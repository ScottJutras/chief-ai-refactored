// handlers/commands/batchReceipts.js
//
// Sequential batch receipt capture for WhatsApp.
// User enters batch mode → sends photos one at a time → sends "done" to confirm all.
//
// Batch state: stored in public.settings as JSON under 'receipt_batch.session'.
// TTL: 2 hours from last activity (checked on read).
//
// Flow:
//   "batch receipts" → start session, confirm reply
//   [photo]          → OCR, add to session, silent ack with count
//   "done" / "confirm all" → show summary, ask for job name
//   [job name]       → create all transactions at once
//   "cancel batch"   → clear session

'use strict';

const pg = require('../../services/postgres');

const BATCH_SESSION_KEY = 'receipt_batch.session';
const BATCH_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function dbQuery(sql, params) {
  if (pg?.query) return pg.query(sql, params);
  if (pg?.pool?.query) return pg.pool.query(sql, params);
  throw new Error('postgres service has no query()');
}

// ── Settings helpers ────────────────────────────────────────────────────────

async function getSetting(ownerId, key) {
  const { rows } = await dbQuery(
    `SELECT value FROM public.settings WHERE owner_id = $1 AND key = $2 LIMIT 1`,
    [String(ownerId), key]
  );
  return rows?.[0]?.value ?? null;
}

async function setSetting(ownerId, key, value) {
  await dbQuery(
    `INSERT INTO public.settings (owner_id, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (owner_id, key)
     DO UPDATE SET value = excluded.value, updated_at = now()`,
    [String(ownerId), key, value == null ? null : String(value)]
  );
}

async function deleteSetting(ownerId, key) {
  await dbQuery(
    `DELETE FROM public.settings WHERE owner_id = $1 AND key = $2`,
    [String(ownerId), key]
  );
}

// ── Session ─────────────────────────────────────────────────────────────────

async function getSession(ownerId) {
  const raw = await getSetting(ownerId, BATCH_SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s || !s.active) return null;
    // TTL check
    const lastActivity = Number(s.last_activity_at) || 0;
    if (Date.now() - lastActivity > BATCH_TTL_MS) {
      await deleteSetting(ownerId, BATCH_SESSION_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

async function saveSession(ownerId, session) {
  session.last_activity_at = Date.now();
  await setSetting(ownerId, BATCH_SESSION_KEY, JSON.stringify(session));
}

async function clearSession(ownerId) {
  await deleteSetting(ownerId, BATCH_SESSION_KEY);
}

// ── Command detection ────────────────────────────────────────────────────────

function isBatchStartCommand(text) {
  const lc = String(text || '').trim().toLowerCase();
  return (
    /\b(batch|bulk)\s+(receipts?|upload|mode|scan)\b/.test(lc) ||
    /\bstart\s+(batch|bulk)\b/.test(lc) ||
    /^multi\s*receipts?$/.test(lc) ||
    /^bulk\s*receipts?$/.test(lc)
  );
}

function isBatchDoneCommand(text) {
  const lc = String(text || '').trim().toLowerCase();
  return (
    /^(done|all done|confirm\s+all|batch\s+done|end\s+batch|finish\s+batch)$/.test(lc)
  );
}

function isBatchCancelCommand(text) {
  const lc = String(text || '').trim().toLowerCase();
  return (
    /^(cancel\s+batch|cancel\s+bulk|stop\s+batch|clear\s+batch|batch\s+cancel)$/.test(lc)
  );
}

// ── Main handler ──────────────────────────────────────────────────────────────

/**
 * Called by the webhook router for non-media text messages when we need
 * to check batch session state (e.g., "done" command, cancel, job assignment).
 *
 * Returns { handled: true, twiml } or { handled: false }
 */
async function handleBatchTextCommand(text, ownerId) {
  const raw = String(text || '').trim();

  if (isBatchCancelCommand(raw)) {
    const session = await getSession(ownerId);
    if (!session) return { handled: false };
    await clearSession(ownerId);
    const n = (session.items || []).length;
    return {
      handled: true,
      replyText: `Batch cancelled. ${n > 0 ? `${n} queued receipt${n !== 1 ? 's' : ''} discarded.` : 'Nothing was saved.'}`
    };
  }

  if (isBatchDoneCommand(raw)) {
    const session = await getSession(ownerId);
    if (!session || !(session.items || []).length) return { handled: false };

    const items = session.items;
    const lines = items.map((item, i) => {
      const amt  = item.amount || '?';
      const vnd  = item.vendor || 'Unknown vendor';
      const dt   = item.date   || 'today';
      return `${i + 1}. ${amt} — ${vnd} (${dt})`;
    });

    // Mark session as awaiting job assignment
    session.awaiting_job = true;
    await saveSession(ownerId, session);

    return {
      handled: true,
      replyText: [
        `Got it. Here's your batch:`,
        ``,
        ...lines,
        ``,
        `${items.length} receipt${items.length !== 1 ? 's' : ''} ready to log.`,
        ``,
        `Which job are these for?`,
        `Reply with the job name (or "overhead" for general overhead).`,
      ].join('\n')
    };
  }

  // If session is awaiting a job name, treat this message as the job assignment
  const session = await getSession(ownerId);
  if (session?.awaiting_job && raw && raw.length >= 2) {
    const items = session.items || [];
    if (!items.length) {
      await clearSession(ownerId);
      return { handled: false };
    }

    // Return items + job name for the webhook to create transactions
    await clearSession(ownerId);
    return {
      handled: true,
      batchConfirm: {
        items,
        jobName: raw,
      }
    };
  }

  return { handled: false };
}

/**
 * Start a new batch session.
 * Called when user sends "batch receipts".
 */
async function startBatchSession(ownerId) {
  await saveSession(ownerId, { active: true, items: [], awaiting_job: false });
  return {
    handled: true,
    replyText: [
      `📎 *Batch receipt mode* — send your photos now.`,
      ``,
      `Each photo will be processed automatically.`,
      `When you're done, reply: *done*`,
      ``,
      `To cancel: reply *cancel batch*`,
    ].join('\n')
  };
}

/**
 * Add an OCR'd receipt to the current batch session.
 * Called from the image pipeline when a batch session is active.
 * Returns { added: true, count } or { added: false }
 */
async function addReceiptToBatch(ownerId, { amount, vendor, date, rawText, stableMediaMsgId }) {
  const session = await getSession(ownerId);
  if (!session || !session.active) return { added: false };

  session.items = session.items || [];
  session.items.push({
    amount:           amount || null,
    vendor:           vendor || null,
    date:             date   || null,
    raw_text:         rawText ? String(rawText).slice(0, 500) : null,
    stable_media_msg_id: stableMediaMsgId || null,
    added_at:         new Date().toISOString(),
  });

  await saveSession(ownerId, session);
  return { added: true, count: session.items.length };
}

/**
 * Check if batch session is active for this owner.
 */
async function isBatchActive(ownerId) {
  const session = await getSession(ownerId);
  return !!(session?.active);
}

module.exports = {
  isBatchStartCommand,
  isBatchDoneCommand,
  isBatchCancelCommand,
  handleBatchTextCommand,
  startBatchSession,
  addReceiptToBatch,
  isBatchActive,
  clearSession,
};
