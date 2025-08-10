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
const UPLOAD_FOLDER_NAME = 'whatsapp-bot-upload';

let oauth2Client;
let uploadFolderId = null;

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

async function ensureUploadFolder() {
  if (uploadFolderId) return uploadFolderId;
  
  const drive = await getDriveClient();
  
  try {
    // First, try to find existing folder
    const searchResponse = await drive.files.list({
      q: `name='${UPLOAD_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });
    
    if (searchResponse.data.files && searchResponse.data.files.length > 0) {
      uploadFolderId = searchResponse.data.files[0].id;
      console.log(`Found existing upload folder: ${UPLOAD_FOLDER_NAME} (ID: ${uploadFolderId})`);
      return uploadFolderId;
    }
    
    // Create new folder if it doesn't exist
    const folderMetadata = {
      name: UPLOAD_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    };
    
    const folder = await drive.files.create({
      resource: folderMetadata,
      fields: 'id, name'
    });
    
    uploadFolderId = folder.data.id;
    console.log(`Created new upload folder: ${UPLOAD_FOLDER_NAME} (ID: ${uploadFolderId})`);
    
    // Make folder accessible to anyone with the link
    await drive.permissions.create({
      fileId: uploadFolderId,
      requestBody: { role: 'reader', type: 'anyone' }
    });
    
    return uploadFolderId;
  } catch (error) {
    console.error('Error ensuring upload folder:', error);
    throw error;
  }
}

async function ensureGoogleAuthReady() {
  try {
    await getDriveClient();
    await ensureUploadFolder();
    console.log('Google Drive auth is ready.');
  } catch (err) {
    console.warn('Google Drive auth not ready yet:', err.message);
  }
}

async function uploadFileToDrive(filePath, mimeType, fileName) {
  const drive = await getDriveClient();
  const folderId = await ensureUploadFolder();
  
  // Get file stats for size checking
  const fileStats = await fsExtra.stat(filePath);
  const fileSize = fileStats.size;

  const requestBody = { 
    name: fileName,
    parents: [folderId] // Upload to our dedicated folder
  };
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

async function checkFileExists(fileName, fileSize) {
  try {
    const drive = await getDriveClient();
    const folderId = await ensureUploadFolder();
    
    // Normalize filename for better matching (remove WhatsApp prefixes, extensions)
    const normalizedFileName = normalizeFileName(fileName);
    
    // Search for files with similar names in our upload folder
    const searchResponse = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id, name, size, webViewLink, webContentLink, createdTime)',
      spaces: 'drive',
      orderBy: 'createdTime desc'
    });
    
    if (searchResponse.data.files && searchResponse.data.files.length > 0) {
      // Check for exact matches first
      for (const existingFile of searchResponse.data.files) {
        // Check if names match (exact or normalized)
        if (existingFile.name === fileName || 
            normalizeFileName(existingFile.name) === normalizedFileName) {
          
          // If file sizes match, it's likely the same file
          if (existingFile.size && Math.abs(parseInt(existingFile.size) - fileSize) < 100) {
            const shareLink = existingFile.webViewLink || existingFile.webContentLink;
            return {
              exists: true,
              fileId: existingFile.id,
              shareLink,
              createdTime: existingFile.createdTime,
              matchType: 'name_and_size'
            };
          }
        }
      }
      
      // If no exact name match, check for files with similar sizes (within 1KB tolerance)
      for (const existingFile of searchResponse.data.files) {
        if (existingFile.size && Math.abs(parseInt(existingFile.size) - fileSize) < 1024) {
          // Check if file extensions match
          const existingExt = existingFile.name.split('.').pop().toLowerCase();
          const newExt = fileName.split('.').pop().toLowerCase();
          
          if (existingExt === newExt) {
            const shareLink = existingFile.webViewLink || existingFile.webContentLink;
            return {
              exists: true,
              fileId: existingFile.id,
              shareLink,
              createdTime: existingFile.createdTime,
              matchType: 'size_and_extension'
            };
          }
        }
      }
    }
    
    return { exists: false };
  } catch (error) {
    console.error('Error checking if file exists:', error);
    return { exists: false, error: error.message };
  }
}

// Normalize filename for better duplicate detection
function normalizeFileName(fileName) {
  // Remove WhatsApp prefixes like "IMG_", "VID_", "DOC_", etc.
  let normalized = fileName.replace(/^(IMG_|VID_|DOC_|AUD_|STK_)/, '');
  
  // Remove timestamp suffixes like "_1234567890"
  normalized = normalized.replace(/_\d{10,}$/, '');
  
  // Remove WhatsApp media prefixes like "media_1234567890"
  normalized = normalized.replace(/^media_\d+/, '');
  
  // Get the base name without extension
  const baseName = normalized.split('.')[0];
  
  return baseName.toLowerCase().trim();
}

module.exports = {
  uploadFileToDrive,
  ensureGoogleAuthReady,
  checkFileExists,
  ensureUploadFolder,
};