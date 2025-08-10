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
let isInitializing = false;

// Message deduplication to prevent duplicate processing
const processedMessages = new Set();
const MESSAGE_DEDUP_TIMEOUT = 30000; // 30 seconds

// Cleanup old processed messages periodically to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const messageKey of processedMessages) {
    const [timestamp] = messageKey.split('_').slice(-1);
    if (now - parseInt(timestamp) > MESSAGE_DEDUP_TIMEOUT) {
      processedMessages.delete(messageKey);
    }
  }
}, 60000); // Clean up every minute

// Graceful shutdown handling
process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  if (whatsappReady) {
    await client.destroy();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  if (whatsappReady) {
    await client.destroy();
  }
  process.exit(0);
});

// Initialize upload queue and health monitor
const uploadQueue = new UploadQueue(MAX_CONCURRENT_UPLOADS);
const healthMonitor = new HealthMonitor(uploadQueue);

const client = new Client({
  puppeteer: puppeteerConfig,
  // Persist WhatsApp session under DATA_DIR using LocalAuth
  authStrategy: new LocalAuth({ dataPath: DATA_DIR }),
});

client.on('qr', (qr) => {
  // Keep the most recent QR in memory for the web viewer
  latestQr = qr;
  whatsappReady = false;
  isInitializing = false;
  // Also print an ASCII QR to logs (useful locally)
  qrcodeTerminal.generate(qr, { small: true });
  console.log('Scan the QR code above to log in. Or open the QR viewer page.');
});

client.on('ready', async () => {
  whatsappReady = true;
  latestQr = null;
  isInitializing = false;
  console.log('WhatsApp bot is ready.');
  // Check Google Drive auth readiness at startup (non-blocking)
  await ensureGoogleAuthReady();
});

client.on('disconnected', (reason) => {
  whatsappReady = false;
  isInitializing = false;
  console.log(`WhatsApp client disconnected: ${reason}`);
});

client.on('auth_failure', (msg) => {
  whatsappReady = false;
  isInitializing = false;
  console.log('WhatsApp authentication failed:', msg);
});

client.on('message', async (msg) => {
  const isPrivateChat = typeof msg?.from === 'string' && msg.from.endsWith('@c.us');
  if (!isPrivateChat) return;

  // Message deduplication check
  const messageKey = `${msg.from}_${msg.id._serialized}_${msg.timestamp}`;
  if (processedMessages.has(messageKey)) {
    console.log(`Duplicate message detected, skipping: ${messageKey}`);
    return;
  }
  
  // Add to processed messages set
  processedMessages.add(messageKey);
  
  // Clean up old processed messages after timeout
  setTimeout(() => {
    processedMessages.delete(messageKey);
  }, MESSAGE_DEDUP_TIMEOUT);

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
  }

  // Media handling in 1:1 chats
  if (!msg?.hasMedia) return;

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
  
  await msg.reply(response);
}

async function handleQueueCommand(msg) {
  const queueStatus = uploadQueue.getStatus();
  
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
  
  await msg.reply(response);
}

async function handleHealthCommand(msg) {
  const healthStatus = healthMonitor.getHealthStatus();
  const performanceSummary = healthMonitor.getPerformanceSummary();
  
  let response = `🏥 *Bot Health Report*\n\n`;
  response += `📊 *Overall Status:* ${healthStatus.current.status}\n`;
  response += `💾 *Memory Usage:* ${healthStatus.system.memory.percentage || 'Unknown'}%\n`;
  response += `🖥️ *CPU Usage:* ${healthStatus.system.cpu ? (100 - parseFloat(healthStatus.system.cpu.idlePercentage)).toFixed(2) : 'Unknown'}%\n`;
  response += `⏱️ *Uptime:* ${healthStatus.uptime}\n`;
  response += `🖥️ *Platform:* ${healthStatus.system.platform} (${healthStatus.system.arch})\n`;
  response += `📦 *Node Version:* ${healthStatus.system.nodeVersion}\n\n`;
  
  response += `📈 *Performance Summary:*\n`;
  response += `• Upload Success Rate: ${performanceSummary.uploads.successRate}%\n`;
  response += `• Total Uploads: ${performanceSummary.uploads.total}\n`;
  response += `• Active Uploads: ${performanceSummary.uploads.active}\n`;
  response += `• Queue Length: ${performanceSummary.uploads.queue}\n`;
  response += `• Last Check: ${performanceSummary.lastCheck}\n\n`;
  
  await msg.reply(response);
}

async function handleStatsCommand(msg) {
  const performanceSummary = healthMonitor.getPerformanceSummary();
  const queueStatus = uploadQueue.getStatus();
  
  let response = `📊 *Upload Statistics*\n\n`;
  response += `📁 *Current Status:*\n`;
  response += `• Total Uploads: ${queueStatus.stats.total}\n`;
  response += `• Completed: ${queueStatus.stats.completed}\n`;
  response += `• Failed: ${queueStatus.stats.failed}\n`;
  response += `• Success Rate: ${performanceSummary.uploads.successRate}%\n\n`;
  
  response += `⏱️ *Queue Status:*\n`;
  response += `• Queue Length: ${queueStatus.queueLength}\n`;
  response += `• Active Uploads: ${queueStatus.activeUploads}\n`;
  response += `• Max Concurrent: ${queueStatus.maxConcurrent}\n\n`;
  
  response += `📈 *Performance Metrics:*\n`;
  response += `• Total Uploads: ${performanceSummary.uploads.total}\n`;
  response += `• Success Rate: ${performanceSummary.uploads.successRate}%\n`;
  response += `• Active Uploads: ${performanceSummary.uploads.active}\n`;
  response += `• Last Check: ${performanceSummary.lastCheck}\n\n`;
  
  await msg.reply(response);
}

// Helper function to create progress bar
function createProgressBar(percentage, length = 10) {
  const filled = Math.round((percentage / 100) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// Get help text
function getHelpText() {
  return `🤖 *WhatsApp → Google Drive Bot*

*Commands:*
• \`.help\` - Show this help message
• \`.ping\` - Test bot response
• \`.status\` - Check your upload status
• \`.queue\` - View upload queue status
• \`.health\` - Check bot health
• \`.stats\` - View upload statistics

*Features:*
• 📤 Upload images, videos, documents, and audio
• 🚫 Stickers are not supported
• 🔄 Queue system for multiple uploads
• 📊 Progress tracking and duplicate detection
• 🏥 Health monitoring
• 🌐 Web dashboard at http://localhost:3000

*Usage:*
Simply forward any media file to this bot and it will upload it to Google Drive and share the link with you.

*Note:* This bot only works in private chats (1:1 conversations).`;
}

// Listen for upload progress events
uploadQueue.on('progress', (progressData) => {
  console.log(`Upload progress for ${progressData.filename}: ${progressData.progress}%`);
});

// Initialize WhatsApp client only if not already initializing
if (!isInitializing && !whatsappReady) {
  isInitializing = true;
  console.log('Initializing WhatsApp client...');
  client.initialize().catch(error => {
    console.error('Failed to initialize WhatsApp client:', error);
    isInitializing = false;
  });
} else {
  console.log('WhatsApp client already initialized or initializing, skipping...');
}

// Enhanced web interface
const app = express();

app.get('/', async (_req, res) => {
  try {
    const botHealth = healthMonitor.getHealthStatus();
    const queueStatus = uploadQueue.getStatus();
    const performanceSummary = healthMonitor.getPerformanceSummary();
    
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web interface listening on port ${PORT}. Open / to view status or /health for health check.`);
});