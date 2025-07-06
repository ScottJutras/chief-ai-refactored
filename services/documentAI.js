require('dotenv').config();
const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;
const { parseReceiptText, logReceiptExpense } = require('../legacy/googleSheetsnewer');
const { getAuthorizedClient } = require('../legacy/googleSheetsnewer');

// Decode Google credentials
const googleCredentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
);

/**
 * Returns an authenticated Document AI client using the proper regional endpoint.
 */
function getDocumentAIClient() {
  const location = process.env.GCP_LOCATION || 'us';
  const apiEndpoint = `${location}-documentai.googleapis.com`;

  return new DocumentProcessorServiceClient({
    credentials: googleCredentials,
    apiEndpoint
  });
}

/**
 * Processes the provided image using Document AI and returns the OCR text.
 *
 * @param {Buffer|string} imageContent - The image content as a Buffer or base64-encoded string.
 * @param {string} mimeType - The MIME type of the image (e.g., 'image/jpeg', 'image/png').
 * @returns {Promise<string>} The OCR text extracted by Document AI.
 */
async function processDocumentAI(imageContent, mimeType = 'image/jpeg') {
  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_LOCATION || 'us';
  const processorId = process.env.DOCUMENTAI_PROCESSOR_ID;

  if (!projectId || !processorId) {
    console.error('[ERROR] Missing GCP_PROJECT_ID or DOCUMENTAI_PROCESSOR_ID');
    throw new Error('Missing required environment variables for Document AI');
  }

  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  const client = getDocumentAIClient();

  const request = {
    name,
    rawDocument: {
      content: imageContent,
      mimeType: mimeType // Dynamic MIME type
    }
  };

  try {
    const [result] = await client.processDocument(request);
    const ocrText = result.document.text;
    console.log('[DEBUG] Document AI OCR text:', ocrText);
    return ocrText;
  } catch (error) {
    console.error('[ERROR] Document AI Failed:', error.message);
    throw new Error(`Failed to process image: ${error.message}`);
  }
}

/**
 * Handles the receipt image processing workflow:
 * 1. Processes the image via Document AI.
 * 2. Parses the OCR text using parseReceiptText.
 * 3. Logs the receipt expense using logReceiptExpense.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @param {Buffer|string} imageContent - The image content.
 * @param {string} mimeType - The MIME type of the image (e.g., 'image/jpeg', 'image/png').
 * @returns {Promise<string>} The result of logging the receipt expense.
 */
async function handleReceiptImage(phoneNumber, imageContent, mimeType = 'image/jpeg') {
  try {
    const ocrText = await processDocumentAI(imageContent, mimeType);
    const parsedData = parseReceiptText(ocrText);
    if (!parsedData) {
      throw new Error('Failed to parse receipt data');
    }
    const result = await logReceiptExpense(phoneNumber, ocrText);
    if (!result) {
      throw new Error('Failed to log receipt expense');
    }
    return result;
  } catch (error) {
    console.error('[ERROR] Failed to process receipt image:', error.message);
    throw new Error(`Receipt processing failed: ${error.message}`);
  }
}

module.exports = {
  getDocumentAIClient,
  processDocumentAI,
  handleReceiptImage
};