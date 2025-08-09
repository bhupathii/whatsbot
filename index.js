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
*/

const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');
const qrcode = require('qrcode-terminal');
const mime = require('mime-types');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { uploadFileToDrive, ensureGoogleAuthReady } = require('./googleDrive');

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const TEMP_DIR = process.env.TEMP_DIR || '/app/temp';
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

const client = new Client({
  puppeteer: puppeteerConfig,
  // Persist WhatsApp session under DATA_DIR using LocalAuth
  authStrategy: new LocalAuth({ dataPath: DATA_DIR }),
});

client.on('qr', (qr) => {
  // Logs QR in terminal for initial login
  qrcode.generate(qr, { small: true });
  console.log('Scan the QR code above to log in.');
});

// LocalAuth manages session automatically; auth events still logged below if needed

client.on('ready', async () => {
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
    const helpText = [
      'Hi! I can upload your media to Google Drive and send you a public link.',
      '',
      'Send me any image/video/document/audio directly here.',
      '',
      'Commands:',
      '• .ping – check if I am online',
      '• .help – show this help',
    ].join('\n');

    if (['hi', 'hello', 'hey'].includes(text)) {
      await msg.reply(helpText);
      return;
    }
    if (text === '.help') {
      await msg.reply(helpText);
      return;
    }
    if (text === '.ping') {
      await msg.reply('pong');
      return;
    }
  }

  // Media handling in 1:1 chats
  if (!msg?.hasMedia) return;

  try {
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

    await msg.reply('Uploading to Google Drive, please wait...');

    const shareLink = await uploadFileToDrive(tempFilePath, media.mimetype, filename);

    await msg.reply(`Here is your shareable link:\n${shareLink}`);

    await fsExtra.remove(tempFilePath);
    console.log('Temporary file deleted:', tempFilePath);
  } catch (err) {
    console.error('Error handling forwarded media:', err);
    try {
      await msg.reply('Sorry, an error occurred while processing your media.');
    } catch (e) {}
  }
});

client.initialize();