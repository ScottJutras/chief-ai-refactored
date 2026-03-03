// routes/webhook.js
//
// ✅ COMPLETE DROP-IN (updated to fix Twilio list picker "index vs job_no" bug)
//
// Key changes vs your current webhook.js:
// ✅ getInboundText() now returns `jobix_<index>` for Content-Template list clicks like `job_3_552e375c`
//    (instead of incorrectly returning `jobno_3`).
// ✅ If ListTitle contains a stamped job number like `J8`, getInboundText() returns `jobno_8`.
// ✅ looksLikeJobPickerReplyToken() recognizes `jobix_`.
// ✅ Fixes multiple syntax issues in the pasted file (missing backticks, broken template strings, bad regex escapes).
// ✅ Keeps all your existing routing: pending_actions first, then legacy pending state, then fast paths, then other commands.
// ✅ Preserves 8s safety timer and safe empty TwiML defaults.

const express = require('express');
const querystring = require('querystring');

const router = express.Router();
const app = express();
const { handleJobPickSelection } = require('../handlers/system/jobPickRouter');

const { flags } = require('../config/flags');
const { handleClock, handleTimesheetCommand } = require('../handlers/commands/timeclock'); // v2 handler (optional)
console.log('[DEBUG] handleTimesheetCommand?', typeof handleTimesheetCommand);

const { handleForecast } = require('../handlers/commands/forecast');
const { getOwnerUuidForPhone } = require('../services/owners'); // optional map phone -> uuid (store separately)
const { twimlWithTargetName } = require('../handlers/commands/timeclock');
console.log('[DEBUG] twimlWithTargetName?', typeof twimlWithTargetName);

const { handleQuoteCommand, isQuoteCommand } = require('../handlers/commands/quote');
const { getUserByName } = require('../services/users');

const stateManager = require('../utils/stateManager');
const { getPendingTransactionState } = stateManager;
const { resolveInboundTextFromTwilio } = require('../services/whatsapp/inboundInteractive');

// Prefer mergePendingTransactionState; fall back to setPendingTransactionState (older builds)
const mergePendingTransactionState =
  stateManager.mergePendingTransactionState ||
  (async (userId, patch) => stateManager.setPendingTransactionState(userId, patch, { merge: true }));

const pg = require('../services/postgres');
const { query } = pg;
const { normalizeTranscriptMoney, stripLeadingFiller } = require('../utils/transcriptNormalize');
const twilioSvc = require('../services/twilio');
const sendWhatsApp = twilioSvc.sendWhatsApp;
const { getEffectivePlanKey } = require("../src/config/getEffectivePlanKey");
const { buildCommandsMessage } = require("../services/commands_message");
/* ---------------- Small helpers ---------------- */
// ✅ XML escape helper for TwiML (single source of truth in this file)
function escapeXml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlEmpty() {
  // ✅ IMPORTANT:
  // Must NOT include <Message></Message> or Twilio will attempt to send an empty reply (14103).
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

function twimlText(text) {
  const t = String(text ?? '').trim();
  if (!t) return twimlEmpty(); // ✅ never emit empty <Message>
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(t)}</Message></Response>`;
}

/// ✅ bulletproof TwiML sender (never sends an "empty Message" which causes Twilio 14103)
function sendTwiml(res, xml) {
  if (!res || res.headersSent) return;

  // Accept raw TwiML string OR object { twiml: '...' }
  let out = xml;
  if (out && typeof out === 'object' && typeof out.twiml === 'string') out = out.twiml;

  out = String(out || '').trim();

  // ✅ If missing, return truly empty TwiML (no bubble)
  if (!out) out = twimlEmpty();

  // ✅ CRITICAL: if someone returned "<Response><Message></Message></Response>",
  // Twilio interprets it as "send an outbound reply with blank body" → 14103.
  // Normalize it to empty <Response></Response>.
  const normalized = out.replace(/\s+/g, '');
  if (
    normalized === '<Response><Message></Message></Response>' ||
    normalized === '<?xmlversion="1.0"encoding="UTF-8"?><Response><Message></Message></Response>'
  ) {
    out = twimlEmpty();
  }

  // ✅ Also guard against "<Message/>" variants
  if (/<Message\s*\/>/.test(out) || /<Message>\s*<\/Message>/.test(out)) {
    out = twimlEmpty();
  }

  return res.status(200).type('text/xml; charset=utf-8').send(out);
}

// Safe default:
// ok(res) -> empty TwiML (no bubble)
// ok(res, "text") -> visible bubble
function ok(res, text = null) {
  if (!res || res.headersSent) return;

  const t = text == null ? '' : String(text).trim();
  if (!t) return sendTwiml(res, twimlEmpty());
  return sendTwiml(res, twimlText(t));
}



const normalizePhone = (raw = '') =>
  String(raw || '').replace(/^whatsapp:/i, '').replace(/\D/g, '') || null;

// --- v2 multi-target helpers (crew + name list) ---
// Uses your existing imports:
//   const pg = require('../services/postgres');
//   const { getUserByName } = require('../services/users');

function splitNameList(raw) {
  let s = String(raw || '')
    .replace(/\band\b/gi, ',')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return [];

  // If they used commas, split on commas
  if (s.includes(',')) {
    return s
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);
  }

  // Otherwise, they likely used spaces: "Scott Justin Tyler"
  // Keep it conservative: split into tokens, then recombine common 2-word names.
  const parts = s.split(' ').filter(Boolean);

  // If only one token, it's a single name
  if (parts.length <= 1) return parts;

  // Conservative heuristic:
  // - treat each token as a name
  // - BUT if the user has 2-word names in your directory, getUserByName() will still catch them
  //   when we also try pairing adjacent tokens (handled below).
  return parts;
}


function hasCrewToken(text) {
  return /\bcrew\b/i.test(String(text || ''));
}

function extractTargetPhrase(text) {
  const s = String(text || '').trim();

  // Strip job hint if present ("@ Roof Repair")
  const withoutJob = s.split(/\s+@\s+/)[0].trim();

  // Preferred: "... for <targets>"
  let m = withoutJob.match(/\bfor\s+(.+)$/i);
  if (m && m[1]) return m[1].trim();

  // Fallback: "<action> <targets>"
  // We only capture targets if they come AFTER a known action phrase
  m = withoutJob.match(
    /\b(clock\s*in|clock\s*out|break\s*(?:start|stop|end)|lunch\s*(?:start|stop|end)|drive\s*(?:start|stop|end))\s+(.+)$/i
  );
  if (m && m[2]) return m[2].trim();

  return '';
}


async function getCrewUsers(ownerId) {
  // Returns [{id, name}] for team members
  try {
    const { rows } = await pg.query(
      `SELECT user_id, name
         FROM public.users
        WHERE owner_id=$1
          AND is_team_member=true`,
      [String(ownerId || '').trim()]
    );

    return (rows || [])
      .map(r => ({
        id: String(r.user_id || '').replace(/\D/g, ''),
        name: String(r.name || '').trim()
      }))
      .filter(x => x.id);
  } catch (e) {
    console.warn('[CREW] failed to load crew users:', e?.message);
    return [];
  }
}

async function resolveTargetUserIdsFromText({ ownerId, text }) {
  const owner_id = String(ownerId || '').trim();
  if (!owner_id) return { mode: 'self', targets: [], namesById: {} };

  // Crew
  if (hasCrewToken(text)) {
    const crew = await getCrewUsers(owner_id);
    const targets = crew.map(x => x.id);
    const namesById = Object.fromEntries(crew.map(x => [x.id, x.name || x.id]));
    return { mode: 'crew', targets, namesById };
  }

  // Explicit names list
  const phrase = extractTargetPhrase(text);
  const rawNames = splitNameList(phrase);
  if (!rawNames.length) return { mode: 'self', targets: [], namesById: {} };

  // Build candidate names:
  // - if comma list: each entry already a candidate
  // - if space tokens: try single tokens + adjacent pairs (to support "Mary Jane")
  const candidates = [];
  for (let i = 0; i < rawNames.length; i++) {
    const a = String(rawNames[i] || '').trim();
    if (a) candidates.push(a);

    const b = String(rawNames[i + 1] || '').trim();
    if (a && b) candidates.push(`${a} ${b}`);
  }

  // Dedupe while preserving order
  const seen = new Set();
  const uniqCandidates = candidates.filter(n => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const hits = [];
  const namesById = {};

  for (const nm of uniqCandidates) {
    const u = await getUserByName(owner_id, nm).catch(() => null);
    const id = u?.user_id ? String(u.user_id).replace(/\D/g, '') : '';
    if (!id) continue;

    // If we already resolved this id, keep the first/best name we saw
    if (!namesById[id]) namesById[id] = String(u?.name || nm || id).trim();
    hits.push(id);
  }

  const targets = Array.from(new Set(hits));
  if (!targets.length) return { mode: 'names', targets: [], namesById: {} };

  return { mode: 'names', targets, namesById };
}


function aggregateCrewMessage({ action, count, previewNames = [], baseText }) {
  const a = String(action || '').toLowerCase();

  const map = {
    in: '✅ Clocked in',
    out: '✅ Clocked out',
    break_start: '⏸️ Break started',
    break_stop: '▶️ Break ended',
    lunch_start: '🍽️ Lunch started',
    lunch_stop: '🍽️ Lunch stopped',
    drive_start: '🚚 Drive started',
    drive_stop: '🅿️ Drive stopped'
  };

  const bt = String(baseText || '').trim();
  const head =
    map[a] ||
    (parts[0] || 'Time logged.')
      .replace(/\s+for\s+.+$/i, '')
      .trim();

  const preview =
    Array.isArray(previewNames) && previewNames.length && count <= 4
      ? ` (${count} people: ${previewNames.slice(0, 4).join(', ')})`
      : ` (${count} people)`;

  return `${head} for Crew${preview}.${tail ? `\n${tail}` : ''}`;
}



/* ---------------- WhatsApp Link Code helpers ---------------- */

// ✅ Canonical phone normalization for identity map (store +E164 only)
function normalizeE164(fromRaw) {
  // Twilio often gives: "whatsapp:+14165551234"
  const s = String(fromRaw || "").trim();
  const m = s.match(/\+?[0-9]{8,15}/);
  if (!m) return null;
  const digits = m[0].startsWith("+") ? m[0] : `+${m[0]}`;
  return digits;
}

function parseLinkCommand(raw = '') {
  const s = String(raw || '').trim();

  // LINK 123456  (legacy)
  let m = s.match(/^link\s+([a-z0-9]{4,12})$/i);
  if (m) return String(m[1]).trim();

  // Just the code: 123456
  m = s.match(/^([0-9]{6})$/);
  if (m) return String(m[1]).trim();

  return null;
}



// Uses your existing pg.query connection
async function redeemLinkCodeToTenant({ code, fromPhone }) {
  const cleanCode = String(code || '').trim();
  const phone = String(fromPhone || '').trim();

  if (!cleanCode || !phone) return { ok: false, error: 'Missing code or phone.' };

  // 1) Atomically "claim" the code (mark used) and get tenant_id.
  // This prevents races + ensures one-time use.
  const claimed = await query(
    `
    WITH claimed AS (
      UPDATE public.chiefos_link_codes
         SET used_at = now()
       WHERE code = $1
         AND used_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       RETURNING tenant_id
    )
    SELECT tenant_id FROM claimed
    `,
    [cleanCode]
  );

  const tenantId = claimed?.rows?.[0]?.tenant_id;
  if (!tenantId) {
    return {
      ok: false,
      error: 'That code was already used or expired. Generate a new one in the portal.'
    };
  }

  // 2) Upsert identity mapping (WhatsApp phone -> tenant)
  await query(
    `
    INSERT INTO public.chiefos_identity_map (tenant_id, kind, identifier, created_at)
    VALUES ($1, 'whatsapp', $2, now())
    ON CONFLICT (kind, identifier)
    DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      updated_at = now()
    `,
    [tenantId, phone]
  );

  return { ok: true, tenantId };
}


function pickFirstMedia(body = {}) {
  const n = parseInt(body.NumMedia || '0', 10) || 0;
  if (n <= 0) return { n: 0, url: null, type: null };
  const url = body.MediaUrl0 || body.MediaUrl || null;
  const typ = body.MediaContentType0 || body.MediaContentType || null;
  return { n, url, type: typ ? String(typ).toLowerCase() : null };
}


function canUseAgent(ownerProfile) {
  const planKey = getEffectivePlanKey(ownerProfile);
  return planKey === "pro";
}


function looksHardCommand(lc) {
  return (
    /^(create|new)\s+job\b/.test(lc) ||
    /^(jobs|list jobs|show jobs)\b/.test(lc) ||
    /^active\s+job\b/.test(lc) ||
    /^set\s+active\b/.test(lc) ||
    /^switch\s+job\b/.test(lc) ||
    /^change\s+job\b/.test(lc) ||
    /^(show\s+active\s+jobs|active\s+jobs|list\s+active\s+jobs|pick\s+job)\b/.test(lc) ||
    /^task\b/.test(lc) ||
    /^my\s+tasks\b/.test(lc) ||
    /^team\s+tasks\b/.test(lc) ||
    /^done\s*#?\d+/.test(lc) ||
    /^clock\b/.test(lc) ||
    /^break\b/.test(lc) ||
    /^drive\b/.test(lc) ||
    /^expense\b/.test(lc) ||
    /^revenue\b/.test(lc)
  );
}
function looksHardTimeCommand(str) {
  const s = String(str || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const compact = s.replace(/\s+/g, '');

  // undo
  if (/^undo(\s+last)?$/.test(s) || /^undolast$/.test(compact)) return true;

  // timesheet
  if (/^timesheet\b/.test(s)) return true;

  // clock in/out (space + no-space)
  if (/^clock\s*in\b/.test(s) || /^clockin\b/.test(compact)) return true;
  if (/^clock\s*out\b/.test(s) || /^clockout\b/.test(compact)) return true;

  // segments (space form)
  const isSeg =
    /^break\s+(start|stop|end)(ed)?\b/.test(s) ||
    /^lunch\s+(start|stop|end)(ed)?\b/.test(s) ||
    /^drive\s+(start|stop|end)(ed)?\b/.test(s);

  if (isSeg) return true;

  // segments (compact form)
  if (
    /^(break|lunch|drive)(start|stop|end)(ed)?$/.test(compact) ||
    /^(start|stop|end)(break|lunch|drive)(ed)?$/.test(compact)
  ) return true;

  return false;
}


// Allowed while a pending expense/revenue exists (so we don't nudge-block them)
function isAllowedWhilePending(lc) {
  return /^(yes|y|confirm|edit|cancel|no|skip|stop|more|overhead|oh|change job|switch job|pick job|change_job)\b/.test(lc);
}

// "global job picker intents" (typed commands)
function isJobPickerIntent(lc) {
  return /^(change\s+job|switch\s+job|pick\s+job|show\s+active\s+jobs|active\s+jobs|list\s+active\s+jobs)\b/.test(lc);
}

function looksLikeJobPickerReplyToken(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return false;

  if (t === 'more' || t === 'overhead' || t === 'oh') return true;
  if (/^\d{1,10}$/.test(t)) return true;

  return (
    /^jobno_\d{1,10}$/.test(t) ||
    /^jobix_\d{1,10}$/.test(t) ||
    /^job_\d{1,10}_[0-9a-z]+$/.test(t) ||
    /^jp:[0-9a-f]{8}:[0-9a-f]{8}:jn:\d{1,10}:h:[0-9a-f]{10,16}$/.test(t)
  );
}



function pendingTxnNudgeMessage(pending) {
  // If user is mid-edit, do not nag. Next message is edit payload.
  if (pending?.confirmDraft?.awaiting_edit || pending?.edit_mode) return null;

  const type = pending?.type || pending?.kind || 'entry';

  return [
    `You’ve got an unfinished ${type} waiting for confirmation.`,
    ``,
    `Reply:`,
    `• "yes" to submit it`,
    `• "edit" to change it`,
    `• "cancel" to discard it`,
    `• "skip" to keep it pending and continue`
  ].join('\n');
}
// routes/webhook.js (DROP-IN) — DB degraded wrappers for webhook-level DB calls

function isTransientDbError(e) {
  const msg = String(e?.message || '');
  const code = String(e?.code || '');
  const status = String(e?.status || '');

  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|EPIPE|ENOTFOUND|socket hang up|Connection terminated|server closed the connection/i.test(msg)) return true;
  if (/(57P01|57P02|57P03|53300|53400|08006|08003|08001|08004)/.test(code)) return true;
  if (/^5\d\d$/.test(status)) return true;
  if (/internal server error|unexpected response|fetch failed/i.test(msg)) return true;

  return false;
}

function withDeadline(promise, ms, label = 'deadline') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))
  ]);
}

/**
 * Wrap a DB call:
 * - if transient error OR deadline hit -> mark req.dbDegraded=true and return fallback
 * - otherwise rethrow (so you don't hide real bugs)
 */
async function safeDb(req, name, fn, { fallback = null, ms = 2500 } = {}) {
  const safeName = String(name || 'db').replace(/\s+/g, '_');

  try {
    const p = typeof fn === 'function' ? fn() : fn;
    return await withDeadline(Promise.resolve(p), ms, `${safeName}_timeout`);
  } catch (e) {
    const msg = String(e?.message || '');
    const transient = isTransientDbError(e) || msg.includes(`${safeName}_timeout`);

    if (transient) {
      req.dbDegraded = true;

      console.warn(`[WEBHOOK] ${safeName} degraded (fallback)`, {
        phase: req?._phase || req?.phase || null, // see note below
        ownerId: req.ownerId || null,
        from: req.from || req.fromPhone || req.body?.From || null,
        messageSid: req.body?.MessageSid || req.body?.SmsMessageSid || null,
        message: msg,
        code: e?.code,
        status: e?.status
      });

      return fallback;
    }

    // Non-transient: real bug, bubble up
    throw e;
  }
}




/* -----------------------------------------------------------------------
 * ✅ Inbound text normalization (SAFE)
 *
 * Rule:
 * - Prefer stable IDs provided by Twilio (RowId/ListId/ButtonPayload)
 * - Do NOT rewrite list IDs into job indexes (jobix_*) — this causes loops.
 * - Do NOT infer job numbers from list titles (unless it is explicitly stamped like "J8")
 *
 * This is compatible with your new picker row ids: "jp:<flow8>:<nonce>:jn:<jobNo>:h:<sig>"
 * ----------------------------------------------------------------------- */

function getInboundText(body = {}) {
  const b = body || {};

  // 1) Buttons / quick replies
  const payload = String(b.ButtonPayload || b.buttonPayload || '').trim();
  if (payload) return payload.toLowerCase();

  const btnText = String(b.ButtonText || b.buttonText || '').trim();
  if (btnText && btnText.length <= 40) return btnText.toLowerCase();

  // 2) InteractiveResponseJson (best signal if present)
  const irj = b.InteractiveResponseJson || b.interactiveResponseJson || null;
  if (irj) {
    try {
      const json = typeof irj === 'string' ? JSON.parse(irj) : irj;

      const id =
        json?.list_reply?.id ||
        json?.listReply?.id ||
        json?.interactive?.list_reply?.id ||
        json?.interactive?.listReply?.id ||
        '';

      const title =
        json?.list_reply?.title ||
        json?.listReply?.title ||
        json?.interactive?.list_reply?.title ||
        json?.interactive?.listReply?.title ||
        '';

      const pickedId = String(id || '').trim();
      const pickedTitle = String(title || '').trim();

      // If title contains stamped job number like "J8", allow explicit recovery
      const stamped = extractStampedJobNo(pickedTitle);
      if (stamped) return `jobno_${stamped}`;

      // ✅ Prefer ID as-is (this is where "jp:..." will come through)
      if (pickedId) return pickedId;

      // Fallback to title only if no id
      if (pickedTitle) return pickedTitle;
    } catch {}
  }

  // 3) Twilio list picker fields (prefer IDs)
  const listRowId = String(b.ListRowId || b.ListRowID || b.listRowId || b.listRowID || '').trim();
  const listId = String(
    b.ListId ||
      b.listId ||
      b.ListItemId ||
      b.listItemId ||
      b.ListReplyId ||
      b.listReplyId ||
      ''
  ).trim();

  if (listRowId) return listRowId; // ✅ "jp:..." stable
  if (listId) return listId;       // ✅ "jp:..." stable

  // Titles only as a last resort
  const listRowTitle = String(b.ListRowTitle || b.listRowTitle || '').trim();
  const listTitle = String(
    b.ListTitle ||
      b.listTitle ||
      b.ListItemTitle ||
      b.listItemTitle ||
      b.ListReplyTitle ||
      b.listReplyTitle ||
      ''
  ).trim();

  const candidateTitle = listRowTitle || listTitle;

  const stamped = extractStampedJobNo(candidateTitle);
  if (stamped) return `jobno_${stamped}`;

  const rawBody = String(b.Body || '').trim();
  if (rawBody) return rawBody;

  if (candidateTitle) return candidateTitle;

  return '';
}

function extractStampedJobNo(title = '') {
  const s = String(title || '').trim();
  if (!s) return null;
  const m = s.match(/\bJ(\d{1,10})\b/i);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}


/**
 * Extracts a job picker *index* from either:
 * - Content-template token: "job_5_44fc8181" => 5
 * - Title prefix: "#5 Happy Road" => 5
 * Returns number or null.
 */
function extractJobPickerIndexFromToken(s) {
  const str = String(s || '').trim();
  if (!str) return null;

  // job_<index>_<nonce>
  let m = str.match(/^job_(\d+)_/i);
  if (m?.[1]) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  // "#<index> <title>"
  m = str.match(/^#\s*(\d+)\b/);
  if (m?.[1]) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}


function looksTimesheetCommand(str) {
  const s = String(str || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return /^timesheet\b/.test(s);
}

/* ---------------- NL heuristics for expense/revenue ---------------- */

function hasMoneyAmount(str) {
  const s = String(str || '');

  const hasDollar = /\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/.test(s);
  const hasWordAmount = /\b\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s(?:dollars|bucks|cad|usd)\b/i.test(s);

  const hasBareNumberWithHint =
    /\b(?:for|paid|spent|received|cost|total)\s+\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\b/i.test(s) ||
    /\b\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s+\b(?:for|paid|spent|received|cost|total)\b/i.test(s);

  return hasDollar || hasWordAmount || hasBareNumberWithHint;
}

function looksExpenseNl(str) {
  const s = String(str || '').trim().toLowerCase();
  if (!hasMoneyAmount(s)) return false;

  const verb =
    /\b(bought|buy|purchased|purchase|spent|spend|paid|pay|picked\s*up|cost|ordered|charge|charged)\b/.test(s) ||
    /\b(on|for)\b/.test(s);

  if (!verb) return false;
  // ✅ If it's a "money came in" phrase, do NOT treat as expense NL.
// Include common misspelling "payed".
if (/\b(received|payment|deposit|got\s+pa(?:i|y)ed|just\s+got\s+pa(?:i|y)ed)\b/.test(s)) return false;


  if (
    /^(create|new)\s+job\b/.test(s) ||
    /^active\s+job\b/.test(s) ||
    /^set\s+active\b/.test(s) ||
    /^switch\s+job\b/.test(s) ||
    /^change\s+job\b/.test(s) ||
    /^(show\s+active\s+jobs|active\s+jobs|list\s+active\s+jobs|pick\s+job)\b/.test(s) ||
    /^clock\b/.test(s) ||
    /^break\b/.test(s) ||
    /^drive\b/.test(s) ||
    /^task\b/.test(s) ||
    /^my\s+tasks\b/.test(s)
  ) {
    return false;
  }

  return true;
}

function looksRevenueNl(str) {
  const s = String(str || '').trim().toLowerCase();
  if (!hasMoneyAmount(s)) return false;
  // ✅ include common misspelling "payed"
if (/\b(received|revenue|rev|payment|deposit|got\s+pa(?:i|y)ed|just\s+got\s+pa(?:i|y)ed)\b/.test(s)) return true;
  if (/\b(paid)\b/.test(s) && /\b(from|client|customer)\b/.test(s)) return true;
  return false;
}
function lc(s) {
  return String(s || '').toLowerCase();
}

function hasAny(haystack, patterns) {
  const t = lc(haystack);
  return patterns.some((p) => p.test(t));
}

function strongExpenseCue(text) {
  // "paid for" is ambiguous (could be expense OR "paid for invoice").
  // Keep it, but don't treat it as "strong" like spent/bought/receipt.
  const strong = [
    /\bspent\b/i,
    /\bbought\b/i,
    /\bpurchase\b/i,
    /\breceipt\b/i,
    /\btotal\b/i,
    /\btax\b/i
  ];
  return hasAny(text, strong);
}

function revenueCue(text) {
  const cues = [
    /\breceived\b/i,
    /\bpaid\b/i,               // revenue: "paid $X"
    /\bpayment\b/i,
    /\bdeposit\b/i,
    /\be[-\s]?transfer\b/i,
    /\betransfer\b/i,
    /\binterac\b/i,
    /\binvoice\s+paid\b/i,
    /\bcheque\b/i,
    /\bcheck\b/i,
    /\bwire\b/i,
    /\btransfer\b/i
  ];
  return hasAny(text, cues);
}

function expenseCue(text) {
  const cues = [
    /\bbought\b/i,
    /\bspent\b/i,
    /\bpurchase\b/i,
    /\breceipt\b/i,
    /\btotal\b/i,
    /\btax\b/i,
    /\bhome\s+depot\b/i,
    /\blumber\b/i,
    /\btools?\b/i,
    /\bgas\b/i,
    /\bfuel\b/i,
    /\bpaid\s+for\b/i
  ];
  return hasAny(text, cues);
}

function receivedChequeDepositCue(text) {
  // tie-breaker: "received" + (cheque/check/deposit)
  const t = lc(text);
  const hasReceived = /\breceived\b/i.test(t) || /\bjust\s+got\b/i.test(t) || /\bgot\b/i.test(t);
  const hasInstrument = /\bcheque\b/i.test(t) || /\bcheck\b/i.test(t) || /\bdeposit\b/i.test(t);
  return !!(hasReceived && hasInstrument);
}

/**
 * ✅ Minimal deterministic classifier for "expense vs revenue"
 * Returns: 'revenue' | 'expense' | null
 */
function classifyMoneyIntent(text) {
  const hasRev = revenueCue(text);
  const hasExp = expenseCue(text);
  const strongExp = strongExpenseCue(text);

  // Revenue precedence:
  // If we see revenue cues and NOT strong expense cues → revenue
  if (hasRev && !strongExp) return 'revenue';

  // If both match, prefer revenue when "received + cheque/check/deposit"
  if (hasRev && hasExp && receivedChequeDepositCue(text)) return 'revenue';

  // Otherwise, expense if expense cues are present
  if (hasExp) return 'expense';

  // Unknown
  return null;
}

/* ---------------- Pending Actions (Option A) ---------------- */

const PA_KIND_PICK_JOB_EXPENSE = 'pick_job_for_expense';
const PA_KIND_CONFIRM_EXPENSE = 'confirm_expense';

// optional (if you add revenue Option A later)
const PA_KIND_PICK_JOB_REVENUE = 'pick_job_for_revenue';
const PA_KIND_CONFIRM_REVENUE = 'confirm_revenue';

// ✅ IMPORTANT: Only use getPendingActionByKind if it exists.
const pgGetPendingActionByKind =
  (typeof pg.getPendingActionByKind === 'function' && pg.getPendingActionByKind) || null;
const pgDeletePendingActionByKind =
  (typeof pg.deletePendingActionByKind === 'function' && pg.deletePendingActionByKind) || null;

// TTL minutes for SQL fallback. Should match services/postgres.js PENDING_TTL_MIN.
const PA_TTL_MIN = Number(process.env.PENDING_TTL_MIN || 10);

async function getPA({ ownerId, userId, kind }) {
  const owner = String(ownerId || '').trim();
  const rawUser = String(userId || '').trim();
  const k = String(kind || '').trim();
  if (!owner || !rawUser || !k) return null;

  const digits =
    (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(rawUser)) ||
    rawUser.replace(/\D/g, '');

  const candidateUserIds = Array.from(new Set([rawUser, digits].filter(Boolean)));

  // Prefer newest by created_at when multiple exist
  const pickNewest = (rows = []) => {
    const arr = (rows || []).filter(Boolean);
    if (arr.length <= 1) return arr[0] || null;
    arr.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return arr[0] || null;
  };

  // ---------- Option A fast path ----------
  if (pgGetPendingActionByKind) {
    try {
      const hits = await Promise.all(
        candidateUserIds.map(async (uid) => {
          try {
            const r = await pgGetPendingActionByKind({ ownerId: owner, userId: uid, kind: k });
            if (!r) return null;
            if (r.payload != null) return r;
            if (typeof r === 'object') return { payload: r };
            return null;
          } catch {
            return null;
          }
        })
      );

      const best = pickNewest(hits);
      if (best) return best;
    } catch {
      // fall through to SQL
    }
  }

  // ---------- SQL fallback ----------
  try {
    const rs = await Promise.all(
      candidateUserIds.map((uid) =>
        query(
          `
          SELECT id, kind, payload, created_at
            FROM public.pending_actions
           WHERE owner_id = $1
             AND user_id = $2
             AND kind = $3
             AND created_at > now() - (($4::text || ' minutes')::interval)
           ORDER BY created_at DESC
           LIMIT 1
          `,
          [owner, uid, k, String(PA_TTL_MIN)]
        ).catch(() => null)
      )
    );

    const rows = rs.map((r) => r?.rows?.[0] || null).filter(Boolean);
    return pickNewest(rows);
  } catch {
    return null;
  }
}


async function deletePA({ ownerId, userId, kind }) {
  const owner = String(ownerId || '').trim();
  const rawUser = String(userId || '').trim();
  const k = String(kind || '').trim();
  if (!owner || !rawUser || !k) return;

  const digits =
    (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(rawUser)) ||
    rawUser.replace(/\D/g, '');

  const candidateUserIds = Array.from(new Set([rawUser, digits].filter(Boolean)));

  // Option A delete (if provided)
  if (pgDeletePendingActionByKind) {
    await Promise.all(
      candidateUserIds.map((uid) =>
        pgDeletePendingActionByKind({ ownerId: owner, userId: uid, kind: k }).catch(() => null)
      )
    );
    return;
  }

  // SQL fallback
  await Promise.all(
    candidateUserIds.map((uid) =>
      query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [owner, uid, k]).catch(
        () => null
      )
    )
  );
}


async function clearAllPendingForUser({ ownerId, from }) {
  const rawFrom = String(from || '').trim();

  // ✅ Canonical keys used across handlers / PA storage (digits-only)
  const actorDigits =
    (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(rawFrom)) ||
    rawFrom.replace(/\D/g, '');

  // ✅ Clear BOTH possible PA keys defensively:
  // - digits-only (the correct canonical key)
  // - rawFrom (legacy callers / older stored keys)
  const candidateUserIds = Array.from(
    new Set([actorDigits, rawFrom].filter(Boolean).map((x) => String(x).trim()))
  );

  const kinds = [
    PA_KIND_CONFIRM_EXPENSE,
    PA_KIND_PICK_JOB_EXPENSE,
    PA_KIND_CONFIRM_REVENUE,
    PA_KIND_PICK_JOB_REVENUE,
    'timeclock.confirm'
  ];

  // ✅ Delete all PAs for both keys (idempotent)
  await Promise.all(
    candidateUserIds.flatMap((uid) =>
      kinds.map((k) => deletePA({ ownerId, userId: uid, kind: k }).catch(() => null))
    )
  );

  // legacy state cleanup (safe)
  try {
    if (typeof stateManager.clearFinanceFlow === 'function') {
      await stateManager.clearFinanceFlow(rawFrom).catch(() => null);
      // also clear by digits, because stateManager normalizes anyway but this is explicit
      if (actorDigits && actorDigits !== rawFrom) {
        await stateManager.clearFinanceFlow(actorDigits).catch(() => null);
      }
    }
  } catch {}

  try {
    if (typeof stateManager.deletePendingTransactionState === 'function') {
      await stateManager.deletePendingTransactionState(rawFrom).catch(() => null);
      if (actorDigits && actorDigits !== rawFrom) {
        await stateManager.deletePendingTransactionState(actorDigits).catch(() => null);
      }
    }
  } catch {}
}


async function hasExpensePA(ownerId, from) {
  const rawFrom = String(from || '').trim();

  const digits =
    (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(rawFrom)) ||
    rawFrom.replace(/\D/g, '');

  const candidateUserIds = Array.from(new Set([rawFrom, digits].filter(Boolean)));

  try {
    // Fetch both kinds across both candidate keys, pick the most recent hit if multiple exist.
    const results = await Promise.all(
      candidateUserIds.flatMap((uid) => [
        getPA({ ownerId, userId: uid, kind: PA_KIND_PICK_JOB_EXPENSE }),
        getPA({ ownerId, userId: uid, kind: PA_KIND_CONFIRM_EXPENSE })
      ])
    );

    // results order is [pick(raw), conf(raw), pick(digits), conf(digits)] (if both keys exist)
    const pickCandidates = [results[0], results[2]].filter(Boolean);
    const confCandidates = [results[1], results[3]].filter(Boolean);

    const pick =
      pickCandidates.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0] || null;

    const conf =
      confCandidates.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0] || null;

    const hasAny = !!(pick?.payload || conf?.payload);

    return { pick, conf, hasAny };
  } catch {
    return { pick: null, conf: null, hasAny: false };
  }
}


function normBare(s = "") {
  return String(s || "").trim().toLowerCase().replace(/[.!?]+$/g, "");
}

function isBareExpense(text = "") {
  const s = normBare(text);
  return s === "expense" || s === "an expense" || s === "a expense";
}
function isBareRevenue(text = "") {
  const s = normBare(text);
  return s === "revenue" || s === "a revenue" || s === "an revenue";
}
function isBareTask(text = "") {
  const s = normBare(text);
  return s === "task" || s === "a task" || s === "an task" || s === "todo";
}
function isBareTime(text = "") {
  const s = normBare(text);
  return s === "time" || s === "clock" || s === "timesheet";
}
function isBareJob(text = "") {
  const s = normBare(text);
  return s === "job" || s === "a job" || s === "an job" || s === "jobs";
}

async function maybeAutoYesAfterEdit({
  userId,
  kind,            // 'expense' | 'revenue'
  handlerFn,       // handleExpense | handleRevenue
  handlerArgs,     // array of args you used for the first call
  firstResult,
  getPendingTransactionState,
  mergePendingTransactionState,
  messageSid
}) {
  // Local strict token detector (do NOT rely on fuzzy parsing)
  const strictControlTokenForPA = (raw) => {
    const t = String(raw || '').trim().toLowerCase();
    if (!t) return null;

    // normalize common variants
    if (t === 'y' || t === 'yeah' || t === 'yep' || t === 'ok' || t === 'okay') return 'yes';

    // exact allow-list only
    if (t === 'yes') return 'yes';
    if (t === 'edit') return 'edit';
    if (t === 'cancel') return 'cancel';
    if (t === 'resume') return 'resume';
    if (t === 'skip') return 'skip';
    if (t === 'change_job' || t === 'change job') return 'change_job';

    return null;
  };

  try {
    // Defensive: if inbound is a strict control token, never auto-yes.
    // (Webhooks should already skip calling us in this case, but we guard anyway.)
    const inboundText = handlerArgs && handlerArgs.length >= 2 ? handlerArgs[1] : '';
    const strictTok = strictControlTokenForPA(inboundText);
    if (strictTok) {
      return firstResult;
    }

    let pending = null;
try {
  // best effort: if DB degraded, skip auto-yes rather than breaking flow
  pending = await safeDb(
    { dbDegraded: false }, // local shim; we don't have req here
    'getPendingTransactionState_autoYes',
    () => getPendingTransactionState(userId),
    { fallback: null, ms: 2500 }
  );
} catch (e) {
  console.warn('[WEBHOOK] autoYes pending state failed (non-transient):', e?.message);
  pending = null;
}

    if (!pending?._autoYesAfterEdit) return firstResult;

    // ✅ Correlate: only auto-yes for the specific inbound message that set the flag.
    // If sourceMsgId is set and doesn't match, do NOT clear the flag — just ignore.
    const src = String(pending?._autoYesSourceMsgId || '').trim();
    const mid = String(messageSid || '').trim();

    if (src && mid && src !== mid) {
      console.info('[AUTO_YES_AFTER_EDIT] skip (msg mismatch)', {
        userId,
        kind,
        pendingSourceMsgId: src,
        messageSid: mid
      });
      return firstResult;
    }

    // ✅ Now that we are actually going to fire, clear the flag first (prevents loops)
    await mergePendingTransactionState(userId, {
      _autoYesAfterEdit: false,
      _autoYesSourceMsgId: null
    });

    const yesSid = `${mid || ''}:auto_yes_after_edit`.slice(0, 64);

    // Re-call the same handler with "yes"
    // signature: (from, text, profile, ownerId, ownerProfile, isOwner, messageSid, req.body)
    const yesArgs = [...handlerArgs];
    yesArgs[1] = 'yes';
    yesArgs[6] = yesSid;

    // ✅ also patch payload body (some logic reads req.body.Body)
    if (yesArgs[7] && typeof yesArgs[7] === 'object') {
      yesArgs[7] = { ...yesArgs[7], Body: 'yes', ButtonPayload: 'yes', ButtonText: 'Yes' };
    }

    const yesResult = await handlerFn(...yesArgs);
    console.info('[AUTO_YES_AFTER_EDIT]', { userId, kind, ok: true, via: 'pending_flag' });
    return yesResult;
  } catch (e) {
    console.warn('[AUTO_YES_AFTER_EDIT] failed (ignored):', e?.message);
    return firstResult;
  }
}

function withTimeout(ms, label = 'timeout') {
  let timer = null;
  let done = false;

  const p = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(label));
    }, ms);
  });

  return {
    promise: p,
    cancel: () => {
      if (timer) clearTimeout(timer);
      done = true;
    }
  };
}

/**
 * Wrap a callback-style middleware (req,res,next) with a hard timeout.
 * If it times out, we fail-open to next() and log.
 */
function middlewareWithDeadline(mw, { ms = 2500, name = 'mw' } = {}) {
  return (req, res, next) => {
    const t0 = Date.now();
    const { promise, cancel } = withTimeout(ms, `${name}_timeout`);

    let finished = false;
    const safeNext = (err) => {
      if (finished) return;
      finished = true;
      cancel();
      return next(err);
    };

    // If the middleware never calls next(), this will fire.
    promise
      .then(() => {}) // never resolves
      .catch((e) => {
        if (finished) return;
        finished = true;

        console.warn(`[WEBHOOK] ${name} fail-open`, {
          phase: res?.locals?.phase || null,
          msInPhase: Date.now() - (res?.locals?.phaseAt || t0),
          ownerId: req.ownerId || null,
          from: req.from || req.fromPhone || null,
          messageSid: req.body?.MessageSid || req.body?.SmsMessageSid || null,
          err: e?.message
        });

        // ✅ Fail-open
        return next();
      });

    try {
      mw(req, res, safeNext);
    } catch (err) {
      console.warn(`[WEBHOOK] ${name} threw (fail-open)`, { err: err?.message });
      return safeNext(); // fail-open
    }
  };
}


// ✅ Twilio delivery status callback (must be BEFORE router.post('*') catch-alls)
router.post('/twilio/status', express.urlencoded({ extended: false }), (req, res) => {
  try {
    console.info('[TWILIO_STATUS]', {
      MessageSid: req.body?.MessageSid || null,
      MessageStatus: req.body?.MessageStatus || null,
      To: req.body?.To || null,
      From: req.body?.From || null,
      ErrorCode: req.body?.ErrorCode || null,
      ErrorMessage: req.body?.ErrorMessage || null
    });
  } catch {}
  return res.status(200).send('ok');
});


/* ---------------- Raw urlencoded parser (Twilio signature expects original body) ---------------- */

router.use((req, _res, next) => {
  if (req.method !== 'POST') return next();

  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const isForm = ct.includes('application/x-www-form-urlencoded');
  if (!isForm) return next();

  if (req.body && Object.keys(req.body).length && typeof req.rawBody === 'string') return next();

  let raw = '';
  req.setEncoding('utf8');

  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 1_000_000) req.destroy();
  });

  req.on('end', () => {
    req.rawBody = raw;
    try {
      req.body = raw ? querystring.parse(raw) : {};
    } catch {
      req.body = {};
    }
    next();
  });

  req.on('error', () => {
    req.rawBody = raw || '';
    req.body = {};
    next();
  });
});




// ---------------- Transport health & echo ----------------
// Put this ABOVE the first router.post('*') so it doesn’t get intercepted.

router.get('/health', (_req, res) => {
  // plain 200 for uptime checks
  return res.status(200).send('OK');
});

// Twilio posts to you; this returns TwiML quickly and proves routing + body parsing
router.post('/echo', (req, res) => {
  try {
    const b = req.body || {};
    const msgSid = b.MessageSid || b.SmsMessageSid || null;
    const from = b.From || null;
    const body = String(resolveInboundTextFromTwilio(b) || '').slice(0, 200);


    // If you already have sendTwiml + ok() helpers, use them.
    // Otherwise simplest safe TwiML:
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>echo: ${body || '—'} (sid ${msgSid || 'none'})</Message></Response>`;
    res.set('Content-Type', 'text/xml');
    return res.status(200).send(twiml);
  } catch {
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
});
/* ---------------- Non-POST guard ---------------- */

router.all('*', (req, res, next) => {
  if (req.method === 'POST') return next();
  return ok(res); // empty TwiML
});

/* ---------------- Identity + canonical URL ---------------- */

router.use((req, _res, next) => {
  // Raw Twilio From (may be "whatsapp:+1...", "+1...", "1...", etc)
 const rawFrom = String(req.body?.From || '').trim();

const e164 = rawFrom ? normalizeE164(rawFrom) : null;

const digitsRaw =
  (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(rawFrom)) ||
  String(rawFrom).replace(/^whatsapp:/i, '').replace(/^\+/, '').replace(/\D/g, '').trim() ||
  '';

const digits = /^\d+$/.test(digitsRaw) ? digitsRaw : null;

req.from = e164;
req.actorKey = digits;



  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const path = req.originalUrl || req.url || '/api/webhook';
  req.twilioUrl = `${proto}://${host}${path}`;

  next();
});



/* ---------------- Phase tracker (debug) ---------------- */

router.use((req, res, next) => {
  if (!res.locals.phase) res.locals.phase = 'start';
  res.locals.phaseAt = Date.now();
  next();
});

/* ---------------- Safety Timer ---------------- */

router.use((req, res, next) => {
  if (res.locals._safety) return next();

  const fromRaw = String(req.body?.From || req.from || '');
  const isWhatsApp = fromRaw.startsWith('whatsapp:') || !!req.body?.WaId;

  const SAFETY_MS = isWhatsApp ? 14000 : 8000;

  // track phase timing
  const startedAt = Date.now();
  const safetyMessageSid = String(req.body?.MessageSid || req.body?.SmsMessageSid || '').trim() || null;

  res.locals._safety = setTimeout(() => {
    if (res.headersSent) return;

    const msInPhase = Date.now() - startedAt;

    console.warn('[WEBHOOK] safety reply', {
      phase: res.locals.phase || 'router',
      msInPhase,
      from: req.from,
      messageSid
    });

    // NEVER return empty — always give user a bubble
    return ok(res, '⚠️ That voice note took too long to process. Please try again, or type it (e.g., "clock in").');
  }, SAFETY_MS);

  const clear = () => {
    try { clearTimeout(res.locals._safety); } catch {}
  };

  res.on('finish', clear);
  res.on('close', clear);

  next();
});



/* ---------------- Inbound debug (TEMP) ---------------- */

const INBOUND_LIST_DEBUG = String(process.env.INBOUND_LIST_DEBUG || '') === '1';

router.post('*', (req, _res, next) => {
  try {
    if (!INBOUND_LIST_DEBUG) return next();

    const b = req.body || {};

    const get = (...keys) => {
      for (const k of keys) {
        if (b[k] != null && String(b[k]).trim() !== '') return b[k];
      }
      return undefined;
    };

    const listRowId = get('ListRowId', 'ListRowID', 'listRowId', 'listRowID');
    const listRowTitle = get('ListRowTitle', 'listRowTitle');
    const listId = get('ListId', 'listId', 'ListItemId', 'listItemId', 'ListReplyId', 'listReplyId');
    const listTitle = get('ListTitle', 'listTitle', 'ListItemTitle', 'listItemTitle', 'ListReplyTitle', 'listReplyTitle');
    const irj = get('InteractiveResponseJson', 'interactiveResponseJson');
    const btnPayload = get('ButtonPayload', 'buttonPayload');
    const btnText = get('ButtonText', 'buttonText');

    const hasListish = !!(irj || listRowId || listRowTitle || listId || listTitle);
    const hasButtonish = !!(btnPayload || btnText);
    if (!hasListish && !hasButtonish) return next();

    let resolvedInbound = '';
    try {
      resolvedInbound = typeof getInboundText === 'function' ? String(getInboundText(b) || '') : '';
    } catch {
      resolvedInbound = '';
    }

    const trunc = (v, n = 400) => {
      const s = String(v ?? '');
      if (s.length <= n) return s;
      return s.slice(0, n) + `…(+${s.length - n} chars)`;
    };

    const present = Object.keys(b)
      .filter((k) => b[k] != null && String(b[k]).trim() !== '')
      .slice(0, 60);

    console.info('[INBOUND_LIST_DEBUG]', {
      MessageSid: b.MessageSid,
      SmsMessageSid: b.SmsMessageSid,
      From: b.From,
      WaId: b.WaId,
      ProfileName: b.ProfileName,
      Body: b.Body,

      ListRowId: listRowId,
      ListRowTitle: listRowTitle,
      ListId: listId,
      ListTitle: listTitle,

      ButtonPayload: btnPayload,
      ButtonText: btnText,
      InteractiveResponseJson: irj ? trunc(irj, 800) : undefined,

      ResolvedInboundText: resolvedInbound,
      KeysPresent: present
    });
  } catch (e) {
    console.warn('[INBOUND_LIST_DEBUG] failed:', e?.message);
  }
  next();
});

/* ---------------- Quick version check ---------------- */

router.post('*', (req, res, next) => {
  const bodyText = String(getInboundText(req.body || {}) || '').toLowerCase();
  if (bodyText === 'version') {
    const v = process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'dev-local';
    return ok(res, `build ${String(v).slice(0, 7)} OK`);
  }
  next();
});

/* ---------------- Lightweight middlewares (tolerant) ---------------- */

router.use((req, res, next) => {
  try {
    const token = require("../middleware/token");
    const prof = require("../middleware/userProfile");
    const lock = require("../middleware/lock");

    res.locals.phase = "token";
    res.locals.phaseAt = Date.now();
    req._phase = "token";

    token.tokenMiddleware(req, res, () => {
      res.locals.phase = "userProfile";
      res.locals.phaseAt = Date.now();
      req._phase = "userProfile";

      middlewareWithDeadline(prof.userProfileMiddleware, { ms: 2500, name: "userProfile" })(
        req,
        res,
        () => {
          // ✅ WHOAMI debug (remove after you confirm gating)
          try {
            console.info("[WHOAMI_CTX]", {
              from: req.from || null,
              actorKey: req.actorKey || null, // may be digits depending on your stack
              waId: req.body?.WaId || req.body?.WaID || null,
              profileName: req.body?.ProfileName || null,
              ownerId: req.ownerId || null,
              isOwner: !!req.isOwner,

              // ✅ the two fields we care about for Crew+Control gating
              actorId: req.actorId || null,
              tenantId: req.tenantId || null,

              role: req.userProfile?.role || req.userProfile?.user_role || null,
              userId: req.userProfile?.user_id || req.userProfile?.id || null,
            });
          } catch {}

          res.locals.phase = "lock";
          res.locals.phaseAt = Date.now();
          req._phase = "lock";

          lock.lockMiddleware(req, res, () => {
            res.locals.phase = "router";
            res.locals.phaseAt = Date.now();
            req._phase = "router";

            next();
          });
        }
      );
    });
  } catch (e) {
    console.warn("[WEBHOOK] light middlewares skipped:", e?.message);
    next();
  }
});

/* ---------------- Pending Action interceptor (confirm/cancel/edit/skip) ---------------- */

try {
  const { pendingActionMiddleware } = require('../middleware/pendingAction');
  router.post('*', pendingActionMiddleware);
} catch (e) {
  console.warn('[WEBHOOK] pendingActionMiddleware unavailable:', e?.message);
}

/* ---------------- Media ingestion (audio/image → handleMedia) ----------------
 * Goals:
 * - Media handler may inject transcript into req.body.Body
 * - Router must use ONE canonical text variable (text2/lc2)
 * - NEVER let Body override stable interactive tokens (jp:/jobpick::/more/overhead/etc.)
 * - Remove legacy `text` and `lc` usage in this section (prevents "text is not defined")
 * -------------------------------------------------------------------------- */

router.post('*', async (req, res, next) => {
  const { n, url, type } = pickFirstMedia(req.body || {});
  if (n <= 0) return next();

  try {
    const { handleMedia } = require('../handlers/media');

    // Use canonical inbound text resolver (interactive-aware)
    const bodyText = String(resolveInboundTextFromTwilio(req.body || {}) || '').trim();
    const sourceMsgId = String(req.body?.MessageSid || req.body?.SmsMessageSid || '').trim() || null;

    const result = await handleMedia(
      req.from,
      bodyText,
      req.userProfile || {},
      req.ownerId,
      url,
      type,
      sourceMsgId
    );

    // ✅ Guarded result checks (prevents edge-case crashes if result is string/null)
    const hasTwiml = !!(result && typeof result === 'object' && result.twiml);
    const hasTranscript = !!(result && typeof result === 'object' && result.transcript);

    console.info('[MEDIA_RETURN]', {
      from: req.from,
      ownerId: req.ownerId || null,
      sourceMsgId: sourceMsgId || null,
      mediaUrl: url ? String(url).slice(0, 140) : null,
      mediaType: type || null,
      hasTwiml,
      hasTranscript,
      transcriptLen: hasTranscript ? String(result.transcript).length : 0
    });

    // ✅ If media handler decided to respond immediately, do it.
    if (hasTwiml && !res.headersSent) {
      const xml = String(result.twiml || '').trim();

      console.info('[MEDIA_SEND_TWIML]', {
        from: req.from,
        ownerId: req.ownerId || null,
        sourceMsgId: sourceMsgId || null,
        twimlLen: xml.length
      });

      res.status(200).type('text/xml').send(xml);
      return;
    }

    // ✅ If media handler produced a transcript, inject it into Body for routing.
    // NOTE: We do NOT touch ResolvedInboundText here; router will reconcile safely later.
    if (hasTranscript) {
      let t = String(result.transcript || '').trim();

      // Fix voice fillers ("uh, expense ...") BEFORE routing
      try { if (typeof stripLeadingFiller === 'function') t = stripLeadingFiller(t); } catch {}

      // Deterministic money normalization BEFORE routing
      try { if (typeof normalizeTranscriptMoney === 'function') t = normalizeTranscriptMoney(t); } catch {}

      req.body = req.body || {};
      req.body.Body = t;

      console.info('[WEBHOOK_MEDIA_TO_ROUTER_HEAD]', { head: String(t || '').slice(0, 40) });
      console.info('[MEDIA_ROUTING_BODY]', {
        bodyHead: String(req.body?.Body || '').slice(0, 60),
        len: String(req.body?.Body || '').length
      });

      return next();
    }

    // Legacy pattern: handler might return raw TwiML string
    if (typeof result === 'string' && result && !res.headersSent) {
      return sendTwiml(res, result);
    }

    return next();
  } catch (e) {
    console.error('[MEDIA] error:', e?.message);
    if (!res.headersSent) return ok(res, null); // empty TwiML
  }
});

/* ---------------- Main router ---------------- */

router.post('*', async (req, res, next) => {
  try {
    if (req.dbDegraded) {
      return ok(
        res,
        `ChiefOS is having trouble reaching the database right now...\n\nPlease try again in 1–2 minutes.\n\nIf this keeps happening, reply SUPPORT.`
      );
    }

    const crypto = require('crypto');
    const numMedia = parseInt(req.body?.NumMedia || '0', 10) || 0;

    // ✅ Canonical inbound text (single source of truth) — interactive-aware
    let text2 = String(resolveInboundTextFromTwilio(req.body || {}) || '').trim();
    req.body.ResolvedInboundText = text2;
    let lc2 = text2.toLowerCase();

  


   /* -----------------------------------------------------------------------
 * ✅ Canonical post-media refresh (EARLY)
 * - Runs immediately after resolveInboundTextFromTwilio()
 * - Preserves stable interactive picker tokens (so Body cannot overwrite them)
 * - IMPORTANT: media handler later may write req.body.Body (transcript)
 * ----------------------------------------------------------------------- */
{
  const resolved0 = String(req.body?.ResolvedInboundText || "").trim();
  const body0 = String(req.body?.Body || "").trim();

  // Treat picker tokens as stable (do not overwrite with Body)
  const isStablePickerToken =
    /^jp:/i.test(resolved0) ||
    /^jobix_\d+/i.test(resolved0) ||
    /^jobno_\d+/i.test(resolved0) ||
    /^jobpick::/i.test(resolved0) ||
    /^(more|overhead|oh)$/i.test(resolved0);

  text2 = isStablePickerToken ? resolved0 : (body0 || resolved0 || text2 || "").trim();
  lc2 = text2.toLowerCase();

  console.info("[ROUTER_TEXT_REFRESH_EARLY]", { lcN: lc2.slice(0, 50) });
  if (isStablePickerToken) {
    console.info("[ROUTER_PICKER_TOKEN_PRESERVED_EARLY]", { token: resolved0.slice(0, 80) });
  }
}

// ✅ Compute Twilio MessageSid ONCE (preferred stable id)
const twilioSid = String(req.body?.MessageSid || req.body?.SmsMessageSid || "").trim() || null;

// ✅ Optional fallback stable id (used elsewhere in your router if needed)
// NOTE: we do NOT use this for Crew idempotency because it can collide on repeated identical messages.
const rawSid = twilioSid || "";
const messageSid =
  rawSid ||
  crypto
    .createHash("sha256")
    .update(`${req.from || ""}|${text2}`)
    .digest("hex")
    .slice(0, 32);

// (D) CREW+CONTROL FAST PATH (task/time → activity logs)
// - requires actor identity + tenant mapping
// - captures crew-auditable log stream
// - IMPORTANT: enforce Pro for employee/board self-logging (fail-closed)
try {
  const crewEnabled = String(process.env.FEATURE_CREW_CONTROL || "0") === "1";
  if (crewEnabled) {
    const hasTenant = !!req.tenantId;
    const hasActor = !!req.actorId;

    // Fail closed unless actor identity system is active
    if (hasTenant && hasActor) {
      const rawText = String(text2 || "").trim();

      const isTaskCmd =
        /^task\b/i.test(String(lc2 || "")) ||
        /^\s*task\s*-\s*/i.test(rawText) ||
        /^\s*task-\s*/i.test(rawText);

      const isTimeCmd =
        /^time\b/i.test(String(lc2 || "")) ||
        /^clock\s*(in|out)\b/i.test(rawText);

      if (isTaskCmd || isTimeCmd) {
        // ✅ Only use idempotency when we have a real Twilio SID.
        // If twilioSid is missing, we still capture, but with sourceMsgId=null (no dedupe).
        const sourceMsgId = twilioSid ? String(twilioSid) : null;

        // Lazy-load so crew module issues never crash the whole webhook
        const mod = require("../services/crewControl");
        const createCrewActivityLog =
          typeof mod?.createCrewActivityLog === "function" ? mod.createCrewActivityLog : null;

        if (!createCrewActivityLog) {
          console.warn("[CREW_CONTROL] createCrewActivityLog missing (skipping crew capture)");
          // fall through to legacy routing
        } else {
          // ✅ clean stored/displayed content (strip command prefix for tasks)
          let contentText = rawText;
          if (isTaskCmd) {
            contentText = contentText
              .replace(/^\s*task\s*-\s*/i, "")
              .replace(/^\s*task-\s*/i, "")
              .replace(/^\s*task\s+/i, "")
              .trim();
          }

          if (!contentText) {
            // fall through to legacy routing
          } else {
            const type = isTaskCmd ? "task" : "time";

            // ------------------------------------------------------------------
            // ✅ PRO GATE (fail-closed) for employee/board self-logging via WhatsApp
            // Owner/admin can always capture (core capture). Employee/board requires Pro.
            // Plan authority: users.plan_key by owner_id (or equivalent).
            // If plan lookup fails -> treat as Free.
            // ------------------------------------------------------------------
            const gate = await pg.withClient(async (client) => {
              // role of this actor inside tenant
              const rr = await client.query(
                `
                select role
                  from public.chiefos_tenant_actors
                 where tenant_id = $1
                   and actor_id = $2
                 limit 1
                `,
                [req.tenantId, req.actorId]
              );
              const actorRole = String(rr?.rows?.[0]?.role || "").trim();

              // Owners/admins allowed regardless of plan (core capture)
              const isOwnerOrAdmin = actorRole === "owner" || actorRole === "admin";
              const isEmployeeOrBoard = actorRole === "employee" || actorRole === "board";

              // If role is missing/unknown, fail closed for crew capture (do not create crew log)
              if (!actorRole) {
                return { ok: false, reason: "ROLE_UNKNOWN", actorRole: null, planKey: "free" };
              }

              // Only employee/board are Pro-gated on WhatsApp self-log
              if (!isEmployeeOrBoard) {
                return { ok: true, reason: "ROLE_ALLOWED", actorRole, planKey: "n/a" };
              }

              // Resolve plan_key (fail-closed)
              let planKey = "free";

              // Detect which table exists for plan authority
              const reg = await client.query(
                `
                select
                  to_regclass('public.users') as t_users,
                  to_regclass('public.chiefos_users') as t_chiefos_users
                `
              );

              const tUsers = reg?.rows?.[0]?.t_users || null;
              const tChiefosUsers = reg?.rows?.[0]?.t_chiefos_users || null;

              try {
                if (tUsers) {
                  const p = await client.query(
                    `select plan_key from public.users where owner_id = $1 limit 1`,
                    [req.ownerId]
                  );
                  planKey = String(p?.rows?.[0]?.plan_key || "free").trim().toLowerCase();
                } else if (tChiefosUsers) {
                  const p = await client.query(
                    `select plan_key from public.chiefos_users where owner_id = $1 limit 1`,
                    [req.ownerId]
                  );
                  planKey = String(p?.rows?.[0]?.plan_key || "free").trim().toLowerCase();
                } else {
                  // Unknown schema -> fail closed
                  planKey = "free";
                }
              } catch (e) {
                // Any plan lookup error -> fail closed
                planKey = "free";
              }

              const isStarterOrPro = planKey === "starter" || planKey === "pro";
if (!isStarterOrPro) {
  return { ok: false, reason: "NOT_INCLUDED", actorRole, planKey };
}
return { ok: true, reason: "STARTER_OK", actorRole, planKey };
            });

            if (!gate.ok) {
              // IMPORTANT: do not create Crew activity log if not allowed.
              // Calm upsell message for employee/board self-log; avoid spamming.
              if (gate.reason === "NOT_INCLUDED") {
                return ok(
                  res,
                  [
                    "🔒 Crew logging requires Starter or Pro (Crew+Control).",
                    "Ask the owner to upgrade in the portal, then try again.",
                  ].join("\n")
                );
              }

              // ROLE_UNKNOWN or other -> silently fall through to legacy routing
            } else {
              const structured = {
                raw: rawText,
                normalized: contentText,
                detected: { isTaskCmd, isTimeCmd },
                gate: {
                  actor_role: gate.actorRole,
                  plan_key: gate.planKey,
                  reason: gate.reason,
                },
                meta: {
                  twilio_message_sid: twilioSid,
                  used_idempotency: !!sourceMsgId,
                },
              };

              console.info("[CREW_CONTROL] capturing", {
                tenantId: req.tenantId,
                ownerId: req.ownerId,
                actorId: req.actorId,
                twilioSid,
                usedIdempotency: !!sourceMsgId,
                type,
                text: contentText.slice(0, 80),
                actorRole: gate.actorRole,
                planKey: gate.planKey,
              });

              const out = await createCrewActivityLog({
                tenantId: req.tenantId,
                ownerId: req.ownerId,
                createdByActorId: req.actorId,
                type,
                source: "whatsapp",
                contentText,
                structured,
                status: "submitted",
                sourceMsgId, // ✅ null if no real Twilio SID (avoid hash collisions)
              });

              // Legacy-style reply:
              const n = out?.logNo ? `#${out.logNo}` : out?.logId ? `#${out.logId}` : "";
              const replyText =
                type === "task"
                  ? `✅ Task ${n} created: ${contentText}`
                  : `✅ Time log ${n} created: ${contentText}`;

              return ok(res, replyText.replace(/\s+/g, " ").trim());
            }
          }
        }
      }
    }
  }
} catch (e) {
  console.warn("[CREW_CONTROL] capture failed (ignored):", e?.message || e);
  // IMPORTANT: ignore and continue normal routing
}

    // ✅ Hard time command classification (uses lc2)
    let isHardTimeCommand = looksHardTimeCommand(lc2);
    console.info('[ROUTER_HARD_TIME]', { lcN: lc2.slice(0, 50), isHardTimeCommand });

         // ✅ HARD JOB COMMANDS helper (must be defined before router-level hard job routing uses it)
    // Includes both "list jobs" and common singular typo "list job"
    function isHardJobCommand(lc) {
      const s = String(lc || '').trim().toLowerCase();

      return (
        // list
        /^(jobs|job|list\s+jobs|list\s+job|show\s+jobs|show\s+job|job\s+list|show\s+job\s+list)\b/.test(s) ||

        // create
        /^(create|new|start)\s+job\b/.test(s) ||

        // active job set
        /^(active\s+job|set\s+active|switch\s+job)\b/.test(s) ||

        // picker open
        /^(change\s+job|pick\s+job|show\s+active\s+jobs|active\s+jobs)\b/.test(s) ||

        // delete/archive
        /^(delete|remove|archive)\s+job\b/.test(s)
      );
    }


    // ✅ If there's no text and no media, do nothing
    if (!text2 && numMedia === 0) return ok(res);

    // ✅ "link" keyword (WhatsApp 24h-window opener for portal OTP) — exact match only
    const lc2Clean = lc2.trim().replace(/[.!?]+$/g, '');
    if (lc2Clean === 'link') {
      return ok(
        res,
        [
          '✅ Got it — WhatsApp confirmed.',
          '',
          'Now go back to the portal:',
          '1) Check the box',
          '2) Enter your phone number',
          '3) Request your 6-digit code',
          '',
          'Paste the code here, then click Verify in ChiefOS.',
          '',
          'Code expires in 10 minutes.'
        ].join('\n')
      );
    }
    
  // ✅ commands/help keyword intercept (pure informational; no CIL; no DB; no side effects)
// Must occur before any DB work (debug helpers), onboarding intercept, pending-action routing, or orchestrator.
if (lc2Clean === "commands" || lc2Clean === "help") {
  return ok(res, buildCommandsMessage());
}

if (/^\s*(what('?s)?\s+my\s+)?owner\s*id\b|where do i get my owner id\??/i.test(text2)) {
  return ok(res, `You don’t need that. I already know your owner ID from your WhatsApp number. Just ask your question (e.g., “profit this month” or “profit on job 1556”).`);
}
// -----------------------------------------------------------------------
// ✅ HOW-TO / HELP INTERCEPT (must run EARLY)
// - Prevents "How do I log an expense?" from triggering intake handlers
// - Routes to Chief/agent guidance (or SOP) instead
// -----------------------------------------------------------------------
{
  const raw = String(text2 || "").trim();
  const s = raw.toLowerCase();

  const howStem =
    /\b(how (do|to) i|how to|help me|help with|what do i say|what should i say|how can i)\b/i.test(raw);

  const mentionsLog =
    /\b(log|add|record|enter|track|submit)\b/i.test(raw);

  const mentionsDomain =
    /\b(expense|exp|revenue|rev|income|sale|task|time|clock|timesheet|job|jobs)\b/i.test(raw);

  const looksHowTo = (howStem || /\?\s*$/.test(raw)) && (mentionsLog || howStem) && mentionsDomain;

  if (looksHowTo) {
    try {
      // Prefer agent for natural help
      const { answerChief } = require("../services/answerChief");

      const out = await answerChief({
        ownerId: req.ownerId,
        actorKey: req.actorKey || req.from,
        text: raw,
        tz: req.tz || req.userProfile?.tz || "America/Toronto",
        channel: "whatsapp",
        req,
        agent: req.app?.locals?.agent || null,
        context: {
          from: req.from,
          ownerProfile: req.ownerProfile,
          userProfile: req.userProfile,
          isOwner: req.isOwner,
          messageSid,
          reqBody: req.body,
          topicHints: ["help"]
        }
      });

      const msg = String(out?.answer || "").trim();
      if (msg) return ok(res, msg);
    } catch (e) {
      console.warn("[HOWTO] answerChief failed (fallback):", e?.message);
    }

    // Fallback if agent is down
    return ok(
      res,
      [
        "To log an expense, just text something like:",
        "",
        "• expense $52 Home Depot lumber today",
        "",
        "That’s it."
      ].join("\n")
    );
  }
}

    // ✅ Owner-only: onboarding status (debug helper)
// Keyword: chiefonboarding status
if (/^chiefonboarding\s+status\b/i.test(lc2Clean)) {
  if (!req.isOwner) {
    return ok(
      res,
      [
        "❌ Only the business owner can run this.",
        "",
        "If you need access, ask the owner to link your phone in the portal."
      ].join("\n")
    );
  }

  try {
    const ownerId = String(req.ownerId || "").trim();
    if (!ownerId) return ok(res, "Missing owner context. Try again.");

    const { rows } = await pg.query(
      `
      select key, value, updated_at
      from public.settings
      where owner_id = $1
        and key like 'onboarding.%'
      order by key
      `,
      [ownerId]
    );

    if (!rows || rows.length === 0) {
      return ok(
        res,
        [
          `📊 Onboarding Status`,
          ``,
          `Owner: ${ownerId}`,
          `Stage: (none set — defaults to "new")`
        ].join("\n")
      );
    }

    const stageRow = rows.find(r => r.key === "onboarding.stage");
    const stage = stageRow?.value || "unknown";
    const updated = stageRow?.updated_at
      ? new Date(stageRow.updated_at).toISOString()
      : "unknown";

    return ok(
      res,
      [
        `📊 Onboarding Status`,
        ``,
        `Owner: ${ownerId}`,
        `Stage: ${stage}`,
        `Last Updated: ${updated}`,
        ``,
        `All onboarding keys:`,
        ...rows.map(r =>
          `• ${r.key} = ${r.value} (${new Date(r.updated_at).toISOString()})`
        )
      ].join("\n")
    );
  } catch (e) {
    console.warn("[ONBOARDING_STATUS] failed:", e?.message);
    return ok(res, `⚠️ Could not fetch onboarding status. ${e?.message || ""}`.trim());
  }
}

// ✅ Owner-only: tenant debug
// Keyword: chiefdebug tenant
if (/^chiefdebug\s+tenant\b/i.test(lc2Clean)) {
  if (!req.isOwner) {
    return ok(
      res,
      [
        "❌ Only the business owner can run this.",
        "",
        "Ask the owner to link your phone in the portal."
      ].join("\n")
    );
  }

  try {
    const ownerId = String(req.ownerId || "").trim();
    if (!ownerId) return ok(res, "Missing owner context. Try again.");

    const { rows } = await pg.query(
      `
      select
        id,
        owner_id,
        business_name,
        country,
        province,
        tz,
        currency,
        tax_code,
        plan_key,
        plan_status,
        stripe_customer_id,
        stripe_subscription_id,
        current_period_end,
        created_at,
        updated_at
      from public.chiefos_tenants
      where owner_id::text = $1
      limit 1
      `,
      [ownerId]
    );

    const t = rows?.[0] || null;
    if (!t) {
      return ok(
        res,
        [
          "🏢 Tenant Debug",
          "",
          `Owner: ${ownerId}`,
          "Result: ❌ No tenant row found in public.chiefos_tenants",
          "",
          "This usually means owner→tenant mapping is missing or wrong."
        ].join("\n")
      );
    }

    const fmt = (v) => (v === null || v === undefined || v === "" ? "(null)" : String(v));

    return ok(
      res,
      [
        "🏢 Tenant Debug",
        "",
        `tenant_id: ${fmt(t.id)}`,
        `owner_id: ${fmt(t.owner_id)}`,
        `business_name: ${fmt(t.business_name)}`,
        "",
        `locale: ${fmt(t.country)} ${fmt(t.province)}  tz=${fmt(t.tz)}  currency=${fmt(t.currency)}  tax=${fmt(t.tax_code)}`,
        "",
        `plan_key: ${fmt(t.plan_key)}`,
        `plan_status: ${fmt(t.plan_status)}`,
        `stripe_customer_id: ${fmt(t.stripe_customer_id)}`,
        `stripe_subscription_id: ${fmt(t.stripe_subscription_id)}`,
        `current_period_end: ${fmt(t.current_period_end)}`,
        "",
        `updated_at: ${fmt(t.updated_at)}`,
        `created_at: ${fmt(t.created_at)}`
      ].join("\n")
    );
  } catch (e) {
    console.warn("[CHIEFDEBUG_TENANT] failed:", e?.message);
    return ok(res, `⚠️ chiefdebug tenant failed. ${e?.message || ""}`.trim());
  }
}
// ✅ Owner-only: effective plan debug
// Keyword: chiefdebug plan
if (/^chiefdebug\s+plan\b/i.test(lc2Clean)) {
  if (!req.isOwner) {
    return ok(
      res,
      [
        "❌ Only the business owner can run this.",
        "",
        "Ask the owner to link your phone in the portal."
      ].join("\n")
    );
  }

  try {
    const ownerId = String(req.ownerId || "").trim();
    if (!ownerId) return ok(res, "Missing owner context. Try again.");

    // 1) Try your canonical plan resolver if present (preferred)
    let eff = null;
    try {
      const planSvc =
        require("../services/effectivePlan") ||
        require("../services/effective_plan") ||
        null;

      if (planSvc?.getEffectivePlanForOwner) {
        eff = await planSvc.getEffectivePlanForOwner(ownerId);
      }
    } catch {}

    // 2) Fallback: read tenant plan fields directly (still valuable)
    let tenant = null;
    try {
      const { rows } = await pg.query(
        `
        select id, plan_key, plan_status, stripe_subscription_id, current_period_end, updated_at
        from public.chiefos_tenants
        where owner_id::text = $1
        limit 1
        `,
        [ownerId]
      );
      tenant = rows?.[0] || null;
    } catch {}

    const fmt = (v) => (v === null || v === undefined || v === "" ? "(null)" : String(v));

    const planKeyRaw = eff?.plan_key ?? tenant?.plan_key ?? "free";
    const planKeyNorm = String(planKeyRaw || "free").trim().toLowerCase();
    const planStatus = eff?.plan_status ?? tenant?.plan_status ?? "(unknown)";
    const source = eff?.source ?? (tenant ? "chiefos_tenants.plan_key" : "fallback_free");
    const tenantId = eff?.tenant_id ?? tenant?.id ?? null;

    return ok(
      res,
      [
        "🧾 Plan Debug",
        "",
        `owner_id: ${ownerId}`,
        `tenant_id: ${fmt(tenantId)}`,
        "",
        `plan_key_raw: ${fmt(planKeyRaw)}`,
        `plan_key_norm: ${planKeyNorm}`,
        `plan_status: ${fmt(planStatus)}`,
        `source: ${fmt(source)}`,
        "",
        `stripe_subscription_id: ${fmt(tenant?.stripe_subscription_id)}`,
        `current_period_end: ${fmt(tenant?.current_period_end)}`,
        `tenant_updated_at: ${fmt(tenant?.updated_at)}`
      ].join("\n")
    );
  } catch (e) {
    console.warn("[CHIEFDEBUG_PLAN] failed:", e?.message);
    return ok(res, `⚠️ chiefdebug plan failed. ${e?.message || ""}`.trim());
  }
}
// ✅ Owner-only: capability/caps debug (jobs)
// Keyword: chiefdebug caps
if (/^chiefdebug\s+caps\b/i.test(lc2Clean)) {
  if (!req.isOwner) {
    return ok(
      res,
      [
        "❌ Only the business owner can run this.",
        "",
        "Ask the owner to link your phone in the portal."
      ].join("\n")
    );
  }

  try {
    const ownerId = String(req.ownerId || "").trim();
    if (!ownerId) return ok(res, "Missing owner context. Try again.");

    // Resolve plan (best effort)
    let planKeyRaw = null;
    let planSource = null;

    try {
      const planSvc =
        require("../services/effectivePlan") ||
        require("../services/effective_plan") ||
        null;

      if (planSvc?.getEffectivePlanForOwner) {
        const eff = await planSvc.getEffectivePlanForOwner(ownerId);
        planKeyRaw = eff?.plan_key || null;
        planSource = eff?.source || "effectivePlan";
      }
    } catch {}

    if (!planKeyRaw) {
      // fallback to tenant row
      const { rows } = await pg.query(
        `select plan_key from public.chiefos_tenants where owner_id::text = $1 limit 1`,
        [ownerId]
      );
      planKeyRaw = rows?.[0]?.plan_key || "free";
      planSource = "chiefos_tenants.plan_key";
    }

    const planKeyNorm = String(planKeyRaw || "free").trim().toLowerCase();

    // Load capability map
    let capsMap = null;
    try {
      capsMap = require("../services/plan_capabilities");
    } catch (e) {
      // some repos keep it elsewhere
      try {
        capsMap = require("../services/planCapabilities");
      } catch {}
    }

    if (!capsMap) {
      return ok(
        res,
        [
          "🧠 Caps Debug",
          "",
          "❌ Could not load plan capabilities map.",
          "Expected one of:",
          "• services/plan_capabilities",
          "• services/planCapabilities"
        ].join("\n")
      );
    }

    const caps = capsMap[planKeyNorm] || capsMap.free;
    const maxJobs = caps?.max_jobs;
    const isUnlimited = maxJobs == null || maxJobs === Infinity;

    // Count jobs
    const { rows: jr } = await pg.query(
      `select count(*)::int as n from public.jobs where owner_id = $1`,
      [ownerId]
    );
    const jobCount = jr?.[0]?.n ?? 0;

    const wouldDeny = !isUnlimited && jobCount >= Number(maxJobs);

    const fmt = (v) => (v === null || v === undefined || v === "" ? "(null)" : String(v));

    return ok(
      res,
      [
        "🧠 Caps Debug (Jobs)",
        "",
        `owner_id: ${ownerId}`,
        "",
        `plan_key_raw: ${fmt(planKeyRaw)}`,
        `plan_key_norm: ${planKeyNorm}`,
        `plan_source: ${fmt(planSource)}`,
        "",
        `job_count: ${jobCount}`,
        `max_jobs: ${fmt(maxJobs)}`,
        `unlimited: ${isUnlimited ? "true" : "false"}`,
        `would_deny_now: ${wouldDeny ? "true" : "false"}`
      ].join("\n")
    );
  } catch (e) {
    console.warn("[CHIEFDEBUG_CAPS] failed:", e?.message);
    return ok(res, `⚠️ chiefdebug caps failed. ${e?.message || ""}`.trim());
  }
}

     // ✅ Owner-only: reset onboarding state for repeat testing
// Keyword: chiefonboarding
if (/^chiefonboarding\b/i.test(lc2Clean)) {
  if (!req.isOwner) {
    return ok(
      res,
      [
        "❌ Only the business owner can run this.",
        "",
        "If you need access, ask the owner to link your phone in the portal."
      ].join("\n")
    );
  }

  try {
    const ownerId = String(req.ownerId || "").trim();
    if (!ownerId) return ok(res, "Missing owner context. Try again.");

    // Requires pg in scope:
    // const pg = require('../services/postgres');
    await pg.query(
      `delete from public.settings where owner_id = $1 and key like 'onboarding.%'`,
      [ownerId]
    );

    const portal = String(
      process.env.PORTAL_BASE_URL ||
        process.env.APP_BASE_URL ||
        "https://www.usechiefos.com/app"
    )
      .trim()
      .replace(/\/$/, "");

    return ok(
      res,
      [
        `✅ Onboarding reset for owner ${ownerId}.`,
        "",
        `Now text: Hi`,
        `and you’ll see onboarding again.`,
        "",
        `Portal: ${portal}`
      ].join("\n")
    );
  } catch (e) {
    console.warn("[ONBOARDING_RESET] failed:", e?.message);
    return ok(res, `⚠️ Could not reset onboarding. ${e?.message || ""}`.trim());
  }
}


    // -----------------------------------------------------------------------
    // ✅ LINK CODE REDEEM (must run EARLY, and MUST work even when unlinked)
    // Accepts: "LINK 123456" OR "123456"
    // -----------------------------------------------------------------------
    {
      const linkCode = parseLinkCommand(text2);
      if (linkCode) {
        try {
          const phone = String(req.from || '').trim(); // +E164
          if (!phone) return ok(res, 'Missing sender phone. Try again.');

          const out = await redeemLinkCodeToTenant({ code: linkCode, fromPhone: phone });

          if (!out?.ok) {
            return ok(
              res,
              `❌ Link failed: ${out?.error || 'Unknown error'}\n\nGo back to the portal, generate a fresh code, then text the 6 digits.`
            );
          }

          // After redeem, your middleware may not have req.ownerId yet on THIS request.
          // Clear pending using the actor key only (safe).
          try {
            await clearAllPendingForUser({ ownerId: null, from: (req.actorKey || req.from) });
          } catch {}

          return ok(
            res,
            `✅ WhatsApp linked.\n\nNow you can try:\n• expense $18 Home Depot\n• revenue $500 deposit`
          );
        } catch (e) {
          console.warn('[LINK] redeem failed:', e?.message);
          return ok(res, '⚠️ Link failed. Please request a new code in the portal and try again.');
        }
      }
    }

// -----------------------------------------------------------------------
// ✅ MULTI-TENANT SELECTION GATE (FAIL CLOSED)
// - If user has access to multiple tenants and has no active tenant selected,
//   we show a numbered menu and STOP.
// - User sets active tenant with: "use 1" (or "use 2", etc.)
// -----------------------------------------------------------------------
if (!req.tenantId && req.multiTenant && Array.isArray(req.multiTenantChoices) && req.multiTenantChoices.length) {
  const raw = String(text2 || "").trim();
  const lc = raw.toLowerCase();

  // "use" command: use <n>
  const m = lc.match(/^use\s+(\d+)\s*$/i);
  if (m) {
    const idx = parseInt(m[1], 10);
    const choice = req.multiTenantChoices[idx - 1];

    if (!choice?.tenant_id) {
      return ok(res, `❌ Invalid choice. Reply "use 1" (or another number) from the list.`);
    }

    const phone = String(req.actorKey || req.from || "").replace(/\D/g, "");
    try {
      await query(
  `
  insert into public.chiefos_phone_active_tenant (phone_digits, tenant_id, updated_at)
  values ($1, $2, now())
  on conflict (phone_digits) do update
    set tenant_id = excluded.tenant_id,
        updated_at = now()
  `,
  [phone, choice.tenant_id]
);
    } catch (e) {
      console.warn("[MULTI_TENANT] failed to set active tenant:", e?.message);
      return ok(res, `⚠️ Could not set active business. Please try again.`);
    }

    const label = choice.tenant_name ? ` (${choice.tenant_name})` : "";
    return ok(res, `✅ Active business set${label}. Now send your log again.`);
  }

  // Show menu (tenant names if available)
  const lines = [
    "You have access to more than one business.",
    "Reply with: use 1 (or use 2, etc.)",
    "",
    ...req.multiTenantChoices.map((c, i) => {
      const name = c.tenant_name ? ` — ${c.tenant_name}` : "";
      return ` ${i + 1}) ${c.tenant_id}${name}`;
    }),
    "",
    "Tip: once set, we’ll keep using that business until you switch.",
  ];

  return ok(res, lines.join("\n"));
}


    // ✅ Now that redeem had a chance, enforce tenant link
if (!req.ownerId) {
  const portal =
    String(process.env.PORTAL_BASE_URL || process.env.APP_BASE_URL || "https://www.usechiefos.com/app")
      .trim()
      .replace(/\/$/, "");

  return ok(
    res,
    [
      `You’re not linked to a ChiefOS business yet.`,
      ``,
      `Open the portal to link your phone:`,
      portal,
      ``,
      `Then generate a link code and text the 6 digits here.`,
    ].join("\n")
  );
}

    console.info('[WEBHOOK_IN]', {
      ownerId: req.ownerId || null,
      from: req.from || null,
      messageSid: req.body?.MessageSid || req.body?.SmsMessageSid || null,
      waId: req.body?.WaId || req.body?.WaID || req.body?.waid || null,
      numMedia,
      resolvedInbound: String(text2 || '').slice(0, 140),
      ListId: req.body?.ListId || null,
      ListRowId: req.body?.ListRowId || null,
      ButtonPayload: req.body?.ButtonPayload || null
    });
/* -----------------------------------------------------------------------
 * ✅ ONBOARDING INTERCEPT (fast magic moment)
 * - Owner-only
 * - Runs only when onboarding.stage != done (inside handler)
 * - Never blocks real usage once they start (handler returns handled:false)
 * ----------------------------------------------------------------------- */
try {
  // ✅ Owner-only: never onboard employees/board members
  if (!!req.isOwner && req.ownerId) {
    // Load lazily so a missing file can't crash the whole router
    const obMod = require("../handlers/commands/onboarding");
    const handleOnboardingInbound =
      obMod?.handleOnboardingInbound ||
      obMod?.default ||
      null;

    if (typeof handleOnboardingInbound === "function") {
      const tzSafe =
        String(
          req?.tz ||
            req?.userProfile?.tz ||
            req?.userProfile?.timezone ||
            req?.ownerProfile?.tz ||
            req?.ownerProfile?.timezone ||
            ""
        ).trim() || "America/Toronto";

      const ob = await handleOnboardingInbound({
  ownerId: String(req.ownerId),
  fromPhone: req.from,
  text2,
  tz: tzSafe,

  // ✅ legacy identity key (digits) used by existing jobs/tasks system
  actorKey: String(req.actorKey || req.from || "").replace(/\D/g, "") || null,

  // ✅ canonical actor uuid (used by Crew+Control + future alignment)
  actorId: req.actorId || null,

  userProfile: req.userProfile || null,
});

      if (ob?.handled && String(ob?.replyText || "").trim()) {
        return ok(res, String(ob.replyText).trim());
      }
    } else {
      // If it isn't a function, log once (helps catch export/import mismatches)
      console.warn("[ONBOARDING] handler missing or not a function");
    }
  }
} catch (e) {
  console.warn("[ONBOARDING] failed (ignored):", e?.message);
}
    // -----------------------------------------------------------------------
    // "resume" => re-send the pending confirm card if we have a confirm pending-action
    // MUST run early (before nudge / PA router / job picker / fast paths / agent)
    // -----------------------------------------------------------------------
    if (lc2 === 'resume' || lc2 === 'show' || lc2 === 'show pending') {
      try {
        // ✅ Dual-key newest-wins PA lookup (rawFrom vs digits)
        const rawFrom = String(req.from || '').trim();
        const fromDigits = String(req.actorKey || '').trim() || rawFrom.replace(/\D/g, '');

        const pickNewest = (a, b) => {
          if (!a) return b || null;
          if (!b) return a || null;
          const ta = new Date(a.created_at || 0).getTime();
          const tb = new Date(b.created_at || 0).getTime();
          return tb >= ta ? b : a;
        };

        let resolvedResumePA = null;

        if (typeof pg.getMostRecentPendingActionForUser === 'function') {
          const [paRaw, paDigits] = await Promise.all([
            pg.getMostRecentPendingActionForUser({ ownerId: req.ownerId, userId: rawFrom }).catch(() => null),
            fromDigits && fromDigits !== rawFrom
              ? pg.getMostRecentPendingActionForUser({ ownerId: req.ownerId, userId: fromDigits }).catch(() => null)
              : Promise.resolve(null)
          ]);

          resolvedResumePA = pickNewest(paRaw, paDigits);
        }

        const kind = String(resolvedResumePA?.kind || '').trim();

        console.info('[RESUME_PA]', {
          ownerId: req.ownerId || null,
          rawFrom: rawFrom || null,
          fromDigits: fromDigits || null,
          kind: kind || null,
          paId: resolvedResumePA?.id ?? null,
          created_at: resolvedResumePA?.created_at ?? null
        });

        if (kind === 'confirm_expense' || kind === 'pick_job_for_expense') {
          const { handleExpense } = require('../handlers/commands/expense');

          const result = await handleExpense(
            req.from,
            'resume',
            req.userProfile,
            req.ownerId,
            req.ownerProfile,
            req.isOwner,
            messageSid,
            req.body
          );

          if (!res.headersSent) {
            const tw = typeof result === 'string' ? result : (result?.twiml || null);
            return sendTwiml(res, tw);
          }
          return;
        }

        if (kind === 'confirm_revenue' || kind === 'pick_job_for_revenue') {
          const { handleRevenue } = require('../handlers/commands/revenue');

          console.info('[META_PASS_THROUGH]', {
            ListId: req.body?.ListId,
            ListTitle: req.body?.ListTitle,
            Body: req.body?.Body
          });

          const result = await handleRevenue(
            req.from,
            'resume',
            req.userProfile,
            req.ownerId,
            req.ownerProfile,
            req.isOwner,
            messageSid,
            req.body
          );

          if (!res.headersSent) {
            const tw = typeof result === 'string' ? result : (result?.twiml || null);
            return sendTwiml(res, tw);
          }
          return;
        }
      } catch (e) {
        console.warn('[WEBHOOK] resume pending failed (ignored):', e?.message);
      }

      return ok(res, `I couldn’t find anything pending. What do you want to do next?`);
    }
/* -----------------------------------------------------------------------
 * ✅ GLOBAL HARD CANCEL (router-level)
 * - Runs BEFORE nudge / PA fetch / time gates / RAG
 * - Clears pending actions/state
 * - Cancels pending CIL drafts (expense + revenue)
 * ----------------------------------------------------------------------- */
{
  const lcCancel = String(lc2 || '').trim(); // ✅ canonical lc2
  const isGlobalCancel = /^(cancel|stop)\b/.test(lcCancel);

  if (isGlobalCancel) {
    console.info('[GLOBAL_CANCEL_HIT]', {
      ownerId: req.ownerId || null,
      from: req.from || null,
      actorKey: req.actorKey || null,
      messageSid: req.body?.MessageSid || req.body?.SmsMessageSid || null,
      lc: lcCancel
    });

    // 1) Clear all pending actions/state (best-effort)
    try {
      await clearAllPendingForUser({
        ownerId: req.ownerId,
        from: (req.actorKey || req.from)
      });
    } catch {}

    // 2) Cancel ALL draft rows for this actor (best-effort)
    try {
      const actorDigits =
        String(req.actorKey || '').trim() ||
        String(req.from || '').replace(/\D/g, '').trim();

      const kinds = ['expense', 'revenue'];
      const results = [];

      for (const kind of kinds) {
        const r = await pg.cancelAllCilDraftsForActor({
          owner_id: req.ownerId,
          actor_phone: actorDigits,
          kind,
          status: 'cancelled'
        });

        results.push({
          kind,
          cancelled: r?.cancelled ?? null,
          cancelled_ids: (r?.rows || []).slice(0, 10).map((x) => x.id)
        });
      }

      console.info('[GLOBAL_CANCEL_CIL_ALL]', {
        ownerId: req.ownerId,
        actorDigits,
        results
      });
    } catch (e) {
      console.warn('[GLOBAL_CANCEL_CIL_ALL] failed (ignored):', e?.message);
    }

    return ok(res, '❌ Cancelled. You’re cleared.');
  }
}

  // ------------------------------------------------------------
// ✅ Owner nudge (Phase 1) — only on owner messages, skip time commands
// ------------------------------------------------------------
try {
  if (req.isOwner && !isHardTimeCommand && req.ownerId && req.from) {
    const { maybeNudgeOwnerForProSelfLogging } = require('../src/lib/nudges');

    await maybeNudgeOwnerForProSelfLogging(pg, {
      owner_id: req.ownerId,
      toPhone: req.from,
      sendText: async (to, msg) => {
        await sendWhatsApp(to, msg); // must exist in this router scope
      }
    });
  }
} catch (e) {
  console.warn('[NUDGE] skipped:', e?.message);
}

// -----------------------------------------------------------------------
// ✅ Pending Action: fetch ONCE early and reuse everywhere
// This prevents legacy nudge from swallowing edit payloads when hasExpensePA() misses.
// -----------------------------------------------------------------------
const rawFrom = String(req.from || '').trim();
const fromDigits = rawFrom.replace(/\D/g, '');

// Helper: pick newest PA row (created_at desc)
const pickNewestPA = (a, b) => {
  if (!a) return b || null;
  if (!b) return a || null;
  const ta = new Date(a.created_at || 0).getTime();
  const tb = new Date(b.created_at || 0).getTime();
  return tb >= ta ? b : a;
};

let resolvedMostRecentPA = null;

if (typeof pg.getMostRecentPendingActionForUser === 'function') {
  try {
    const [paRaw, paDigits] = await Promise.all([
      pg.getMostRecentPendingActionForUser({ ownerId: req.ownerId, userId: rawFrom }).catch(() => null),
      fromDigits && fromDigits !== rawFrom
        ? pg.getMostRecentPendingActionForUser({ ownerId: req.ownerId, userId: fromDigits }).catch(() => null)
        : Promise.resolve(null)
    ]);

    resolvedMostRecentPA = pickNewestPA(paRaw, paDigits);
  } catch (e) {
    console.warn('[WEBHOOK] getMostRecentPendingActionForUser dual-key failed (ignored):', e?.message);
    resolvedMostRecentPA = null;
  }
}

const mostRecentPAKind = resolvedMostRecentPA?.kind ? String(resolvedMostRecentPA.kind).trim() : '';

console.info('[ROUTER_PA_CTX]', {
  mostRecentPAKind: mostRecentPAKind || null,
  isHardTimeCommand
});

// -----------------------------------------------------------------------
// ✅ Pending-choice intercept (ChatGPT-like log flow)
// If user previously chose "log", then bare intents like "expense" should
// stay in the conversational flow (Agent/Chief) instead of triggering intake.
// Must run BEFORE any intake routing / pending txn nudges.
// -----------------------------------------------------------------------
try {
  // If we are already inside a confirm/pick flow, do NOT hijack it.
  // (Let confirm cards / job pick flows win.)
  const k = String(mostRecentPAKind || "").trim();
  const hasActiveConfirmFlow =
    k === "confirm_expense" ||
    k === "pick_job_for_expense" ||
    k === "confirm_revenue" ||
    k === "pick_job_for_revenue";

  if (!hasActiveConfirmFlow && req.ownerId) {
    const actorKeyDigits =
      String(req.actorKey || "").trim() ||
      String(req.from || "").replace(/\D/g, "").trim();

    // Load actor memory (best-effort)
    let actorMemory = {};
    try {
      if (typeof pg.getActorMemory === "function") {
        actorMemory = (await pg.getActorMemory(String(req.ownerId), actorKeyDigits)) || {};
      }
    } catch (e) {
      console.warn("[MEMORY] getActorMemory failed (ignored):", e?.message);
      actorMemory = {};
    }

    const pendingChoice = String(actorMemory?.pending_choice || "").trim().toLowerCase();

    // Bare intent checks (helpers must exist above)
    const isBareIntent =
      isBareExpense(text2) ||
      isBareRevenue(text2) ||
      isBareTask(text2) ||
      isBareTime(text2) ||
      isBareJob(text2);

    if (pendingChoice === "log" && isBareIntent) {
      // Route through Chief/Agent path (NOT intake handlers)
      // so Chief can ask the single best next question.
      try {
        const { answerChief } = require("../services/answerChief"); // adjust if your path differs

        const tzSafe =
          String(
            req?.tz ||
              req?.userProfile?.tz ||
              req?.ownerProfile?.tz ||
              req?.userProfile?.timezone ||
              req?.ownerProfile?.timezone ||
              ""
          ).trim() || "America/Toronto";

        const out = await answerChief({
  ownerId: req.ownerId,
  actorKey: req.actorKey || req.from,
  text: text2,
  tz: req.tz || req.userProfile?.tz || "America/Toronto",
  channel: "whatsapp",
  req,
  agent: req.app?.locals?.agent || null,
  context: {
    from: req.from,
    ownerProfile: req.ownerProfile,
    userProfile: req.userProfile,
    isOwner: req.isOwner,
    messageSid,
    reqBody: req.body,
    // give it the memory you just loaded (so it can drive the next question)
    actorMemory,
    topicHints: ["logging"],
  },
});

        const reply =
          (typeof out === "string" && out.trim()) ? out.trim() :
          (out?.answer && String(out.answer).trim()) ? String(out.answer).trim() :
          "Okay — what are you logging?";

        return ok(res, reply);
      } catch (e) {
        console.warn("[PENDING_CHOICE] intercept failed (fallthrough):", e?.message);
        // fall through to normal routing
      }
    }
  }
} catch (e) {
  console.warn("[PENDING_CHOICE] outer failed (ignored):", e?.message);
}

const mostRecentIsExpensePA =
  mostRecentPAKind === 'confirm_expense' || mostRecentPAKind === 'pick_job_for_expense';
const mostRecentIsRevenuePA =
  mostRecentPAKind === 'confirm_revenue' || mostRecentPAKind === 'pick_job_for_revenue';

// ✅ Keep your Option A helper (but don’t trust it as sole source of truth)
const expensePA = await hasExpensePA(req.ownerId, rawFrom);
const hasExpensePendingActions = !!expensePA?.hasAny || mostRecentIsExpensePA;
// -------------------------------------------------------------------
// ✅ Pending (legacy stateManager) — define BEFORE any pending?. usage
// -------------------------------------------------------------------
let pending = null;

// Prefer legacy state (this is what mergePendingTransactionState writes to)
try {
  if (stateManager?.getPendingTransactionState) {
    pending = await stateManager.getPendingTransactionState(rawFrom);
  } else if (stateManager?.getPendingState) {
    pending = await stateManager.getPendingState(rawFrom);
  }
} catch (e) {
  pending = null;
}

// Fallback: if some routes attach pending to req (rare but harmless)
pending =
  pending ||
  req.pendingAction ||
  req.pending ||
  req.mostRecentPendingAction ||
  req.pa ||
  null;

// ✅ If PA flow exists, legacy pendingCorrection is stale noise — clear it once.
try {
  if (mostRecentIsExpensePA && pending?.pendingCorrection && pending?.type === 'expense') {
    await stateManager.mergePendingTransactionState(rawFrom, {
      pendingCorrection: false,
      suggestedCorrections: null
    });
    console.info('[WEBHOOK] cleared stale pendingCorrection (expense) due to PA');
  }
} catch {}

 /* ------------------------------------------------------------
 * PENDING TXN NUDGE (legacy revenue/expense flows via stateManager)
 * ------------------------------------------------------------ */

const pendingRevenueFlow =
  !!pending?.pendingRevenue || !!pending?.awaitingRevenueJob || !!pending?.awaitingRevenueClarification;

const pendingExpenseFlowLegacy =
  !!pending?.pendingExpense || !!pending?.awaitingExpenseJob || !!pending?.awaitingExpenseClarification;

const pendingExpenseFlow = pendingExpenseFlowLegacy || hasExpensePendingActions;

// ✅ If user said "skip" in expense.js, we allow new commands/messages to proceed without nagging.
const allowNewWhilePendingExpense = !!pending?.allow_new_while_pending;

// ✅ Only allow job picker commands through when expense PA is NOT active
const allowJobPickerThrough =
  (isJobPickerIntent(lc) || !!pending?.awaitingActiveJobPick) && !hasExpensePendingActions;

if (pendingRevenueFlow && !isHardTimeCommand) {
  if (lc === 'skip') return ok(res, `Okay — leaving that revenue pending. What do you want to do next?`);

  if (!allowJobPickerThrough && !isAllowedWhilePending(lc) && looksHardCommand(lc)) {
    const msg = pendingTxnNudgeMessage({ ...(pending || {}), type: 'revenue' });
    if (msg) return ok(res, msg);
    // msg null => mid-edit; do NOT nag; fall through
  }
}

// ✅ EXPENSE NUDGE GATE — hardened: NEVER block when an expense PA exists
if (pendingExpenseFlow && !isHardTimeCommand) {
  if (!hasExpensePendingActions) {
    if (lc === 'skip') return ok(res, `Okay — leaving that expense pending. What do you want to do next?`);

    if (!allowNewWhilePendingExpense) {
      if (!allowJobPickerThrough && !isAllowedWhilePending(lc) && looksHardCommand(lc)) {
        const msg = pendingTxnNudgeMessage({ ...(pending || {}), type: 'expense' });
        if (msg) return ok(res, msg);
      }
    }
  }

  console.info('[WEBHOOK] after_nudge_gate', {
    hasExpensePendingActions,
    pendingExpenseFlow,
    lc: String(lc || '').slice(0, 30),
    mostRecentPAKind: mostRecentPAKind || null
  });
}

// ✅ Refresh canonical working vars (Body-first) — do NOT redeclare text2/lc2
text2 = String(req.body?.Body || req.body?.ResolvedInboundText || text2 || '').trim();
lc2 = text2.toLowerCase();

/* -----------------------------------------------------------------------
 * Media follow-up: if prior step set pendingMedia and this is text-only
 * ----------------------------------------------------------------------- */
const hasPendingMedia = !!pending?.pendingMedia || !!pending?.pendingMediaMeta;

if (hasPendingMedia && numMedia === 0) {
  try {
    const { handleMedia } = require('../handlers/media');

    // Use the best current text (prefer Body, then ResolvedInboundText, then text2)
    const priorText = String(req.body?.Body || req.body?.ResolvedInboundText || text2 || '').trim();

    const result = await handleMedia(
      req.from,
      priorText,
      req.userProfile || {},
      req.ownerId,
      null,
      null,
      messageSid
    );

    if (result && typeof result === 'object') {
      // If media handler decided to respond immediately, do it.
      if (result.twiml) return sendTwiml(res, result.twiml);

      // If media handler produced a transcript, inject it into Body for routing
      if (result.transcript && !result.twiml) {
        let t = String(result.transcript || '').trim();
        try { if (typeof stripLeadingFiller === 'function') t = stripLeadingFiller(t); } catch {}
        try { if (typeof normalizeTranscriptMoney === 'function') t = normalizeTranscriptMoney(t); } catch {}

        req.body = req.body || {};
        req.body.Body = t;

        console.info('[WEBHOOK_MEDIA_TO_ROUTER_HEAD]', { head: String(t || '').slice(0, 40) });
      }
    } else if (typeof result === 'string' && result) {
      return sendTwiml(res, result);
    }

    // Refresh pending state best-effort (media follow-up may have changed flow state)
    try {
      pending = await safeDb(
        req,
        'getPendingTransactionState',
        () => getPendingTransactionState(req.actorKey || req.from),
        { fallback: pending || null, ms: 2500 }
      );
    } catch (e) {
      console.warn('[WEBHOOK] pending refresh after media failed (ignored):', e?.message);
    }
  } catch (e) {
    console.warn('[WEBHOOK] pending media follow-up failed (ignored):', e?.message);
  }
}


/* -----------------------------------------------------------------------
 * ✅ Canonical post-media refresh (SINGLE source of truth)
 * - IMPORTANT: never let Body overwrite stable interactive tokens
 * - Recompute hard-time classification ONCE (after final text settles)
 * ----------------------------------------------------------------------- */
{
  const resolved0 = String(req.body?.ResolvedInboundText || '').trim();
  const body0 = String(req.body?.Body || '').trim();

  // Treat picker tokens as stable (do not overwrite with transcript Body)
  const isStablePickerToken =
    /^jp:/i.test(resolved0) ||
    /^jobix_\d+/i.test(resolved0) ||
    /^jobno_\d+/i.test(resolved0) ||
    /^jobpick::/i.test(resolved0) ||
    /^(more|overhead|oh)$/i.test(resolved0);

  text2 = isStablePickerToken
    ? resolved0
    : (body0 || resolved0 || text2 || '').trim();

  lc2 = text2.toLowerCase();

  console.info('[ROUTER_TEXT_REFRESH]', { lcN: lc2.slice(0, 50) });
  if (isStablePickerToken) {
    console.info('[ROUTER_PICKER_TOKEN_PRESERVED]', { token: resolved0.slice(0, 80) });
  }

  // Recompute hard-time classification ONCE (after final text settles)
  isHardTimeCommand = looksHardTimeCommand(lc2);
  console.info('[ROUTER_HARD_TIME_POST_MEDIA]', { lcN: lc2.slice(0, 50), isHardTimeCommand });
}

/* -----------------------------------------------------------------------
 * ✅ HARD JOB COMMANDS (router-level)
 * - Runs AFTER final post-media refresh (lc2 is settled)
 * - Runs AFTER tenant link enforcement (req.ownerId exists by here)
 * - Runs BEFORE Insights/orchestrator so "list jobs" never becomes insights
 *
 * IMPORTANT FIX:
 * If we're awaiting a job delete confirmation, route "yes/cancel" back into handleJob()
 * even though "yes" is not a "hard job command".
 * ----------------------------------------------------------------------- */
try {
  const lcJob = String(lc2 || '').trim().toLowerCase();
  const hardJob = isHardJobCommand(lcJob);

  // ✅ If a job-delete confirm is pending, job handler must receive "yes"/"cancel".
  const hasPendingJobDeleteConfirm = !!pending?.awaitingJobDeleteConfirm;

  // ✅ Avoid hijacking PA flows (expense/revenue) unless it's an explicit job command
  const paKindHere = String(mostRecentPAKind || '').trim();
  const isExpensePAHere = paKindHere === 'confirm_expense' || paKindHere === 'pick_job_for_expense';
  const isRevenuePAHere = paKindHere === 'confirm_revenue' || paKindHere === 'pick_job_for_revenue';
  const hasMoneyPAHere = isExpensePAHere || isRevenuePAHere;

  const shouldRouteToJob = hardJob || (hasPendingJobDeleteConfirm && !hasMoneyPAHere);

  console.info('[ROUTER_HARD_JOB]', {
    lcN: lcJob.slice(0, 50),
    isHardJobCommand: hardJob,
    hasPendingJobDeleteConfirm,
    hasMoneyPAHere,
    shouldRouteToJob
  });

  if (shouldRouteToJob) {
    const { handleJob } = require('../handlers/commands/job');

    const sourceMsgId =
      String(req.body?.MessageSid || req.body?.SmsMessageSid || messageSid || '').trim() || null;

    const result = await handleJob(
      req.from,          // fromPhone (digits)
      text2,             // ✅ canonical inbound text (post-media settled)
      req.userProfile,   // userProfile
      req.ownerId,       // ownerId
      req.ownerProfile,  // ownerProfile
      req.isOwner,       // isOwner
      res,               // res (Twilio)
      sourceMsgId        // sourceMsgId
    );

    if (!res.headersSent && result) {
      if (typeof result === 'string') return sendTwiml(res, result);
      if (result?.twiml) return sendTwiml(res, result.twiml);
    }
    return;
  }
} catch (e) {
  console.warn('[ROUTER_HARD_JOB] failed (continue):', e?.message);
}
/* -----------------------------------------------------------------------
 * ✅ INSIGHTS v0 FASTPATH (MVP)
 * - Runs BEFORE job handler routing
 * - Intercepts ONLY deterministic “insight” questions
 * - Must NOT swallow core command flows (expense/revenue/task/time/job CRUD)
 * ----------------------------------------------------------------------- */
try {
  const { answerInsightV0 } = require('../services/insights_v0');
  const { sendJobPickList } = require('../handlers/commands/expense');

  const t = String(text2 || '').trim();
  const s = t.toLowerCase();

  // 0) Hard exclusions — never intercept these (they have dedicated handlers)
  const looksLikeCoreCommand =
    // money logging
    /^\s*(expense|exp)\b/.test(s) ||
    /^\s*(revenue|rev)\b/.test(s) ||
    /^\s*(bill)\b/.test(s) ||
    // timeclock
    /^\s*(clock\s+in|clock\s+out|break|drive|resume|timesheet|undo)\b/.test(s) ||
    // job CRUD / context
    /^\s*(create\s+job|new\s+job|start\s+job|change\s+job|switch\s+job|pick\s+job|active\s+job|set\s+active)\b/.test(s) ||
    // task CRUD
    /^\s*(task\b|my\s+tasks\b|team\s+tasks\b|done\s*#?\d+)\b/.test(s) ||
    // support / admin
    /^\s*(support|help)\b/.test(s);

  if (!t || looksLikeCoreCommand) {
    // let the normal router handle it
  } else {
    // 1) Profit / margin (job-specific)
    const looksProfit =
  (
    /\bprofit\b/.test(s) ||
    /\bprofitability\b/.test(s) ||
    /\bmargin\b/.test(s) ||
    /\bhow\s+profitable\b/.test(s) ||
    /\bwhat'?s\s+the\s+margin\b/.test(s) ||
    /\bhow much am i making\b/.test(s) ||
    /\bhow much are we making\b/.test(s) ||
    /\bwhat am i making\b/.test(s)
  ) &&
  (
    /\bjob\b/.test(s) ||
    /(^|\s)#\d+\b/.test(s) ||          // "#12"
    /\bjob\s*#?\s*\d+\b/.test(s) ||     // "job 1556" or "job #1556"
    /\bactive job\b/.test(s) ||
    /\bon\s+[a-z0-9]/.test(s)
  );
    // 2) Time presets (MVP-safe totals)
    const hasTimePreset =
      /\btoday\b/.test(s) ||
      /\byesterday\b/.test(s) ||
      /\bthis\s+week\b/.test(s) ||
      /\blast\s+week\b/.test(s) ||
      /\bthis\s+month\b/.test(s) ||
      /\blast\s+month\b/.test(s) ||
      /\bthis\s+year\b/.test(s) ||
      /\blast\s+year\b/.test(s);

    const looksSpendTotal =
      (/\bspend\b/.test(s) || /\bspent\b/.test(s) || /\bexpenses?\b/.test(s)) && hasTimePreset;

    const looksRevenueTotal =
      (/\brevenue\b/.test(s) || /\bsales\b/.test(s) || /\bincome\b/.test(s)) && hasTimePreset;

    const looksCashflowTotal =
      (/\bcash\s*flow\b/.test(s) || /\bcashflow\b/.test(s)) && hasTimePreset;

    // 3) Vendor spend (MVP-safe)
    const looksVendorSpend =
      (
        /\bhome depot\b/.test(s) ||
        /\bat\s+[a-z0-9][a-z0-9\s&'.-]{2,}\b/.test(s) ||
        /\bfrom\s+[a-z0-9][a-z0-9\s&'.-]{2,}\b/.test(s)
      ) &&
      (/\bspend\b/.test(s) || /\bspent\b/.test(s) || /\bhow much\b/.test(s) || /\btotal\b/.test(s));

    // 4) Jobs overview (query-ish, not CRUD)
    const looksJobsQuery =
      /\bjobs\b/.test(s) &&
      (/\blist\b/.test(s) || /\bshow\b/.test(s) || /\brecent\b/.test(s) || /\bopen\b/.test(s) || /\bactive\b/.test(s));

    // 5) Tasks overview (query-ish, not CRUD)
    const looksTasksQuery =
      /\btasks?\b/.test(s) &&
      (/\blist\b/.test(s) || /\bshow\b/.test(s) || /\bopen\b/.test(s) || /\bdue\b/.test(s) || /\btoday\b/.test(s) || /\bthis\s+week\b/.test(s));

    // 6) Top vendors / categories (optional MVP-safe)
    const looksTopVendors =
      (/\btop\b/.test(s) || /\bbiggest\b/.test(s)) &&
      (/\bvendors?\b/.test(s) || /\bwhere am i spending\b/.test(s) || /\bwho am i paying\b/.test(s));

    const looksTopCategories =
      (/\btop\b/.test(s) || /\bbiggest\b/.test(s)) &&
      (/\bcategories?\b/.test(s) || /\bwhere am i spending\b/.test(s));

    const shouldIntercept =
      looksProfit ||
      looksSpendTotal ||
      looksRevenueTotal ||
      looksCashflowTotal ||
      looksVendorSpend ||
      looksJobsQuery ||
      looksTasksQuery ||
      looksTopVendors ||
      looksTopCategories;

    if (shouldIntercept) {
  const out = await answerInsightV0({
    ownerId: req.ownerId,
    actorKey: req.actorKey || req.from,
    text: t,
    tz: req.tz || 'America/Toronto'
  });

  // ✅ NEW: route-aware handling
  if (out?.route === 'picker' && out?.picker?.kind === 'job_picker') {
    const fromPhone = String(req.from || '').trim();
    const ownerId = String(req.ownerId || '').trim();

    const userProfile = req.userProfile || req.profile || req.actorProfile || null;

    const paUserId =
      (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(req.waId || req.from)) ||
      String(req.waId || req.from || '').replace(/\D/g, '');

    const pickUserId = paUserId;

    const stableMsgId =
      String(req.messageSid || req.body?.MessageSid || req.body?.SmsMessageSid || '').trim() ||
      `${paUserId}:${Date.now()}`;

    const jobOptions = Array.isArray(out.picker.jobOptions) ? out.picker.jobOptions : [];

    await sendJobPickList({
      fromPhone,
      ownerId,
      userProfile,
      confirmFlowId: stableMsgId,
      jobOptions,
      paUserId,
      pickUserId,
      page: 0,
      pageSize: 8,
      context: out.picker.context || 'profit_jobpick',
      confirmDraft: null,
      resolveAttempts: 0
    });

    // ✅ IMPORTANT: don’t also send a text reply
    // Prefer empty TwiML so Twilio doesn't show a blank message
    return sendTwiml(res, twimlEmpty());
    // If you don't have sendTwiml/twimlEmpty here, use whatever your other branches use
  }

  // Normal text response path
  if (out?.answer) return ok(res, out.answer);
}
  }
} catch (e) {
  console.warn('[INSIGHTS_V0_FASTPATH] skipped:', e?.message);
}

/* -----------------------------------------------------------------------
 * ✅ Quotes (MVP): route early (before PA router / other flows)
 * ----------------------------------------------------------------------- */
try {
  // Quote commands should not be interpreted as PA confirmations.
  // They are deterministic and generate a PDF + link.
  if (typeof isQuoteCommand === 'function' && isQuoteCommand(text2)) {
    const msg = await handleQuoteCommand({
      ownerId: req.ownerId,
      from: req.from,
      text: text2,
      userProfile: req.userProfile
    });

    if (typeof msg === 'string' && msg.trim()) return ok(res, msg.trim());
    return ok(res, 'Quote created.');
  }
} catch (e) {
  console.error('[QUOTE] error:', e?.message);
  return ok(res, 'Quote error. Try again.');
}

    /* -----------------------------------------------------------------------
     * ✅ Pending-actions router (must run early)
     * Uses resolvedMostRecentPA fetched earlier (single source here)
     * ----------------------------------------------------------------------- */

    const pa = resolvedMostRecentPA;
    const paKind = pa?.kind ? String(pa.kind).trim() : '';

    const isExpensePA = paKind === 'confirm_expense' || paKind === 'pick_job_for_expense';
    const isRevenuePA = paKind === 'confirm_revenue' || paKind === 'pick_job_for_revenue';

    // ✅ STRICT TOKENS = EXACT MATCH ONLY (no ok/yeah/yep normalization)
    const strictControlTokenForPA = (raw) => {
      const t = String(raw || '').trim().toLowerCase();
      if (!t) return null;

      if (t === 'yes') return 'yes';
      if (t === 'edit') return 'edit';
      if (t === 'cancel') return 'cancel';
      if (t === 'resume') return 'resume';
      if (t === 'skip') return 'skip';
      if (t === 'change_job' || t === 'change job') return 'change_job';

      return null;
    };

  if (isExpensePA && !isHardTimeCommand) {
  try {
    const expenseMod = require('../handlers/commands/expense');
    const expenseHandler =
      expenseMod && typeof expenseMod.handleExpense === 'function' ? expenseMod.handleExpense : null;

    if (!expenseHandler) throw new Error('expense handler export missing (handleExpense)');

    const handlerArgs = [
      req.from,
      text2,
      req.userProfile,
      req.ownerId,
      req.ownerProfile,
      req.isOwner,
      messageSid,
      req.body
    ];

    // Always run the handler first (it owns state transitions)
    const first = await expenseHandler(...handlerArgs);

    const strictTok = strictControlTokenForPA(text2);

    // ✅ helpers (local to this block is fine)
    const looksLikeXml = (s) => typeof s === 'string' && s.trim().startsWith('<');
    const isDoneAck = (s) => typeof s === 'string' && /^done\.?$/i.test(s.trim());

    console.info('[AUTO_YES_CHECK]', {
      from: req.from,
      kind: 'expense',
      messageSid,
      strictTok: strictTok || null,
      head: String(text2 || '').slice(0, 20)
    });

    // ✅ Never auto-yes on strict control tokens
    if (strictTok) {
      if (!res.headersSent) {
        // Prefer TwiML objects
        if (first && typeof first === 'object' && first.twiml) return sendTwiml(res, first.twiml);

        // ONLY send string if it's XML TwiML
        if (typeof first === 'string' && looksLikeXml(first)) return sendTwiml(res, first);

        // Suppress non-XML strings like "Done."
        return ok(res, null);
      }
      return;
    }

    const tw = await maybeAutoYesAfterEdit({
      userId: req.from,
      kind: 'expense',
      handlerFn: expenseHandler,
      handlerArgs,
      firstResult: first,
      getPendingTransactionState,
      mergePendingTransactionState,
      messageSid
    });

    if (!res.headersSent) {
      // Prefer TwiML objects
      if (tw && typeof tw === 'object' && tw.twiml) return sendTwiml(res, tw.twiml);
      if (first && typeof first === 'object' && first.twiml) return sendTwiml(res, first.twiml);

      // ONLY send strings if they are XML TwiML
      if (typeof tw === 'string' && looksLikeXml(tw)) return sendTwiml(res, tw);
      if (typeof first === 'string' && looksLikeXml(first)) return sendTwiml(res, first);

      // Belt & suspenders: suppress Done ack if it leaks through
      if (isDoneAck(tw) || isDoneAck(first)) return ok(res, null);

      // Default: no bubble
      return ok(res, null);
    }
    return;
  } catch (e) {
    console.warn('[WEBHOOK] expense PA router failed (ignored):', e?.message);
  }
}

    if (isRevenuePA && !isHardTimeCommand) {
      try {
        const revMod = require('../handlers/commands/revenue');
        const revenueHandler =
          revMod && typeof revMod.handleRevenue === 'function' ? revMod.handleRevenue : null;

        if (!revenueHandler) throw new Error('revenue handler export missing (handleRevenue)');

        const handlerArgs = [
          req.from,
          text2,
          req.userProfile,
          req.ownerId,
          req.ownerProfile,
          req.isOwner,
          messageSid,
          req.body
        ];

        const first = await revenueHandler(...handlerArgs);

        const strictTok = strictControlTokenForPA(text2);

        console.info('[AUTO_YES_CHECK]', {
          from: req.from,
          kind: 'revenue',
          messageSid,
          strictTok: strictTok || null,
          head: String(text2 || '').slice(0, 20)
        });

        // ✅ Never auto-yes on strict control tokens
        if (strictTok) {
          if (!res.headersSent) {
            if (first && typeof first === 'object' && first.twiml) return sendTwiml(res, first.twiml);
            if (typeof first === 'string' && first) return sendTwiml(res, first);
            return ok(res);
          }
          return;
        }

        const tw = await maybeAutoYesAfterEdit({
          userId: req.from,
          kind: 'revenue',
          handlerFn: revenueHandler,
          handlerArgs,
          firstResult: first,
          getPendingTransactionState,
          mergePendingTransactionState,
          messageSid
        });

        if (!res.headersSent) {
          if (tw && typeof tw === 'object' && tw.twiml) return sendTwiml(res, tw.twiml);
          if (typeof tw === 'string' && tw) return sendTwiml(res, tw);
          if (first && typeof first === 'object' && first.twiml) return sendTwiml(res, first.twiml);
          if (typeof first === 'string' && first) return sendTwiml(res, first);
          return ok(res);
        }
        return;
      } catch (e) {
        console.warn('[WEBHOOK] revenue PA router failed (ignored):', e?.message);
      }
    }

    
    /* -----------------------------------------------------------------------
     * (A0) ACTIVE JOB PICKER FLOW — only if awaitingActiveJobPick OR explicit intent
     * AND NOT blocked by expense pending_actions.
     * ----------------------------------------------------------------------- */
    if (!hasExpensePendingActions && (isJobPickerIntent(lc2) || pending?.awaitingActiveJobPick)) {
      if (isPickerToken && !pending?.awaitingActiveJobPick) {
        // fall through
      } else {
        try {
          const cmds = require('../handlers/commands');
          const handleJob =
            (cmds?.job && cmds.job.handleJob) || cmds?.handleJob || require('../handlers/commands/job').handleJob;

          if (typeof handleJob === 'function') {
            await handleJob(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
            if (res.headersSent) return;
            return ok(res); // empty TwiML
          }
        } catch (e) {
          console.warn('[WEBHOOK] job picker handler failed:', e?.message);
        }
      }
    }

    /* -----------------------------------------------------------------------
     * (A) PENDING FLOW ROUTER — MUST RUN BEFORE ANY FAST PATH OR AGENT
     * ----------------------------------------------------------------------- */
    const isNewRevenueCmd = /^(?:revenue|rev|received)\b/.test(lc2);
    const isNewExpenseCmd = /^(?:expense|exp)\b/.test(lc2);

    const pendingRevenueLike =
  !!pending?.awaitingRevenueClarification ||
  !!pending?.awaitingRevenueJob ||
  ((pending?.pendingCorrection && pending?.type === 'revenue') && !mostRecentIsRevenuePA) ||
  (!!pending?.pendingRevenue && !isNewRevenueCmd);

const expensePendingActionsLike =
  hasExpensePendingActions && (isPickerToken || isAllowedWhilePending(lc2) || /^(expense|exp)\b/.test(lc2));

const pendingExpenseLike =
  expensePendingActionsLike ||
  !!pending?.awaitingExpenseClarification ||
  !!pending?.awaitingExpenseJob ||
  pending?.pendingDelete?.type === 'expense' ||
  ((pending?.pendingCorrection && pending?.type === 'expense') && !mostRecentIsExpensePA) ||
  (!!pending?.pendingExpense && !isNewExpenseCmd);


    if (pendingRevenueLike && !isHardTimeCommand) {

  try {
    const revMod = require('../handlers/commands/revenue');
    const revenueHandler = revMod && typeof revMod.handleRevenue === 'function' ? revMod.handleRevenue : null;

    if (!revenueHandler) {
      throw new Error('revenue handler export missing (handleRevenue)');
    }

    const handlerArgs = [
      req.from,
      text2,
      req.userProfile,
      req.ownerId,
      req.ownerProfile,
      req.isOwner,
      messageSid,
      req.body
    ];

    const first = await revenueHandler(...handlerArgs);

    const tw = await maybeAutoYesAfterEdit({
      userId: req.from,
      kind: 'revenue',
      handlerFn: revenueHandler,
      handlerArgs,
      firstResult: first,
      getPendingTransactionState,
      mergePendingTransactionState,
      messageSid
    });

    if (!res.headersSent) {
      if (tw && typeof tw === 'object' && tw.twiml) return sendTwiml(res, tw.twiml);
      if (typeof tw === 'string' && tw) return sendTwiml(res, tw);
      return ok(res);
    }
    return;
  } catch (e) {
    console.warn('[WEBHOOK] revenue pending/clarification handler failed:', e?.message);
  }
}


    /* -----------------------------------------------------------------------
 * (B) FAST PATHS — REVENUE/EXPENSE (prefix OR NL)
 * ----------------------------------------------------------------------- */

// Prefix commands (hard)
const revenuePrefix = /^(?:revenue|rev|received)\b/.test(lc2);
const expensePrefix = /^(?:expense|exp)\b/.test(lc2);

// NL heuristics (soft)
const revenueNl = !revenuePrefix && looksRevenueNl(text2);
const expenseNl = !expensePrefix && looksExpenseNl(text2);

// ✅ Precedence rule: revenue wins on cheque/check/received/deposit unless strong expense verbs
const looksRevenue = revenuePrefix || (revenueNl && !expensePrefix);
const looksExpense = expensePrefix || (!looksRevenue && expenseNl); // only if not revenue

// -------------------- REVENUE FAST PATH --------------------
if (looksRevenue && !isHowToQuestion && !isQuestionAsk) {
  if (revenueNl) console.info('[WEBHOOK] NL revenue detected', { from: req.from, text: text2.slice(0, 120) });

  try {
    const { handleRevenue } = require('../handlers/commands/revenue');

    const result = await handleRevenue(
      req.from,
      text2,
      req.userProfile,
      req.ownerId,
      req.ownerProfile,
      req.isOwner,
      messageSid,
      req.body
    );

    if (!res.headersSent) {
      const twiml =
        typeof result === 'string'
          ? result
          : (result && typeof result.twiml === 'string' ? result.twiml : null);

      return sendTwiml(res, twiml);
    }
    return;
  } catch (e) {
    console.warn('[WEBHOOK] revenue handler failed:', e?.message);
    if (!res.headersSent) return ok(res, null);
    return;
  }
}


// -------------------- EXPENSE FAST PATH --------------------
if (looksRevenue && !isHowToQuestion && !isQuestionAsk) {
  if (expenseNl) console.info('[WEBHOOK] NL expense detected', { from: req.from, text: text2.slice(0, 120) });

  try {
    const { handleExpense } = require('../handlers/commands/expense');

    const timeoutMs = 8000;
    const timeoutTwiml = twimlText(
      '⚠️ I’m having trouble saving that right now (database busy). Please tap Yes again in a few seconds.'
    );

    let timeoutId = null;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        console.warn('[WEBHOOK] expense handler timeout', { from: req.from, messageSid, timeoutMs });
        resolve(timeoutTwiml);
      }, timeoutMs);
    });

    const result = await Promise.race([
      handleExpense(
        req.from,
        text2,
        req.userProfile,
        req.ownerId,
        req.ownerProfile,
        req.isOwner,
        messageSid,
        req.body
      ),
      timeoutPromise
    ]).finally(() => timeoutId && clearTimeout(timeoutId));

    if (!res.headersSent) {
      const twiml =
        typeof result === 'string'
          ? result
          : (result && typeof result.twiml === 'string' ? result.twiml : null);

      return sendTwiml(res, twiml);
    }
    return;
  } catch (e) {
    console.warn('[WEBHOOK] expense handler failed:', e?.message);
    if (!res.headersSent) return ok(res, null);
    return;
  }
}

    /* -----------------------------------------------------------------------
     * (C) Other command routing (tasks / jobs / timeclock / forecast / KPIs / agent)
     * ----------------------------------------------------------------------- */

    async function glossaryNudgeFrom(str) {
      try {
        const glossary = require('../services/glossary');
        const findClosestTerm = glossary?.findClosestTerm;
        if (typeof findClosestTerm !== 'function') return '';

        const words = String(str || '').toLowerCase().match(/[a-z0-9_-]+/g) || [];
        for (const w of words) {
          const hit = await findClosestTerm(w);
          if (hit?.nudge) return `\n\nTip: ${hit.nudge}`;
        }
        return '';
      } catch {
        return '';
      }
    }

    const askingHow = /\b(how (do|to) i|how to|help with|how do i use|how can i use)\b/.test(lc2);

    let looksTask = /^task\b/.test(lc2) || /\btasks?\b/.test(lc2);

    let looksJob =
  isJobPickerIntent(lc2) ||
  /\bactive job\??\b/.test(lc2) ||
  /\bwhat'?s\s+my\s+active\s+job\??\b/.test(lc2) ||
  /\bset\s+active\b/.test(lc2) ||
  /\b(list|create|new|start|change|switch|pick|activate|pause|resume|finish|close|delete|remove|archive)\s+job\b/.test(lc2) ||
  /\bjobs?\s+(list|show|open|active|recent)\b/.test(lc2) ||
  /\bmove\s+last\s+log\s+to\b/.test(lc2);

 let looksTime =
  /\b(time\s*clock|timeclock|clock|punch|break|drive|timesheet|hours|lunch|undo)\b/.test(lc2) ||
  /\b(clockin|clockout|punchin|punchout|shiftin|shiftout|undolast|breakstart|breakend|startbreak|lunchstart|lunchend)\b/.test(lc2) ||
  /^clock\s*(in|out)\b/.test(lc2) ||
  /^undo(\s+last)?$/.test(lc2);




    if (askingHow && /\btasks?\b/.test(lc2)) looksTask = true;
    if (askingHow && /\b(time\s*clock|timeclock)\b/.test(lc2)) looksTime = true;
    if (askingHow && /\bjobs?\b/.test(lc2)) looksJob = true;

    const topicHints = [looksTask ? 'tasks' : null, looksJob ? 'jobs' : null, looksTime ? 'timeclock' : null].filter(Boolean);

    let tasksHandler = null;
    let handleJob = null;
    let handleTimeclock = null;

    try {
      const cmds = require('../handlers/commands');

      tasksHandler =
        (cmds?.tasks && (cmds.tasks.tasksHandler || cmds.tasks)) ||
        require('../handlers/commands/tasks').tasksHandler ||
        null;

      handleJob = (cmds?.job && cmds.job.handleJob) || require('../handlers/commands/job').handleJob || null;

      handleTimeclock =
        (cmds?.timeclock && (cmds.timeclock.handleTimeclock || cmds.timeclock)) ||
        require('../handlers/commands/timeclock').handleTimeclock ||
        null;
    } catch (e) {
      console.warn('[WEBHOOK] commands bundle load failed (ignored):', e?.message);
    }

    const SOP = {
      tasks:
        'Tasks — Quick guide:\n' +
        '• Create: task - buy nails\n' +
        '• List mine: my tasks\n' +
        '• Complete: done #4\n' +
        '• Assign: task @PHONE - pickup shingles\n' +
        '• Due date: task - call client | due tomorrow 4pm',
      timeclock:
        'Timeclock — Quick guide:\n' +
        '• Clock in: clock in (uses active job) or clock in @ Roof Job\n' +
        '• Break/Drive: break start/stop; drive start/stop\n' +
        '• Clock out: clock out\n' +
        '• Timesheet: timesheet week',
      jobs:
        'Jobs — Quick guide:\n' +
        '• Create: create job Roof Repair\n' +
        '• Set active: change job (or active job Roof Repair)\n' +
        '• List: list jobs\n' +
        '• Close: finish job Roof Repair\n' +
        '• Move: move last log to Front Porch [for Justin]'
    };

    if (looksTask && typeof tasksHandler === 'function') {
      const out = await tasksHandler(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
      if (res.headersSent) return;

      let msg = '';
      if (typeof out === 'string' && out.trim()) msg = out.trim();
      else if (askingHow) msg = SOP.tasks;
      else if (out === true) return ok(res);
      else msg = 'Task handled.';

      msg += await glossaryNudgeFrom(text2);
      return ok(res, msg);
    }

    if (looksJob && typeof handleJob === 'function') {
      if (looksLikeJobPickerReplyToken(text2) && !isJobPickerIntent(lc2) && !pending?.awaitingActiveJobPick) {
        // fall through to agent/help
      } else {
        await handleJob(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
        if (res.headersSent) return;

        let msg = askingHow ? SOP.jobs : 'Job handled.';
        msg += await glossaryNudgeFrom(text2);
        return ok(res, msg);
      }
    }

    if (/^forecast\b/i.test(lc2)) {
      try {
        const handled = await handleForecast(
          {
            text: text2,
            ownerId: req.ownerId,
            jobId: req.userProfile?.active_job_id || null,
            jobName: req.userProfile?.active_job_name || 'All Jobs'
          },
          res
        );

        if (res.headersSent) return;
        if (handled) return ok(res);
      } catch (e) {
        console.warn('[WEBHOOK] forecast failed:', e?.message);
      }
    }

  const s = String(lc2 || '').trim();
console.info('[TIME_V2_GATE]', { timeclock_v2: !!flags.timeclock_v2, isHardTimeCommand, lc2 });

// ✅ ALWAYS allow timeclock repair replies (duration/skip) to be handled,
// even if the text is NOT a hard time command (e.g., "20 min").
if (flags.timeclock_v2) {
  try {
    const { handleSegmentDurationRepairReply } = require('../handlers/commands/timeclock');
    if (typeof handleSegmentDurationRepairReply === 'function') {
      const ownerDigits = String(req.ownerId || '').replace(/\D/g, '');
      const actorId = String(req.actorKey || req.from || '').replace(/\D/g, '');

      if (ownerDigits && actorId) {
      const repairOut = await handleSegmentDurationRepairReply(
  {
    owner_id: ownerDigits,
    user_id: actorId,
    source_msg_id: messageSid || null,
    tz: req.tz || req.userProfile?.tz || 'America/Toronto',
    fallbackName: req.userProfile?.name || req.userProfile?.ProfileName || ''
  },
  text2
);


// ✅ LOG RIGHT HERE
console.info('[TIME_V2_REPAIR_CHECK]', {
  ownerDigits,
  actorId,
  text2,
  hasRepairOut: !!repairOut,
  hasText: !!String(repairOut?.text || '').trim()
});

// ✅ Only respond if we got a real message back
if (repairOut && String(repairOut.text || '').trim()) {
          let msg = String(repairOut.text || '').trim();
          msg += await glossaryNudgeFrom(text2);

          return twimlWithTargetName(res, msg, {
            ownerId: ownerDigits,
            actorId,
            targetUserId: String(repairOut.targetUserId || actorId).replace(/\D/g, '') || actorId,
            fallbackName: req.userProfile?.name || req.userProfile?.ProfileName || ''
          });
        }
      }
    }
  } catch (e) {
    console.warn('[TIME_V2_REPAIR] ignored:', e?.message);
  }
}

// From here down: only handle "hard time commands" via CIL
if (flags.timeclock_v2 && looksHardTimeCommand(text2)) {
  const s0 = String(text2 || '').trim();

  // ✅ Timesheet routes even without Clock CIL
  if (looksTimesheetCommand(s0)) {
    try {
      const out = await handleTimesheetCommand({
        ownerId: req.ownerId,
        actorKey: req.actorKey, // digits
        from: req.from, // e164
        text: s0,
        req,
        res
      });
      if (out !== false) return; // handler already responded (twiml or json)
    } catch (e) {
      console.error('[TIMESHEET] error:', e?.message);
      return ok(res, 'Timesheet error. Try again.');
    }
  }

  // existing Clock CIL builder
  const cil = (() => {
    const s = String(text2 || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const c = s.replace(/\s+/g, '');

    if (/^undo(\s+last)?$/.test(s) || /^undolast$/.test(c)) return null;

    if (/^clock\s*in\b/.test(s) || /^clockin\b/.test(c)) return { type: 'Clock', action: 'in' };
    if (/^clock\s*out\b/.test(s) || /^clockout\b/.test(c)) return { type: 'Clock', action: 'out' };

    if (/^break\s+start(ed)?\b/.test(s) || /^(breakstart|startbreak)$/.test(c)) return { type: 'Clock', action: 'break_start' };
    if (/^break\s+(stop|end)(ed)?\b/.test(s) || /^(breakend|endbreak|breakstop|stopbreak)$/.test(c)) return { type: 'Clock', action: 'break_stop' };

    if (/^lunch\s+start(ed)?\b/.test(s) || /^(lunchstart|startlunch)$/.test(c)) return { type: 'Clock', action: 'lunch_start' };
    if (/^lunch\s+(stop|end)(ed)?\b/.test(s) || /^(lunchend|endlunch|lunchstop|stoplunch)$/.test(c)) return { type: 'Clock', action: 'lunch_stop' };

    if (/^drive\s+start(ed)?\b/.test(s) || /^(drivestart|startdrive)$/.test(c)) return { type: 'Clock', action: 'drive_start' };
    if (/^drive\s+(stop|end)(ed)?\b/.test(s) || /^(driveend|enddrive|drivestop|stopdrive)$/.test(c)) return { type: 'Clock', action: 'drive_stop' };

    return null;
  })();

  console.info('[TIME_V2_CIL]', { flagsTimeV2: true, text2, matched: !!cil, cil });

  if (cil) {
    const nowIso = new Date().toISOString();

    const actorId = String(req.actorKey || req.from || '').replace(/\D/g, '');
    const ownerDigits = String(req.ownerId || '').replace(/\D/g, '');

    const resolved = await resolveTargetUserIdsFromText({ ownerId: ownerDigits, text: text2 });

    let targets = resolved.targets || [];
    if (!targets.length) targets = actorId ? [actorId] : [];

    if (!actorId) {
      let msg = 'Timeclock: missing user identity (WaId).';
      msg += await glossaryNudgeFrom(text2);
      return ok(res, msg);
    }

    const baseCtx = {
  owner_id: ownerDigits,
  job_id: req.userProfile?.active_job_id || null,
  created_by: actorId,
  source_msg_id: messageSid || null,
  tz: req.tz || req.userProfile?.tz || 'America/Toronto',
  meta: { job_name: req.userProfile?.active_job_name || null }
};


    const cilToSend = { ...cil, at: nowIso };

    targets = Array.from(new Set((targets || []).map((x) => String(x || '').replace(/\D/g, '')).filter(Boolean)));

    if (targets.length > 1 || resolved.mode === 'crew') {
      let okCount = 0;
      let lastText = '';
      const previewNames = [];
      const previewSeen = new Set();

      for (const targetId of targets) {
        const ctx = { ...baseCtx, user_id: targetId };

        try {
          const reply = await handleClock(ctx, cilToSend);
          if (reply?.text) lastText = reply.text;
          okCount += 1;

          const nmRaw = resolved.namesById?.[targetId];
          const nm = String(nmRaw || '').trim();

          if (nm && previewNames.length < 4) {
            const key = nm.toLowerCase();
            if (!previewSeen.has(key)) {
              previewSeen.add(key);
              previewNames.push(nm);
            }
          }
        } catch (e) {
          console.warn('[TIME_V2_MULTI] target failed:', e?.message, { targetId });
        }
      }

      if (!okCount) {
        let msg = 'Timeclock: no valid targets found.';
        msg += await glossaryNudgeFrom(text2);
        return ok(res, msg);
      }

      let msg = aggregateCrewMessage({
        action: cil.action,
        count: okCount,
        previewNames,
        baseText: lastText || 'Time logged.'
      });

      msg += await glossaryNudgeFrom(text2);
      return ok(res, msg);
    }

    const targetUserId = String(targets[0] || actorId).replace(/\D/g, '') || actorId;
    const ctx = { ...baseCtx, user_id: targetUserId };

    const raw = await handleClock(ctx, cilToSend);

    const reply =
      typeof raw === 'string'
        ? { text: raw, targetUserId }
        : raw && typeof raw === 'object'
          ? { text: raw.text || 'Time logged.', targetUserId: raw.targetUserId || targetUserId }
          : { text: 'Time logged.', targetUserId };

    let msg = String(reply.text || 'Time logged.').trim();
    msg += await glossaryNudgeFrom(text2);

    return twimlWithTargetName(res, msg, {
      ownerId: ownerDigits,
      actorId,
      targetUserId: reply.targetUserId || targetUserId,
      fallbackName: req.userProfile?.name || req.userProfile?.ProfileName || ''
    });
  }
}





    if (looksTime && typeof handleTimeclock === 'function') {
      const out = await handleTimeclock(req.actorKey || req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
      if (res.headersSent) return;

      let msg = '';
      if (typeof out === 'string' && out.trim()) msg = out.trim();
      else if (askingHow) msg = SOP.timeclock;
      else if (out === true) return ok(res);
      else msg = 'Time logged.';

      msg += await glossaryNudgeFrom(text2);
      return ok(res, msg);
    }
   // --- one-time plan sanity log (remove after verification) ---
try {
  console.info("[PLAN_EFFECTIVE]", {
    from: req.from,
    ownerId: req.ownerId,
    plan_key: req.ownerProfile?.plan_key || null,
    sub_status: req.ownerProfile?.sub_status || null,
    effective_plan: getEffectivePlanKey(req.ownerProfile),
  });
} catch {}

    const looksKpi = /^kpis?\s+for\b/.test(lc2);
    const KPI_ENABLED = (process.env.FEATURE_FINANCE_KPIS || '0') === '1';
    const hasSub = canUseAgent(req.ownerProfile);

    if (looksKpi && KPI_ENABLED && hasSub) {
      try {
        const { handleJobKpis } = require('../handlers/commands/job_kpis');
        if (typeof handleJobKpis === 'function') {
          const out = await handleJobKpis(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
          if (res.headersSent) return;

          let msg = typeof out === 'string' && out.trim() ? out.trim() : 'KPI shown.';
          msg += await glossaryNudgeFrom(text2);
          return ok(res, msg);
        }
      } catch (e) {
        console.warn('[KPI] handler missing:', e?.message);
      }
    }

 try {
  const { answerChief } = require('../services/answerChief');

  const out = await answerChief({
    ownerId: req.ownerId,
    actorKey: req.actorKey || req.from,
    text: text2,
    tz: req.tz || req.userProfile?.tz || 'America/Toronto',
    channel: 'whatsapp',
    req,
    agent: req.app?.locals?.agent || null,
    context: {
      from: req.from,
      ownerProfile: req.ownerProfile,
      userProfile: req.userProfile,
      isOwner: req.isOwner,
      messageSid,
      reqBody: req.body,
      topicHints
    }
  });

  if (out?.route === 'action' && typeof out.run === 'function') {
    const ran = await out.run();
    const ans = String(ran?.answer || '').trim() || 'Done.';
    let msg = ans + (await glossaryNudgeFrom(text2));
    return ok(res, msg);
  }

  if (String(out?.answer || '').trim()) {
    let msg = String(out.answer).trim();
    msg += await glossaryNudgeFrom(text2);
    return ok(res, msg);
  }
} catch (e) {
  console.warn('[CHIEF] answerChief failed:', e?.message);
}

// final fallback
let msg =
  'ChiefOS — Try:\n' +
  '• expense $18 Home Depot\n' +
  '• revenue $500 deposit\n' +
  '• task - buy nails\n' +
  '• clock in';

msg += await glossaryNudgeFrom(text2);
return ok(res, msg);
  } catch (err) {
    return next(err);
  }
});

/* ---------------- Final fallback (always 200) ---------------- */

router.use((req, res, next) => {
  if (!res.headersSent) {
    console.warn('[WEBHOOK] fell-through fallback');
    return ok(res); // empty
  }
  next();
});

/* ---------------- Error middleware (lazy) ---------------- */

try {
  const { errorMiddleware } = require('../middleware/error');
  router.use(errorMiddleware);
} catch {
  /* no-op */
}

/* ---------------- Export ---------------- */

app.use('/', router);
module.exports = (req, res) => app.handle(req, res);
