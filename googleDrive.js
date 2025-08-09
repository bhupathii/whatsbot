/*
  Google Drive helper

  credentials.json:
  - From Google Cloud Console (OAuth client for Desktop app). Place at project root as `credentials.json`
    or set env var CREDENTIALS_PATH to an absolute path.

  token.json:
  - Will be stored in DATA_DIR (default /app/data). Persist this path via a Railway volume.

  Initial auth:
  - On first run without token.json, this module prints an auth URL.
  - If running in a non-interactive environment, set env var GOOGLE_OAUTH_CODE with the code you get
    after visiting the printed URL to auto-generate token.json.
  - Alternatively, run locally once to generate token.json, then deploy it with the app/volume.
*/

const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive',
];

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const TOKEN_PATH = path.join(DATA_DIR, 'token.json');
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || path.join(process.cwd(), 'credentials.json');

let oauth2Client;

async function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Missing Google API credentials. Place credentials.json at ${CREDENTIALS_PATH} or set CREDENTIALS_PATH.`
    );
  }
  const content = await fsExtra.readJson(CREDENTIALS_PATH);
  const { installed, web } = content;
  const clientInfo = installed || web;
  if (!clientInfo) throw new Error('Invalid credentials.json: expected an "installed" or "web" client.');
  const { client_secret, client_id, redirect_uris } = clientInfo;
  const redirectUri = (redirect_uris && redirect_uris[0]) || 'http://localhost';
  return { client_id, client_secret, redirectUri };
}

async function authorize() {
  const { client_id, client_secret, redirectUri } = await loadCredentials();
  oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  await fsExtra.ensureDir(DATA_DIR);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = await fsExtra.readJson(TOKEN_PATH);
    oauth2Client.setCredentials(token);
    return oauth2Client;
  }

  // No token yet; guide the user
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  console.log('Authorize this app by visiting this URL:\n', authUrl);

  if (process.env.GOOGLE_OAUTH_CODE) {
    const code = process.env.GOOGLE_OAUTH_CODE;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    await fsExtra.writeJson(TOKEN_PATH, tokens, { spaces: 2 });
    console.log('Google OAuth token stored at:', TOKEN_PATH);
    return oauth2Client;
  }

  throw new Error(
    `Google OAuth token not found. Set GOOGLE_OAUTH_CODE with the code obtained from the URL above, or run locally to create ${TOKEN_PATH}.`
  );
}

async function getDriveClient() {
  if (!oauth2Client) await authorize();
  return google.drive({ version: 'v3', auth: oauth2Client });
}

async function ensureGoogleAuthReady() {
  try {
    await getDriveClient();
    console.log('Google Drive auth is ready.');
  } catch (err) {
    console.warn('Google Drive auth not ready yet:', err.message);
  }
}

async function uploadFileToDrive(filePath, mimeType, fileName) {
  const drive = await getDriveClient();

  const requestBody = { name: fileName };
  const media = { mimeType, body: fs.createReadStream(filePath) };

  const createRes = await drive.files.create({
    requestBody,
    media,
    fields: 'id,name',
  });

  const fileId = createRes.data.id;
  if (!fileId) throw new Error('Drive did not return a file ID.');

  // Make file public
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  const getRes = await drive.files.get({ fileId, fields: 'webViewLink,webContentLink' });
  const shareLink = getRes.data.webViewLink || getRes.data.webContentLink;
  if (!shareLink) throw new Error('Failed to retrieve shareable link from Drive.');

  return shareLink;
}

module.exports = {
  uploadFileToDrive,
  ensureGoogleAuthReady,
};