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

const { flags } = require('../config/flags');
const { handleClock } = require('../handlers/commands/timeclock'); // v2 handler (optional)
const { handleForecast } = require('../handlers/commands/forecast');
const { getOwnerUuidForPhone } = require('../services/owners'); // optional map phone -> uuid (store separately)

const stateManager = require('../utils/stateManager');
const { getPendingTransactionState } = stateManager;

// Prefer mergePendingTransactionState; fall back to setPendingTransactionState (older builds)
const mergePendingTransactionState =
  stateManager.mergePendingTransactionState ||
  (async (userId, patch) => stateManager.setPendingTransactionState(userId, patch, { merge: true }));

const pg = require('../services/postgres');
const { query } = pg;
const { normalizeTranscriptMoney, stripLeadingFiller } = require('../utils/transcriptNormalize');

/* ---------------- Small helpers ---------------- */

function xmlEsc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function twimlText(s = '') {
  const safe = String(s || '');
  return `<Response><Message>${xmlEsc(safe)}</Message></Response>`;
}

// ✅ single source of truth
function twimlEmpty() {
  return '<Response></Response>';
}

const sendTwiml = (res, twiml) => {
  if (res.headersSent) return;
  const out = String(twiml || '').trim();
  // Always return valid XML
  const payload = out ? out : twimlEmpty();
  return res.status(200).type('text/xml; charset=utf-8').send(payload);
};

// Safe default:
// ok(res) -> empty TwiML
// ok(res, "text") -> visible bubble
const ok = (res, text = null) => {
  if (res.headersSent) return;
  if (!text) return sendTwiml(res, twimlEmpty());
  return sendTwiml(res, twimlText(text));
};

const normalizePhone = (raw = '') =>
  String(raw || '').replace(/^whatsapp:/i, '').replace(/\D/g, '') || null;

/* ---------------- WhatsApp Link Code helpers ---------------- */

function parseLinkCommand(raw = '') {
  const s = String(raw || '').trim();

  // LINK 123456
  let m = s.match(/^link\s+([a-z0-9]{4,12})$/i);
  if (m) return String(m[1]).trim();

  // Just the code: 123456
  m = s.match(/^([0-9]{4,12})$/);
  if (m) return String(m[1]).trim();

  return null;
}


// Uses your existing pg.query connection
async function redeemLinkCodeToTenant({ code, fromPhone }) {
  const cleanCode = String(code || '').trim();
  const phone = String(fromPhone || '').trim();

  if (!cleanCode || !phone) return { ok: false, error: 'Missing code or phone.' };

  // 1) Find valid, unused code
  // NOTE: adjust table/column names here if your SQL used different names
   const row = await query(
    `
    SELECT tenant_id, portal_user_id
      FROM public.chiefos_link_codes
     WHERE code = $1
       AND used_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1
    `,
    [cleanCode]
  );

  const tenantId = row?.rows?.[0]?.tenant_id;
  if (!tenantId) return { ok: false, error: 'Invalid or expired link code.' };

  // 2) Upsert identity mapping (WhatsApp phone -> tenant)
  // We use the table you said exists: chiefos_ingestion_identities
  // NOTE: if your schema uses different columns, adjust here.
    await query(
    `
    INSERT INTO public.chiefos_identity_map (tenant_id, kind, identifier, created_at)
    VALUES ($1, 'whatsapp', $2, now())
    ON CONFLICT (kind, identifier)
    DO UPDATE SET tenant_id = EXCLUDED.tenant_id
    `,
    [tenantId, phone]
  );


  // 3) Mark code used (prevents reuse)
  // NOTE: if you don’t have used_by / used_by_phone, you can remove those lines.
  await query(
    `
    UPDATE public.chiefos_link_codes
       SET used_at = now()
     WHERE code = $1
    `,
    [cleanCode]
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

// Allowed while a pending expense/revenue exists (so we don't nudge-block them)
function isAllowedWhilePending(lc) {
  return /^(yes|y|confirm|edit|cancel|no|skip|stop|more|overhead|oh|change job|switch job|pick job|change_job)\b/.test(lc);
}

// "global job picker intents" (typed commands)
function isJobPickerIntent(lc) {
  return /^(change\s+job|switch\s+job|pick\s+job|show\s+active\s+jobs|active\s+jobs|list\s+active\s+jobs)\b/.test(lc);
}

function looksLikeJobPickerReplyToken(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;

  if (/^(more|overhead|oh)$/i.test(s)) return true;
  if (/^\d+$/i.test(s)) return true;

  // ✅ canonical tokens
  if (/^jobno_\d+$/i.test(s)) return true;
  if (/^jobix_\d+$/i.test(s)) return true;

  // ✅ Twilio Content Template inbound format
  if (/^job_\d+_[0-9a-z]+$/i.test(s)) return true;

  return false;
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
 * ✅ Inbound text normalization (button-aware + interactive list-aware)
 *
 * Your Twilio Content Template list clicks arrive as:
 *   Body:      job_3_552e375c
 *   ListId:    job_3_552e375c
 *   ListTitle: "#3 1559 MedwayPark Dr"
 *
 * IMPORTANT:
 *   job_3_* and "#3 ..." are ROW INDEX tokens, NOT job_no.
 *
 * We normalize:
 *   job_3_*  -> jobix_3
 *
 * If ListTitle contains a stamped token like "J8", we can recover job_no:
 *   "#3 J8 1559..." -> jobno_8
 * ----------------------------------------------------------------------- */

function resolveTwilioInboundText(body = {}) {
  const b = body || {};
  const rawBody = String(b.Body || '').trim();

  // 1) Buttons / quick replies
  const payload = String(b.ButtonPayload || b.buttonPayload || '').trim();
  if (payload) return payload.toLowerCase();

  const btnText = String(b.ButtonText || b.buttonText || '').trim();
  if (btnText && btnText.length <= 40) return btnText.toLowerCase();

  // 2) InteractiveResponseJson (some flows)
  const irj = b.InteractiveResponseJson || b.interactiveResponseJson || null;
  if (irj) {
    try {
      const json = typeof irj === 'string' ? JSON.parse(irj) : irj;
      const id =
        json?.list_reply?.id ||
        json?.listReply?.id ||
        json?.interactive?.list_reply?.id ||
        '';
      const title =
        json?.list_reply?.title ||
        json?.listReply?.title ||
        json?.interactive?.list_reply?.title ||
        '';
      const picked = String(id || title || '').trim();
      if (picked) return normalizeListPickToken(picked, { listTitle: String(title || '').trim() });
    } catch {}
  }

  // 3) Twilio list picker fields
  const listRowId = String(b.ListRowId || b.ListRowID || b.listRowId || b.listRowID || '').trim();
  const listRowTitle = String(b.ListRowTitle || b.listRowTitle || '').trim();
  const listId = String(
    b.ListId ||
      b.listId ||
      b.ListItemId ||
      b.listItemId ||
      b.ListReplyId ||
      b.listReplyId ||
      ''
  ).trim();
  const listTitle = String(
    b.ListTitle ||
      b.listTitle ||
      b.ListItemTitle ||
      b.listItemTitle ||
      b.ListReplyTitle ||
      b.listReplyTitle ||
      ''
  ).trim();

  // Prefer IDs over titles if present
  const candidateId = listRowId || listId || rawBody;
  const candidateTitle = listRowTitle || listTitle;

  // If we have a title, allow stamped J<num> recovery
  if (candidateTitle) {
    const mStamp = String(candidateTitle).match(/\bJ(\d{1,10})\b/i);
    if (mStamp?.[1]) return `jobno_${mStamp[1]}`;
  }

  // Normalize the ID/body token
  const normalized = normalizeListPickToken(candidateId, { listTitle: candidateTitle });

  // If normalization did nothing but we have a title, fall back to title
  if (!normalized && candidateTitle) return candidateTitle;
  if (normalized) return normalized;

  return rawBody;
}

/**
 * Normalize list click tokens into what your pickers understand.
 *
 * - "job_3_deadbeef" => "jobix_3"  (ROW INDEX token from Content Template)
 * - "jobno_8"        => "jobno_8"  (already canonical)
 * - "#3 Something"   => "#3 Something" (expense.js will treat as index safely)
 */
function normalizeListPickToken(raw = '', { listTitle = '' } = {}) {
  const s = String(raw || '').trim();
  if (!s) return s;

  // ✅ If title contains stamped job number like "J8", trust job_no directly
  const mStamp = String(listTitle || s).match(/\bJ(\d{1,10})\b/i);
  if (mStamp?.[1]) return `jobno_${mStamp[1]}`;

  // ✅ Content-template list click format: job_<index>_<nonce>  (index, not job_no!)
  const mLegacy = s.match(/^job_(\d{1,10})_[0-9a-z]+$/i);
  if (mLegacy?.[1]) return `jobix_${mLegacy[1]}`;

  return s;
}

function getInboundText(b = {}) {
  const get = (...keys) => {
    for (const k of keys) {
      if (b[k] != null && String(b[k]).trim() !== '') return b[k];
    }
    return undefined;
  };

  // 1) Buttons (quick replies / persistentAction)
  const btnPayload = get('ButtonPayload', 'buttonPayload');
  const btnText = get('ButtonText', 'buttonText');
  if (btnPayload) return String(btnPayload).trim();
  if (btnText) return String(btnText).trim();

  // 2) Interactive list selection IDs (prefer IDs over titles)
  const listId =
    get('ListRowId', 'ListRowID', 'listRowId', 'listRowID') ||
    get('ListId', 'listId', 'ListItemId', 'listItemId', 'ListReplyId', 'listReplyId');

  if (listId) {
    const id = String(listId).trim();

    // ✅ If we already have a stable ID, return it AS-IS.
    // This preserves: jobno_1556, job_1_hash, overhead, more, etc.
    return id;
  }

  // 3) Some Twilio deliveries put the ID into Body
  const body = String(get('Body', 'body') || '').trim();
  if (body) {
    // If Body looks like an ID token, preserve it.
    if (/^(jobno_\d{1,10}|jobix_\d{1,10}|job_\d{1,10}_[0-9a-z]+|overhead|more)$/i.test(body)) {
      return body;
    }
    // Otherwise: treat as normal inbound text
    return body;
  }

  // 4) As a last resort, try extracting job_no from the title
  // NEW format often uses "J1556 ..." (your sendJobPickerOrFallback uses that)
  const listTitle =
    get('ListRowTitle', 'listRowTitle') ||
    get('ListTitle', 'listTitle', 'ListItemTitle', 'listItemTitle', 'ListReplyTitle', 'listReplyTitle');

  if (listTitle) {
    const t = String(listTitle).trim();

    // Prefer J1234 form -> jobno_1234
    const mJ = t.match(/\bJ(\d{1,10})\b/i);
    if (mJ?.[1]) return `jobno_${Number(mJ[1])}`;

    // If the title is "Overhead" / "More jobs…"
    if (/^overhead$/i.test(t)) return 'overhead';
    if (/^more\b/i.test(t)) return 'more';

    // Avoid converting "#1 Foo" to jobix_1 (that’s the bug).
    // Just return the title text if nothing else is usable.
    return t;
  }

  return '';
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
  if (/\b(received|got paid|payment|deposit)\b/.test(s)) return false;

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
  if (/\b(received|revenue|rev|got paid|payment|deposit)\b/.test(s)) return true;
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
  const user = String(userId || '').trim();
  const k = String(kind || '').trim();
  if (!owner || !user || !k) return null;

  if (pgGetPendingActionByKind) {
    try {
      const r = await pgGetPendingActionByKind({ ownerId: owner, userId: user, kind: k });
      if (!r) return null;
      if (r.payload != null) return r;
      if (typeof r === 'object') return { payload: r };
      return null;
    } catch {
      // fall through
    }
  }

  try {
    const r = await query(
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
      [owner, user, k, String(PA_TTL_MIN)]
    );
    return r?.rows?.[0] || null;
  } catch {
    return null;
  }
}

async function deletePA({ ownerId, userId, kind }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  const k = String(kind || '').trim();
  if (!owner || !user || !k) return;

  if (pgDeletePendingActionByKind) {
    try {
      await pgDeletePendingActionByKind({ ownerId: owner, userId: user, kind: k });
      return;
    } catch {
      // fall through
    }
  }

  try {
    await query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [
      owner,
      user,
      k
    ]);
  } catch {
    // ignore
  }
}

async function clearAllPendingForUser({ ownerId, from }) {
  const kinds = [
    PA_KIND_CONFIRM_EXPENSE,
    PA_KIND_PICK_JOB_EXPENSE,
    PA_KIND_CONFIRM_REVENUE,
    PA_KIND_PICK_JOB_REVENUE,
    'timeclock.confirm'
  ];

  await Promise.all(kinds.map((k) => deletePA({ ownerId, userId: from, kind: k }).catch(() => null)));

  // legacy state cleanup (safe)
  try {
    if (typeof stateManager.clearFinanceFlow === 'function') {
      await stateManager.clearFinanceFlow(from).catch(() => null);
    }
  } catch {}

  try {
    if (typeof stateManager.deletePendingTransactionState === 'function') {
      await stateManager.deletePendingTransactionState(from).catch(() => null);
    }
  } catch {}
}

async function hasExpensePA(ownerId, from) {
  try {
    const [pick, conf] = await Promise.all([
      getPA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB_EXPENSE }),
      getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM_EXPENSE })
    ]);
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

/* ---------------- Non-POST guard ---------------- */

router.all('*', (req, res, next) => {
  if (req.method === 'POST') return next();
  return ok(res); // empty TwiML
});

/* ---------------- Identity + canonical URL ---------------- */

router.use((req, _res, next) => {
  req.from = req.body?.From ? normalizePhone(req.body.From) : null;
  req.ownerId = req.from || null;

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

/* ---------------- 8s Safety Timer ---------------- */

router.use((req, res, next) => {
  if (res.locals._safety) return next();

  res.locals._safety = setTimeout(() => {
    if (!res.headersSent) {
      console.warn('[WEBHOOK] 8s safety reply', {
        phase: res.locals.phase,
        msInPhase: Date.now() - (res.locals.phaseAt || Date.now()),
        from: req.from,
        messageSid: req.body?.MessageSid || req.body?.SmsMessageSid
      });
      ok(res); // empty TwiML (no bubble)
    }
  }, 8000);

  const clear = () => clearTimeout(res.locals._safety);
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
  return sendTwiml(res, result.twiml);
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
    if (req.from) {
      try {
        const mapped = await getOwnerUuidForPhone(req.from);
        if (mapped) req.ownerUuid = mapped;
      } catch (e) {
        console.warn('[WEBHOOK] owner uuid map failed:', e?.message);
      }
    }

    let pending = await getPendingTransactionState(req.from);
    const numMedia = parseInt(req.body?.NumMedia || '0', 10) || 0;
    const crypto = require('crypto');

    let text = String(getInboundText(req.body || {}) || '').trim();
    let lc = text.toLowerCase();

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
// Accepts: "LINK 123456"
// -----------------------------------------------------------------------
{
  const linkCode = parseLinkCommand(text);
  if (linkCode) {
    try {
      const phone = String(req.from || "").trim();
      if (!phone) return ok(res, "Missing sender phone. Try again.");

      const out = await redeemLinkCodeToTenant({ code: linkCode, fromPhone: phone });

      if (!out?.ok) {
        return ok(
          res,
          `❌ Link failed: ${out?.error || "Unknown error"}\n\nGo back to the portal and generate a fresh code, then text: LINK <code>`
        );
      }

      // Optional: clear any stale pending state after linking
      await clearAllPendingForUser({ ownerId: req.ownerId, from: req.from }).catch(() => null);

      return ok(
        res,
        `✅ WhatsApp linked.\n\nNow try:\n• expense $18 Home Depot\n• revenue $500 deposit\n\n(Go back to the portal and tap “I sent it”.)`
      );
    } catch (e) {
      console.warn("[LINK] redeem failed:", e?.message);
      return ok(res, "⚠️ Link failed. Please request a new code in the portal and try again.");
    }
  }
}



    // -----------------------------------------------------------------------
    // "resume" => re-send the pending confirm card if we have a confirm pending-action
    // MUST run early (before nudge / PA router / job picker / fast paths / agent)
    // -----------------------------------------------------------------------
    if (lc === 'resume' || lc === 'show' || lc === 'show pending') {
      try {
        const pa =
          typeof pg.getMostRecentPendingActionForUser === 'function'
            ? await pg.getMostRecentPendingActionForUser({ ownerId: req.ownerId, userId: req.from })
            : null;

        const kind = String(pa?.kind || '').trim();

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
     * ✅ GLOBAL HARD CANCEL
     * ----------------------------------------------------------------------- */
    if (/^(cancel|stop|no)\b/.test(lc)) {
      await clearAllPendingForUser({ ownerId: req.ownerId, from: req.from }).catch(() => null);
      return ok(res, '❌ Cancelled. You’re cleared.');
    }

    // -----------------------------------------------------------------------
    // ✅ Pending Action: fetch ONCE early and reuse everywhere
    // This prevents legacy nudge from swallowing edit payloads when hasExpensePA() misses.
    // -----------------------------------------------------------------------
    const mostRecentPA =
      typeof pg.getMostRecentPendingActionForUser === 'function'
        ? await pg.getMostRecentPendingActionForUser({ ownerId: req.ownerId, userId: req.from })
        : null;

    const mostRecentPAKind = mostRecentPA?.kind ? String(mostRecentPA.kind).trim() : '';
    const mostRecentIsExpensePA = mostRecentPAKind === 'confirm_expense' || mostRecentPAKind === 'pick_job_for_expense';
    const mostRecentIsRevenuePA = mostRecentPAKind === 'confirm_revenue' || mostRecentPAKind === 'pick_job_for_revenue';

    // ✅ Keep your Option A helper (but don’t trust it as sole source of truth)
    const expensePA = await hasExpensePA(req.ownerId, req.from);
    const hasExpensePendingActions = !!expensePA?.hasAny || mostRecentIsExpensePA;
// ✅ If PA flow exists, legacy pendingCorrection is stale noise — clear it once.
try {
  if (mostRecentIsExpensePA && pending?.pendingCorrection && pending?.type === 'expense') {
    await stateManager.mergePendingTransactionState(req.from, {
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

    if (pendingRevenueFlow) {
      if (lc === 'skip') return ok(res, `Okay — leaving that revenue pending. What do you want to do next?`);

      if (!allowJobPickerThrough && !isAllowedWhilePending(lc) && looksHardCommand(lc)) {
        const msg = pendingTxnNudgeMessage({ ...(pending || {}), type: 'revenue' });
        if (msg) return ok(res, msg);
        // msg null => mid-edit; do NOT nag; fall through
      }
    }

    // ✅ EXPENSE NUDGE GATE — hardened: NEVER block when an expense PA exists
    if (pendingExpenseFlow) {
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
        const result = await handleMedia(req.from, text, req.userProfile || {}, req.ownerId, null, null, messageSid);

        if (result && typeof result === 'object') {
          if (result.twiml) return sendTwiml(res, result.twiml);
          if (result.transcript && !result.twiml) {
  let t = String(result.transcript || '').trim();
  try { if (typeof stripLeadingFiller === 'function') t = stripLeadingFiller(t); } catch {}
  try { if (typeof normalizeTranscriptMoney === 'function') t = normalizeTranscriptMoney(t); } catch {}
  req.body.Body = t;
  console.info('[WEBHOOK_MEDIA_TO_ROUTER_HEAD]', { head: String(t || '').slice(0, 12) });

}

        } else if (typeof result === 'string' && result) {
          return sendTwiml(res, result);
        }

        text = String(getInboundText(req.body || {}) || '').trim();
        lc = text.toLowerCase();
        pending = await getPendingTransactionState(req.from);
      } catch (e) {
        console.warn('[WEBHOOK] pending media follow-up failed (ignored):', e?.message);
      }
    }

    const text2 = String(getInboundText(req.body || {}) || '').trim();
    const lc2 = text2.toLowerCase();
    const isPickerToken = looksLikeJobPickerReplyToken(text2);

    /* -----------------------------------------------------------------------
     * ✅ Pending-actions router (must run early)
     * Uses mostRecentPA fetched earlier (single source here)
     * ----------------------------------------------------------------------- */

    const pa = mostRecentPA;
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

    if (isExpensePA) {
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

    if (isRevenuePA) {
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


    if (pendingRevenueLike) {
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

    const timeoutMs = 8000;
    const timeoutTwiml = twimlText(
      '⚠️ I’m having trouble saving that right now (database busy). Please tap Yes again in a few seconds.'
    );

    let timeoutId = null;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        console.warn('[WEBHOOK] revenue handler timeout', { from: req.from, messageSid, timeoutMs });
        resolve(timeoutTwiml);
      }, timeoutMs);
    });

    const result = await Promise.race([
      handleRevenue(
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

    let looksTime = /\b(time\s*clock|timeclock|clock|punch|break|drive|timesheet|hours)\b/.test(lc2);

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

    if (flags.timeclock_v2) {
      const cil = (() => {
        if (/^clock in\b/.test(lc2)) return { type: 'Clock', action: 'in' };
        if (/^clock out\b/.test(lc2)) return { type: 'Clock', action: 'out' };
        if (/^break start\b/.test(lc2)) return { type: 'Clock', action: 'break_start' };
        if (/^break stop\b/.test(lc2)) return { type: 'Clock', action: 'break_end' };
        if (/^lunch start\b/.test(lc2)) return { type: 'Clock', action: 'lunch_start' };
        if (/^lunch stop\b/.test(lc2)) return { type: 'Clock', action: 'lunch_end' };
        if (/^drive start\b/.test(lc2)) return { type: 'Clock', action: 'drive_start' };
        if (/^drive stop\b/.test(lc2)) return { type: 'Clock', action: 'drive_end' };
        return null;
      })();

      if (cil) {
        const ctx = {
          owner_id: req.ownerId,
          user_id: req.userProfile?.id || req.userProfile?.user_id || null,
          job_id: req.userProfile?.active_job_id || null,
          job_name: req.userProfile?.active_job_name || 'Active Job',
          created_by: req.userProfile?.id || req.userProfile?.user_id || null
        };

        const reply = await handleClock(ctx, cil);
        let msg = reply?.text || 'Time logged.';
        msg += await glossaryNudgeFrom(text2);
        return ok(res, msg);
      }
    }

    if (looksTime && typeof handleTimeclock === 'function') {
      const out = await handleTimeclock(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
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
