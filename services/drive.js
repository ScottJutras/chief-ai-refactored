require('dotenv').config();
const { google } = require('googleapis');
const { getAuthorizedClient } = require('../legacy/googleSheetsnewer');

/**
 * Creates a Google Drive API client.
 * @returns {Promise<Object>} The Drive API client.
 */
async function getDriveClient() {
  try {
    const auth = await getAuthorizedClient();
    return google.drive({ version: 'v3', auth });
  } catch (error) {
    console.error('[ERROR] Failed to create Drive client:', error.message);
    throw new Error(`Drive client creation failed: ${error.message}`);
  }
}

/**
 * Uploads a file to Google Drive.
 * @param {string} fileName - The name of the file (e.g., "Deep_Dive_userId_timestamp.pdf").
 * @param {string} mimeType - The MIME type of the file (e.g., 'application/pdf').
 * @param {string|Buffer|Stream} fileContent - The file content (e.g., file path or Buffer).
 * @param {Object} [metadata={}] - Additional metadata for the file.
 * @returns {Promise<{ id: string, webViewLink: string }>} The file ID and web view link.
 */
async function uploadFile(fileName, mimeType, fileContent, metadata = {}) {
  try {
    const drive = await getDriveClient();
    const fileMetadata = { name: fileName, ...metadata };
    const media = { mimeType, body: fileContent };
    const response = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, webViewLink'
    });
    console.log(`[✅] Uploaded file to Drive: ${fileName}, ID: ${response.data.id}`);
    return response.data;
  } catch (error) {
    console.error(`[ERROR] Failed to upload file to Drive: ${error.message}`);
    throw new Error(`File upload failed: ${error.message}`);
  }
}

/**
 * Sets permissions for a file on Google Drive.
 * @param {string} fileId - The ID of the file.
 * @param {string} role - The permission role ('reader', 'writer', etc.).
 * @param {string} type - The permission type ('anyone', 'user', etc.).
 * @param {string} [emailAddress] - Optional email address for user-specific permissions.
 * @returns {Promise<void>}
 */
async function setFilePermissions(fileId, role, type, emailAddress = null) {
  try {
    const drive = await getDriveClient();
    const permission = { role, type };
    if (emailAddress) {
      permission.emailAddress = emailAddress;
    }
    await drive.permissions.create({
      fileId,
      requestBody: permission
    });
    console.log(`[✅] Set permissions for file ${fileId}: ${role} for ${type}${emailAddress ? ` (${emailAddress})` : ''}`);
  } catch (error) {
    console.error(`[ERROR] Failed to set permissions for file ${fileId}: ${error.message}`);
    throw new Error(`Permission setting failed: ${error.message}`);
  }
}

module.exports = {
  getDriveClient,
  uploadFile,
  setFilePermissions
};