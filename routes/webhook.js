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

  // If handler returned multi-line text, keep the "tail" as a follow-up under the crew line.
  const parts = bt.split('\n').map((x) => x.trim()).filter(Boolean);
  const tail = parts.length > 1 ? parts.slice(1).join('\n') : '';

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

function canUseAgent(profile) {
  const tier = (profile?.subscription_tier || profile?.plan || '').toLowerCase();
  return !!tier && tier !== 'basic' && tier !== 'free';
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

    const pending = await getPendingTransactionState(userId);
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
  const messageSid = String(req.body?.MessageSid || req.body?.SmsMessageSid || '').trim() || null;

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
    const token = require('../middleware/token');
    const prof = require('../middleware/userProfile');
    const lock = require('../middleware/lock');

    res.locals.phase = 'token';
    res.locals.phaseAt = Date.now();

    token.tokenMiddleware(req, res, () => {
      res.locals.phase = 'userProfile';
      res.locals.phaseAt = Date.now();

      prof.userProfileMiddleware(req, res, () => {
  // ✅ WHOAMI debug (remove after you confirm gating)
  try {
    console.info('[WHOAMI_CTX]', {
      from: req.from || null,
      actorKey: req.actorKey || null,
      waId: req.body?.WaId || req.body?.WaID || null,
      profileName: req.body?.ProfileName || null,
      ownerId: req.ownerId || null,
      isOwner: !!req.isOwner,
      role: req.userProfile?.role || req.userProfile?.user_role || null,
      userId: req.userProfile?.user_id || req.userProfile?.id || null
    });
  } catch {}

  res.locals.phase = 'lock';
  res.locals.phaseAt = Date.now();

  lock.lockMiddleware(req, res, () => {
    res.locals.phase = 'router';
    res.locals.phaseAt = Date.now();
    next();
  });
});

    });
  } catch (e) {
    console.warn('[WEBHOOK] light middlewares skipped:', e?.message);
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

/* ---------------- Media ingestion (audio/image → handleMedia) ---------------- */

router.post('*', async (req, res, next) => {
  const { n, url, type } = pickFirstMedia(req.body || {});
  if (n <= 0) return next();

  try {
    const { handleMedia } = require('../handlers/media');

    const bodyText = getInboundText(req.body || {});
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

// ✅ Boundary debug
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


if (hasTranscript) {
  let t = String(result.transcript || '').trim();

  // ✅ Fix voice fillers ("uh, expense ...") BEFORE routing
  try {
    if (typeof stripLeadingFiller === 'function') t = stripLeadingFiller(t);
  } catch {}

  // ✅ Apply your deterministic money normalization BEFORE routing
  try {
    if (typeof normalizeTranscriptMoney === 'function') t = normalizeTranscriptMoney(t);
  } catch {}

  req.body.Body = t;

  console.info('[WEBHOOK_MEDIA_TO_ROUTER_HEAD]', {
    head: String(t || '').slice(0, 12),
  });

  // ✅ ADD THIS DEBUG LINE (right here)
  console.info('[MEDIA_ROUTING_BODY]', {
    bodyHead: String(req.body?.Body || '').slice(0, 60),
    len: String(req.body?.Body || '').length
  });

  return next();
}

    if (typeof result === 'string' && !res.headersSent) {
      return sendTwiml(res, result);
    }

    return next();
  } catch (e) {
    console.error('[MEDIA] error:', e?.message);
    if (!res.headersSent) return ok(res, null); // empty TwiML
  }
});


/* ---------------- Main text router ---------------- */

router.post('*', async (req, res, next) => {
  try {
    // ✅ Fail-closed: unknown identity (not linked to any tenant)
    if (!req.ownerId) {
      return ok(
        res,
        `You’re not linked to a ChiefOS business yet.\n\nGo to the portal, generate a link code, then text the 6 digits here.`
      );
    }

    if (req.from) {
      try {
        const mapped = await getOwnerUuidForPhone(req.from);
        if (mapped) req.ownerUuid = mapped;
      } catch (e) {
        console.warn('[WEBHOOK] owner uuid map failed:', e?.message);
      }
    }

        let pending = await getPendingTransactionState(req.actorKey || req.from);
    const numMedia = parseInt(req.body?.NumMedia || '0', 10) || 0;
    const crypto = require('crypto');

    // ✅ Canonical inbound text (single source of truth for this request)
    // Prefer Twilio interactive IDs exactly as sent (jp:...).
    let text = String(resolveInboundTextFromTwilio(req.body || {}) || '').trim();
    req.body.ResolvedInboundText = text;
    let lc = text.toLowerCase();

    // ✅ PROVE router received the message + what text it resolved
    console.info('[WEBHOOK_IN]', {
      ownerId: req.ownerId || null,
      from: req.from || null,
      messageSid: req.body?.MessageSid || req.body?.SmsMessageSid || null,
      waId: req.body?.WaId || req.body?.WaID || req.body?.waid || null,
      numMedia: Number(req.body?.NumMedia || 0) || 0,
      resolvedInbound: String(text || '').slice(0, 140),
      ListId: req.body?.ListId || null,
      ListRowId: req.body?.ListRowId || null,
      ButtonPayload: req.body?.ButtonPayload || null
    });

    // ✅ If there's no text and no media, do nothing (avoid burning cycles)
    if (!text && numMedia === 0) return ok(res);


    
// ------------------------------------------------------------
// ✅ HARD TIME COMMANDS: bypass nudge + PA + pending-flow routers
// ------------------------------------------------------------
let isHardTimeCommand = looksHardTimeCommand(lc);
console.info('[ROUTER_HARD_TIME]', { lcN: lc.slice(0, 50), isHardTimeCommand });

    // ✅ Compute messageSid EARLY so resume can use it safely
    const rawSid = String(req.body?.MessageSid || req.body?.SmsMessageSid || '').trim();
    const messageSid =
      rawSid ||
      crypto
        .createHash('sha256')
        .update(`${req.from || ''}|${text}`)
        .digest('hex')
        .slice(0, 32);


      
    // -----------------------------------------------------------------------
    // ✅ LINK CODE REDEEM (must run EARLY so it doesn't fall into agent)
    // Accepts: "LINK 123456" (legacy) OR "123456"
    // IMPORTANT: uses resolvedInbound (button/list-aware) AND canonical phone (+E164)
    // -----------------------------------------------------------------------
    {
      const linkCode = parseLinkCommand(text);

      if (linkCode) {
        try {
          const phone = String(req.from || '').trim(); // ✅ already +E164 from middleware above
          if (!phone) {
            console.warn('[LINK] missing/invalid From:', req.body?.From);
            return ok(res, 'Missing sender phone. Try again.');
          }

          const out = await redeemLinkCodeToTenant({ code: linkCode, fromPhone: phone });

          if (!out?.ok) {
            return ok(
              res,
              `❌ Link failed: ${out?.error || 'Unknown error'}\n\nGo back to the portal, generate a fresh code, then text the 6 digits.`
            );
          }

          // Optional: clear any stale pending state after linking
          try {
            await clearAllPendingForUser({ ownerId: req.ownerId, from: (req.actorKey || req.from) });
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
// "resume" => re-send the pending confirm card if we have a confirm pending-action
// MUST run early (before nudge / PA router / job picker / fast paths / agent)
// -----------------------------------------------------------------------
if (lc === 'resume' || lc === 'show' || lc === 'show pending') {
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

    // ✅ Tiny debug log (keep for ~1 week then remove)
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
        req.from, // ✅ reply identity (E.164)
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
        req.from, // ✅ reply identity (E.164)
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
  /* -----------------------------------------------------------------------
 * ✅ GLOBAL HARD CANCEL (router-level)
 * - Runs BEFORE handlers
 * - Clears pending actions/state
 * - Cancels pending CIL drafts (expense + revenue)
 * ----------------------------------------------------------------------- */
if (/^(cancel|stop|no)\b/.test(lc)) {
  // 1) Clear all pending actions/state (existing behavior)
  await clearAllPendingForUser({ ownerId: req.ownerId, from: (req.actorKey || req.from) }).catch(() => null);

  // 2) Cancel ALL draft rows for this actor (definitive)
try {
  const actorDigits = String(req.actorKey || '').trim() || String(req.from || '').replace(/\D/g, '');

  const kinds = ['expense', 'revenue'];
  const out = [];

  for (const kind of kinds) {
    const r = await pg.cancelAllCilDraftsForActor({
      owner_id: req.ownerId,
      actor_phone: actorDigits,
      kind,
      status: 'cancelled'
    });

    out.push({
      kind,
      cancelled: r?.cancelled ?? null,
      cancelled_ids: (r?.rows || []).slice(0, 10).map((x) => x.id)
    });
  }

  console.info('[GLOBAL_CANCEL_CIL_ALL]', {
    ownerId: req.ownerId,
    actorDigits,
    results: out
  });
} catch (e) {
  console.warn('[GLOBAL_CANCEL_CIL_ALL] failed (ignored):', e?.message);
}
  return ok(res, '❌ Cancelled. You’re cleared.');
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

const mostRecentIsExpensePA =
  mostRecentPAKind === 'confirm_expense' || mostRecentPAKind === 'pick_job_for_expense';
const mostRecentIsRevenuePA =
  mostRecentPAKind === 'confirm_revenue' || mostRecentPAKind === 'pick_job_for_revenue';

// ✅ Keep your Option A helper (but don’t trust it as sole source of truth)
const expensePA = await hasExpensePA(req.ownerId, rawFrom);
const hasExpensePendingActions = !!expensePA?.hasAny || mostRecentIsExpensePA;

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

    /* -----------------------------------------------------------------------
 * Media follow-up: if prior step set pendingMedia and this is text-only
 * ----------------------------------------------------------------------- */
const hasPendingMedia = !!pending?.pendingMedia || !!pending?.pendingMediaMeta;

if (hasPendingMedia && numMedia === 0) {
  try {
    const { handleMedia } = require('../handlers/media');

    // Use the current canonical text we already computed earlier in the request
    const priorText = String(req.body?.ResolvedInboundText || text || '').trim();

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
      if (result.twiml) return sendTwiml(res, result.twiml);

      if (result.transcript && !result.twiml) {
        let t = String(result.transcript || '').trim();
        try { if (typeof stripLeadingFiller === 'function') t = stripLeadingFiller(t); } catch {}
        try { if (typeof normalizeTranscriptMoney === 'function') t = normalizeTranscriptMoney(t); } catch {}

        // Put transcript into the inbound body
        req.body.Body = t;

        // ✅ Recompute canonical text ONCE and store it (so everything downstream uses the same thing)
        const newResolved = String(resolveInboundTextFromTwilio(req.body || {}) || '').trim();
req.body.ResolvedInboundText = newResolved;
text = newResolved;
lc = text.toLowerCase();


        console.info('[WEBHOOK_MEDIA_TO_ROUTER_HEAD]', { head: String(t || '').slice(0, 12) });
      }
    } else if (typeof result === 'string' && result) {
      return sendTwiml(res, result);
    }

    // If handleMedia didn't produce a transcript, keep whatever canonical text we already had
    text = String(req.body.ResolvedInboundText || text || '').trim();
    lc = text.toLowerCase();

    isHardTimeCommand = looksHardTimeCommand(lc);
    console.info('[ROUTER_HARD_TIME_POST_MEDIA]', { lcN: lc.slice(0, 50), isHardTimeCommand });

    pending = await getPendingTransactionState(req.actorKey || req.from);
  } catch (e) {
    console.warn('[WEBHOOK] pending media follow-up failed (ignored):', e?.message);
  }
}

// ✅ From here on, reuse the canonical `text`
const text2 = text;
const lc2 = text2.toLowerCase();
const isPickerToken = looksLikeJobPickerReplyToken(text2);
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
            if (first && typeof first === 'object' && first.twiml) return sendTwiml(res, first.twiml);
            if (typeof first === 'string' && first) return sendTwiml(res, first);
            return ok(res);
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
          if (tw && typeof tw === 'object' && tw.twiml) return sendTwiml(res, tw.twiml);
          if (typeof tw === 'string' && tw) return sendTwiml(res, tw);
          if (first && typeof first === 'object' && first.twiml) return sendTwiml(res, first.twiml);
          if (typeof first === 'string' && first) return sendTwiml(res, first);
          return ok(res);
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
if (looksRevenue) {
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
if (looksExpense) {
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
      /\b(?:job|jobs)\b/.test(lc2) ||
      isJobPickerIntent(lc2) ||
      /\bactive job\??\b/.test(lc2) ||
      /\bwhat'?s\s+my\s+active\s+job\??\b/.test(lc2) ||
      /\bset\s+active\b/.test(lc2) ||
      /\b(list|create|start|activate|pause|resume|finish)\s+job\b/.test(lc2) ||
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

    const looksKpi = /^kpis?\s+for\b/.test(lc2);
    const KPI_ENABLED = (process.env.FEATURE_FINANCE_KPIS || '1') === '1';
    const hasSub = canUseAgent(req.userProfile);

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

    if (canUseAgent(req.userProfile)) {
      try {
        const { ask } = require('../services/agent');
        if (typeof ask === 'function') {
          const answer = await Promise.race([
            ask({ from: req.from, text: text2, topicHints }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))
          ]).catch(() => '');

          if (answer?.trim()) {
            let msg = answer.trim();
            msg += await glossaryNudgeFrom(text2);
            return ok(res, msg);
          }
        }
      } catch (e) {
        console.warn('[AGENT] failed:', e?.message);
      }
    }

    let msg =
      'PocketCFO — What I can do:\n' +
      '• Jobs: create job Roof Repair, change job, active job Roof Repair\n' +
      '• Tasks: task - buy nails, my tasks, done #4\n' +
      '• Time: clock in, clock out, timesheet week';

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
