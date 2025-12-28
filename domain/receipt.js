// domain/receipt.js
const { insertTransaction } = require('../services/postgres');

function safeStr(x) {
  const s = String(x ?? '').trim();
  return s || null;
}

function isoDateOrToday(d) {
  try {
    return d ? new Date(d).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Log a receipt as an expense.
 *
 * Expected cil (example):
 * {
 *   amount_cents: 1234,
 *   date: '2025-12-27',
 *   store: 'Home Depot',
 *   item: 'Materials',
 *   category: 'Materials',
 *   job: 'Basement Waterproofing',
 *   job_id: 'uuid...', // optional
 *   job_no: 12,        // optional
 *   media_url: 'https://...',
 *   media_type: 'image/jpeg',
 *   media_transcript: '...ocr text...',
 *   media_confidence: 0.82
 * }
 *
 * ctx:
 * { owner_id, source_msg_id, user_name, mediaMetaNormalized }
 */
async function logReceipt(cil, ctx) {
  const ownerId = safeStr(ctx?.owner_id);
  if (!ownerId) throw new Error('Missing ctx.owner_id');

  const amountCents = Number(cil?.amount_cents ?? 0) || 0;
  if (!amountCents || amountCents <= 0) throw new Error('Invalid receipt amount_cents');

  const date = isoDateOrToday(cil?.date);

  const store = safeStr(cil?.store || cil?.source) || 'Unknown';
  const item = safeStr(cil?.item || cil?.description) || 'Receipt';
  const category = safeStr(cil?.category);

  const jobRef = safeStr(cil?.job);
  const job_id = cil?.job_id ?? null;
  const job_no = cil?.job_no ?? null;

  const sourceMsgId = safeStr(ctx?.source_msg_id);
  const userName = safeStr(ctx?.user_name || ctx?.actor_name || null);

  // Prefer ctx media meta (pipeline normalized), else accept cil media fields.
  const mediaMeta =
    ctx?.mediaMetaNormalized ||
    ctx?.mediaMeta ||
    {
      url: cil?.media_url || cil?.mediaUrl || null,
      type: cil?.media_type || cil?.mediaType || null,
      transcript: cil?.media_transcript || cil?.mediaTranscript || null,
      confidence: cil?.media_confidence ?? cil?.mediaConfidence ?? null
    };

  const result = await insertTransaction(
    {
      ownerId,
      kind: 'expense',
      date,
      description: item,
      amount_cents: amountCents,
      source: store,
      job: jobRef || null,
      job_id,
      job_no,
      job_name: safeStr(cil?.job_name) || jobRef || null,
      category,
      user_name: userName,
      source_msg_id: sourceMsgId,
      mediaMeta
    },
    { timeoutMs: 6000 }
  );

  const dollars = (amountCents / 100).toFixed(2);

  return {
    ok: true,
    inserted: !!result?.inserted,
    summary: result?.inserted
      ? `✅ Receipt logged: $${dollars} at ${store}${jobRef ? ` (job: ${jobRef})` : ''}.`
      : `✅ Already logged that receipt (duplicate message).`
  };
}

module.exports = { logReceipt };
