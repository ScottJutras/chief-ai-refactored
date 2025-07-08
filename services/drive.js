// services/drive.js
require('dotenv').config();
const { google } = require('googleapis');

// Decode and parse your service-account JSON from the base64 env var
const googleCredentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
);

// Create a reusable GoogleAuth instance
const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  scopes: [
    'https://www.googleapis.com/auth/drive.file', // only File-level operations
    'https://www.googleapis.com/auth/drive.metadata.readonly'
  ],
});

async function getDriveClient() {
  const client = await auth.getClient();
  return google.drive({ version: 'v3', auth: client });
}

async function uploadFile(fileName, mimeType, fileContent, metadata = {}) {
  const drive = await getDriveClient();
  const response = await drive.files.create({
    resource: { name: fileName, ...metadata },
    media: { mimeType, body: fileContent },
    fields: 'id, webViewLink'
  });
  console.log(`[✅] Uploaded file to Drive: ${fileName} (ID: ${response.data.id})`);
  return response.data;
}

async function setFilePermissions(fileId, role, type, emailAddress = null) {
  const drive = await getDriveClient();
  const permission = { role, type };
  if (emailAddress) permission.emailAddress = emailAddress;
  await drive.permissions.create({ fileId, requestBody: permission });
  console.log(`[✅] Set Drive permissions: ${fileId} → ${role}/${type}`);
}

module.exports = { getDriveClient, uploadFile, setFilePermissions };
