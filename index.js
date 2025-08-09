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
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const mime = require('mime-types');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { uploadFileToDrive, ensureGoogleAuthReady } = require('./googleDrive');

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const TEMP_DIR = process.env.TEMP_DIR || '/app/temp';
const PORT = parseInt(process.env.PORT || '3000', 10);
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

// Minimal QR web viewer for Railway
const app = express();
app.get('/', async (_req, res) => {
  try {
    if (whatsappReady) {
      res.status(200).send('<html><body><h2>WhatsApp is already authenticated ✅</h2><p>No QR needed.</p></body></html>');
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
    res.status(500).send('Failed to render QR.');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QR viewer listening on port ${PORT}. Open / to view the QR.`);
});