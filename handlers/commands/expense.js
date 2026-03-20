// handlers/commands/expense.js
// COMPLETE DROP-IN (aligned to postgres.js + revenue.js)
//
// ✅ Beta-ready alignment highlights:
// - Pending actions are KIND-aware and aligned to postgres.js helpers:
//   • pg.getPendingActionByKind / pg.upsertPendingAction / pg.deletePendingActionByKind
//   • SQL fallback with TTL window if helpers missing
// - JOB_NO-FIRST rule enforced (never trusts numeric job_id; only UUID goes to job_id)
// - Job picker supports: jobno_<job_no>, jobix_<row>, numeric replies, exact name, overhead, more, change job
// - Confirm flow: confirm → (optional job picker) → confirm again
// - Deterministic parse first, AI fallback, strong "Unknown item" recovery
// - DB timeout UX: keeps confirm PA and asks user to tap Yes again
// - Persists active job after successful log
//
// Signature:
//   handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId)

const pg = require('../../services/postgres');
const twilioSvc = require('../../services/twilio');
// --- Node crypto (do NOT rely on variable name "crypto" being unshadowed)
const nodeCrypto = require('crypto');
const { normalizeJobNameCandidate } = require('../../utils/jobNameUtils');
const { getEffectivePlanFromOwner } = require("../../src/config/effectivePlan");

const {
  sendWhatsAppInteractiveList,
  sendWhatsApp,
  sendQuickReply,
  sendTemplateMessage,
  sendTemplateQuickReply,
  toWhatsApp,
  sendWhatsAppTemplate
} = twilioSvc;

const { query, insertTransaction } = pg;

const ai = require('../../utils/aiErrorHandler');
const handleInputWithAI = ai.handleInputWithAI;
const parseExpenseMessage = ai.parseExpenseMessage;

const cilMod = require('../../cil');
const validateCIL =
  (cilMod && typeof cilMod.validateCIL === 'function' && cilMod.validateCIL) ||
  (cilMod && typeof cilMod.validateCil === 'function' && cilMod.validateCil) ||
  (cilMod && typeof cilMod.validate === 'function' && cilMod.validate) ||
  (typeof cilMod === 'function' && cilMod) ||
  null;


const getCategorySuggestion =
  (typeof pg.getCategorySuggestion === 'function' && pg.getCategorySuggestion) || (async () => null);

const normalizeVendorName =
  (typeof pg.normalizeVendorName === 'function' && pg.normalizeVendorName) ||
  (typeof pg.normalizeVendor === 'function' && pg.normalizeVendor) ||
  (async (_ownerId, vendor) => {
    const s = String(vendor || '').trim();
    return s || 'Unknown Store';
  });

const todayInTimeZone =
  (typeof pg.todayInTZ === 'function' && pg.todayInTZ) ||
  (typeof ai.todayInTimeZone === 'function' && ai.todayInTimeZone) ||
  (() => new Date().toISOString().split('T')[0]);

const parseNaturalDateTz =
  (typeof ai.parseNaturalDate === 'function' && ai.parseNaturalDate) ||
  ((s, _tz) => {
    const t = String(s || '').trim().toLowerCase();
    const today = new Date().toISOString().split('T')[0];
    if (!t || t === 'today') return today;
    if (t === 'yesterday') {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().split('T')[0];
    }
    if (t === 'tomorrow') {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().split('T')[0];
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().split('T')[0];
    return null;
  });

const categorizeEntry = (typeof ai.categorizeEntry === 'function' && ai.categorizeEntry) || (async () => null);
const { canEmployeeSelfLog, getPlanOrDefault } = require("../../src/config/checkCapability");
const { logCapabilityDenial } = require("../../src/lib/capabilityDenials");
const { PRO_CREW_UPGRADE_LINE, UPGRADE_FOLLOWUP_ASK } = require("../../src/config/upgradeCopy");


/* ---------------- Pending Actions (KIND-AWARE; postgres.js-aligned) ---------------- */

const PA_KIND_PICK_JOB = 'pick_job_for_expense';
exports.PA_KIND_PICK_JOB = PA_KIND_PICK_JOB;

const PA_KIND_CONFIRM = 'confirm_expense';

const PA_KIND_REVIEW_ITEMS = 'review_receipt_items';

const PA_TTL_MIN = Number(process.env.PENDING_TTL_MIN || 10);
const PA_TTL_SEC = PA_TTL_MIN * 60;
exports.PA_TTL_SEC = PA_TTL_SEC;

const pgGetPendingActionByKind =
  (typeof pg.getPendingActionByKind === 'function' && pg.getPendingActionByKind) || null;

// postgres.js exposes: upsertPendingAction({ownerId,userId,kind,payload,ttlSeconds})
const pgUpsertPendingAction =
  (typeof pg.upsertPendingAction === 'function' && pg.upsertPendingAction) ||
  (typeof pg.savePendingAction === 'function' && pg.savePendingAction) ||
  null;

const pgDeletePendingActionByKind =
  (typeof pg.deletePendingActionByKind === 'function' && pg.deletePendingActionByKind) || null;

// postgres.js also has deletePendingAction(arg) which can route by {ownerId,userId,kind}
const pgDeletePendingActionSmart = (typeof pg.deletePendingAction === 'function' && pg.deletePendingAction) || null;

function DIGITS_ID(v) {
  return String(v ?? '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\D/g, '')
    .trim();
}

function PA_USER_KEY(userId) {
  const raw = String(userId || '').trim();
  const dig = DIGITS_ID(raw);
  return dig || raw; // ✅ never drop to null if raw exists
}
function PA_OWNER_KEY(ownerId) {
  const raw = String(ownerId || '').trim();
  const dig = DIGITS_ID(raw);
  return dig || raw;
}
function normalizeDateTextForParse(s) {
  let t = String(s || '');
  t = t.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1');      // 1st -> 1
  t = t.replace(/\b(\d{4})\s+(\d)\b/g, '$1$2');            // 2020 5 -> 20205
  t = t.replace(/\b(19|20)(\d0\d)\b/g, (m, c, rest) => {   // 20205 -> 2025 (only for x0y pattern)
    return `${c}${rest[0]}${rest[2]}`;
  });
  return t;
}

// =========================================================
// Emoji / summary normalization for expense edit payloads
// - Converts "✅ $14.21 Home Hardware Sept 27 job Oak" →
//   "expense $14.21 from Home Hardware on Sept 27 job Oak"
// - Strips common UI emojis and bullet glyphs
// - Normalizes commas in money and common separators
// =========================================================
function normalizeEditedExpense(raw) {
  let s = String(raw || '').trim();
  if (!s) return s;

  // Normalize unicode dashes / bullets to spaces
  s = s
    .replace(/[\u2012\u2013\u2014\u2015]/g, '-') // en/em dashes → '-'
    .replace(/[•·∙●◦]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip common "confirm UI" words that users paste back
  // (but keep the important tokens like amount/store/date/job)
  s = s.replace(/\bconfirm\s+expense\b/i, '').trim();

  // Remove leading "✅ Confirm ..." patterns
  s = s.replace(/^✅\s*/u, '').trim();

  // Remove common emojis that appear in summaries
  // (leave text + numbers intact)
  s = s.replace(
    /[✅🧾💳💰🪙💵🏦🛒🧰🔧🧱📅🗓️🕒⏱️📍🏷️🧾]/gu,
    ' '
  );

  // Normalize currency symbols (keep $ but normalize spacing)
  s = s.replace(/\s*\$\s*/g, ' $');

  // Normalize money commas: "$4,500" -> "$4500"
  s = s.replace(/\$(\d{1,3})(,\d{3})+(?=\b)/g, (m) => m.replace(/,/g, ''));

  // If user didn't include the word "expense" anywhere, add a prefix.
  // This makes downstream parsing more consistent.
  const hasExpenseKeyword = /\bexpense\b/i.test(s);
  if (!hasExpenseKeyword) {
    s = `expense ${s}`.trim();
  }

  // Light canonical phrases (helps the parser)
  // Convert "at Home Depot" / "from Home Depot" consistently
  // (Don't overdo it; keep it tolerant.)
  s = s.replace(/\s+@+\s+/g, ' at ');
  s = s.replace(/\s+from\s+/gi, ' from ');
  s = s.replace(/\s+on\s+/gi, ' on ');
  s = s.replace(/\s+job\s*[:\-]?\s*/gi, ' job ');

  // Final whitespace cleanup
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

function extractExplicitDateFromText(rawText, tz) {
  const s0 = String(rawText || '').trim();
  if (!s0) return null;

  // normalize ordinals + "2020 5" year spacing etc
  const s = (typeof normalizeDateTextForParse === 'function')
    ? normalizeDateTextForParse(s0)
    : s0;

  // 1) ISO
  let m = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (m?.[1]) return parseNaturalDateTz(m[1], tz);

  // 2) Month name date: "January 1, 2025" (optionally preceded by "on")
  m = s.match(/\b(?:on\s+)?([A-Za-z]{3,9}\s+\d{1,2}(?:,\s*)?\s+\d{4})\b/);
  if (m?.[1]) return parseNaturalDateTz(m[1], tz);

  // 3) Slash date: 1/1/2025
  m = s.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  if (m?.[1]) return parseNaturalDateTz(m[1], tz);

  return null;
}


async function getPA({ ownerId, userId, kind }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  const k = String(kind || '').trim();
  if (!owner || !user || !k) return null;

  const ownerKey = PA_OWNER_KEY(owner);
const userKey = PA_USER_KEY(user);
if (!ownerKey || !userKey) return;


  if (pgGetPendingActionByKind) {
    try {
      const r = await pgGetPendingActionByKind({ ownerId: ownerKey, userId: userKey, kind: k });
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
      [ownerKey, userKey, String(k), String(PA_TTL_MIN)]
    );
    return r?.rows?.[0] || null;
  } catch {
    return null;
  }
}
exports.getPA = getPA;

async function upsertPA({ ownerId, userId, kind, payload, ttlSeconds = PA_TTL_SEC }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  const k = String(kind || '').trim();
  if (!owner || !user || !k) return;

  const ttl = Number(ttlSeconds || PA_TTL_SEC) || PA_TTL_SEC;

  // ✅ normalize IDs once
  const ownerKey = PA_OWNER_KEY(owner);
const userKey = PA_USER_KEY(user);
if (!ownerKey || !userKey) return;


  if (pgUpsertPendingAction) {
    try {
      await pgUpsertPendingAction({ ownerId: ownerKey, userId: userKey, kind: k, payload, ttlSeconds: ttl });
      return;
    } catch (e) {
      console.warn('[PA] pg.upsertPendingAction failed; falling back:', e?.message);
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
      [ownerKey, userKey, String(k), JSON.stringify(payload || {})]
    );
  } catch (e) {
    // If no unique index exists, fall back to delete+insert
    try {
      await query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [
        ownerKey,
        userKey,
        String(k)
      ]);
      await query(
        `
        INSERT INTO public.pending_actions (owner_id, user_id, kind, payload, created_at)
        VALUES ($1, $2, $3, $4::jsonb, NOW())
        `,
        [ownerKey, userKey, String(k), JSON.stringify(payload || {})]
      );
    } catch {}
    console.warn('[PA] upsert fallback failed (ignored):', e?.message);
  }
}
exports.upsertPA = upsertPA;


async function deletePA({ ownerId, userId, kind }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  const k = String(kind || '').trim();
  if (!owner || !user || !k) return;

  const ownerKey = PA_OWNER_KEY(owner);
const userKey = PA_USER_KEY(user);
if (!ownerKey || !userKey) return;


  if (pgDeletePendingActionByKind) {
    try {
      await pgDeletePendingActionByKind({ ownerId: ownerKey, userId: userKey, kind: k });
      return;
    } catch (e) {
      console.warn('[PA] deletePendingActionByKind failed; falling back:', e?.message);
    }
  }

  if (pgDeletePendingActionSmart) {
    try {
      await pgDeletePendingActionSmart({ ownerId: ownerKey, userId: userKey, kind: k });
      return;
    } catch {
      // fall through
    }
  }

  if (typeof query !== 'function') return;
  try {
    await query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [
      ownerKey,
      userKey,
      String(k)
    ]);
  } catch {}
}
exports.deletePA = deletePA;

async function ensureConfirmPAExists({ ownerId, userId = null, from = null, draft, sourceMsgId }) {
  // ✅ CONFIRM PA is keyed by the provided userId/paKey (canonical digits string)
  const paKey = String(userId || '').trim() || String(from || '').replace(/\D/g, '');
  if (!paKey) return;

  const existing = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
  if (existing?.payload?.draft) return;

  await upsertPA({
    ownerId,
    userId: paKey,
    kind: PA_KIND_CONFIRM,
    payload: {
      draft,
      sourceMsgId: sourceMsgId || null,
      type: 'expense'
    },
    ttlSeconds: PA_TTL_SEC
  });
}

function pickConfirmDraftSnapshot(d) {
  if (!d || typeof d !== 'object') return null;

  return {
    // core confirm fields
    amount: d.amount ?? null,
    item: d.item ?? null,
    store: d.store ?? null,
    date: d.date ?? null,

    // job-related
    jobName: d.jobName ?? null,
    jobSource: d.jobSource ?? null,
    job_no: d.job_no ?? null,
    job_id: d.job_id ?? null,

    // helpful recovery text (short)
    originalText: d.originalText ?? null,
    draftText: d.draftText ?? null
  };
}


/* ---------------- Trade-term correction layer ---------------- */

function correctTradeTerms(text) {
  let s = String(text || '');
  s = s.replace(/\bgen\s*tech\b/gi, 'Gentek');
  s = s.replace(/\bgentech\b/gi, 'Gentek');
  s = s.replace(/\bgentek\b/gi, 'Gentek');
  s = s.replace(/\bsighting\b/gi, 'siding');
  s = s.replace(/\bsoffet\b/gi, 'soffit');
  s = s.replace(/\bfacia\b/gi, 'fascia');
  s = s.replace(/\beaves\s*trough\b/gi, 'eavestrough');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
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

exports.twimlEmpty = twimlEmpty;

function out(twiml, sentOutOfBand = false) {
  return { twiml, sentOutOfBand: !!sentOutOfBand };
}
exports.out = out;

function waTo(fromPhone) {
  const d = String(fromPhone || '').replace(/\D/g, '');
  return d ? `whatsapp:+${d}` : null;
}
exports.waTo = waTo;


function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error('Missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN');
  const twilio = require('twilio');
  return twilio(accountSid, authToken);
}

function getSendFromConfig() {
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || null;
  const waFrom = process.env.TWILIO_WHATSAPP_FROM || null;
  if (!waFrom && !messagingServiceSid) throw new Error('Missing TWILIO_WHATSAPP_FROM or TWILIO_MESSAGING_SERVICE_SID');
  return { waFrom, messagingServiceSid };
}

function getExpenseConfirmTemplateSid() {
  return (
    process.env.TWILIO_EXPENSE_CONFIRM_TEMPLATE_SID ||
    process.env.EXPENSE_CONFIRM_TEMPLATE_SID ||
    process.env.TWILIO_TEMPLATE_EXPENSE_CONFIRM_SID ||
    null
  );
}

function toTemplateVar(str) {
  return (
    String(str || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 900) || '—'
  );
}


function buildActiveJobHint(jobName, jobSource) {
  if (jobSource !== 'active' || !jobName) return '';
  return `\n\n🧠 Using active job: ${jobName}\nTip: reply "change job" to pick another`;
}

/**
 * sendConfirmExpenseOrFallback
 * - Sends confirm UI via approved content template when available
 * - Falls back to quick replies
 * - Final fallback to TwiML
 *
 * IMPORTANT: accepts optional ctx so we can log exactly what job/date/vendor will render.
 */
async function sendConfirmExpenseOrFallback(fromPhone, summaryLine, ctx = null) {
  const to = waTo(fromPhone);
  const templateSid = getExpenseConfirmTemplateSid();

  // Defensive: keep templates happy + avoid OCR garbage explosions
  const safeSummary = String(summaryLine || '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);

  const bodyText =
    `✅ Confirm expense\n${safeSummary}\n\n` +
    `Reply: Yes / Edit / Cancel / Change Job`;

  // ✅ Render-time truth log
  try {
    console.info('[EXPENSE_CONFIRM_RENDER_CTX]', {
      ownerId: ctx?.ownerId ?? null,
      paUserId: ctx?.paUserId ?? null,
      fromPhone: String(fromPhone || '').trim() || null,

      draft_job_id: ctx?.draft?.job_id ?? ctx?.draft?.jobId ?? null,
      draft_job_no: ctx?.draft?.job_no ?? null,
      draft_job_name:
        (ctx?.draft?.jobName || ctx?.draft?.job_name || ctx?.draft?.job_name_label || null),

      draft_amount: ctx?.draft?.amount ?? null,
      draft_store: ctx?.draft?.store ?? null,
      draft_date: ctx?.draft?.date ?? null,
      draft_item: ctx?.draft?.item ?? null,
      draft_subtotal: ctx?.draft?.subtotal ?? null,
      draft_tax: ctx?.draft?.tax ?? null,
      draft_total: ctx?.draft?.total ?? null,
      draft_taxLabel: ctx?.draft?.taxLabel ?? null,

      active_job_no: ctx?.activeJob?.job_no ?? null,
      active_job_name: ctx?.activeJob?.name ?? null,

      varsPreview: ctx?.varsPreview ?? null,
      safeSummaryHead: safeSummary.slice(0, 140),
      safeSummaryLen: safeSummary.length
    });
  } catch {}

  // ✅ 1) Best path: Content Template with buttons
  if (to && templateSid) {
    try {
      const msg = await sendWhatsAppTemplate({ to, templateSid, summaryLine: safeSummary });

      console.info('[EXPENSE_CONFIRM_SENT]', { to, sid: msg?.sid, status: msg?.status });
      return out(twimlEmpty(), true);
    } catch (e) {
      console.warn('[EXPENSE] confirm template send failed; falling back:', e?.message);
    }
  }

  // ✅ 2) Fallback path: 3 quick replies + explicit "change job" instruction
  if (to) {
    try {
      await sendQuickReply(to, `✅ Confirm expense\n${safeSummary}`, ['Yes', 'Edit', 'Cancel']);
      await sendWhatsApp(to, `🔁 To change the job, reply: "change job"`);
      return out(twimlEmpty(), true);
    } catch (e2) {
      console.warn('[EXPENSE] quick replies failed; falling back to TwiML:', e2?.message);
    }
  }

  // ✅ 3) Final fallback: TwiML
  return out(twimlText(bodyText), false);
}


// ------------------------------------------------------------------
// ✅ CIL Draft upsert for Expense Confirm UI
// Centralized: whenever we show a confirm UI, ensure a cil_drafts row exists.
// ------------------------------------------------------------------
async function upsertCilDraftForExpenseConfirm({
  ownerId,
  paUserId,
  fromPhone,
  draft,
  sourceMsgId
}) {
  try {
    if (!ownerId || !paUserId || !draft) return;

    const sid = String(sourceMsgId || '').trim() || null;

    // Best-effort: safe payload snapshot
    const payload = {
      type: 'ExpenseDraft',
      draft: {
        ...pickConfirmDraftSnapshot(draft),
        subtotal: draft?.subtotal ?? null,
        tax: draft?.tax ?? null,
        total: draft?.total ?? null,
        taxLabel: draft?.taxLabel ?? null
      },
      text_head: String(draft?.draftText || draft?.originalText || draft?.ocrText || '')
        .replace(/\u0000/g, '')
        .trim()
        .slice(0, 300)
    };

    const occurred_on = String(draft?.date || '').trim() || null;

    const amount_cents =
      draft?.amount_cents != null
        ? Number(draft.amount_cents)
        : null;

    const source = String(draft?.store || draft?.source || '').trim() || null;
    const description = String(draft?.item || draft?.description || '').trim() || null;
    const category = String(draft?.category || draft?.suggestedCategory || '').trim() || null;

    const job_id = draft?.job_id || draft?.jobId || null;
    const job_name = String(draft?.jobName || draft?.job_name || '').trim() || null;

    const media_asset_id = draft?.media_asset_id || draft?.mediaAssetId || null;

    await pg.createCilDraft({
      owner_id: ownerId,
      kind: 'expense',
      actor_user_id: paUserId,
      actor_phone: fromPhone || null,
      source_msg_id: sid,
      payload,
      occurred_on,
      amount_cents,
      source,
      description,
      job_id,
      job_name,
      category,
      media_asset_id
    });
  } catch (e) {
    console.warn('[CIL_DRAFT] upsertCilDraftForExpenseConfirm failed (ignored):', e?.message);
  }
}

function buildExpenseSummaryLine({
  amount,
  item,
  store,
  date,
  jobName,
  tz,
  sourceText,
  subtotal,
  tax,
  total,
  taxLabel
}) {
  const rawAmt = String(amount || '').trim();

  const amtNum = (() => {
    const n = Number(rawAmt.replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : NaN;
  })();

  const amt =
    Number.isFinite(amtNum) && amtNum > 0
      ? formatMoneyDisplay(amtNum)
      : rawAmt
        ? (rawAmt.startsWith('$')
            ? rawAmt
            : /^\d+(?:\.\d+)?$/.test(rawAmt)
              ? formatMoneyDisplay(Number(rawAmt))
              : rawAmt)
        : '$0.00';

  let it = cleanExpenseItemForDisplay(item);

  const looksBadItem =
    !it ||
    /^unknown\b/i.test(String(it || '')) ||
    /\b(returns?-and-refunds|store details|career with|www\.|http|rona\.ca)\b/i.test(String(it || '')) ||
    String(it || '').length > 100;

  if (looksBadItem && sourceText && typeof extractReceiptPrimaryItem === 'function') {
    const primary = extractReceiptPrimaryItem(sourceText);
    if (primary) it = cleanExpenseItemForDisplay(primary);
  }

  if (!it || /^unknown\b/i.test(String(it || ''))) it = 'Unknown';

  let st = String(store || '').trim();
  if ((!st || /^unknown\b/i.test(st)) && sourceText && typeof extractReceiptStore === 'function') {
    const receiptStore = extractReceiptStore(sourceText);
    if (receiptStore) st = String(receiptStore).trim();
  }
  if (!st) st = 'Unknown Store';

  const dt = String(date || '').trim() ? formatDisplayDate(date, tz) : null;
  const jb = jobName ? String(jobName).trim() : '';

  const taxInfo =
    typeof extractReceiptTaxBreakdown === 'function'
      ? extractReceiptTaxBreakdown(sourceText || '')
      : { subtotal: null, tax: null, total: null, taxLabel: null };

  const safeSubtotal =
    subtotal != null && Number.isFinite(Number(subtotal))
      ? Number(subtotal)
      : taxInfo?.subtotal != null && Number.isFinite(Number(taxInfo.subtotal))
        ? Number(taxInfo.subtotal)
        : null;

  const safeTax =
    tax != null && Number.isFinite(Number(tax))
      ? Number(tax)
      : taxInfo?.tax != null && Number.isFinite(Number(taxInfo.tax))
        ? Number(taxInfo.tax)
        : null;

  const safeTotal =
    total != null && Number.isFinite(Number(total))
      ? Number(total)
      : taxInfo?.total != null && Number.isFinite(Number(taxInfo.total))
        ? Number(taxInfo.total)
        : null;

  const safeTaxLabel =
    String(taxLabel || '').trim() ||
    String(taxInfo?.taxLabel || '').trim() ||
    'Tax';

  const lines = [];
  lines.push(`💸 ${amt} — ${it}`);
  if (st && st !== 'Unknown Store') lines.push(`🏪 ${st}`);
  if (dt) lines.push(`📅 ${dt}`);
  if (jb) lines.push(`🧰 ${jb}`);
  if (safeSubtotal != null) lines.push(`Subtotal: ${formatMoneyDisplay(safeSubtotal)}`);
  if (safeTax != null) lines.push(`${safeTaxLabel}: ${formatMoneyDisplay(safeTax)}`);
  if (safeTotal != null) lines.push(`Total: ${formatMoneyDisplay(safeTotal)}`);

  return lines.join('\n');
}

async function resendConfirmExpense({ fromPhone, ownerId, tz, paUserId, userProfile = null }) {
  const paKey = String(paUserId || '').trim();

  // ✅ Load first
  const confirmPA0 = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
  const draft0 = confirmPA0?.payload?.draft || null;

  if (!draft0 || !Object.keys(draft0).length) {
    return out(twimlText("couldn't"), false);
  }

  // ✅ Only reparse if explicitly requested AND not in edit flow
  if (draft0?.needsReparse && !draft0?.awaiting_edit) {
    try {
      if (userProfile && typeof maybeReparseConfirmDraftExpense === 'function') {
        await maybeReparseConfirmDraftExpense({ ownerId, paUserId: paKey, tz, userProfile });
      }
    } catch (e) {
      console.warn('[RESEND_CONFIRM] maybeReparseConfirmDraftExpense failed (ignored):', e?.message);
    }
  }

  // ✅ Reload after optional reparse
  const confirmPA = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
  const draft = confirmPA?.payload?.draft || draft0;

  const srcText =
    draft?.originalText ||
    draft?.receiptText ||
    draft?.ocrText ||
    draft?.draftText ||
    confirmPA?.payload?.humanLine ||
    confirmPA?.payload?.summaryLine ||
    '';

  const line =
    buildExpenseSummaryLine({
      amount: draft.amount,
      item: draft.item,
      store: draft.store,
      date: draft.date,
      jobName: draft.jobName,
      tz,
      sourceText: srcText,
      subtotal: draft.subtotal,
      tax: draft.tax,
      total: draft.total,
      taxLabel: draft.taxLabel
    }) || 'Confirm expense?';

  // ✅ Ensure CIL draft exists whenever we show confirm UI
  try {
    const srcId =
      String(confirmPA?.payload?.sourceMsgId || '').trim() ||
      String(confirmPA0?.payload?.sourceMsgId || '').trim() ||
      null;

    await upsertCilDraftForExpenseConfirm({
      ownerId,
      paUserId: paKey,
      fromPhone,
      draft,
      sourceMsgId: srcId
    });
  } catch {}

  // ✅ Optional: get active job for debug only
  let activeJob = null;
  try {
    if (typeof pg.getActiveJob === 'function') {
      activeJob = await pg.getActiveJob(ownerId, paKey).catch(() => null);
    }
  } catch {}

  return await sendConfirmExpenseOrFallback(fromPhone, line, {
    ownerId,
    paUserId: paKey,
    draft,
    activeJob
  });
}

function parseExpenseEditOverwrite(text) {
  const src = String(text || '').trim();
  if (!src) {
    return {
      amount: null,
      store: null,
      date: null,
      jobName: null,
      subtotal: null,
      tax: null,
      total: null
    };
  }

  const rawLines = src
    .split(/\r?\n/)
    .map((x) => String(x || '').trim())
    .filter(Boolean);

  const cleanedLines = rawLines.map((line) =>
    line.replace(/[💸🏪📅🧰]/g, ' ').replace(/\s+/g, ' ').trim()
  );

  let amount = null;
  let item = null;
  let store = null;
  let date = null;
  let jobName = null;
  let subtotal = null;
  let tax = null;
  let total = null;

  // ---------------------------------------------------------
  // item — extract from "— ITEM 🏪" (emoji) or "— ITEM at/on/job" (plain)
  // The emoji line may not be the first line (e.g. "Expense\n💸 ...")
  // so scan all raw lines.
  // ---------------------------------------------------------
  for (const rawLine of rawLines) {
    // Emoji-delimited: "— ITEM 🏪"
    const emojiMatch = rawLine.match(/—\s*(.+?)\s*🏪/u);
    if (emojiMatch?.[1]) {
      const candidate = emojiMatch[1].trim();
      if (candidate && !/^unknown$/i.test(candidate)) item = candidate;
      break;
    }
    // Plain-text: "— ITEM at/on/job" (no emojis)
    const plainMatch = rawLine.match(/—\s*(.+?)\s+(?:at|on|job)\b/i);
    if (plainMatch?.[1]) {
      const candidate = plainMatch[1].trim();
      if (candidate && !/^unknown$/i.test(candidate) && !/^\$/.test(candidate)) {
        item = candidate;
        break;
      }
    }
  }

  // ---------------------------------------------------------
  // amount
  // prefer first standalone money line
  // or explicit amount/total/price/cost line
  // ---------------------------------------------------------
    // Prefer explicit Total first
  for (const line of cleanedLines) {
    const m = line.match(/^\s*total\b\s*[:\-]?\s*\$?\s*(\d+(?:\.\d{1,2})?)\b/i);
    if (m?.[1]) {
      amount = `$${Number(m[1]).toFixed(2)}`;
      break;
    }
  }

  // Fallback to first standalone amount / explicit amount line
  if (!amount) {
    for (const line of cleanedLines) {
      if (
        /^\$?\s*\d+(?:\.\d{1,2})?\s*$/.test(line) ||
        /\b(amount|price|cost)\b/i.test(line)
      ) {
        const m = line.match(/\$?\s*(-?\d+(?:\.\d{1,2})?)\b/);
        if (m?.[1]) {
          amount = `$${Number(m[1]).toFixed(2)}`;
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------
  // date
  // ---------------------------------------------------------
  for (const line of cleanedLines) {
    const dateMatch =
      line.match(/\b(?:on\s+)?([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\b/i) ||
      line.match(/\b(?:on\s+)?(\d{4}-\d{2}-\d{2})\b/i) ||
      line.match(/\b(?:on\s+)?(\d{1,2}\/\d{1,2}\/\d{2,4})\b/i);

    if (dateMatch?.[1]) {
      const iso =
        typeof extractReceiptDateYYYYMMDD === 'function'
          ? extractReceiptDateYYYYMMDD(dateMatch[1])
          : null;

      date = iso || String(dateMatch[1]).trim();
      break;
    }
  }

  // ---------------------------------------------------------
  // job
  // MUST stop at a single line only
  // NEVER consume subtotal/tax/total pollution
  // ---------------------------------------------------------
  for (const line of cleanedLines) {
    const m =
      line.match(/^\s*job\b\s*[:\-]?\s*(.+)$/i) ||
      line.match(/^\s*for\s+job\s+(.+)$/i);

    if (m?.[1]) {
      const candidate = String(m[1] || '')
        .replace(/[.!,;:]+$/g, '')
        .trim();

      if (
        candidate &&
        !/\b(subtotal|tax|total)\b/i.test(candidate)
      ) {
        jobName = candidate;
        break;
      }
    }
  }

  // ---------------------------------------------------------
  // store/vendor — explicit label or "at VENDOR on/for" inline pattern
  // ---------------------------------------------------------
  for (const line of cleanedLines) {
    const m = line.match(/^\s*(?:from|at|store|vendor|merchant)\b\s*[:\-]?\s*(.+)$/i);
    if (m?.[1]) {
      const candidate = String(m[1] || '')
        .replace(/[.!,;:]+$/g, '')
        .trim();
      if (candidate) {
        store = candidate;
        break;
      }
    }
  }

  // Inline "at VENDOR on/for/job" pattern (plain-text no-emoji edits)
  if (!store) {
    for (const rawLine of rawLines) {
      const m = rawLine.match(/\bat\s+(.+?)\s+(?:on|for|job)\b/i);
      if (m?.[1]) {
        const candidate = m[1].trim();
        if (candidate && !/^\$/.test(candidate)) {
          store = candidate;
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------
  // fallback store/vendor
  // only allow short vendor-like lines
  // ---------------------------------------------------------
  if (!store) {
    for (const line of cleanedLines) {
      if (
        !/^\$/.test(line) &&
        !/\$/.test(line) &&
        !/^job\b/i.test(line) &&
        !/^on\b/i.test(line) &&
        !/^(subtotal|tax|hst|gst|pst|total)\b/i.test(line) &&
        !/^(expense|revenue|edit|confirm|unknown)\b/i.test(line) &&
        line.split(/\s+/).length <= 4 &&
        /[A-Za-z]/.test(line)
      ) {
        store = line.replace(/[.!,;:]+$/g, '').trim();
        break;
      }
    }
  }

  // ---------------------------------------------------------
  // subtotal / tax / total
  // ---------------------------------------------------------
  for (const line of cleanedLines) {
    let m = line.match(/^\s*subtotal\b\s*[:\-]?\s*\$?\s*(\d+(?:\.\d{1,2})?)\b/i);
    if (m?.[1]) subtotal = Number(m[1]).toFixed(2);

    m = line.match(/^\s*(?:tax|hst|gst|pst)\b\s*[:\-]?\s*\$?\s*(\d+(?:\.\d{1,2})?)\b/i);
    if (m?.[1]) tax = Number(m[1]).toFixed(2);

    m = line.match(/^\s*total\b\s*[:\-]?\s*\$?\s*(\d+(?:\.\d{1,2})?)\b/i);
    if (m?.[1]) total = Number(m[1]).toFixed(2);
  }

  return {
    amount,
    item,
    store,
    date,
    jobName,
    subtotal,
    tax,
    total
  };
}


async function maybeReparseConfirmDraftExpense({ ownerId, paUserId, tz, userProfile }) {
  const paKey = String(paUserId || '').trim();
  if (!paKey) return null;

  const confirmPA = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
  const draft = confirmPA?.payload?.draft || null;

  if (!confirmPA || !draft) return confirmPA;

  if (draft?.awaiting_edit) {
    console.info('[EXPENSE_REPARSE_SKIP_AWAITING_EDIT]', { paKey });
    return confirmPA;
  }

  if (!draft?.needsReparse) return confirmPA;

  const sourceText = String(
    draft?.receiptText ||
      draft?.ocrText ||
      draft?.extractedText ||
      draft?.originalText ||
      draft?.draftText ||
      ''
  ).trim();

  if (!sourceText) {
    console.warn('[EXPENSE_REPARSE] no sourceText; leaving needsReparse=true', { paKey });
    return confirmPA;
  }

  let parsed = {};
  try {
    parsed = (await parseExpenseMessage(sourceText, { tz })) || {};
  } catch {
    parsed = {};
  }

  const jobFields = {
    jobName: draft?.jobName ?? null,
    jobSource: draft?.jobSource ?? null,
    job_no: draft?.job_no ?? null,
    job_id: draft?.job_id ?? null
  };

  const mediaFields = {
    media_asset_id: draft?.media_asset_id ?? null,
    media_source_msg_id: draft?.media_source_msg_id ?? null
  };

  const receiptTaxInfo =
    typeof extractReceiptTaxBreakdown === 'function'
      ? extractReceiptTaxBreakdown(sourceText)
      : { subtotal: null, tax: null, total: null, taxLabel: null };

  const safePrimaryItem =
    typeof extractReceiptPrimaryItem === 'function'
      ? extractReceiptPrimaryItem(sourceText)
      : null;

  // Helper: returns the number as toFixed(2) string only if plausible receipt money
  const safeMoneyString = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(n)) return null;
    if (n <= 0 || n > 100000) return null;
    return n.toFixed(2);
  };

  // Helper: returns true if value is clearly garbage (SKU-scale or missing)
  const isClearlyBadMoney = (v) => {
    if (v == null) return true;
    const raw = String(v).trim();
    if (!raw) return true;
    const n = Number(raw.replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(n)) return true;
    if (n <= 0 || n > 100000) return true;
    if (!raw.includes('.') && raw.replace(/[^0-9]/g, '').length > 5) return true;
    return false;
  };

  // Receipt-derived values — these are the ground truth for this reparse
  const receiptSubtotalSafe = safeMoneyString(receiptTaxInfo?.subtotal);
  const receiptTaxSafe = safeMoneyString(receiptTaxInfo?.tax);
  const rawRTotal = receiptTaxInfo?.total != null && Number.isFinite(Number(receiptTaxInfo.total))
    ? Number(receiptTaxInfo.total) : null;
  const rawRSubtotal = receiptTaxInfo?.subtotal != null && Number.isFinite(Number(receiptTaxInfo.subtotal))
    ? Number(receiptTaxInfo.subtotal) : null;
  const rawRTax = receiptTaxInfo?.tax != null && Number.isFinite(Number(receiptTaxInfo.tax))
    ? Number(receiptTaxInfo.tax) : null;

  const rTotalLooksLikeSubtotal =
    rawRTotal != null && rawRSubtotal != null && rawRTax != null &&
    Math.abs(rawRTotal - rawRSubtotal) < 0.01;

  const correctedReceiptTotal = rTotalLooksLikeSubtotal
    ? Number((rawRSubtotal + rawRTax).toFixed(2))
    : rawRTotal;

  const receiptTotalSafe = safeMoneyString(correctedReceiptTotal);
  const parsedAmountSafe = safeMoneyString(parsed?.amount);

  // Old draft values — only used as fallback if receipt-derived values are missing
  const draftSubtotalSafe = safeMoneyString(draft?.subtotal);
  const draftTaxSafe = safeMoneyString(draft?.tax);
  const draftTotalSafe = safeMoneyString(draft?.total);

  const mergedDraft = mergeDraftNonNull(
    {
      ...(draft || {}),
      ...jobFields,
      ...mediaFields
    },
    {
      ...(parsed || {}),
      ...jobFields,
      ...mediaFields,

      item:
        safePrimaryItem ||
        parsed?.item ||
        null,

      // receipt-derived always wins over poisoned draft
      subtotal:
        receiptSubtotalSafe ||
        draftSubtotalSafe ||
        null,

      tax:
        receiptTaxSafe ||
        draftTaxSafe ||
        null,

      total:
        receiptTotalSafe ||
        draftTotalSafe ||
        parsedAmountSafe ||
        null,

      taxLabel:
        String(receiptTaxInfo?.taxLabel || '').trim() ||
        String(draft?.taxLabel || '').trim() ||
        null
    }
  );

  const normalized = normalizeExpenseData(mergedDraft, userProfile, sourceText) || {};

  // Item: backfill if still unknown after normalize
  if (
    (typeof isUnknownItem === 'function' && isUnknownItem(normalized.item)) ||
    !String(normalized.item || '').trim() ||
    /^unknown$/i.test(String(normalized.item || '').trim())
  ) {
    if (safePrimaryItem) normalized.item = safePrimaryItem;
  }

  // Tax fields: receipt-derived wins, then draft fallback, then normalized
  normalized.subtotal =
    receiptSubtotalSafe ||
    draftSubtotalSafe ||
    safeMoneyString(normalized?.subtotal) ||
    null;

  normalized.tax =
    receiptTaxSafe ||
    draftTaxSafe ||
    safeMoneyString(normalized?.tax) ||
    null;

  normalized.total =
    receiptTotalSafe ||
    draftTotalSafe ||
    parsedAmountSafe ||
    safeMoneyString(normalized?.total) ||
    safeMoneyString(normalized?.amount) ||
    null;

  normalized.taxLabel =
    String(receiptTaxInfo?.taxLabel || '').trim() ||
    String(draft?.taxLabel || '').trim() ||
    String(normalized?.taxLabel || '').trim() ||
    null;

  // Amount: repair from receipt total if poisoned
  if (isClearlyBadMoney(normalized.amount)) {
    const repair = receiptTotalSafe || parsedAmountSafe;
    if (repair) normalized.amount = `$${repair}`;
  }

  // ✅ Amount must equal total, not subtotal
  // If amount == subtotal and total > subtotal, repair amount to total
  const _amtN = Number(String(normalized.amount || '').replace(/[^0-9.-]/g, ''));
  const _subN = Number(String(normalized.subtotal || '').replace(/[^0-9.-]/g, ''));
  const _totN = Number(String(normalized.total || '').replace(/[^0-9.-]/g, ''));

  if (
    Number.isFinite(_amtN) && Number.isFinite(_subN) && Number.isFinite(_totN) &&
    Math.abs(_amtN - _subN) < 0.01 && _totN > _subN
  ) {
    normalized.amount = typeof formatMoneyDisplay === 'function'
      ? formatMoneyDisplay(_totN)
      : `$${_totN.toFixed(2)}`;
  }

  // Preserve edit latch fields
  normalized.awaiting_edit = !!draft?.awaiting_edit;
  normalized.edit_started_at = draft?.edit_started_at ?? null;
  normalized.editStartedAt = draft?.editStartedAt ?? null;
  normalized.edit_flow_id = draft?.edit_flow_id ?? null;

  // Preserve media linkage
  normalized.media_asset_id = mediaFields.media_asset_id ?? normalized.media_asset_id ?? null;
  normalized.media_source_msg_id = mediaFields.media_source_msg_id ?? normalized.media_source_msg_id ?? null;

  // Preserve job fields
  normalized.jobName = jobFields.jobName;
  normalized.jobSource = jobFields.jobSource;
  normalized.job_no = jobFields.job_no;
  normalized.job_id = jobFields.job_id;

  const gotAmount =
    !!String(normalized?.amount || '').trim() &&
    String(normalized.amount).trim() !== '$0.00';

  const gotDate = !!String(normalized?.date || '').trim();
  normalized.needsReparse = !(gotAmount && gotDate);

  if (!Object.keys(normalized || {}).length) {
    console.warn('[EXPENSE_REPARSE] normalized draft empty; leaving confirmPA unchanged', { paKey });
    return confirmPA;
  }

  await upsertPA({
    ownerId,
    userId: paKey,
    kind: PA_KIND_CONFIRM,
    payload: {
      ...(confirmPA?.payload || {}),
      draft: normalized
    },
    ttlSeconds: PA_TTL_SEC
  });

  console.info('[EXPENSE_REPARSE_RESULT]', {
    paKey,
    needsReparse: !!normalized.needsReparse,
    amount: normalized?.amount || null,
    date: normalized?.date || null,
    store: normalized?.store || null,
    item: normalized?.item || null,
    subtotal: normalized?.subtotal || null,
    tax: normalized?.tax || null,
    total: normalized?.total || null,
    taxLabel: normalized?.taxLabel || null,
    currency: normalized?.currency || null
  });

  return await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
}


// -----------------------------
// Job text normalization + scoring (file-scope helpers)
// -----------------------------
function normalizeNeedle(s) {
  return String(s || '')
    .trim()
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[?!.:,;]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, '')
    .trim();
}

function scoreJobMatch(needleNorm, jobNorm) {
  if (!needleNorm || !jobNorm) return 0;
  if (needleNorm === jobNorm) return 100;
  if (jobNorm.includes(needleNorm)) return 80;
  if (needleNorm.includes(jobNorm)) return 60;

  const nTok = new Set(needleNorm.split(/\s+/).filter(Boolean));
  const jTok = new Set(jobNorm.split(/\s+/).filter(Boolean));
  let hit = 0;
  for (const t of nTok) if (jTok.has(t)) hit++;
  return hit >= 2 ? 40 + hit : hit ? 20 : 0;
}

/* ---------------- misc helpers ---------------- */
async function bestEffortResolveJobFromText(ownerId, text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const m =
    raw.match(/\bjob\b\s*[:\-]?\s*([^\n\r]+)$/i) ||
    raw.match(/\bjob\s*(\d{1,6}\b[^\n\r]*)$/i);

  const needle = String(m?.[1] || '').trim();
  if (!needle) return null;

  const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 200));
  if (!jobs.length) return null;

  // ------------------------------------------------------------
  // 1) STRONG PATH: "job 9" / "job #9" / "job no 9" => exact job_no
  // ------------------------------------------------------------
  const mJobNo =
    needle.match(/^\s*(?:#|no\.?\s*)?(\d{1,4})\s*$/i) ||
    needle.match(/^\s*(\d{1,4})\s*$/);

  if (mJobNo?.[1]) {
    const jobNo = Number(mJobNo[1]);
    if (Number.isFinite(jobNo) && jobNo > 0) {
      const exact = jobs.find((j) => Number(j?.job_no ?? j?.jobNo) === jobNo) || null;
      if (exact) {
        const chosenJobId = asUuidOrNull(exact?.job_id) || asUuidOrNull(exact?.id) || null;
        return {
          jobName: getJobDisplayName(exact),
          jobSource: 'edited',
          job_no: Number(exact?.job_no ?? exact?.jobNo ?? null) || null,
          job_id: chosenJobId
        };
      }
      return null; // do not fuzzy-guess a numeric-only intent
    }
  }

  // ------------------------------------------------------------
  // 2) FUZZY PATH: match by name/address, but with guardrails
  // ------------------------------------------------------------
  const prefixDigits = (needle.match(/^\s*(\d{3,6})\b/) || [])[1] || null;

  const needleNorm = normalizeNeedle(needle);

  let best = null;
  let bestScore = 0;
  let bestPrefixMatch = false;

  for (const j of jobs) {
    const name = String(getJobDisplayNameNoCode(j) || '').trim();
    if (!name) continue;

    const jNorm = normalizeNeedle(name);

    let sc = scoreJobMatch(needleNorm, jNorm);

    let prefixMatch = false;
    if (prefixDigits) {
      const jPrefix = (name.match(/^\s*(\d{3,6})\b/) || [])[1] || null;
      prefixMatch = !!(jPrefix && jPrefix === prefixDigits);
      if (prefixMatch) sc += 15; // small boost, still bounded by thresholds below
    }

    if (sc > bestScore) {
      bestScore = sc;
      best = j;
      bestPrefixMatch = prefixMatch;
    }
  }

  if (!best) return null;

  // --- Thresholds tuned to YOUR scoring function ---
  //
  // Without digits:
  // - Accept >= 60 (needle includes job or strong partial), but reject token-overlap-only (42..)
  //
  // With digit prefix:
  // - Prefer strong substring containment (>= 80) OR
  // - allow >= 60 only if digit prefix matches exactly (prevents 1556 -> 1559 swaps)
  //
  const accept =
    !prefixDigits
      ? bestScore >= 60
      : (bestScore >= 80) || (bestPrefixMatch && bestScore >= 60);

  if (!accept) return null;

  const chosenJobId = asUuidOrNull(best?.job_id) || asUuidOrNull(best?.id) || null;

  return {
    jobName: getJobDisplayName(best),
    jobSource: 'edited',
    job_no: Number(best?.job_no ?? best?.jobNo ?? null) || null,
    job_id: chosenJobId
  };
}




/* =========================================================
   Job picker helpers (DE-DUPED, aligned with sendJobPickList)
   ========================================================= */

// rowId = jp:<flow>:<nonce>:jn:<jobNo>:h:<sig>
function makeRowId({ flow, nonce, jobNo, secret }) {
  const base = `${flow}|${nonce}|${jobNo}`;
  const sig = hmac12(secret, base);
  return `jp:${flow}:${nonce}:jn:${jobNo}:h:${sig}`;
}

function parseRowId(rowId) {
  const s = String(rowId || '').trim();

  // STRICT:
  // jp:<8hex flow>:<8hex nonce>:jn:<jobNo>:h:<12hex sig>
  const m = s.match(/^jp:([0-9a-f]{8}):([0-9a-f]{8}):jn:(\d{1,10}):h:([0-9a-f]{12})$/i);
  if (!m) return null;

  return {
    flow: String(m[1]).toLowerCase(),
    nonce: String(m[2]).toLowerCase(),
    jobNo: Number(m[3]),
    sig: String(m[4]).toLowerCase()
  };
}



// ✅ legacy support for old "job_<ix>_<hash>" replies (keep ONE copy)
function legacyIndexFromTwilioToken(tok) {
  const m = String(tok || '').trim().match(/^job_(\d{1,10})_[0-9a-z]+$/i);
  if (!m) return null;
  const ix = Number(m[1]);
  return Number.isFinite(ix) ? ix : null;
}

/* =========================
   Expense parsing helpers
   ========================= */

function stripExpensePrefixes(input) {
  let s = String(input || '').trim();

  // Accept:
  // - "expense: ..."
  // - "expense ..."
  // - "edit expense: ..."
  // - "edit expense ..."
  // - "edit: ..."
  // - "edit ..."
  s = s.replace(/^(?:edit\s+)?expense\b\s*:?\s*/i, '');
  s = s.replace(/^edit\b\s*:?\s*/i, '');

  return s.trim();
}
function ensureAmountCents(d) {
  if (!d) return d;

  // If normalizeExpenseData already set it, great.
  const ac = Number(d.amount_cents);
  if (Number.isFinite(ac) && ac > 0) return d;

  // Otherwise compute from amount (string like "$48.00", "48", "48.00")
  const a = String(d.amount || '').trim();
  if (a) {
    const cents = toCents(a); // you already export toCents from pg/postgres.js
    if (Number.isFinite(cents) && cents > 0) {
      d.amount_cents = cents;
      return d;
    }
  }

  return d;
}

function toCents(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.,]/g, '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function toNumberAmount(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.,]/g, '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return n;
}

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(str || '').trim()
  );
}

function looksLikeOverhead(s) {
  const t = String(s || '').trim().toLowerCase();
  return t === 'overhead' || t === 'oh';
}

function asUuidOrNull(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
    ? s
    : null;
}


function normalizeJobAnswer(text) {
  let s = String(text || '').trim();
  if (!s) return s;

  // Keep these tokens exactly (just normalize case)
  if (/^jobno_\d{1,10}$/i.test(s)) return s.toLowerCase();
  if (/^jobix_\d{1,10}$/i.test(s)) return s.toLowerCase();
  if (/^job_\d{1,10}_[0-9a-z]+$/i.test(s)) return s; // ✅ DO NOT rewrite to jobix_

  // Allow stamped "J1556 ..." => jobno_1556
  const mStamp = s.match(/\bJ(\d{1,10})\b/i);
  if (mStamp?.[1]) return `jobno_${mStamp[1]}`;

  // Clean common prefixes
  s = s.replace(/^(job\s*name|job)\s*[:-]?\s*/i, '');
  s = s.replace(/^(create|new)\s+job\s+/i, '');
  s = s.replace(/[?]+$/g, '').trim();

  return s;
}

function cleanExpenseItemForDisplay(item) {
  let s = String(item || '').trim();
  s = s.replace(/^for\s+/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s || 'Unknown';
}

function escapeRegExp(x) {
  return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripEmbeddedDateAndJobFromItem(item, { date, jobName } = {}) {
  let s = normalizeDashes(String(item || '')).trim();
  if (!s) return 'Unknown';

  // Strip: "on 2026-01-02" or "on Jan 2, 2026" (light touch)
  if (date) {
    const d = String(date).trim();
    if (d) s = s.replace(new RegExp(`\\bon\\s+${escapeRegExp(d)}\\b`, 'ig'), ' ');
  }

  // Always strip explicit tails like: "for job <anything>" at end
  s = s.replace(/\bfor\s+job\s+.+$/i, ' ');

  // If we know the job name, strip a trailing "for <jobName>" at end (not mid-sentence)
  if (jobName) {
    const j = String(jobName).trim();
    if (j) s = s.replace(new RegExp(`\\bfor\\s+${escapeRegExp(j)}\\s*$`, 'i'), ' ');
  }

  s = s.replace(/\bfor\s+a\s+job\b/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s || 'Unknown';
}

function inferItemFromDashOrInPattern(text) {
  const src = normalizeDashes(String(text || '')).trim();
  if (!src) return null;

  // A) "$883 - Railing at Rona ..."
  let m =
    src.match(
      /\$\s*[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?\s*-\s*(.+?)(?:\s+\b(from|at|@|for)\b|\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
    ) || null;
  if (m?.[1]) {
    const it = cleanExpenseItemForDisplay(m[1]);
    if (it && !isUnknownItem(it)) return it;
  }

  // B) "... $883 in railing at/from Rona ..."
  m =
    src.match(
      /\$\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?\s+\bin\s+(.+?)(?:\s+\b(from|at|@|for)\b|\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
    ) || null;
  if (m?.[1]) {
    const it = cleanExpenseItemForDisplay(m[1]);
    if (it && !isUnknownItem(it)) return it;
  }

  // C) Last resort: reuse your "on <item>" extractor
  const on = inferItemFromOnPattern(src);
  if (on && !isUnknownItem(on)) return on;

  return null;
}

function inferExpenseItemFallback(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;

  const rules = [
    { re: /\brailing(s)?\b|\bhandrail(s)?\b|\bguard\s*rail(s)?\b/, item: 'Railing' },
    { re: /\blumber\b|\b2x4\b|\b2x6\b|\bplywood\b|\bosb\b|\bstud(s)?\b/, item: 'Lumber' },
    { re: /\bshingle(s)?\b|\broofing\b|\bunderlayment\b|\bice\s*&?\s*water\b/, item: 'Roofing materials' },
    { re: /\bnail(s)?\b|\bscrew(s)?\b|\bfastener(s)?\b|\bdeck\s*screw(s)?\b/, item: 'Fasteners' },
    { re: /\bcaulk\b|\bsealant\b|\badhesive\b|\bglue\b/, item: 'Sealants/adhesives' },
    { re: /\bconcrete\b|\bmortar\b|\bgrout\b|\bquikrete\b/, item: 'Concrete' },
    { re: /\binsulation\b|\bfoam\b|\bvapou?r\s*barrier\b/, item: 'Insulation' },
    { re: /\bpaint\b|\bprimer\b|\bstain\b/, item: 'Paint' },
    { re: /\btool(s)?\b|\bblade(s)?\b|\bbit(s)?\b|\bsaw\b/, item: 'Tools/supplies' }
  ];

  for (const r of rules) if (r.re.test(t)) return r.item;

  // "worth of X" fallback
  const m = t.match(/\bof\s+([a-z0-9][a-z0-9\s\-]{2,40})\b/);
  if (m?.[1]) {
    const guess = m[1].trim();
    if (!guess.includes('unknown') && !guess.includes('stuff')) {
      return guess.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  return null;
}

function inferItemFromOnPattern(text) {
  const t0 = normalizeDashes(String(text || '')).trim();
  if (!t0) return null;

  const m = t0.match(
    /\b(?:expense|exp|spent|paid|purchased|bought|purchase|ordered)?\b[\s\S]*?\bon\s+(.+?)(?=\s+\b(from|at|@|for)\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
  );
  if (!m?.[1]) return null;

  const item = cleanExpenseItemForDisplay(m[1]);
  return item && !isUnknownItem(item) ? item : null;
}

function normalizeDecisionToken(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;

  // exact / common taps
  if (s === 'yes' || s === 'y' || s === 'confirm' || s === '✅ yes' || s === '✅yes') return 'yes';
  if (s === 'edit') return 'edit';
  if (s === 'cancel' || s === 'stop') return 'cancel';
  if (s === 'skip') return 'skip';

  // change job
  if (s === 'change job' || s === 'switch job') return 'change_job';
  if (/\bchange\s+job\b/.test(s) && s.length <= 40) return 'change_job';

  // resume
  if (s === 'resume') return 'resume';
  if (/\bresume\b/.test(s) && s.length <= 20) return 'resume';

  // "more" (job list paging)
  if (s === 'more' || s === 'more jobs' || s === 'more jobs…') return 'more';
  if (/\bmore\b/.test(s) && s.length <= 24) return 'more'; // handles "more please"

  // soft contains (safe only)
  // ⚠️ avoid soft "yes"/"cancel" to prevent accidental confirmation/cancel on natural sentences
  if (/\bedit\b/.test(s) && s.length <= 24) return 'edit';
  if (/\bskip\b/.test(s) && s.length <= 24) return 'skip';

  // Not a control token
  return null;
}


function formatDisplayDate(isoDate, tz = 'America/Toronto') {
  const s = String(isoDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || '';
  try {
    const d = new Date(`${s}T12:00:00Z`);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(d);
  } catch {
    return s;
  }
}

function normalizeExpenseData(data, userProfile, sourceText = '') {
  const tz = userProfile?.timezone || userProfile?.tz || 'America/Toronto';
  const d = { ...(data || {}) };
  const src = String(sourceText || '').trim();

  // ---------------------------
  // Receipt-first detection
  // ---------------------------
  const looksReceiptish =
    !!src &&
    (
      /\b(subtotal|total|hst|gst|pst|tax|debit|visa|mastercard|amex|approved|auth|terminal|invoice|receipt)\b/i.test(src) ||
      src.split(/\r?\n/).filter(Boolean).length >= 3
    );

  const taxBreakdown =
    src && typeof extractReceiptTaxBreakdown === 'function'
      ? extractReceiptTaxBreakdown(src)
      : { subtotal: null, tax: null, total: null, taxLabel: null };

  // ---------------------------
  // Amount
  // Trust order:
  // 1) explicit valid amount already on draft
  // 2) explicit valid total already on draft
  // 3) labeled receipt total
  // Never allow absurd SKU-like totals through
  // ---------------------------
  const currentAmt = d.amount != null ? toNumberAmount(d.amount) : null;

  const explicitDraftTotal =
    d.total != null && Number.isFinite(Number(d.total))
      ? Number(d.total)
      : null;

  const receiptTotal =
    taxBreakdown?.total != null && Number.isFinite(Number(taxBreakdown.total))
      ? Number(taxBreakdown.total)
      : null;

  const chosenTotal =
    explicitDraftTotal != null
      ? explicitDraftTotal
      : receiptTotal != null
        ? receiptTotal
        : null;

  if ((d.amount == null || !Number.isFinite(currentAmt) || currentAmt <= 0) && chosenTotal != null) {
    d.amount = chosenTotal;
  }

  // ---------------------------
  // Tax fields (canonical names)
  // ---------------------------
  if ((d.subtotal == null || !Number.isFinite(Number(d.subtotal))) && taxBreakdown?.subtotal != null) {
    d.subtotal = Number(taxBreakdown.subtotal).toFixed(2);
  }

  if ((d.tax == null || !Number.isFinite(Number(d.tax))) && taxBreakdown?.tax != null) {
    d.tax = Number(taxBreakdown.tax).toFixed(2);
  }

  if ((d.total == null || !Number.isFinite(Number(d.total))) && taxBreakdown?.total != null) {
    d.total = Number(taxBreakdown.total).toFixed(2);
  }

  if (!String(d.taxLabel || '').trim() && taxBreakdown?.taxLabel) {
    d.taxLabel = String(taxBreakdown.taxLabel).trim();
  }

  // ---------------------------
  // Date
  // ---------------------------
  if (!String(d.date || '').trim() && src) {
    const receiptDate =
      (typeof extractReceiptDateYYYYMMDD === 'function' ? extractReceiptDateYYYYMMDD(src, tz) : null) ||
      (typeof extractReceiptDate === 'function' ? extractReceiptDate(src) : null) ||
      null;

    if (receiptDate) d.date = receiptDate;
  }

  // ---------------------------
  // Store
  // ---------------------------
  const storeTrim = String(d.store || '').trim();
  const storeWeak =
    !storeTrim ||
    /^unknown\b/i.test(storeTrim) ||
    storeTrim.length > 60 ||
    /\$\d/.test(storeTrim);

  if (storeWeak && src && typeof extractReceiptStore === 'function') {
    const receiptStore = extractReceiptStore(src);
    if (receiptStore) d.store = receiptStore;
  }

  // ---------------------------
  // Item sanitization
  // ---------------------------
  const rawItem = String(d.item || '').trim();

  const looksLikeReceiptMeta =
    /\b(sub\s*total|subtotal|total|grand\s*total|balance\s*due|tax|hst|gst|pst|vat|visa|mastercard|debit|change|tender|auth|acct|account|employee|store details|rona\.ca|www\.|career|returns?-and-refunds)\b/i.test(rawItem);

  const looksLikeMoneyLine =
    /^\$?\s*\d{1,6}(?:\.\d{2})?\s*$/.test(rawItem) ||
    /\$\s*\d{1,6}(?:\.\d{2})?/.test(rawItem);

  const looksLikeSkuLine =
    /^\d{6,}$/.test(rawItem);

  const tooLong = rawItem.length > 120;

  if (!rawItem || looksLikeReceiptMeta || looksLikeMoneyLine || looksLikeSkuLine || tooLong) {
    d.item = null;
  }

  // Safe receipt item backfill
  if (!d.item && src && typeof extractReceiptPrimaryItem === 'function') {
    const primary = extractReceiptPrimaryItem(src);
    if (primary) d.item = primary;
  }

  // Typed-text fallback only for non-receipt flows
  if (!d.item && !looksReceiptish && typeof inferItemFromDashOrInPattern === 'function') {
    const inferred = inferItemFromDashOrInPattern(src);
    if (inferred) d.item = inferred;
  }

  // ---------------------------
  // Formatting / normalization
  // ---------------------------
  if (d.amount != null) {
    const n = toNumberAmount(d.amount);
    if (Number.isFinite(n) && n > 0) d.amount = formatMoneyDisplay(n);
  }

  if (d.subtotal != null && Number.isFinite(Number(d.subtotal))) {
    d.subtotal = Number(d.subtotal).toFixed(2);
  }

  if (d.tax != null && Number.isFinite(Number(d.tax))) {
    d.tax = Number(d.tax).toFixed(2);
  }

  if (d.total != null && Number.isFinite(Number(d.total))) {
    d.total = Number(d.total).toFixed(2);
  }

  if (d.taxLabel != null) {
    const x = String(d.taxLabel || '').trim();
    d.taxLabel = x || null;
  }

  // ✅ CRITICAL:
  // Never invent today for receipt/OCR flows.
  // Only default today for typed/manual non-receipt flows.
  if (!String(d.date || '').trim()) {
    d.date = looksReceiptish ? null : todayInTimeZone(tz);
  }

  d.item = cleanExpenseItemForDisplay(d.item);
  d.store = String(d.store || '').trim() || 'Unknown Store';

  if (d.jobName != null) d.jobName = normalizeJobNameCandidate(d.jobName);

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

function isStalePickerTap(pickPA, inbound) {
  // We only enforce staleness when Twilio tells us what message the user replied to.
  // If Twilio doesn't send it (some client cases), we do NOT block — but we log.
  const expected = pickPA?.payload?.lastPickerMsgSid || pickPA?.payload?.expectedPickerMsgSid || null;
  const repliedTo = inbound?.OriginalRepliedMessageSid || inbound?.originalReplied || null;

  if (!expected) return { stale: false, reason: null };

  if (!repliedTo) {
    return { stale: false, reason: 'no_replied_to_sid' };
  }

  if (String(expected) !== String(repliedTo)) {
    return { stale: true, reason: 'replied_to_mismatch', expected, repliedTo };
  }

  return { stale: false, reason: null };
}

function extractReceiptPrimaryItem(text) {
  const normalized = normalizeReceiptOcrForParsing(text);
  if (!normalized) return null;

  const lines = normalized
    .split(/\n+/)
    .map((l) => String(l || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (!lines.length) return null;

  const isBadLine = (line) => {
    const s = String(line || '').trim();
    if (!s) return true;

    return (
      /\b(subtotal|total|gst\/hst|gst|hst|pst|tax|debit|visa|mastercard|amex|auth|acct|account|employee|refund|return|exchange|career|rona\.ca|www\.|http|store details|saved today|debit card|acct type|auth#|default|you saved today|interested in a career|exchange or refund|returns? and refunds?|mission exteriors|paypoi|paypoint|interac|transaction record|wonderland|ontario|london)\b/i.test(s) ||
      /^(item|qty|price|total)$/i.test(s) ||
      /^(rona inc\.?|rona\+?\s+n\.?w\.?\s+london)(\s+\d+)?$/i.test(s) ||
      // payment terminal ID + masked card: "PC163473: ***132801"
      /^PC\d{4,}:\s*\*+\d+/.test(s) ||
      // FHST receipt number line: "FHST #: 871917936"
      /^[FP]HST\s*#/.test(s) ||
      // customer/account number lines: short numeric ID followed by an all-caps name
      /^\d{6,12}\s+[A-Z][A-Z\s]{3,}$/.test(s)
    );
  };

  const looksSkuish = (line) => /^\d{8,14}$/.test(String(line || '').trim());

  const looksMoneyish = (line) =>
    /\$\s*\d+(?:\.\d{2})?/.test(String(line || '')) ||
    /^\s*\d+(?:\.\d{2})\s*[A-Z]?\s*$/.test(String(line || '').trim());

  const cleanCandidate = (line) => {
    const s = cleanExpenseItemForDisplay(line)
      .replace(/\bqty\b.*$/i, '')
      .replace(/\bprice\b.*$/i, '')
      .replace(/\bsubtotal\b.*$/i, '')
      .replace(/\btotal\b.*$/i, '')
      // ✅ Strip trailing inline price+tax (e.g. "MEMBRANE WEATHERTEX 3X65 68.01 N 1")
      .replace(/\s+\d+\.\d{2}\s*[A-Z]?.*$/, '')
      // ✅ Strip trailing qty+unit code (e.g. "MEMBRANE WEATHERTEX 3X65 1 RL")
      .replace(/\s+\d+(?:\s+[A-Z]{1,3})+\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!s) return null;
    if (isBadLine(s)) return null;
    if (looksMoneyish(s)) return null;
    if (s.length < 4 || s.length > 80) return null;
    if (!/[A-Za-z]/.test(s)) return null;
    return s;
  };

  const looksProductish = (line) => {
    const s = cleanCandidate(line);
    if (!s) return false;
    if (/\b(membrane|weathert|shingle|nail|screw|flashing|insulation|lumber|plywood|osb|caulk|adhesive|board|sheet|roll)\b/i.test(s)) return true;
    if (/\b(regular|premium|diesel|unleaded|super|midgrade|fuel|gasoline|e85)\b/i.test(s)) return true;
    if (/\d+\s*[xX]\s*\d+/.test(s)) return true;
    if (/\d/.test(s) && /[A-Za-z]/.test(s)) return true;
    if (/[A-Z]{3,}/.test(s)) return true;
    return true;
  };

  // 0a) Fuel station receipt: look for fuel grade, fall back to "Fuel"
  if (/\b(petro-canada|petro canada|shell|esso|mobil|pioneer|ultramar|irving|husky|sunoco)\b/i.test(String(text || ''))) {
    const fuelGradeMatch = String(text || '').match(
      /\b(regular\s+unleaded|premium\s+unleaded|regular|premium|super|midgrade|diesel|unleaded|e85)\b/i
    );
    if (fuelGradeMatch?.[1]) {
      const grade = fuelGradeMatch[1].trim();
      return grade.charAt(0).toUpperCase() + grade.slice(1).toLowerCase();
    }
    return 'Fuel';
  }

  // 0) Hardware/building-supply receipt: barcode + price + 1-3 short unit/tax codes + product
  //    Works on raw flat OCR — e.g. "773615003161 77.89 RL B MEMBRANE WEATHERTEX 3X65' 1 RL 77.89"
  const m0 = String(text || '').match(
    /\b\d{8,14}\b\s+\d[\d.,]*(?:\s+[A-Z]{1,3}){1,3}\s+([A-Z][A-Za-z0-9'".\-\/ ]{3,60}?)(?=\s+\d+\s+[A-Z]{1,3}\b|\s+\d+\.\d{2}\b|\s*$)/
  );
  if (m0?.[1]) {
    const candidate = cleanCandidate(m0[1].trim());
    if (candidate) return candidate;
  }

  // 1) Best case: inline SKU followed directly by product text (flattened OCR)
  const inlineSkuProduct = normalized.match(
    /\b\d{8,14}\b\s+([A-Za-z][A-Za-z0-9'".\-\/ ]{4,80}?)(?=\s+\$?\d+\.\d{2}\b|\s+\b(subtotal|gst\/hst|gst|hst|pst|tax|total)\b|$)/i
  );
  if (inlineSkuProduct?.[1]) {
    const candidate = cleanCandidate(inlineSkuProduct[1]);
    if (candidate) return candidate;
  }

  // 2) SKU line then next product-like line
  //    Skip lines that look like store names, addresses, phone numbers, or customer accounts
  const looksLikeStoreOrAddress = (line) => {
    const s = String(line || '').trim();
    return (
      /\b(rona|home depot|lowes|canadian tire|costco|walmart|superstore|dollarama|mission exteriors|petro-canada|petro canada|shell|esso|mobil|pioneer|ultramar|irving|husky|sunoco)\b/i.test(s) ||
      /\b(n\.?w\.?|n\.?e\.?|s\.?w\.?|s\.?e\.?)\b/i.test(s) ||
      /\b\d{3,5}\s+[A-Za-z]/.test(s) ||
      /\(\d{3}\)\s*\d{3}-\d{4}/.test(s) ||
      /\b(london|toronto|ottawa|vancouver|calgary|edmonton|winnipeg)\b/i.test(s) ||
      /\b(on|bc|ab|qc|sk|mb|ns|nb|pe|nl)\b,?\s*[A-Z]\d[A-Z]/i.test(s) ||
      /^\*+$/.test(s) ||
      /^={3,}$/.test(s) ||
      /^-{3,}$/.test(s) ||
      // customer account line: digits + all-caps business name
      /^\d{6,12}\s+[A-Z][A-Z\s]{3,}$/.test(s)
    );
  };

  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!looksSkuish(lines[i])) continue;

    for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
      if (looksLikeStoreOrAddress(lines[j])) continue;
      if (looksSkuish(lines[j])) break;

      if (looksProductish(lines[j])) {
        const candidate = cleanCandidate(lines[j]);
        if (candidate) return candidate;
      }
      break;
    }
  }
  // 3) Search item zone before totals/payment/footer
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/\b(subtotal|gst\/hst|gst|hst|pst|tax|debit card|debit|visa|mastercard|amex|acct|auth|employee|you saved today|returns? and refunds?)\b/i.test(line)) {
      break;
    }
    // Skip store headers, addresses, and phone numbers
    if (looksLikeStoreOrAddress(line)) continue;
    if (looksProductish(line)) {
      const candidate = cleanCandidate(line);
      if (candidate) return candidate;
    }
  }

  return null;
}

/**
 * Extract all line items from a receipt.
 * Returns [{name, price}] sorted by order of appearance.
 * Skips store headers, totals, tax, and payment lines.
 */
function extractAllReceiptLineItems(text) {
  const normalized = normalizeReceiptOcrForParsing(text);
  if (!normalized) return [];

  const lines = normalized
    .split(/\n+/)
    .map((l) => String(l || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const isFooterLine = (line) =>
    /\b(subtotal|total|gst\/hst|gst|hst|pst|tax|debit card|debit|visa|mastercard|amex|interac|acct|auth|employee|you saved today|returns? and refunds?|fhst|phst)\b/i.test(line);

  const isSkipLine = (line) =>
    /\b(rona|home depot|lowes|canadian tire|costco|walmart|petro-canada|petro canada|shell|esso|mission exteriors)\b/i.test(line) ||
    /\(\d{3}\)\s*\d{3}-\d{4}/.test(line) ||
    /\b(on|bc|ab|qc)\b,?\s*[A-Z]\d[A-Z]/i.test(line) ||
    /\b(item|items|qty|quantity|=====)\b/i.test(line);

  const isBadName = (name) =>
    !name || name.length < 3 ||
    isSkipLine(name) ||
    /^\d+$/.test(name) ||
    !/[A-Za-z]/.test(name) ||
    /\b(subtotal|total|tax|gst|hst|pst|debit|visa|mastercard|amex|interac)\b/i.test(name);

  const parseMoney = (line) => {
    const m = line.match(/\b(\d{1,4}\.\d{2})\b/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 && n < 10000 ? n : null;
  };

  const items = [];
  let pendingName = null; // item name seen without a price yet
  let footerStarted = false;

  for (const line of lines) {
    if (footerStarted) break;
    if (isFooterLine(line)) { footerStarted = true; break; }
    if (isSkipLine(line)) { pendingName = null; continue; }

    // Pure barcode line — marks start of item zone, clears pending
    if (/^\d{8,14}$/.test(line)) { pendingName = null; continue; }

    const price = parseMoney(line);

    if (price == null) {
      // No price on this line — could be an item name (price follows on next line)
      // Strip leading barcode if present
      const candidate = line.replace(/^\d{8,14}\s*/, '').replace(/\s+/g, ' ').trim();
      if (!isBadName(candidate)) {
        pendingName = candidate;
      } else {
        pendingName = null;
      }
      continue;
    }

    // We have a price — try to get a name from this line or use pendingName
    let name = line
      .replace(/\s+\d+\.\d{2}\s*[A-Z]?\s*$/, '')  // strip trailing price + tax code
      .replace(/\s+\d+(?:\s+[A-Z]{1,3})+\s*$/, '') // strip trailing quantity codes
      .replace(/^\d{8,14}\s*/, '')                   // strip leading barcode
      .replace(/\s+/g, ' ')
      .trim();

    if (isBadName(name)) {
      // Name not on this line — use pending name from previous line
      name = pendingName || null;
    }

    pendingName = null;

    if (!name || isBadName(name)) continue;

    items.push({ name, price });
  }

  return items;
}

/**
 * Send a plain WhatsApp text message to a user via Twilio API.
 */
async function sendWhatsAppTextMessage({ toPhone, body }) {
  const tw = getTwilioClient();
  const { waFrom, messagingServiceSid } = getSendFromConfig();
  const to = `whatsapp:+${String(toPhone).replace(/\D/g, '')}`;
  const params = { to, body: String(body || '').slice(0, 1600) };
  if (messagingServiceSid) params.messagingServiceSid = messagingServiceSid;
  else params.from = waFrom;
  return tw.messages.create(params);
}

function buildItemReviewMessage({ items, subtotal, tax, taxLabel, total, store }) {
  const storeName = String(store || 'Receipt').trim();
  const header = `📋 ${storeName} — ${items.length} items found`;
  const itemLines = items.map((it, i) => `${i + 1}. ${it.name} — $${Number(it.price).toFixed(2)}`).join('\n');
  const taxStr = taxLabel ? `${taxLabel} $${Number(tax || 0).toFixed(2)}` : `Tax $${Number(tax || 0).toFixed(2)}`;
  const footer = subtotal
    ? `Subtotal $${Number(subtotal).toFixed(2)} | ${taxStr} | Total $${Number(total).toFixed(2)}`
    : `Total $${Number(total).toFixed(2)}`;
  return `${header}\n${itemLines}\n\n${footer}\n\nReply "all" to include everything, or type the number(s) of any personal/excluded items (e.g. "2" or "1,2").`;
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

function getJobPickerSecret() {
  const s = process.env.JOB_PICKER_HMAC_SECRET;
  return s && String(s).trim() ? String(s).trim() : null;
}

function sha8(s) {
  return nodeCrypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

function hmac12(secret, s) {
  return nodeCrypto
    .createHmac('sha256', String(secret))
    .update(String(s))
    .digest('hex')
    .slice(0, 12);
}


// -------------------------------------------------------
// Twilio ListTitle cleanup + normalization (HARDENED)
// -------------------------------------------------------

function stripListNumberPrefix(title = '') {
  // Handles:
  // "#1 Job Name"
  // "# 1 Job Name"
  // "1) Job Name"
  // "1. Job Name"
  // "(1) Job Name"
  // "1 - Job Name"
  return String(title || '')
    .trim()
    .replace(/^#\s*\d+\s+/i, '')                 // "#1 "
    .replace(/^\(?\d+\)?\s*[\)\.:\-]\s+/i, '')   // "1) " / "1. " / "(1) " / "1 - "
    .replace(/^\d+\s+/, '')                      // "1 " (bare)
    .trim();
}

function normalizePickTitle(s = '') {
  // IMPORTANT: remove "#" so "#1 foo" can't poison matching even if stripper fails.
  return String(s || '')
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/[—–]/g, '-')                // normalize fancy dashes
    .replace(/#/g, ' ')                   // critical safety
    .replace(/[^a-z0-9\s:-]/g, ' ')       // keep safe chars only
    .replace(/\s+/g, ' ')
    .trim();
}

function deSpace(s = '') {
  return String(s || '').replace(/\s+/g, '');
}

// -------------------------------------------------------
// Title-signal detection across Twilio variants (HARDENED)
// -------------------------------------------------------
function getInboundTitleSignal(meta = {}) {
  const candidates = [
    meta?.ListTitle,
    meta?.ListRowTitle,
    meta?.listTitle,
    meta?.list_row_title
  ].filter((v) => String(v || '').trim());

  // Some Twilio configs include interactive response JSON
  try {
    const raw = meta?.InteractiveResponseJson;
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const t =
      obj?.list_reply?.title ||
      obj?.list_reply?.row_title ||
      obj?.interactive?.list_reply?.title ||
      obj?.interactive?.list_reply?.row_title ||
      null;
    if (String(t || '').trim()) candidates.push(t);
  } catch (_) {}

  const hit = candidates.find((v) => String(v || '').trim());
  return hit ? String(hit).trim() : null;
}

// -------------------------------------------------------
// ✅ legacy support for Twilio "job_<ix>_<hash>" (INDEX ONLY)
// -------------------------------------------------------
function legacyIndexFromTwilioToken(tok) {
  const m = String(tok || '').trim().match(/^job_(\d{1,10})_[0-9a-z]+$/i);
  if (!m) return null;
  const ix = Number(m[1]);
  return Number.isFinite(ix) ? ix : null;
}

// -------------------------------------------------------
// Tripwire: forbid legacy_* resolutions when title exists
// -------------------------------------------------------
function enforceNoLegacyWhenTitle(result, hasTitleSignal) {
  if (!result?.ok) return result;
  if (!hasTitleSignal) return result;

  const via = String(result?.via || '');
  if (via.startsWith('legacy_')) {
    console.error('[JOB_PICK_INVARIANT_BROKEN] legacy path used despite title signal', {
      via,
      inboundTitle: result?.inboundListTitle,
      inboundBody: result?.inboundBody
    });
    return {
      ok: false,
      reason: 'invariant_broken_legacy_with_title',
      jobNo: null,
      via: 'reject_invariant_broken',
      inboundBody: result?.inboundBody,
      inboundListTitle: result?.inboundListTitle
    };
  }
  return result;
}

// -------------------------------------------------------
// Canonical interactive-list resolver (SAFE + PERMANENT)
// Accepts either:
//   resolveJobPickSelection(rawInput, inboundTwilioMeta, pickPA)
// OR
//   resolveJobPickSelection({ input, twilioMeta, pickState })
// where pickState = { displayedJobNos, sentRows, jobOptions }
// -------------------------------------------------------
function resolveJobPickSelection(arg1, arg2 = {}, arg3 = null) {
  // ✅ Support object-call style used in revenue/expense handlers
  if (arg1 && typeof arg1 === 'object' && (arg1.input != null || arg1.rawInput != null)) {
    const rawInput = String(arg1.input ?? arg1.rawInput ?? '').trim();
    const inboundTwilioMeta = arg1.twilioMeta || arg1.inboundTwilioMeta || {};
    const pickState = arg1.pickState || null;

    // Normalize pickState into the older "pickPA.payload" shape your resolver expects
    const pickPA = pickState
      ? { payload: { ...pickState } }
      : (arg1.pickPA || arg1.pickPa || null);

    return resolveJobPickSelection(rawInput, inboundTwilioMeta, pickPA);
  }

  // ---- original implementation below (UNCHANGED) ----
  const s = String(arg1 || "").trim();
  const tok = s.toLowerCase();

  const inboundTwilioMeta = arg2 || {};
  const pickPA = arg3 || null;

  const displayedJobNos = Array.isArray(pickPA?.payload?.displayedJobNos)
    ? pickPA.payload.displayedJobNos.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];

  const jobOptions = Array.isArray(pickPA?.payload?.jobOptions) ? pickPA.payload.jobOptions : [];
  const sentRows = Array.isArray(pickPA?.payload?.sentRows) ? pickPA.payload.sentRows : [];

  const clean = (x) =>
    String(x || "")
      .toLowerCase()
      .replace(/[#]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  // 0) Strongest: stable signed row id (jp:...)
  const parsed = typeof parseRowId === "function" ? parseRowId(s) : null;
  if (parsed?.jobNo && Number.isFinite(Number(parsed.jobNo))) {
    return { ok: true, jobNo: Number(parsed.jobNo), via: "stable_row_id" };
  }

  // 1) Explicit jobno_<jobNo>
  const mJobNo = tok.match(/^jobno_(\d{1,10})$/i);
  if (mJobNo?.[1]) {
    const jobNo = Number(mJobNo[1]);
    if (Number.isFinite(jobNo)) return { ok: true, jobNo, via: "jobno_token" };
  }

  // 2) Title-based resolution
  const listTitle = String(inboundTwilioMeta?.ListTitle || inboundTwilioMeta?.ListRowTitle || "").trim();
  if (listTitle) {
    const titleName = clean(listTitle.replace(/^#\d+\s*/i, ""));

    if (titleName) {
      const rowKey = (r) => clean(r?.title || r?.name || "");

      const exactRows = sentRows.filter((r) => rowKey(r) === titleName);
      if (exactRows.length === 1) {
        const jobNo = Number(exactRows[0]?.jobNo);
        if (Number.isFinite(jobNo)) return { ok: true, jobNo, via: "list_title_sentRows_exact" };
      }

      const prefixRows = sentRows.filter((r) => {
        const k = rowKey(r);
        if (!k || !titleName) return false;
        if (titleName.length < 8) return false;
        return k.startsWith(titleName) || titleName.startsWith(k);
      });

      if (prefixRows.length === 1) {
        const jobNo = Number(prefixRows[0]?.jobNo);
        if (Number.isFinite(jobNo)) return { ok: true, jobNo, via: "list_title_sentRows_prefix" };
      }

      const optKey = (j) =>
        clean(
          j?.name ||
            j?.job_name ||
            (typeof getJobDisplayName === "function" ? getJobDisplayName(j) : "")
        );

      const exactOpts = jobOptions.filter((j) => optKey(j) === titleName);
      if (exactOpts.length === 1) {
        const jobNo = Number(exactOpts[0]?.job_no ?? exactOpts[0]?.jobNo);
        if (Number.isFinite(jobNo)) return { ok: true, jobNo, via: "list_title_jobOptions_exact" };
      }

      const prefixOpts = jobOptions.filter((j) => {
        const k = optKey(j);
        if (!k || !titleName) return false;
        if (titleName.length < 8) return false;
        return k.startsWith(titleName) || titleName.startsWith(k);
      });

      if (prefixOpts.length === 1) {
        const jobNo = Number(prefixOpts[0]?.job_no ?? prefixOpts[0]?.jobNo);
        if (Number.isFinite(jobNo)) return { ok: true, jobNo, via: "list_title_jobOptions_prefix" };
      }
    }
  }

  // 3) jobix_<row>
  const mTok = tok.match(/^jobix_(\d{1,10})$/i);
  if (mTok?.[1]) {
    const row = Number(mTok[1]);
    const idx = row - 1;
    const jobNo = displayedJobNos[idx];

    if (Number.isFinite(jobNo)) return { ok: true, jobNo, via: "jobix_row_index" };
    return { ok: false, reason: "row_out_of_range", via: "jobix_row_index" };
  }

  // 4) Legacy: ListId / Body job_<row>_<nonce>
  const listId = String(inboundTwilioMeta?.ListId || "").trim();
  const body = String(inboundTwilioMeta?.Body || "").trim();

  const mList =
    listId.match(/^job_(\d{1,10})_[0-9a-z]+$/i) ||
    body.match(/^job_(\d{1,10})_[0-9a-z]+$/i);

  if (mList?.[1]) {
    const row = Number(mList[1]);
    const idx = row - 1;
    const jobNo = displayedJobNos[idx];

    if (Number.isFinite(jobNo)) return { ok: true, jobNo, via: "list_id_row_index" };
    return { ok: false, reason: "row_out_of_range", via: "list_id_row_index" };
  }

  return { ok: false, reason: "unrecognized_pick", via: "none" };
}



/* ---------------- receipt-safe extractors (TOTAL/date/store) ---------------- */

// Prefer TOTAL lines; ignore loyalty/points; ignore hyphenated IDs; avoid "largest number wins".
function extractReceiptTotal(text) {
  const raw = String(text || '');
  if (!raw) return null;

  const lines = raw
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const BAD_LINE =
    /\b(points?|redeem(ed)?|balance|bonus|base\s*points?|loyalty|member|rewards?)\b/i;

  const BAD_CONTEXT =
    /\b(invoice|inv|order|auth|approval|reference|ref|customer|acct|account|terminal|trace|batch|pump|litre|liter|l\/|price\/l)\b/i;

  const hasHyphenatedId = (s) => /\b\d{3,6}-\d{1,4}\b/.test(s);
  const hasLongDigitRun = (s) => /\b\d{8,}\b/.test(s);

  const money2dp = (s) =>
    s.match(/(?:^|[^0-9])(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d{1,6}\.\d{2})(?:[^0-9]|$)/);

  const toNum = (x) => {
    const n = Number(String(x).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const goodLine = (lc) => {
    if (BAD_LINE.test(lc)) return false;
    if (BAD_CONTEXT.test(lc)) return false;
    if (hasHyphenatedId(lc)) return false;
    if (hasLongDigitRun(lc)) return false;
    return true;
  };

  // 1) Strong: TOTAL lines
  for (const line of lines) {
    const lc = line.toLowerCase();
    if (!goodLine(lc)) continue;

    if (/\btotal\b/i.test(lc)) {
      const m = money2dp(lc);
      if (m?.[1]) {
        const n = toNum(m[1]);
        if (n != null && n > 0 && n < 100000) return Number(n.toFixed(2));
      }
    }
  }

  // 2) Backup: GRAND TOTAL / AMOUNT DUE
  for (const line of lines) {
    const lc = line.toLowerCase();
    if (!goodLine(lc)) continue;

    if (/\b(grand\s*total|amount\s*due|total\s*due)\b/i.test(lc)) {
      const m = money2dp(lc);
      if (m?.[1]) {
        const n = toNum(m[1]);
        if (n != null && n > 0 && n < 100000) return Number(n.toFixed(2));
      }
    }
  }

  // 3) Backup: Subtotal + Tax
  let subtotal = null;
  let tax = null;

  for (const line of lines) {
    const lc = line.toLowerCase();
    if (!goodLine(lc)) continue;

    if (/\bsubtotal\b/i.test(lc)) {
      const m = money2dp(lc);
      if (m?.[1]) {
        const n = toNum(m[1]);
        if (n != null && n > 0) subtotal = n;
      }
    }

    if (/\b(hst|gst|pst|tax)\b/i.test(lc)) {
      const m = money2dp(lc);
      if (m?.[1]) {
        const n = toNum(m[1]);
        if (n != null && n >= 0) tax = n;
      }
    }
  }

  if (subtotal != null && tax != null) {
    const n = subtotal + tax;
    if (Number.isFinite(n) && n > 0 && n < 100000) return Number(n.toFixed(2));
  }

  // 4) Final fallback: PURCHASE / PAID / DEBIT / AMOUNT
  let best = null;

  for (const line of lines) {
    const lc = line.toLowerCase();
    if (!goodLine(lc)) continue;

    if (/\b(purchase|paid|debit|credit|amount)\b/i.test(lc)) {
      const m = money2dp(lc);
      if (m?.[1]) {
        const n = toNum(m[1]);
        if (n != null && n > 0 && n < 100000) {
          if (best == null || n > best) best = n;
        }
      }
    }
  }

  if (best != null) return Number(best.toFixed(2));

  return null;
}

function extractReceiptTaxBreakdown(text) {
  const normalized = normalizeReceiptOcrForParsing(text);
  if (!normalized) {
    return { subtotal: null, tax: null, total: null, taxLabel: null };
  }

  const lines = normalized
    .split(/\n+/)
    .map((l) => String(l || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  let subtotal = null;
  let tax = null;
  let total = null;
  let taxLabel = null;

  const parseSafeMoney = (s) => {
    const str = String(s || '').trim();
    if (!str) return null;

    // Prefer explicit decimal money tokens
    const dec =
      str.match(/\$\s*(-?\d{1,6}(?:,\d{3})*\.\d{2})\b/) ||
      str.match(/\b(-?\d{1,6}(?:,\d{3})*\.\d{2})\b/);

    if (dec?.[1]) {
      const n = Number(String(dec[1]).replace(/,/g, ''));
      if (Number.isFinite(n) && n >= 0 && n <= 100000) return n;
    }

    // Only allow plain integers if small and labeled
    const intm =
      str.match(/\$\s*(-?\d{1,5})\b/) ||
      str.match(/\b(-?\d{1,5})\b/);

    if (intm?.[1]) {
      const rawNum = String(intm[1]).trim();
      if (rawNum.length > 5) return null;
      const n = Number(rawNum);
      if (Number.isFinite(n) && n >= 0 && n <= 100000) return n;
    }

    return null;
  };

  for (const line of lines) {
    if (subtotal == null && /\bsubtotal\b/i.test(line)) {
      const n = parseSafeMoney(line);
      if (n != null) subtotal = n;
    }

    // Standard tax labels: GST/HST, GST, HST, PST, TAX
    if (tax == null) {
      const m = line.match(/\b(gst\/hst|gst|hst|pst|tax)\b/i);
      if (m?.[1]) {
        const n = parseSafeMoney(line);
        if (n != null) {
          tax = n;
          taxLabel = String(m[1]).toUpperCase();
        }
      }
    }

    // Petro-Canada style: "FHST INCLUDE $1.08" / "PHST INCLUDE $1.73"
    // FHST = Federal HST, PHST = Provincial HST — sum both into a single tax value
    if (/\b(f|p)hst\s+include/i.test(line)) {
      const n = parseSafeMoney(line);
      if (n != null) {
        tax = tax != null ? Number((tax + n).toFixed(2)) : n;
        taxLabel = taxLabel || 'HST';
      }
    }

    if (total == null && /\b(total|amount due|balance due)\b/i.test(line)) {
      const n = parseSafeMoney(line);
      if (n != null) total = n;
    }
  }

  // Card/payment fallback — only accept decimal amounts
  if (total == null) {
    for (const line of lines) {
      if (!/\b(debit card|debit|visa|mastercard|amex|paid)\b/i.test(line)) continue;

      const dec =
        line.match(/\$\s*(-?\d{1,6}(?:,\d{3})*\.\d{2})\b/) ||
        line.match(/\b(-?\d{1,6}(?:,\d{3})*\.\d{2})\b/);

      if (dec?.[1]) {
        const n = Number(String(dec[1]).replace(/,/g, ''));
        if (Number.isFinite(n) && n > 0 && n <= 100000) {
          total = n;
          break;
        }
      }
    }
  }

  // Derive total from subtotal + tax if still missing
  if (total == null && subtotal != null && tax != null) {
    total = Number((subtotal + tax).toFixed(2));
  }

  // Derive subtotal from total - tax if subtotal not on receipt (e.g. fuel receipts)
  if (subtotal == null && total != null && tax != null) {
    subtotal = Number((total - tax).toFixed(2));
  }

  return {
    subtotal: subtotal != null ? subtotal.toFixed(2) : null,
    tax: tax != null ? tax.toFixed(2) : null,
    total: total != null ? total.toFixed(2) : null,
    taxLabel: taxLabel || null
  };
}

function normalizeReceiptOcrForParsing(text) {
  const raw = String(text || '');
  if (!raw) return '';

  let s = raw
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();

  s = s
    .replace(/\b(subtotal)\b/ig, '\n$1 ')
    .replace(/\b(gst\/hst|gst|hst|pst|tax)\b/ig, '\n$1 ')
    .replace(/\b([fp]hst\s+include)\b/ig, '\n$1 ')
    .replace(/\b(total|amount due|balance due)\b/ig, '\n$1 ')
    .replace(/\b(debit card|debit|visa|mastercard|amex)\b/ig, '\n$1 ')
    .replace(/\b(auth#?|acct|account|employee|you saved today|exchange or refund|returns? and refunds?|store details)\b/ig, '\n$1 ')
    .replace(/(\b\d{8,14}\b)\s+([A-Za-z])/g, '$1\n$2')
    // ✅ 6-7 digit product codes + 3+ uppercase (hardware receipt short SKUs)
    .replace(/(\b\d{6,7}\b)\s+([A-Z]{3,})/g, '$1\n$2')
    // ✅ Barcode + price + short unit/tax codes → split before product description
    // e.g. "773615003161 77.89 RL B MEMBRANE" → "773615003161 77.89 RL B\nMEMBRANE"
    .replace(/(\b\d{8,14}\b(?:\s+[\d.,]+)+(?:\s+[A-Z]{1,3}){1,3}\s+)([A-Z]{4,})/g, '$1\n$2')
    .replace(/(\$\s*\d+\.\d{2})\s+([A-Za-z]{3,})/g, '$1\n$2');

  return s;
}

function formatMoneyDisplayMaybe(v) {
  const n =
    typeof v === 'number'
      ? v
      : Number(String(v || '').replace(/[^0-9.,-]/g, '').replace(/,/g, ''));

  if (!Number.isFinite(n)) return null;
  return formatMoneyDisplay(n);
}

function formatMoneyMaybe(amountStrOrNum) {
  const n =
    typeof amountStrOrNum === 'number'
      ? amountStrOrNum
      : Number(String(amountStrOrNum || '').replace(/[^0-9.,-]/g, '').replace(/,/g, ''));

  if (!Number.isFinite(n)) return null;
  return formatMoneyDisplay(n);
}



function extractReceiptDateYYYYMMDD(text, tz = 'America/Toronto') {
  const src = String(text || '').trim();
  if (!src) return null;

  // 1) MM/DD/YY or MM/DD/YYYY (receipt common)
  // Example: 01/13/26 or 01/13/2026
  const m1 = src.match(/\b(0?[1-9]|1[0-2])[\/\-\.](0?[1-9]|[12]\d|3[01])[\/\-\.](\d{2}|\d{4})\b/);
  if (m1) {
    let mm = Number(m1[1]);
    let dd = Number(m1[2]);
    let yy = String(m1[3]);
    let yyyy = yy.length === 2 ? (Number(yy) >= 70 ? 1900 + Number(yy) : 2000 + Number(yy)) : Number(yy);
    const pad = (n) => String(n).padStart(2, '0');
    return `${yyyy}-${pad(mm)}-${pad(dd)}`;
  }

  // 2) Month name formats: "Jan 13, 2026" / "January 13 2026"
  const m2 = src.match(
    /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+([0-3]?\d)(?:st|nd|rd|th)?(?:,)?\s+(\d{4})\b/i
  );
  if (m2) {
    const mon = m2[1].toLowerCase();
    const day = Number(m2[2]);
    const year = Number(m2[3]);

    const map = {
      jan: 1, january: 1,
      feb: 2, february: 2,
      mar: 3, march: 3,
      apr: 4, april: 4,
      may: 5,
      jun: 6, june: 6,
      jul: 7, july: 7,
      aug: 8, august: 8,
      sep: 9, sept: 9, september: 9,
      oct: 10, october: 10,
      nov: 11, november: 11,
      dec: 12, december: 12
    };

    const mm = map[mon];
    if (mm) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${year}-${pad(mm)}-${pad(day)}`;
    }
  }

  return null;
}

function extractReceiptDate(text, tz = 'America/Toronto') {
  return extractReceiptDateYYYYMMDD(text, tz);
}


function extractReceiptStore(text) {
  const t = normalizeDashes(String(text || '')).replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // 1) Strong explicit vendor phrases
  // e.g. "TRANSACTION RECORD PETRO-CANADA"
  {
    const m = t.match(/\bTRANSACTION\s+RECORD\s+([A-Z0-9&' .-]{3,40})\b/i);
    if (m?.[1]) {
      const cand = String(m[1]).trim();
      if (!/\b(total|interac|fuel|sales|hst|gst|pst|invoice|auth|reference)\b/i.test(cand)) {
        const cleaned = cand.replace(/\s{2,}/g, ' ').trim();
        if (cleaned && cleaned.length <= 40) return titleCaseVendor(cleaned);
      }
    }
  }

  // 2) Brand keyword fallbacks (high precision)
  if (/\bPETRO[- ]?CANADA\b/i.test(t)) return 'Petro-Canada';
  if (/\bESSO\b/i.test(t)) return 'Esso';
  if (/\bSHELL\b/i.test(t)) return 'Shell';
  if (/\bULTRAMAR\b/i.test(t)) return 'Ultramar';
  if (/\bPIONEER\b/i.test(t)) return 'Pioneer';
  if (/\bCIRCLE\s*K\b/i.test(t)) return 'Circle K';

  if (/\bHOME\s*DEPOT\b/i.test(t)) return 'Home Depot';
  if (/\bHOME\s*HARDWARE\b/i.test(t)) return 'Home Hardware';
  if (/\bRONA\b/i.test(t)) return 'Rona';
  if (/\bLOWE'?S\b/i.test(t)) return "Lowe's";

  // 3) Nothing found
  return null;
}

// Optional: tiny helper to keep vendor formatting sane
function titleCaseVendor(s) {
  const x = String(s || '').trim();
  if (!x) return null;
  // Preserve common brand styling
  if (/petro[- ]?canada/i.test(x)) return 'Petro-Canada';
  if (/circle\s*k/i.test(x)) return 'Circle K';
  // Default title case
  return x
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}


/* ---------------- category heuristics ---------------- */

function isUnknownItem(x) {
  const s = String(x || '').trim().toLowerCase();
  return !s || s === 'unknown' || s.startsWith('unknown ');
}

function vendorDefaultCategory(store) {
  const s = String(store || '').toLowerCase();
  if (/(home depot|homedepot|rona|lowe|lowes|home hardware|convoy|gentek|abc supply|beacon|roofmart|kent)/i.test(s))
    return 'Materials';
  if (/(esso|shell|petro|ultramar|pioneer|circle\s*k)/i.test(s)) return 'Fuel';
  return null;
}

function filterVendors(all, frag) {
  const f = String(frag || '').toLowerCase().trim();
  if (!f) return [];
  return (all || []).filter(v =>
    String(v?.name || '').toLowerCase().includes(f)
  );
}

function inferExpenseCategoryHeuristic(data) {
  const s = String(data?.store || '').toLowerCase();
  const it = String(data?.item || '').toLowerCase();

  if (/(esso|shell|petro|ultramar|pioneer|circle\s*k)/i.test(s)) return 'Fuel';
  if (/(home depot|homedepot|rona|lowe|lowes|home hardware|convoy|gentek|abc supply|beacon|roofmart|kent)/i.test(s))
    return 'Materials';
  if (/\b(subcontract|sub-contractor|sub contractor)\b/i.test(it)) return 'Subcontractors';
  if (/\b(lunch|coffee|meal)\b/i.test(it)) return 'Meals';
  return null;
}
function isControlDuringEdit(rawInboundText, twilioMeta) {
  return (
    isCancelIntent(rawInboundText, twilioMeta) ||
    isSkipIntent(rawInboundText, twilioMeta) ||
    isEditIntent(rawInboundText, twilioMeta) ||
    strictDecisionTokenExact(rawInboundText) === 'resume'
  );
}

function formatMoneyDisplay(n) {
  try {
    const fmt = new Intl.NumberFormat('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `$${fmt.format(n)}`;
  } catch {
    return `$${Number(n).toFixed(2)}`;
  }
}

async function resolveExpenseCategory({ ownerId, data, ownerProfile }) {
  const vendor = String(data?.store || '').trim() || 'Unknown Store';
  const itemText = String(data?.item || '').trim();

  if (data?.suggestedCategory && String(data.suggestedCategory).trim()) return String(data.suggestedCategory).trim();

  try {
    const fromRules = await getCategorySuggestion(ownerId, 'expense', vendor, itemText);
    if (fromRules && String(fromRules).trim()) return String(fromRules).trim();
  } catch (e) {
    console.warn('[EXPENSE] getCategorySuggestion failed (ignored):', e?.message);
  }

  const fromVendor = vendorDefaultCategory(vendor);
  if (fromVendor) return fromVendor;

  const fromAI = await Promise.resolve(categorizeEntry('expense', data, ownerProfile)).catch(() => null);
  if (fromAI && String(fromAI).trim()) return String(fromAI).trim();

  const fromHeur = inferExpenseCategoryHeuristic(data);
  if (fromHeur) return fromHeur;

  return null;
}



/* ---------------- Active job persistence (expense.js) ---------------- */
/**
 * Best-effort persist active job for this identity.
 *
 * Prefers:
 *  - pg.setActiveJobForIdentity(ownerDigits, identityDigits, jobUuid|null, jobName|null)
 *  - pg.setActiveJob(ownerDigits, identityDigits, jobRef)   (jobRef = jobName OR job_no)
 *  - SQL fallback using `query` (NOT pg.query)
 *
 * Rules:
 *  - NEVER persist picker tokens (jobno_/jobix_/job_<ix>_<nonce>/#123)
 *  - NEVER write non-UUID into *_job_id uuid columns
 *  - identity = normalizeIdentityDigits(fromPhone) (aligns with pg.getActiveJobForIdentity usage)
 */
async function persistActiveJobBestEffort({ ownerId, userProfile, fromPhone, jobRow, jobNameFallback }) {
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

  if (!owner || !identity) {
    console.warn('[JOB] persistActiveJobBestEffort: missing owner/identity', { ownerId, identity });
    return false;
  }

  const isBadJobNameToken = (s) => {
    const t = String(s || '').trim();
    if (!t) return true;
    const lc = t.toLowerCase();
    if (/^jobix_\d+$/i.test(lc)) return true;
    if (/^jobno_\d+$/i.test(lc)) return true;
    if (/^job_\d+_[0-9a-z]+$/i.test(lc)) return true;
    if (/^#\s*\d+\b/.test(lc)) return true;
    if (/^ix_\d+$/i.test(lc)) return true;
    return false;
  };

  const rawId = jobRow?.id ?? jobRow?.job_id ?? jobRow?.jobId ?? null;
  const rawJobNo = jobRow?.job_no ?? jobRow?.jobNo ?? null;

  const rawNameRow =
    typeof sanitizeJobLabel === 'function'
      ? sanitizeJobLabel(jobRow?.name || jobRow?.job_name || jobRow?.jobName || '')
      : String(jobRow?.name || jobRow?.job_name || jobRow?.jobName || '').trim();

  const rawNameFallback =
    typeof sanitizeJobLabel === 'function'
      ? sanitizeJobLabel(jobNameFallback || '')
      : String(jobNameFallback || '').trim();

  const jobUuid = rawId && looksLikeUuid(rawId) ? String(rawId) : null;
  const jobNo = rawJobNo != null && Number.isFinite(Number(rawJobNo)) ? Number(rawJobNo) : null;

  const jobName =
    (rawNameRow && !isBadJobNameToken(rawNameRow) ? rawNameRow : null) ||
    (rawNameFallback && !isBadJobNameToken(rawNameFallback) ? rawNameFallback : null) ||
    null;

  // No junk persistence
  if (!jobUuid && jobNo == null && !jobName) return false;

  // 1) Canonical identity-based setter
  if (typeof pg.setActiveJobForIdentity === 'function') {
    try {
      await pg.setActiveJobForIdentity(owner, String(identity), jobUuid || null, jobName || null);
      return true;
    } catch (e) {
      console.warn('[JOB] pg.setActiveJobForIdentity failed:', e?.message);
    }
  }

  // 2) setActiveJob(owner, identity, jobRef) where jobRef is human ref (name or job_no)
  const jobRef = jobName || (jobNo != null ? String(jobNo) : null);
  if (typeof pg.setActiveJob === 'function' && jobRef) {
    try {
      await pg.setActiveJob(owner, String(identity), String(jobRef));
      return true;
    } catch (e) {
      console.warn('[JOB] pg.setActiveJob failed:', e?.message);
    }
  }

  // 3) SQL fallback using `query` (NOT pg.query)
  if (typeof query === 'function') {
    // Only write UUIDs into uuid columns
    const jobUuidOrNull = jobUuid || null;
    const jobNameOrEmpty = jobName || '';

    const sqlAttempts = [
      {
        label: 'public.users',
        sql: `UPDATE public.users
                SET active_job_id = $3::uuid,
                    active_job_name = NULLIF($4,''),
                    updated_at = NOW()
              WHERE owner_id = $1 AND user_id = $2`
      },
      {
        label: 'public.user_profiles',
        sql: `UPDATE public.user_profiles
                SET active_job_id = $3::uuid,
                    active_job_name = NULLIF($4,''),
                    updated_at = NOW()
              WHERE owner_id = $1 AND user_id = $2`
      },
      {
        label: 'public.memberships',
        sql: `UPDATE public.memberships
                SET active_job_id = $3::uuid,
                    active_job_name = NULLIF($4,''),
                    updated_at = NOW()
              WHERE owner_id = $1 AND user_id = $2`
      }
    ];

    // If we don't have a uuid, skip uuid writes; only set name
    const sqlNameOnlyAttempts = [
      {
        label: 'public.users(name-only)',
        sql: `UPDATE public.users
                SET active_job_name = NULLIF($3,''),
                    updated_at = NOW()
              WHERE owner_id = $1 AND user_id = $2`
      },
      {
        label: 'public.user_profiles(name-only)',
        sql: `UPDATE public.user_profiles
                SET active_job_name = NULLIF($3,''),
                    updated_at = NOW()
              WHERE owner_id = $1 AND user_id = $2`
      },
      {
        label: 'public.memberships(name-only)',
        sql: `UPDATE public.memberships
                SET active_job_name = NULLIF($3,''),
                    updated_at = NOW()
              WHERE owner_id = $1 AND user_id = $2`
      }
    ];

    try {
      if (jobUuidOrNull) {
        for (const a of sqlAttempts) {
          try {
            const r = await query(a.sql, [owner, String(identity), jobUuidOrNull, jobNameOrEmpty]);
            if (r?.rowCount) return true;
          } catch {}
        }
      } else if (jobNameOrEmpty) {
        for (const a of sqlNameOnlyAttempts) {
          try {
            const r = await query(a.sql, [owner, String(identity), jobNameOrEmpty]);
            if (r?.rowCount) return true;
          } catch {}
        }
      }
    } catch (e) {
      console.warn('[JOB] SQL fallback persist failed:', e?.message);
    }
  }

  return false;
}

/* ---------------- Job list + picker mapping (JOB_NO-FIRST) ---------------- */

function sanitizeJobLabel(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeIdentityDigits(x) {
  const s = String(x || '').trim();
  if (!s) return null;
  return s.replace(/^whatsapp:/i, '').replace(/^\+/, '').replace(/\D/g, '') || null;
}

function normalizeIdentity(x) {
  return normalizeIdentityDigits(x);
}

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
function looksLikeReceiptText(s) {
  const t = String(s || '').toLowerCase();
  if (!t) return false;
  // common receipt cues + liney OCR texture
  const cues = ['subtotal', 'total', 'hst', 'gst', 'pst', 'visa', 'mastercard', 'debit', 'approved', 'receipt', 'cashier'];
  const cueHit = cues.some((w) => t.includes(w));
  const manyLines = (t.match(/\n/g) || []).length >= 6;
  const manyNumbers = (t.match(/[0-9]/g) || []).length >= 25;
  return cueHit || (manyLines && manyNumbers);
}


function isGarbageJobName(name) {
  const lc = String(name || '').trim().toLowerCase();

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
async function resolveJobNameByNo(ownerId, jobNo) {
  const n = Number(jobNo);
  if (!Number.isFinite(n) || n <= 0) return null;

  // prefer postgres.js helper if you have it
  const fn =
    (typeof pg.resolveJobRow === 'function' && pg.resolveJobRow) ||
    (typeof pg.getJobByNo === 'function' && pg.getJobByNo) ||
    null;

  if (fn) {
    try {
      const row = await fn(ownerId, n);
      const nm = String(row?.job_name || row?.name || '').trim();
      return nm || null;
    } catch {}
  }

  // fallback to direct query
  if (typeof query === 'function') {
    try {
      const r = await query(
        `
        select coalesce(name, job_name) as name
          from public.jobs
         where owner_id=$1 and job_no=$2
         limit 1
        `,
        [String(ownerId), n]
      );
      const nm = String(r?.rows?.[0]?.name || '').trim();
      return nm || null;
    } catch {}
  }

  return null;
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
    const rawName = j?.name || j?.job_name || j?.jobName;
    const name = sanitizeJobLabel(stripLeadingJobCode(rawName));
    if (!name) continue;
    if (isGarbageJobName(name)) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const jobNo = j?.job_no != null ? Number(j.job_no) : j?.jobNo != null ? Number(j.jobNo) : null;
    if (jobNo == null || !Number.isFinite(jobNo)) continue;

    const rawId = j?.id != null ? String(j.id) : j?.job_id != null ? String(j.job_id) : null;
    const safeUuidId = rawId && looksLikeUuid(rawId) ? rawId : null;

    out.push({ id: safeUuidId, job_no: jobNo, name });
  }

  return out;
}
function coerceJobixToJobno(raw, displayedJobNos) {
  const s = String(raw || '').trim();
  const m = s.match(/^jobix_(\d{1,10})$/i);
  if (!m?.[1]) return s;

  const ix = Number(m[1]);
  if (!Number.isFinite(ix) || ix <= 0) return s;

  const arr = Array.isArray(displayedJobNos) ? displayedJobNos : [];
  const jobNo = arr[ix - 1]; // jobix is 1-based
  if (jobNo == null || !Number.isFinite(Number(jobNo))) return s;

  return `jobno_${Number(jobNo)}`;
}


/**
 * Deterministic resolver (JOB_NO-first) with belt & suspenders:
 * - Accepts jobno_<job_no>, job_<n>_<hash>, jobix_<ix>, "#1556", "J1556", "1556", "1" (page-local), name.
 * - Uses displayedJobNos when available to interpret index replies safely.
 * - ✅ Treats job_<n>_<hash> as INDEX ONLY (Twilio list), never job_no.
 *
 * MVP guardrails:
 * - Pure numeric replies ("1") are treated as ROW INDEX first (when displayedJobNos exists),
 *   then page-index fallback ONLY if displayedJobNos is missing AND the slice exists.
 * - Index tokens (job_<ix>_<hash>, jobix_<ix>) FAIL-CLOSED if displayedJobNos is missing.
 */
function resolveJobOptionFromReply(input, jobOptions, { page = 0, pageSize = 10, displayedJobNos = null } = {}) {
  const raw = normalizeJobAnswer(input);
  let t0 = String(raw || '').trim();
  if (!t0) return null;

  const lc0 = t0.toLowerCase();
  if (looksLikeOverhead(t0)) return { kind: 'overhead' };
  if (lc0 === 'more' || lc0 === 'more jobs' || lc0 === 'more jobs…') return { kind: 'more' };

  const p = Math.max(0, Number(page || 0));
  const ps = Math.min(10, Math.max(1, Number(pageSize) || 10));
  const opts = Array.isArray(jobOptions) ? jobOptions : [];
  const arr = Array.isArray(displayedJobNos) ? displayedJobNos : null;

  const findByJobNo = (jobNo) => {
    const n = Number(jobNo);
    if (!Number.isFinite(n)) return null;
    return opts.find((j) => Number(j?.job_no ?? j?.jobNo) === n) || null;
  };

  // Helper: page slice lookup (least preferred; only used when arr missing and we truly must)
  const findByRowIndexInPage = (ix1Based) => {
    const ix = Number(ix1Based);
    if (!Number.isFinite(ix) || ix <= 0) return null;
    const start = p * ps;
    const idx = start + (ix - 1);
    const opt = opts[idx] || null;
    if (opt && Number.isFinite(Number(opt?.job_no ?? opt?.jobNo))) return opt;
    return null;
  };

  // --- A) jobno_123 (canonical job_no) ---
  let m = t0.match(/^jobno_(\d{1,10})$/i);
  if (m?.[1]) {
    const opt = findByJobNo(m[1]);
    return opt ? { kind: 'job', job: opt } : null;
  }

  // --- B) Twilio list token: job_<ix>_<hash> (INDEX ONLY) ---
  m = t0.match(/^job_(\d{1,10})_[0-9a-z]+$/i);
  if (m?.[1]) {
    const ix = Number(m[1]);
    if (!Number.isFinite(ix) || ix <= 0) return null;

    // ✅ FAIL-CLOSED if we don't have displayed mapping (prevents wrong-job assignment)
    if (!arr || !arr.length || arr.length < ix) return null;

    const mappedJobNo = arr[ix - 1];
    const opt = findByJobNo(mappedJobNo);
    return opt ? { kind: 'job', job: opt } : null;
  }

  // --- C) jobix_5 (index token) ---
  m = t0.match(/^jobix_(\d{1,10})$/i);
  if (m?.[1]) {
    const ix = Number(m[1]);
    if (!Number.isFinite(ix) || ix <= 0) return null;

    // ✅ FAIL-CLOSED if displayed mapping missing
    if (!arr || !arr.length || arr.length < ix) return null;

    const mappedJobNo = arr[ix - 1];
    const opt = findByJobNo(mappedJobNo);
    return opt ? { kind: 'job', job: opt } : null;
  }

  // --- D) Pure numeric reply "1" ---
  // ✅ ROW INDEX FIRST when displayedJobNos exists, because that's what users mean in picker context.
  if (/^\d+$/.test(t0)) {
    const n = Number(t0);
    if (!Number.isFinite(n) || n <= 0) return null;

    if (arr && arr.length >= n) {
      const mappedJobNo = arr[n - 1];
      const opt = findByJobNo(mappedJobNo);
      if (opt) return { kind: 'job', job: opt };
      return null;
    }

    // If no displayed mapping, treat as page row index (least preferred)
    const opt = findByRowIndexInPage(n);
    return opt ? { kind: 'job', job: opt } : null;
  }

  // --- E) "#1556 ..." or "J1556 ..." or "1556 ..." => job_no intent ---
  // This runs AFTER the pure-numeric row-index logic.
  m = t0.match(/^(?:#\s*)?(\d{1,10})\b/);
  if (m?.[1]) {
    const opt = findByJobNo(m[1]);
    if (opt) return { kind: 'job', job: opt };
  }

  m = t0.match(/^\s*J(\d{1,10})\b/i);
  if (m?.[1]) {
    const opt = findByJobNo(m[1]);
    if (opt) return { kind: 'job', job: opt };
  }

  // --- F) Name match ---
  const lc = t0.toLowerCase();
  const opt =
    opts.find((j) => String(j?.name || j?.job_name || '').trim().toLowerCase() === lc) ||
    opts.find((j) => String(j?.name || j?.job_name || '').trim().toLowerCase().startsWith(lc.slice(0, 24))) ||
    null;

  if (opt && Number.isFinite(Number(opt?.job_no ?? opt?.jobNo))) return { kind: 'job', job: opt };

  return null;
}




const ENABLE_INTERACTIVE_LIST = (() => {
  const raw = process.env.TWILIO_ENABLE_INTERACTIVE_LIST ?? process.env.TWILIO_ENABLE_LIST_PICKER ?? 'true';
  return String(raw).trim().toLowerCase() !== 'false';
})();
exports.ENABLE_INTERACTIVE_LIST = ENABLE_INTERACTIVE_LIST;

function buildTextJobPrompt(jobOptions, page, pageSize) {
  const p = Math.max(0, Number(page || 0));
  const ps = Math.min(10, Math.max(1, Number(pageSize) || 10));

  const start = p * ps;
  const slice = (jobOptions || []).slice(start, start + ps);

  const lines = slice.map((j, i) => {
    const rawName = j?.name || j?.job_name || j?.jobName;
    const name = sanitizeJobLabel(stripLeadingJobCode(rawName));
    const jobNo = j?.job_no != null ? Number(j.job_no) : null;

    // ✅ Make the number semantics unambiguous:
    // i+1 is the *row index*, jobNo is the *real job number*
    if (jobNo != null && Number.isFinite(jobNo)) {
      return `${i + 1}) Job #${jobNo} — ${name}`;
    }
    return `${i + 1}) ${name}`;
  });

  const hasMore = start + ps < (jobOptions || []).length;
  const more = hasMore ? `\nReply "more" for more jobs.` : '';

  return (
    `Which job is this expense for?\n\n` +
    `${lines.join('\n')}\n\n` +
    `Reply with a number, job name, or "Overhead".${more}\n` +
    `Tip: reply "change job" to see the picker.`
  );
}
exports.buildTextJobPrompt = buildTextJobPrompt;



function looksLikeNewExpenseText(s = '') {
  const lc = String(s || '').trim().toLowerCase();
  if (!lc) return false;

  if (/^(expense|exp)\b/.test(lc)) return true;

  return (
    /\b(spent|bought|purchase|purchased|paid|receipt|cost|home\s*depot|rona|lowe'?s|home\s*hardware|beacon)\b/.test(lc) &&
    /\$?\s*\d+(\.\d{1,2})?\b/.test(lc)
  );
}
/* ---------------- Job picker helpers ---------------- */

function capListTitle(s, max = 24) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function getJobDisplayNameNoCode(job) {
  const raw = String(getJobDisplayName?.(job) || job?.name || '').trim();
  if (!raw) return '';

  // Remove leading "J<number>" patterns:
  // "J1 1556 Medway Park Dr" -> "1556 Medway Park Dr"
  // "J12 - Oak St" -> "Oak St"
  // "J12: Oak St" -> "Oak St"
  return raw.replace(/^\s*J\d+\s*[-:–—]?\s*/i, '').trim();
}

function getJobDisplayName(job) {
  const nm = String(job?.name || job?.job_name || job?.jobName || job?.job_name_display || '').trim();
  return nm || null;
}

function stripLeadingJobCode(s) {
  const t = String(s || '').trim();
  if (!t) return '';

  // "J1 1556 Medway Park Dr" -> "1556 Medway Park Dr"
  // "J12 - Oak St" -> "Oak St"
  // "J12: Oak St" -> "Oak St"
  return t.replace(/^\s*J\d+\s*[-:–—]?\s*/i, '').trim();
}

function getJobDisplayNameClean(job) {
  const nm = String(job?.name || job?.job_name || job?.jobName || job?.job_name_display || '').trim();
  const cleaned = stripLeadingJobCode(nm);
  return cleaned || null;
}

// tiny nonce for "this picker instance"
function makePickerNonce() {
  return Math.random().toString(16).slice(2, 10);
}

// Twilio list token Body/ListId like: job_2_abcd1234 (2 == row index, 1-based)
function parseTwilioJobIndexToken(s) {
  const m = String(s || '').trim().match(/^job_(\d{1,10})_[0-9a-z]+$/i);
  if (!m?.[1]) return null;
  const ix = Number(m[1]);
  return Number.isFinite(ix) && ix >= 1 ? ix : null;
}
function extractJobNoFromWhatsAppListTitle(title) {
  const s = String(title || '').trim();

  // "#1 1556 Medway Park Dr"
  let m = s.match(/^#\s*(\d{1,6})\b/);
  if (m) return Number(m[1]);

  // "1 1556 Medway Park Dr"
  m = s.match(/^(\d{1,6})\b/);
  if (m) return Number(m[1]);

  // "Job #12 — Something"
  m = s.match(/\bjob\s*#\s*(\d{1,6})\b/i);
  if (m) return Number(m[1]);

  return null;
}
// helpers used above (ensure they exist)
function randHex8() {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0').slice(0, 8);
}
function hash8(s) {
  const x = require('crypto').createHash('sha1').update(String(s || '')).digest('hex');
  return x.slice(0, 8);
}
// ============================================================================
// ✅ DROP-IN: sendJobPickList (FULLY ACTIVATES stable jp: row IDs via makeRowId)
// ----------------------------------------------------------------------------
// What's new vs your current sendJobPickList:
// 1) Uses makeRowId({ flow, nonce, jobNo, secret }) for each row.id  ✅
// 2) Stores `flow8` (8-hex) in PA payload so parseRowId() expects jp:<flow8>:<nonce>:... ✅
// 3) Leaves displayedJobNos + sentRows intact (resolver still has fallbacks)
// 4) Keeps lastPickerMsgSid stale-click hardening unchanged
//
// REQUIREMENTS (already in your file per your snippet):
// - makeRowId({ flow, nonce, jobNo, secret }) exists
// - randHex8() exists
// - PA_TTL_SEC, PA_KIND_PICK_JOB exist
// - upsertPA(), sendWhatsAppInteractiveList(), twimlEmpty(), out(), waTo()
// - normalizeIdentityDigits(), getJobDisplayName(), hash8() exist
//
// ENV needed (pick ONE; either works):
// - JOB_PICKER_ROWID_SECRET   (recommended)
// - TWILIO_ROWID_SECRET       (fallback)
// ============================================================================

async function sendJobPickList({
  fromPhone,
  ownerId,
  userProfile,
  confirmFlowId,
  jobOptions,
  paUserId,
  pickUserId,
  page = 0,
  pageSize = 10,
  context = 'expense_jobpick',
  confirmDraft = null,
  resolveAttempts = 0 // ✅ NEW
}) {
  const to = waTo(fromPhone);
  if (!to) return out(twimlText('Missing recipient.'), false);

  // ✅ Guard: enforce that callers pass pickUserId (canonical PA key)
  // We still fail-open to paUserId so we don't break prod flows,
  // but this warns loudly so you can fix missed callsites.
  const pickUserIdDigits = normalizeIdentityDigits(pickUserId);
  if (!pickUserIdDigits) {
    console.warn('[JOB_PICK] missing/invalid pickUserId; falling back to paUserId', {
      pickUserId: pickUserId || null,
      paUserId: paUserId || null,
      fromPhone: fromPhone || null,
      context: context || null
    });
  }

  // ✅ SINGLE canonical pick key for PA_KIND_PICK_JOB writes (digits-first, always)
  const pickKey =
    pickUserIdDigits ||
    normalizeIdentityDigits(paUserId) ||
    normalizeIdentityDigits(userProfile?.wa_id) ||
    normalizeIdentityDigits(fromPhone) ||
    String(fromPhone || '').replace(/\D/g, '') ||
    String(fromPhone || '').trim();

  const p = Math.max(0, Number(page) || 0);
  const ps = Math.min(10, Math.max(1, Number(pageSize) || 10));

  const safeJobs = Array.isArray(jobOptions) ? jobOptions : [];
  const total = safeJobs.length;

  const start = p * ps;
  const end = start + ps;

  const pageJobs = safeJobs.slice(start, end);
  const hasMore = end < total;

  // Stable flow for this picker session:
  // ✅ MUST be stable across pages + replies for this confirm flow
  const flowRaw = String(confirmFlowId || '').trim() || String(`${paUserId}:${Date.now()}`).trim();

  // ✅ IMPORTANT: jp: row ids expect 8-hex flow (parseRowId regex is 8-hex)
  // Use hash8(flowRaw) to generate a stable, 8-hex flow token
  const flow8 = hash8(flowRaw);

  // Nonce rotates per send to prevent stale replays
  const pickerNonce = randHex8(); // 8-hex

  // Secret for signing stable row ids
  const rowSecret =
    String(process.env.JOB_PICKER_ROWID_SECRET || process.env.TWILIO_ROWID_SECRET || '').trim();

  if (!rowSecret) {
    console.warn('[JOB_PICK] missing JOB_PICKER_ROWID_SECRET/TWILIO_ROWID_SECRET; jp: row ids will still be generated but signature will be weak/invalid if makeRowId depends on secret.');
  }

  // displayedJobNos are REAL jobNos (not UI indexes)
  const displayedJobNos = pageJobs
    .map((j) => Number(j?.job_no ?? j?.jobNo))
    .filter((n) => Number.isFinite(n) && n > 0);

  const displayedHash = hash8(displayedJobNos.join(','));

  // ✅ ROW TITLES MUST BE NAME-ONLY (Twilio adds its own #index)
  // ✅ sentRows must carry jobNo so resolver can map title->jobNo reliably
  // ✅ NEW: row.id is a signed stable jp: row id
  const sentRows = pageJobs.map((j) => {
    const jobNo = Number(j?.job_no ?? j?.jobNo);
    const name =
  String(getJobDisplayNameNoCode(j) || j?.name || '').trim() ||
  `Job ${jobNo || ''}`.trim();

   let stableId = `jobno_${jobNo}`; // fallback
if (typeof makeRowId === 'function' && Number.isFinite(jobNo) && jobNo > 0) {
  try {
    stableId = makeRowId({ flow: flow8, nonce: pickerNonce, jobNo, secret: rowSecret });
  } catch (e) {
    console.warn('[JOB_PICK] makeRowId failed; using fallback jobno_', { jobNo, err: e?.message });
    stableId = `jobno_${jobNo}`;
  }
}

    return {
      jobNo,
      name,
      id: stableId, // ✅ FULLY ACTIVATED: jp:<flow8>:<nonce>:jn:<jobNo>:h:<sig>
     title: capListTitle(name, 24) // ✅ truncation-safe for WhatsApp UI
    };
  });

  console.info('[JOB_PICK_CLEAN]', {
    total,
    page: p,
    displayedJobNos,
    hasMore
  });

  console.info('[JOB_PICK_SEND]', {
    context,
    flow: flow8,
    pickerNonce,
    page: p,
    displayedHash,
    displayedJobNos,
    rows: sentRows.map((r) => ({
      id: String(r.id || '').slice(0, 42) + (String(r.id || '').length > 42 ? '…' : ''),
      title: r.title,
      jobNo: r.jobNo
    }))
  });

  const bodyText = hasMore
  ? 'Tap a job below. Reply "more" to see more jobs.'
  : 'Tap a job below.';


  const sections = [
    {
      title: 'Jobs',
      rows: sentRows.map((r) => ({ id: r.id, title: r.title }))
    }
  ];

  // ✅ Send the interactive list via your wrapper signature
// IMPORTANT: capture result to store picker message SID for stale-click protection
let sendResult = null;
try {
  sendResult = await sendWhatsAppInteractiveList({
    to,
    bodyText,
    buttonText: 'Pick job',
    sections
  });

  // Twilio usually returns `{ sid }` for message create; sometimes wrapper returns full Message.
  const sid = String(sendResult?.sid || sendResult?.messageSid || sendResult?.MessageSid || '').trim() || null;
  const status = String(sendResult?.status || '').trim() || null;

  console.info('[JOB_PICK_SENT]', { to, sid, status });
} catch (e) {
  console.warn('[JOB_PICK_SEND] sendWhatsAppInteractiveList failed:', e?.message);
  // fail-open (Twilio wrapper may already have fallback). Continue to persist PA anyway.
}

// ✅ NEW: store picker message SID for stale-click protection (even if we only have `{ sid }`)
const lastPickerMsgSid =
  String(sendResult?.sid || sendResult?.messageSid || sendResult?.MessageSid || '').trim() || null;


  await upsertPA({
  ownerId,
  userId: pickKey,
  kind: PA_KIND_PICK_JOB,
  payload: {
    context: String(context || 'expense_jobpick'),
    flow: flow8,
    confirmFlowId: String(confirmFlowId || '').trim() || null,
    page: p,
    pageSize: ps,
    hasMore,
    sentAt: Date.now(),
    pickerNonce,
    displayedHash,
    displayedJobNos,
    sentRows,
    jobOptions: safeJobs,
    confirmDraft: confirmDraft || null,
    lastPickerMsgSid: lastPickerMsgSid || null,
    resolveAttempts: Number(resolveAttempts || 0) || 0
  },
  ttlSeconds: PA_TTL_SEC
});



  return out(twimlEmpty(), true);
}




/* ---------------- Active job resolution ---------------- */

let _ACTIVE_JOB_IDENTITY_OK = null;

function pickActiveJobNameFromAny(out1) {
  const candidates = [
    out1?.active_job_name,
    out1?.activeJobName,
    out1?.name,
    out1?.job_name,
    out1?.jobName,
    out1?.job?.name,
    out1?.job?.job_name
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

  if (_ACTIVE_JOB_IDENTITY_OK === false) return null;

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
      const out1 = await pg.getActiveJobForIdentity(owner, identity);
      _ACTIVE_JOB_IDENTITY_OK = true;

      const n = pickActiveJobNameFromAny(out1);
      if (n) return n;

      return null;
    } catch (e) {
      const msg = String(e?.message || '').toLowerCase();
      const code = String(e?.code || '');
      if (code === '42P01' || msg.includes('memberships')) _ACTIVE_JOB_IDENTITY_OK = false;
    }
  }

  const fallbackFns = ['getActiveJobForPhone', 'getActiveJobForUser', 'getActiveJob', 'getUserActiveJob'];
  for (const fn of fallbackFns) {
    if (typeof pg[fn] !== 'function') continue;
    try {
      const out1 = await pg[fn](String(owner), String(identity));
      const n1 = pickActiveJobNameFromAny(out1);
      if (n1) return n1;
    } catch {}
  }

  return null;
}

async function persistActiveJobFromExpense({ ownerId, fromPhone, userProfile, jobNo, jobName }) {
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
    console.warn('[EXPENSE] persistActiveJobFromExpense failed (ignored):', e?.message);
    return false;
  }
}

/* ---------------- CIL builders ---------------- */

function buildExpenseCIL_LogExpense({ from, data, jobName, category, sourceMsgId }) {
  const cents = toCents(data.amount);
  return {
    type: 'LogExpense',
    job: jobName ? String(jobName) : undefined,
    item: String(data.item || '').trim() || undefined,
    amount_cents: cents,
    store: data.store && data.store !== 'Unknown Store' ? String(data.store) : undefined,
    date: data.date ? String(data.date) : undefined,
    category: category ? String(category) : undefined,
    source_msg_id: sourceMsgId ? String(sourceMsgId) : undefined,
    actor_phone: from ? String(from) : undefined
  };
}

function buildExpenseCIL_Legacy({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  const cents = toCents(data.amount);

  return {
    cil_version: '1.0',
    type: 'expense',

    // ✅ owner_id is the ingestion boundary
    owner_id: String(ownerId),

    source: 'whatsapp',
    source_msg_id: String(sourceMsgId || ''),

    actor: {
      actor_id: String(userProfile?.user_id || from || 'unknown'),
      role: 'owner'
    },

    occurred_at: new Date().toISOString(),

    job: jobName ? { job_name: String(jobName) } : null,
    needs_job_resolution: !jobName,

    total_cents: cents,
    currency: 'CAD',

    vendor:
      data.store && data.store !== 'Unknown Store'
        ? String(data.store)
        : undefined,

    memo:
      data.item && data.item !== 'Unknown'
        ? String(data.item)
        : undefined,

    category: category ? String(category) : undefined
  };
}

function assertExpenseCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  try {
    if (typeof validateCIL !== 'function') return { ok: true, cil: null, skipped: true };

    const cil1 = buildExpenseCIL_LogExpense({ from, data, jobName, category, sourceMsgId });
    try {
      validateCIL(cil1);
      return { ok: true, cil: cil1, variant: 'LogExpense' };
    } catch {
      const cil2 = buildExpenseCIL_Legacy({ ownerId, from, userProfile, data, jobName, category, sourceMsgId });
      validateCIL(cil2);
      return { ok: true, cil: cil2, variant: 'Legacy' };
    }
  } catch {
    return { ok: false, reply: `⚠️ Couldn\'t log that expense yet. Try: "expense $84.12 nails from Home Depot".` };
  }
}

async function withTimeout(promise, ms, fallbackValue = '__TIMEOUT__') {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))]);
}
function normalizeDashes(s) {
  return String(s || '')
    .replace(/[\u2014\u2013]/g, '-') // em dash / en dash -> hyphen
    .replace(/\s*-\s*/g, ' - ')      // normalize spacing
    .replace(/\s+/g, ' ')
    .trim();
}
function parseReceiptBackstop(ocrText) {
  const t = normalizeDashes(String(ocrText || '')).replace(/\s+/g, ' ').trim();
  if (!t) return null;

  const store = extractReceiptStore(t);

  let dateIso = null;
  const mdY = t.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (mdY) {
    const mm = mdY[1], dd = mdY[2], yyyy = mdY[3];
    dateIso = `${yyyy}-${mm}-${dd}`;
  } else {
    const ymd = t.match(/\b(\d{4})\s*-\s*(\d{2})\s*-\s*(\d{2})\b/);
    if (ymd) dateIso = `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  }

  let currency = null;
  const cur =
    t.match(/\b(CAD|USD|EUR|GBP)\b/i) ||
    t.match(/\b(C\$|US\$)\b/i) ||
    t.match(/\$\s*(CAD|USD|EUR|GBP)\b/i);

  if (cur?.[1]) {
    const raw = String(cur[1]).toUpperCase();
    if (raw === 'C$') currency = 'CAD';
    else if (raw === 'US$') currency = 'USD';
    else currency = raw.replace('$', '');
  }

  const tax = extractReceiptTaxBreakdown(t);

  if (
    tax.total == null &&
    tax.subtotal == null &&
    tax.tax == null &&
    !dateIso &&
    !store &&
    !currency
  ) {
    return null;
  }

  return {
    total: tax.total,
    subtotal: tax.subtotal,
    tax: tax.tax,
    taxLabel: tax.taxLabel,
    dateIso,
    store,
    currency
  };
}

function chooseBestReceiptAmountCandidate(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (!rows.length) return null;

  const penaltyWords = [
    'hst', 'gst', 'pst', 'tax', 'discount', 'save', 'savings',
    'litre', 'liter', 'litre:', 'price/l', 'price per litre', 'cents/l'
  ];

  const strongWords = [
    'total', 'amount due', 'balance due', 'debit', 'visa',
    'mastercard', 'paid', 'purchase', 'sale'
  ];

  const scored = rows
    .map((r) => {
      const line = String(r?.line || '').toLowerCase();
      const value = Number(r?.value || 0);

      if (!Number.isFinite(value) || value <= 0) return null;

      let score = value;

      if (strongWords.some((w) => line.includes(w))) score += 1000;
      if (penaltyWords.some((w) => line.includes(w))) score -= 1000;

      return { value, line, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.value != null ? scored[0].value : null;
}

function mergeDraftNonNull(dst, patch) {
  const out = { ...(dst || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}



/* --------- deterministic parser --------- */

function extractMoneyToken(input) {
  const s0 = String(input || '');
  if (!s0.trim()) return null;

  // Normalize common unicode spacing/dashes that break tokenization
  const s = s0
    .replace(/\u00A0/g, ' ')       // nbsp
    .replace(/[–—]/g, '-')         // en/em dash → hyphen
    .replace(/\s+/g, ' ');

   // 1) Strong signal: MUST include '$' (prevents matching dates like "July 17")
  // Examples: $2000, $2,000, $2 000, $2000.50, -$2000
  const moneyMatches = [];
  const reDollar = /(?:^|[^\w])(?:-\s*)?\$\s*(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?=$|[^\w])/g;
  let m;
  while ((m = reDollar.exec(s)) !== null) {
    const tok = m[1];
    if (tok) moneyMatches.push(tok);
  }

  // Prefer first $-style match
  if (moneyMatches.length) return moneyMatches[0];

  // 2) Currency words (CAD/USD) near a number
  // "2000 cad", "cad 2000", "usd 2,000.00"
  const reCcy = /\b(?:cad|usd)\b\s*\$?\s*(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)|\$?\s*(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*\b(?:cad|usd)\b/i;
  const ccy = s.match(reCcy);
  if (ccy?.[1] || ccy?.[2]) return (ccy[1] || ccy[2]).trim();

  // 3) Fallback: find numeric candidates, but avoid ISO dates and likely job numbers.
  // Collect candidates, choose the largest plausible amount.
  const candidates = [];
  const reNum = /\b(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{4,}(?:\.\d{1,2})?|\d{1,3}\.\d{1,2})\b/g;
  while ((m = reNum.exec(s)) !== null) {
    const tok = m[1];
    if (!tok) continue;

    // skip ISO dates like 2026-02-14 (reNum won't match full, but be safe)
    if (/\b\d{4}-\d{2}-\d{2}\b/.test(s)) {
      // keep, but don't auto-skip everything; just skip tokens that are date pieces if any
      // (practically: no action needed here)
    }

    // skip likely job numbers if preceded by "job" nearby
    const idx = m.index;
    const left = s.slice(Math.max(0, idx - 12), idx).toLowerCase();
    if (/\bjob\s*$/.test(left) || /\bjob#\s*$/.test(left) || /\bjob\s*\d*\s*$/.test(left)) continue;

    // skip very small numbers that are likely quantities, not amounts
    const n = Number(tok.replace(/,/g, '').replace(/\s/g, ''));
    if (!Number.isFinite(n) || n <= 0) continue;

    candidates.push({ tok, n });
  }

  if (!candidates.length) return null;

  // Choose the largest candidate (prevents picking 200 when 2000 exists)
  candidates.sort((a, b) => b.n - a.n);
  return candidates[0].tok;
}


function moneyToFixed(token) {
  const raw0 = String(token || '').trim();
  if (!raw0) return null;

  // Detect negative via leading '-' OR parentheses
  // Examples: -200, $-200, (-200), (200)
  const isNeg =
    /^\s*-/.test(raw0) ||
    /\(\s*[^)]+\s*\)/.test(raw0);

  // Keep only digits, dots, commas, spaces (for "2 000"), and strip parens/minus later
  let cleaned = raw0
    .replace(/[()]/g, '')       // remove parens (we already captured negativity)
    .replace(/-/g, '')          // remove minus (we already captured negativity)
    .replace(/[^0-9.,\s]/g, '') // remove currency symbols/words
    .trim();

  if (!cleaned) return null;

  // Normalize thousands separators:
  // - remove spaces used as thousands separators
  // - remove commas
  const normalized = cleaned.replace(/\s+/g, '').replace(/,/g, '');

  const n0 = Number(normalized);
  if (!Number.isFinite(n0)) return null;

  // Reject zero (keeps your old behavior)
  if (n0 === 0) return null;

  const n = isNeg ? -Math.abs(n0) : Math.abs(n0);

  // Your formatter should handle negatives fine (e.g. "-$200.00")
  return formatMoneyDisplay(n);
}

function isIsoDateToken(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}


function deterministicExpenseParse(input, userProfile) {
  const raw0 = String(input || '').trim();
  if (!raw0) return null;

  // Normalize fancy dashes so "$883 — Railing" behaves like "$883 - Railing"
  const raw = normalizeDashes(raw0);

  let token = extractMoneyToken(raw);

// ✅ HARD FALLBACK: match "$48", "$48.12", "$1,234.56" even if extractMoneyToken is picky
if (!token) {
  const m = raw.match(/\$\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/);
  if (m?.[0]) token = m[0];
}

if (!token) return null;
console.info('[DET_EXPENSE_MONEY_TOKEN]', {
  head: String(raw || '').slice(0, 120),
  token: token || null
});


  // Refund/credit hint must live INSIDE the function (raw exists here)
  const isRefundish = /\b(refund|credit|return|chargeback|reversal)\b/i.test(raw);

  let amount = moneyToFixed(token);
  if (!amount) return null;

  // Optional: force negative when refundish + amount is positive
  // (only if your formatMoneyDisplay supports negatives well)
  if (isRefundish && amount && !/^-/.test(String(amount))) {
    const num = Number(String(amount).replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(num) && num !== 0) {
      amount = formatMoneyDisplay(-Math.abs(num));
    }
  }

  const tz = userProfile?.timezone || userProfile?.tz || 'UTC';

  let date = null;
  if (/\btoday\b/i.test(raw)) date = parseNaturalDateTz('today', tz);
  else if (/\byesterday\b/i.test(raw)) date = parseNaturalDateTz('yesterday', tz);
  else if (/\btomorrow\b/i.test(raw)) date = parseNaturalDateTz('tomorrow', tz);

  if (!date) {
    const iso = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (iso?.[1]) date = iso[1];
  }

  // If this looks like receipt/OCR text and no explicit date token was found, do NOT default to today.
  const looksReceipt =
    /\b(receipt|subtotal|hst|gst|pst|tax|total|debit|visa|mastercard|amex|approved|auth|terminal)\b/i.test(raw);

  if (!date) {
    date = looksReceipt ? null : todayInTimeZone(tz);
  }

  let jobName = null;
  const forJob = raw.match(/\bfor\s+job\s+(.+?)(?:[.?!]|$)/i);
  if (forJob?.[1]) {
    const cand = String(forJob[1]).trim();
    if (cand && !isIsoDateToken(cand)) jobName = normalizeJobNameCandidate(cand);
  }
  if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

  let store = null;
  const fromMatch = raw.match(
    /\b(?:from|at)\s+(.+?)(?:\s+\bon\b|\s+\bfor\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
  );
  if (fromMatch?.[1]) store = String(fromMatch[1]).trim();

  let item = null;

  // 1) "worth of <item> from/at <store>"
  const worthOf = raw.match(
    /\bworth\s+of\s+(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\bfor\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
  );
  if (worthOf?.[1]) item = String(worthOf[1]).trim();

  // 2) "purchased $883 in railing at Rona"
  if (!item) {
    const inItem = raw.match(
      /\b(?:spent|spend|paid|pay|purchased|purchase|bought|buy|ordered|order|got)\b.*?\$\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?\s+\bin\s+(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\bfor\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
    );
    if (inItem?.[1]) item = String(inItem[1]).trim();
  }

  // 3) "$883 - Railing at Rona" (after normalizeDashes)
  if (!item) {
    const dashItem = raw.match(
      /\$\s*[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?\s*-\s*(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\bfor\b|[.?!]|$)/i
    );
    if (dashItem?.[1]) item = String(dashItem[1]).trim();
  }

  // 4) Keep "for <item> ..." rule (but don't allow "for job ...")
  if (!item) {
    const itemMatch = raw.match(
      /\bfor\s+(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
    );
    if (itemMatch?.[1]) {
      const cand = String(itemMatch[1]).trim();
      const looksLikeJobPhrase = /^\s*job\b/i.test(cand);
      if (cand && !isIsoDateToken(cand) && !looksLikeJobPhrase) item = cand;
    }
  }

  return {
    date,
    amount,
    item: cleanExpenseItemForDisplay(item || 'Unknown'),
    store: store || 'Unknown Store',
    jobName: jobName || null
  };
}



/* ---------------- inbound helpers (drop-in) ---------------- */

function normLower(s) {
  return String(s ?? '').trim().toLowerCase();
}

// Extremely defensive extraction of "what the user meant" from Twilio payloads.
// DO NOT assume a single shape exists.
function getInboundText(bodyOrInput, twilioMetaMaybe) {
  // Support both calling styles:
  // - getInboundText(req.body)
  // - getInboundText(input, twilioMeta)
  const meta =
    (twilioMetaMaybe && typeof twilioMetaMaybe === 'object') ? twilioMetaMaybe :
    (bodyOrInput && typeof bodyOrInput === 'object') ? bodyOrInput :
    {};

  const direct = (typeof bodyOrInput === 'string') ? bodyOrInput : '';
  const body = String(meta.Body || meta.body || direct || '').trim();

  // ✅ 0) Router-resolved token (highest priority)
  // webhook.js may canonicalize list clicks to jobix_<n> or jobno_<n>
  const resolved =
    String(meta.ResolvedInboundText || meta.resolvedInboundText || '').trim();
  if (resolved) return resolved; // do NOT rewrite

  // --- Buttons ---
  const btnPayload = String(meta.ButtonPayload || meta.buttonPayload || '').trim();
  const btnText = String(meta.ButtonText || meta.buttonText || '').trim();
  if (btnPayload) return btnPayload.toLowerCase();
  if (btnText && btnText.length <= 40) return btnText.toLowerCase();

  // --- InteractiveResponseJson (best signal if present) ---
  const irj = meta.InteractiveResponseJson || meta.interactiveResponseJson || null;
  if (irj) {
    try {
      const json = (typeof irj === 'string') ? JSON.parse(irj) : irj;

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
      if (pickedId) return pickedId; // ✅ never rewrite

      const pickedTitle = String(title || '').trim();
      if (pickedTitle) return pickedTitle;
    } catch {}
  }

  // --- List replies (Twilio list picker fields): prefer ids first ---
  const listRowId = String(meta.ListRowId || meta.ListRowID || meta.listRowId || meta.listRowID || '').trim();
  if (listRowId) return listRowId;

  const listId = String(
    meta.ListId ||
    meta.listId ||
    meta.ListItemId ||
    meta.listItemId ||
    meta.ListReplyId ||
    meta.listReplyId ||
    ''
  ).trim();
  if (listId) return listId;

  // If Twilio put the token in Body (common), return it AS-IS
  if (body) return body;

  // last resort: titles
  const listTitle = String(meta.ListTitle || meta.listTitle || meta.ListReplyTitle || meta.listReplyTitle || '').trim();
  if (listTitle) return listTitle;

  return '';
}



function isEditIntent(input, twilioMeta) {
  const t = normLower(getInboundText(input, twilioMeta));
  return t === 'edit';
}

function isYesIntent(input, twilioMeta) {
  const t = normLower(getInboundText(input, twilioMeta));
  return t === 'yes' || t === 'y';
}

function isCancelIntent(input, twilioMeta) {
  const t = normLower(getInboundText(input, twilioMeta));
  return t === 'cancel' || t === 'stop' || t === 'no';
}

function isSkipIntent(input, twilioMeta) {
  const t = normLower(getInboundText(input, twilioMeta));
  return t === 'skip';
}

// If user is in edit-mode, these are the "control words" that should NOT be treated as edit payload.
function isControlWord(input, twilioMeta) {
  const t = normLower(getInboundText(input, twilioMeta));
  return (
    t === 'yes' ||
    t === 'y' ||
    t === 'edit' ||
    t === 'cancel' ||
    t === 'stop' ||
    t === 'no' ||
    t === 'skip' ||
    t === 'resume' ||
    t === 'change_job' ||
    t === 'change job' ||
    t === 'switch job' ||
    t.startsWith('job ') ||     // covers "job 1" typed manually
    t.startsWith('jobno_') ||
    t.startsWith('jobix_') ||   // legacy compatibility
    t.startsWith('job_') ||     // Twilio content-template tokens
    t.startsWith('jp:')         // your stable row id format
  );
}


// --- EDIT MODE helpers (drop-in) ---
// We store edit intent in stateManager so the next free-text message is treated as the edit payload.
// This MUST run before handleInputWithAI(...) to avoid parsing "edit" / "" as an expense.

function isSkipWord(s) {
  const t = normLower(s);
  return t === 'skip';
}

// Build a confirm message in plain text (fail-open). This avoids relying on interactive templates.
function formatExpenseConfirmText(draft) {
  const amtRaw = String(draft?.amount || '').trim();
  const amtNum = Number(amtRaw.replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
  const amt =
    Number.isFinite(amtNum) && amtNum > 0
      ? formatMoneyDisplay(amtNum) // "$18,000.00"
      : (amtRaw ? (amtRaw.startsWith('$') ? amtRaw : `$${amtRaw}`) : 'Unknown');

  const item = draft?.item || draft?.description || 'Expense';
  const store = draft?.store || 'Unknown Store';
  const date = draft?.date || 'Unknown date';
  const job = draft?.job_name || draft?.jobName || 'Unassigned';
  const cat = draft?.category || draft?.suggestedCategory || 'Other Expenses';

  return [
    `Confirm expense`,
    `💸 ${amt} — ${item}`,
    `🏪 ${store}`,
    `📅 ${date}`,
    `🧰 ${job}`,
    `Category: ${cat}`,
    ``,
    `Reply:`,
    `"yes" to submit`,
    `"edit" to change it`,
    `"cancel" (or "stop") to discard`
  ].join('\n');
}
function hasExplicitDateToken(text = '') {
  const s = String(text || '');

  // ISO
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(s)) return true;

  // 01/13/2026, 1-13-26, 01.13.2026 (includes YY)
  if (/\b(0?[1-9]|1[0-2])[\/\-\.](0?[1-9]|[12]\d|3[01])[\/\-\.](\d{2}|\d{4})\b/.test(s)) return true;

  // Month name formats: Jan 17 2026 / Jan 17, 2026 / January 17 2026
  if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,\s*|\s+)\d{2,4}\b/i.test(s)) return true;

  // Relative date words
  if (/\b(today|yesterday|tomorrow)\b/i.test(s)) return true;

  return false;
}


/// Parse edit payload and merge into existing draft WITHOUT losing receipt/media linkage.
// ✅ Rule: Only overwrite fields the user explicitly intended to change.
// ✅ AI-FREE: deterministic parsing only.
async function applyEditPayloadToConfirmDraft(editText, existingDraft, ctx) {
  const tz = ctx?.tz || 'America/Toronto';
  const raw = String(editText || '').trim();
  const lc = raw.toLowerCase();

  const isUnknownish = (s) => {
    const x = String(s || '').trim().toLowerCase();
    return !x || x === 'unknown' || x.startsWith('unknown ');
  };

  const hasMoney = (s) => /\$?\s*-?\d+(?:,\d{3})*(?:\.\d{1,2})?\b/.test(String(s || ''));

  const explicitDate =
    (typeof hasExplicitDateToken === 'function')
      ? !!hasExplicitDateToken(raw)
      : /\b(\d{4}-\d{2}-\d{2}|today|yesterday|tomorrow|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(raw);

  const explicit = {
    amount: /\b(amount|total|price|cost)\b/i.test(raw) || hasMoney(raw),
    date: explicitDate,
    store: /\b(store|vendor|merchant|from|at)\b/i.test(raw),
    item: /\b(item|for|bought|purchase|description|desc)\b/i.test(raw),
    category: /\b(category|categorize|type)\b/i.test(raw),
    job: /\b(job|for job|change job|overhead)\b/i.test(raw)
  };

  const looksLikeJustVendor =
    !explicit.amount &&
    !explicit.date &&
    !explicit.job &&
    !explicit.category &&
    raw.split(/\s+/).length <= 4;

  explicit.store = explicit.store || looksLikeJustVendor;

  const overwrite =
    typeof parseExpenseEditOverwrite === 'function'
      ? parseExpenseEditOverwrite(raw)
      : {
          amount: null,
          store: null,
          date: null,
          jobName: null,
          subtotal: null,
          tax: null,
          total: null
        };

  const out = { ...(existingDraft || {}) };

  // ✅ Preserve receipt/media linkage ALWAYS
  out.media_asset_id =
    existingDraft?.media_asset_id ||
    existingDraft?.mediaAssetId ||
    out.media_asset_id ||
    null;

  out.media_source_msg_id =
    existingDraft?.media_source_msg_id ||
    existingDraft?.mediaSourceMsgId ||
    out.media_source_msg_id ||
    null;

  out.source_msg_id =
    existingDraft?.source_msg_id ||
    existingDraft?.sourceMsgId ||
    out.source_msg_id ||
    null;

  out.receiptText =
    existingDraft?.receiptText ||
    existingDraft?.ocrText ||
    existingDraft?.extractedText ||
    out.receiptText ||
    null;

  out.ocrText = existingDraft?.ocrText || out.ocrText || null;
  out.extractedText = existingDraft?.extractedText || out.extractedText || null;

  // ✅ Preserve existing tax fields unless explicitly overwritten
  out.subtotal = existingDraft?.subtotal || out.subtotal || null;
  out.tax = existingDraft?.tax || out.tax || null;
  out.total = existingDraft?.total || out.total || null;
  out.taxLabel = existingDraft?.taxLabel || out.taxLabel || null;

  // Amount
  if (explicit.amount) {
    const amt =
      overwrite.amount ||
      (typeof extractMoneyAmount === 'function' ? extractMoneyAmount(raw) : null) ||
      (() => {
        const m = raw.match(/\$?\s*(-?\s*\d+(?:,\d{3})*(?:\.\d{1,2})?)/);
        if (!m?.[1]) return null;

        const numStr = String(m[1]).replace(/\s+/g, '').replace(/,/g, '');
        const n = Number(numStr);
        if (!Number.isFinite(n)) return null;

        return `$${n.toFixed(2)}`;
      })();

    if (amt && amt !== '$0.00') out.amount = amt;
  }

  // Date
  if (explicit.date) {
    const typedDate =
      overwrite.date ||
      (typeof extractReceiptDateYYYYMMDD === 'function'
        ? extractReceiptDateYYYYMMDD(raw, tz)
        : null);

    if (!typedDate) {
      return {
        nextDraft: null,
        aiReply: 'I saw a date in your message, but I couldn\'t parse it. Try: "Feb 14 2026" or "2026-02-14".'
      };
    }

    out.date = typedDate;
  } else if (existingDraft?.date) {
    out.date = existingDraft.date;
  }

  // Job
  if (explicit.job) {
    if (/\boverhead\b/i.test(raw)) {
      out.jobName = 'Overhead';
      out.jobSource = 'typed';
    } else if (overwrite.jobName) {
      out.jobName = overwrite.jobName;
      out.jobSource = 'typed';
    } else {
      const m =
        raw.match(/\bjob\b\s*[:\-]?\s*([^\n\r]+)$/i) ||
        raw.match(/\bjob\s*(\d{1,6}\b[^\n\r]*)$/i);

      if (m?.[1]) {
        const name = String(m[1]).trim().replace(/[.!,;:]+$/g, '').trim();
        if (name && !/\b(subtotal|tax|total)\b/i.test(name)) {
          out.jobName = name;
          out.jobSource = 'typed';
        }
      }
    }
  }

  // Store
  if (explicit.store) {
    if (overwrite.store) {
      out.store = overwrite.store;
    } else if (looksLikeJustVendor) {
      out.store = raw;
    } else {
      const lines = raw
        .split(/\r?\n/)
        .map((x) => String(x || '').trim())
        .filter(Boolean);

      let foundStore = null;

      for (const line of lines) {
        const m = line.match(/^\s*(?:at|from|vendor|merchant|store)\b\s*[:\-]?\s*(.+)$/i);
        if (m?.[1]) {
          foundStore = String(m[1]).trim().replace(/[.!,;:]+$/g, '').trim();
          if (foundStore) break;
        }
      }

      if (foundStore) out.store = foundStore;
    }
  }

  // Item / description
  if (explicit.item) {
    const lines = raw
      .split(/\r?\n/)
      .map((x) => String(x || '').trim())
      .filter(Boolean);

    let foundItem = null;

    for (const line of lines) {
      const m = line.match(/^\s*(?:item|desc|description|for)\b\s*[:\-]?\s*(.+)$/i);
      if (m?.[1]) {
        foundItem = String(m[1]).trim().replace(/[.!,;:]+$/g, '').trim();
        if (foundItem && !/^\s*job\b/i.test(foundItem)) break;
      }
    }

    if (foundItem) out.item = foundItem;
  }

  // Category
  if (explicit.category) {
    const m = raw.match(/\b(?:category|type)\b\s*[:\-]?\s*([^\n\r]+)$/i);
    const v = m?.[1] ? String(m[1]).trim().replace(/[.!,;:]+$/g, '').trim() : null;
    if (v) out.category = v;
  }

  // ✅ Tax fields from deterministic overwrite parser
  if (overwrite.subtotal) out.subtotal = overwrite.subtotal;
  if (overwrite.tax) out.tax = overwrite.tax;
  if (overwrite.total) out.total = overwrite.total;

  // ✅ Never accidentally null out strong values
  if (out.store && isUnknownish(out.store) && existingDraft?.store && !isUnknownish(existingDraft.store)) {
    out.store = existingDraft.store;
  }

  if (out.amount === '$0.00' && existingDraft?.amount && existingDraft.amount !== '$0.00') {
    out.amount = existingDraft.amount;
  }

  return { nextDraft: out, aiReply: null };
}


// -------------------------------------------------------
// ✅ Inbound extraction (expense-local) — aligned w/ webhook.js
// Rules:
// - Prefer router-resolved token first (ResolvedInboundText), because webhook.js
//   may canonicalize list clicks to jobix_<n>
// - Buttons still normalize
// - IRJ id is stable if present
// - Then ListRowId/ListId
// - Then raw input/body as-is
// -------------------------------------------------------
function getInboundTextExpense(input, meta = {}) {
  const rawInput = String(input || '').trim();

  // ✅ 0) Router-resolved inbound (highest priority)
  const resolved =
    String(meta?.ResolvedInboundText || meta?.resolvedInboundText || '').trim();
  if (resolved) return resolved; // e.g. "jobix_2" (do NOT rewrite)

  // ✅ 1) Buttons
  const payload = String(meta?.ButtonPayload || meta?.buttonPayload || '').trim();
  if (payload) return payload.toLowerCase();

  const btnText = String(meta?.ButtonText || meta?.buttonText || '').trim();
  if (btnText && btnText.length <= 40) return btnText.toLowerCase();

  // ✅ 2) InteractiveResponseJson (best raw signal if present)
  const irj = meta?.InteractiveResponseJson || meta?.interactiveResponseJson || null;
  if (irj) {
    try {
      const obj = typeof irj === 'string' ? JSON.parse(irj) : irj;
      const id =
        obj?.list_reply?.id ||
        obj?.interactive?.list_reply?.id ||
        obj?.listReply?.id ||
        obj?.interactive?.listReply?.id ||
        '';

      const title =
        obj?.list_reply?.title ||
        obj?.interactive?.list_reply?.title ||
        obj?.listReply?.title ||
        obj?.interactive?.listReply?.title ||
        '';

      const pickedId = String(id || '').trim();
      if (pickedId) return pickedId; // ✅ never rewrite

      const pickedTitle = String(title || '').trim();
      if (pickedTitle) return pickedTitle;
    } catch {}
  }

  // ✅ 3) Twilio list fields: prefer ids
  const listRowId = String(meta?.ListRowId || meta?.ListRowID || meta?.listRowId || meta?.listRowID || '').trim();
  if (listRowId) return listRowId;

  const listId = String(meta?.ListId || meta?.listId || meta?.ListItemId || meta?.listItemId || meta?.ListReplyId || meta?.listReplyId || '').trim();
  if (listId) return listId;

  // ✅ 4) Raw input
  if (rawInput) return rawInput;

  // ✅ 5) Last resort titles
  const title = String(meta?.ListTitle || meta?.listTitle || meta?.ListRowTitle || meta?.listRowTitle || '').trim();
  if (title) return title;

  const body = String(meta?.Body || meta?.body || '').trim();
  if (body) return body;

  return '';
}

// ---------------------------------------------------------
// ✅ Media source msg id normalizer (FILE SCOPE)
// Prevents double-prefix / junk prefixes and avoids TDZ issues
// when YES / confirm / receipt seed paths all need the same helper.
// ---------------------------------------------------------
function normalizeMediaSourceMsgId(userKeyDigits, val) {
  const u = String(userKeyDigits || '').trim();
  const s0 = String(val || '').trim();

  if (!u) return s0 || null;
  if (!s0) return null;

  // Already "digits:SM..."
  if (/^\d{7,20}:SM[a-f0-9]{10,64}$/i.test(s0)) return s0;

  // Raw SM...
  const mSid = s0.match(/\bSM[a-f0-9]{10,64}\b/i);
  if (mSid?.[0]) return `${u}:${mSid[0]}`;

  // Something like "junk:SM..."
  if (s0.includes(':')) {
    const m2 = s0.match(/\bSM[a-f0-9]{10,64}\b/i);
    if (m2?.[0]) return `${u}:${m2[0]}`;
  }

  // Fallback: prefix raw token
  return `${u}:${s0}`;
}

// ---------------------------------------------------------
// ✅ Media asset resolver (FILE SCOPE)
// Used by YES path to ensure confirm drafts link to media_assets.
// Priority:
// 1) draft.media_asset_id
// 2) flowMediaAssetId (function-scope capture)
// 3) DB lookup by draft/pending source_msg_id
// 4) pending state pendingMediaMeta.media_asset_id
// ---------------------------------------------------------
async function resolveMediaAssetIdForFlow({ ownerId, userKey, rawDraft, flowMediaAssetId }) {
  // 1) Draft direct
  let id =
    (rawDraft?.media_asset_id || rawDraft?.mediaAssetId || null) ||
    (rawDraft?.pendingMediaMeta?.media_asset_id || rawDraft?.pendingMediaMeta?.mediaAssetId || null) ||
    null;

  if (id) return id;

  // 2) Function-scope fallback
  if (flowMediaAssetId) return flowMediaAssetId;

  // Helper: normalize a source msg id into the DB format "<digitsUserKey>:<sid>"
  const asDbSource = (sid) => {
    const s = String(sid || '').trim();
    if (!s) return null;

    const stateKey =
      (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(userKey)) ||
      String(userKey || '').replace(/\D/g, '') ||
      String(userKey || '').trim();

    if (!stateKey) return null;

    // If already has a prefix like "digits:SID", keep it (or re-key safely)
    if (s.includes(':')) {
      if (s.startsWith(`${stateKey}:`)) return s;

      const prefix = s.split(':')[0];
      if (/^\d{7,20}$/.test(prefix)) return s;

      // colon-containing junk; force our key prefix
      return `${stateKey}:${s.replace(/^[^:]*:/, '')}`;
    }

    return `${stateKey}:${s}`;
  };

  // 3) Try draft hints for source msg id (strong fallback)
  const draftSrc =
    rawDraft?.media_source_msg_id ||
    rawDraft?.source_msg_id ||
    rawDraft?.pendingMediaMeta?.source_msg_id ||
    rawDraft?.mediaSourceMsgId ||
    null;

  const srcFromDraft = asDbSource(draftSrc);
  if (srcFromDraft) {
    try {
      const r = await pg.query(
        `select id
           from public.media_assets
          where owner_id=$1 and source_msg_id=$2
          limit 1`,
        [String(ownerId || '').trim(), String(srcFromDraft).trim()]
      );
      const found = r?.rows?.[0]?.id || null;
      if (found) return found;
    } catch (e) {
      console.warn('[MEDIA_ASSET_RESOLVE_DB_DRAFTSRC] failed (ignored):', e?.message);
    }
  }

  // 4) Re-read pending state (in case it exists)
  let pending = null;
  try {
    const stateKey =
      (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(userKey)) ||
      String(userKey || '').replace(/\D/g, '') ||
      String(userKey || '').trim();

    pending = await getPendingTransactionState(stateKey);
  } catch {}

  id =
    (pending?.pendingMediaMeta?.media_asset_id ||
      pending?.pendingMediaMeta?.mediaAssetId ||
      null) || null;

  if (id) return id;

  // 5) DB fallback using pending source msg id
  const pendingSrc = pending?.pendingMediaMeta?.source_msg_id || pending?.mediaSourceMsgId || null;
  const srcFromPending = asDbSource(pendingSrc);

  if (srcFromPending) {
    try {
      const r = await pg.query(
        `select id
           from public.media_assets
          where owner_id=$1 and source_msg_id=$2
          limit 1`,
        [String(ownerId || '').trim(), String(srcFromPending).trim()]
      );
      const found = r?.rows?.[0]?.id || null;
      if (found) return found;
    } catch (e) {
      console.warn('[MEDIA_ASSET_RESOLVE_DB_PENDINGSRC] failed (ignored):', e?.message);
    }
  }

  return null;
}


/* ---------------- insert helper (module scope) ---------------- */

// Best-effort insert (tries known helper names first; falls back if one exists in your pg module)
async function insertExpenseBestEffort(pgSvc, p) {
  // 1) If you already have a canonical helper
  if (typeof pgSvc.insertExpense === 'function') return pgSvc.insertExpense(p);
  if (typeof pgSvc.createExpense === 'function') return pgSvc.createExpense(p);
  if (typeof pgSvc.logExpense === 'function') return pgSvc.logExpense(p);

  // 2) Your actual common helper in Chief codebase
  if (typeof pgSvc.insertTransaction === 'function') {
    return pgSvc.insertTransaction({
      owner_id: p.owner_id,
      user_id: p.user_id,
      kind: 'expense',
      amount: p.amount,
      amount_cents: p.amount_cents,
      currency: p.currency,
      date: p.date,

      // ✅ CRITICAL: insertTransaction expects `source`, not `store`
      source: p.store,
      store: p.store,

      description: p.description,
      category: p.category,
      jobName: p.job_name,
      jobSource: p.job_source,
      job_id: p.job_id ?? null,
      media_asset_id: p.media_asset_id,
      media_source_msg_id: p.media_source_msg_id,
      source_msg_id: p.source_msg_id,
      tenant_id: p.tenant_id,
      original_text: p.original_text,
      draft_text: p.draft_text,
      subtotal_amount: p.subtotal_amount,
      tax_amount: p.tax_amount,
      tax_label: p.tax_label
    });
  }

  // 3) Generic transaction helpers (if you have one)
  if (typeof pgSvc.createTransaction === 'function') {
    return pgSvc.createTransaction({
      ownerId: p.owner_id,
      userId: p.user_id,
      kind: 'expense',
      amount: p.amount,
      amount_cents: p.amount_cents,
      currency: p.currency,
      date: p.date,

      // ✅ same issue here
      source: p.store,
      store: p.store,

      description: p.description,
      category: p.category,
      jobName: p.job_name,
      jobSource: p.job_source,
      job_id: p.job_id ?? null,
      media_asset_id: p.media_asset_id,
      media_source_msg_id: p.media_source_msg_id,
      source_msg_id: p.source_msg_id,
      tenant_id: p.tenant_id,
      original_text: p.original_text,
      draft_text: p.draft_text
    });
  }

  throw new Error(
    'No expense insert function found on pg service (insertExpense/createExpense/logExpense/insertTransaction/createTransaction).'
  );
}

/* ---------------- main handler ---------------- */

async function handleExpense(
  from,
  input,
  userProfile,
  ownerId,
  ownerProfile,
  isOwner,
  sourceMsgId,
  twilioMeta = null
) {
  // Normalize Twilio meta (req.body) if caller provided it.
  twilioMeta = twilioMeta && typeof twilioMeta === 'object' ? twilioMeta : {};
  const getTwilio = (k) =>
    twilioMeta?.[k] ?? twilioMeta?.[String(k).toLowerCase()] ?? twilioMeta?.[String(k).toUpperCase()] ?? null;

  // ✅ IMPORTANT: carry IRJ + ListRowId variants through to resolver
  const inboundTwilioMeta = {
    MessageSid: getTwilio('MessageSid') || getTwilio('SmsMessageSid'),
    SmsMessageSid: getTwilio('SmsMessageSid') || null,
    OriginalRepliedMessageSid: getTwilio('OriginalRepliedMessageSid'),
    // core text fields
    Body: getTwilio('Body'),
    ResolvedInboundText: getTwilio('ResolvedInboundText') || getTwilio('resolvedInboundText'),
    // list fields (all variants)
    ListRowId:
      getTwilio('ListRowId') ||
      getTwilio('ListRowID') ||
      getTwilio('listRowId') ||
      getTwilio('listRowID'),
    ListRowTitle: getTwilio('ListRowTitle') || getTwilio('listRowTitle'),
    ListId:
      getTwilio('ListId') ||
      getTwilio('listId') ||
      getTwilio('ListItemId') ||
      getTwilio('listItemId') ||
      getTwilio('ListReplyId') ||
      getTwilio('listReplyId'),
    ListTitle:
      getTwilio('ListTitle') ||
      getTwilio('listTitle') ||
      getTwilio('ListItemTitle') ||
      getTwilio('listItemTitle') ||
      getTwilio('ListReplyTitle') ||
      getTwilio('listReplyTitle'),
    // IRJ (interactive response json)
    InteractiveResponseJson: getTwilio('InteractiveResponseJson') || getTwilio('interactiveResponseJson'),
    // buttons
    ButtonPayload: getTwilio('ButtonPayload') || getTwilio('buttonPayload'),
    ButtonText: getTwilio('ButtonText') || getTwilio('buttonText'),
    // meta
    NumMedia: getTwilio('NumMedia') ?? getTwilio('numMedia') ?? null,
    WaId: getTwilio('WaId') || getTwilio('WaID') || getTwilio('waid')
  };

  // ✅ Preserve raw sender for replies + logs (router may pass +E164 now)
  const fromPhone = String(from || '').trim();

  // ✅ Canonical PA/state user id (digits only) — ALWAYS prefer WaId then from
  const paUserId =
    (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(inboundTwilioMeta?.WaId)) ||
    (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(fromPhone)) ||
    String(fromPhone || '').replace(/\D/g, '').trim() ||
    String(fromPhone || '').trim();

  // ✅ Stable id for idempotency + flow correlation (define EARLY so gating can use it)
  const stableMsgId =
    String(inboundTwilioMeta?.MessageSid || '').trim() ||
    String(sourceMsgId || '').trim() ||
    String(userProfile?.last_message_sid || '').trim() ||
    String(`${paUserId}:${Date.now()}`).trim();

  const safeMsgId = stableMsgId; // keep the alias so future clamps are centralized

  // ✅ tz needed throughout handler (single definition)
  const tz = userProfile?.timezone || userProfile?.tz || ownerProfile?.tz || 'America/Toronto';

  // ✅ IMPORTANT: capture raw inbound text BEFORE modifying input.
  // NOTE: getInboundTextExpense MUST exist at FILE SCOPE (do NOT define it inside handleExpense)
  const rawInboundText = getInboundTextExpense(input, inboundTwilioMeta);

  // ✅ Debug: verify we're extracting the right signal for list picks / IRJ
  console.info('[EXPENSE_INBOUND_EXTRACTOR]', {
    rawInboundText: String(rawInboundText || '').slice(0, 80),
    body: String(inboundTwilioMeta?.Body || '').slice(0, 80),
    listId: inboundTwilioMeta?.ListId || null,
    listTitle: inboundTwilioMeta?.ListTitle || null,
    listRowId: inboundTwilioMeta?.ListRowId || null,
    hasIRJ: !!inboundTwilioMeta?.InteractiveResponseJson
  });

  // ✅ Canonical inbound signal for expense flow.
// Some older branches still referenced `inboundText` — alias it to prevent crashes.
let raw = String(rawInboundText || '').trim();

// ✅ Normalize date text BEFORE parsing (ordinals + "2020 5" year spacing)
// This prevents "January 1st, 2020 5" from failing date parse and falling back to today.
try {
  if (raw) raw = normalizeDateTextForParse(raw);
} catch {
  // fail-open: never block intake
}

const inboundText = raw; // keep legacy alias, but normalized
try {
  if (typeof inboundTwilioMeta?.Body === 'string') {
    inboundTwilioMeta.Body = normalizeDateTextForParse(inboundTwilioMeta.Body);
  }
  if (typeof inboundTwilioMeta?.ResolvedInboundText === 'string') {
    inboundTwilioMeta.ResolvedInboundText = normalizeDateTextForParse(inboundTwilioMeta.ResolvedInboundText);
  }
} catch {}


  function strictDecisionToken(s) {
    const t = String(s || '').trim().toLowerCase();
    if (!t) return null;

    // normalize a few common variants
    if (t === 'y' || t === 'yeah' || t === 'yep' || t === 'ok' || t === 'okay') return 'yes';

    if (t === 'yes') return 'yes';
    if (t === 'edit') return 'edit';
    if (t === 'cancel') return 'cancel';
    if (t === 'resume') return 'resume';
    if (t === 'skip') return 'skip';
    if (t === 'change_job' || t === 'change job' || t === 'change-job') return 'change_job';

    return null;
  }

  const strictTok = strictDecisionToken(raw);
  console.info('[EXPENSE_IN]', {
    ownerId,
    fromPhone,
    paUserId,
    raw: raw.slice(0, 140),
    strictTok,
    messageSid: inboundTwilioMeta?.MessageSid || null,
    originalReplied: inboundTwilioMeta?.OriginalRepliedMessageSid || null,
    waId: inboundTwilioMeta?.WaId || null
  });


  // ✅ Canonical CONFIRM PA key used everywhere in this handler
const paKey = String(paUserId || '').trim();
// ✅ Canonical, status-aware plan (paid users only if active/trialing)
const plan = getEffectivePlanFromOwner(ownerProfile);



  if (!isOwner) {
    const gate = canEmployeeSelfLog(plan);
    if (!gate.allowed) {
      try {
        await logCapabilityDenial(pg, {
          owner_id: String(ownerId || "").trim(),
          user_id: String(paUserId || "").trim(),
          actor_role: "employee",
          plan,
          capability: "expense",
          reason_code: gate.reason_code,
          upgrade_plan: gate.upgrade_plan || null,
          source_msg_id: safeMsgId || null, // ✅ ensure safeMsgId is used here
          context: { handler: "expense.handleExpense" }
        });
      } catch {}

      return out(twimlText(`${PRO_CREW_UPGRADE_LINE}\n${UPGRADE_FOLLOWUP_ASK}`), false);
    }
  }

  // ✅ Canonical PICK key used everywhere in this handler
  const canonicalUserKey =
    (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(paUserId)) ||
    (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(userProfile?.wa_id)) ||
    (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(fromPhone)) ||
    String(fromPhone || '').trim();

  const pickUserId = canonicalUserKey; // alias for readability in picker calls



  // ---------------------------------------------------------
// ✅ EARLY GUARD (HARD, BUT SAFE):
// If confirm draft is awaiting_edit, consume non-control edit payload
// BEFORE job picker / nag / intake — but do NOT eat normal commands.
// ---------------------------------------------------------
try {
  const strictTokEarly = strictDecisionToken(rawInboundText);
  const confirmPAEarly = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
  const draftEarly = confirmPAEarly?.payload?.draft || null;

  const isControlEarly = !!strictTokEarly;

  const lcEarly = String(rawInboundText || '').trim().toLowerCase();
  const isNonIntakeQueryEarly =
    /^show\b/.test(lcEarly) ||
    lcEarly.includes('last expense') ||
    lcEarly.includes('last revenue') ||
    /^help\b/.test(lcEarly) ||
    /^dashboard\b/.test(lcEarly) ||
    /^jobs?\b/.test(lcEarly) ||
    /^tasks?\b/.test(lcEarly) ||
    /^timesheet\b/.test(lcEarly);

  if (draftEarly?.awaiting_edit && !isControlEarly) {
    if (isNonIntakeQueryEarly) {
      return out(
        twimlText(
          [
            "✏️ I\'m waiting for your edited expense details in ONE message.",
            'Example:',
            'expense $14.21 spray foam insulation from Home Hardware on Sept 27 2025',
            'Reply "cancel" to discard.'
          ].join('\n')
        ),
        false
      );
    }

    console.info('[AWAITING_EDIT_EARLY_CONSUME]', {
      paUserId,
      strictTokEarly,
      head: String(rawInboundText || '').trim().slice(0, 140)
    });

    let nextDraft = null;
    let aiReply = null;

    try {
      const tz0 = tz;
      const r = await applyEditPayloadToConfirmDraft(
        rawInboundText,
        draftEarly,
        { fromKey: paUserId, tz: tz0, defaultData: {} }
      );
      nextDraft = r?.nextDraft || null;
      aiReply = r?.aiReply || null;
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg.includes('429')) {
        return out(
          twimlText(
            "⚠️ I\'m temporarily rate-limited. Please resend your edited expense with: amount + store + date + (optional) job."
          ),
          false
        );
      }
      throw e;
    }

    if (!nextDraft) {
      return out(
        twimlText(aiReply || "I couldn\'t understand that edit. Please resend with amount + date + job."),
        false
      );
    }

    const extractJobNameFromEditText = (t) => {
  const s = String(t || '').trim();
  if (!s) return null;

  const lines = s
    .split(/\r?\n/)
    .map((x) => String(x || '').trim())
    .filter(Boolean);

  for (const line of lines) {
    const m =
      line.match(/^\s*job\b\s*[:\-]?\s*(.+)$/i) ||
      line.match(/^\s*for\s+job\s+(.+)$/i);

    if (!m?.[1]) continue;

    let name = String(m[1]).trim();
    name = name.replace(/[.!,;:]+$/g, '').trim();
    if (!name) return null;

    if (/\b(subtotal|tax|total)\b/i.test(name)) return null;
    if (/^overhead$/i.test(name)) return 'Overhead';
    return name;
  }

  return null;
};

const jobFromText = extractJobNameFromEditText(rawInboundText);

let jobPatch = null;
try {
  jobPatch = await bestEffortResolveJobFromText(ownerId, rawInboundText);
} catch {
  jobPatch = null;
}

const originalTextKeepEarly =
  String(
    draftEarly?.originalText ||
    draftEarly?.receiptText ||
    draftEarly?.ocrText ||
    ''
  ).trim() || null;

const overwriteEarly = parseExpenseEditOverwrite(rawInboundText);

const patchedDraft = {
  ...(draftEarly || {}),
  ...(nextDraft || {}),
  ...(jobPatch || {}),

  amount:
    overwriteEarly.amount ||
    nextDraft?.amount ||
    draftEarly?.amount ||
    null,

  store:
    overwriteEarly.store ||
    nextDraft?.store ||
    draftEarly?.store ||
    null,

  date:
    overwriteEarly.date ||
    nextDraft?.date ||
    draftEarly?.date ||
    null,

  jobName:
    overwriteEarly.jobName ||
    jobFromText ||
    (
      jobPatch?.jobName &&
      !/\b(subtotal|tax|total)\b/i.test(String(jobPatch.jobName || ''))
        ? jobPatch.jobName
        : null
    ) ||
    nextDraft?.jobName ||
    draftEarly?.jobName ||
    null,

  ...(overwriteEarly.jobName || jobFromText
    ? { jobSource: 'typed' }
    : draftEarly?.jobSource
      ? { jobSource: draftEarly.jobSource }
      : jobPatch?.jobName
        ? { jobSource: jobPatch.jobSource || 'typed' }
        : null),

  item:
    overwriteEarly.item ||
    nextDraft?.item ||
    (draftEarly?.item && !/^unknown$/i.test(String(draftEarly.item)) ? draftEarly.item : null) ||
    null,

  subtotal: overwriteEarly.subtotal || draftEarly?.subtotal || null,
  tax: overwriteEarly.tax || draftEarly?.tax || null,
  total: overwriteEarly.total || draftEarly?.total || null,

  humanLine: null,
  summaryLine: null,

  draftText: String(rawInboundText || '').trim(),
  originalText: originalTextKeepEarly,

  awaiting_edit: false,
  edit_started_at: null,
  editStartedAt: null,
  edit_flow_id: null,
  needsReparse: false
};

console.info('[EXPENSE_EDIT_OVERWRITE_RESULT_EARLY]', {
  paUserId,
  amount: patchedDraft.amount || null,
  item: patchedDraft.item || null,
  store: patchedDraft.store || null,
  date: patchedDraft.date || null,
  jobName: patchedDraft.jobName || null,
  subtotal: patchedDraft.subtotal || null,
  tax: patchedDraft.tax || null,
  total: patchedDraft.total || null
});

await upsertPA({
  ownerId,
  userId: paKey,
  kind: PA_KIND_CONFIRM,
  payload: {
    ...(confirmPAEarly?.payload || {}),
    draft: patchedDraft
  },
  ttlSeconds: PA_TTL_SEC
});

try {
  return await resendConfirmExpense({ fromPhone, ownerId, tz, paUserId, userProfile });
} catch (e) {
  console.warn('[AWAITING_EDIT_EARLY_CONSUME] resendConfirmExpense failed; fallback to text:', e?.message);
  return out(twimlText(formatExpenseConfirmText(patchedDraft)), false);
}
  }
} catch (e) {
  console.warn('[AWAITING_EDIT_EARLY_CONSUME] failed (ignored):', e?.message);
}

  // ✅ NOTE: early pendingTxState edit machine is removed entirely.
  // CONFIRM PA is the only source of truth for edit flow.

  // ✅ Preserve pre-normalization receipt text — keeps newlines for OCR line parsing
  const rawReceiptTextForParsing = stripExpensePrefixes(rawInboundText);
  // Now it is safe to normalize the input for "new expense" parsing.
  input = correctTradeTerms(rawReceiptTextForParsing);

  // ---- media linkage (function-scope) ----
  let flowMediaAssetId = null;
  try {
    const pending = await getPendingTransactionState(paUserId);
    flowMediaAssetId =
      (pending?.pendingMediaMeta?.media_asset_id ||
        pending?.pendingMediaMeta?.mediaAssetId ||
        null) || null;
  } catch {}

  // -------------------------------------------------------------------
  // OPTIONAL: Confirm reparse precheck (keeps your existing behavior)
  // -------------------------------------------------------------------
  try {
    const c0 = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
    const needs = !!c0?.payload?.draft?.needsReparse;

    if (needs) {
      try {
        await maybeReparseConfirmDraftExpense({ ownerId, paUserId: paKey, tz, userProfile });
      } catch (e) {
        console.warn('[EXPENSE] maybeReparseConfirmDraftExpense failed (ignored):', e?.message);
      }

      const c1 = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
      const draft1 = c1?.payload?.draft || {};

      const receiptText = String(
        draft1?.receiptText ||
          draft1?.ocrText ||
          draft1?.extractedText ||
          c1?.payload?.receiptText ||
          c1?.payload?.ocrText ||
          c1?.payload?.extractedText ||
          draft1?.media_transcript ||
          draft1?.mediaTranscript ||
          draft1?.originalText ||
          draft1?.draftText ||
          ''
      ).trim();

      const back = parseReceiptBackstop(receiptText);

      const defaultCurrency =
        String(userProfile?.currency || '').trim().toUpperCase() ||
        String(ownerProfile?.currency || '').trim().toUpperCase() ||
        (/us/i.test(String(ownerProfile?.locale || '')) ? 'USD' : '') ||
        (/ca/i.test(String(ownerProfile?.locale || '')) ? 'CAD' : '') ||
        'CAD';

             const receiptTaxInfo =
        typeof extractReceiptTaxBreakdown === 'function'
          ? extractReceiptTaxBreakdown(receiptText || '')
          : { subtotal: null, tax: null, total: null, taxLabel: null };

      const receiptPrimaryItem =
        typeof extractReceiptPrimaryItem === 'function'
          ? extractReceiptPrimaryItem(receiptText || '')
          : null;

      const patch = back
        ? {
            store: back.store || null,
            date: String(draft1?.date || '').trim() || back.dateIso || null,
            amount:
              receiptTaxInfo?.total != null && Number.isFinite(Number(receiptTaxInfo.total))
                ? String(Number(receiptTaxInfo.total).toFixed(2))
                : back.total != null
                  ? String(Number(back.total).toFixed(2))
                  : null,
            currency: back.currency || draft1?.currency || defaultCurrency,
            item: draft1?.item || receiptPrimaryItem || null,
            subtotal:
              draft1?.subtotal ||
              (receiptTaxInfo?.subtotal != null && Number.isFinite(Number(receiptTaxInfo.subtotal))
                ? Number(receiptTaxInfo.subtotal).toFixed(2)
                : null),
            tax:
              draft1?.tax ||
              (receiptTaxInfo?.tax != null && Number.isFinite(Number(receiptTaxInfo.tax))
                ? Number(receiptTaxInfo.tax).toFixed(2)
                : null),
            total:
              draft1?.total ||
              (receiptTaxInfo?.total != null && Number.isFinite(Number(receiptTaxInfo.total))
                ? Number(receiptTaxInfo.total).toFixed(2)
                : null),
            taxLabel:
              String(draft1?.taxLabel || '').trim() ||
              String(receiptTaxInfo?.taxLabel || '').trim() ||
              null
          }
        : {
            currency: draft1?.currency || defaultCurrency,
            item: draft1?.item || receiptPrimaryItem || null,
            subtotal:
              draft1?.subtotal ||
              (receiptTaxInfo?.subtotal != null && Number.isFinite(Number(receiptTaxInfo.subtotal))
                ? Number(receiptTaxInfo.subtotal).toFixed(2)
                : null),
            tax:
              draft1?.tax ||
              (receiptTaxInfo?.tax != null && Number.isFinite(Number(receiptTaxInfo.tax))
                ? Number(receiptTaxInfo.tax).toFixed(2)
                : null),
            total:
              draft1?.total ||
              (receiptTaxInfo?.total != null && Number.isFinite(Number(receiptTaxInfo.total))
                ? Number(receiptTaxInfo.total).toFixed(2)
                : null),
            taxLabel:
              String(draft1?.taxLabel || '').trim() ||
              String(receiptTaxInfo?.taxLabel || '').trim() ||
              null
          };

      const mergedDraft = mergeDraftNonNull(draft1, patch);

      const gotAmount =
        !!String(mergedDraft.amount || '').trim() &&
        String(mergedDraft.amount).trim() !== '$0.00';

      const gotDate = !!String(mergedDraft.date || '').trim();

      await upsertPA({
        ownerId,
        userId: paKey,
        kind: PA_KIND_CONFIRM,
        payload: {
          ...(c1?.payload || {}),
          draft: { ...mergedDraft, needsReparse: !(gotAmount && gotDate) }
        },
        ttlSeconds: PA_TTL_SEC
      });
    }

    try {
      const c = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
      console.info('[CONFIRM_DRAFT_AFTER_REPARSE]', {
        paKey,
        needsReparse: !!c?.payload?.draft?.needsReparse,
        amount: c?.payload?.draft?.amount || null,
        date: c?.payload?.draft?.date || null,
        store: c?.payload?.draft?.store || null,
        item: c?.payload?.draft?.item || null,
        subtotal: c?.payload?.draft?.subtotal || null,
        tax: c?.payload?.draft?.tax || null,
        total: c?.payload?.draft?.total || null,
        taxLabel: c?.payload?.draft?.taxLabel || null,
        currency: c?.payload?.draft?.currency || null
      });
    } catch {}
  } catch (e) {
    console.warn('[EXPENSE] confirm reparse precheck failed (ignored):', e?.message);
  }

  // ✅ Resolve media link early so confirm draft always carries it.
  let resolvedFlowMediaAssetId = null;
  try {
    const inferredSrc = String(sourceMsgId || '').trim()
      ? `${String(paUserId || '').trim()}:${String(sourceMsgId).trim()}`
      : null;

    resolvedFlowMediaAssetId = await resolveMediaAssetIdForFlow({
      ownerId,
      userKey: paUserId,
      rawDraft: inferredSrc ? { media_source_msg_id: inferredSrc } : null,
      flowMediaAssetId
    });
  } catch {}

  console.info('[FLOW_MEDIA_RESOLVED_EARLY]', {
    userKey: paUserId,
    flowMediaAssetId: flowMediaAssetId || null,
    resolvedFlowMediaAssetId: resolvedFlowMediaAssetId || null,
    sourceMsgId: sourceMsgId || null
  });

  // ✅ ONE lock key, canonical
  const lockKey = `lock:${paUserId}`;

  // ✅ Local helper: reject + resend picker (with loop-stopper)
  async function rejectAndResendPicker({
    fromPhone,
    paUserId,
    stableMsgId,
    ownerId,
    userProfile,
    confirmFlowId,
    jobOptions,
    confirmDraft,
    reason,
    twilioMeta,
    pickUserId,       // ✅ REQUIRED: canonical key for PA_KIND_PICK_JOB
    pickPA            // ✅ pass in current pickPA so we can count attempts
  }) {
    const effectiveFlowId =
      String(confirmFlowId || '').trim() ||
      String(confirmDraft?.sourceMsgId || confirmDraft?.source_msg_id || '').trim() ||
      String(twilioMeta?.OriginalRepliedMessageSid || '').trim() ||
      String(stableMsgId || '').trim() ||
      `${String(paUserId || '').trim()}:${Date.now()}`;

    // --- loop stopper ---
    const attempts = Number(pickPA?.payload?.resolveAttempts || 0) || 0;
    if (attempts >= 1) {
      console.warn('[JOB_PICK_STOP_LOOP]', { reason, attempts, ownerId, paUserId });
      return out(
        twimlText(
          [
            "I couldn\'t match that job selection.",
            'Please tap the job again (or type the job name exactly as shown).',
            'Reply "cancel" to exit.'
          ].join('\n')
        ),
        false
      );
    }

    console.warn('[JOB_PICK_REJECT]', {
      reason,
      ownerId,
      paUserId,
      effectiveFlowId: String(effectiveFlowId || '').slice(0, 24),
      inboundBody: twilioMeta?.Body,
      inboundListRowId: twilioMeta?.ListRowId,
      inboundListId: twilioMeta?.ListId,
      inboundListTitle: twilioMeta?.ListTitle,
      repliedMsgSid: twilioMeta?.OriginalRepliedMessageSid,
      msgSid: twilioMeta?.MessageSid
    });

    // bump resolveAttempts so a second failure stops the loop
    try {
      await upsertPA({
        ownerId,
        userId: pickUserId,
        kind: PA_KIND_PICK_JOB,
        payload: { ...(pickPA?.payload || {}), resolveAttempts: attempts + 1 },
        ttlSeconds: PA_TTL_SEC
      });
    } catch {}

    const safeJobOptions = Array.isArray(jobOptions) ? jobOptions : [];

    await sendJobPickList({
  fromPhone,
  ownerId,
  userProfile,
  confirmFlowId: effectiveFlowId,
  jobOptions: safeJobOptions,
  paUserId,
  pickUserId,
  page: 0,
  pageSize: 8,
  context: 'expense_jobpick',
  confirmDraft: confirmDraft || null,
  resolveAttempts: attempts + 1
});


    return out(twimlEmpty(), true);
  }

  // ---------------------------------------------------------
  // ✅ OUTER TRY (handler-level): must wrap ALL remaining logic
  // ---------------------------------------------------------
  try {
    // Acquire lock (best-effort; do not hard fail)
    try {
      const lock = require('../../middleware/lock');
      if (lock?.acquireLock) await lock.acquireLock(lockKey, 8000).catch(() => null);
    } catch {}

    // ============================================================================
// ✅ DROP-IN: JOB_PICK_DEBUG block (with stale-click guard)
// ----------------------------------------------------------------------------
// What's new:
// - Uses pickPA.payload.lastPickerMsgSid (stored by sendJobPickList)
// - Compares against inboundTwilioMeta.OriginalRepliedMessageSid
// - If mismatch -> treat as stale tap and resend page 0 (no wrong-job mapping)
// - Also logs `expectedPickerMsgSid` + `repliedToMsgSid` for debugging
// ============================================================================

/* ---- 0) Awaiting receipt item review ---- */
const reviewItemsPA = await getPA({
  ownerId,
  userId: canonicalUserKey,
  kind: PA_KIND_REVIEW_ITEMS
}).catch(() => null);

if (reviewItemsPA?.payload?.draft) {
  const reviewDraft = reviewItemsPA.payload.draft;
  const lineItems = Array.isArray(reviewDraft.lineItems) ? reviewDraft.lineItems : [];
  const receiptTaxRate = typeof reviewDraft.receiptTaxRate === 'number' ? reviewDraft.receiptTaxRate : null;

  if (lineItems.length >= 2) {
    const rawReply = String(rawInboundText || '').trim().toLowerCase();

    // Check if this looks like a valid review response
    const isAllReply = rawReply === 'all';
    const nums = rawReply.split(/[\s,]+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    const isNumericReply = nums.length > 0;

    if (!isAllReply && !isNumericReply) {
      // Not a valid item-review reply — resend the review message
      const reviewMsg = buildItemReviewMessage({
        items: lineItems,
        subtotal: reviewDraft.subtotal ? Number(reviewDraft.subtotal) : null,
        tax: reviewDraft.tax ? Number(reviewDraft.tax) : null,
        taxLabel: reviewDraft.taxLabel || null,
        total: reviewDraft.total ? Number(reviewDraft.total) : null,
        store: reviewDraft.store || null
      });
      await sendWhatsAppTextMessage({ toPhone: fromPhone, body: reviewMsg });
      return out(twimlEmpty(), true);
    }

    // Determine which items to exclude (user sends numbers like "2" or "1,3")
    let excludeIndices = new Set(); // 0-based
    if (!isAllReply) {
      const validNums = nums.filter((n) => n >= 1 && n <= lineItems.length);
      for (const n of validNums) excludeIndices.add(n - 1);
    }

    const approvedItems = lineItems.filter((_, i) => !excludeIndices.has(i));

    if (approvedItems.length === 0) {
      // All items excluded — cancel the expense
      await deletePA({ ownerId, userId: canonicalUserKey, kind: PA_KIND_REVIEW_ITEMS });
      await deletePA({ ownerId, userId: canonicalUserKey, kind: PA_KIND_CONFIRM });
      return out(twimlText('All items excluded — expense cancelled. Send a new receipt to start over.'), false);
    }

    // Recalculate totals from approved items
    const newSubtotal = approvedItems.reduce((sum, it) => sum + Number(it.price || 0), 0);
    const newTax = receiptTaxRate != null ? Number((newSubtotal * receiptTaxRate).toFixed(2)) : Number(reviewDraft.tax || 0);
    const newTotal = Number((newSubtotal + newTax).toFixed(2));

    // Update the confirm PA draft with recalculated amounts and single item label
    const itemLabel = approvedItems.length === 1
      ? approvedItems[0].name
      : `${approvedItems.length} items`;

    const updatedDraft = {
      ...reviewDraft,
      item: itemLabel,
      amount: `$${newSubtotal.toFixed(2)}`,
      subtotal: newSubtotal.toFixed(2),
      tax: newTax.toFixed(2),
      total: newTotal.toFixed(2),
      lineItems: undefined,
      receiptTaxRate: undefined
    };

    // Clear review PA
    await deletePA({ ownerId, userId: canonicalUserKey, kind: PA_KIND_REVIEW_ITEMS });

    // Update confirm PA
    await upsertPA({
      ownerId,
      userId: canonicalUserKey,
      kind: PA_KIND_CONFIRM,
      payload: {
        type: 'expense',
        sourceMsgId: reviewItemsPA.payload.sourceMsgId,
        draft: updatedDraft
      },
      ttlSeconds: PA_TTL_SEC
    });

    console.info('[RECEIPT_ITEM_REVIEW]', {
      paUserId: canonicalUserKey,
      totalItems: lineItems.length,
      approvedCount: approvedItems.length,
      excludedCount: excludeIndices.size,
      newSubtotal,
      newTax,
      newTotal
    });

    // Proceed to job picker
    try {
      const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
      if (!jobs.length) {
        return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);
      }
      const confirmFlowId =
        String(reviewItemsPA.payload.sourceMsgId || '').trim() ||
        `${canonicalUserKey}:${Date.now()}`;

      await sendJobPickList({
        fromPhone,
        ownerId,
        userProfile,
        confirmFlowId,
        jobOptions: jobs,
        paUserId,
        pickUserId: canonicalUserKey,
        page: 0,
        pageSize: 8,
        context: 'expense_jobpick',
        confirmDraft: {
          ...updatedDraft,
          jobName: null,
          jobSource: null
        }
      });
      return out(twimlEmpty(), true);
    } catch (e) {
      console.warn('[EXPENSE] item review job picker send failed:', e?.message);
      return out(twimlText('Items noted. I had trouble showing the job list — try replying "jobs".'), false);
    }
  }
}

/* ---- 1) Awaiting job pick ---- */
const pickPA = await getPA({
  ownerId,
  userId: canonicalUserKey, // ✅ single canonical key
  kind: PA_KIND_PICK_JOB
}).catch(() => null);

if (pickPA?.payload && Array.isArray(pickPA.payload.jobOptions) && pickPA.payload.jobOptions.length) {
  const tok = normalizeDecisionToken(rawInboundText);

  const isConfirmControlToken =
    tok === 'yes' ||
    tok === 'edit' ||
    tok === 'cancel' ||
    tok === 'resume' ||
    tok === 'skip' ||
    tok === 'change_job';

  if (isConfirmControlToken) {
    console.info('[PICK_FLOW_BYPASS_FOR_CONFIRM_TOKEN]', { tok });
    // fall through
  } else {
    const rawInput = String(rawInboundText || '').trim();

    // ✅ include ListRowId + IRJ in "picker tap" detection
    const looksLikePickerTap =
      /^jp:[0-9a-f]{8}:/i.test(rawInput) ||
      /^job_\d{1,10}_[0-9a-z]+$/i.test(rawInput) ||
      /^jobno_\d{1,10}$/i.test(rawInput) ||
      !!inboundTwilioMeta?.ListTitle ||
      !!inboundTwilioMeta?.ListId ||
      !!inboundTwilioMeta?.ListRowId ||
      !!inboundTwilioMeta?.InteractiveResponseJson;

    const jobOptions = pickPA.payload.jobOptions;
    const page = Number(pickPA.payload.page || 0) || 0;
    const pageSize = Number(pickPA.payload.pageSize || 8) || 8;
    const hasMore = !!pickPA.payload.hasMore;

    const flow = String(pickPA.payload.flow || '').trim() || null;
    const confirmFlowId = String(pickPA.payload.confirmFlowId || '').trim() || null;
    const sentAt = Number(pickPA.payload.sentAt || 0) || 0;
    const pickerNonce = pickPA.payload.pickerNonce || null;
    const displayedHash = pickPA.payload.displayedHash || null;
    const confirmDraft = pickPA?.payload?.confirmDraft || null;

    const displayedJobNos = Array.isArray(pickPA?.payload?.displayedJobNos)
      ? pickPA.payload.displayedJobNos
      : [];

    const effectiveConfirmFlowId = confirmFlowId || stableMsgId || `${paUserId}:${Date.now()}`;

    // ✅ Resume works even while we're in the picker flow
    if (tok === 'resume') {
      const confirmPA0 = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
      const draft0 = confirmPA0?.payload?.draft || null;

      if (draft0 && Object.keys(draft0).length) {
        try {
          return await resendConfirmExpense({ fromPhone, ownerId, tz, paUserId, userProfile });
        } catch (e) {
          console.warn('[EXPENSE] resume during pick failed; fallback to text:', e?.message);
          return out(twimlText(formatExpenseConfirmText(draft0)), false);
        }
      }

      return out(twimlText("couldn't"), false);
    }

    // If user sent a brand new expense while waiting for job pick, clear state and continue parsing.
    if (looksLikeNewExpenseText(input)) {
      console.info('[EXPENSE] pick-job bypass: new expense detected, clearing PAs');
      try { await deletePA({ ownerId, userId: canonicalUserKey, kind: PA_KIND_PICK_JOB }); } catch {}
      try { await deletePA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }); } catch {}
      // fall through
    } else {
      // Stale picker protection (TTL) → resend page 0
      if (!sentAt || Date.now() - sentAt > PA_TTL_SEC * 1000) {
        return await sendJobPickList({
          fromPhone,
          ownerId,
          userProfile,
          confirmFlowId: effectiveConfirmFlowId,
          jobOptions,
          paUserId,
          pickUserId: canonicalUserKey,
          page: 0,
          pageSize: 8,
          context: 'expense_jobpick',
          confirmDraft
        });
      }

      // ✅ "more" paging MUST happen BEFORE picker tap parsing / stale-click checks
      if (tok === 'more' || /^\s*more\s*$/i.test(String(rawInboundText || '').trim())) {
        if (!hasMore) {
          return out(twimlText('No more jobs to show. Tap a job, or reply with a job name.'), false);
        }

        const nextPage = Number(page) + 1;

        return await sendJobPickList({
          fromPhone,
          ownerId,
          userProfile,
          confirmFlowId: confirmFlowId || effectiveConfirmFlowId,
          jobOptions,
          paUserId,
          pickUserId: canonicalUserKey,
          page: nextPage,
          pageSize,
          context: pickPA?.payload?.context || 'expense_jobpick',
          confirmDraft,
          resolveAttempts: pickPA?.payload?.resolveAttempts || 0
        });
      }

      // ✅ NEW: Stale picker protection (message reply mismatch)
// Only enforce when this looks like a picker tap (don't block typed messages)
const expectedPickerMsgSid = String(pickPA?.payload?.lastPickerMsgSid || '').trim() || null;
const repliedToMsgSid = String(inboundTwilioMeta?.OriginalRepliedMessageSid || '').trim() || null;

if (looksLikePickerTap && expectedPickerMsgSid) {
  // ✅ If Twilio did NOT include the replied-to SID, fail-closed (prevents stale taps from history)
  if (!repliedToMsgSid) {
    console.warn('[JOB_PICK_STALE_CLICK_NO_REPLY_SID]', {
      expectedPickerMsgSid,
      rawInput,
      listTitle: inboundTwilioMeta?.ListTitle || null,
      listId: inboundTwilioMeta?.ListId || null
    });

    return await sendJobPickList({
      fromPhone,
      ownerId,
      userProfile,
      confirmFlowId: effectiveConfirmFlowId,
      jobOptions,
      paUserId,
      pickUserId: canonicalUserKey,
      page: 0,
      pageSize: 8,
      context: 'expense_jobpick',
      confirmDraft
    });
  }

  // ✅ Mismatch -> stale
  if (expectedPickerMsgSid !== repliedToMsgSid) {
    console.warn('[JOB_PICK_STALE_CLICK]', {
      expectedPickerMsgSid,
      repliedToMsgSid,
      rawInput,
      listTitle: inboundTwilioMeta?.ListTitle || null,
      listId: inboundTwilioMeta?.ListId || null
    });

    // Resend latest picker page 0 (keeps state aligned with newest list)
    return await sendJobPickList({
      fromPhone,
      ownerId,
      userProfile,
      confirmFlowId: effectiveConfirmFlowId,
      jobOptions,
      paUserId,
      pickUserId: canonicalUserKey,
      page: 0,
      pageSize: 8,
      context: 'expense_jobpick',
      confirmDraft
    });
  }
}


      console.info('[JOB_PICK_DEBUG]', {
        input,
        rawInput,
        tok,
        flow,
        confirmFlowId: effectiveConfirmFlowId,
        sentAt,
        page,
        pageSize,
        pickerNonce,
        displayedHash,
        displayedJobNos: displayedJobNos.slice(0, 16),

        // visibility for stale protection
        expectedPickerMsgSid,
        repliedToMsgSid,

        inbound: {
          MessageSid: inboundTwilioMeta?.MessageSid || null,
          OriginalRepliedMessageSid: inboundTwilioMeta?.OriginalRepliedMessageSid || null,
          ListRowId: inboundTwilioMeta?.ListRowId || null,
          ListId: inboundTwilioMeta?.ListId || null,
          ListTitle: inboundTwilioMeta?.ListTitle || null
        }
      });

      // Optional: remember last inbound picker token (store RAWs)
      try {
        await upsertPA({
          ownerId,
          userId: canonicalUserKey,
          kind: PA_KIND_PICK_JOB,
          payload: { ...(pickPA.payload || {}), lastInboundTextRaw: rawInboundText, lastInboundText: rawInput },
          ttlSeconds: PA_TTL_SEC
        });
      } catch {}

      // ✅ If user says "change job" while already picking -> resend page 0
      if (tok === 'change_job') {
        try {
          const confirmPAx = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
          if (confirmPAx?.payload?.draft) {
            await upsertPA({
              ownerId,
              userId: paKey,
              kind: PA_KIND_CONFIRM,
              payload: {
                ...(confirmPAx.payload || {}),
                draft: { ...(confirmPAx.payload.draft || {}), needsReparse: true }
              },
              ttlSeconds: PA_TTL_SEC
            });
          }
        } catch (e) {
          console.warn('[EXPENSE] change_job needsReparse set failed (ignored):', e?.message);
        }

        return await sendJobPickList({
          fromPhone,
          ownerId,
          userProfile,
          confirmFlowId: effectiveConfirmFlowId,
          jobOptions,
          paUserId,
          pickUserId: canonicalUserKey,
          page: 0,
          pageSize: 8,
          context: 'expense_jobpick',
          confirmDraft
        });
      }

          // ✅ HARD GUARD: if confirm PA is missing but we got a picker reply, re-bootstrap from pickPA.confirmDraft
          let confirmPAForGuard = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);

          if (!confirmPAForGuard?.payload?.draft && (looksLikePickerTap || looksLikeJobPickerAnswer(rawInput))) {
            if (confirmDraft) {
              try {
                await ensureConfirmPAExists({
                  ownerId,
                  from,
                  draft: confirmDraft,
                  sourceMsgId: effectiveConfirmFlowId || stableMsgId || null,
                  userId: paKey
                });
              } catch (e) {
                console.warn('[EXPENSE] ensureConfirmPAExists failed (ignored):', e?.message);
              }

              confirmPAForGuard = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
            } else {
              return await sendJobPickList({
                fromPhone,
                ownerId,
                userProfile,
                confirmFlowId: effectiveConfirmFlowId,
                jobOptions,
                paUserId,
                pickUserId: canonicalUserKey,
                page: 0,
                pageSize: 8,
                context: 'expense_jobpick',
                confirmDraft: null
              });
            }
          }

          // ✅ shared across BOTH picker-tap path and typed-input path
let skipPickHandling = false;

// ----------------------------
// 1) PICKER-TAP PATH
// ----------------------------
if (looksLikePickerTap) {
  // ✅ IMPORTANT: detect control tokens FIRST (don't attempt selection resolution)
  const token2 = normalizeDecisionToken(rawInput);
  const isControlToken2 =
    token2 === 'yes' ||
    token2 === 'edit' ||
    token2 === 'cancel' ||
    token2 === 'change_job' ||
    token2 === 'skip' ||
    token2 === 'resume';

  if (isControlToken2) {
    skipPickHandling = true; // ✅ assign, do NOT redeclare
  } else {
    const pickJobOptions = Array.isArray(pickPA?.payload?.jobOptions) ? pickPA.payload.jobOptions : [];
    const sel = await resolveJobPickSelection(rawInput, inboundTwilioMeta || {}, pickPA);

    console.info('[JOB_PICK_RESOLVED_EXPENSE]', {
      tok: rawInput,
      inboundTitle: String(inboundTwilioMeta?.ListTitle || '').slice(0, 80),
      ok: !!sel?.ok,
      reason: sel?.ok ? null : sel?.reason,
      jobNo: sel?.jobNo || null,
      via: sel?.via || null
    });

    if (!sel?.ok || !sel?.jobNo || !Number.isFinite(Number(sel.jobNo))) {
      return await rejectAndResendPicker({
        fromPhone,
        paUserId,
        stableMsgId,
        ownerId,
        userProfile,
        confirmFlowId: effectiveConfirmFlowId,
        jobOptions: pickJobOptions.length ? pickJobOptions : jobOptions,
        confirmDraft,
        reason: sel?.reason || 'unrecognized_pick',
        twilioMeta: inboundTwilioMeta,
        pickUserId: canonicalUserKey,
        pickPA
      });
    }

    const chosenJobNo = Number(sel.jobNo);
    const chosen =
      (pickJobOptions || []).find((j) => Number(j?.job_no ?? j?.jobNo) === chosenJobNo) || null;

    if (!chosen) {
      return await rejectAndResendPicker({
        fromPhone,
        paUserId,
        stableMsgId,
        ownerId,
        userProfile,
        confirmFlowId: effectiveConfirmFlowId,
        jobOptions: pickJobOptions.length ? pickJobOptions : jobOptions,
        confirmDraft,
        reason: 'job_not_in_pick_state',
        twilioMeta: inboundTwilioMeta,
        pickUserId: canonicalUserKey,
        pickPA
      });
    }

    // Ensure confirm draft exists
    let confirmPA = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);

    if (!confirmPA?.payload?.draft) {
      const fallbackDraft = pickPA?.payload?.confirmDraft || null;
      if (fallbackDraft) {
        await upsertPA({
          ownerId,
          userId: paKey,
          kind: PA_KIND_CONFIRM,
          payload: {
            ...(confirmPA?.payload || {}),
            draft: fallbackDraft,
            sourceMsgId: effectiveConfirmFlowId || null,
            type: 'expense'
          },
          ttlSeconds: PA_TTL_SEC
        });

        confirmPA = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
      }
    }

    if (!confirmPA?.payload?.draft) {
      return await rejectAndResendPicker({
        fromPhone,
        paUserId,
        stableMsgId,
        ownerId,
        userProfile,
        confirmFlowId: effectiveConfirmFlowId,
        jobOptions: pickJobOptions.length ? pickJobOptions : jobOptions,
        confirmDraft,
        reason: 'missing_confirm_after_pick',
        twilioMeta: inboundTwilioMeta,
        pickUserId: canonicalUserKey,
        pickPA
      });
    }

    // persist active job (best-effort)
    const userKey =
      String(paUserId || '').trim() ||
      String(userProfile?.wa_id || '').trim() ||
      String(fromPhone || '').trim();

    try {
      await persistActiveJobBestEffort({
        ownerId,
        userProfile,
        fromPhone: userKey,
        jobRow: chosen,
        jobNameFallback: chosen?.name
      });
    } catch {}

    // Patch confirm draft with chosen job (UUID-safe job_id)
const chosenJobId =
  asUuidOrNull(chosen?.job_id) ||
  asUuidOrNull(chosen?.id) ||
  null;

await upsertPA({
  ownerId,
  userId: paKey,
  kind: PA_KIND_CONFIRM,
  payload: {
    ...(confirmPA.payload || {}),
    draft: {
      ...(confirmPA.payload?.draft || {}),
      jobName: getJobDisplayNameClean(chosen),
      jobSource: 'picked',
      job_no: Number.isFinite(Number(chosen?.job_no ?? chosen?.jobNo))
        ? Number(chosen?.job_no ?? chosen?.jobNo)
        : null,
      job_id: chosenJobId
    }
  },
  ttlSeconds: PA_TTL_SEC
});



    // Clear pick state now that we have a job
    try {
      await deletePA({ ownerId, userId: canonicalUserKey, kind: PA_KIND_PICK_JOB });
    } catch {}

    // Immediately re-send confirm UI
    return await resendConfirmExpense({ fromPhone, ownerId, tz, paUserId, userProfile });
  }
} // end looksLikePickerTap

// ----------------------------
// 2) TYPED INPUT PATH
// ----------------------------
//
// Assumes these exist above:
// - rawInput (string)
// - inboundTwilioMeta
// - jobOptions, page, pageSize, displayedJobNos
// - pickPA, confirmDraft, effectiveConfirmFlowId
// - canonicalUserKey, paKey, tz
// - helpers: resolveJobOptionFromReply, getJobDisplayName, persistActiveJobBestEffort
// - helpers: getPA, upsertPA, deletePA, resendConfirmExpense, rejectAndResendPicker
// - helper: asUuidOrNull (file-scope)

if (!skipPickHandling) {
  // Prefer pick-state options if present (prevents stale/shifted list interpretation)
  const pickStateOptions = Array.isArray(pickPA?.payload?.jobOptions) ? pickPA.payload.jobOptions : [];
  const optionsForResolution = pickStateOptions.length ? pickStateOptions : jobOptions;

  const resolved = resolveJobOptionFromReply(rawInput, optionsForResolution, { page, pageSize, displayedJobNos });

  console.info('[JOB_PICK_RESOLVED_TYPED]', {
    input: rawInput,
    title: inboundTwilioMeta?.ListTitle,
    resolvedKind: resolved?.kind || null,
    resolvedJobNo: resolved?.job?.job_no ?? resolved?.job?.jobNo ?? null,
    usedPickState: pickStateOptions.length > 0
  });

  if (!resolved) {
    // ✅ Don't loop forever: for typed replies, show guidance (no resend spam)
    return out(
      twimlText('Please reply with a job from the list, a number, job name, "Overhead", or "more".'),
      false
    );
  }

  // ----------------------------
  // Overhead selection
  // ----------------------------
  if (resolved.kind === 'overhead') {
    let confirmPA = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);

    // ✅ If confirm draft missing, bootstrap from pickPA.confirmDraft
    if (!confirmPA?.payload?.draft) {
      const fallbackDraft = pickPA?.payload?.confirmDraft || null;
      if (fallbackDraft) {
        await upsertPA({
          ownerId,
          userId: paKey,
          kind: PA_KIND_CONFIRM,
          payload: {
            ...(confirmPA?.payload || {}),
            draft: fallbackDraft,
            sourceMsgId: effectiveConfirmFlowId || stableMsgId || null,
            type: 'expense'
          },
          ttlSeconds: PA_TTL_SEC
        });
        confirmPA = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
      }
    }

    if (!confirmPA?.payload?.draft) {
      return await rejectAndResendPicker({
        fromPhone,
        paUserId,
        stableMsgId,
        ownerId,
        userProfile,
        confirmFlowId: effectiveConfirmFlowId,
        jobOptions: optionsForResolution,
        confirmDraft,
        reason: 'missing_confirm_after_typed_overhead',
        twilioMeta: inboundTwilioMeta,
        pickUserId: canonicalUserKey,
        pickPA
      });
    }

    await upsertPA({
      ownerId,
      userId: paKey,
      kind: PA_KIND_CONFIRM,
      payload: {
        ...(confirmPA.payload || {}),
        draft: {
          ...(confirmPA.payload?.draft || {}),
          jobName: 'Overhead',
          jobSource: 'overhead',
          job_no: null,
          job_id: null
        }
      },
      ttlSeconds: PA_TTL_SEC
    });

    // Clear pick state now that we have a job
    try { await deletePA({ ownerId, userId: canonicalUserKey, kind: PA_KIND_PICK_JOB }); } catch {}

    return await resendConfirmExpense({ fromPhone, ownerId, tz, paUserId, userProfile });
  }

  // ----------------------------
  // Specific job selection
  // ----------------------------
  if (resolved.kind === 'job' && resolved.job) {
    const resolvedJobNo =
      Number(resolved?.job?.job_no ?? resolved?.job?.jobNo ?? NaN);

    if (!Number.isFinite(resolvedJobNo)) {
      // typed reply did not resolve deterministically
      return out(
        twimlText('Please reply with a job from the list, a number, job name, "Overhead", or "more".'),
        false
      );
    }

    // ✅ Safety: ensure chosen job exists in pick-state options (if present)
    const chosen =
      (optionsForResolution || []).find((j) => Number(j?.job_no ?? j?.jobNo) === resolvedJobNo) || null;

    if (!chosen) {
      return await rejectAndResendPicker({
        fromPhone,
        paUserId,
        stableMsgId,
        ownerId,
        userProfile,
        confirmFlowId: effectiveConfirmFlowId,
        jobOptions: optionsForResolution,
        confirmDraft,
        reason: 'typed_job_not_in_pick_state',
        twilioMeta: inboundTwilioMeta,
        pickUserId: canonicalUserKey,
        pickPA
      });
    }

    const userKey =
      String(paUserId || '').trim() ||
      String(userProfile?.wa_id || '').trim() ||
      String(fromPhone || '').trim();

    // Best-effort persist active job
    try {
      await persistActiveJobBestEffort({
        ownerId,
        userProfile,
        fromPhone: userKey,
        jobRow: chosen,
        jobNameFallback: chosen?.name
      });
    } catch {}

    let confirmPA = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);

    // ✅ If confirm draft missing, bootstrap from pickPA.confirmDraft
    if (!confirmPA?.payload?.draft) {
      const fallbackDraft = pickPA?.payload?.confirmDraft || null;
      if (fallbackDraft) {
        await upsertPA({
          ownerId,
          userId: paKey,
          kind: PA_KIND_CONFIRM,
          payload: {
            ...(confirmPA?.payload || {}),
            draft: fallbackDraft,
            sourceMsgId: effectiveConfirmFlowId || stableMsgId || null,
            type: 'expense'
          },
          ttlSeconds: PA_TTL_SEC
        });
        confirmPA = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
      }
    }

    if (!confirmPA?.payload?.draft) {
      return await rejectAndResendPicker({
        fromPhone,
        paUserId,
        stableMsgId,
        ownerId,
        userProfile,
        confirmFlowId: effectiveConfirmFlowId,
        jobOptions: optionsForResolution,
        confirmDraft,
        reason: 'missing_confirm_after_typed_job',
        twilioMeta: inboundTwilioMeta,
        pickUserId: canonicalUserKey,
        pickPA
      });
    }

    // ✅ UUID-only enforcement for job_id (matches picker-tap safety)
    const chosenJobId =
      asUuidOrNull(chosen?.job_id) ||
      asUuidOrNull(chosen?.id) ||
      null;

    await upsertPA({
      ownerId,
      userId: paKey,
      kind: PA_KIND_CONFIRM,
      payload: {
        ...(confirmPA.payload || {}),
        draft: {
          ...(confirmPA.payload?.draft || {}),
          jobName: getJobDisplayNameClean(chosen),
          jobSource: 'picked',
          job_no: Number.isFinite(Number(chosen?.job_no ?? chosen?.jobNo))
          ? Number(chosen?.job_no ?? chosen?.jobNo)
          : null,

          job_id: chosenJobId
        }
      },
      ttlSeconds: PA_TTL_SEC
    });

    // Clear pick state now that we have a job
    try { await deletePA({ ownerId, userId: canonicalUserKey, kind: PA_KIND_PICK_JOB }); } catch {}

    return await resendConfirmExpense({ fromPhone, ownerId, tz, paUserId, userProfile });
  }

  // Safe fallback (should rarely hit)
  return await resendConfirmExpense({ fromPhone, ownerId, tz, paUserId, userProfile });
}

} // end not new expense
} // end picker else
} // end pickPA block


// ---- 2) Confirm/edit/cancel (CONSOLIDATED) ----

// ✅ reads (always use paKey for CONFIRM in this scope)
let confirmPA = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);

// ✅ STRICT decision token = EXACT allow-list only (no ok/yeah/yep normalization)
// ONLY yes/edit/cancel/resume/skip/change_job
const strictDecisionTokenExact = (raw) => {
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

const strictTok = strictDecisionTokenExact(rawInboundText);

// for logs
console.info('[CONFIRM_STATE]', {
  paUserId,
  paKey,
  hasDraft: !!confirmPA?.payload?.draft,
  awaiting_edit: !!confirmPA?.payload?.draft?.awaiting_edit,
  needsReparse: !!confirmPA?.payload?.draft?.needsReparse,
  strictTok,
  head: String(rawInboundText || '').trim().slice(0, 80),
  hasPickPA: false
});

let bypassConfirmToAllowNewIntake = false;

// ---------------------------------------------------------
// ✅ UN-SKIPPABLE EDIT CONSUMPTION (CONFIRM FLOW):
// ---------------------------------------------------------

try {
  // ✅ Refresh ONLY once, and only if we think confirm exists
  if (confirmPA?.payload?.draft) {
    try {
      const fresh = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM });
      if (fresh) confirmPA = fresh;
    } catch {}
  }

  const draftE = confirmPA?.payload?.draft || null;

  // "recent edit" latch (works even if awaiting_edit flag is lost)
  const editStartedAt = Number(draftE?.edit_started_at || draftE?.editStartedAt || 0) || 0;

  const EDIT_WINDOW_MS = 10 * 60 * 1000; // 10 min
  const ageMs = editStartedAt ? Date.now() - editStartedAt : null;

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

  const lc = String(rawInboundText || '').trim().toLowerCase();

  // "info commands" that should NOT be consumed as an edit payload
  const isNonIntakeQuery =
    /^show\b/.test(lc) ||
    lc.includes('last expense') ||
    lc.includes('last revenue') ||
    /^help\b/.test(lc) ||
    /^dashboard\b/.test(lc) ||
    /^jobs?\b/.test(lc) ||
    /^tasks?\b/.test(lc) ||
    /^timesheet\b/.test(lc);

  const looksLikeNewIntake = typeof looksLikeNewExpenseText === 'function'
    ? looksLikeNewExpenseText(rawInboundText)
    : false;

  const shouldConsumeAsEditPayload =
  !!draftE &&
  !isControl &&
  !isNonIntakeQuery &&
  (
    // ✅ If we are explicitly awaiting an edit, consume ANY non-control text,
    // even if it looks like a new intake (users will naturally type "expense ...")
    !!draftE.awaiting_edit ||

    // ✅ If awaiting_edit flag got lost, only then use the stricter heuristic window
    (editRecentlyStarted && !looksLikeNewIntake)
  );


  console.info('[AWAITING_EDIT_SAFETYNET_CHECK]', {
    paUserId,
    strictTok,
    awaiting_edit: !!draftE?.awaiting_edit,
    editStartedAt: editStartedAt || null,
    editRecentlyStarted,
    editAgeMs: ageMs,
    isControlToken: isControl,
    isNonIntakeQuery,
    looksLikeNewIntake,
    willConsumeAsEditPayload: shouldConsumeAsEditPayload,
    head: String(rawInboundText || '').trim().slice(0, 80)
  });

  if (shouldConsumeAsEditPayload) {
    console.info('[AWAITING_EDIT_SAFETYNET_CONSUME]', {
      paUserId,
      head: String(rawInboundText || '').trim().slice(0, 80)
    });

    const tz0 = tz;
    const rawEditText = String(rawInboundText || '').trim();
    const normalizedEditText = normalizeEditedExpense(rawEditText);
    const { nextDraft, aiReply } = await applyEditPayloadToConfirmDraft(
      normalizedEditText,
      draftE,
      { fromKey: paUserId, tz: tz0, defaultData: {} }
    );

    if (!nextDraft) {
      return out(
        twimlText(aiReply || "I couldn\'t understand that edit. Please resend with amount + date + job."),
        false
      );
    }

    // ✅ Deterministic "Job ..." capture (so job edits never rely on LLM)
const extractJobNameFromEditText = (t) => {
  const s = String(t || '').trim();
  if (!s) return null;

  const lines = s
    .split(/\r?\n/)
    .map((x) => String(x || '').trim())
    .filter(Boolean);

  for (const line of lines) {
    const m =
      line.match(/^\s*job\b\s*[:\-]?\s*(.+)$/i) ||
      line.match(/^\s*for\s+job\s+(.+)$/i);

    if (!m?.[1]) continue;

    let name = String(m[1]).trim();
    name = name.replace(/[.!,;:]+$/g, '').trim();
    if (!name) return null;

    if (/\b(subtotal|tax|total)\b/i.test(name)) return null;
    if (/^overhead$/i.test(name)) return 'Overhead';
    return name;
  }

  return null;
};

const jobFromText = extractJobNameFromEditText(rawInboundText);

// ✅ best-effort structured job patch (safe, may be null)
let jobPatch = null;
try {
  jobPatch = await bestEffortResolveJobFromText(ownerId, rawInboundText);
} catch {
  jobPatch = null;
}

// ✅ IMPORTANT: keep originalText as the original intake (audit trail)
const originalTextKeep =
  String(
    draftE?.originalText ||
    draftE?.receiptText ||
    draftE?.ocrText ||
    ''
  ).trim() || null;

// ✅ AUTHORITATIVE OVERWRITE FROM USER'S EDIT MESSAGE
const overwrite = parseExpenseEditOverwrite(rawInboundText);

const patchedDraft = {
  ...(draftE || {}),
  ...(nextDraft || {}),
  ...(jobPatch || {}),

  // ✅ user edit wins when explicitly present
  amount:
    overwrite.amount ||
    nextDraft?.amount ||
    draftE?.amount ||
    null,

  store:
    overwrite.store ||
    nextDraft?.store ||
    draftE?.store ||
    null,

  date:
    overwrite.date ||
    nextDraft?.date ||
    draftE?.date ||
    null,

  jobName:
    overwrite.jobName ||
    jobFromText ||
    (
      jobPatch?.jobName &&
      !/\b(subtotal|tax|total)\b/i.test(String(jobPatch.jobName || ''))
        ? jobPatch.jobName
        : null
    ) ||
    nextDraft?.jobName ||
    draftE?.jobName ||
    null,

  ...(overwrite.jobName || jobFromText
    ? { jobSource: 'typed' }
    : draftE?.jobSource
      ? { jobSource: draftE.jobSource }
      : jobPatch?.jobName
        ? { jobSource: jobPatch.jobSource || 'typed' }
        : null),

  subtotal: overwrite.subtotal || draftE?.subtotal || null,
  tax: overwrite.tax || draftE?.tax || null,
  total: overwrite.total || draftE?.total || null,

  // ✅ force re-render from fresh summary after edit
  humanLine: null,
  summaryLine: null,

  // ✅ user's edit is authoritative for current draft text
  draftText: String(rawInboundText || '').trim(),

  // ✅ preserve original intake / OCR evidence
  originalText: originalTextKeep,

  awaiting_edit: false,
  edit_started_at: null,
  editStartedAt: null,
  edit_flow_id: null,
  needsReparse: false
};

console.info('[EXPENSE_EDIT_OVERWRITE_RESULT]', {
  paUserId,
  amount: patchedDraft.amount || null,
  store: patchedDraft.store || null,
  date: patchedDraft.date || null,
  jobName: patchedDraft.jobName || null,
  subtotal: patchedDraft.subtotal || null,
  tax: patchedDraft.tax || null,
  total: patchedDraft.total || null
});

await upsertPA({
  ownerId,
  userId: paKey,
  kind: PA_KIND_CONFIRM,
  payload: {
    ...(confirmPA?.payload || {}),
    draft: patchedDraft
  },
  ttlSeconds: PA_TTL_SEC
});

// ✅ refresh in-memory (avoid stale confirmPA shadow bugs)
try {
  const fresh2 = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM });
  if (fresh2) confirmPA = fresh2;
} catch {}

// ✅ After applying edit payload & saving patched draft:
// set one-shot auto-yes so webhook router re-calls handler with "yes"
try {
  const editMsgSid =
    String(sourceMsgId || '').trim() ||
    String(inboundTwilioMeta?.MessageSid || '').trim() ||
    null;

  await mergePendingTransactionState(paUserId, {
    _autoYesAfterEdit: true,
    _autoYesSourceMsgId: editMsgSid
  });
} catch (e) {
  console.warn('[AUTO_YES_FLAG_SET] failed (ignored):', e?.message);
}

// ✅ MUST send interactive confirm, NEVER nag
try {
  return await resendConfirmExpense({ fromPhone, ownerId, tz: tz0, paUserId, userProfile });
} catch (e) {
  console.warn('[AWAITING_EDIT_SAFETYNET_CONSUME] resendConfirmExpense failed; fallback to text:', e?.message);
  return out(twimlText(formatExpenseConfirmText(patchedDraft)), false);
}
  }

  // ✅ If we're still awaiting_edit and user sent a control token, never nag.
  if (draftE?.awaiting_edit && isControl) {
    return out(
      twimlText(
        [
          "✏️ I\'m waiting for your edited expense details in ONE message.",
          'Example:',
          'expense $14.21 spray foam insulation from Home Hardware on Sept 27 2025',
          'Reply "cancel" to discard.'
        ].join('\n')
      ),
      false
    );
  }
} catch (e) {
  console.warn('[AWAITING_EDIT_SAFETYNET] failed (ignored):', e?.message);
  if (confirmPA?.payload?.draft?.awaiting_edit) {
    return out(
      twimlText(
        [
          "✏️ I\'m waiting for your edited expense details in ONE message.",
          'Example:',
          'expense $14.21 spray foam insulation from Home Hardware on Sept 27 2025',
          'Reply "cancel" to discard.'
        ].join('\n')
      ),
      false
    );
  }
}


// ---------------------------------------------------------
// ✅ DROP-IN: Confirm flow (nag/bypass/decision tokens) → LOOP BREAKER
// REPLACE your entire block starting at:
//   // ✅ Confirm flow (nag/bypass/decision tokens)
// DOWN THROUGH (and INCLUDING) the LOOP BREAKER header comment inside YES.
// ---------------------------------------------------------

// ---------------------------------------------------------
// ✅ Confirm flow (nag/bypass/decision tokens)
// ---------------------------------------------------------
if (confirmPA?.payload?.draft) {
  // ✅ Confirm gate (Owner OR employee-allowed-by-plan)
if (!isOwner) {

const plan = getEffectivePlanFromOwner(ownerProfile);
const gate = canEmployeeSelfLog(plan);


    if (!gate?.allowed) {
      // (Optional) log denial for analytics/audit
      try {
        await logCapabilityDenial(pg, {
          owner_id: String(ownerId || '').trim(),
          user_id: String(paUserId || '').trim(),
          actor_role: 'employee',
          plan,
          capability: 'expense_confirm',
          reason_code: gate.reason_code,
          upgrade_plan: gate.upgrade_plan || null,
          source_msg_id: safeMsgId || sourceMsgId || null,
          context: { handler: 'expense.confirmFlow' }
        });
      } catch {}

      // IMPORTANT: do NOT delete the confirm PA here; keep it resumable for the owner
      return out(twimlText(`${PRO_CREW_UPGRADE_LINE}\n${UPGRADE_FOLLOWUP_ASK}`), false);
    }
    // ✅ Employee is allowed to confirm their own expense on this plan → continue
  }

  const lcRaw = String(rawInboundText || '').trim().toLowerCase();

  // ✅ 0) Receipt/media inbound bypass: do NOT nag; let receipt intake handle this inbound.
  try {
    const numMedia0 = Number(inboundTwilioMeta?.NumMedia || inboundTwilioMeta?.numMedia || 0);
    const looksLikeReceiptInbound0 = looksLikeReceiptText(rawInboundText) || numMedia0 > 0;
    if (looksLikeReceiptInbound0) {
      console.info('[CONFIRM_BYPASS_FOR_RECEIPT_INBOUND]', { paUserId, numMedia: numMedia0 });
      bypassConfirmToAllowNewIntake = true;
    }
  } catch {}

  // ✅ 2) Currency-only reply consumption (only when it's a pure currency token)
  try {
    if (!strictTok) {
      const draft0 = confirmPA?.payload?.draft || null;
      const draftCurrency0 = String(draft0?.currency || '').trim();
      const awaitingCurrency0 = !!draft0?.awaiting_currency;

      const tokCurrencyRaw = String(rawInboundText || '').trim().toUpperCase();
      const isCurrencyToken = /^(CAD|USD|EUR|GBP|C\$|US\$)$/.test(tokCurrencyRaw);

      if (draft0 && isCurrencyToken && (!draftCurrency0 || awaitingCurrency0)) {
        const normalizedCurrency =
          tokCurrencyRaw === 'C$' ? 'CAD' : tokCurrencyRaw === 'US$' ? 'USD' : tokCurrencyRaw;

        await upsertPA({
          ownerId,
          userId: paKey,
          kind: PA_KIND_CONFIRM,
          payload: {
            ...(confirmPA.payload || {}),
            draft: {
              ...(draft0 || {}),
              currency: normalizedCurrency,
              awaiting_currency: false
            }
          },
          ttlSeconds: PA_TTL_SEC
        });

        try {
          confirmPA = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM });
        } catch {}
        return await resendConfirmExpense({ fromPhone, ownerId, tz, paUserId, userProfile });
      }
    }
  } catch (e) {
    console.warn('[EXPENSE] currency-only consume failed (ignored):', e?.message);
  }

  // decision tokens that MUST stay inside confirm flow
  const isDecisionToken = !!strictTok;

  const lc = String(rawInboundText || '').trim().toLowerCase();

  // "info commands" that should NOT be blocked by confirm draft
  const isNonIntakeQuery =
  /^show\b/.test(lc) ||
  lc.includes('last expense') ||
  lc.includes('last revenue') ||
  /^help\b/.test(lc) ||
  /^dashboard\b/.test(lc) ||
  /^jobs?\b/.test(lc) ||
  /^tasks?\b/.test(lc) ||
  /^timesheet\b/.test(lc);

  // ✅ bypass confirm nag for info commands (but do NOT bypass real decision tokens)
  if (!isDecisionToken && isNonIntakeQuery && !looksLikeNewExpenseText(rawInboundText)) {
    bypassConfirmToAllowNewIntake = true;
  }

  // ✅ If bypassing, fall through to normal routing below (do not nag, do not clear)
  if (!bypassConfirmToAllowNewIntake) {
    let pendingNow = null;
    try {
      pendingNow = await getPendingTransactionState(paUserId);
    } catch {}

    // ✅ Resume: re-send confirm for the existing pending expense (no state changes)
    if (strictTok === 'resume') {
      try {
        return await resendConfirmExpense({ fromPhone, ownerId, tz, paUserId, userProfile });
      } catch (e) {
        console.warn('[EXPENSE] resume confirm resend failed (fallback to text):', e?.message);
        return out(twimlText(formatExpenseConfirmText(confirmPA.payload.draft)), false);
      }
    }

    // ✅ Skip: keep current confirm draft pending, allow ONE new intake next.
    if (strictTok === 'skip') {
      try {
        await mergePendingTransactionState(paUserId, {
          kind: 'expense',
          allow_new_while_pending: true,
          allow_new_set_at: Date.now()
        });
        console.info('[ALLOW_NEW_WHILE_PENDING_SET]', { paUserId });
      } catch {}

      return out(
        twimlText(
          [
            'Okay — I\'ll keep that expense pending.',
            'Now send the *new* expense (or photo) you want to log.',
            'Tip: reply "resume" anytime to bring back the pending one.'
          ].join('\n')
        ),
        false
      );
    }

    // ✅ Never nag while awaiting_edit — re-prompt instead
    if (confirmPA?.payload?.draft?.awaiting_edit) {
      return out(
        twimlText(
          [
            "✏️ I\'m waiting for your edited expense details in ONE message.",
            'Example:',
            'expense $14.21 spray foam insulation from Home Hardware on Sept 27 2025',
            'Reply "cancel" to discard.'
          ].join('\n')
        ),
        false
      );
    }

    // ✅ If user is trying to log a new expense while confirm pending:
    if (looksLikeNewExpenseText(rawInboundText)) {
      console.info('[CONFIRM_NAG_WOULD_FIRE]', {
        paUserId,
        awaiting_edit: !!confirmPA?.payload?.draft?.awaiting_edit,
        head: String(rawInboundText || '').trim().slice(0, 80),
        looksLikeNewExpense: true,
        strictTok
      });

      const allowNew = !!pendingNow?.allow_new_while_pending;

      if (!allowNew) {
        return out(
          twimlText(
            [
              'You\'ve still got an expense waiting for confirmation.',
              '',
              'Reply:',
              '• "yes" to submit it',
              '• "edit" to change it',
              '• "resume" to see it again',
              '• "skip" to keep it pending and log a new one',
              '• "cancel" to discard it'
            ].join('\n')
          ),
          false
        );
      }

      // ✅ allow ONE new intake to proceed; keep confirmPA stored for resume
      bypassConfirmToAllowNewIntake = true;
    }

    // If we decided to bypass to allow new intake, fall through.
    if (!bypassConfirmToAllowNewIntake) {
      // Common safe flow id builder (avoids stableMsgId scope surprises)
      const confirmFlowIdSafe =
        String(confirmPA?.payload?.sourceMsgId || '').trim() ||
        String(confirmPA?.payload?.draft?.txSourceMsgId || confirmPA?.payload?.draft?.sourceMsgId || '').trim() ||
        String(inboundTwilioMeta?.MessageSid || inboundTwilioMeta?.SmsMessageSid || '').trim() ||
        String(sourceMsgId || '').trim() ||
        `${paUserId}:${Date.now()}`;

      // 🔁 Change Job (keep confirm PA)
      if (strictTok === 'change_job') {
        const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
        if (!jobs.length) {
          return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);
        }

        // ✅ Touch confirm PA but preserve needsReparse as-is
        try {
          await upsertPA({
            ownerId,
            userId: paKey,
            kind: PA_KIND_CONFIRM,
            payload: {
              ...(confirmPA.payload || {}),
              draft: {
                ...(confirmPA.payload?.draft || {}),
                needsReparse: !!confirmPA?.payload?.draft?.needsReparse
              }
            },
            ttlSeconds: PA_TTL_SEC
          });
        } catch (e) {
          console.warn('[EXPENSE] change_job confirmPA touch failed (ignored):', e?.message);
        }

        await sendJobPickList({
          fromPhone,
          ownerId,
          userProfile,
          confirmFlowId: confirmFlowIdSafe,
          jobOptions: jobs,
          paUserId,
          pickUserId: canonicalUserKey, // ✅ canonical key
          page: 0,
          pageSize: 8,
          context: 'expense_jobpick',
          confirmDraft: confirmPA?.payload?.draft || null
        });

        return out(twimlEmpty(), true);
      }

      // ✏️ Edit: mark confirm draft as awaiting edit
      if (strictTok === 'edit') {
        try {
          await upsertPA({
            ownerId,
            userId: paKey,
            kind: PA_KIND_CONFIRM,
            payload: {
              ...(confirmPA.payload || {}),
              draft: {
                ...(confirmPA.payload?.draft || {}),
                awaiting_edit: true,
                edit_started_at: Date.now(),
                editStartedAt: Date.now(),
                edit_flow_id: confirmFlowIdSafe
              }
            },
            ttlSeconds: PA_TTL_SEC
          });

          console.info('[EXPENSE_EDIT_MODE_SET]', { paUserId });
        } catch (e) {
          console.warn('[EXPENSE] set awaiting_edit failed (ignored):', e?.message);
        }

        return out(
          twimlText(
            [
              '✏️ Okay — send the corrected expense details in ONE message.',
              'Example:',
              'expense $14.21 spray foam insulation from Home Hardware on Sept 27 2025',
              'Reply "cancel" to discard.'
            ].join('\n')
          ),
          false
        );
      }

      // ❌ Cancel (delete confirm + pick) + clear allow_new_while_pending + cancel CIL draft
      if (strictTok === 'cancel') {
        // ---------------------------------------------
        // 0) Extract best possible source_msg_id
        // ---------------------------------------------
        const paSourceMsgId = String(confirmPA?.payload?.sourceMsgId || '').trim() || null;

        const txSourceMsgId =
          String(confirmPA?.payload?.draft?.txSourceMsgId || confirmPA?.payload?.draft?.sourceMsgId || '').trim() ||
          null;

        const mediaSourceRaw = String(confirmPA?.payload?.draft?.media_source_msg_id || '').trim() || null;

        // media_source_msg_id is often like: "<paUserId>:SMxxxxxxxx"
        let mediaMsgSid = null;
        if (mediaSourceRaw) {
          const m = mediaSourceRaw.match(/\bSM[a-f0-9]{10,64}\b/i);
          if (m) mediaMsgSid = m[0];
        }

        const srcId = paSourceMsgId || txSourceMsgId || mediaMsgSid || null;

        // ✅ Normalize actor phone to digits-only (must match cil_drafts.actor_phone)
        const actorDigits =
          (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(fromPhone)) ||
          (typeof normalizeIdentityDigits === 'function' && normalizeIdentityDigits(paUserId)) ||
          String(fromPhone || '').replace(/\D/g, '');

        console.info('[EXPENSE_CANCEL_HIT]', {
          ownerId,
          fromPhone,
          actorDigits,
          paKey,
          pickUserId: canonicalUserKey,
          strictTok,
          srcId,
          paSourceMsgId,
          txSourceMsgId,
          media_source_msg_id: mediaSourceRaw,
          mediaMsgSid
        });

        // ---------------------------------------------
        // 1) Delete PAs (confirm + pick)
        // ---------------------------------------------
        try {
          await deletePA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM });
        } catch {}
        try {
          await deletePA({ ownerId, userId: canonicalUserKey, kind: PA_KIND_PICK_JOB });
        } catch {}

        // ---------------------------------------------
        // 2) Cancel matching CIL draft (best-effort + fallback)
        // ---------------------------------------------
        let cancelledBySrc = 0;

        // 2a) cancel by source_msg_id
        try {
          if (srcId) {
            const r = await pg.cancelCilDraftBySourceMsg({
              owner_id: ownerId,
              source_msg_id: srcId,
              status: 'cancelled'
            });
            cancelledBySrc = Number(r?.cancelled || 0) || 0;
            console.info('[CIL_DRAFT_CANCEL]', { srcId, cancelled: cancelledBySrc });
          } else {
            console.warn('[CIL_DRAFT_CANCEL] no srcId found; cannot cancel by source_msg_id');
          }
        } catch (e) {
          console.warn('[CIL_DRAFT] cancel by source_msg_id failed (ignored):', e?.message);
        }

        // 2b) fallback: cancel latest draft for this actor phone (digits-only)
        try {
          if (!cancelledBySrc) {
            const r2 = await pg.cancelLatestCilDraftForActor({
              owner_id: ownerId,
              actor_phone: actorDigits,
              kind: 'expense',
              status: 'cancelled'
            });

            console.info('[CIL_DRAFT_CANCEL_FALLBACK]', {
              actorDigits,
              cancelled: r2?.cancelled ?? null,
              id: r2?.row?.id ?? null,
              source_msg_id: r2?.row?.source_msg_id ?? null,
              status: r2?.row?.status ?? null
            });
          }
        } catch (e) {
          console.warn('[CIL_DRAFT] cancel fallback failed (ignored):', e?.message);
        }

        // ---------------------------------------------
        // 3) Clear allow_new_while_pending
        // ---------------------------------------------
        try {
          const p2 = await getPendingTransactionState(paUserId);
          if (p2?.allow_new_while_pending) {
            await mergePendingTransactionState(paUserId, {
              allow_new_while_pending: false,
              allow_new_set_at: null
            });
          }
        } catch {}

        return out(twimlText("❌ Cancelled. You\'re cleared."), false);
      }

      // --------------------------------------------
// ✅ YES (HARDENED + DOES INSERT + MUST RETURN)
// --------------------------------------------
if (strictTok === 'yes') {
  // ✅ If user hits "yes" while we're awaiting_edit, do NOT submit.
  if (confirmPA?.payload?.draft?.awaiting_edit) {
    return out(
      twimlText(
        [
          "✏️ I\'m still waiting for your edited expense details in ONE message.",
          'Example:',
          'expense $14.21 spray foam insulation from Home Hardware on Sept 27 2025',
          'Reply "cancel" to discard.'
        ].join('\n')
      ),
      false
    );
  }

  try {
    // Always operate on freshest confirm PA (avoid stale confirmPA var)
    let confirmPAFresh = null;
    try {
      confirmPAFresh = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM });
    } catch (e) {
      console.warn('[YES] getPA failed (ignored):', e?.message);
      confirmPAFresh = confirmPA || null;
    }
    if (!confirmPAFresh) confirmPAFresh = confirmPA || null;

    // If draft is marked dirty, reparse now (receipt-safe)
    if (confirmPAFresh?.payload?.draft?.needsReparse) {
      try {
        await maybeReparseConfirmDraftExpense({ ownerId, paUserId: paKey, tz, userProfile });
        confirmPAFresh = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM });
      } catch (e) {
        console.warn('[YES] maybeReparseConfirmDraftExpense failed (ignored):', e?.message);
      }
    }

    let rawDraft = confirmPAFresh?.payload?.draft ? { ...confirmPAFresh.payload.draft } : null;

    // ---------------------------------------------------
    // ✅ YES LOOP BREAKER + rawDraft refresh + logging
    // ---------------------------------------------------
    try {
      // 0) Always clear pick state on YES (prevents re-entering picker on retries)
      try {
        await deletePA({ ownerId, userId: canonicalUserKey, kind: PA_KIND_PICK_JOB });
      } catch {}

      // 1) Clear pending-state one-shot flags (auto-yes after edit)
      try {
        const p = await getPendingTransactionState(paUserId);
        if (p?._autoYesAfterEdit || p?._autoYesSourceMsgId) {
          await mergePendingTransactionState(paUserId, {
            _autoYesAfterEdit: false,
            _autoYesSourceMsgId: null
          });
        }
      } catch {}

      // 2) Clear edit/issue latches in the confirm draft (belt & suspenders)
      if (rawDraft) {
        const hadLatch =
          !!rawDraft.awaiting_edit ||
          !!rawDraft.edit_started_at ||
          !!rawDraft.editStartedAt ||
          !!rawDraft.edit_flow_id ||
          !!rawDraft.editIssues ||
          !!rawDraft.pendingIssues ||
          !!rawDraft.issues ||
          rawDraft.validationMode === 'issues';

        if (hadLatch) {
          // clear on local copy
          rawDraft.awaiting_edit = false;
          rawDraft.edit_started_at = null;
          rawDraft.editStartedAt = null;
          rawDraft.edit_flow_id = null;

          rawDraft.editIssues = null;
          rawDraft.pendingIssues = null;
          rawDraft.issues = null;
          rawDraft.validationMode = null;

          // persist cleared state
          await upsertPA({
            ownerId,
            userId: paKey,
            kind: PA_KIND_CONFIRM,
            payload: {
              ...(confirmPAFresh?.payload || {}),
              draft: {
                ...(confirmPAFresh?.payload?.draft || {}),
                ...rawDraft,

                // ✅ hard override
                awaiting_edit: false,
                edit_started_at: null,
                editStartedAt: null,
                edit_flow_id: null,
                editIssues: null,
                pendingIssues: null,
                issues: null,
                validationMode: null
              }
            },
            ttlSeconds: PA_TTL_SEC
          });

          console.info('[YES_LOOP_BREAKER_CLEARED]', { paUserId, cleared: true });

          // refresh confirmPAFresh so downstream reads cleared draft
          try {
            const fresh = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM });
            if (fresh) confirmPAFresh = fresh;
          } catch {}
        } else {
          console.info('[YES_LOOP_BREAKER_CLEARED]', { paUserId, cleared: false });
        }
      }
    } catch (e) {
      console.warn('[YES_LOOP_BREAKER_CLEARED] failed (ignored):', e?.message);
    }

    // ✅ Recompute draft after possible refresh (use THIS downstream)
    const rawDraft2 = confirmPAFresh?.payload?.draft
      ? { ...confirmPAFresh.payload.draft }
      : rawDraft
        ? { ...rawDraft }
        : null;

    console.info('[YES_HANDLER_CONFIRM_PA]', {
      paUserId,
      hasConfirm: !!confirmPAFresh,
      hasDraft: !!rawDraft2 && !!Object.keys(rawDraft2 || {}).length,
      paSourceMsgId: confirmPAFresh?.payload?.sourceMsgId || null,
      amount: rawDraft2?.amount || null,
      date: rawDraft2?.date || null,
      store: rawDraft2?.store || null,
      currency: rawDraft2?.currency || null,
      jobName: rawDraft2?.jobName || null
    });

    if (!rawDraft2 || !Object.keys(rawDraft2).length) {
      return out(
        twimlText(`I didn\'t find an expense draft to submit. Reply "resume" to see what\'s pending.`),
        false
      );
    }

    // ---------------------------------------------------
    // ✅ YES finalization (txSourceMsgId + media_source_msg_id + normalize + job + insert)
    // ---------------------------------------------------

    // ✅ Canonical txSourceMsgId — NO stableMsgId dependency
    const txSourceMsgId =
      String(confirmPAFresh?.payload?.sourceMsgId || '').trim() ||
      String(inboundTwilioMeta?.MessageSid || inboundTwilioMeta?.SmsMessageSid || '').trim() ||
      String(sourceMsgId || '').trim() ||
      null;

    // ✅ Ensure media_source_msg_id always "userKey:SM..." (canonical userKey = digits paUserId)
    const userKey = String(paUserId || '').trim();

    

    // Work off draft2 (NOT rawDraft) from here down
    const draftForSubmit = { ...rawDraft2 };

    // set/normalize on draft
    if (!draftForSubmit.media_source_msg_id && txSourceMsgId) {
      draftForSubmit.media_source_msg_id = normalizeMediaSourceMsgId(userKey, txSourceMsgId);
    } else if (draftForSubmit.media_source_msg_id) {
      draftForSubmit.media_source_msg_id = normalizeMediaSourceMsgId(userKey, draftForSubmit.media_source_msg_id);
    }

    // Resolve media asset id (draft -> flow -> pending -> DB)
    const mediaAssetId = await resolveMediaAssetIdForFlow({
      ownerId,
      userKey: paUserId, // ✅ canonical
      rawDraft: draftForSubmit,
      flowMediaAssetId
    });

    // Receipt/OCR-first source text for normalization
const sourceText = String(
  draftForSubmit?.receiptText ||
    draftForSubmit?.ocrText ||
    draftForSubmit?.media_transcript ||
    draftForSubmit?.mediaTranscript ||
    draftForSubmit?.originalText ||
    draftForSubmit?.draftText ||
    draftForSubmit?.text ||
    ''
).trim();

// Normalize
let data = normalizeExpenseData(draftForSubmit, userProfile, sourceText);
ensureAmountCents(data);

// ✅ Receipt date fallback (must happen BEFORE date gating)
if (!data?.date) {
  const tz0 = userProfile?.timezone || userProfile?.tz || ownerProfile?.tz || 'America/Toronto';
  const d = extractReceiptDateYYYYMMDD(sourceText, tz0);
  if (d) data.date = d;
}

// Attach media (resolved earlier)
data.media_asset_id = mediaAssetId || data.media_asset_id || null;
data.media_source_msg_id = draftForSubmit.media_source_msg_id || null;

// ✅ Minimal gating (DB requires amount_cents + date)
const dateStr = String(data?.date || '').trim();

if (!data?.amount_cents) {
  console.warn('[EXPENSE_PARSE_MISSING_AMOUNT_CENTS]', {
    head: String(raw || '').slice(0, 120),
    amount: data?.amount ?? null
  });
  return out(twimlText("I didn\'t catch the amount. Try: expense $48 from RONA for plywood"), false);
}

if (!dateStr) {
  return out(twimlText(`I\'m missing the date. Reply like: "The transaction date is 01/05/2026".`), false);
}

// ✅ Job resolution
let jobName = data.jobName || draftForSubmit.jobName || null;
let jobSource = jobName ? (data.jobSource || draftForSubmit.jobSource || 'typed') : null;

if (!jobName) {
  jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone })) || null;
  if (jobName) jobSource = 'active';
}

if (jobName && looksLikeOverhead(jobName)) {
  jobName = 'Overhead';
  jobSource = 'overhead';
}

if (!jobName) {
  const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));

  await sendJobPickList({
    fromPhone,
    ownerId,
    userProfile,
    confirmFlowId: txSourceMsgId || `${paUserId}:${Date.now()}`,
    jobOptions: jobs,
    paUserId,
    pickUserId: canonicalUserKey,
    page: 0,
    pageSize: 8,
    context: 'expense_jobpick',
    confirmDraft: {
      ...data,
      jobName: null,
      jobSource: null,
      media_asset_id: data.media_asset_id || null,
      media_source_msg_id: data.media_source_msg_id || null,
      originalText: draftForSubmit?.originalText || sourceText || '',
      draftText: draftForSubmit?.draftText || sourceText || '',
      subtotal: draftForSubmit?.subtotal || data?.subtotal || null,
      tax: draftForSubmit?.tax || data?.tax || null,
      total: draftForSubmit?.total || data?.total || null,
      taxLabel: draftForSubmit?.taxLabel || data?.taxLabel || null
    }
  });

  return out(twimlEmpty(), true);
}


    data.jobName = jobName;
    data.jobSource = jobSource;

    // ✅ Store normalization + category
    data.store = await normalizeVendorName(ownerId, data.store);
    const category = await resolveExpenseCategory({ ownerId, data, ownerProfile });
    const categoryStr = category && String(category).trim() ? String(category).trim() : null;

    // ---------------------------------------------------
    // ✅ ACTUAL DB INSERT (HARDENED amount → amount_cents)
    // ---------------------------------------------------

    // amount_cents best-effort — prefer already-computed data.amount_cents (set by ensureAmountCents above)
    const amountCents =
      (Number.isFinite(Number(data.amount_cents)) && Number(data.amount_cents) > 0 && Number(data.amount_cents)) ||
      (typeof toAmountCents === 'function' && toAmountCents(data.amount)) ||
      (typeof toAmount === 'function' && Math.round(Number(toAmount(data.amount) || 0) * 100)) ||
      Math.round(Number(String(data.amount || '').replace(/[^0-9.\-]/g, '') || 0) * 100);

    if (!amountCents || amountCents <= 0) {
      return out(twimlText(`That amount doesn\'t look valid. Reply like: "Total 14.84" (or "14.84 CAD").`), false);
    }
// ✅ Ensure DB-safe numeric amount (never "$10.00")
const amountNumericStr = (Number.isFinite(amountCents) ? (amountCents / 100) : 0).toFixed(2);

    const insertPayload = {
  owner_id: String(ownerId || '').trim(),
  tenant_id: String(userProfile?.tenant_id || ownerProfile?.tenant_id || '').trim() || null,
  user_id: String(paUserId || '').trim(),
  actor_phone: String(paUserId || '').trim(),
  source_msg_id: txSourceMsgId || null,

  amount: amountNumericStr,
  amount_cents: amountCents,
  currency: data.currency || null,
  date: data.date,

  store: data.store || null,
  description: data.item || data.description || data.memo || null,
  category: categoryStr,

  job_name: data.jobName || null,
  job_source: data.jobSource || null,
  job_id: data.job_id || draftForSubmit.job_id || null,

  media_asset_id: data.media_asset_id || null,
  media_source_msg_id: data.media_source_msg_id || null,

  original_text: draftForSubmit?.originalText || sourceText || null,
  draft_text: draftForSubmit?.draftText || sourceText || null,

  subtotal_amount: draftForSubmit?.subtotal || data?.subtotal || null,
  tax_amount: draftForSubmit?.tax || data?.tax || null,
  tax_label: draftForSubmit?.taxLabel || data?.taxLabel || null
};

    // --- INSERT ---
  const inserted = await insertExpenseBestEffort(pg, insertPayload).catch((e) => {
  console.error('[EXPENSE_YES_INSERT] failed:', e?.message);
  throw e;
});

// Normalize "ins" shape so legacy tail logic works
const ins = {
  id: inserted?.id ?? inserted?.tx_id ?? inserted?.transaction_id ?? inserted?.row?.id ?? null,
  inserted: inserted?.inserted ?? (inserted?.id != null || inserted?.tx_id != null || inserted?.transaction_id != null)
};

console.info('[EXPENSE_INSERT_OK]', {
  paUserId,
  txSourceMsgId: txSourceMsgId || null,
  media_asset_id: data.media_asset_id || null,
  inserted: ins?.inserted ?? null,
  id: ins?.id ?? null
});

// ------------------------------
// ✅ Brain v0 fact emission (expense.confirmed)
// ------------------------------
try {
  const currency = String(data?.currency || draftForSubmit?.currency || '').trim().toUpperCase() || null;

  const rawDate = String(data?.date || '').trim() || null;
  const occurredAt =
    rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? `${rawDate}T12:00:00Z`
    : rawDate && /^\d{4}-\d{2}-\d{2}T/.test(rawDate) ? rawDate
    : null;

  const dedupeKey =
    txSourceMsgId ? `expense.confirmed:${String(txSourceMsgId)}`
    : ins?.id != null ? `expense.confirmed:tx:${String(ins.id)}`
    : `expense.confirmed:fallback:${paUserId}:${Date.now()}`;

  if (typeof pg.insertFactEvent === 'function') {
    await pg.insertFactEvent({
      owner_id: ownerId,
      actor_key: paUserId,

      event_type: 'expense.confirmed',
      entity_type: 'expense',
      entity_id: ins?.id != null ? String(ins.id) : null,

      job_no: data?.job_no ?? null,
      job_id: data?.job_id ?? null,
      job_name: jobName || data?.jobName || null,
      job_source: jobSource || data?.jobSource || null,

      amount_cents: Number.isFinite(amountCents) ? amountCents : null,
      currency,

      occurred_at: occurredAt,
      source_msg_id: txSourceMsgId || null,
      source_kind: 'whatsapp_text',

      event_payload: {
        store: String(data?.store || '').trim() || null,
        description: data.item || data.description || data.memo || null,
        date: rawDate,
        jobName: jobName || null,
        jobSource: jobSource || null
      },

      dedupe_key: dedupeKey
    });
  }
} catch (e) {
  console.warn('[FACT_EVENT] expense.confirmed insert failed (ignored):', e?.message);
}

// ✅ Link draft → confirmed transaction (best-effort)
try {
  if (txSourceMsgId && ins?.id && typeof pg.confirmCilDraftBySourceMsg === 'function') {
    await pg.confirmCilDraftBySourceMsg({
      owner_id: ownerId,
      source_msg_id: txSourceMsgId,
      confirmed_transaction_id: ins.id
    });
  }
} catch (e) {
  console.warn('[CIL_DRAFT] confirm link failed (ignored):', e?.message);
}

// ✅ After successful log: clear confirm + picker + pending-state flags so we never nag incorrectly
try { await deletePA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }); } catch {}
try { await deletePA({ ownerId, userId: canonicalUserKey, kind: PA_KIND_PICK_JOB }); } catch {}

try {
  const p2 = await getPendingTransactionState(paUserId);
  if (p2?.allow_new_while_pending || p2?._autoYesAfterEdit || p2?._autoYesSourceMsgId) {
    await mergePendingTransactionState(paUserId, {
      allow_new_while_pending: false,
      allow_new_set_at: null,
      _autoYesAfterEdit: false,
      _autoYesSourceMsgId: null
    });
  }
} catch {}

try {
  if (typeof state?.deletePendingMediaMeta === 'function') {
    await state.deletePendingMediaMeta(paUserId);
  }
} catch {}

// ✅ Build structured confirmation receipt
const confirmedCurrency = String(data?.currency || draftForSubmit?.currency || '').trim().toUpperCase() || 'CAD';

// Subtotal, tax, total — pull from draft (most complete source at this point)
const confirmedSubtotalNum = (() => {
  const v = draftForSubmit?.subtotal ?? data?.subtotal ?? null;
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
})();

const confirmedTaxNum = (() => {
  const v = draftForSubmit?.tax ?? data?.tax ?? null;
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
})();

const confirmedTotalNum = (() => {
  // Prefer explicit total field
  const v = draftForSubmit?.total ?? data?.total ?? null;
  const t = v != null ? Number(String(v).replace(/[^0-9.-]/g, '')) : null;

  // If total == subtotal and we have tax, derive real total
  if (
    t != null &&
    confirmedSubtotalNum != null &&
    confirmedTaxNum != null &&
    Math.abs(t - confirmedSubtotalNum) < 0.01
  ) {
    return Number((confirmedSubtotalNum + confirmedTaxNum).toFixed(2));
  }

  if (t != null && Number.isFinite(t) && t > 0) return t;

  // Fallback: subtotal + tax
  if (confirmedSubtotalNum != null && confirmedTaxNum != null) {
    return Number((confirmedSubtotalNum + confirmedTaxNum).toFixed(2));
  }

  // Last resort: use amountCents
  return Number.isFinite(amountCents) ? amountCents / 100 : null;
})();

const fmt = (n) =>
  typeof formatMoneyDisplay === 'function'
    ? formatMoneyDisplay(n)
    : `$${Number(n).toFixed(2)}`;

const confirmedItem = String(draftForSubmit?.item || data?.item || '').trim();
const confirmedStore = String(data?.store || draftForSubmit?.store || '').trim();
const confirmedDate = (() => {
  const raw = String(data?.date || '').trim();
  if (!raw) return null;
  if (typeof formatDisplayDate === 'function') return formatDisplayDate(raw, tz);
  return raw;
})();
const confirmedJob = String(jobName || data?.jobName || '').trim();
const confirmedCategory = String(categoryStr || '').trim();
const confirmedTaxLabel = String(draftForSubmit?.taxLabel || data?.taxLabel || '').trim() || 'Tax';

const okLines = ['✅ Logged expense:'];

if (confirmedSubtotalNum != null) {
  okLines.push(`Cost: ${fmt(confirmedSubtotalNum)} ${confirmedCurrency}`);
} else {
  // No subtotal available — show total as cost
  const fallbackAmt = confirmedTotalNum ?? (Number.isFinite(amountCents) ? amountCents / 100 : null);
  if (fallbackAmt != null) okLines.push(`Cost: ${fmt(fallbackAmt)} ${confirmedCurrency}`);
}

if (confirmedTaxNum != null && confirmedTaxNum > 0) okLines.push(`${confirmedTaxLabel}: ${fmt(confirmedTaxNum)}`);

if (confirmedTotalNum != null) okLines.push(`Total: ${fmt(confirmedTotalNum)}`);

if (confirmedItem && !/^unknown$/i.test(confirmedItem)) okLines.push(`Item: ${confirmedItem}`);
if (confirmedStore && !/^unknown/i.test(confirmedStore)) okLines.push(`Store: ${confirmedStore}`);
if (confirmedCategory) okLines.push(`Category: ${confirmedCategory}`);
if (confirmedDate) okLines.push(`Date: ${confirmedDate}`);
if (confirmedJob) okLines.push(`Job: ${confirmedJob}`);

const okMsg = okLines.join('\n');

return out(twimlText(okMsg), false);
    } catch (e) {
    console.warn('[YES] failed:', e?.message);
    // fail-soft: do not lose the confirm PA; user can "resume"
    return out(
      twimlText(
        `⚠️ I couldn\'t submit that expense right now.\n\nReply "resume" to see what\'s pending, or "cancel" to discard it.`
      ),
      false
    );
  }
} // ✅ closes: if (strictTok === 'yes')
      // Default while confirm pending (only reached if no decision token matched)
      return out(
        twimlText(
          [
            'You\'ve still got an expense waiting for confirmation.',
            '',
            'Reply:',
            '• "yes" to submit it',
            '• "edit" to change it',
            '• "resume" to see it again',
            '• "skip" to keep it pending and log a new one',
            '• "cancel" to discard it'
          ].join('\n')
        ),
        false
      );
    } // ✅ closes: inner if (!bypassConfirmToAllowNewIntake) { ... decision handling }
  } // ✅ closes: outer if (!bypassConfirmToAllowNewIntake) { ... confirm-flow body }
} // ✅ closes: if (confirmPA?.payload?.draft) { ... confirm flow }


/* ---- 3) New expense parse (deterministic first) ---- */


// ✅ Receipt/OCR path: seed/patch CONFIRM PA so "Yes" has something real to submit.
// IMPORTANT: do NOT run deterministicExpenseParse on receipt blobs.
if (looksLikeReceiptText(input)) {
  let txSourceMsgId = null;
  let mergedDraft = null;

  try {
    // --------------------------------------------
    // 1) Resolve draft0 and OCR transcript FIRST
    //    before building receiptText
    // --------------------------------------------
    const paKey = String(paUserId || '').trim();
    const userKey = String(paUserId || '').trim();
    const tz0 = userProfile?.timezone || userProfile?.tz || ownerProfile?.tz || 'America/Toronto';

    const c0 = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
    const draft0 = c0?.payload?.draft || {};

    // ✅ Canonical txSourceMsgId — NO stableMsgId dependency
    txSourceMsgId =
      String(c0?.payload?.sourceMsgId || '').trim() ||
      String(inboundTwilioMeta?.MessageSid || inboundTwilioMeta?.SmsMessageSid || '').trim() ||
      String(sourceMsgId || '').trim() ||
      null;

    // --------------------------------------------
    // 2) Build receiptText — prefer richest OCR
    //    transcript over flattened inbound body
    // --------------------------------------------
    const receiptText = (() => {
      const candidates = [
        draft0?.receiptText,
        draft0?.ocrText,
        draft0?.extractedText,
        draft0?.media_transcript,
        draft0?.mediaTranscript,
        rawReceiptTextForParsing, // ✅ preserves newlines; preferred over flattened input
        input
      ]
        .map((x) => String(x || '').trim())
        .filter(Boolean);

      // Prefer longest (richest) source — never the short flattened body
      candidates.sort((a, b) => b.length - a.length);

      return stripExpensePrefixes(String(candidates[0] || '')).trim();
    })();

    const back = parseReceiptBackstop(receiptText);

    const locale0 = String(userProfile?.locale || ownerProfile?.locale || '').toLowerCase();
    const defaultCurrency =
      String(userProfile?.currency || '').trim().toUpperCase() ||
      String(ownerProfile?.currency || '').trim().toUpperCase() ||
      (locale0.includes('us') ? 'USD' : '') ||
      (locale0.includes('ca') ? 'CAD' : '') ||
      'CAD';

    // ✅ Deterministic receipt date from the receipt text itself
    const seededDate = extractReceiptDateYYYYMMDD(receiptText, tz0);

    const inEdit = !!draft0?.awaiting_edit;

    const editLatch = {
      awaiting_edit: !!draft0?.awaiting_edit,
      edit_started_at: draft0?.edit_started_at ?? null,
      editStartedAt: draft0?.editStartedAt ?? null,
      edit_flow_id: draft0?.edit_flow_id ?? null
    };

    // ✅ Tax/subtotal/total extraction at seed time
    const receiptTaxInfo =
      typeof extractReceiptTaxBreakdown === 'function'
        ? extractReceiptTaxBreakdown(receiptText)
        : { subtotal: null, tax: null, total: null, taxLabel: null };

    // ✅ Safe item extraction at seed time
    const seededItem =
      typeof extractReceiptPrimaryItem === 'function'
        ? extractReceiptPrimaryItem(receiptText)
        : null;

    // ✅ Build patch
    // Prefer labeled receipt total; never accept absurd values
    const safeMoneyStr = (v) => {
      if (v == null) return null;
      const n = Number(String(v).replace(/[^0-9.-]/g, ''));
      if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
      return n.toFixed(2);
    };

    // ✅ If labeled total == subtotal and we have tax, the labeled total is actually
    // the subtotal row — derive the real total as subtotal + tax
    const rawReceiptTotal = receiptTaxInfo?.total != null && Number.isFinite(Number(receiptTaxInfo.total))
      ? Number(receiptTaxInfo.total)
      : null;
    const rawReceiptSubtotal = receiptTaxInfo?.subtotal != null && Number.isFinite(Number(receiptTaxInfo.subtotal))
      ? Number(receiptTaxInfo.subtotal)
      : null;
    const rawReceiptTax = receiptTaxInfo?.tax != null && Number.isFinite(Number(receiptTaxInfo.tax))
      ? Number(receiptTaxInfo.tax)
      : null;

    const totalLooksLikeSubtotal =
      rawReceiptTotal != null &&
      rawReceiptSubtotal != null &&
      rawReceiptTax != null &&
      Math.abs(rawReceiptTotal - rawReceiptSubtotal) < 0.01;

    // Also catch when parser grabbed a line-item price instead of grand total
    const totalIsTooSmall =
      rawReceiptTotal != null &&
      rawReceiptSubtotal != null &&
      rawReceiptTax != null &&
      rawReceiptTotal < rawReceiptSubtotal;

    const derivedTotal = (totalLooksLikeSubtotal || totalIsTooSmall)
      ? Number((rawReceiptSubtotal + rawReceiptTax).toFixed(2))
      : rawReceiptTotal;

    const seededTotal =
      derivedTotal != null
        ? derivedTotal.toFixed(2)
        : back?.total != null && Number.isFinite(Number(back.total))
          ? Number(back.total).toFixed(2)
          : null;

    const seededSubtotal = safeMoneyStr(receiptTaxInfo?.subtotal) || null;
    const seededTax = safeMoneyStr(receiptTaxInfo?.tax) || null;

    const patch = {
      store: back?.store || draft0?.store || null,

      date: String(draft0?.date || '').trim() || seededDate || back?.dateIso || null,

      // Use pre-tax subtotal as the primary expense amount (tax recovered as ITC for GST/HST registrants).
      // Fall back to total when no subtotal is available.
      amount:
        seededSubtotal
          ? `$${seededSubtotal}`
          : seededTotal
            ? `$${seededTotal}`
            : (String(draft0?.amount || '').trim() || null),

      currency: back?.currency || draft0?.currency || defaultCurrency,

      item:
        seededItem ||
        draft0?.item ||
        null,

      subtotal:
        seededSubtotal ||
        draft0?.subtotal ||
        null,

      tax:
        seededTax ||
        draft0?.tax ||
        null,

      total:
        seededTotal ||
        draft0?.total ||
        null,

      taxLabel:
        String(receiptTaxInfo?.taxLabel || '').trim() ||
        String(draft0?.taxLabel || '').trim() ||
        null,

      receiptText: rawReceiptTextForParsing || receiptText,
      ocrText: rawReceiptTextForParsing || receiptText,

      // ✅ Only overwrite these when NOT awaiting_edit
      originalText: inEdit ? (draft0?.originalText || receiptText) : receiptText,
      draftText: inEdit ? (draft0?.draftText || receiptText) : receiptText
    };

    mergedDraft = mergeDraftNonNull(draft0, patch);

    // ✅ Ensure media_source_msg_id always "userKey:SM..."
    if (!mergedDraft.media_source_msg_id && txSourceMsgId) {
      mergedDraft.media_source_msg_id = normalizeMediaSourceMsgId(userKey, txSourceMsgId);
    } else if (mergedDraft.media_source_msg_id) {
      mergedDraft.media_source_msg_id = normalizeMediaSourceMsgId(userKey, mergedDraft.media_source_msg_id);
    }

    mergedDraft.media_asset_id =
      mergedDraft.media_asset_id || resolvedFlowMediaAssetId || flowMediaAssetId || null;

    // ✅ Vendor sanitation: prevent "Rona for plywood" pollution
    if (mergedDraft?.store && typeof mergedDraft.store === 'string') {
      const s = mergedDraft.store.trim();
      if (mergedDraft?.item && /\sfor\s/i.test(s)) {
        mergedDraft.store = s.replace(/\s+for\s+.*/i, '').trim();
      }
    }


    const gotAmount =
      !!String(mergedDraft.amount || '').trim() &&
      String(mergedDraft.amount).trim() !== '$0.00';

    const gotDate = !!String(mergedDraft.date || '').trim();

    await upsertPA({
      ownerId,
      userId: paKey,
      kind: PA_KIND_CONFIRM,
      payload: {
        ...(c0?.payload || {}),
        type: 'expense',
        sourceMsgId: txSourceMsgId,
        draft: {
          ...mergedDraft,
          ...editLatch,
          needsReparse: !(gotAmount && gotDate)
        }
      },
      ttlSeconds: PA_TTL_SEC
    });

    console.info('[RECEIPT_SEED_CONFIRM_PA]', {
      paUserId,
      sourceMsgId: txSourceMsgId,
      store: mergedDraft.store || null,
      date: mergedDraft.date || null,
      amount: mergedDraft.amount || null,
      item: mergedDraft.item || null,
      subtotal: mergedDraft.subtotal || null,
      tax: mergedDraft.tax || null,
      total: mergedDraft.total || null,
      taxLabel: mergedDraft.taxLabel || null,
      currency: mergedDraft.currency || null,
      needsReparse: !(gotAmount && gotDate),
      media_asset_id: mergedDraft.media_asset_id || null
    });
  } catch (e) {
    console.warn('[RECEIPT_SEED_CONFIRM_PA] failed (ignored):', e?.message);
  }

  // --------------------------------------------
  // 2) Multi-item check: if receipt has 2+ items, ask user to review before job picker
  // --------------------------------------------
  try {
    const _receiptSrc = mergedDraft?.receiptText || mergedDraft?.ocrText || '';
    const allLineItems = typeof extractAllReceiptLineItems === 'function'
      ? extractAllReceiptLineItems(_receiptSrc)
      : [];

    console.info('[RECEIPT_LINE_ITEMS_CHECK]', {
      srcLen: _receiptSrc.length,
      srcHead: _receiptSrc.slice(0, 200),
      itemCount: allLineItems.length,
      items: allLineItems
    });

    if (allLineItems.length >= 2) {
      // Calculate tax rate from parsed totals for later recalculation
      const subNum = Number(mergedDraft?.subtotal || 0);
      const taxNum = Number(mergedDraft?.tax || 0);
      const receiptTaxRate = subNum > 0 && taxNum > 0 ? taxNum / subNum : null;

      // Store line items + tax rate in draft so the review handler can use them
      const draftWithItems = {
        ...mergedDraft,
        lineItems: allLineItems,
        receiptTaxRate
      };

      await upsertPA({
        ownerId,
        userId: paKey,
        kind: PA_KIND_REVIEW_ITEMS,
        payload: {
          type: 'expense',
          sourceMsgId: txSourceMsgId,
          draft: draftWithItems
        },
        ttlSeconds: PA_TTL_SEC
      });

      // Also keep the confirm PA updated with latest draft (without items list bloat)
      await upsertPA({
        ownerId,
        userId: paKey,
        kind: PA_KIND_CONFIRM,
        payload: {
          type: 'expense',
          sourceMsgId: txSourceMsgId,
          draft: draftWithItems
        },
        ttlSeconds: PA_TTL_SEC
      });

      const reviewMsg = buildItemReviewMessage({
        items: allLineItems,
        subtotal: mergedDraft?.subtotal ? Number(mergedDraft.subtotal) : null,
        tax: mergedDraft?.tax ? Number(mergedDraft.tax) : null,
        taxLabel: mergedDraft?.taxLabel || null,
        total: mergedDraft?.total ? Number(mergedDraft.total) : null,
        store: mergedDraft?.store || null
      });

      await sendWhatsAppTextMessage({ toPhone: fromPhone, body: reviewMsg });

      console.info('[RECEIPT_MULTI_ITEM]', {
        paUserId,
        itemCount: allLineItems.length,
        items: allLineItems,
        subtotal: mergedDraft?.subtotal,
        tax: mergedDraft?.tax,
        total: mergedDraft?.total,
        receiptTaxRate
      });

      return out(twimlEmpty(), true);
    }
  } catch (e) {
    console.warn('[EXPENSE] multi-item check failed (continuing to job picker):', e?.message);
  }

  // --------------------------------------------
  // 3) Receipt intake UX: ALWAYS go to job picker first
  // --------------------------------------------
  try {
    const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
    if (!jobs.length) {
      return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);
    }

    // ✅ confirmFlowId — NO stableMsgId dependency
    const confirmFlowId =
      String(txSourceMsgId || '').trim() ||
      String(inboundTwilioMeta?.MessageSid || inboundTwilioMeta?.SmsMessageSid || '').trim() ||
      String(sourceMsgId || '').trim() ||
      `${paUserId}:${Date.now()}`;

    await sendJobPickList({
      fromPhone,
      ownerId,
      userProfile,
      confirmFlowId,
      jobOptions: jobs,
      paUserId,
      pickUserId: canonicalUserKey,
      page: 0,
      pageSize: 8,
      context: 'expense_jobpick',
      confirmDraft: mergedDraft
        ? {
            ...mergedDraft,
            jobName: null,
            jobSource: null,
            media_asset_id: mergedDraft.media_asset_id || null,
            media_source_msg_id: mergedDraft.media_source_msg_id || null,
            originalText: mergedDraft.originalText || mergedDraft.receiptText || '',
            draftText: mergedDraft.draftText || mergedDraft.receiptText || '',
            subtotal: mergedDraft.subtotal || null,
            tax: mergedDraft.tax || null,
            total: mergedDraft.total || null,
            taxLabel: mergedDraft.taxLabel || null
          }
        : null
    });

    // ✅ picker sent out-of-band
    return out(twimlEmpty(), true);
  } catch (e) {
    console.warn('[EXPENSE] receipt job picker send failed:', e?.message);
    return out(twimlText('I had trouble showing the job list. Try again or reply "jobs".'), false);
  }
} else {
  // ✅ Non-receipt path: deterministic parse first
  let backstop = deterministicExpenseParse(rawInboundText, userProfile);

  // ✅ If parser failed to extract a date but the user clearly said one,
  // capture it here and inject it so we don't fall back to "today".
  const explicitDate = extractExplicitDateFromText(rawInboundText, tz);

  if (backstop && !backstop.date && explicitDate) {
    backstop = { ...backstop, date: explicitDate };
  }

  console.info('[DET_EXPENSE_DATE_TOKEN]', {
    head: String(rawInboundText || '').slice(0, 120),
    explicitDate: explicitDate || null,
    backstopDateBeforeFallback: backstop?.date ?? null
  });

  console.info('[EXPENSE_PARSE_RESULT_BACKSTOP]', {
    hasBackstop: !!backstop,
    amount: backstop?.amount ?? null,
    store: backstop?.store ?? backstop?.vendor ?? null,
    date: backstop?.date ?? null,
    job: backstop?.jobName ?? backstop?.job ?? null,
    head: String(rawInboundText || '').slice(0, 120)
  });

  // IMPORTANT:
  // Do NOT `return` here unless backstop is good enough to start confirm flow.
  if (backstop && backstop.amount) {
    const sourceText0 = String(backstop?.originalText || backstop?.draftText || input || '').trim();
    const data0 = normalizeExpenseData(backstop, userProfile, sourceText0);
    ensureAmountCents(data0);

    console.info('[EXPENSE_PARSE_RESULT_NORMALIZED]', {
      amount: data0?.amount ?? null,
      amount_cents: data0?.amount_cents ?? null,
      store: data0?.store ?? null,
      date: data0?.date ?? null,
      item: data0?.item ?? null,
      jobName: data0?.jobName ?? null,
      subtotal: data0?.subtotal ?? null,
      tax: data0?.tax ?? null,
      total: data0?.total ?? null,
      taxLabel: data0?.taxLabel ?? null
    });

    data0.store = await normalizeVendorName(ownerId, data0.store);

    // ✅ Vendor sanitation: prevent "Rona for plywood" pollution.
    if (data0?.store && typeof data0.store === 'string') {
      const s = data0.store.trim();
      if (data0?.item && /\sfor\s/i.test(s)) {
        data0.store = s.replace(/\s+for\s+.*/i, '').trim();
      }
    }

    if (isUnknownItem(data0.item)) {
      const inferred = inferExpenseItemFallback(input);
      if (inferred) data0.item = inferred;
    }

    let category = await resolveExpenseCategory({ ownerId, data: data0, ownerProfile });
    category = category && String(category).trim() ? String(category).trim() : null;

    let jobName = data0.jobName || null;
    let jobSource = jobName ? 'typed' : null;

    if (!jobName) {
      jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone })) || null;
      if (jobName) jobSource = 'active';
    }

    if (jobName && looksLikeOverhead(jobName)) {
      jobName = 'Overhead';
      jobSource = 'overhead';
    }

    if (jobName) {
      data0.item = stripEmbeddedDateAndJobFromItem(data0.item, { date: data0.date, jobName });
    }

    // ✅ Canonical per-message id for confirm PA
    const safeMsgId0 =
      String(inboundTwilioMeta?.MessageSid || inboundTwilioMeta?.SmsMessageSid || '').trim() ||
      String(sourceMsgId || '').trim() ||
      `${paUserId}:${Date.now()}`;

    const paKey = String(paUserId || '').trim();
    const u = String(paUserId || '').trim();
    const sid = String(inboundTwilioMeta?.MessageSid || inboundTwilioMeta?.SmsMessageSid || '').trim();
    const ms0 = sid ? normalizeMediaSourceMsgId(u, sid) : null;

    console.info('[MEDIA_SOURCE_MSG_ID_NORMALIZED]', {
      u,
      sid: sid || null,
      ms0
    });

    // ✅ Upsert CONFIRM PA (so "Yes/Edit" works)
    await upsertPA({
      ownerId,
      userId: paKey,
      kind: PA_KIND_CONFIRM,
      payload: {
        draft: {
          ...data0,
          jobName,
          jobSource,
          suggestedCategory: category,
          job_id: null,
          job_no: null,

          media_asset_id: resolvedFlowMediaAssetId || flowMediaAssetId || null,
          media_source_msg_id: ms0,

          originalText: input,
          draftText: input,

          subtotal: data0?.subtotal || null,
          tax: data0?.tax || null,
          total: data0?.total || null,
          taxLabel: data0?.taxLabel || null
        },
        sourceMsgId: safeMsgId0,
        type: 'expense'
      },
      ttlSeconds: PA_TTL_SEC
    });

    // ✅ Create/refresh CIL draft row (initial confirm send)
    try {
      const confirmPA1 = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
      const draft1 = confirmPA1?.payload?.draft || null;
      const srcId = String(confirmPA1?.payload?.sourceMsgId || '').trim() || null;

      if (draft1) {
        await upsertCilDraftForExpenseConfirm({
          ownerId,
          paUserId: paKey,
          fromPhone,
          draft: draft1,
          sourceMsgId: srcId
        });
      }
    } catch {}

    // ✅ consume allow_new_while_pending
    try {
      const pn = await getPendingTransactionState(paUserId);
      if (pn?.allow_new_while_pending) {
        await mergePendingTransactionState(paUserId, {
          allow_new_while_pending: false,
          allow_new_set_at: null
        });
        console.info('[ALLOW_NEW_WHILE_PENDING_RESET]', { paUserId });
      }
    } catch {}

    // ✅ If no job, go to picker
    if (!jobName) {
      const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));

      const confirmFlowId =
        String(safeMsgId0 || '').trim() ||
        String(inboundTwilioMeta?.MessageSid || inboundTwilioMeta?.SmsMessageSid || '').trim() ||
        String(sourceMsgId || '').trim() ||
        `${paUserId}:${Date.now()}`;

      await sendJobPickList({
        fromPhone,
        ownerId,
        userProfile,
        confirmFlowId,
        jobOptions: jobs,
        paUserId,
        page: 0,
        pickUserId: canonicalUserKey,
        pageSize: 8,
        context: 'expense_jobpick',
        confirmDraft: {
          ...data0,
          jobName: null,
          jobSource: null,
          media_asset_id: resolvedFlowMediaAssetId || flowMediaAssetId || null,
          media_source_msg_id: ms0,
          originalText: input,
          draftText: input,
          subtotal: data0?.subtotal || null,
          tax: data0?.tax || null,
          total: data0?.total || null,
          taxLabel: data0?.taxLabel || null
        }
      });

      return out(twimlEmpty(), true);
    }

    // ✅ Otherwise send confirm card
    const summaryLine = buildExpenseSummaryLine({
      amount: data0.amount,
      item: data0.item,
      store: data0.store,
      date: data0.date,
      jobName,
      tz,
      sourceText: input,
      subtotal: data0?.subtotal,
      tax: data0?.tax,
      total: data0?.total,
      taxLabel: data0?.taxLabel
    });

    let activeJob = null;
    try {
      if (typeof pg.getActiveJob === 'function') {
        activeJob = await pg.getActiveJob(ownerId, paKey).catch(() => null);
      }
    } catch {}

    return await sendConfirmExpenseOrFallback(
      fromPhone,
      `${summaryLine}${buildActiveJobHint(jobName, jobSource)}`,
      {
        ownerId,
        paUserId: paKey,
        draft: {
          ...data0,
          jobName,
          jobSource,
          suggestedCategory: category,
          job_id: null,
          job_no: null,
          media_asset_id: resolvedFlowMediaAssetId || flowMediaAssetId || null,
          media_source_msg_id: ms0,
          originalText: input,
          draftText: input,
          subtotal: data0?.subtotal || null,
          tax: data0?.tax || null,
          total: data0?.total || null,
          taxLabel: data0?.taxLabel || null
        },
        activeJob,
        varsPreview: null
      }
    );
  }
}
// ✅ closes: if (looksLikeReceiptText(input)) { ... } else { ... }
/* ---- 4) Parsing (AI optional; deterministic fallback always available) ---- */

const ctx = {
  fromKey: canonicalUserKey || fromPhone || userProfile?.user_id || userProfile?.from || null,
  tz: userProfile?.tz || userProfile?.timezone || tz || 'America/Toronto',
  defaultData: {
    currency: userProfile?.currency || ownerProfile?.currency || 'CAD'
  }
};

// -----------------------------
// Deterministic expense parser (no OpenAI)
// Handles: "expense $5 at value village today", "expense 12.34 home depot", "exp $18 nails from home depot yesterday"
// -----------------------------
function parseExpenseDeterministic(rawText, tz0) {
  const s = String(rawText || '').replace(/\s+/g, ' ').trim();
  const lc = s.toLowerCase();

    // Require an amount somewhere.
  // Prefer explicit "$" amounts first to avoid grabbing dates like "July 17".
  let moneyMatch = s.match(/-\s*\$\s*(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
  if (!moneyMatch) {
    moneyMatch = s.match(/\$\s*(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
  }

  // Fallback only if no $-amount exists: allow a bare number (legacy behavior)
  // NOTE: this can still match non-money numbers; keep it last.
  if (!moneyMatch) {
   // Prefer decimal amounts (12.34) or comma-grouped (1,234.56) before plain ints (17)
moneyMatch = s.match(/\b(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}\.\d{1,2})\b/);
if (!moneyMatch) {
  moneyMatch = s.match(/\b(\d{1,3}(?:,\d{3})*)\b/);
}

  }

  if (!moneyMatch) return null;

  const num = Number(String(moneyMatch[1]).replace(/,/g, '').replace(/\s/g, ''));
  if (!Number.isFinite(num) || num <= 0) return null;

  const amount = `$${num.toFixed(2)}`;


  // Date: today/yesterday/tomorrow OR explicit date via extractReceiptDateYYYYMMDD
  let date = null;
  try {
    if (/\btoday\b/i.test(lc)) date = todayInTimeZone(tz0);
    else if (/\byesterday\b/i.test(lc)) date = shiftDateYYYYMMDD(todayInTimeZone(tz0), -1);
    else if (/\btomorrow\b/i.test(lc)) date = shiftDateYYYYMMDD(todayInTimeZone(tz0), 1);
    else if (typeof extractReceiptDateYYYYMMDD === 'function') {
      date = extractReceiptDateYYYYMMDD(s, tz0) || null;
    }
  } catch {
    date = null;
  }

  // Vendor/store: look for "at X" or "from X" else take trailing tokens after amount
  let store = null;
  const atFrom = s.match(/\b(?:at|from)\s+(.+?)(?:\s+\b(?:on|for|job)\b\s+|$)/i);
  if (atFrom?.[1]) {
    store = String(atFrom[1]).trim();
  } else {
    // remove leading "expense/exp" and the amount then use what's left as store candidate
    const stripped = s
      .replace(/^(expense|exp)\b[:\-]?\s*/i, '')
      .replace(moneyMatch[0], ' ')
      .replace(/\b(today|yesterday|tomorrow)\b/ig, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (stripped) store = stripped;
  }

  // Item: optional; let downstream inference handle it
  const item = null;

  // Job: best-effort parse "job X" or "for job X"
  let jobName = null;
  const jobM = s.match(/\bjob\b\s*[:\-]?\s*([^\n\r]+)$/i);
  if (jobM?.[1]) jobName = String(jobM[1]).trim();

  return {
    amount,
    date: date || null,
    store: store || null,
    item,
    jobName: jobName || null
  };
}

// Helper: shift YYYY-MM-DD by days without moment libs
function shiftDateYYYYMMDD(ymd, deltaDays) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// -----------------------------
// Canonical parse stage (AI soft → deterministic fallback → normalize)
// MUST run before any confirm/draft logic reads `data`.
// -----------------------------

// 1) Try AI parse (soft)
let aiRes = null;
try {
  aiRes = await handleInputWithAI(
    ctx.fromKey,
    raw,
    'expense',
    parseExpenseMessage,
    ctx.defaultData,
    { tz: ctx.tz },
    { disableCorrections: true, disablePendingState: true }
  );
} catch (e) {
  console.warn('[EXPENSE_AI] failed; using deterministic fallback:', e?.message);
  aiRes = null;
}

let data = aiRes?.data || null;
let aiReply = aiRes?.reply || null;

// 2) If AI failed, use deterministic parse
const det = (!data ? parseExpenseDeterministic(raw, ctx.tz) : null);

if (!data && det) {
  data = {
    amount: det.amount,
    date: det.date || null, // keep null if absent; normalizeExpenseData decides fallback
    store: det.store || 'Unknown Store',
    item: det.item || null, // ✅ let downstream inference handle it
    jobName: det.jobName || null,
    originalText: input || raw,
    draftText: input || raw
  };
  aiReply = null;
}


// ✅ DEBUG (place #1): right after AI+deterministic assignment, BEFORE normalize
console.info('[EXPENSE_DEBUG_AFTER_PARSE]', {
  hasAI: !!aiRes,
  hasData: !!data,
  data: data
    ? {
        amount: data.amount ?? null,
        store: data.store ?? null,
        date: data.date ?? null,
        item: data.item ?? null,
        jobName: data.jobName ?? null
      }
    : null,
  det: det
    ? {
        amount: det.amount ?? null,
        store: det.store ?? null,
        date: det.date ?? null,
        jobName: det.jobName ?? null
      }
    : null,
  aiReplyHead: aiReply ? String(aiReply).slice(0, 80) : null
});
// === DATE HELPERS (MVP) ===================================================

function getTodayPartsInTz(tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = fmt.formatToParts(new Date());
    const y = Number(parts.find(p => p.type === 'year')?.value);
    const m = Number(parts.find(p => p.type === 'month')?.value);
    const d = Number(parts.find(p => p.type === 'day')?.value);
    if (!y || !m || !d) return null;
    return { y, m, d };
  } catch {
    return null;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// If transcript includes explicit month/day but no year, infer year as:
// - currentYear if that date <= today (tenant TZ)
// - else currentYear - 1
function extractMonthDayNoYear(text) {
  if (!text) return null;
  const s = String(text);

  // If a 4-digit year is explicitly present anywhere, do nothing.
  if (/\b(19|20)\d{2}\b/.test(s)) return null;

  const monthMap = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12
  };

  // Month name + day (e.g., "August 31st", "Aug 31")
  const monthDay = s.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[^0-9]{0,10}\b([0-3]?\d)(st|nd|rd|th)?\b/i
  );
  if (monthDay) {
    const monStr = monthDay[1].toLowerCase();
    const day = Number(monthDay[2]);
    const month = monthMap[monStr] ?? monthMap[monStr.slice(0, 3)];
    if (month && day >= 1 && day <= 31) return { month, day, source: 'month_name' };
  }

  // Numeric month/day (e.g., "8/31", "08-31") — only when it looks like a date phrase.
  // Prevents false-positives on codes like "INV 8/31" or random fractions.
  const looksDatey = /\b(on|dated|date|bought|purchased)\b/i.test(s);
  const md = looksDatey ? s.match(/\b([0-1]?\d)\s*[\/\-]\s*([0-3]?\d)\b/) : null;
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { month, day, source: 'numeric_md' };
    }
  }

  return null;
}

function inferYearForMonthDay(month, day, tz) {
  const t = getTodayPartsInTz(tz) || getTodayPartsInTz('UTC');
  if (!t) return null;

  const isFutureInCurrentYear =
    (month > t.m) || (month === t.m && day > t.d);

  const year = isFutureInCurrentYear ? (t.y - 1) : t.y;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// Apply inference only when:
// - text contains explicit month/day without year
// - AND parsed date is missing OR equals today (fallback symptom)
function applyMissingYearDateInference({ data, input, raw, tz, ownerId, paUserId }) {
  try {
    const textForDateScan = input || raw || '';
    const md = extractMonthDayNoYear(textForDateScan);
    if (!md) return;

    const today = getTodayPartsInTz(tz) || getTodayPartsInTz('UTC');
    const todayStr = today ? `${today.y}-${pad2(today.m)}-${pad2(today.d)}` : null;

    const parsedDateStr =
      (data && (data.date || data.expense_date || data.expenseDate)) || null;

    const isMissing = !parsedDateStr;
    const isFallbackToday = !!(todayStr && parsedDateStr === todayStr);

    if (!isMissing && !isFallbackToday) return;

    const inferred = inferYearForMonthDay(md.month, md.day, tz);
    if (!inferred) return;

    console.info('[EXPENSE_DATE_INFERRED_MISSING_YEAR]', {
      ownerId,
      paUserId,
      from: parsedDateStr,
      to: inferred,
      source: md.source,
      rawHead: String(textForDateScan).slice(0, 120)
    });

    if (data) {
      data.date = inferred;
      if (data.expense_date) data.expense_date = inferred;
      if (data.expenseDate) data.expenseDate = inferred;
    }
  } catch (e) {
    console.warn('[EXPENSE_DATE_INFERRED_MISSING_YEAR_ERR]', {
      ownerId,
      paUserId,
      msg: e?.message
    });
  }
}

// === END DATE HELPERS =====================================================


applyMissingYearDateInference({
  data,
  input,
  raw,
  tz: ctx?.tz,
  ownerId,
  paUserId
});

console.info('[EXPENSE_FINAL_DATE_PRE_NORMALIZE]', { date: data?.date ?? null });


// Normalize (works for both AI + deterministic)
if (data) {
  const sourceText = String(
    data?.receiptText ||
      data?.ocrText ||
      data?.media_transcript ||
      data?.mediaTranscript ||
      data?.originalText ||
      data?.draftText ||
      input ||
      ''
  ).trim();

  data = normalizeExpenseData(data, userProfile, sourceText);
}

if (data?.jobName) data.jobName = normalizeJobNameCandidate(data.jobName);

if (data && isUnknownItem(data.item)) {
  const inferred = inferExpenseItemFallback(input);
  if (inferred) data.item = inferred;
}
console.info('[EXPENSE_DEBUG_BEFORE_MISSINGCORE]', {
  hasData: !!data,
  amount: data?.amount ?? null,
  store: data?.store ?? null,
  date: data?.date ?? null
});

const missingCore =
  !data ||
  !data.amount ||
  data.amount === '$0.00' ||
  !data.store ||
  data.store === 'Unknown Store';

// If AI gave a helpful reply AND we truly have nothing usable, show it
if (aiReply && missingCore) {
  return out(twimlText(aiReply), false);
}

// If still missing core after deterministic attempt, show a clear fallback
if (missingCore) {
  return out(
    twimlText(`🤔 Couldn\'t parse an expense from "${input}". Try:\nexpense $84.12 at Home Depot today`),
    false
  );
}

// ✅ If we got here, we have enough to proceed.
// IMPORTANT: we must now RUN the confirm flow and RETURN,
// otherwise we will fall through to the hard fallback.

try {
  let data0 = { ...data };

  // Normalize vendor (optional)
  if (data0.store) {
    try {
      data0.store = await normalizeVendorName(ownerId, data0.store);
    } catch {}
  }

  // Vendor sanitation: prevent "Rona for plywood" pollution.
  // Only strip trailing " for …" if we ALSO have an item/description already.
  if (data0?.store && typeof data0.store === 'string') {
    const s = data0.store.trim();
    if (data0?.item && /\sfor\s/i.test(s)) {
      data0.store = s.replace(/\s+for\s+.*/i, '').trim();
    }
  }

  // Item fallback (if still unknown)
  if (isUnknownItem(data0.item)) {
    const inferred = inferExpenseItemFallback(input);
    if (inferred) data0.item = inferred;
  }

  // Category (best-effort)
  let category = null;
  try {
    category = await resolveExpenseCategory({ ownerId, data: data0, ownerProfile });
    category = category && String(category).trim() ? String(category).trim() : null;
  } catch {}

  // Job resolution (typed → active → overhead)
  let jobName = data0.jobName || null;
  let jobSource = jobName ? 'typed' : null;

  if (!jobName) {
    try {
      jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone })) || null;
      if (jobName) jobSource = 'active';
    } catch {}
  }

  if (jobName && looksLikeOverhead(jobName)) {
    jobName = 'Overhead';
    jobSource = 'overhead';
  }

  // Clean "item" of embedded job/date junk once job is known
  if (jobName) {
    data0.item = stripEmbeddedDateAndJobFromItem(data0.item, { date: data0.date, jobName });
  }

  // ✅ Canonical per-message id for confirm PA (NO stableMsgId dependency)
  const safeMsgId0 =
    String(inboundTwilioMeta?.MessageSid || inboundTwilioMeta?.SmsMessageSid || '').trim() ||
    String(sourceMsgId || '').trim() ||
    `${paUserId}:${Date.now()}`;

  // ✅ media_source_msg_id always "digits:SM..."
  const u = String(paUserId || '').trim();
  const sid = String(inboundTwilioMeta?.MessageSid || inboundTwilioMeta?.SmsMessageSid || '').trim();
  const ms0 = sid ? normalizeMediaSourceMsgId(u, sid) : null;

  // ✅ Upsert CONFIRM PA (so "Yes/Edit" works)
  await upsertPA({
    ownerId,
    userId: paKey,
    kind: PA_KIND_CONFIRM,
    payload: {
      draft: {
        ...data0,
        jobName,
        jobSource,
        suggestedCategory: category,
        job_id: null,
        job_no: null,

        media_asset_id: resolvedFlowMediaAssetId || flowMediaAssetId || null,
        media_source_msg_id: ms0,

        originalText: input,
        draftText: input
      },
      sourceMsgId: safeMsgId0,
      type: 'expense'
    },
    ttlSeconds: PA_TTL_SEC
  });

  // ✅ Create/refresh CIL draft row (initial confirm send)
  try {
    const confirmPA1 = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);
    const draft1 = confirmPA1?.payload?.draft || null;
    const srcId = String(confirmPA1?.payload?.sourceMsgId || '').trim() || null;

    if (draft1) {
      await upsertCilDraftForExpenseConfirm({
        ownerId,
        paUserId: paKey,
        fromPhone,
        draft: draft1,
        sourceMsgId: srcId
      });
    }
  } catch {}

  // ✅ If no job, go to picker
  if (!jobName) {
    const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));

    const confirmFlowId =
      String(safeMsgId0 || '').trim() ||
      String(inboundTwilioMeta?.MessageSid || inboundTwilioMeta?.SmsMessageSid || '').trim() ||
      String(sourceMsgId || '').trim() ||
      `${paUserId}:${Date.now()}`;

    await sendJobPickList({
      fromPhone,
      ownerId,
      userProfile,
      confirmFlowId,
      jobOptions: jobs,
      paUserId,
      page: 0,
      pickUserId: canonicalUserKey,
      pageSize: 8,
      context: 'expense_jobpick',
      confirmDraft: {
        ...data0,
        jobName: null,
        jobSource: null,
        media_asset_id: resolvedFlowMediaAssetId || flowMediaAssetId || null,
        media_source_msg_id: ms0,
        originalText: input,
        draftText: input
      }
    });

    return out(twimlEmpty(), true);
  }

  // ✅ Otherwise send confirm card
  const summaryLine = buildExpenseSummaryLine({
    amount: data0.amount,
    item: data0.item,
    store: data0.store,
    date: data0.date,
    jobName,
    tz,
    sourceText: input
  });

  let activeJob = null;
  try {
    if (typeof pg.getActiveJob === 'function') {
      activeJob = await pg.getActiveJob(ownerId, paKey).catch(() => null);
    }
  } catch {}

  return await sendConfirmExpenseOrFallback(
    fromPhone,
    `${summaryLine}${buildActiveJobHint(jobName, jobSource)}`,
    {
      ownerId,
      paUserId: paKey,
      draft: {
        ...data0,
        jobName,
        jobSource,
        suggestedCategory: category,
        job_id: null,
        job_no: null,
        media_asset_id: resolvedFlowMediaAssetId || flowMediaAssetId || null,
        media_source_msg_id: ms0,
        originalText: input,
        draftText: input
      },
      activeJob,
      varsPreview: null
    }
  );
} catch (e) {
  console.warn('[EXPENSE_CONFIRM_FLOW_FAILED]', e?.message);
  return out(
    twimlText(`🤔 I parsed that expense, but I couldn\'t start the confirm flow. Try again or reply "resume".`),
    false
  );
}

// 🔒 HARD FALLBACK (should never happen now)
console.warn('[EXPENSE_FALLTHROUGH_NO_REPLY]', {
  ownerId,
  paUserId,
  sourceMsgId: inboundTwilioMeta?.MessageSid || null,
  head: String(rawInboundText || input || '').slice(0, 120)
});

return out(
  twimlText(
    [
      "I couldn\'t confirm that expense yet.",
      "Try: expense $48 from RONA for plywood",
      'Or reply: "help expense"'
    ].join('\n')
  ),
  false
);


} catch (error) {
  console.error(`[ERROR] handleExpense failed for ${from}:`, error?.message, {
    stack: error?.stack,
    code: error?.code,
    detail: error?.detail,
    constraint: error?.constraint
  });

  return out(twimlText('⚠️ Error logging expense. Please try again.'), false);
} finally {
  try {
    const lock = require('../../middleware/lock');
    if (lock?.releaseLock) await lock.releaseLock(lockKey);
  } catch {}
} // end try/catch/finally

} // ✅ end handleExpense

module.exports = { handleExpense };


