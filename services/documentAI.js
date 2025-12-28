// services/documentAI.js
// ------------------------------------------------------------------
// Receipt / media parsing helpers.
// NOTE: This is not Google Document AI yet — it's the local parser layer
// that you'll swap to Document AI results later.
// ------------------------------------------------------------------

const pg = require('./postgres');
const { parseMediaText } = require('./mediaParser');

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

function safeStr(x) {
  const s = String(x ?? '').trim();
  return s || null;
}

/**
 * Very lightweight receipt text parse fallback.
 * (Replace with Document AI structured extraction later.)
 */
async function parseReceiptText(text) {
  const raw = String(text || '').trim();
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  const amtLine = lines.find(l => l.match(/\$?\s*\d{1,6}(?:,\d{3})*(?:\.\d{2})/));
  const amtMatch = amtLine?.match(/\$?\s*(\d{1,6}(?:,\d{3})*(?:\.\d{2}))/);
  const amountNum = amtMatch?.[1] ? amtMatch[1].replace(/,/g, '') : null;

  const storeLine = lines.find(l => !l.match(/\$?\s*\d{1,6}(?:,\d{3})*(?:\.\d{2})/)) || 'Unknown';
  const store = storeLine.slice(0, 80);

  const amount = amountNum ? `$${Number(amountNum).toFixed(2)}` : '$0.00';

  return {
    date: todayIso(),
    item: store,
    amount,
    store,
    category: 'Miscellaneous',
  };
}

/**
 * Unified parser used by inbound media handlers.
 * Delegates to services/mediaParser.js (time/expense/revenue).
 */
async function parseAnyMediaText(text) {
  return parseMediaText(text);
}

/**
 * Handle a receipt image that has already been OCR’d/transcribed into text.
 * Expected to be called by your WhatsApp media pipeline after OCR.
 *
 * @param {string} ownerId - tenant owner id (uuid/text)
 * @param {string} phoneNumber - the sender phone (optional; used for user field if you want)
 * @param {string} text - OCR text
 * @param {string|null} mediaUrl - attachment url
 * @param {object} ctx - optional context (jobName override, mediaMetaNormalized, sourceMsgId)
 */
async function handleReceiptImage(ownerId, phoneNumber, text, mediaUrl, ctx = {}) {
  const owner = safeStr(ownerId);
  if (!owner) throw new Error('Missing ownerId');

  const parsed = await parseReceiptText(text || 'Unknown receipt');

  // Prefer ctx.jobName, else active job for THIS owner, else Uncategorized
  let jobName = safeStr(ctx.jobName);
  if (!jobName && typeof pg.getActiveJob === 'function') {
    // some older implementations keyed active job by phone; newer should key by owner
    try {
      jobName = (await pg.getActiveJob(owner)) || null;
    } catch {
      // ignore
    }
  }
  if (!jobName) jobName = 'Uncategorized';

  // Prefer ctx.mediaMetaNormalized if present
  const mediaMeta = ctx.mediaMetaNormalized || null;
  const media_url = safeStr(mediaUrl) || safeStr(mediaMeta?.media_url) || safeStr(mediaMeta?.url) || null;

  // Save expense (use best-available function)
  if (typeof pg.saveExpense === 'function') {
    await pg.saveExpense({
      ownerId: owner,
      date: parsed.date,
      item: parsed.item,
      amount: parsed.amount,
      store: parsed.store,
      jobName,
      category: parsed.category,
      user: safeStr(phoneNumber) || 'Unknown',
      media_url,
    });
  } else if (typeof pg.logExpense === 'function') {
    await pg.logExpense(
      {
        type: 'LogExpense',
        owner_id: owner,
        date: parsed.date,
        item: parsed.item,
        amount: parsed.amount,
        store: parsed.store,
        job_name: jobName,
        category: parsed.category,
        media_url,
      },
      { owner_id: owner, actor_phone: safeStr(phoneNumber), source_msg_id: safeStr(ctx.sourceMsgId) }
    );
  } else {
    throw new Error('No expense save function available in postgres.js');
  }

  return `✅ Logged expense ${parsed.amount} for ${parsed.item} from ${parsed.store}${jobName ? ` (Job: ${jobName})` : ''}`;
}

module.exports = { parseReceiptText, parseAnyMediaText, handleReceiptImage };
