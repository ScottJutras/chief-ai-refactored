// handlers/commands/revenue.js
// COMPLETE DROP-IN (BETA-ready; aligned to expense.js identity + picker-state safety)
//
// ✅ Key alignments in this drop-in:
// - ✅ Canonical PA identity: uses paUserId (digits/WaId) for ALL getPA/upsertPA/deletePA (never "from").
// - ✅ Picker state stores: sentRows + jobOptions + confirmDraft snapshot (so picker taps can recover confirm).
// - ✅ Picker tap resolver uses Twilio ListTitle name-match FIRST (fixes "#6 happy street" mapping bugs),
//   then falls back to ix mapping, then stable jobno_ tokens.
// - ✅ Confirm flow supports: yes / edit / cancel / resume / skip / change_job
// - ✅ Auto-yes flag is ONLY set after a successful edit payload is applied (never during DB ops).
//
// Signature expected by router:
//   handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId, twilioMeta)

const pg = require('../../services/postgres');
const state = require('../../utils/stateManager');

const ai = require('../../utils/aiErrorHandler');
const handleInputWithAI = ai.handleInputWithAI;
const parseRevenueMessage = ai.parseRevenueMessage;
const {
  sendWhatsAppInteractiveList,
  sendWhatsAppTemplate,
  toTemplateVar
} = require('../../services/twilio');


const { normalizeJobNameCandidate } = require('../../utils/jobNameUtils');
const { PRO_CREW_UPGRADE_LINE, UPGRADE_FOLLOWUP_ASK } = require('../../src/config/upgradeCopy');
const { getEffectivePlanFromOwner } = require("../../src/config/effectivePlan");



// ---- CIL validator (fail-open) ----
const cilMod = require('../../cil');
const validateCIL =
  (cilMod && typeof cilMod.validateCIL === 'function' && cilMod.validateCIL) ||
  (cilMod && typeof cilMod.validateCil === 'function' && cilMod.validateCil) ||
  (cilMod && typeof cilMod.validate === 'function' && cilMod.validate) ||
  (typeof cilMod === 'function' && cilMod) ||
  null;

// ---- Optional category helper (fail-open) ----
const categorizeEntry =
  (typeof ai.categorizeEntry === 'function' && ai.categorizeEntry) || (async () => null);

/* ---------------- Pending state helpers (stateManager) ---------------- */

const getPendingTransactionState =
  state.getPendingTransactionState || state.getPendingState || (async () => null);

const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

/* ---------------- Constants ---------------- */

const PA_KIND_CONFIRM = 'confirm_revenue';
const PA_KIND_PICK_JOB = 'pick_job_for_revenue';

const PA_TTL_MIN = Number(process.env.PENDING_TTL_MIN || 10);
const PA_TTL_SEC = PA_TTL_MIN * 60;

// New (override per-kind)
const PA_TTL_CONFIRM_MIN = Number(process.env.PENDING_CONFIRM_TTL_MIN || 30);
const PA_TTL_CONFIRM_SEC = PA_TTL_CONFIRM_MIN * 60;

const PA_TTL_PICK_MIN = Number(process.env.PENDING_PICK_TTL_MIN || 15);
const PA_TTL_PICK_SEC = PA_TTL_PICK_MIN * 60;

const ENABLE_INTERACTIVE_LIST = (() => {
  const raw = process.env.TWILIO_ENABLE_INTERACTIVE_LIST ?? process.env.TWILIO_ENABLE_LIST_PICKER ?? 'true';
  return String(raw).trim().toLowerCase() !== 'false';
})();

const DIGITS = (x) =>
  String(x ?? '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\D/g, '');

const looksLikeUuid = (str) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str || '').trim());

function normalizeIdentityDigits(x) {
  return DIGITS(x);
}

/* ---------------- Pending Actions (KIND-AWARE w/ SQL fallback) ---------------- */

const { query } = pg;

const pgGetPendingActionByKind =
  (typeof pg.getPendingActionByKind === 'function' && pg.getPendingActionByKind) || null;

const pgUpsertPendingActionByKind =
  (typeof pg.upsertPendingActionByKind === 'function' && pg.upsertPendingActionByKind) ||
  (typeof pg.upsertPendingAction === 'function' && pg.upsertPendingAction) ||
  (typeof pg.savePendingAction === 'function' && pg.savePendingAction) ||
  null;

const pgDeletePendingActionByKind =
  (typeof pg.deletePendingActionByKind === 'function' && pg.deletePendingActionByKind) || null;

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

  if (typeof query !== 'function') return null;

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
      [String(owner), String(user), String(k), String(PA_TTL_MIN)]
    );
    return r?.rows?.[0] || null;
  } catch {
    return null;
  }
}

async function upsertPA({ ownerId, userId, kind, payload, ttlSeconds = PA_TTL_SEC }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  const k = String(kind || '').trim();
  if (!owner || !user || !k) return;

  const ttl = Number(ttlSeconds || PA_TTL_PICK_SEC) || PA_TTL_PICK_SEC;

  if (pgUpsertPendingActionByKind) {
    try {
      await pgUpsertPendingActionByKind({ ownerId: owner, userId: user, kind: k, payload, ttlSeconds: ttl });
      return;
    } catch (e) {
      console.warn('[PA] upsertPendingActionByKind failed; falling back:', e?.message);
    }
  }

  if (typeof query !== 'function') return;

  try {
    await query(
      `
      INSERT INTO public.pending_actions (owner_id, user_id, kind, payload, created_at)
      VALUES ($1, $2, $3, $4::jsonb, NOW())
      ON CONFLICT (owner_id, user_id, kind)
      DO UPDATE SET payload = EXCLUDED.payload,
                    created_at = NOW()
      `,
      [String(owner), String(user), String(k), JSON.stringify(payload || {})]
    );
  } catch (e) {
    // If no unique index exists, fall back to delete+insert
    try {
      await query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [
        String(owner),
        String(user),
        String(k)
      ]);
      await query(
        `
        INSERT INTO public.pending_actions (owner_id, user_id, kind, payload, created_at)
        VALUES ($1, $2, $3, $4::jsonb, NOW())
        `,
        [String(owner), String(user), String(k), JSON.stringify(payload || {})]
      );
    } catch {}
    console.warn('[PA] upsert fallback failed (ignored):', e?.message);
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
    } catch (e) {
      console.warn('[PA] deletePendingActionByKind failed; falling back:', e?.message);
    }
  }

  if (typeof query !== 'function') return;

  try {
    await query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [
      String(owner),
      String(user),
      String(k)
    ]);
  } catch {}
}

/* ---------------- TwiML helpers ---------------- */

function xmlEsc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlEmpty() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

function twimlText(msg) {
  const t = String(msg ?? '').trim();
  if (!t) return twimlEmpty(); // ✅ never emit empty <Message>
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEsc(t)}</Message></Response>`;
}


function out(twiml, sentOutOfBand = false) {
  return { twiml, sentOutOfBand: !!sentOutOfBand };
}

function waTo(from) {
  const d = normalizeIdentityDigits(from);
  return d ? `whatsapp:+${d}` : null;
}

/* ---------------- STRICT decision tokens (confirm flow) ---------------- */
// EXACT allow-list only: yes/edit/cancel/resume/skip/change_job
function strictDecisionToken(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return null;

  if (t === 'yes') return 'yes';
  if (t === 'edit') return 'edit';
  if (t === 'cancel') return 'cancel';
  if (t === 'resume') return 'resume';
  if (t === 'skip') return 'skip';
  if (t === 'change_job' || t === 'change job') return 'change_job';

  return null;
}

/**
 * ✅ Aligned: uses explicit paUserId (preferred), falls back to digits(from)
 */
async function resendConfirmRevenue({ from, ownerId, tz, paUserId } = {}) {
  const key = normalizeIdentityDigits(paUserId) || normalizeIdentityDigits(from) || String(from || '').trim();
  const confirmPA = await getPA({ ownerId, userId: key, kind: PA_KIND_CONFIRM });
  if (!confirmPA?.payload) return null;

  const draft = confirmPA.payload.draft || {};

  const summaryLine =
    confirmPA.payload.humanLine ||
    buildRevenueSummaryLine({
      amount: draft.amount,
      source: draft.source,
      date: draft.date,
      jobName: draft.jobName,
      tz
    }) ||
    'Confirm revenue?';

  // ✅ ONE PATH: template or fallback both receive the SAME text
  return sendConfirmRevenueTemplateOrFallback(from, summaryLine);
}

/* ---------------- Date / money helpers ---------------- */

const todayInTimeZone =
  (typeof pg.todayInTZ === 'function' && pg.todayInTZ) ||
  ((tz = 'America/Toronto') => {
    try {
      const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      const s = dtf.format(new Date());
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    } catch {}
    return new Date().toISOString().split('T')[0];
  });

function toCents(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function toNumberAmount(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return n;
}

function formatMoneyDisplay(n) {
  try {
    const fmt = new Intl.NumberFormat('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `$${fmt.format(n)}`;
  } catch {
    const num = Number(n);
    return Number.isFinite(num) ? `$${num.toFixed(2)}` : '$0.00';
  }
}


function formatDisplayDate(isoDate, tz = 'America/Toronto') {
  const s = String(isoDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || '';
  try {
    const d = new Date(`${s}T12:00:00Z`);
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  } catch {
    return s;
  }
}

function stripRevenuePrefixes(input) {
  let s = String(input || '').trim();
  s = s.replace(/^(edit\s+)?revenue\s*:\s*/i, '');
  s = s.replace(/^(edit\s+)?received\s*:\s*/i, '');
  s = s.replace(/^edit\s*:\s*/i, '');
  return s.trim();
}

// (Used for non-confirm flows / picker helpers; confirm uses strictDecisionToken)
function normalizeDecisionToken(input) {
  const s = String(input || '').trim().toLowerCase();

  if (s === 'yes' || s === 'y' || s === 'confirm' || s === '✅ yes' || s === '✅yes') return 'yes';
  if (s === 'edit') return 'edit';
  if (s === 'cancel' || s === 'stop' || s === 'no') return 'cancel';

  if (s === 'change job' || s === 'switch job') return 'change_job';
  if (/\bchange\s+job\b/.test(s) && s.length <= 40) return 'change_job';

  if (s === 'more' || s === 'more jobs' || s === 'more jobs…') return 'more';

  if (/\byes\b/.test(s) && s.length <= 20) return 'yes';
  if (/\bedit\b/.test(s) && s.length <= 20) return 'edit';
  if (/\bcancel\b/.test(s) && s.length <= 20) return 'cancel';

  return s;
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

function parseRelativeDateReply(input, tz) {
  const t = String(input || '').trim().toLowerCase();
  if (!t) return null;

  if (t === 'today' || t === 'td' || t === 'now' || t === 'just now') {
    return todayInTimeZone(tz);
  }

  if (t === 'yesterday') {
    // tz-safe enough for our use: compute "yesterday" from todayInTimeZone
    const today = todayInTimeZone(tz);
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  // accept ISO directly
  if (isIsoDate(t)) return t;

  return null;
}

function inferDateFromJust(originalText, tz) {
  const s = String(originalText || '').toLowerCase();
  const hasJust = /\bjust\b/.test(s);
  const looksLikeReceiptMoment =
    /\b(received|got|paid|deposit|e-?transfer|etransfer|interac|cheque|check)\b/.test(s);

  if (hasJust && looksLikeReceiptMoment) return todayInTimeZone(tz);
  return null;
}


function looksLikeOverhead(s) {
  const t = String(s || '').trim().toLowerCase();
  return t === 'overhead' || t === 'oh';
}

/* ---------------- Revenue normalization ---------------- */

function normalizeRevenueData(data, tz) {
  const d = { ...(data || {}) };

  if (d.amount != null) {
    const n = toNumberAmount(d.amount);
    if (Number.isFinite(n) && n > 0) d.amount = formatMoneyDisplay(n);
  }

  // ✅ Do NOT default date here.
// New-parse flow decides date explicitly (and may latch awaiting_date).
d.date = String(d.date || '').trim() || null;

  const desc = String(d.description || '').trim();
  d.description = desc || 'Revenue received';

  // ✅ Payer/source is OPTIONAL in MVP (job is the primary dimension).
// Keep it null/empty if not provided; only default to "Unknown" at DB insert time.
const src = String(d.source || '').trim();
d.source = src || null;

  if (d.jobName != null) {
  d.jobName = normalizeJobNameCandidate(d.jobName);
}


  if (d.suggestedCategory != null) {
    const c = String(d.suggestedCategory).trim();
    d.suggestedCategory = c || null;
  }

  if (d.jobSource != null) {
    const js = String(d.jobSource).trim();
    d.jobSource = js || null;
  }

  if (d.job_no != null && !Number.isFinite(Number(d.job_no))) d.job_no = null;

  return d;
}

async function withTimeout(promise, ms, fallbackValue = '__TIMEOUT__') {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))]);
}

/* ---------------- Active job resolution + persistence ---------------- */

function looksLikeJobTokenName(name) {
  const t = String(name || '').trim().toLowerCase();
  if (!t) return true;
  if (t === 'overhead' || t === 'oh') return false;
  if (/^jobix_\d+$/i.test(t)) return true;
  if (/^jobno_\d+$/i.test(t)) return true;
  if (/^job_\d+_[0-9a-z]+$/i.test(t)) return true;
  if (/^#\s*\d+\b/.test(t)) return true;
  return false;
}

function pickActiveJobNameFromAny(out) {
  const candidates = [
    out?.active_job_name,
    out?.activeJobName,
    out?.name,
    out?.job_name,
    out?.jobName,
    out?.job?.name,
    out?.job?.job_name
  ];

  for (const c of candidates) {
    const s = String(c || '').trim();
    if (!s) continue;
    if (looksLikeJobTokenName(s)) continue;
    if (/^overhead$/i.test(s)) return 'Overhead';
    return s;
  }
  return null;
}

async function resolveActiveJobName({ ownerId, userProfile, fromPhone }) {
  const directName = userProfile?.active_job_name || userProfile?.activeJobName || null;
  if (directName && !looksLikeJobTokenName(directName)) return String(directName).trim();

  const owner = normalizeIdentityDigits(ownerId);
  const identity =
    normalizeIdentityDigits(fromPhone) ||
    normalizeIdentityDigits(userProfile?.phone_e164) ||
    normalizeIdentityDigits(userProfile?.phone) ||
    normalizeIdentityDigits(userProfile?.from) ||
    normalizeIdentityDigits(userProfile?.user_id) ||
    normalizeIdentityDigits(userProfile?.id) ||
    normalizeIdentityDigits(userProfile?.userId) ||
    null;

  if (!owner || !identity) return null;

  if (typeof pg.getActiveJobForIdentity === 'function') {
    try {
      const out = await pg.getActiveJobForIdentity(owner, identity);
      return pickActiveJobNameFromAny(out);
    } catch {}
  }

  const fallbackFns = ['getActiveJobForPhone', 'getActiveJobForUser', 'getActiveJob', 'getUserActiveJob'];
  for (const fn of fallbackFns) {
    if (typeof pg[fn] !== 'function') continue;
    try {
      const out = await pg[fn](String(owner), String(identity));
      const nm = pickActiveJobNameFromAny(out);
      if (nm) return nm;
    } catch {}
  }

  return null;
}

async function persistActiveJobFromRevenue({ ownerId, fromPhone, userProfile, jobNo, jobName }) {
  try {
    const owner = normalizeIdentityDigits(ownerId);
    const identity =
      normalizeIdentityDigits(fromPhone) ||
      normalizeIdentityDigits(userProfile?.phone_e164) ||
      normalizeIdentityDigits(userProfile?.phone) ||
      normalizeIdentityDigits(userProfile?.from) ||
      normalizeIdentityDigits(userProfile?.user_id) ||
      normalizeIdentityDigits(userProfile?.id) ||
      normalizeIdentityDigits(userProfile?.userId) ||
      null;

    if (!owner || !identity) return false;

    const safeName = jobName && !looksLikeJobTokenName(jobName) ? String(jobName).trim() : null;
    const n = jobNo != null && Number.isFinite(Number(jobNo)) ? Number(jobNo) : null;

    if (safeName && /^overhead$/i.test(safeName)) return false;

    if (typeof pg.setActiveJobForIdentity === 'function') {
      await pg.setActiveJobForIdentity(owner, identity, n != null ? String(n) : null, safeName);
      return true;
    }

    if (typeof pg.setActiveJob === 'function') {
      const jobRef = safeName || (n != null ? String(n) : null);
      if (!jobRef) return false;
      await pg.setActiveJob(owner, identity, jobRef);
      return true;
    }

    return false;
  } catch (e) {
    console.warn('[REVENUE] persistActiveJobFromRevenue failed (ignored):', e?.message);
    return false;
  }
}

/* ---------------- CIL (fail-open) ---------------- */

function buildRevenueCIL({ from, data, jobName, category, sourceMsgId }) {
  const d = data && typeof data === 'object' ? data : {};

  const cents = toCents(d.amount);
  
  // Keep your “Revenue Logged” behavior, but make sure it's always populated
  const description =
    String(d.description || '').trim() && String(d.description).trim() !== 'Unknown'
      ? String(d.description).trim()
      : 'Revenue Logged';

  // ✅ KEY FIX: Source is OPTIONAL in UX but REQUIRED by schema → always provide one
  const source =
    String(d.source || '').trim() && String(d.source).trim() !== 'Unknown'
      ? String(d.source).trim()
      : 'Unknown';

  return {
    type: 'LogRevenue',
    job: jobName ? String(jobName) : undefined,
    description,
    amount_cents: cents,
    source, // ✅ never undefined now
    date: d.date ? String(d.date) : undefined,
    category: category ? String(category) : undefined,
    source_msg_id: sourceMsgId ? String(sourceMsgId) : undefined,
    actor_phone: from ? String(from) : undefined
  };
}

function assertRevenueCILOrClarify({ from, data, jobName, category, sourceMsgId }) {
  try {
    const d = data && typeof data === 'object' ? { ...data } : {};

    // -----------------------------
    // ✅ Minimum required fields (for CIL)
    // -----------------------------
    const amtOk = !!d.amount && String(d.amount).trim() && String(d.amount).trim() !== '$0.00';
    const dateOk = !!d.date && typeof isIsoDate === 'function' && isIsoDate(d.date);

    // Job can come from arg or data
    let j =
      (typeof normalizeJobNameCandidate === 'function' ? normalizeJobNameCandidate(jobName) : jobName) ||
      (typeof normalizeJobNameCandidate === 'function' ? normalizeJobNameCandidate(d.jobName) : d.jobName) ||
      null;

    // If "Overhead" is allowed, normalize it
    if (j && typeof looksLikeOverhead === 'function' && looksLikeOverhead(j)) {
      j = 'Overhead';
    }

    if (!amtOk) {
      return {
        ok: false,
        reply: `I’m missing the amount. Try: "revenue $4500 on Dec 2 2025 job 1556 Medway Park Dr".`
      };
    }

    if (!dateOk) {
      return {
        ok: false,
        reply: `I’m missing the date. Reply "today", "yesterday", or "2025-12-02".`
      };
    }

    if (!j) {
      return {
        ok: false,
        reply: `Which job is this for? Reply like: "job 1556 Medway Park Dr" or "Overhead".`
      };
    }

    // Ensure the jobName that CIL sees is the resolved one
    d.jobName = j;

    // -----------------------------
    // ✅ Source/payer OPTIONAL in UX
    // but CIL may require it → satisfy schema safely
    // -----------------------------
    if (!d.source || !String(d.source).trim()) d.source = 'Unknown';

    // Same for description
    if (!d.description || !String(d.description).trim()) d.description = 'Revenue received';

    // Category can be optional, but keep if provided
    if (category && !d.suggestedCategory) d.suggestedCategory = category;

    const cil = buildRevenueCIL({ from, data: d, jobName: j, category, sourceMsgId });

    if (typeof validateCIL !== 'function') return { ok: true, cil, skipped: true };
    
   function assertRevenueCILOrClarify({ from, data, jobName, category, sourceMsgId }) {
  try {
    const d = data && typeof data === 'object' ? { ...data } : {};

    // -----------------------------
    // ✅ Minimum required fields (for CIL)
    // -----------------------------
    const amtOk = !!d.amount && String(d.amount).trim() && String(d.amount).trim() !== '$0.00';
    const dateOk = !!d.date && typeof isIsoDate === 'function' && isIsoDate(d.date);

    // Job can come from arg or data
    let j =
      (typeof normalizeJobNameCandidate === 'function' ? normalizeJobNameCandidate(jobName) : jobName) ||
      (typeof normalizeJobNameCandidate === 'function' ? normalizeJobNameCandidate(d.jobName) : d.jobName) ||
      null;

    // If "Overhead" is allowed, normalize it
    if (j && typeof looksLikeOverhead === 'function' && looksLikeOverhead(j)) {
      j = 'Overhead';
    }

    if (!amtOk) {
      return {
        ok: false,
        reply: `I’m missing the amount. Try: "revenue $4500 on Dec 2 2025 job 1556 Medway Park Dr".`
      };
    }

    if (!dateOk) {
      return {
        ok: false,
        reply: `I’m missing the date. Reply "today", "yesterday", or "2025-12-02".`
      };
    }

    if (!j) {
      return {
        ok: false,
        reply: `Which job is this for? Reply like: "job 1556 Medway Park Dr" or "Overhead".`
      };
    }

    // Ensure the jobName that CIL sees is the resolved one
    d.jobName = j;

    // -----------------------------
    // ✅ Source/payer OPTIONAL in UX
    // but CIL may require it → satisfy schema safely
    // -----------------------------
    if (!d.source || !String(d.source).trim()) d.source = 'Unknown';

    // Same for description
    if (!d.description || !String(d.description).trim()) d.description = 'Revenue received';

    // Category can be optional, but keep if provided
    if (category && !d.suggestedCategory) d.suggestedCategory = category;

    const cil = buildRevenueCIL({ from, data: d, jobName: j, category, sourceMsgId });

    if (typeof validateCIL !== 'function') return { ok: true, cil, skipped: true };

    validateCIL(cil);
    return { ok: true, cil };
  } catch (e) {
    console.warn('[REVENUE] CIL validate failed', {
      message: e?.message,
      name: e?.name,
      details: e?.errors || e?.issues || e?.cause || null
    });

    // ✅ Better fallback than "missing details"
    return {
      ok: false,
      reply: `⚠️ I couldn't log that revenue yet. Try: "revenue $4500 on 2025-12-02 job 1556 Medway Park Dr".`
    };
  }
}

    validateCIL(cil);
    return { ok: true, cil };
  } catch (e) {
    console.warn('[REVENUE] CIL validate failed', {
      message: e?.message,
      name: e?.name,
      details: e?.errors || e?.issues || e?.cause || null
    });

    // ✅ Better fallback than "missing details"
    return {
      ok: false,
      reply: `⚠️ I couldn't log that revenue yet. Try: "revenue $4500 on 2025-12-02 job 1556 Medway Park Dr".`
    };
  }
}


function toNumericAmount(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function sendConfirmRevenueTwiML(from, summaryLine) {
  return out(
    twimlText(`✅ Confirm revenue\n${summaryLine}\n\nReply: Yes / Edit / Change Job / Skip / Cancel`),
    false
  );
}

async function sendConfirmRevenueTemplateOrFallback(from, summaryLine) {
  summaryLine = String(summaryLine || '').trim() || 'Confirm revenue?';
  const sid = String(process.env.TWILIO_REVENUE_CONFIRM_TEMPLATE_SID || '').trim();
  
  // If template SID missing, fall back to TwiML confirm (NO recursion)
  if (!sid) return sendConfirmRevenueTwiML(from, summaryLine);

  try {
    const { sendWhatsAppTemplate } = require('../../services/twilio'); // path may vary

    await sendWhatsAppTemplate({
      to: from,
      templateSid: sid,
      summaryLine
    });

    // outbound WhatsApp sent, return empty TwiML to stop double replies
    return out(twimlEmpty(), true);
  } catch (e) {
    console.warn('[REVENUE_CONFIRM_TEMPLATE] failed, falling back:', e?.message);
    return sendConfirmRevenueTwiML(from, summaryLine);
  }
}

async function sendConfirmRevenueOrFallback(from, summaryLine, ctx = null) {
  // ✅ Refresh confirm TTL (best effort) whenever we re-send confirm
  try {
    if (ctx?.ownerId && ctx?.paUserId) {
      const payload =
        (ctx?.confirmPayload && typeof ctx.confirmPayload === 'object') ? { ...ctx.confirmPayload } : {};

      const draft =
        (ctx?.draft && typeof ctx.draft === 'object') ? { ...ctx.draft }
        : (payload?.draft && typeof payload.draft === 'object') ? { ...payload.draft }
        : null;

      if (draft) {
        await upsertPA({
          ownerId: ctx.ownerId,
          userId: ctx.paUserId,
          kind: PA_KIND_CONFIRM,
          payload: {
            ...(payload || {}),
            draft,
            humanLine: summaryLine,
            sentAt: Date.now(),
            // preserve these if present
            sourceMsgId: payload?.sourceMsgId || ctx?.sourceMsgId || null,
            type: payload?.type || ctx?.type || 'revenue'
          },
          ttlSeconds: PA_TTL_CONFIRM_SEC
        });
      }
    }
  } catch (e) {
    console.warn('[REVENUE_CONFIRM] ttl refresh failed (ignored):', e?.message);
  }

  try {
    return await sendConfirmRevenueTemplateOrFallback(from, summaryLine);
  } catch (e) {
    console.warn('[REVENUE_CONFIRM] template wrapper failed, falling back:', e?.message);
    return sendConfirmRevenueTwiML(from, summaryLine);
  }
}

function extractIsoDateFromText(raw, tz) {
  const s = String(raw || '').trim();

  // 1) ISO already
  const mIso = s.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (mIso) return mIso[1];

  // 2) Month name formats: "November 1, 2025" / "Nov 1 2025"
  const m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/i);
  if (m) {
    const mon = m[1].toLowerCase().slice(0, 3);
    const day = String(m[2]).padStart(2, '0');
    const year = m[3];

    const map = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
    const mm = map[mon];
    if (mm) return `${year}-${mm}-${day}`;
  }

  // 3) If they only say today/yesterday/etc, reuse your existing helper
  const rel = typeof parseRelativeDateReply === 'function' ? parseRelativeDateReply(s, tz) : null;
  return rel || null;
}

// ---------------------------------------------
// Revenue parsing hardening: prevent field bleed
// ---------------------------------------------
function stripJobClause(s) {
  return String(s || '')
    // strip "for job ..." tail
    .replace(/\bfor\s+job\b[\s\S]*$/i, '')
    // strip "job: ..." tail (in case parser produces it)
    .replace(/\bjob\b\s*[:\-]?\s*[\s\S]*$/i, '')
    .trim();
}

function isDateishSource(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return false;

  // common relative tokens
  if (t === 'today' || t === 'yesterday' || t === 'tomorrow') return true;

  // ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;

  // "Jan 29" / "January 29, 2026" (loose)
  if (/^[a-z]{3,9}\s+\d{1,2}(,\s*\d{4})?$/i.test(t)) return true;

  return false;
}
function parseMoneyAmountFromText(text) {
  const s = String(text || '');

  // Match: $16,890  |  $16890  |  $16,890.50
  const m = s.match(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
  if (!m) return null;

  const raw = String(m[1] || '').replace(/,/g, '').trim();
  const n = Number(raw);

  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}


/* ---------------- Job list + picker (JOB_NO-FIRST; deterministic) ---------------- */

function makePickerNonce() {
  return Math.random().toString(16).slice(2, 10);
}

function sanitizeJobLabel(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isGarbageJobName(name) {
  const lc = String(name || '').trim().toLowerCase();
  if (!lc) return true;
  if (looksLikeJobTokenName(lc)) return true;
  return (
    lc === 'cancel' ||
    lc === 'show active jobs' ||
    lc === 'active jobs' ||
    lc === 'change job' ||
    lc === 'switch job' ||
    lc === 'pick job'
  );
}

async function listOpenJobsDetailed(ownerId, limit = 50) {
  const fn =
    (typeof pg.listOpenJobsDetailed === 'function' && pg.listOpenJobsDetailed) ||
    (typeof pg.listJobsOpen === 'function' && pg.listJobsOpen) ||
    null;

  if (fn) {
    try {
      const r = await fn(ownerId, { limit });
      if (Array.isArray(r) && r.length) {
        return r
          .map((j) => ({
            id: j.id || j.job_id || null,
            job_no: j.job_no || j.jobNo || null,
            name: j.name || j.job_name || j.jobName || null
          }))
          .filter((j) => j.name && !isGarbageJobName(j.name));
      }
    } catch {}
  }

  if (typeof query === 'function') {
    try {
      const r = await query(
        `
        SELECT id, job_no, COALESCE(name, job_name) AS name
          FROM public.jobs
         WHERE owner_id = $1
         ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
         LIMIT $2
        `,
        [String(ownerId), Number(limit)]
      );
      const rows = r?.rows || [];
      return rows
        .map((x) => ({ id: x.id || null, job_no: x.job_no ?? null, name: x.name ? String(x.name).trim() : null }))
        .filter((j) => j.name && !isGarbageJobName(j.name));
    } catch {}
  }

  if (typeof pg.listOpenJobs === 'function') {
    try {
      const names = await pg.listOpenJobs(ownerId, { limit });
      return (names || [])
        .map((n) => ({ id: null, job_no: null, name: String(n || '').trim() }))
        .filter((j) => j.name && !isGarbageJobName(j.name));
    } catch {}
  }

  return [];
}

function normalizeJobOptions(jobRows) {
  const out = [];
  const seen = new Set();

  for (const j of jobRows || []) {
    const name = sanitizeJobLabel(j?.name || j?.job_name || j?.jobName);
    if (!name) continue;
    if (isGarbageJobName(name)) continue;

    const jobNo = j?.job_no != null ? Number(j.job_no) : j?.jobNo != null ? Number(j.jobNo) : null;
    if (jobNo == null || !Number.isFinite(jobNo)) continue;

    const key = String(jobNo);
    if (seen.has(key)) continue;
    seen.add(key);

    const rawId = j?.id != null ? String(j.id) : j?.job_id != null ? String(j.job_id) : null;
    const safeUuidId = rawId && looksLikeUuid(rawId) ? rawId : null;

    out.push({ id: safeUuidId, job_no: jobNo, name });
  }

  out.sort((a, b) => Number(a.job_no) - Number(b.job_no));
  return out;
}

function buildTextJobPrompt(jobOptions, page, pageSize) {
  const p = Math.max(0, Number(page || 0));
  const ps = Math.min(8, Math.max(1, Number(pageSize || 8)));

  const start = p * ps;
  const slice = (jobOptions || []).slice(start, start + ps);

  const lines = slice.map((j, i) => {
    const name = String(j?.name || 'Untitled Job').trim();
    const jobNo = j?.job_no != null ? Number(j.job_no) : null;
    const prefix = jobNo != null && Number.isFinite(jobNo) ? `#${jobNo} ` : '';
    return `${i + 1}) ${prefix}${name}`;
  });

  const hasMore = start + ps < (jobOptions || []).length;
  const more = hasMore ? `\nReply "more" for more jobs.` : '';

  return `Which job is this revenue for?\n\n${lines.join('\n')}\n\nReply with a number, job name, or "Overhead".${more}\nTip: reply "change job" to see the picker.`;
}

function looksLikeJobTokenNameLite(name) {
  const t = String(name || '').trim().toLowerCase();
  if (!t) return true;
  if (/^jobix_\d+$/i.test(t)) return true;
  if (/^jobno_\d+$/i.test(t)) return true;
  if (/^job_\d+_[0-9a-z]+$/i.test(t)) return true;
  if (/^#\s*\d+\b/.test(t)) return true;
  return false;
}

function normalizeJobAnswer(text) {
  let s = String(text || '').trim();
  if (!s) return s;

  if (/^jobno_\d{1,10}$/i.test(s)) return s.toLowerCase();
  if (/^jobix_\d{1,10}$/i.test(s)) return s.toLowerCase();
  if (/^job_\d{1,10}_[0-9a-z]+$/i.test(s)) return s; // don't rewrite

  const mStamp = s.match(/\bJ(\d{1,10})\b/i);
  if (mStamp?.[1]) return `jobno_${mStamp[1]}`;

  s = s.replace(/^(job\s*name|job)\s*[:-]?\s*/i, '');
  s = s.replace(/^(create|new)\s+job\s+/i, '');
  s = s.replace(/[?]+$/g, '').trim();

  return s;
}

/**
 * ✅ Maps router-emitted jobix_# to jobno_<jobNo> using displayedJobNos
 */
function coerceJobixToJobno(rawInput, displayedJobNos) {
  const s = String(rawInput || '').trim();
  const m = s.match(/^jobix_(\d{1,10})$/i);
  if (!m?.[1]) return s;
  const ix = Number(m[1]);
  if (!Number.isFinite(ix) || ix < 1) return s;
  const arr = Array.isArray(displayedJobNos) ? displayedJobNos : [];
  if (arr.length >= ix) {
    const jobNo = Number(arr[ix - 1]);
    if (Number.isFinite(jobNo)) return `jobno_${jobNo}`;
  }
  return s;
}

function coerceToYYYYMMDD(raw, tz = 'America/Toronto') {
  const s = String(raw || '').trim();
  if (!s) return null;

  // already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // "2025 02 11" or "2025/02/11"
  let m = s.match(/^(\d{4})[\/\s](\d{1,2})[\/\s](\d{1,2})$/);
  if (m) {
    const y = m[1];
    const mo = String(m[2]).padStart(2, '0');
    const d = String(m[3]).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }

  // "Nov 2, 2025" / "November 2 2025"
  m = s.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})$/i);
  if (m) {
    const mon = m[1].slice(0, 3).toLowerCase();
    const day = String(m[2]).padStart(2, '0');
    const yr = m[3];
    const map = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
    return `${yr}-${map[mon]}-${day}`;
  }

  // relative tokens you already support elsewhere
  if (/^today$/i.test(s) || /^yesterday$/i.test(s) || /^tomorrow$/i.test(s)) {
    // If you already have extractReceiptDateYYYYMMDD(raw,tz), prefer it here
    return null;
  }

  return null;
}

function resolveJobOptionFromReply(rawInput, jobOptions, opts = {}) {
  const s0 = String(rawInput || '').trim();
  const s = normalizeJobAnswer(s0);
  const jobList = Array.isArray(jobOptions) ? jobOptions : [];

  const page = Number(opts.page || 0) || 0;
  const pageSize = Number(opts.pageSize || 8) || 8;
  const displayedJobNos = Array.isArray(opts.displayedJobNos) ? opts.displayedJobNos : null;

  if (/^(overhead|oh)$/i.test(s)) return { kind: 'overhead' };
  if (/^more(\s+jobs)?…?$/i.test(s)) return { kind: 'more' };

  const mTw = String(s).match(/^job_(\d{1,10})_[0-9a-z]+$/i);
  if (mTw?.[1]) {
    const ix = Number(mTw[1]);
    if (Number.isFinite(ix) && ix >= 1) {
      if (displayedJobNos && displayedJobNos.length >= ix) {
        const jobNo = Number(displayedJobNos[ix - 1]);
        const job = jobList.find((j) => Number(j?.job_no) === jobNo);
        return job
          ? { kind: 'job', job: { job_no: Number(job.job_no), name: job.name || null, id: job.id || null } }
          : null;
      }
      const start = page * pageSize;
      const candidate = jobList[start + (ix - 1)];
      if (candidate?.job_no != null) {
        return { kind: 'job', job: { job_no: Number(candidate.job_no), name: candidate.name || null, id: candidate.id || null } };
      }
    }
    return null;
  }

  const mIx = String(s).match(/^jobix_(\d{1,10})$/i);
  if (mIx?.[1]) {
    const ix = Number(mIx[1]);
    if (Number.isFinite(ix) && ix >= 1) {
      if (displayedJobNos && displayedJobNos.length >= ix) {
        const jobNo = Number(displayedJobNos[ix - 1]);
        const job = jobList.find((j) => Number(j?.job_no) === jobNo);
        if (job) return { kind: 'job', job: { job_no: Number(job.job_no), name: job.name || null, id: job.id || null } };
        return null;
      }
      const start = page * pageSize;
      const candidate = jobList[start + (ix - 1)];
      if (candidate?.job_no != null) {
        return { kind: 'job', job: { job_no: Number(candidate.job_no), name: candidate.name || null, id: candidate.id || null } };
      }
    }
    return null;
  }

  const mNo = String(s).match(/^jobno_(\d{1,10})$/i);
  if (mNo?.[1]) {
    const jobNo = Number(mNo[1]);
    const job = jobList.find((j) => Number(j?.job_no) === jobNo);
    return job ? { kind: 'job', job: { job_no: Number(job.job_no), name: job.name || null, id: job.id || null } } : null;
  }

  if (/^\d{1,10}$/.test(String(s).trim())) {
    const ix = Number(s);
    if (Number.isFinite(ix) && ix >= 1) {
      if (displayedJobNos && displayedJobNos.length >= ix) {
        const jobNo = Number(displayedJobNos[ix - 1]);
        const job = jobList.find((j) => Number(j?.job_no) === jobNo);
        return job ? { kind: 'job', job: { job_no: Number(job.job_no), name: job.name || null, id: job.id || null } } : null;
      }
      const start = page * pageSize;
      const candidate = jobList[start + (ix - 1)];
      if (candidate?.job_no != null) {
        return { kind: 'job', job: { job_no: Number(candidate.job_no), name: candidate.name || null, id: candidate.id || null } };
      }
    }
    return null;
  }

  const mHash = String(s).match(/^#?\s*(\d{1,10})\b/);
  if (mHash?.[1]) {
    const jobNo = Number(mHash[1]);
    const job = jobList.find((j) => Number(j?.job_no) === jobNo);
    return job ? { kind: 'job', job: { job_no: Number(job.job_no), name: job.name || null, id: job.id || null } } : null;
  }

  const lc = String(s).trim().toLowerCase();
  const byName = jobList.find((j) => String(j?.name || '').trim().toLowerCase() === lc);
  if (byName?.job_no != null) {
    return { kind: 'job', job: { job_no: Number(byName.job_no), name: byName.name || null, id: byName.id || null } };
  }

  return null;
}

function normalizeListTitle(s = '') {
  return String(s || '')
    .toLowerCase()
    .replace(/\u00A0/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * ✅ Fixes:
 * - Twilio legacy list: ListId="job_<ix>_<hash>", ListTitle="#<ix> <name>", Body may equal ListId
 * - Router-normalized token: input="jobix_<ix>"
 * - Treat "<ix>" as UI index, NOT jobNo
 * - ✅ CRITICAL INVARIANT: if Twilio provided a title, DO NOT use any index mapping.
 *   Title must match a row the user saw OR a unique jobOptions match, otherwise reject.
 * - Works even if some helper fns are missing
 */
async function resolveJobPickSelection({ input, twilioMeta, pickState }) {
  const tokRaw = String(input || '').trim();

  const listIdRaw = String(twilioMeta?.ListId || twilioMeta?.ListRowId || '').trim();
  const bodyRaw = String(twilioMeta?.Body || '').trim();
  const inboundTitleRaw = String(twilioMeta?.ListTitle || twilioMeta?.ListRowTitle || '').trim();

  // Prefer the most "true" token:
  // 1) ListId, then 2) Body, then 3) router-normalized input
  const tok = listIdRaw || bodyRaw || tokRaw;

  const displayedJobNos = Array.isArray(pickState?.displayedJobNos)
    ? pickState.displayedJobNos.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];

  const sentRows = Array.isArray(pickState?.sentRows) ? pickState.sentRows : [];
  const jobOptions = Array.isArray(pickState?.jobOptions) ? pickState.jobOptions : [];

  const safeNormalize = (s) => {
    const v = String(s || '').trim();
    if (!v) return '';
    if (typeof normalizeListTitle === 'function') return normalizeListTitle(v);
    return v
      .toLowerCase()
      .replace(/[#\s]+/g, ' ')
      .replace(/[^\w\s]/g, '')
      .trim();
  };

  const deSpace = (s) => String(s || '').replace(/\s+/g, '').trim().toLowerCase();

  const extractJobNoFromRow = (r) => {
    const cand = r?.jobNo ?? r?.job_no ?? r?.jobNumber ?? r?.job_number ?? r?.job ?? null;
    const n = Number(cand);
    return Number.isFinite(n) ? n : null;
  };

  const extractJobName = (r) => {
    const cand = r?.name ?? r?.title ?? r?.label ?? r?.jobName ?? r?.job_name ?? '';
    return String(cand || '').trim();
  };

  // ----------------------------
  // 0) Stable token: jobno_<jobNo>
  // ----------------------------
  const mJobNo = tok.match(/^jobno_(\d{1,10})$/i);
  if (mJobNo?.[1]) {
    return { ok: true, jobNo: Number(mJobNo[1]), meta: { mode: 'stable_jobno' } };
  }

  // ----------------------------
  // 1) Title/name match (authoritative if title exists)
  // ----------------------------
  const hasTitleSignal = !!String(inboundTitleRaw || '').trim();

  if (hasTitleSignal) {
    const strippedTitle = String(inboundTitleRaw || '').replace(/^#\s*\d+\s+/, '').trim();
    const needle = safeNormalize(strippedTitle);
    const needleDS = deSpace(needle);

    // 1a) Try sentRows (what we believe we rendered)
    if (sentRows.length) {
      const hit = sentRows.find((r) => {
        const jobNo = extractJobNoFromRow(r);
        if (jobNo == null) return false;

        // NOTE: do NOT hard-require displayedJobNos; some builds store UI indices here
        const candRaw = extractJobName(r);
        const cand = safeNormalize(candRaw);
        if (!cand || !needle) return false;

        return cand === needle || deSpace(cand) === needleDS;
      });

      if (hit) {
        const jn = extractJobNoFromRow(hit);
        if (jn != null) return { ok: true, jobNo: Number(jn), meta: { mode: 'title_match_sentRows' } };
      }
    }

    // 1b) Fallback: match against jobOptions (authoritative listOpenJobsDetailed result)
    if (jobOptions.length) {
      const matches = jobOptions
        .map((j) => {
          const jobNo = extractJobNoFromRow(j);
          if (jobNo == null) return null;

          const name = safeNormalize(extractJobName(j));
          if (!name || !needle) return null;

          const ok = name === needle || deSpace(name) === needleDS || name.includes(needle) || needle.includes(name);
          return ok ? { jobNo, name } : null;
        })
        .filter(Boolean);

      // only accept unique match
      const uniq = new Map();
      for (const m of matches) uniq.set(String(m.jobNo), m);
      const arr = Array.from(uniq.values());

      if (arr.length === 1) {
        return { ok: true, jobNo: Number(arr[0].jobNo), meta: { mode: 'title_match_jobOptions' } };
      }
    }

    // ✅ IMPORTANT: title existed but we couldn't match -> reject (NO index fallback)
    return { ok: false, reason: 'title_present_but_no_match' };
  }

  // ----------------------------
  // 2) Router token: jobix_<ix> (UI index) — ONLY allowed when NO title signal
  // ----------------------------
  const mJobIx = tok.match(/^jobix_(\d{1,10})$/i);
  const ixFromJobix = mJobIx?.[1] ? Number(mJobIx[1]) : null;
  if (ixFromJobix != null && Number.isFinite(ixFromJobix) && ixFromJobix >= 1) {
    const ix = ixFromJobix;

    if (displayedJobNos.length && ix <= displayedJobNos.length) {
      const jobNo = Number(displayedJobNos[ix - 1]);
      if (Number.isFinite(jobNo)) return { ok: true, jobNo, meta: { mode: 'jobix_displayed', ix } };
    }

    if (sentRows.length && ix <= sentRows.length) {
      const expected = sentRows[ix - 1];
      const jobNo = extractJobNoFromRow(expected);
      if (jobNo != null) return { ok: true, jobNo, meta: { mode: 'jobix_sentRows', ix } };
    }

    return { ok: false, reason: 'jobix_out_of_range' };
  }

  // ----------------------------
  // 3) Twilio legacy token: job_<ix>_<hash> (UI index) — ONLY allowed when NO title signal
  // ----------------------------
  const mLegacy = tok.match(/^job_(\d{1,10})_[0-9a-z]+$/i);
  const ix = mLegacy?.[1] ? Number(mLegacy[1]) : null;

  if (ix != null && Number.isFinite(ix) && ix >= 1) {
    if (displayedJobNos.length && ix <= displayedJobNos.length) {
      const jobNo = Number(displayedJobNos[ix - 1]);
      if (Number.isFinite(jobNo)) return { ok: true, jobNo, meta: { mode: 'legacy_ix_displayed', ix } };
    }

    if (sentRows.length && ix <= sentRows.length) {
      const expected = sentRows[ix - 1];
      const jobNo = extractJobNoFromRow(expected);
      if (jobNo != null) return { ok: true, jobNo, meta: { mode: 'legacy_ix_sentRows', ix } };
    }

    return { ok: false, reason: 'legacy_ix_out_of_range' };
  }

  return { ok: false, reason: 'unrecognized_row_id' };
}



function buildJobPickerRows({
  jobOptions = [],
  page = 0,
  pageSize = 8,
  includeOverhead = true,
  includeMore = true
} = {}) {
  const jobs = Array.isArray(jobOptions) ? jobOptions : [];
  const p = Math.max(0, Number(page) || 0);
  const size = Math.max(1, Math.min(8, Number(pageSize) || 8)); // keep <= 8 jobs per page
  const start = p * size;
  const end = start + size;

  const slice = jobs.slice(start, end);

  const total = jobs.length;
  const hasMore = end < total;

  // Stable row IDs (never index-based)
  // - job rows: jobno_<job_no>
  // - overhead: overhead
  // - more: more
  const rows = [];

  // Job rows first
  for (const j of slice) {
    const jobNo = j?.job_no ?? j?.jobNo ?? null;
    const titleRaw = j?.name ?? j?.job_name ?? j?.jobName ?? '';
    const title = String(titleRaw || '').trim() || (jobNo != null ? `Job #${jobNo}` : 'Untitled Job');

    // If job_no is missing, fall back to a stable-ish id using name
    // (but ideally job_no exists for all rows)
    const id =
      jobNo != null && Number.isFinite(Number(jobNo))
        ? `jobno_${Number(jobNo)}`
        : `jobname_${title.toLowerCase().replace(/\s+/g, '_').slice(0, 32)}`;

    rows.push({ title, id, jobNo: jobNo != null ? Number(jobNo) : null });
  }

  // Optional: Overhead row
  if (includeOverhead) {
    rows.push({ title: 'Overhead', id: 'overhead', jobNo: null });
  }

  // Optional: More… row (only if there are more jobs beyond this page)
  if (includeMore && hasMore) {
    rows.push({ title: 'More…', id: 'more', jobNo: null });
  }

  // What we actually displayed (helps coerce jobix -> jobno and verify taps)
  const displayedJobNos = rows
    .map((r) => (r.jobNo != null && Number.isFinite(Number(r.jobNo)) ? Number(r.jobNo) : null))
    .filter((n) => n != null);

  // This is what you should persist so selection resolution can validate taps
  const sentRows = rows.map((r) => ({ title: r.title, id: r.id }));

  return {
    rows,              // array of {title, id, jobNo?}
    sentRows,          // persisted for robust resolution
    displayedJobNos,   // persisted for jobix->jobno coercion
    hasMore,
    page: p,
    pageSize: size,
    total
  };
}
function pickConfirmDraftSnapshot(confirmDraft) {
  if (!confirmDraft || typeof confirmDraft !== 'object') return null;
  const d = { ...confirmDraft };
  return {
    amount: d.amount ?? null,
    source: d.source ?? null,
    date: d.date ?? null,
    description: d.description ?? null,
    jobName: d.jobName ?? null,
    jobSource: d.jobSource ?? null,
    job_no: d.job_no ?? null,
    job_id: d.job_id ?? null,
    suggestedCategory: d.suggestedCategory ?? null,
    originalText: d.originalText ?? d.draftText ?? null,
    draftText: d.draftText ?? d.originalText ?? null
  };
}

async function sendJobPickerOrFallback({
  from,
  ownerId,
  paUserId,
  jobOptions,
  page = 0,
  pageSize = 8,
  confirmDraft = null,
  context = 'revenue_jobpick'
}) {
  const to = waTo(from);

  // ✅ Keep <= 10 total rows: 8 jobs + Overhead + (optional) More…
const JOBS_PER_PAGE = Math.min(8, Math.max(1, Number(pageSize || 8)));
  const p = Math.max(0, Number(page || 0));
  const start = p * JOBS_PER_PAGE;

  // Filter + de-dupe by job_no
  const seen = new Set();
  const clean = [];
  for (const j of jobOptions || []) {
    const n = j?.job_no != null ? Number(j.job_no) : j?.jobNo != null ? Number(j.jobNo) : null;
    if (n == null || !Number.isFinite(n)) continue;

    const nm = String(j?.name || j?.job_name || j?.jobName || '').trim();
    if (!nm || isGarbageJobName(nm)) continue;

    if (seen.has(n)) continue;
    seen.add(n);

    clean.push({ ...j, job_no: n, name: nm });
  }

  clean.sort((a, b) => Number(a.job_no) - Number(b.job_no));

  const slice = clean.slice(start, start + JOBS_PER_PAGE);

  const displayedJobNos = slice
    .map((j) => (j?.job_no != null ? Number(j.job_no) : null))
    .filter((n) => Number.isFinite(n));

  const hasMore = start + JOBS_PER_PAGE < clean.length;

  const pickerNonce = makePickerNonce();

  const sentRows = slice.map((j, idx) => {
    const jobNo = Number(j.job_no);
    const name = sanitizeJobLabel(j.name);
    const title = `${jobNo} ${name}`.slice(0, 24);
    return { ix: idx + 1, jobNo, name, title };
  });

  const confirmDraftSnap = pickConfirmDraftSnapshot(confirmDraft);

  const userKey = normalizeIdentityDigits(paUserId) || normalizeIdentityDigits(from) || String(from || '').trim();

  // ✅ pre-write PA so typed replies still work even if interactive send fails
  await upsertPA({
    ownerId,
    userId: userKey,
    kind: PA_KIND_PICK_JOB,
    payload: {
      context: String(context || 'revenue_jobpick'),
      page: p,
      pageSize: JOBS_PER_PAGE,
      hasMore,
      displayedJobNos,
      sentRows,
      sentAt: Date.now(),       // ✅ standardize with expense
      pickerNonce,
      jobOptions: clean,
      confirmDraft: confirmDraftSnap,
      lastPickerMsgSid: null    // ✅ will be set if interactive succeeds
    },
    ttlSeconds: PA_TTL_PICK_SEC
  });

  if (!ENABLE_INTERACTIVE_LIST || !to) {
    return out(twimlText(buildTextJobPrompt(clean, p, JOBS_PER_PAGE)), false);
  }

  const rows = slice.map((j) => {
    const full = sanitizeJobLabel(j?.name || j?.job_name || 'Untitled Job');
    const jobNo = Number(j?.job_no);
    const stamped = `J${jobNo} ${full}`;

    return {
      id: `jobno_${jobNo}`,
      title: stamped.slice(0, 24),
      description: full.slice(0, 72)
    };
  });

  rows.push({ id: 'overhead', title: 'Overhead', description: 'Not tied to a job' });
  if (hasMore) rows.push({ id: 'more', title: 'More jobs…', description: 'Show next page' });
  // ✅ Hard cap: Twilio list rows max (protects against accidental oversize)
rows.splice(10);
  const bodyText =
    `Pick a job (${start + 1}-${Math.min(start + JOBS_PER_PAGE, clean.length)} of ${clean.length}).` +
    `\n\nTip: You can also reply with a number (like "1").`;

  let sendResult = null;
  try {
    sendResult = await sendWhatsAppInteractiveList({
      to,
      bodyText,
      buttonText: 'Pick a job',
      sections: [{ title: 'Active Jobs', rows }]
    });
  } catch (e) {
    console.warn('[REVENUE] interactive list failed; falling back:', e?.message);
    return out(twimlText(buildTextJobPrompt(clean, p, JOBS_PER_PAGE)), false);
  }

  // ✅ persist lastPickerMsgSid after send
  const lastPickerMsgSid =
    String(sendResult?.sid || sendResult?.messageSid || sendResult?.MessageSid || '').trim() || null;

  if (lastPickerMsgSid) {
    try {
      const pa0 = await getPA({ ownerId, userId: userKey, kind: PA_KIND_PICK_JOB });
      if (pa0?.payload) {
        await upsertPA({
          ownerId,
          userId: userKey,
          kind: PA_KIND_PICK_JOB,
          payload: { ...(pa0.payload || {}), lastPickerMsgSid },
          ttlSeconds: PA_TTL_PICK_SEC
        });
      }
    } catch {}
  }

  return out(twimlEmpty(), true);
}


/* ---------------- Confirm message builder ---------------- */

function buildActiveJobHint(jobName, jobSource) {
  if (jobSource !== 'active' || !jobName) return '';
  return `\n\n🧠 Using active job: ${jobName}\nTip: reply "change job" to pick another`;
}

function buildRevenueTemplateLine({ amount, source, date, jobName, tz }) {
  const amt = String(amount || '').trim();
  const src = String(source || '').trim();
  const dt = formatDisplayDate(date, tz);
  const jb = jobName ? String(jobName).trim() : '';

  const parts = [];
  if (amt) parts.push(`You received ${amt}`);
  if (src && src !== 'Unknown') parts.push(`from ${src}`);
  if (jb) parts.push(`for Job ${jb}`);
  if (dt) parts.push(`on ${dt}`);

  const s = parts.join(' ') + '.';
  return s.replace(/\s+/g, ' ').trim();
}

function buildRevenueSummaryLine({ amount, source, date, jobName, tz }) {
  const n = typeof amount === 'number' ? amount : toNumberAmount(amount);
  const amtPretty = formatMoneyDisplay(Number.isFinite(n) ? n : 0);

  const src = String(source || '').trim();
  const dtRaw = String(date || '').trim();
  const dt = dtRaw ? formatDisplayDate(dtRaw, tz) : '';
  const jb = jobName ? String(jobName).trim() : '';

  const lines = [];
  lines.push(`💰 ${amtPretty}`);
  if (src && src !== 'Unknown') lines.push(`👤 ${src}`);
  if (dt) lines.push(`📅 ${dt}`);
  if (jb) lines.push(`🧰 ${jb}`);

  return lines.join('\n');
}


/* ---------------- New message detection (job-picker bypass) ---------------- */

function looksLikeNewRevenueText(s = '') {
  const lc = String(s || '').trim().toLowerCase();
  if (!lc) return false;

  if (/^(revenue|rev|received|deposit|paid|payment)\b/.test(lc)) return true;

  return (
    /\b(received|deposit|paid|payment|etransfer|e-transfer|interac|invoice|cheque|check)\b/.test(lc) &&
    /\$?\s*\d+(\.\d{1,2})?\b/.test(lc)
  );
}
const REVENUE_DEFAULT_DATA = Object.freeze({
  date: null,
  description: 'Revenue received',
  amount: '$0.00',
  source: null,
  jobName: null,
  jobSource: null
});

/* ---------------- main handler ---------------- */

async function handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId, twilioMeta = null) {
  input = stripRevenuePrefixes(input);

  twilioMeta = twilioMeta && typeof twilioMeta === 'object' ? twilioMeta : {};
const plan = getEffectivePlanFromOwner(ownerProfile);
  // ✅ Canonical PA key (digits) — prefer WaId, then userProfile, then from
  const paUserId =
    (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(twilioMeta?.WaId || twilioMeta?.WaID || twilioMeta?.waid)) ||
    (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(userProfile?.wa_id)) ||
    (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(from)) ||
    String(from || '').replace(/\D/g, '').trim() ||
    String(from || '').trim();

  const msgSid = String(twilioMeta?.MessageSid || twilioMeta?.SmsMessageSid || '').trim();
  const safeMsgId = msgSid || String(sourceMsgId || '').trim() || String(`${paUserId}:${Date.now()}`).trim();

  const tz = userProfile?.timezone || userProfile?.tz || 'America/Toronto';
  
  try {
    
 // ---- 1) Awaiting job pick ----
const pickPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB }).catch(() => null);
const allowCreateJob = !!pickPA?.payload?.allowCreateJob;

if (
  pickPA?.payload &&
  (allowCreateJob || (Array.isArray(pickPA.payload.jobOptions) && pickPA.payload.jobOptions.length))
) {
  // If user starts a NEW revenue while stuck in pick flow, clear pick+confirm and let intake run
  if (looksLikeNewRevenueText(input)) {
    console.info('[REVENUE] pick-job bypass: new revenue detected, clearing PAs');
    try { await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB }); } catch {}
    try { await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }); } catch {}
  } else {
const raw0 = String(input || '').trim();
const rawLc = raw0.toLowerCase();
const tok = normalizeDecisionToken(raw0);
const jobOptions = Array.isArray(pickPA.payload.jobOptions) ? pickPA.payload.jobOptions : [];
const page = Number(pickPA.payload.page || 0) || 0;
const pageSize = Number(pickPA.payload.pageSize || 8) || 8; // ✅ 8
const hasMore = !!pickPA.payload.hasMore;
const displayedJobNos = Array.isArray(pickPA.payload.displayedJobNos) ? pickPA.payload.displayedJobNos : [];
const sentRows = Array.isArray(pickPA.payload.sentRows) ? pickPA.payload.sentRows : [];
const sentAt = Number(pickPA.payload.sentAt || 0) || Number(pickPA.payload.shownAt || 0) || 0; // compat
const context = String(pickPA.payload.context || 'revenue_jobpick');
const listRowId = String(twilioMeta?.ListRowId || twilioMeta?.ListId || '').trim().toLowerCase();
const isMore = tok === 'more' || rawLc === 'more' || listRowId === 'more';

// TTL / stale → resend page 0
if (!sentAt || (Date.now() - sentAt) > (PA_TTL_PICK_SEC * 1000)) {
  return await sendJobPickerOrFallback({
    from,
    ownerId,
    paUserId,
    jobOptions,
    page: 0,
    pageSize,
    confirmDraft: pickPA?.payload?.confirmDraft || null,
    context
  });
}

// ✅ "more" handler (must run BEFORE coercion / resolution)
if (isMore) {
  if (!hasMore) {
    return out(twimlText('No more jobs to show. Tap a job, or reply with a job name.'), false);
  }
  return await sendJobPickerOrFallback({
    from,
    ownerId,
    paUserId,
    jobOptions,
    page: page + 1,
    pageSize,
    confirmDraft: pickPA?.payload?.confirmDraft || null,
    context
  });
}

    // ---------------------------------------------------------
    // ✅ CREATE-FIRST-JOB (typed) when allowCreateJob is true
    // - Lets user type first job name or "Overhead"
    // - Updates confirm draft + re-sends confirm
    // ---------------------------------------------------------
    if (allowCreateJob) {
      const tok0 = normalizeDecisionToken(raw0);

      const isControl0 =
        tok0 === 'yes' ||
        tok0 === 'edit' ||
        tok0 === 'cancel' ||
        tok0 === 'resume' ||
        tok0 === 'skip' ||
        tok0 === 'change_job' ||
        tok0 === 'more';

      if (!isControl0) {
        // Overhead allowed
        if (/^(overhead|oh)$/i.test(raw0)) {
          let confirm = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }).catch(() => null);

          // rebuild from pickPA.confirmDraft if missing
          if (!confirm?.payload?.draft && pickPA?.payload?.confirmDraft) {
            await upsertPA({
              ownerId,
              userId: paUserId,
              kind: PA_KIND_CONFIRM,
              payload: { draft: pickPA.payload.confirmDraft, sourceMsgId: safeMsgId, type: 'revenue' },
              ttlSeconds: PA_TTL_CONFIRM_SEC
            }).catch(() => null);

            confirm = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }).catch(() => null);
          }

          if (!confirm?.payload?.draft) {
            await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB }).catch(() => null);
            return out(twimlText('I couldn’t find the pending revenue. Please resend the revenue.'), false);
          }

          const draft = { ...(confirm.payload.draft || {}) };
          draft.jobName = 'Overhead';
          draft.jobSource = 'overhead';
          draft.job_no = null;
          draft.job_id = null;

          await upsertPA({
            ownerId,
            userId: paUserId,
            kind: PA_KIND_CONFIRM,
            payload: { ...(confirm.payload || {}), draft },
            ttlSeconds: PA_TTL_CONFIRM_SEC
          });

          await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB }).catch(() => null);

          const summaryLine = buildRevenueSummaryLine({
            amount: draft.amount,
            source: draft.source,
            date: draft.date,
            jobName: draft.jobName,
            tz
          });

          return await sendConfirmRevenueOrFallback(from, summaryLine, {
  ownerId,
  paUserId,
  draft,
  confirmPayload: confirm?.payload || null,
  type: 'revenue',
  sourceMsgId: String(confirm?.payload?.sourceMsgId || safeMsgId || sourceMsgId || '').trim() || null
});
        }

        // Otherwise create first job from typed name
        const jobName = raw0;

        let createdJob = null;
        try {
          if (typeof pg?.createJobIdempotent === 'function') {
            try {
              createdJob = await pg.createJobIdempotent(ownerId, jobName, paUserId);
            } catch {
              createdJob = await pg.createJobIdempotent({ ownerId, name: jobName, createdBy: paUserId });
            }
          } else if (typeof pg?.createJob === 'function') {
            try {
              createdJob = await pg.createJob(ownerId, jobName, paUserId);
            } catch {
              createdJob = await pg.createJob({ ownerId, name: jobName, createdBy: paUserId });
            }
          }
        } catch (e) {
          console.warn('[REVENUE_CREATE_FIRST_JOB] createJob failed:', e?.message);
        }

        if (!createdJob) {
          return out(twimlText(`I couldn’t create that job. Try a shorter name like: "Oak Street Re-roof"`), false);
        }

        const newJobId =
          (createdJob?.job_id && looksLikeUuid(createdJob.job_id) ? String(createdJob.job_id) : null) ||
          (createdJob?.id && looksLikeUuid(createdJob.id) ? String(createdJob.id) : null) ||
          null;

        const newJobNoRaw = createdJob?.job_no ?? createdJob?.jobNo ?? null;
        const newJobNo = Number(newJobNoRaw);

        // Ensure confirm exists
        let confirm = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }).catch(() => null);

        if (!confirm?.payload?.draft && pickPA?.payload?.confirmDraft) {
          await upsertPA({
            ownerId,
            userId: paUserId,
            kind: PA_KIND_CONFIRM,
            payload: { draft: pickPA.payload.confirmDraft, sourceMsgId: safeMsgId, type: 'revenue' },
            ttlSeconds: PA_TTL_CONFIRM_SEC
          }).catch(() => null);

          confirm = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }).catch(() => null);
        }

        if (!confirm?.payload?.draft) {
          await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB }).catch(() => null);
          return out(twimlText('I couldn’t find the pending revenue. Please resend the revenue.'), false);
        }

        const draft = { ...(confirm.payload.draft || {}) };
        draft.jobName = jobName;
        draft.jobSource = 'created';
        draft.job_no = Number.isFinite(newJobNo) ? newJobNo : null;
        draft.job_id = newJobId;

        await upsertPA({
          ownerId,
          userId: paUserId,
          kind: PA_KIND_CONFIRM,
          payload: { ...(confirm.payload || {}), draft },
          ttlSeconds: PA_TTL_CONFIRM_SEC
        });

        await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB }).catch(() => null);

        const summaryLine = buildRevenueSummaryLine({
          amount: draft.amount,
          source: draft.source,
          date: draft.date,
          jobName: draft.jobName,
          tz
        });

        return await sendConfirmRevenueOrFallback(from, summaryLine, {
  ownerId,
  paUserId,
  draft,
  confirmPayload: confirm?.payload || null,
  type: 'revenue',
  sourceMsgId: String(confirm?.payload?.sourceMsgId || safeMsgId || sourceMsgId || '').trim() || null
});
      }
    }

   

    // -----------------------------
    // picker-tap resolution
    // -----------------------------
    let rawInput = raw0;
    const rawInput0 = rawInput;

    const looksLikePickerTap =
      !!twilioMeta?.ListId ||
      /^jp:[0-9a-f]{8}:/i.test(rawInput0) ||
      /^job_\d{1,10}_[0-9a-z]+$/i.test(rawInput0) ||
      /^jobno_\d{1,10}$/i.test(rawInput0) ||
      /^jobix_\d{1,10}$/i.test(rawInput0);

    if (looksLikePickerTap) {
      const sel = await resolveJobPickSelection({
        input: rawInput0,
        twilioMeta: twilioMeta || {},
        pickState: { displayedJobNos, sentRows, jobOptions }
      });

      const twilioProvidedPickerMeta =
        !!String(twilioMeta?.ListId || twilioMeta?.ListRowId || '').trim() ||
        !!String(twilioMeta?.ListTitle || twilioMeta?.ListRowTitle || '').trim();

      if (!sel?.ok) {
        if (twilioProvidedPickerMeta) {
          return await sendJobPickerOrFallback({
            from,
            ownerId,
            paUserId,
            jobOptions,
            page,
            pageSize,
            confirmDraft: pickPA?.payload?.confirmDraft || null,
            context
          });
        }
        rawInput = coerceJobixToJobno(rawInput0, displayedJobNos);
      } else {
        rawInput = `jobno_${Number(sel.jobNo)}`;
      }
    } else {
      rawInput = coerceJobixToJobno(rawInput0, displayedJobNos);
    }

    // Remember inbound token (optional)
    try {
      await upsertPA({
        ownerId,
        userId: paUserId,
        kind: PA_KIND_PICK_JOB,
        payload: { ...(pickPA.payload || {}), lastInboundTextRaw: input, lastInboundText: rawInput },
        ttlSeconds: PA_TTL_PICK_SEC
      });
    } catch {}

    const resolved = resolveJobOptionFromReply(rawInput, jobOptions, { page, pageSize, displayedJobNos });

    if (!resolved) {
      return out(twimlText('Please tap a job, or reply with a job name, or "more".'), false);
    }

    // ✅ Ensure confirm draft exists (rebuild from pickPA.confirmDraft if needed)
    let confirm = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }).catch(() => null);

    if (!confirm?.payload?.draft) {
      const fallbackDraft = pickPA?.payload?.confirmDraft || null;
      if (fallbackDraft) {
        await upsertPA({
          ownerId,
          userId: paUserId,
          kind: PA_KIND_CONFIRM,
          payload: { draft: fallbackDraft, sourceMsgId: safeMsgId, type: 'revenue' },
          ttlSeconds: PA_TTL_CONFIRM_SEC
        }).catch(() => null);

        confirm = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }).catch(() => null);
      }
    }

    if (!confirm?.payload?.draft) {
      await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB }).catch(() => null);
      return out(twimlText('Got it. Now resend the revenue details.'), false);
    }

    const draft = { ...(confirm.payload.draft || {}) };

    if (resolved.kind === 'overhead') {
      draft.jobName = 'Overhead';
      draft.jobSource = 'overhead';
      draft.job_no = null;
      draft.job_id = null;
    } else if (resolved.kind === 'job' && resolved.job?.job_no != null) {
      const jobName = normalizeJobNameCandidate(resolved.job?.name);
      draft.jobName = jobName || draft.jobName || null;

      draft.jobSource = 'picked';
      draft.job_no = Number(resolved.job.job_no);

      const jobId =
        (resolved.job?.job_id && looksLikeUuid(resolved.job.job_id) ? String(resolved.job.job_id) : null) ||
        (resolved.job?.id && looksLikeUuid(resolved.job.id) ? String(resolved.job.id) : null) ||
        null;

      draft.job_id = jobId;
    } else {
      return out(twimlText('Please reply with a number, job name, "Overhead", or "more".'), false);
    }

    await upsertPA({
      ownerId,
      userId: paUserId,
      kind: PA_KIND_CONFIRM,
      payload: { ...(confirm.payload || {}), draft },
      ttlSeconds: PA_TTL_CONFIRM_SEC
    });

    await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB }).catch(() => null);

    // ✅ Always re-confirm using the SAME human summary builder
    const summaryLine = buildRevenueSummaryLine({
      amount: draft.amount,
      source: draft.source,
      date: draft.date,
      jobName: draft.jobName,
      tz
    });

    // persist humanLine (optional)
    try {
      await upsertPA({
        ownerId,
        userId: paUserId,
        kind: PA_KIND_CONFIRM,
        payload: { ...(confirm.payload || {}), humanLine: summaryLine, draft },
        ttlSeconds: PA_TTL_CONFIRM_SEC
      });
    } catch {}

    console.info('[REVENUE_RECONFIRM_AFTER_PICK]', {
      head: String(summaryLine || '').slice(0, 60),
      job: draft.jobName || null,
      job_no: draft.job_no ?? null
    });

    return await sendConfirmRevenueOrFallback(from, summaryLine, {
  ownerId,
  paUserId,
  draft,
  confirmPayload: confirm?.payload || null,
  type: 'revenue',
  sourceMsgId: String(confirm?.payload?.sourceMsgId || safeMsgId || sourceMsgId || '').trim() || null
});
  }
}



    // ---- 2) Confirm/edit/cancel (CONSOLIDATED) ----
    let confirmPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }).catch(() => null);

    if (confirmPA?.payload?.draft) {
      // Owner gate
      if (!isOwner) {
        try { await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }); } catch {}
        return out(twimlText('⚠️ Only the owner can manage revenue.'), false);
      }

      const strictTok = strictDecisionToken(input);
// ---------------------------------------------------------
// ✅ CONFIRM-SUMMARY ECHO GUARD (CONFIRM FLOW)
// If user sends back the formatted confirm summary (often after Edit),
// do NOT treat it as a new "revenue ..." intake.
// Instead: re-send confirm (resume behavior) or give the right prompt.
// ---------------------------------------------------------
function looksLikeRevenueConfirmEcho(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;

  const lc = s.toLowerCase();

  // Must look like the confirm “shape”
  const hasMoneyLine = /💰\s*\$?\s*[\d,]+(?:\.\d{2})?/.test(s);
  const hasDateLine =
    /📅/.test(s) ||
    /\b(20\d{2}-\d{2}-\d{2})\b/.test(lc) ||
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/.test(lc);

  const hasJobLine = /🧰/.test(s);

  // Common patterns you generate
  const startsWithRevenue = /^revenue\b/i.test(s);

  // "Revenue\n💰...\n📅...\n🧰..."
  if (startsWithRevenue && hasMoneyLine && (hasDateLine || hasJobLine)) return true;

  // Emoji block pasted alone
  if (hasMoneyLine && hasDateLine && hasJobLine && s.length <= 260) return true;

  // Safety: avoid matching normal intake like "revenue 4500 nov 2"
  if (startsWithRevenue && !/[\n\r]/.test(s) && s.length <= 60) return false;

  return false;
}
       // ---------------------------------------------------------
      // ✅ UN-SKIPPABLE EDIT CONSUMPTION (CONFIRM FLOW)
      // (Echo guard is defined ONCE above — do not redefine it here)
      // ---------------------------------------------------------
      try {
        // refresh confirmPA (avoid stale snapshots)
        try {
          confirmPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }).catch(() => confirmPA);
        } catch {}

        const draftR = confirmPA?.payload?.draft || null;

        const editStartedAt = Number(draftR?.edit_started_at || draftR?.editStartedAt || 0) || 0;
        const EDIT_WINDOW_MS = 10 * 60 * 1000;
        const ageMs = editStartedAt ? (Date.now() - editStartedAt) : null;

        const editRecentlyStarted =
          !!editStartedAt &&
          typeof ageMs === 'number' &&
          ageMs >= 0 &&
          ageMs <= EDIT_WINDOW_MS;

        const isControl =
          strictTok === 'yes' ||
          strictTok === 'edit' ||
          strictTok === 'cancel' ||
          strictTok === 'resume' ||
          strictTok === 'skip' ||
          strictTok === 'change_job';

        // ✅ Echo guard (uses the ONE definition you kept above)
        if (!strictTok && draftR && looksLikeRevenueConfirmEcho(input)) {
          if (draftR.awaiting_edit) {
            return out(
              twimlText(
                [
                  '✏️ Send the corrected revenue details in ONE message.',
                  'Example:',
                  'revenue $2500 on Jan 13 2026 job Oak Street Re-roof',
                  'Reply "cancel" to discard.'
                ].join('\n')
              ),
              false
            );
          }

          if (draftR.awaiting_date) {
            return out(
              twimlText(`📅 I still need the date. Reply "today", "yesterday", or "2026-01-13".`),
              false
            );
          }

          // Otherwise treat echo as resume
          return await resendConfirmRevenue({ from, ownerId, tz, paUserId });
        }

        const shouldConsumeAsEditPayload =
          !!draftR && !isControl && (draftR.awaiting_edit || editRecentlyStarted);

        if (shouldConsumeAsEditPayload) {

  console.info('[REVENUE_EDIT_CONSUME_ENTER]', {
    awaiting_edit: !!draftR?.awaiting_edit,
    previousDraftDate: draftR?.date,
    input: String(input || '').slice(0, 120)
  });

  const editInputRaw = String(input || '').trim();
  const editInput = stripRevenuePrefixes(editInputRaw); // ✅ makes "Revenue 4580..." acceptable
  const aiRes = await handleInputWithAI(from, editInput, 'revenue', parseRevenueMessage, REVENUE_DEFAULT_DATA, { tz });
  let nextDraft = aiRes?.data || null;
  if (nextDraft) nextDraft = normalizeRevenueData(nextDraft, tz);

          if (!nextDraft || typeof nextDraft !== 'object') nextDraft = {};

          if (!nextDraft.amount || nextDraft.amount === '$0.00') {
  const n = parseMoneyAmountFromText(editInputRaw); // raw, not stripped
  if (n != null) nextDraft.amount = formatMoneyDisplay(n);
}

          if (!isIsoDate(nextDraft.date)) {
            const t = String(input || '').toLowerCase();
            if (/\btoday\b/.test(t)) nextDraft.date = todayInTimeZone(tz);
            else if (/\byesterday\b/.test(t)) {
              try {
                const td = todayInTimeZone(tz);
                const d = new Date(`${td}T12:00:00Z`);
                d.setUTCDate(d.getUTCDate() - 1);
                nextDraft.date = d.toISOString().slice(0, 10);
              } catch {}
            }
          }
// ✅ Deterministic explicit date override during edit
// If user typed a real date, it must win over stale draft date.
const explicitIso = extractIsoDateFromText(input, tz);
if (explicitIso) nextDraft.date = explicitIso;
console.info('[REVENUE_EDIT_DATE_DEBUG]', {
  oldDate: draftR?.date,
  aiDate: aiRes?.data?.date,
  normalizedDate: nextDraft?.date,
  explicitIso
});
          // cleanup: prevent job/date bleed into source
          if (nextDraft?.source) {
            nextDraft.source = stripJobClause(nextDraft.source);
            if (isDateishSource(nextDraft.source)) nextDraft.source = '';
          }

          const missingCore = !nextDraft || !nextDraft.amount || nextDraft.amount === '$0.00';
          if (missingCore) {
            return out(
              twimlText(aiRes?.reply || 'I couldn’t understand that edit. Please resend with amount + date + job.'),
              false
            );
          }
console.info('[REVENUE_EDIT_DATE_DEBUG]', {
  was: draftR?.date,
  ai: aiRes?.data?.date,
  normalized: nextDraft?.date,
  explicitIso
});
          const patchedDraft = {
            ...(draftR || {}),
            ...(nextDraft || {}),
            draftText: String(input || '').trim(),
            originalText: String(input || '').trim(),
            awaiting_edit: false,
            edit_started_at: null,
            editStartedAt: null,
            edit_flow_id: null
          };

          await upsertPA({
            ownerId,
            userId: paUserId,
            kind: PA_KIND_CONFIRM,
            payload: { ...(confirmPA?.payload || {}), draft: patchedDraft },
            ttlSeconds: PA_TTL_CONFIRM_SEC
          });

          // Do NOT auto-confirm after edit
          try {
            if (typeof mergePendingTransactionState === 'function') {
              await mergePendingTransactionState(paUserId, { _autoYesAfterEdit: false, _autoYesSourceMsgId: null });
            }
          } catch {}

          const displayDate =
            (typeof formatDisplayDate === 'function' ? formatDisplayDate(patchedDraft?.date, tz) : null) ||
            String(patchedDraft?.date || '').trim() ||
            '—';

          const displayAmt = String(patchedDraft?.amount || '').trim() || '—';
          const displayJob = String(patchedDraft?.jobName || '').trim() || '—';

          const summaryLine = `💰 ${displayAmt}\n📅 ${displayDate}\n🧰 ${displayJob}`;

return await sendConfirmRevenueOrFallback(from, summaryLine, {
  ownerId,
  paUserId,
  draft: patchedDraft,                 // ✅ correct: patched draft
  confirmPayload: confirmPA?.payload || null, // ✅ confirmPA is in scope
  type: 'revenue',
  sourceMsgId: String(confirmPA?.payload?.sourceMsgId || safeMsgId || sourceMsgId || '').trim() || null
});
        }

        // if still awaiting_edit and user sent a control token, never nag
        if (draftR?.awaiting_edit && isControl) {
          return out(
            twimlText(
              [
                '✏️ I’m waiting for your edited revenue details in ONE message.',
                'Example:',
                'revenue $2500 from ClientName on Jan 13 2026 job Oak Street Re-roof',
                'Reply "cancel" to discard.'
              ].join('\n')
            ),
            false
          );
        }
      } catch (e) {
        console.warn('[REVENUE_AWAITING_EDIT] failed (ignored):', e?.message);
        if (confirmPA?.payload?.draft?.awaiting_edit) {
          return out(
            twimlText(
              [
                '✏️ I’m waiting for your edited revenue details in ONE message.',
                'Example:',
                'revenue $2500 from ClientName on Jan 13 2026 job Oak Street Re-roof',
                'Reply "cancel" to discard.'
              ].join('\n')
            ),
            false
          );
        }
      }

      // ✅ Resume: re-send confirm for the existing pending revenue (no state changes)
      if (strictTok === 'resume') {
        try {
          return await resendConfirmRevenue({ from, ownerId, tz, paUserId });
        } catch (e) {
          console.warn('[REVENUE] resume confirm resend failed:', e?.message);
          const d = confirmPA?.payload?.draft || {};
const line =
  buildRevenueSummaryLine({
    amount: d.amount,
    source: d.source,
    date: d.date,
    jobName: d.jobName,
    tz
  }) || 'Confirm revenue?';

return await sendConfirmRevenueOrFallback(from, line, {
  ownerId,
  paUserId,
  draft: d,                             // ✅ correct draft
  confirmPayload: confirmPA?.payload || null,
  type: 'revenue',
  sourceMsgId: String(confirmPA?.payload?.sourceMsgId || sourceMsgId || '').trim() || null
});
        }
      }

      // ✅ Skip: keep current confirm draft pending, allow ONE new intake next.
      if (strictTok === 'skip') {
        try {
          await mergePendingTransactionState(paUserId, {
            kind: 'revenue',
            allow_new_while_pending: true,
            allow_new_set_at: Date.now()
          });
        } catch {}

        return out(
          twimlText(
            [
              'Okay — I’ll keep that revenue pending.',
              'Now send the *new* revenue you want to log.',
              'Tip: reply “resume” anytime to bring back the pending one.'
            ].join('\n')
          ),
          false
        );
      }

      // ✅ block new revenue intake while confirm pending (but allow if skip flag set)
      if (!strictTok && looksLikeNewRevenueText(input)) {
        let pendingNow = null;
        try { pendingNow = await getPendingTransactionState(paUserId); } catch {}
        const allowNew = !!pendingNow?.allow_new_while_pending;

        if (!allowNew) {
          return out(
            twimlText(
              'One sec 🙂 You still have a revenue draft open.\n' +
                'Reply: "yes" / "edit" / "change job" / "skip" / "cancel".'
            ),
            false
          );
        }
        // consume the allow-one flag and fall through to new intake parsing
        try {
          await mergePendingTransactionState(paUserId, { allow_new_while_pending: false, allow_new_set_at: null });
        } catch {}
      }

      const stableMsgId =
        String(confirmPA?.payload?.sourceMsgId || '').trim() ||
        String(sourceMsgId || '').trim() ||
        String(`${from}:${Date.now()}`).trim();

      if (strictTok === 'change_job') {
  const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));

  if (!jobs.length) {
    // ✅ Create-first-job path (no one gets stuck)
    await upsertPA({
      ownerId,
      userId: paUserId,
      kind: PA_KIND_PICK_JOB,
      payload: {
        allowCreateJob: true,
        flow: 'revenue',
        context: 'revenue_jobpick_create_first',
        confirmFlowId:
          String(confirmPA?.payload?.sourceMsgId || '').trim() ||
          String(sourceMsgId || '').trim() ||
          String(`${paUserId}:${Date.now()}`).trim(),
        sentAt: Date.now(),
        jobOptions: [],
        confirmDraft: confirmPA?.payload?.draft || null
      },
      ttlSeconds: PA_TTL_PICK_SEC
    });

    return out(
      twimlText(
        [
          'You don’t have any jobs yet.',
          '',
          'Reply with your first job name (just the name), or reply "Overhead".',
          'Example: Oak Street Re-roof'
        ].join('\n')
      ),
      false
    );
  }

  return await sendJobPickerOrFallback({
    from,
    ownerId,
    paUserId,
    jobOptions: jobs,
    page: 0,
    pageSize: 8,
    confirmDraft: confirmPA?.payload?.draft || null,
    context: 'revenue_jobpick'
  });
}


  if (strictTok === 'edit') {
  // ✅ enter edit mode (do NOT delete confirm PA)
  try {
    await upsertPA({
      ownerId,
      userId: paUserId,
      kind: PA_KIND_CONFIRM,
      payload: {
        ...(confirmPA?.payload || {}),
        draft: {
          ...(confirmPA?.payload?.draft || {}),

          awaiting_edit: true,

          // ✅ critical: do not let awaiting_date hijack edit payload
          awaiting_date: false,
          needsReparse: false,

          edit_started_at: Date.now(),
          editStartedAt: Date.now(),
          edit_flow_id:
            String(confirmPA?.payload?.sourceMsgId || stableMsgId || '').trim() || null
        }
      },
      ttlSeconds: PA_TTL_CONFIRM_SEC
    });
  } catch {}

  return out(
    twimlText(
      [
        '✏️ Okay — send the corrected revenue details in ONE message.',
        'Example:',
        'revenue $2500 from ClientName on Jan 13 2026 job Oak Street Re-roof',
        'Reply "cancel" to discard.'
      ].join('\n')
    ),
    false
  );
}


  // ✅ Resume: re-send confirm (no state changes)
  if (strictTok === 'resume') {
    try {
      const r = await resendConfirmRevenue({ from, ownerId, tz, paUserId });
      if (r) return r;
    } catch {}
    // fallback: generic
    return out(
      twimlText(
        'You still have a revenue draft open.\n' +
          'Tap Yes/Edit/Change Job/Cancel to finish it. If you want to start over, reply "Cancel".'
      ),
      false
    );
  }

  if (strictTok === 'cancel') {
    await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
    try {
      await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB });
    } catch {}
    return out(twimlText('❌ Operation cancelled.'), false);
  }

 
if (strictTok === 'yes') {
  console.info('[REVENUE_YES_ENTER]', {
    ownerId,
    paUserId,
    from,
    msgSid: String(twilioMeta?.MessageSid || twilioMeta?.SmsMessageSid || '').trim() || null
  });

  try {
    // Always operate on freshest confirm PA
    let confirmPAFresh = null;
    try {
      confirmPAFresh = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
    } catch (e) {
      console.warn('[REVENUE_YES] getPA failed:', e?.message);
      confirmPAFresh = confirmPA || null;
    }

    const rawDraft =
      confirmPAFresh?.payload?.draft && typeof confirmPAFresh.payload.draft === 'object'
        ? { ...confirmPAFresh.payload.draft }
        : null;

    // ✅ If confirm is gone (expired / cleared), DO NOT fall through to agent
    if (!rawDraft || !Object.keys(rawDraft).length) {
      return out(
        twimlText(
          [
            '⏱️ That confirmation expired.',
            'Please resend the revenue in one message.',
            'Example: revenue $4580 on Dec 21 2025 job 1556 Medway Park Dr'
          ].join('\n')
        ),
        false
      );
    }

    console.info('[REVENUE_YES_DRAFT]', {
      hasDraft: !!rawDraft,
      keys: Object.keys(rawDraft).slice(0, 25),
      amount: rawDraft?.amount,
      date: rawDraft?.date,
      jobName: rawDraft?.jobName,
      job_no: rawDraft?.job_no,
      job_id: rawDraft?.job_id,
      awaiting_edit: !!rawDraft?.awaiting_edit,
      awaiting_date: !!rawDraft?.awaiting_date
    });

    // ✅ If user is still in edit mode, do NOT submit
    if (rawDraft?.awaiting_edit) {
      return out(
        twimlText(
          [
            '✏️ I’m still waiting for your edited revenue details in ONE message.',
            'Example:',
            'revenue $2500 on Jan 13 2026 job Oak Street Re-roof',
            'Reply "cancel" to discard.'
          ].join('\n')
        ),
        false
      );
    }

    // ✅ If waiting for date, do NOT submit
    if (rawDraft?.awaiting_date) {
      return out(
        twimlText(`📅 I still need the date.\nReply "today", "yesterday", or "2026-01-13".`),
        false
      );
    }

    // Normalize draft
    let data = normalizeRevenueData(rawDraft, tz);

    // ✅ CRITICAL: coerce amount to number at DB boundary
    const amountNum = toNumericAmount(data.amount);
    if (!amountNum || amountNum <= 0) {
      return out(twimlText('I couldn’t read the amount. Reply "edit" and resend the amount.'), false);
    }
    const amountCents = Math.round(amountNum * 100);

    // Prefer normalized date, but fallback to rawDraft if normalization ever drops it
    const dateStr =
      String(data?.date || '').trim() ||
      String(rawDraft?.date || '').trim() ||
      '';

    if (!dateStr) {
      return out(twimlText(`I’m missing the date. Reply like: "on 2026-01-13".`), false);
    }

    // ✅ Job resolution (job choice must win)
    let jobName = normalizeJobNameCandidate(data.jobName) || null;
    let jobSource = jobName ? (data.jobSource || rawDraft.jobSource || 'typed') : null;

    if (jobName && looksLikeOverhead(jobName)) {
      jobName = 'Overhead';
      jobSource = 'overhead';
    }

    if (!jobName) {
      jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
      if (jobName) jobSource = 'active';
    }

    if (jobName && looksLikeOverhead(jobName)) {
      jobName = 'Overhead';
      jobSource = 'overhead';
    }

    // If still no job, force picker (keep confirm)
    if (!jobName) {
      const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
      if (!jobs.length) return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);

      // refresh confirm TTL while we’re here (best-effort)
      try {
        await upsertPA({
          ownerId,
          userId: paUserId,
          kind: PA_KIND_CONFIRM,
          payload: { ...(confirmPAFresh?.payload || {}), draft: rawDraft, sentAt: Date.now() },
          ttlSeconds: PA_TTL_CONFIRM_SEC
        });
      } catch {}

      return await sendJobPickerOrFallback({
        from,
        ownerId,
        paUserId,
        jobOptions: jobs,
        page: 0,
        pageSize: 8,
        confirmDraft: {
          ...data,
          jobName: null,
          jobSource: null,
          job_no: null,
          job_id: null,
          originalText: rawDraft?.originalText || rawDraft?.draftText || null,
          draftText: rawDraft?.draftText || rawDraft?.originalText || null
        }
      });
    }

    data.jobName = jobName;
    data.jobSource = jobSource;

    // Category (keep your existing behavior)
    let categoryStr =
      (data?.suggestedCategory && String(data.suggestedCategory).trim()) ||
      (rawDraft?.suggestedCategory && String(rawDraft.suggestedCategory).trim()) ||
      null;

    if (!categoryStr) {
      try {
        const c = (await withTimeout(Promise.resolve(categorizeEntry('revenue', data, ownerProfile)), 1200, null)) || null;
        if (c && String(c).trim()) categoryStr = String(c).trim();
      } catch {}
    }

    // ✅ Canonical sourceMsgId for DB (prefer PA sourceMsgId)
    const txSourceMsgId =
      String(confirmPAFresh?.payload?.sourceMsgId || '').trim() ||
      String(sourceMsgId || '').trim() ||
      null;

    // ✅ CIL validation (keep)
    const cilCheck = assertRevenueCILOrClarify({
      from,
      data,
      jobName,
      category: categoryStr,
      sourceMsgId: txSourceMsgId
    });

    if (!cilCheck?.ok) {
      return out(twimlText(cilCheck?.reply || '⚠️ Could not log that revenue yet.'), false);
    }

    const sourceForDb = String(data.source || '').trim() || 'Unknown';
    const descForDb = String(data.description || '').trim() || 'Revenue received';

    const insertFn = typeof pg.insertTransaction === 'function' ? pg.insertTransaction : insertTransaction;

    const ins = await insertFn({
      ownerId,
      owner_id: ownerId,
      userId: paUserId,
      user_id: paUserId,
      fromPhone: from,
      from,

      kind: 'revenue',

      date: String(dateStr),
      source: sourceForDb,
      description: descForDb,

      amount: amountNum,
      amount_cents: amountCents,

      jobName,
      jobSource,

      category: categoryStr,
      source_msg_id: txSourceMsgId || null
    });

    const txId =
      (ins && typeof ins === 'object' && ins.id != null) ? ins.id
      : (ins && typeof ins === 'object' && ins.transaction_id != null) ? ins.transaction_id
      : (typeof ins === 'string' || typeof ins === 'number') ? ins
      : null;

    console.info('[REVENUE_YES_INSERT_OK]', { txId });

    // ✅ Clear confirm + pick PA so we never loop
    try { await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }); } catch {}
    try { await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB }); } catch {}

    // ✅ Clear legacy pending flags (best-effort)
    try {
      const mergeFn =
        (typeof mergePendingTransactionState === 'function' && mergePendingTransactionState) ||
        (stateManager?.mergePendingTransactionState && stateManager.mergePendingTransactionState) ||
        null;

      if (mergeFn) {
        await mergeFn(paUserId, {
          pendingRevenue: false,
          awaitingRevenueJob: false,
          awaitingRevenueClarification: false,
          allow_new_while_pending: false,
          allow_new_set_at: null,

          pendingRevenueFlow: false,
          awaitingRevenuePick: false,

          _autoYesAfterEdit: false,
          _autoYesSourceMsgId: null
        });
      }
    } catch (e) {
      console.warn('[REVENUE_YES] clear pending state failed (ignored):', e?.message);
    }

    // Best-effort: persist active job (skip overhead)
    try {
      if (jobName && !looksLikeOverhead(jobName)) {
        await persistActiveJobFromRevenue({
          ownerId,
          fromPhone: from,
          userProfile,
          jobNo: data?.job_no ?? data?.jobNo ?? null,
          jobName
        });
      }
    } catch (e) {
      console.warn('[REVENUE_YES] persistActiveJobFromRevenue failed (ignored):', e?.message);
    }

    const okMsg = [
      `✅ Logged revenue ${formatMoneyDisplay(amountNum)} — ${sourceForDb}`,
      dateStr ? `Date: ${dateStr}` : null,
      jobName ? `Job: ${jobName}` : null,
      categoryStr ? `Category: ${categoryStr}` : null
    ]
      .filter(Boolean)
      .join('\n');

    return out(twimlText(okMsg), false);
  } catch (e) {
    console.error('[REVENUE_YES] handler failed:', e?.message);
    return out(
      twimlText(`Something went wrong submitting that revenue. Reply "resume" and try again.`),
      false
    );
  }
} // ✅ end strictTok === 'yes'
 // ✅ If we’re still here, a confirm draft exists and user didn’t finish it.
      // Never fall through into new intake parsing.
      return out(
        twimlText(
          'You still have a revenue draft open.\n' +
            'Reply: "yes" / "edit" / "change job" / "skip" / "cancel".\n' +
            'Tip: reply "resume" to see it again.'
        ),
        false
      );
    } // ✅ end if (confirmPA?.payload?.draft)

  // ---- 3) New revenue parse (AI first-pass; keep behavior; beta hardening) ----

// IMPORTANT: do NOT force date here, or it will prevent awaiting_date from ever triggering.
// We want to know if the user explicitly provided a date.
const aiRes = await handleInputWithAI(from, input, 'revenue', parseRevenueMessage, REVENUE_DEFAULT_DATA, { tz });

let data = aiRes?.data || null;
// ---------------------------------------------------------
// ✅ NL revenue safety: handleInputWithAI can return null data
// for phrases like "Just got paid $X today from Job ..."
// Never mutate `data` unless it's an object.
// ---------------------------------------------------------
if (!data || typeof data !== 'object') {
  data = { ...(REVENUE_DEFAULT_DATA) };
}


let aiReply = aiRes?.reply || null;
// ---------------------------------------------------------
// ✅ Ignore AI clarifiers about payer/source (optional in MVP)
// We only want AI clarifiers when amount is missing.
// Job is resolved deterministically (active job / picker).
// ---------------------------------------------------------
try {
  const r = String(aiReply || '').toLowerCase();
  const hasSourceClarifier =
    r.includes('specify the source') ||
    (r.includes('source of the revenue') && r.includes('for example'));

  // If AI is asking about source, drop the reply and continue the deterministic flow
  if (hasSourceClarifier) {
    console.info('[REVENUE] ignoring AI source-clarifier (source optional)');
    aiReply = null;
  }
} catch {}
// Track whether we had a real date BEFORE normalization defaults
const rawDateBeforeNormalize = data?.date != null ? String(data.date).trim() : '';

// Normalize everything else, but we will decide date explicitly below
if (data) data = normalizeRevenueData(data, tz);
// ---------------------------------------------------------
// ✅ Harden parsed fields (new revenue intake)
// - Prevent job clause from bleeding into source
// - Prevent date-ish tokens like "today" from becoming payer/source
// ---------------------------------------------------------
if (data?.source) {
  data.source = stripJobClause(data.source);
  if (isDateishSource(data.source)) data.source = '';
}



// --------------------
// ✅ Decide the date
// --------------------

// 1) If parser gave a usable ISO date, keep it
let finalDate = isIsoDate(rawDateBeforeNormalize) ? rawDateBeforeNormalize : null;


// 2) If user typed a relative date anywhere in the message, use it
if (!finalDate) {
  const t = String(input || '').toLowerCase();
  if (/\btoday\b/.test(t)) finalDate = todayInTimeZone(tz);
  else if (/\byesterday\b/.test(t)) {
    // if you have a helper for yesterday, use it; otherwise compute from todayInTimeZone
    try {
      const td = todayInTimeZone(tz);
      const d = new Date(`${td}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      finalDate = d.toISOString().slice(0, 10);
    } catch {}
  } else {
    const rel = parseRelativeDateReply(input, tz);
    if (rel) finalDate = rel;
  }
}


// 3) If user said "just" and still no date, treat as today
if (!finalDate) {
  const inferred = inferDateFromJust(input, tz);
  if (inferred) finalDate = inferred;
}

// Apply chosen date (or keep null so we can latch awaiting_date)
data.date = finalDate;

// --------------------
// ✅ Core parse checks
// --------------------
// ---------------------------------------------------------
// ✅ Deterministic amount fallback
// If AI misses the amount but user typed "$...", recover it.
// This prevents falling into AI clarifier prompts.
// ---------------------------------------------------------
if (!data?.amount || data.amount === '$0.00') {
  const n = parseMoneyAmountFromText(input);
  if (n != null) {
    data.amount = `$${n.toFixed(2)}`;
  }
}

// --------------------
// ✅ Core parse checks
// --------------------
const missingAmount = !data || !data.amount || data.amount === '$0.00';
if (aiReply && missingAmount) return out(twimlText(aiReply), false);


if (missingAmount) {
  return out(
    twimlText(`🤔 Couldn’t parse a revenue from "${input}". Try "received $2500 today for <job>".`),
    false
  );
}

let category = (await withTimeout(Promise.resolve(categorizeEntry('revenue', data, ownerProfile)), 1200, null)) || null;
if (category && String(category).trim()) category = String(category).trim();
else category = null;

// ---------------------------------------------------------
// ✅ Deterministic job capture for NL revenue
// Accepts:
//   - "... for job <name>"
//   - "... from job <name>"
//   - "... job <name>"          ✅ NEW
// Also strips date-ish tokens accidentally included at end.
// ---------------------------------------------------------
{
  const raw = String(input || '').trim();

  // Prefer tails like "for job ..." / "from job ..." / "job ..."
  // We anchor to end-of-message to avoid grabbing mid-sentence junk.
  const mJob =
    raw.match(/\bfor\s+job\b\s*[:\-]?\s*([^\n\r]+)$/i) ||
    raw.match(/\bfrom\s+job\b\s*[:\-]?\s*([^\n\r]+)$/i) ||
    raw.match(/\bjob\b\s*[:\-]?\s*([^\n\r]+)$/i); // ✅ NEW

  let jobFromText = mJob?.[1] ? String(mJob[1]).replace(/[.!,;:]+$/g, '').trim() : null;

  // ✅ remove trailing date-ish tokens accidentally included in job tail
  // examples: "1559 Medway Park Dr today" -> "1559 Medway Park Dr"
  if (jobFromText) {
    jobFromText = jobFromText
      .replace(/\b(on\s+)?(today|yesterday|tomorrow)\b\s*$/i, '')
      .replace(/\b(on\s+)?\d{4}-\d{2}-\d{2}\b\s*$/i, '')
      .replace(/\b(on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b.*$/i, (m) => m) // keep month forms; don't strip whole thing
      .trim();
  }

  if (jobFromText) {
    data.jobName = jobFromText;
    data.jobSource = 'typed';

    // If source accidentally contains "job ...", strip it
    if (data.source) {
      data.source = stripJobClause(data.source);
      if (isDateishSource(data.source)) data.source = '';
    }
  }

  // If user literally wrote "from job X", we should NOT keep that as payer/source
  if (/\bfrom\s+job\b/i.test(raw) || /\bjob\b/i.test(raw)) {
    if (data.source) {
      data.source = stripJobClause(data.source);
      if (isDateishSource(data.source)) data.source = '';
    }
  }
}

console.info('[REVENUE_NEW_JOB_CAPTURE]', {
  jobNameFromData: data?.jobName || null,
  jobSourceFromData: data?.jobSource || null,
  source: data?.source || null
});


let jobName = normalizeJobNameCandidate(data.jobName) || null;
let jobSource = jobName ? 'typed' : null;

if (!jobName) {
  jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
  if (jobName) jobSource = 'active';
}

if (jobName && looksLikeOverhead(jobName)) {
  jobName = 'Overhead';
  jobSource = 'overhead';
}

// ------------------------------------------------------
// ✅ If date is still missing/unusable, latch awaiting_date
// ------------------------------------------------------
if (!data?.date || !isIsoDate(data.date)) {
  await upsertPA({
    ownerId,
    userId: paUserId,
    kind: PA_KIND_CONFIRM,
    payload: {
      draft: {
        ...(data || {}),
        awaiting_date: true,
        // preserve job inference so the user only has to answer the date
        jobName: jobName || null,
        jobSource: jobName ? (jobSource || 'typed') : null,
        suggestedCategory: category,
        job_id: null,
        job_no: null,
        originalText: input,
        draftText: input
      },
      sourceMsgId: safeMsgId,
      type: 'revenue'
    },
    ttlSeconds: PA_TTL_CONFIRM_SEC
  });

  return out(
    twimlText(
      `Please specify the date you received the check.\n` +
        `Reply "today", "yesterday", or a date like "2026-01-13".`
    ),
    false
  );
}

// --------------------------------------
// ✅ Normal confirm PA upsert (date valid)
// --------------------------------------
await upsertPA({
  ownerId,
  userId: paUserId,
  kind: PA_KIND_CONFIRM,
  payload: {
    draft: {
      ...data,

      // ✅ alignment: job must reflect inference/pick logic (not stale parser fields)
      jobName: jobName || null,
      jobSource: jobName ? (jobSource || 'typed') : null,

      suggestedCategory: category,
      job_id: null,
      job_no: null,
      originalText: input,
      draftText: input
    },
    sourceMsgId: safeMsgId,
    type: 'revenue'
  },
  ttlSeconds: PA_TTL_CONFIRM_SEC
});

if (!jobName) {
  const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
  if (!jobs.length) return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);

  return await sendJobPickerOrFallback({
    from,
    ownerId,
    paUserId,
    jobOptions: jobs,
    page: 0,
    pageSize: 8,
    // ✅ alignment: job must be selected explicitly
    confirmDraft: { ...(data || {}), jobName: null, jobSource: null }
  });
}

const summaryLine = buildRevenueSummaryLine({
  amount: data.amount,
  source: data.source,
  date: data.date || todayInTimeZone(tz),
  jobName,
  tz
});

const confirmText = `${summaryLine}${buildActiveJobHint(jobName, jobSource)}`;

// ✅ debug why we chose template vs fallback (keep ~1 week)
try {
  const hasContentSid = !!String(process.env.TWILIO_REVENUE_CONFIRM_TEMPLATE_SID || '').trim();
  console.info('[REVENUE_CONFIRM_DISPATCH]', {
    hasContentSid,
    to: String(from || '').slice(0, 25),
    head: String(confirmText || '').slice(0, 60)
  });
} catch {}

return await sendConfirmRevenueOrFallback(from, confirmText, {
  ownerId,
  paUserId,
  draft: data,                          // ✅ correct: the parsed data becomes the draft
  confirmPayload: {
    draft: data,
    sourceMsgId: safeMsgId,
    type: 'revenue'
  },
  type: 'revenue',
  sourceMsgId: String(safeMsgId || sourceMsgId || '').trim() || null
});



  } catch (error) {
    console.error(`[ERROR] handleRevenue failed for ${from}:`, error?.message, {
      code: error?.code,
      detail: error?.detail,
      constraint: error?.constraint
    });
    return out(twimlText('⚠️ Error logging revenue. Please try again.'), false);
  }
}

module.exports = { handleRevenue };
