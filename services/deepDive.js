// services/deepDive.js
const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;
const { query } = require('./postgres');
const Papa = require('papaparse');
const ExcelJS = require('exceljs');

// Lazy-init Document AI client (so local dev without creds doesn’t crash)
let docAiClient = null;
function getDocAiClient() {
  if (docAiClient) return docAiClient;
  const credsB64 = process.env.GOOGLE_CREDENTIALS_BASE64;
  if (!credsB64) return null;
  const credentials = JSON.parse(Buffer.from(credsB64, 'base64').toString());
  docAiClient = new DocumentProcessorServiceClient({ credentials });
  return docAiClient;
}

// ---------- helpers ----------
function normalizeFrom(from = '') {
  const val = String(from || '');
  const noWa = val.startsWith('whatsapp:') ? val.slice('whatsapp:'.length) : val;
  return noWa.replace(/^\+/, '').trim();
}

function isoDateOrToday(d) {
  const date = new Date(d);
  return isNaN(date) ? new Date().toISOString().split('T')[0] : date.toISOString().split('T')[0];
}

// Excel stores dates as serial numbers or Date objects
function excelToISO(val) {
  if (val instanceof Date) return isoDateOrToday(val);
  if (typeof val === 'number' && isFinite(val)) {
    // Excel serial date: number of days since 1899-12-30 (handling the 1900 leap bug convention)
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const ms = val * 24 * 60 * 60 * 1000;
    return new Date(epoch.getTime() + ms).toISOString().split('T')[0];
  }
  return isoDateOrToday(val);
}

function parseMoney(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  return parseFloat(String(v).replace(/[$,]/g, '')) || 0;
}

// Map any legacy/unknown tier to limits
const MAX_TRANSACTIONS = {
  starter: 5000,
  basic: 5000,      // your DB shows 'basic' in logs; treat as starter
  pro: 20000,
  enterprise: 50000,
};

// ---------- main ----------
async function parseUpload(buffer, filename, from, mimeType, uploadType = 'csv', fiscalYearStart) {
  try {
    const userId = normalizeFrom(from);

    // Find user by user_id or owner_id (schema-safe)
    const userRes = await query(
      `SELECT * FROM users WHERE user_id = $1 OR owner_id = $1 LIMIT 1`,
      [userId]
    );
    const userProfile = userRes.rows[0];
    if (!userProfile) throw new Error('User not found');

    const tierRaw = userProfile.subscription_tier || userProfile.paid_tier || 'starter';
    const tier = (tierRaw || '').toLowerCase();
    const maxTransactions = MAX_TRANSACTIONS[tier] || MAX_TRANSACTIONS.starter;

    // Fiscal window
    const fyStart = isoDateOrToday(fiscalYearStart || '2025-01-01');
    const fiscalYear = new Date(fyStart);
    const fiscalYearEnd = new Date(fiscalYear.getFullYear() + 1, fiscalYear.getMonth(), fiscalYear.getDate() - 1);

    let transactions = [];

    // ------ CSV / XLSX ------
    if (
      uploadType === 'csv' &&
      ['text/csv', 'application/vnd.ms-excel'].includes(mimeType)
    ) {
      // CSV (or some banks label CSV as application/vnd.ms-excel)
      const csvText = buffer.toString('utf8');
      const { data } = Papa.parse(csvText, { header: true, skipEmptyLines: true });
      transactions = data.map((row) => ({
        date: row.date ? isoDateOrToday(row.date) : isoDateOrToday(new Date()),
        amount: parseMoney(row.amount),
        description: row.description || 'Unknown',
        category: row.category || 'Other',
      }));
    } else if (
      uploadType === 'csv' &&
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ) {
      // XLSX
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const sheet = workbook.worksheets[0];
      transactions = [];
      // assume headers: date, amount, description, category
      sheet.eachRow((row, idx) => {
        if (idx === 1) return;
        const vals = row.values.slice(1); // ExcelJS row.values[0] is null
        const [date, amount, description, category] = vals;
        transactions.push({
          date: date ? excelToISO(date) : isoDateOrToday(new Date()),
          amount: parseMoney(amount),
          description: description || 'Unknown',
          category: category || 'Other',
        });
      });
    }
    // ------ PDF / Image via Document AI ------
    else if (['application/pdf', 'image/jpeg', 'image/png'].includes(mimeType)) {
      const client = getDocAiClient();
      if (!client) {
        throw new Error('Document AI is not configured.');
      }
      const name = `projects/${process.env.GCP_PROJECT_ID}/locations/us/processors/${process.env.DOCUMENTAI_PROCESSOR_ID}`;
      const request = { name, rawDocument: { content: buffer, mimeType } };
      const [result] = await client.processDocument(request);
      const { document } = result || {};
      if (document?.entities?.length) {
        for (const entity of document.entities) {
          if (entity.type !== 'transaction') continue;

          const dateText =
            entity.properties?.find((p) => p.type === 'date')?.normalizedValue?.text ||
            new Date().toISOString().split('T')[0];
          const date = new Date(dateText);

          // Historical parsing gate
          if ((date < fiscalYear || date > fiscalYearEnd) && !userProfile.historical_parsing_purchased) {
            throw new Error(
              'Historical image parsing requires DeepDive purchase. Reply "upload history" for payment link.'
            );
          }

          transactions.push({
            date: isoDateOrToday(dateText),
            amount: parseMoney(
              entity.properties?.find((p) => p.type === 'amount')?.mentionText || '0'
            ),
            description: entity.properties?.find((p) => p.type === 'description')?.mentionText || 'Unknown',
            category: entity.properties?.find((p) => p.type === 'category')?.mentionText || 'Other',
          });
        }
      }
    } else {
      throw new Error('Unsupported file type. Use CSV, Excel, or PDF/image.');
    }

    // Enforce tier limits
    if (transactions.length > maxTransactions) {
      throw new Error(`Upload exceeds ${maxTransactions} transactions for ${tier || 'starter'} tier.`);
    }

    // Nothing parsed?
    if (transactions.length === 0) {
      return { transactions: 0, summary: `No valid transactions detected in ${filename}.` };
    }

    // Batch insert
    const nowIso = new Date().toISOString();
    const values = transactions.flatMap((t) => [
      userProfile.owner_id || userProfile.user_id,
      t.date,
      t.amount,
      t.description,
      t.category,
      nowIso,
    ]);
    const placeholders = transactions
      .map((_, i) => {
        const o = i * 6;
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
      })
      .join(',');

    await query(
      `INSERT INTO transactions (owner_id, date, amount, description, category, created_at)
       VALUES ${placeholders}`,
      values
    );

    return {
      transactions: transactions.length,
      summary: `Processed ${transactions.length} transactions from ${filename}.`,
    };
  } catch (err) {
    console.error(`[ERROR] parseUpload failed for ${from}:`, err.message);
    throw new Error(`Upload processing failed: ${err.message}`);
  }
}

module.exports = { parseUpload };
