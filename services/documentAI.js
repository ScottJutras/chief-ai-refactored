require('dotenv').config();
const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;
const visionService = require('../utils/visionService');
const { parseReceiptText } = require('../utils/expenseParser');
const { saveExpense, getActiveJob } = require('./postgres');

// Decode Google credentials once
const googleCredentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
);

/**
 * Returns an authenticated Document AI client using the proper regional endpoint.
 */
function getDocumentAIClient() {
  const location = process.env.GCP_LOCATION || 'us';
  const apiEndpoint = `${location}-documentai.googleapis.com`;
  const projectId = process.env.GCP_PROJECT_ID;
  const processorId = process.env.DOCUMENTAI_PROCESSOR_ID;
  if (!projectId || !processorId) {
    throw new Error('Missing GCP_PROJECT_ID or DOCUMENTAI_PROCESSOR_ID');
  }
  return new DocumentProcessorServiceClient({
    credentials: googleCredentials,
    apiEndpoint
  });
}

/**
 * Processes the provided image buffer via Document AI to return raw OCR text.
 */
async function processDocumentAI(imageContent, mimeType = 'image/jpeg') {
  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_LOCATION || 'us';
  const processorId = process.env.DOCUMENTAI_PROCESSOR_ID;
  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  const client = getDocumentAIClient();
  const request = {
    name,
    rawDocument: { content: imageContent, mimeType }
  };
  const [result] = await client.processDocument(request);
  return result.document.text;
}

/**
 * Full receipt handling: OCR -> parse -> save
 */
async function handleReceiptImage(phoneNumber, imageContent, mimeType = 'image/jpeg') {
  // 1) Raw OCR
  const ocrText = await processDocumentAI(imageContent, mimeType);
  // 2) Parse fields
  const parsed = parseReceiptText(ocrText);
  if (!parsed) throw new Error('Failed to parse receipt data');
  // 3) Determine active job
  const jobName = await getActiveJob(phoneNumber) || 'Uncategorized';
  // 4) Persist to Postgres
  await saveExpense({
    ownerId: phoneNumber,
    date: parsed.date,
    item: parsed.item,
    amount: parsed.amount,
    store: parsed.store,
    jobName,
    category: parsed.category,
    user: parsed.user || 'Unknown'
  });
  return `✅ Logged expense $${parsed.amount} for ${parsed.item}`;
}

module.exports = {
  getDocumentAIClient,
  processDocumentAI,
  handleReceiptImage
};
