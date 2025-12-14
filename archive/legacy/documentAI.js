require('dotenv').config();

// documentAI.js

// Import the Document AI client library.
const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;

// Decode your Google credentials from the environment.
const googleCredentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
);

/**
 * Returns an authenticated Document AI client using the proper regional endpoint.
 * (We are not explicitly setting scopes here so that the client library can use its defaults.)
 */
function getDocumentAIClient() {
  // Use the environment variable for location or default to 'us'
  const location = process.env.GCP_LOCATION || 'us';
  // Construct the endpoint. For example, for 'us' it becomes 'us-documentai.googleapis.com'
  const apiEndpoint = `${location}-documentai.googleapis.com`;

  return new DocumentProcessorServiceClient({
    credentials: googleCredentials,
    apiEndpoint, // Use the regional endpoint for Document AI.
    // Note: Removing the explicit "scopes" parameter to avoid conflicts.
  });
}

/**
 * Processes the provided image using Document AI and returns the OCR text.
 *
 * @param {Buffer|string} imageContent - The image content as a Buffer or base64-encoded string.
 * @returns {Promise<string>} The OCR text extracted by Document AI.
 */
async function processDocumentAI(imageContent) {
  const projectId = process.env.GCP_PROJECT_ID;
  // Use location from env or default to 'us'
  const location = process.env.GCP_LOCATION || 'us';
  const processorId = process.env.DOCUMENTAI_PROCESSOR_ID;

  // Construct the full resource name.
  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;

  const client = getDocumentAIClient();

  const request = {
    name,
    rawDocument: {
      content: imageContent, // Either a Buffer or base64-encoded string.
      mimeType: 'image/jpeg', // Adjust if your images are a different type.
    },
  };

  try {
    const [result] = await client.processDocument(request);
    // Extract the OCR text from the Document AI response.
    const ocrText = result.document.text;
    console.log('[DEBUG] Document AI OCR text:', ocrText);
    return ocrText;
  } catch (error) {
    console.error('[ERROR] Document AI Failed:', error.message);
    throw error;
  }
}

/**
 * Handles the receipt image processing workflow:
 * 1. Processes the image via Document AI.
 * 2. Parses the OCR text using a provided parseReceiptText function.
 * 3. Logs the receipt expense using a provided logReceiptExpense function.
 *
 * Note: You must pass in the `parseReceiptText` and `logReceiptExpense` functions
 *       (or import them in this module) since they are not defined here.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @param {Buffer|string} imageContent - The image content.
 * @param {function} parseReceiptText - A function that parses receipt OCR text.
 * @param {function} logReceiptExpense - A function that logs the parsed receipt data.
 * @returns {Promise<*>} The result of logging the receipt expense.
 */
async function handleReceiptImage(phoneNumber, imageContent, parseReceiptText, logReceiptExpense) {
  try {
    // Process the image with Document AI.
    const ocrText = await processDocumentAI(imageContent);

    // Parse the OCR text.
    const parsedData = parseReceiptText(ocrText);
    if (!parsedData) {
      throw new Error('Failed to parse receipt data.');
    }

    // Log the receipt expense (this function should handle adding active job info, etc.).
    return await logReceiptExpense(phoneNumber, ocrText);
  } catch (error) {
    console.error('[ERROR] Failed to process receipt image:', error.message);
    throw error;
  }
}

// Export the functions for use in other modules.
module.exports = {
  getDocumentAIClient,
  processDocumentAI,
  handleReceiptImage,
};
