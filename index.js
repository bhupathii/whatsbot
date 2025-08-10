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
  const userStatus = uploadQueue.getUserStatus(msg.from);
  const healthStatus = healthMonitor.getPerformanceSummary();
  
  const statusText = [
    '📊 **Your Upload Status**',
    '',
    `📁 **Queue**: ${userStatus.queue} files waiting`,
    `🔄 **Active**: ${userStatus.active} files uploading`,
    `✅ **Completed**: ${userStatus.completed} files`,
    `📈 **Total**: ${userStatus.total} files`,
    '',
    '🏥 **Bot Health**: ' + (healthStatus.status === 'healthy' ? '✅ Good' : 
                              healthStatus.status === 'warning' ? '⚠️ Warning' : '❌ Critical'),
    `⏱️ **Uptime**: ${healthStatus.uptime}`,
    `💾 **Memory**: ${healthStatus.memory}`,
    `📤 **Success Rate**: ${healthStatus.uploads.successRate}%`
  ].join('\n');
  
  await msg.reply(statusText);
}

async function handleQueueCommand(msg) {
  const queueStatus = uploadQueue.getStatus();
  
  if (queueStatus.queueLength === 0 && queueStatus.activeUploads === 0) {
    await msg.reply('📭 Upload queue is empty. All files have been processed!');
    return;
  }
  
  let queueText = '📋 **Upload Queue Status**\n\n';
  
  if (queueStatus.activeUploads > 0) {
    queueText += `🔄 **Currently Uploading** (${queueStatus.activeUploads}/${queueStatus.maxConcurrent}):\n`;
    queueStatus.active.forEach(item => {
      const progressBar = createProgressBar(item.progress);
      queueText += `• ${item.filename} ${progressBar} ${item.progress}%\n`;
    });
    queueText += '\n';
  }
  
  if (queueStatus.queueLength > 0) {
    queueText += `📁 **Waiting in Queue** (${queueStatus.queueLength}):\n`;
    queueStatus.queue.slice(0, 5).forEach((item, index) => {
      queueText += `• ${index + 1}. ${item.filename}\n`;
    });
    if (queueStatus.queueLength > 5) {
      queueText += `• ... and ${queueStatus.queueLength - 5} more files\n`;
    }
  }
  
  await msg.reply(queueText);
}

async function handleHealthCommand(msg) {
  const healthStatus = healthMonitor.getHealthStatus();
  
  let healthText = '🏥 **Bot Health Report**\n\n';
  
  // Overall status
  const statusEmoji = {
    'healthy': '✅',
    'warning': '⚠️',
    'critical': '🚨',
    'unknown': '❓'
  };
  
  healthText += `${statusEmoji[healthStatus.current.status] || '❓'} **Status**: ${healthStatus.current.status.toUpperCase()}\n`;
  
  if (healthStatus.current.issues.length > 0) {
    healthText += `⚠️ **Issues**:\n`;
    healthStatus.current.issues.forEach(issue => {
      healthText += `• ${issue}\n`;
    });
    healthText += '\n';
  }
  
  // System info
  healthText += `💻 **System**: ${healthStatus.system.platform} ${healthStatus.system.arch}\n`;
  healthText += `🟢 **Node**: ${healthStatus.system.nodeVersion}\n`;
  healthText += `⏱️ **Uptime**: ${healthStatus.uptime}\n`;
  healthText += `💾 **Memory**: ${healthStatus.system.memory.used} / ${healthStatus.system.memory.total} (${healthStatus.system.memory.percentage}%)\n`;
  healthText += `🔄 **CPU Cores**: ${healthStatus.system.cpu.cores}\n`;
  healthText += `📊 **Load Average**: ${healthStatus.system.cpu.loadAverage.join(', ')}\n`;
  
  await msg.reply(healthText);
}

async function handleStatsCommand(msg) {
  const stats = uploadQueue.getStatus();
  const healthSummary = healthMonitor.getPerformanceSummary();
  
  const statsText = [
    '📊 **Upload Statistics**',
    '',
    `📤 **Total Uploads**: ${stats.stats.total}`,
    `✅ **Successful**: ${stats.stats.completed}`,
    `❌ **Failed**: ${stats.stats.failed}`,
    `📈 **Success Rate**: ${healthSummary.uploads.successRate}%`,
    '',
    `📁 **Current Queue**: ${stats.queueLength} files`,
    `🔄 **Active Uploads**: ${stats.activeUploads}/${stats.maxConcurrent}`,
    '',
    `⏱️ **Last Health Check**: ${healthSummary.lastCheck}`,
    `🏥 **Bot Status**: ${healthSummary.status.toUpperCase()}`
  ].join('\n');
  
  await msg.reply(statsText);
}

// Helper function to create progress bar
function createProgressBar(percentage, length = 10) {
  const filled = Math.round((percentage / 100) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// Get help text
function getHelpText() {
  return [
    '🤖 **WhatsApp Drive Bot**',
    '',
    'I can upload your media to Google Drive and send you a public link.',
    '',
    '📤 **Supported Media**:',
    '• Images (JPG, PNG, GIF, etc.)',
    '• Videos (MP4, AVI, MOV, etc.)',
    '• Documents (PDF, DOC, TXT, etc.)',
    '• Audio files (MP3, WAV, etc.)',
    '',
    '❌ **Not Supported**:',
    '• Stickers',
    '• Contact cards',
    '• Location data',
    '',
    '💬 **Commands**:',
    '• `.ping` – Check if I am online',
    '• `.help` – Show this help',
    '• `.status` – Your upload status',
    '• `.queue` – Current upload queue',
    '• `.health` – Bot health report',
    '• `.stats` – Upload statistics',
    '',
    '📁 **How it works**:',
    '1. Send me any supported media file',
    '2. I\'ll add it to the upload queue',
    '3. Upload to Google Drive automatically',
    '4. Get a shareable link when done!',
    '',
    '⚠️ **Note**: Duplicate files are automatically detected and won\'t be uploaded again.'
  ].join('\n');
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
    if (whatsappReady) {
      const healthStatus = healthMonitor.getPerformanceSummary();
      const queueStatus = uploadQueue.getStatus();
      
      res.status(200).send(`
        <!doctype html>
        <html>
        <head>
          <title>WhatsApp Drive Bot - Status</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; margin: 40px; background: #f5f5f5; }
            .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .status { padding: 15px; border-radius: 8px; margin: 20px 0; }
            .healthy { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
            .warning { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; }
            .critical { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
            .metric { display: inline-block; margin: 10px 20px 10px 0; padding: 10px; background: #f8f9fa; border-radius: 5px; }
            .metric strong { display: block; font-size: 1.2em; }
            h1 { color: #333; text-align: center; }
            h2 { color: #555; border-bottom: 2px solid #eee; padding-bottom: 10px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🤖 WhatsApp Drive Bot</h1>
            <p style="text-align: center; color: #28a745; font-size: 1.2em;">✅ WhatsApp is authenticated and ready!</p>
            
            <div class="status ${healthStatus.status}">
              <h2>🏥 Bot Health: ${healthStatus.status.toUpperCase()}</h2>
              <p><strong>Uptime:</strong> ${healthStatus.uptime}</p>
              <p><strong>Memory:</strong> ${healthStatus.memory}</p>
              <p><strong>Last Check:</strong> ${healthStatus.lastCheck}</p>
            </div>
            
            <h2>📊 Upload Statistics</h2>
            <div class="metric">
              <strong>Total Uploads</strong>
              ${healthStatus.uploads.total}
            </div>
            <div class="metric">
              <strong>Success Rate</strong>
              ${healthStatus.uploads.successRate}
            </div>
            <div class="metric">
              <strong>Queue Length</strong>
              ${queueStatus.queueLength}
            </div>
            <div class="metric">
              <strong>Active Uploads</strong>
              ${queueStatus.activeUploads}/${queueStatus.maxConcurrent}
            </div>
            
            <h2>📁 Current Queue</h2>
            ${queueStatus.queueLength === 0 ? '<p>Queue is empty</p>' : 
              `<p><strong>Waiting:</strong> ${queueStatus.queueLength} files</p>
               <p><strong>Processing:</strong> ${queueStatus.activeUploads} files</p>`
            }
            
            <p style="text-align: center; margin-top: 30px; color: #666;">
              Bot is running and ready to receive media files via WhatsApp
            </p>
          </div>
        </body>
        </html>
      `);
      return;
    }
    
    if (!latestQr) {
      res.status(200).send('<html><body><h2>QR not generated yet</h2><p>Wait a few seconds and refresh.</p></body></html>');
      return;
    }
    
    const dataUrl = await QRCode.toDataURL(latestQr, { margin: 1, width: 320 });
    res.status(200).send(`<!doctype html><html><body style="font-family: system-ui; text-align:center;">
      <h3>Scan this QR with WhatsApp</h3>
      <img src="${dataUrl}" alt="WhatsApp QR" />
      <p style="opacity:0.7">This page auto-refresh does not occur; refresh manually if it expires.</p>
    </body></html>`);
  } catch (err) {
    res.status(500).send('Failed to render page.');
  }
});

// Health check endpoint for monitoring
app.get('/health', (req, res) => {
  try {
    const healthStatus = healthMonitor.getHealthStatus();
    res.json({
      status: 'ok',
      whatsapp: whatsappReady ? 'connected' : 'disconnected',
      health: healthStatus.current.status,
      uptime: healthStatus.uptime,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web interface listening on port ${PORT}. Open / to view status or /health for health check.`);
});