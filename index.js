/*
  WhatsApp → Google Drive Uploader Bot

  Setup instructions:
  1) Google Cloud Console → Enable "Google Drive API" and create OAuth2 Client ID (Desktop app).
     - Download the OAuth client JSON as "credentials.json" and place it in the project root
       OR set env var CREDENTIALS_PATH to its absolute path.
  2) Run locally once to generate and save OAuth token: `node index.js`
     - The app will print an auth URL if `token.json` is not present.
     - Visit the URL, grant access, copy the code.
     - Either paste the code into env var GOOGLE_OAUTH_CODE and run again OR run locally where you can paste on prompt.
     - The token will be saved to DATA_DIR/token.json (default /app/data).
  3) Railway deployment:
     - Mount a persistent volume at /app/data (Railway → Volumes) so `session.json` and `token.json` persist.
     - Ensure the Dockerfile is used. Puppeteer launch includes --no-sandbox flags and uses system Chromium.

  Behavior:
  - Detects any FORWARDED media (image, video, document, audio) sent to the bot
  - Downloads media to a temp dir
  - Uploads to Google Drive, makes public, returns a shareable link
  - Cleans up the temp file
  - NEW: Queue system, duplicate detection, progress tracking, health monitoring
*/

const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const mime = require('mime-types');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { uploadFileToDrive, ensureGoogleAuthReady } = require('./googleDrive');
const UploadQueue = require('./uploadQueue');
const HealthMonitor = require('./healthMonitor');
const AdminSystem = require('./adminSystem');

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const TEMP_DIR = process.env.TEMP_DIR || '/app/temp';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_CONCURRENT_UPLOADS = parseInt(process.env.MAX_CONCURRENT_UPLOADS || '3', 10);

fsExtra.ensureDirSync(DATA_DIR);
fsExtra.ensureDirSync(TEMP_DIR);

// Using LocalAuth which persists session under DATA_DIR/.wwebjs_auth

const puppeteerConfig = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
  ],
};

// Prefer an explicit Chromium path (Docker/Railway)
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
} else if (fs.existsSync('/usr/bin/chromium')) {
  puppeteerConfig.executablePath = '/usr/bin/chromium';
}

let latestQr = null;
let whatsappReady = false;

// Initialize upload queue, health monitor, and admin system
const uploadQueue = new UploadQueue(MAX_CONCURRENT_UPLOADS);
const healthMonitor = new HealthMonitor(uploadQueue);
const adminSystem = new AdminSystem(DATA_DIR);

const client = new Client({
  puppeteer: puppeteerConfig,
  // Persist WhatsApp session under DATA_DIR using LocalAuth
  authStrategy: new LocalAuth({ dataPath: DATA_DIR }),
});

client.on('qr', (qr) => {
  // Keep the most recent QR in memory for the web viewer
  latestQr = qr;
  whatsappReady = false;
  // Also print an ASCII QR to logs (useful locally)
  qrcodeTerminal.generate(qr, { small: true });
  console.log('Scan the QR code above to log in. Or open the QR viewer page.');
});

client.on('ready', async () => {
  whatsappReady = true;
  latestQr = null;
  console.log('WhatsApp bot is ready.');
  // Check Google Drive auth readiness at startup (non-blocking)
  await ensureGoogleAuthReady();
});

client.on('message', async (msg) => {
  const isPrivateChat = typeof msg?.from === 'string' && msg.from.endsWith('@c.us');
  if (!isPrivateChat) return;

  // Text commands in 1:1 chats
  if (typeof msg?.body === 'string') {
    const text = msg.body.trim().toLowerCase();
    
    if (['hi', 'hello', 'hey'].includes(text)) {
      await msg.reply(getHelpText());
      return;
    }
    
    if (text === '.help') {
      await msg.reply(getHelpText());
      return;
    }
    
    if (text === '.ping') {
      await msg.reply('🏓 pong');
      return;
    }
    
    if (text === '.status') {
      await handleStatusCommand(msg);
      return;
    }
    
    if (text === '.queue') {
      await handleQueueCommand(msg);
      return;
    }
    
    if (text === '.health') {
      await handleHealthCommand(msg);
      return;
    }
    
    if (text === '.stats') {
      await handleStatsCommand(msg);
      return;
    }
    
    if (text.startsWith('.admin')) { // New admin command routing
      await handleAdminCommand(msg);
      return;
    } else if (text.startsWith('.check admin')) { // Simple admin check
      await handleCheckAdminCommand(msg);
      return;
    } else if (text.startsWith('.create default admin')) { // Force create default admin
      await handleCreateDefaultAdminCommand(msg);
      return;
    }
  }

  // Media handling in 1:1 chats
  if (!msg?.hasMedia) return;

  // Check if user is restricted
  if (adminSystem.isUserRestricted(msg.from)) {
    const restriction = adminSystem.getUserRestriction(msg.from);
    const durationText = restriction.duration ? 
      `for ${restriction.duration} hours` : 'permanently';
    
    await msg.reply(
      `❌ Access Denied\n\n` +
      `You have been restricted from using this bot ${durationText}.\n\n` +
      `Reason: ${restriction.reason}\n` +
      `Restricted by: ${restriction.restrictedBy}\n` +
      `Contact an administrator for assistance.`
    );
    return;
  }

  try {
    // Check if it's a sticker (skip stickers)
    if (msg.type === 'sticker') {
      await msg.reply(
        '❌ Stickers are not supported for upload.\n\n' +
        'Please send images, videos, documents, or audio files instead.'
      );
      return;
    }

    console.log(`Media received (1:1) from ${msg.from}. Type=${msg.type}`);

    const media = await msg.downloadMedia();
    if (!media || !media.data) {
      console.warn('No media data available to download.');
      return;
    }

    const extension = mime.extension(media.mimetype) || 'bin';
    const safeBase = media.filename ? path.parse(media.filename).name : `media_${Date.now()}`;
    const filename = `${safeBase}.${extension}`;
    const tempFilePath = path.join(TEMP_DIR, filename);

    await fsExtra.writeFile(tempFilePath, Buffer.from(media.data, 'base64'));

    // Add to upload queue instead of direct upload
    const uploadData = {
      userId: msg.from,
      messageId: msg.id._serialized,
      filePath: tempFilePath,
      mimeType: media.mimetype,
      filename: filename,
      originalMessage: msg
    };

    const result = await uploadQueue.addToQueue(uploadData);
    
    if (result.status === 'duplicate') {
      // File was already uploaded, temp file will be cleaned up
      try {
        await fsExtra.remove(tempFilePath);
      } catch (e) {
        console.error('Error cleaning up duplicate temp file:', e);
      }
    }
    // If queued, the queue will handle the rest

  } catch (err) {
    console.error('Error handling media:', err);
    try {
      await msg.reply('❌ Sorry, an error occurred while processing your media.');
    } catch (e) {}
  }
});

// Command handlers
async function handleStatusCommand(msg) {
  const userId = msg.from;
  const userStatus = uploadQueue.getUserStatus(userId);
  const botHealth = healthMonitor.getHealthStatus();
  const isAdmin = adminSystem.isAdmin(userId);
  
  let response = `📊 *Your Upload Status*\n\n`;
  
  if (userStatus.uploads.length === 0) {
    response += `No uploads found for your account.\n\n`;
  } else {
    response += `📁 *Recent Uploads:* ${userStatus.uploads.length}\n`;
    response += `✅ *Successful:* ${userStatus.successful}\n`;
    response += `❌ *Failed:* ${userStatus.failed}\n`;
    response += `⏳ *In Queue:* ${userStatus.inQueue}\n\n`;
    
    if (userStatus.recentUploads.length > 0) {
      response += `🕒 *Latest Uploads:*\n`;
      userStatus.recentUploads.slice(0, 3).forEach(upload => {
        const status = upload.status === 'completed' ? '✅' : 
                      upload.status === 'failed' ? '❌' : '⏳';
        response += `${status} ${upload.filename} (${upload.status})\n`;
      });
    }
  }
  
  response += `\n🏥 *Bot Health:* ${botHealth.status}\n`;
  response += `💾 *Memory:* ${botHealth.memoryUsage}\n`;
  response += `⏱️ *Uptime:* ${botHealth.uptime}`;
  
  if (isAdmin) {
    const adminUser = adminSystem.getAdminUser(userId);
    response += `\n\n👑 *Admin Status:* ${adminUser.role.toUpperCase()}`;
    response += `\n🔑 *Permissions:* ${adminUser.permissions.length}`;
  }

  if (!isAdmin) {
    response += `\n\n👑 *Admin Status:* Not Admin\n`;
    response += `🔑 *Permissions:* 0\n`;
  }
  
  await msg.reply(response);
}

async function handleQueueCommand(msg) {
  const queueStatus = uploadQueue.getStatus();
  const isAdmin = adminSystem.isAdmin(msg.from);
  
  let response = `📋 *Upload Queue Status*\n\n`;
  response += `⏳ *Total in Queue:* ${queueStatus.total}\n`;
  response += `🔄 *Currently Processing:* ${queueStatus.processing}\n`;
  response += `✅ *Completed Today:* ${queueStatus.completedToday}\n`;
  response += `❌ *Failed Today:* ${queueStatus.failedToday}\n\n`;
  
  if (queueStatus.queue.length > 0) {
    response += `📝 *Current Queue:*\n`;
    queueStatus.queue.slice(0, 5).forEach((item, index) => {
      const progress = item.progress || 0;
      const progressBar = createProgressBar(progress);
      response += `${index + 1}. ${item.filename}\n`;
      response += `   ${progressBar} ${progress}%\n`;
      response += `   👤 ${item.userId}\n\n`;
    });
    
    if (queueStatus.queue.length > 5) {
      response += `... and ${queueStatus.queue.length - 5} more items\n`;
    }
  }
  
  if (isAdmin) {
    response += `\n🔧 *Admin Controls:*\n`;
    response += `• Use \`.queue clear\` to clear completed uploads\n`;
    response += `• Use \`.queue pause\` to pause processing\n`;
    response += `• Use \`.queue resume\` to resume processing`;
  }
  
  await msg.reply(response);
}

async function handleHealthCommand(msg) {
  const healthStatus = healthMonitor.getHealthStatus();
  const performanceSummary = healthMonitor.getPerformanceSummary();
  const isAdmin = adminSystem.isAdmin(msg.from);
  
  let response = `🏥 *Bot Health Report*\n\n`;
  response += `📊 *Overall Status:* ${healthStatus.status}\n`;
  response += `💾 *Memory Usage:* ${healthStatus.memoryUsage}\n`;
  response += `🖥️ *CPU Usage:* ${healthStatus.cpuUsage}\n`;
  response += `💿 *Disk Usage:* ${healthStatus.diskUsage}\n`;
  response += `⏱️ *Uptime:* ${healthStatus.uptime}\n\n`;
  
  response += `📈 *Performance Summary:*\n`;
  response += `• Upload Success Rate: ${performanceSummary.successRate}%\n`;
  response += `• Average Upload Time: ${performanceSummary.avgUploadTime}\n`;
  response += `• Total Uploads: ${performanceSummary.totalUploads}\n`;
  response += `• Active Users: ${performanceSummary.activeUsers}\n\n`;
  
  if (isAdmin) {
    const systemStatus = adminSystem.getSystemStatus();
    response += `🔧 *System Status:*\n`;
    response += `• Admin Users: ${systemStatus.adminCount}\n`;
    response += `• Restricted Users: ${systemStatus.restrictedUserCount}\n`;
    response += `• Total Warnings: ${systemStatus.totalWarnings}\n`;
    response += `• Audit Logs: ${systemStatus.auditLogCount}`;
  }
  
  await msg.reply(response);
}

async function handleStatsCommand(msg) {
  const performanceSummary = healthMonitor.getPerformanceSummary();
  const queueStatus = uploadQueue.getStatus();
  const isAdmin = adminSystem.isAdmin(msg.from);
  
  let response = `📊 *Upload Statistics*\n\n`;
  response += `📁 *Today's Uploads:*\n`;
  response += `• Total: ${queueStatus.totalToday}\n`;
  response += `• Successful: ${queueStatus.completedToday}\n`;
  response += `• Failed: ${queueStatus.failedToday}\n`;
  response += `• Success Rate: ${performanceSummary.successRate}%\n\n`;
  
  response += `⏱️ *Performance Metrics:*\n`;
  response += `• Average Upload Time: ${performanceSummary.avgUploadTime}\n`;
  response += `• Fastest Upload: ${performanceSummary.fastestUpload}\n`;
  response += `• Slowest Upload: ${performanceSummary.slowestUpload}\n\n`;
  
  response += `👥 *User Activity:*\n`;
  response += `• Active Users: ${performanceSummary.activeUsers}\n`;
  response += `• Top Uploaders: ${performanceSummary.topUploaders?.slice(0, 3).join(', ') || 'None'}\n`;
  
  if (isAdmin) {
    const adminStats = adminSystem.getAdminStats();
    response += `\n🔧 *Admin Statistics:*\n`;
    response += `• Total Admins: ${adminStats.totalAdmins}\n`;
    response += `• Active Admins: ${adminStats.activeAdmins}\n`;
    response += `• Role Distribution: ${Object.entries(adminStats.roleCounts).map(([role, count]) => `${role}: ${count}`).join(', ')}`;
  }
  
  await msg.reply(response);
}

// NEW: Admin command handlers
async function handleAdminCommand(msg) {
  const command = msg.body.toLowerCase().trim();
  const userId = msg.from;
  
  // Check if user is admin
  const adminValidation = adminSystem.validateAdminCommand(userId, 'admin_management');
  if (!adminValidation.allowed) {
    await msg.reply(
      `❌ *Access Denied*\n\n` +
      `You don't have permission to use admin commands.\n` +
      `Required: Admin access\n` +
      `Your role: ${adminValidation.reason}`
    );
    return;
  }
  
  const adminUser = adminSystem.getAdminUser(userId);
  
  if (command.includes('add admin')) {
    await handleAddAdminCommand(msg, adminUser);
  } else if (command.includes('remove admin')) {
    await handleRemoveAdminCommand(msg, adminUser);
  } else if (command.includes('list admins')) {
    await handleListAdminsCommand(msg, adminUser);
  } else if (command.includes('restrict user')) {
    await handleRestrictUserCommand(msg, adminUser);
  } else if (command.includes('unrestrict user')) {
    await handleUnrestrictUserCommand(msg, adminUser);
  } else if (command.includes('warn user')) {
    await handleWarnUserCommand(msg, adminUser);
  } else if (command.includes('list restricted')) {
    await handleListRestrictedCommand(msg, adminUser);
  } else if (command.includes('audit logs')) {
    await handleAuditLogsCommand(msg, adminUser);
  } else if (command.includes('system status')) {
    await handleSystemStatusCommand(msg, adminUser);
  } else if (command.includes('test access')) {
    await handleTestAdminAccessCommand(msg, adminUser);
  } else if (command.includes('force create admin')) {
    await handleForceCreateAdminCommand(msg, adminUser);
  } else {
    await msg.reply(
      `🔧 *Admin Commands* (Admin Only)\n\n` +
      `*User Management:*\n` +
      `• \`.admin add admin <phone> <role> <name>\`\n` +
      `• \`.admin remove admin <phone>\`\n` +
      `• \`.admin list admins\`\n\n` +
      `*User Control:*\n` +
      `• \`.admin restrict user <phone> <reason> [duration]\`\n` +
      `• \`.admin unrestrict user <phone>\`\n` +
      `• \`.admin warn user <phone> <reason>\`\n` +
      `• \`.admin list restricted\`\n\n` +
      `*System:*\n` +
      `• \`.admin audit logs [limit]\`\n` +
      `• \`.admin system status\`\n` +
      `• \`.admin test access\` - Test admin access\n` +
      `• \`.admin force create admin <phone> <role> <name>\`\n\n` +
      `*Your Role:* ${adminUser.role.toUpperCase()}\n` +
      `*Permissions:* ${adminUser.permissions.join(', ')}\n\n` +
      `💡 *Note:* These commands are only visible to admin users. Regular users can use \`.check admin\` to see their status.`
    );
  }
}

async function handleAddAdminCommand(msg, adminUser) {
  const parts = msg.body.split(' ');
  if (parts.length < 5) {
    await msg.reply(
      `❌ *Invalid Format*\n\n` +
      `Usage: \`.admin add admin <phone> <role> <name>\`\n\n` +
      `*Example:*\n` +
      `\`.admin add admin 919876543210@c.us admin John Doe\`\n\n` +
      `*Available Roles:*\n` +
      `• super_admin (Super Admin only)\n` +
      `• admin\n` +
      `• moderator\n` +
      `• viewer`
    );
    return;
  }
  
  const phone = parts[3];
  const role = parts[4];
  const name = parts.slice(5).join(' ');
  
  try {
    // Check if current user can add this role
    if (role === 'super_admin' && adminUser.role !== 'super_admin') {
      await msg.reply('❌ Only super admins can create other super admins.');
      return;
    }
    
    const newAdmin = await adminSystem.addAdmin(phone, role, name, adminUser.name);
    
    await msg.reply(
      `✅ *Admin Added Successfully*\n\n` +
      `*Phone:* ${phone}\n` +
      `*Name:* ${newAdmin.name}\n` +
      `*Role:* ${newAdmin.role}\n` +
      `*Added By:* ${newAdmin.addedBy}\n` +
      `*Permissions:* ${newAdmin.permissions.length}`
    );
  } catch (error) {
    await msg.reply(`❌ *Error:* ${error.message}`);
  }
}

async function handleRemoveAdminCommand(msg, adminUser) {
  const parts = msg.body.split(' ');
  if (parts.length < 4) {
    await msg.reply(
      `❌ *Invalid Format*\n\n` +
      `Usage: \`.admin remove admin <phone>\`\n\n` +
      `*Example:*\n` +
      `\`.admin remove admin 919876543210@c.us\``
    );
    return;
  }
  
  const phone = parts[3];
  
  try {
    const result = await adminSystem.removeAdmin(phone, adminUser.name);
    
    await msg.reply(
      `✅ *Admin Removed Successfully*\n\n` +
      `*Removed User:* ${result.removedUser.name}\n` +
      `*Previous Role:* ${result.removedUser.role}\n` +
      `*Removed By:* ${result.removedBy}\n` +
      `*Timestamp:* ${new Date(result.timestamp).toLocaleString()}`
    );
  } catch (error) {
    await msg.reply(`❌ *Error:* ${error.message}`);
  }
}

async function handleListAdminsCommand(msg, adminUser) {
  const admins = adminSystem.getAllAdmins();
  
  let response = `👑 *Admin Users List*\n\n`;
  
  admins.forEach(admin => {
    const status = admin.lastActive ? 
      `Active: ${new Date(admin.lastActive).toLocaleString()}` : 'Never active';
    
    response += `*${admin.name}*\n`;
    response += `📱 ${admin.phone}\n`;
    response += `🔑 ${admin.role.toUpperCase()}\n`;
    response += `⏰ ${status}\n\n`;
  });
  
  response += `*Total Admins:* ${admins.length}`;
  
  await msg.reply(response);
}

async function handleRestrictUserCommand(msg, adminUser) {
  const parts = msg.body.split(' ');
  if (parts.length < 5) {
    await msg.reply(
      `❌ *Invalid Format*\n\n` +
      `Usage: \`.admin restrict user <phone> <reason> [duration]\`\n\n` +
      `*Example:*\n` +
      `\`.admin restrict user 919876543210@c.us Spam 24\`\n` +
      `\`.admin restrict user 919876543210@c.us Violation\`\n\n` +
      `*Duration:* Optional, in hours. Leave empty for permanent restriction.`
    );
    return;
  }
  
  const phone = parts[3];
  const reason = parts[4];
  const duration = parts[5] ? parseInt(parts[5]) : null;
  
  try {
    const restriction = await adminSystem.restrictUser(phone, reason, adminUser.name, duration);
    
    const durationText = duration ? `for ${duration} hours` : 'permanently';
    
    await msg.reply(
      `🚫 *User Restricted Successfully*\n\n` +
      `*Phone:* ${phone}\n` +
      `*Reason:* ${reason}\n` +
      `*Duration:* ${durationText}\n` +
      `*Restricted By:* ${restriction.restrictedBy}\n` +
      `*Timestamp:* ${new Date(restriction.restrictedAt).toLocaleString()}`
    );
  } catch (error) {
    await msg.reply(`❌ *Error:* ${error.message}`);
  }
}

async function handleUnrestrictUserCommand(msg, adminUser) {
  const parts = msg.body.split(' ');
  if (parts.length < 4) {
    await msg.reply(
      `❌ *Invalid Format*\n\n` +
      `Usage: \`.admin unrestrict user <phone>\`\n\n` +
      `*Example:*\n` +
      `\`.admin unrestrict user 919876543210@c.us\``
    );
    return;
  }
  
  const phone = parts[3];
  
  try {
    const result = await adminSystem.unrestrictUser(phone, adminUser.name);
    
    await msg.reply(
      `✅ *User Unrestricted Successfully*\n\n` +
      `*Phone:* ${phone}\n` +
      `*Previous Reason:* ${result.previousReason}\n` +
      `*Unrestricted By:* ${result.unrestrictedBy}\n` +
      `*Timestamp:* ${new Date(result.unrestrictedAt).toLocaleString()}`
    );
  } catch (error) {
    await msg.reply(`❌ *Error:* ${error.message}`);
  }
}

async function handleWarnUserCommand(msg, adminUser) {
  const parts = msg.body.split(' ');
  if (parts.length < 5) {
    await msg.reply(
      `❌ *Invalid Format*\n\n` +
      `Usage: \`.admin warn user <phone> <reason>\`\n\n` +
      `*Example:*\n` +
      `\`.admin warn user 919876543210@c.us Inappropriate content\``
    );
    return;
  }
  
  const phone = parts[3];
  const reason = parts.slice(4).join(' ');
  
  try {
    const warning = await adminSystem.warnUser(phone, reason, adminUser.name);
    
    await msg.reply(
      `⚠️ *User Warned Successfully*\n\n` +
      `*Phone:* ${phone}\n` +
      `*Reason:* ${reason}\n` +
      `*Warning Level:* ${warning.warningLevel}\n` +
      `*Warned By:* ${warning.warnedBy}\n` +
      `*Timestamp:* ${new Date(warning.warnedAt).toLocaleString()}`
    );
  } catch (error) {
    await msg.reply(`❌ *Error:* ${error.message}`);
  }
}

async function handleListRestrictedCommand(msg, adminUser) {
  const restrictedUsers = adminSystem.getAllRestrictedUsers();
  
  if (restrictedUsers.length === 0) {
    await msg.reply('✅ No users are currently restricted.');
    return;
  }
  
  let response = `🚫 *Restricted Users List*\n\n`;
  
  restrictedUsers.forEach(restriction => {
    const durationText = restriction.duration ? 
      `for ${restriction.duration} hours` : 'permanently';
    
    response += `*${restriction.phone}*\n`;
    response += `📝 ${restriction.reason}\n`;
    response += `⏰ ${durationText}\n`;
    response += `👮 ${restriction.restrictedBy}\n`;
    response += `🕒 ${new Date(restriction.restrictedAt).toLocaleString()}\n\n`;
  });
  
  response += `*Total Restricted:* ${restrictedUsers.length}`;
  
  await msg.reply(response);
}

async function handleAuditLogsCommand(msg, adminUser) {
  const parts = msg.body.split(' ');
  const limit = parts[4] ? parseInt(parts[4]) : 10;
  
  const logs = adminSystem.getAuditLogs(limit);
  
  if (logs.length === 0) {
    await msg.reply('📋 No audit logs found.');
    return;
  }
  
  let response = `📋 *Recent Audit Logs*\n\n`;
  
  logs.slice(0, 5).forEach(log => {
    response += `*${log.action.replace(/_/g, ' ').toUpperCase()}*\n`;
    response += `👤 ${log.performedBy}\n`;
    response += `🕒 ${new Date(log.timestamp).toLocaleString()}\n`;
    if (log.details.targetUser) {
      response += `📱 Target: ${log.details.targetUser}\n`;
    }
    response += `\n`;
  });
  
  if (logs.length > 5) {
    response += `... and ${logs.length - 5} more logs\n`;
  }
  
  response += `*Total Logs:* ${adminSystem.getAuditStats().totalActions}`;
  
  await msg.reply(response);
}

async function handleSystemStatusCommand(msg, adminUser) {
  const systemStatus = adminSystem.getSystemStatus();
  const auditStats = adminSystem.getAuditStats();
  
  let response = `🔧 *System Status Report*\n\n`;
  
  response += `👑 *Admin System:*\n`;
  response += `• Total Admins: ${systemStatus.adminCount}\n`;
  response += `• Active Admins: ${systemStatus.activeAdmins}\n`;
  response += `• Roles: ${systemStatus.roles}\n\n`;
  
  response += `🚫 *User Control:*\n`;
  response += `• Restricted Users: ${systemStatus.restrictedUserCount}\n`;
  response += `• Total Warnings: ${systemStatus.totalWarnings}\n\n`;
  
  response += `📋 *Audit System:*\n`;
  response += `• Total Actions: ${auditStats.totalActions}\n`;
  response += `• Recent Actions (24h): ${auditStats.recentActions}\n`;
  response += `• Last Updated: ${new Date(systemStatus.lastUpdated).toLocaleString()}`;
  
  await msg.reply(response);
}

async function handleTestAdminAccessCommand(msg, adminUser) {
  try {
    const userId = msg.from;
    const testPhone = '6309513603';
    
    // Test different phone number formats
    const testResults = adminSystem.testAdminAccess(testPhone);
    
    let response = `🔍 *Admin Access Test Results*\n\n`;
    response += `*Your Phone:* ${userId}\n`;
    response += `*Your Role:* ${adminUser.role.toUpperCase()}\n`;
    response += `*Your Permissions:* ${adminUser.permissions.join(', ')}\n\n`;
    
    response += `*Testing Phone:* ${testPhone}\n`;
    response += `*Normalized:* ${testResults.normalizedPhone}\n`;
    response += `*Is Admin:* ${testResults.isAdmin ? '✅ Yes' : '❌ No'}\n`;
    
    if (testResults.userData) {
      response += `*Admin Data:* ${testResults.userData.role} - ${testResults.userData.name}\n`;
    }
    
    response += `\n*All Admin Phones:*\n`;
    testResults.allAdminPhones.forEach(phone => {
      response += `• ${phone}\n`;
    });
    
    await msg.reply(response);
  } catch (error) {
    await msg.reply(`❌ *Test Failed*\n\n` +
      `*Error:* ${error.message}`
    );
  }
}

async function handleForceCreateAdminCommand(msg, adminUser) {
  const parts = msg.body.split(' ');
  if (parts.length < 5) {
    await msg.reply(
      `❌ *Invalid Format*\n\n` +
      `Usage: \`.admin force create admin <phone> <role> <name>\`\n\n` +
      `*Example:*\n` +
      `\`.admin force create admin 919876543210@c.us super_admin John Doe\`\n\n` +
      `*Available Roles:*\n` +
      `• super_admin (Super Admin only)\n` +
      `• admin\n` +
      `• moderator\n` +
      `• viewer`
    );
    return;
  }
  
  const phone = parts[3];
  const role = parts[4];
  const name = parts.slice(5).join(' ');
  
  try {
    // Force create admin, bypassing role restrictions
    const newAdmin = await adminSystem.forceCreateAdmin(phone, role, name, adminUser.name);
    
    await msg.reply(
      `✅ *Admin Force Created Successfully*\n\n` +
      `*Phone:* ${phone}\n` +
      `*Name:* ${newAdmin.name}\n` +
      `*Role:* ${newAdmin.role}\n` +
      `*Added By:* ${newAdmin.addedBy}\n` +
      `*Permissions:* ${newAdmin.permissions.length}`
    );
  } catch (error) {
    await msg.reply(`❌ *Error:* ${error.message}`);
  }
}

async function handleCheckAdminCommand(msg) {
  const userId = msg.from;
  const isAdmin = adminSystem.isAdmin(userId);
  const adminUser = adminSystem.getAdminUser(userId);

  let response = `🔍 *Admin Check*\n\n`;
  response += `*Your Phone:* ${userId}\n`;
  response += `*Your Role:* ${isAdmin ? adminUser.role.toUpperCase() : 'Not Admin'}\n`;
  response += `*Your Permissions:* ${isAdmin ? adminUser.permissions.join(', ') : 'None'}\n`;

  if (isAdmin) {
    response += `\n*Your Admin Status:* ${adminUser.role.toUpperCase()}\n`;
    response += `*Permissions:* ${adminUser.permissions.length}\n`;
    response += `*Last Active:* ${adminUser.lastActive ? new Date(adminUser.lastActive).toLocaleString() : 'Never'}\n`;
  }

  await msg.reply(response);
}

async function handleCreateDefaultAdminCommand(msg) {
  const userId = msg.from;
  const isAdmin = adminSystem.isAdmin(userId);

  if (!isAdmin) {
    await msg.reply('❌ You must be an admin to force create the default admin.');
    return;
  }

  try {
    const result = await adminSystem.forceCreateDefaultAdmin();
    await msg.reply(
      `✅ *Default Admin Force Created Successfully*\n\n` +
      `*Phone:* ${result.normalizedPhone}\n` +
      `*Name:* ${result.userData.name}\n` +
      `*Role:* ${result.userData.role}\n` +
      `*Permissions:* ${result.userData.permissions.length}`
    );
  } catch (error) {
    await msg.reply(`❌ *Error:* ${error.message}`);
  }
}

// Helper function to create progress bar
function createProgressBar(percentage, length = 10) {
  const filled = Math.round((percentage / 100) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// Get help text
function getHelpText() {
  let helpText = `🤖 *WhatsApp Bot Help*\n\n`;
  
  helpText += `📁 *Upload Commands:*\n`;
  helpText += `• Send any media file to upload to Google Drive\n`;
  helpText += `• Supported: Images, Videos, Documents, Audio\n`;
  helpText += `• Stickers are not supported\n\n`;
  
  helpText += `📊 *Status Commands:*\n`;
  helpText += `• \`.status\` - Your upload status and bot health\n`;
  helpText += `• \`.queue\` - Current upload queue status\n`;
  helpText += `• \`.health\` - Detailed bot health report\n`;
  helpText += `• \`.stats\` - Upload statistics and metrics\n`;
  helpText += `• \`.ping\` - Check bot responsiveness\n`;
  helpText += `• \`.check admin\` - Check your admin status\n\n`;
  
  helpText += `❓ *Need Help?*\n`;
  helpText += `Contact an administrator for assistance.\n\n` +
  `💡 *Admin Users:* Use \`.admin\` to see available admin commands.`;
  
  return helpText;
}

// Listen for upload progress events
uploadQueue.on('progress', (progressData) => {
  console.log(`Upload progress for ${progressData.filename}: ${progressData.progress}%`);
});

client.initialize();

// Enhanced web interface
const app = express();

app.get('/', async (_req, res) => {
  try {
    const botHealth = healthMonitor.getHealthStatus();
    const queueStatus = uploadQueue.getStatus();
    const performanceSummary = healthMonitor.getPerformanceSummary();
    const systemStatus = adminSystem.getSystemStatus();
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>WhatsApp Bot Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
          .container { max-width: 1200px; margin: 0 auto; }
          .header { background: #25D366; color: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
          .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
          .card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .card h3 { margin-top: 0; color: #333; }
          .status-good { color: #28a745; }
          .status-warning { color: #ffc107; }
          .status-error { color: #dc3545; }
          .progress-bar { background: #e9ecef; height: 20px; border-radius: 10px; overflow: hidden; }
          .progress-fill { background: #007bff; height: 100%; transition: width 0.3s; }
          .admin-section { background: #6f42c1; color: white; }
          .admin-section h3 { color: white; }
          .refresh-btn { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
          .refresh-btn:hover { background: #0056b3; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🤖 WhatsApp Bot Dashboard</h1>
            <p>Real-time monitoring and control panel</p>
            <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
          </div>
          
          <div class="status-grid">
            <div class="card">
              <h3>🏥 Bot Health</h3>
              <p><strong>Status:</strong> <span class="status-${botHealth.status === 'healthy' ? 'good' : botHealth.status === 'warning' ? 'warning' : 'error'}">${botHealth.status.toUpperCase()}</span></p>
              <p><strong>Memory:</strong> ${botHealth.memoryUsage}</p>
              <p><strong>CPU:</strong> ${botHealth.cpuUsage}</p>
              <p><strong>Disk:</strong> ${botHealth.diskUsage}</p>
              <p><strong>Uptime:</strong> ${botHealth.uptime}</p>
            </div>
            
            <div class="card">
              <h3>📊 Upload Queue</h3>
              <p><strong>In Queue:</strong> ${queueStatus.total}</p>
              <p><strong>Processing:</strong> ${queueStatus.processing}</p>
              <p><strong>Completed Today:</strong> ${queueStatus.completedToday}</p>
              <p><strong>Failed Today:</strong> ${queueStatus.failedToday}</p>
              <p><strong>Success Rate:</strong> ${performanceSummary.successRate}%</p>
            </div>
            
            <div class="card">
              <h3>📈 Performance</h3>
              <p><strong>Total Uploads:</strong> ${performanceSummary.totalUploads}</p>
              <p><strong>Active Users:</strong> ${performanceSummary.activeUsers}</p>
              <p><strong>Avg Upload Time:</strong> ${performanceSummary.avgUploadTime}</p>
              <p><strong>Fastest Upload:</strong> ${performanceSummary.fastestUpload}</p>
            </div>
            
            <div class="card admin-section">
              <h3>👑 Admin System</h3>
              <p><strong>Total Admins:</strong> ${systemStatus.adminCount}</p>
              <p><strong>Active Admins:</strong> ${systemStatus.activeAdmins}</p>
              <p><strong>Restricted Users:</strong> ${systemStatus.restrictedUserCount}</p>
              <p><strong>Total Warnings:</strong> ${systemStatus.totalWarnings}</p>
              <p><strong>Audit Logs:</strong> ${systemStatus.auditLogCount}</p>
            </div>
          </div>
          
          <div class="card">
            <h3>📋 Recent Activity</h3>
            <p><em>Last updated: ${new Date().toLocaleString()}</em></p>
            <p>Use the refresh button to get the latest data.</p>
          </div>
        </div>
      </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Add admin API endpoint
app.get('/admin/status', (req, res) => {
  try {
    const systemStatus = adminSystem.getSystemStatus();
    const auditStats = adminSystem.getAuditStats();
    
    res.json({
      success: true,
      data: {
        system: systemStatus,
        audit: auditStats,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web interface listening on port ${PORT}. Open / to view status or /health for health check.`);
});