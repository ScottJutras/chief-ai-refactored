// utils/documentAiExpense.js
// Pretrained Document AI Expense Parser
// Input: Buffer of image bytes (jpeg/png/webp/pdf)
// Output: { text, fields, raw }

const { DocumentProcessorServiceClient } = require('@google-cloud/documentai');

let _client = null;

function getClient() {
  if (_client) return _client;

  // Recommended: set GOOGLE_APPLICATION_CREDENTIALS to a file path.
  // If you prefer base64, decode to /tmp at runtime (shown below).
  _client = new DocumentProcessorServiceClient();
  return _client;
}

function normalizeMime(mimeType) {
  const m = String(mimeType || '').split(';')[0].trim().toLowerCase();
  // Twilio sometimes gives odd things; keep it conservative.
  if (m === 'image/jpg') return 'image/jpeg';
  return m;
}

function pickEntity(entities, type) {
  if (!Array.isArray(entities)) return null;
  const e = entities.find((x) => String(x.type || '').toLowerCase() === String(type).toLowerCase());
  return e || null;
}

function entityMoney(entity) {
  const props = entity?.normalizedValue?.moneyValue || entity?.mentionText || null;
  if (!props) return null;
  if (typeof props === 'string') return props;
  const units = props.units != null ? String(props.units) : '0';
  const nanos = props.nanos != null ? String(props.nanos) : '0';
  return `${units}.${String(nanos).padStart(9, '0').slice(0, 2)}`; // cents-ish display
}

async function processExpenseReceipt({
  projectId,
  processorId,
  location = 'us',
  bytes,
  mimeType,
}) {
  if (!projectId) throw new Error('Missing projectId');
  if (!processorId) throw new Error('Missing processorId');
  if (!bytes || !Buffer.isBuffer(bytes)) throw new Error('Missing bytes Buffer');

  const client = getClient();

  const name = client.processorPath(projectId, location, processorId);

  const request = {
    name,
    rawDocument: {
      content: bytes.toString('base64'),
      mimeType: normalizeMime(mimeType) || 'image/jpeg',
    },
  };

  const [result] = await client.processDocument(request);

  const doc = result?.document || {};
  const text = doc?.text || '';

  // Expense Parser puts key fields in entities.
  const entities = doc?.entities || [];

  const supplier = pickEntity(entities, 'supplier_name')?.mentionText || null;
  const receiptDate = pickEntity(entities, 'receipt_date')?.mentionText || null;
  const total = entityMoney(pickEntity(entities, 'total_amount')) || pickEntity(entities, 'total_amount')?.mentionText || null;
  const currency = pickEntity(entities, 'currency')?.mentionText || null;

  const fields = { supplier, receiptDate, total, currency };

  return { text, fields, raw: result };
}

module.exports = { processExpenseReceipt };
