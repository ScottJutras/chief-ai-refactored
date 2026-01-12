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

const {
  sendWhatsAppInteractiveList,
  sendWhatsApp,
  sendQuickReply,
  sendTemplateMessage,
  sendTemplateQuickReply,
  toWhatsApp
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

/* ---------------- Pending Actions (KIND-AWARE; postgres.js-aligned) ---------------- */

const PA_KIND_PICK_JOB = 'pick_job_for_expense';
exports.PA_KIND_PICK_JOB = PA_KIND_PICK_JOB;

const PA_KIND_CONFIRM = 'confirm_expense';

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
  return String(v || '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\D/g, '')
    .trim();
}


async function getPA({ ownerId, userId, kind }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  const k = String(kind || '').trim();
  if (!owner || !user || !k) return null;

  const ownerKey = DIGITS_ID(owner);
  const userKey = DIGITS_ID(user);
  if (!ownerKey || !userKey) return null;

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
  const ownerKey = DIGITS_ID(owner);
  const userKey = DIGITS_ID(user);

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

  const ownerKey = DIGITS_ID(owner);
  const userKey = DIGITS_ID(user);
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

async function ensureConfirmPAExists({ ownerId, from, draft, sourceMsgId }) {
  const existing = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
  if (existing?.payload?.draft) return;

  await upsertPA({
    ownerId,
    userId: paUserId,
    kind: PA_KIND_CONFIRM,
    payload: {
      draft,
      sourceMsgId,
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
function twimlText(msg) {
  return `<Response><Message>${xmlEsc(msg)}</Message></Response>`;
}
exports.twimlText = twimlText;

function twimlEmpty() {
  return `<Response></Response>`;
}
exports.twimlEmpty = twimlEmpty;

function out(twiml, sentOutOfBand = false) {
  return { twiml, sentOutOfBand: !!sentOutOfBand };
}
exports.out = out;

function waTo(from) {
  const d = String(from || '').replace(/\D/g, '');
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

async function sendWhatsAppTemplate({ to, templateSid, summaryLine }) {
  const client = getTwilioClient();
  const { waFrom, messagingServiceSid } = getSendFromConfig();

  if (!to) throw new Error('Missing "to"');

  const toClean = String(to).startsWith('whatsapp:') ? String(to) : `whatsapp:${String(to).replace(/^whatsapp:/, '')}`;
  const safeBody = String(summaryLine || '').trim().slice(0, 1500) || '—';

  // ✅ If templateSid missing, send plain text (prevents 21619)
  if (!templateSid || !String(templateSid).trim()) {
    const payload = { to: toClean, body: safeBody };
    if (waFrom) payload.from = waFrom;
    else payload.messagingServiceSid = messagingServiceSid;
    return client.messages.create(payload);
  }

  const payload = {
    to: toClean,
    contentSid: String(templateSid).trim(),
    body: safeBody,
    contentVariables: JSON.stringify({ '1': toTemplateVar(summaryLine) })
  };

  if (waFrom) payload.from = waFrom;
  else payload.messagingServiceSid = messagingServiceSid;

  return client.messages.create(payload);
}

function buildActiveJobHint(jobName, jobSource) {
  if (jobSource !== 'active' || !jobName) return '';
  return `\n\n🧠 Using active job: ${jobName}\nTip: reply "change job" to pick another`;
}

async function sendConfirmExpenseOrFallback(from, summaryLine) {
  const to = waTo(from);
  const templateSid = getExpenseConfirmTemplateSid();

  // Defensive: keep templates happy + avoid OCR garbage explosions
  const safeSummary = String(summaryLine || '')
    .replace(/\u0000/g, '')          // no null bytes
    .replace(/\s+/g, ' ')            // collapse whitespace
    .trim()
    .slice(0, 600);                  // cap for safety

  const bodyText =
    `✅ Confirm expense\n${safeSummary}\n\n` +
    `Reply: Yes / Edit / Cancel / Change Job`;

  // ✅ 1) Best path: Content Template with 4 buttons
  if (to && templateSid) {
    try {
      await sendWhatsAppTemplate({ to, templateSid, summaryLine: safeSummary });
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



async function resendConfirmExpense({ from, ownerId, tz, paUserId, userProfile = null }) {
  // ✅ Canonical: NEVER re-key; use the same PA key you write with everywhere else
  const paKey = String(paUserId || '').trim() || String(from || '').trim();

  const confirmPA = await getPA({ ownerId, userId: paKey, kind: PA_KIND_CONFIRM }).catch(() => null);

  const draft = confirmPA?.payload?.draft || null;
  if (!draft || !Object.keys(draft).length) {
    return out(twimlText('I couldn’t find anything pending. What do you want to do next?'), false);
  }

  // Prefer stored summary/humanLine if present
  const srcText =
    confirmPA?.payload?.humanLine ||
    confirmPA?.payload?.summaryLine ||
    draft.draftText ||
    draft.originalText ||
    draft.receiptText ||
    draft.ocrText ||
    '';

  const line =
    confirmPA?.payload?.humanLine ||
    confirmPA?.payload?.summaryLine ||
    buildExpenseSummaryLine({
      amount: draft.amount,
      item: draft.item,
      store: draft.store,
      date: draft.date,
      jobName: draft.jobName,
      tz,
      sourceText: srcText
    }) ||
    'Confirm expense?';

  // ✅ Send interactive template/quick replies if possible
  return await sendConfirmExpenseOrFallback(from, line);
}


async function maybeReparseConfirmDraftExpense({ ownerId, paUserId, tz, userProfile }) {
  const confirmPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
  const draft = confirmPA?.payload?.draft;
  if (!draft || !draft.needsReparse) return confirmPA;

  // ✅ Receipt/OCR-first source text (critical)
  const sourceText = String(
    draft?.receiptText ||
      draft?.ocrText ||
      draft?.extractedText ||
      draft?.originalText ||
      draft?.draftText ||
      ''
  ).trim();

  if (!sourceText) {
    // Nothing to reparse — DO NOT clear needsReparse (keeps the system honest)
    console.warn('[EXPENSE_REPARSE] no sourceText; leaving needsReparse=true', { paUserId });
    return confirmPA;
  }

  // Re-run your existing parser on the receipt/OCR source text.
  // IMPORTANT: keep job fields as-is (job choice must win).
  let parsed = {};
  try {
    parsed = (await parseExpenseMessage(sourceText, { tz })) || {};
  } catch {
    parsed = {};
  }

  const jobFields = {
    jobName: draft.jobName ?? null,
    jobSource: draft.jobSource ?? null,
    job_no: draft.job_no ?? null,
    job_id: draft.job_id ?? null
  };

  // ✅ Merge but never clobber existing values with nulls
  const mergedDraft = mergeDraftNonNull(
    {
      ...(draft || {}),
      ...jobFields,

      // keep media linkage
      media_asset_id: draft?.media_asset_id ?? null,
      media_source_msg_id: draft?.media_source_msg_id ?? null
    },
    {
      ...(parsed || {}),
      ...jobFields
    }
  );

  // Normalize receipt-safe fields now (TOTAL/date/store)
  const normalized = normalizeExpenseData(mergedDraft, userProfile, sourceText);

  // ✅ Only clear needsReparse if we got minimum viable fields
  const gotAmount = !!String(normalized?.amount || '').trim() && String(normalized.amount).trim() !== '$0.00';
  const gotDate = !!String(normalized?.date || '').trim();

  normalized.needsReparse = !(gotAmount && gotDate);

  await upsertPA({
    ownerId,
    userId: paUserId,
    kind: PA_KIND_CONFIRM,
    payload: {
      ...(confirmPA?.payload || {}),
      draft: normalized
    },
    ttlSeconds: PA_TTL_SEC
  });

  console.info('[EXPENSE_REPARSE_RESULT]', {
    paUserId,
    needsReparse: !!normalized.needsReparse,
    amount: normalized?.amount || null,
    date: normalized?.date || null,
    store: normalized?.store || null,
    currency: normalized?.currency || null
  });

  return await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
}



/* ---------------- misc helpers ---------------- */

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

  // ✅ nonce is 8-hex in your implementation (makePickerNonce() => e.g. 91726e8e)
  const m = s.match(/^jp:([0-9a-f]{8}):([0-9a-f]{8}):jn:(\d{1,10}):h:([0-9a-f]{10,16})$/i);
  if (!m) return null;

  return {
    flow: String(m[1]).toLowerCase(),
    nonce: String(m[2]).toLowerCase(),
    jobNo: Number(m[3]),
    sig: String(m[4]).toLowerCase()
  };
}

// ✅ self-contained title normalization (safe even if sanitizeJobLabel changes)
function normalizeListTitle(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[—–-]/g, '-') // normalize dashes
    .replace(/[^a-z0-9 #:-]/g, ''); // keep minimal safe chars
}

// ✅ parse jobNo from the title you actually send: "2 Oak Street Re-roof"
// (also accepts "#2 ..." and "Job #2 ...")
function jobNoFromTitle(title) {
  const t = String(title || '').trim();

  let m = t.match(/^#\s*(\d{1,10})\b/);
  if (m) return Number(m[1]);

  m = t.match(/^\s*(\d{1,10})\b/);
  if (m) return Number(m[1]);

  m = t.match(/\bjob\s*#\s*(\d{1,10})\b/i);
  if (m) return Number(m[1]);

  return null;
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

function sanitizeJobNameCandidate(candidate) {
  const s = String(candidate || '').trim();
  if (!s) return null;
  const lc = s.toLowerCase();

  if (lc.includes('$') || /\b\d{4}-\d{2}-\d{2}\b/.test(lc)) return null;
  if (/\b(from|at|on|today|yesterday|tomorrow|worth|purchased|bought|paid|spent|received)\b/.test(lc)) return null;

  const connectors = (lc.match(/\b(from|at|on|for)\b/g) || []).length;
  if (connectors >= 2) return null;

  if (s.length > 80) return null;
  return s;
}

function normalizeDecisionToken(input) {
  const s = String(input || '').trim().toLowerCase();

  // exact / common taps
  if (s === 'yes' || s === 'y' || s === 'confirm' || s === '✅ yes' || s === '✅yes') return 'yes';
  if (s === 'edit') return 'edit';
  if (s === 'cancel' || s === 'stop' || s === 'no') return 'cancel';
  if (s === 'skip') return 'skip';

  // change job
  if (s === 'change job' || s === 'switch job') return 'change_job';
  if (/\bchange\s+job\b/.test(s) && s.length <= 40) return 'change_job';

  // resume
  if (s === 'resume') return 'resume';
  if (/\bresume\b/.test(s) && s.length <= 20) return 'resume';

  // "more" (job list paging)
  if (s === 'more' || s === 'more jobs' || s === 'more jobs…') return 'more';

  // soft contains (conservative)
  if (/\byes\b/.test(s) && s.length <= 20) return 'yes';
  if (/\bedit\b/.test(s) && s.length <= 20) return 'edit';
  if (/\bcancel\b/.test(s) && s.length <= 20) return 'cancel';
  if (/\bskip\b/.test(s) && s.length <= 20) return 'skip';

  return s;
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

function buildExpenseSummaryLine({ amount, item, store, date, jobName, tz, sourceText }) {
  const amt = String(amount || '').trim();

  // Start with existing behavior
  let it = cleanExpenseItemForDisplay(item);

  // ✅ If item is Unknown, try to infer from the original line
  if (isUnknownItem(it) && sourceText) {
    const src = normalizeDashes(String(sourceText || '').trim());

    // 1) "$883 - Railing ..."
    let m =
      src.match(
        /\$\s*[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?\s*-\s*(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\bfor\b|[.?!]|$)/i
      ) || null;
    if (m?.[1]) it = cleanExpenseItemForDisplay(m[1]);

    // 2) "purchased $883 in railing at Rona"
    if (isUnknownItem(it)) {
      m =
        src.match(
          /\b(?:spent|spend|paid|pay|purchased|purchase|bought|buy|ordered|order|got)\b.*?\$\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?\s+\bin\s+(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\bfor\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
        ) || null;
      if (m?.[1]) it = cleanExpenseItemForDisplay(m[1]);
    }

    // 3) "$883 railing at Rona"
    if (isUnknownItem(it)) {
      m =
        src.match(
          /\$\s*[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?\s+(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\bfor\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
        ) || null;
      if (m?.[1]) it = cleanExpenseItemForDisplay(m[1]);
    }
  }

  if (isUnknownItem(it)) it = 'Unknown';

  const st = String(store || '').trim() || 'Unknown Store';
  const dt = formatDisplayDate(date, tz);
  const jb = jobName ? String(jobName).trim() : '';

  const lines = [];
  lines.push(`💸 ${amt} — ${it}`);
  if (st && st !== 'Unknown Store') lines.push(`🏪 ${st}`);
  if (dt) lines.push(`📅 ${dt}`);
  if (jb) lines.push(`🧰 ${jb}`);

  return lines.join('\n');
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


/**
 * ✅ PURE selection resolver
 * - Never references outer vars (including jobOptions)
 * - Uses only passed-in pickState + inbound twilio meta
 */
async function resolveJobPickSelection({ ownerId, from, input, twilioMeta, pickState }) {
  const tok = String(input || '').trim();
  const inboundTitle = String(twilioMeta?.ListTitle || '').trim();

  const flow = String(pickState?.flow || '').trim() || null;
  const pickerNonce = String(pickState?.pickerNonce || '').trim() || null;
  const displayedHash = String(pickState?.displayedHash || '').trim() || null;
  const displayedJobNos = Array.isArray(pickState?.displayedJobNos)
    ? pickState.displayedJobNos.map(Number).filter(Number.isFinite)
    : [];
  const sentRows = Array.isArray(pickState?.sentRows) ? pickState.sentRows : [];

  // Helper: extract jobNo from a visible title like "#1 1556 ..." or "Job #12 — ..."
  function extractJobNoFromTitle(s) {
    const t = String(s || '').trim();
    if (!t) return null;

    let m = t.match(/^#\s*(\d{1,6})\b/);
    if (m) return Number(m[1]);

    m = t.match(/^(\d{1,6})\b/);
    if (m) return Number(m[1]);

    m = t.match(/\bjob\s*#\s*(\d{1,6})\b/i);
    if (m) return Number(m[1]);

    return null;
  }

  // Helper: normalize titles for fuzzy matching
  function normalizeListTitle(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/^#\s*\d+\s*/g, '')     // drop leading "#12 "
      .replace(/^\d+\s+/g, '')        // drop leading "12 "
      .replace(/job\s*#\s*\d+\s*[-—:]?\s*/g, '') // drop "Job #12 —"
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ----------------------------
  // 1) CURRENT ROW-ID PATH: jp:<flow>:<nonce>:jn:<jobNo>:h:<sig>
  // ----------------------------
  const rid = parseRowId(tok);
  if (rid) {
    if (flow && String(rid.flow) !== String(flow)) return { ok: false, reason: 'flow_mismatch' };
    if (pickerNonce && String(rid.nonce) !== String(pickerNonce)) return { ok: false, reason: 'nonce_mismatch' };

    const secret = getJobPickerSecret() || 'dev-secret-change-me';
    const expected = hmac12(secret, `${rid.flow}|${rid.nonce}|${rid.jobNo}`);
    if (String(rid.sig) !== String(expected)) return { ok: false, reason: 'sig_mismatch' };

    if (displayedJobNos.length && !displayedJobNos.includes(Number(rid.jobNo))) {
      return { ok: false, reason: 'jobno_not_in_displayed' };
    }

    return {
      ok: true,
      jobNo: Number(rid.jobNo),
      meta: { mode: 'row_id', flow: rid.flow, pickerNonce: rid.nonce }
    };
  }

  // ----------------------------
  // 2) LIST TITLE FAST-PATH: "#1 1556 ..." or "Job #12 — ..."
  // ----------------------------
  const titleJobNo = extractJobNoFromTitle(inboundTitle);
  if (Number.isFinite(titleJobNo) && titleJobNo > 0) {
    if (displayedJobNos.length && !displayedJobNos.includes(Number(titleJobNo))) {
      return { ok: false, reason: 'title_jobno_not_in_displayed' };
    }
    return {
      ok: true,
      jobNo: Number(titleJobNo),
      meta: { mode: 'list_title', flow, pickerNonce, displayedHash, inboundTitle: inboundTitle.slice(0, 80) }
    };
  }

  // ----------------------------
  // 3) TITLE TEXT MATCH AGAINST sentRows (fuzzy fallback)
  // ----------------------------
  const inboundNorm = normalizeListTitle(inboundTitle);
  if (inboundNorm && sentRows.length) {
    const candidates = sentRows
      .map((r) => {
        const nameNorm = normalizeListTitle(r?.name || '');
        const titleNorm = normalizeListTitle(r?.title || '');
        const jobNo = Number(r?.jobNo);
        if (!Number.isFinite(jobNo)) return null;
        if (displayedJobNos.length && !displayedJobNos.includes(jobNo)) return null;

        let score = 0;
        if (nameNorm === inboundNorm || titleNorm === inboundNorm) score = 3;
        else if (
          (nameNorm && nameNorm.startsWith(inboundNorm)) ||
          (titleNorm && titleNorm.startsWith(inboundNorm)) ||
          (inboundNorm && inboundNorm.startsWith(nameNorm))
        ) score = 2;
        else if (
          (nameNorm && nameNorm.includes(inboundNorm)) ||
          (titleNorm && titleNorm.includes(inboundNorm)) ||
          (inboundNorm && inboundNorm.includes(nameNorm))
        ) score = 1;

        return score ? { jobNo, score, row: r } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    if (candidates.length) {
      const top = candidates[0];
      const second = candidates[1];
      if (!second || second.score < top.score) {
        return {
          ok: true,
          jobNo: Number(top.jobNo),
          meta: { mode: 'title_name_match', flow, pickerNonce, displayedHash }
        };
      }
    }
  }

  // ----------------------------
// 4) LEGACY BODY INDEX PATH: "job_<ix>_<hash>" (ix is row index, not jobNo)
// ----------------------------
const ix = typeof legacyIndexFromTwilioToken === 'function' ? legacyIndexFromTwilioToken(tok) : null;
if (ix != null) {
  if (!sentRows.length || ix > sentRows.length) return { ok: false, reason: 'legacy_ix_out_of_range' };

  const expectedRow = sentRows[ix - 1];
  const expectedJobNo = Number(expectedRow?.jobNo);

  if (!Number.isFinite(expectedJobNo)) return { ok: false, reason: 'legacy_bad_jobno' };
  if (displayedJobNos.length && !displayedJobNos.includes(expectedJobNo)) {
    return { ok: false, reason: 'legacy_job_not_in_displayed' };
  }

  return {
    ok: true,
    jobNo: expectedJobNo,
    meta: { mode: 'legacy_index', ix, flow, pickerNonce, displayedHash }
  };
}


  // ----------------------------
  // 6) FINAL TEXT FALLBACK: user typed "1" or "#1"
  // ----------------------------
  const typed = extractJobNoFromTitle(tok);
  if (Number.isFinite(typed) && typed > 0) {
    if (displayedJobNos.length && !displayedJobNos.includes(Number(typed))) {
      return { ok: false, reason: 'typed_jobno_not_in_displayed' };
    }
    return {
      ok: true,
      jobNo: Number(typed),
      meta: { mode: 'typed_number', flow, pickerNonce, displayedHash }
    };
  }

  return { ok: false, reason: 'unrecognized_pick' };
}


/* ---------------- receipt-safe extractors (TOTAL/date/store) ---------------- */

// Prefer TOTAL lines; ignore loyalty/points; ignore hyphenated IDs; avoid “largest number wins”.
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

  const hasHyphenatedId = (s) => /\b\d{3,6}-\d{1,4}\b/.test(s);          // 1852-4
  const hasLongDigitRun = (s) => /\b\d{8,}\b/.test(s);                   // barcode/account-ish

  // ✅ allow 1,234.56 or 1234.56
  const money2dp = (s) => s.match(/(?:^|[^0-9])(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d{1,6}\.\d{2})(?:[^0-9]|$)/);

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

  // ✅ 4) Final fallback: PURCHASE / PAID / DEBIT / AMOUNT (when TOTAL isn't present)
  // Choose the *largest plausible* money value from these lines, but still filtered.
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



// Extract common receipt dates. Returns YYYY-MM-DD.
function extractReceiptDate(text) {
  const raw = String(text || '');
  if (!raw) return null;

  // 1) Prefer explicit YYYY-MM-DD (works with timestamps too)
  const ymd = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;

  // 2) MM/DD/YYYY (US-style)
  const mdy = raw.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (mdy) {
    const mm = mdy[1], dd = mdy[2], yyyy = mdy[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  // 3) YYYY/MM/DD or YYYY.MM.DD
  const ymd2 = raw.match(/\b(\d{4})[\/.](\d{2})[\/.](\d{2})\b/);
  if (ymd2) return `${ymd2[1]}-${ymd2[2]}-${ymd2[3]}`;

  // 4) Month name formats: "Jan 05 2026" or "05 Jan 2026"
  const monMap = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12'
  };

  let m = raw.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\s*,?\s*(\d{4})\b/i);
  if (m) {
    const mm = monMap[String(m[1]).toLowerCase().slice(0, 4).replace('sept','sep')] || monMap[String(m[1]).toLowerCase().slice(0,3)];
    const dd = String(m[2]).padStart(2, '0');
    const yyyy = m[3];
    if (mm) return `${yyyy}-${mm}-${dd}`;
  }

  m = raw.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/i);
  if (m) {
    const dd = String(m[1]).padStart(2, '0');
    const mm = monMap[String(m[2]).toLowerCase().slice(0, 4).replace('sept','sep')] || monMap[String(m[2]).toLowerCase().slice(0,3)];
    const yyyy = m[3];
    if (mm) return `${yyyy}-${mm}-${dd}`;
  }

  return null;
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
    normalizeDecisionToken(rawInboundText) === 'resume'
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

/**
 * ✅ UPDATED: normalizeExpenseData(data, userProfile, sourceText?)
 * - Receipt-first: backfills missing/weak amount/date/store from receipt text
 * - Then applies formatting/defaults
 */
function normalizeExpenseData(data, userProfile, sourceText = '') {
  const tz = userProfile?.timezone || userProfile?.tz || 'America/Toronto';
  const d = { ...(data || {}) };

  const src = String(sourceText || '').trim();

  // ---------------------------
  // Receipt-first backfills
  // ---------------------------

  // Amount
  const currentAmt = d.amount != null ? toNumberAmount(d.amount) : null;
  const receiptTotal = src ? extractReceiptTotal(src) : null;

  if ((d.amount == null || !Number.isFinite(currentAmt) || currentAmt <= 0) && receiptTotal != null) {
    d.amount = receiptTotal; // numeric; formatted below
  }

  // Date
  if (!String(d.date || '').trim() && src) {
    const receiptDate = extractReceiptDate(src);
    if (receiptDate) d.date = receiptDate;
  }

  // Store (vendor)
  const storeTrim = String(d.store || '').trim();
  const storeWeak = !storeTrim || /^unknown\b/i.test(storeTrim) || storeTrim.length > 60 || /\$\d/.test(storeTrim);

  if (storeWeak && src) {
    const receiptStore = extractReceiptStore(src);
    if (receiptStore) d.store = receiptStore;
  }

  // ---------------------------
  // Your original normalization
  // ---------------------------

  if (d.amount != null) {
    const n = toNumberAmount(d.amount);
    if (Number.isFinite(n) && n > 0) d.amount = formatMoneyDisplay(n);
  }

  d.date = String(d.date || '').trim() || todayInTimeZone(tz);
  d.item = cleanExpenseItemForDisplay(d.item);
  d.store = String(d.store || '').trim() || 'Unknown Store';

  if (d.jobName != null) d.jobName = sanitizeJobNameCandidate(d.jobName);

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
    const name = sanitizeJobLabel(j?.name || j?.job_name || j?.jobName);
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
 */
function resolveJobOptionFromReply(input, jobOptions, { page = 0, pageSize = 8, displayedJobNos = null } = {}) {
  const raw = normalizeJobAnswer(input);
  let t0 = String(raw || '').trim();
  if (!t0) return null;

  const lc0 = t0.toLowerCase();
  if (looksLikeOverhead(t0)) return { kind: 'overhead' };
  if (lc0 === 'more' || lc0 === 'more jobs' || lc0 === 'more jobs…') return { kind: 'more' };

  const p = Math.max(0, Number(page || 0));
  const ps = Math.min(8, Math.max(1, Number(pageSize || 8)));
  const opts = Array.isArray(jobOptions) ? jobOptions : [];
  const arr = Array.isArray(displayedJobNos) ? displayedJobNos : [];

  const findByJobNo = (jobNo) => {
    const n = Number(jobNo);
    if (!Number.isFinite(n)) return null;
    return opts.find((j) => Number(j?.job_no) === n) || null;
  };

  // --- A) jobno_123 (canonical) ---
  let m = t0.match(/^jobno_(\d{1,10})$/i);
  if (m?.[1]) {
    const opt = findByJobNo(m[1]);
    return opt ? { kind: 'job', job: opt } : null;
  }

  // --- B) Twilio list token: job_<ix>_<hash> (INDEX ONLY) ---
  // Twilio sends Body/ListId like "job_2_abcd1234" where 2 == row index (1-based).
  m = t0.match(/^job_(\d{1,10})_[0-9a-z]+$/i);
  if (m?.[1]) {
    const ix = Number(m[1]);
    if (!Number.isFinite(ix) || ix <= 0) return null;

    // Prefer displayed mapping
    if (arr.length >= ix) {
      const mappedJobNo = arr[ix - 1];
      const opt = findByJobNo(mappedJobNo);
      return opt ? { kind: 'job', job: opt } : null;
    }

    // Fallback: page-local index into opts (least preferred)
    const start = p * ps;
    const idx = start + (ix - 1);
    const opt = opts[idx] || null;
    if (opt && Number.isFinite(Number(opt?.job_no))) return { kind: 'job', job: opt };
    return null;
  }

  // --- C) jobix_5 (index token) ---
  m = t0.match(/^jobix_(\d{1,10})$/i);
  if (m?.[1]) {
    const ix = Number(m[1]);
    if (!Number.isFinite(ix) || ix <= 0) return null;

    if (arr.length >= ix) {
      const mappedJobNo = arr[ix - 1];
      const opt = findByJobNo(mappedJobNo);
      if (opt) return { kind: 'job', job: opt };
    }

    const start = p * ps;
    const idx = start + (ix - 1);
    const opt = opts[idx] || null;
    if (opt && Number.isFinite(Number(opt?.job_no))) return { kind: 'job', job: opt };
    return null;
  }

  // --- D) "#1556 ..." or "1556 ..." or "J1556 ..." ---
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

  // --- E) Pure numeric reply "1" (displayed row / index) ---
  if (/^\d+$/.test(t0)) {
    const n = Number(t0);
    if (!Number.isFinite(n) || n <= 0) return null;

    if (arr.length >= n) {
      const mappedJobNo = arr[n - 1];
      const opt = findByJobNo(mappedJobNo);
      if (opt) return { kind: 'job', job: opt };
    }

    const start = p * ps;
    const idx = start + (n - 1);
    const opt = opts[idx] || null;
    if (opt && Number.isFinite(Number(opt?.job_no))) return { kind: 'job', job: opt };
    return null;
  }

  // --- F) Name match ---
  const lc = t0.toLowerCase();
  const opt =
    opts.find((j) => String(j?.name || j?.job_name || '').trim().toLowerCase() === lc) ||
    opts.find((j) => String(j?.name || j?.job_name || '').trim().toLowerCase().startsWith(lc.slice(0, 24))) ||
    null;

  if (opt && Number.isFinite(Number(opt?.job_no))) return { kind: 'job', job: opt };

  return null;
}



const ENABLE_INTERACTIVE_LIST = (() => {
  const raw = process.env.TWILIO_ENABLE_INTERACTIVE_LIST ?? process.env.TWILIO_ENABLE_LIST_PICKER ?? 'true';
  return String(raw).trim().toLowerCase() !== 'false';
})();
exports.ENABLE_INTERACTIVE_LIST = ENABLE_INTERACTIVE_LIST;

function buildTextJobPrompt(jobOptions, page, pageSize) {
  const p = Math.max(0, Number(page || 0));
  const ps = Math.min(8, Math.max(1, Number(pageSize || 8)));

  const start = p * ps;
  const slice = (jobOptions || []).slice(start, start + ps);

  const lines = slice.map((j, i) => {
    const name = sanitizeJobLabel(String(j?.name || 'Untitled Job').trim());
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
}/* ---------------- Job picker helpers ---------------- */
function getJobDisplayName(job) {
  const nm = String(job?.name || job?.job_name || job?.jobName || job?.job_name_display || '').trim();
  return nm || null;
}

// tiny nonce for “this picker instance”
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

async function sendJobPickList({
  from,
  ownerId,
  userProfile,
  confirmFlowId,
  jobOptions,
  paUserId,              // optional param (may be undefined)
  page = 0,
  pageSize = 8,
  context = 'expense_jobpick',
  confirmDraft = null
}) {
  // ✅ Canonical PA key used everywhere in this function
  const paKey =
    normalizeIdentityDigits(paUserId) ||
    normalizeIdentityDigits(userProfile?.wa_id) ||
    normalizeIdentityDigits(from) ||
    String(from || '').trim();

  const to = waTo(from);
  const p = Math.max(0, Number(page) || 0);
  const ps = Math.min(8, Math.max(1, Number(pageSize) || 8));

  // deterministic, job_no-first clean list
  const seen = new Set();
  const clean = [];
  

  for (const j of jobOptions || []) {
    const jobNo = j?.job_no != null ? Number(j.job_no) : null;
    if (jobNo == null || !Number.isFinite(jobNo)) continue;

    const name = sanitizeJobLabel(j?.name || j?.job_name || '');
    if (!name || isGarbageJobName(name)) continue;

    if (seen.has(jobNo)) continue;
    seen.add(jobNo);

    const rawId = j?.id != null ? String(j.id) : j?.job_id != null ? String(j.job_id) : null;
    const safeUuidId = rawId && looksLikeUuid(rawId) ? rawId : null;

    clean.push({ id: safeUuidId, job_no: jobNo, name });
  }
// ✅ Put debug HERE (after clean is built)
console.info('[JOB_PICK_CLEAN]', {
  total: clean.length,
  jobNos: clean.map(x => x.job_no).slice(0, 40)
});
  clean.sort((a, b) => Number(a.job_no) - Number(b.job_no));

  const start = p * ps;
  const slice = clean.slice(start, start + ps);
  const displayedJobNos = slice.map((j) => Number(j.job_no)).filter(Number.isFinite);
  const hasMore = start + ps < clean.length;

  const displayedHash = sha8(displayedJobNos.join(','));
  const pickerNonce = makePickerNonce();
  const flow = sha8(String(confirmFlowId || `${ownerId}:${from}:${Date.now()}`));

  const sentRows = slice.map((j, idx) => {
  const jobNo = Number(j.job_no);
  const name = sanitizeJobLabel(j.name);

  // ✅ CRITICAL: embed REAL jobNo as the first token in the visible label
  const title = `${jobNo} ${name}`.slice(0, 24);

  return { ix: idx + 1, jobNo, name, title };
});


  // ✅ store minimal confirmDraft snapshot for E5 recovery
  const confirmDraftSnap = pickConfirmDraftSnapshot(confirmDraft);

  await upsertPA({
    ownerId,
    userId: paKey,
    kind: PA_KIND_PICK_JOB,
    payload: {
      context,
      flow,
      confirmFlowId,
      pickerNonce,
      page: p,
      pageSize: ps,
      displayedJobNos,
      displayedHash,
      sentAt: Date.now(),
      sentRows,

      // ✅ REQUIRED for handler path
      jobOptions: clean,
      hasMore,

      // ✅ E5 recovery source
      confirmDraft: confirmDraftSnap
    },
    ttlSeconds: PA_TTL_SEC
  });

  // Text fallback
  if (!ENABLE_INTERACTIVE_LIST || !to) {
    return out(twimlText(buildTextJobPrompt(clean, p, ps)), false);
  }

  const secret = process.env.JOB_PICKER_HMAC_SECRET || 'dev-secret-change-me';
  const rows = slice.map((j) => {
  const jobNo = Number(j.job_no);
  const name = sanitizeJobLabel(j.name);

  return {
    id: makeRowId({ flow, nonce: pickerNonce, jobNo, secret }), // jp:...
    title: `${jobNo} ${name}`.slice(0, 24),                     // ✅ embed jobNo
    description: `Job #${jobNo} — ${name}`.slice(0, 72)         // optional, but helps visibility
  };
});


  const bodyText = context === 'expense_jobpick'
    ? 'Which job is this expense for?'
    : 'Which job is this expense for?';

  const sections = [{ title: 'Jobs', rows }];

  console.info('[JOB_PICK_SEND]', {
    context,
    flow,
    pickerNonce,
    page: p,
    displayedHash,
    displayedJobNos,
    rows: rows.slice(0, 8).map((r) => ({ id: r.id, title: r.title })),
    sentRows: sentRows.slice(0, 8)
  });

  return await sendWhatsAppInteractiveList({
    to,
    bodyText,
    buttonText: 'Pick job',
    sections
  });
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
    tenant_id: String(ownerId),
    source: 'whatsapp',
    source_msg_id: String(sourceMsgId),
    actor: { actor_id: String(userProfile?.user_id || from || 'unknown'), role: 'owner' },
    occurred_at: new Date().toISOString(),
    job: jobName ? { job_name: String(jobName) } : null,
    needs_job_resolution: !jobName,
    total_cents: cents,
    currency: 'CAD',
    vendor: data.store && data.store !== 'Unknown Store' ? String(data.store) : undefined,
    memo: data.item && data.item !== 'Unknown' ? String(data.item) : undefined,
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
    return { ok: false, reply: `⚠️ Couldn't log that expense yet. Try: "expense $84.12 nails from Home Depot".` };
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

  // ✅ Store: use extractReceiptStore instead of substring window heuristics
  const store = extractReceiptStore(t);

  // ✅ Date: support MM/DD/YYYY and also ISO
  let dateIso = null;
  const mdY = t.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (mdY) {
    const mm = mdY[1], dd = mdY[2], yyyy = mdY[3];
    dateIso = `${yyyy}-${mm}-${dd}`;
  } else {
    const ymd = t.match(/\b(\d{4})\s*-\s*(\d{2})\s*-\s*(\d{2})\b/);
if (ymd) dateIso = `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  }

  // ✅ Total: prefer explicit "Total"
  let total = null;
  const totalLine =
    t.match(/\btotal\b[^0-9]{0,20}(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b/i) ||
    t.match(/\bdebit\b[^0-9]{0,20}(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b/i) ||
    t.match(/\binterac\b[^0-9]{0,20}(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b/i) ||
    null;

  if (totalLine?.[1]) {
    total = Number(String(totalLine[1]).replace(/,/g, ''));
    if (!Number.isFinite(total)) total = null;
  }

  // ✅ Currency (optional): CAD, USD, etc
  let currency = null;

  // Accept common variants: "CAD", "C$", "$CAD", "USD", "$USD"
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

  // If we found nothing useful, return null
  if (!total && !dateIso && !store && !currency) return null;

  return { total, dateIso, store, currency };
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
  const s = String(input || '');
  let m = s.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/);
  if (m?.[1]) return m[1];
  m = s.match(/\b([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)\b/);
  if (m?.[1]) return m[1];
  m = s.match(/\b([0-9]{4,}(?:\.[0-9]{1,2})?)\b/);
  if (m?.[1]) return m[1];
  m = s.match(/\b([0-9]{1,3}\.[0-9]{1,2})\b/);
  if (m?.[1]) return m[1];
  return null;
}

function moneyToFixed(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;
  const normalized = cleaned.replace(/,/g, '');
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  return formatMoneyDisplay(n);
}

function isIsoDateToken(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

function deterministicExpenseParse(input, userProfile) {
  const raw0 = String(input || '').trim();
  if (!raw0) return null;

  // ✅ Normalize fancy dashes so "$883 — Railing" behaves like "$883 - Railing"
  const raw = normalizeDashes(raw0);

  const token = extractMoneyToken(raw);
  if (!token) return null;

  const amount = moneyToFixed(token);
  if (!amount) return null;

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
// Let downstream confirmation / OCR-safe extractors fill date, or keep it null.
const looksReceipt =
  /\b(receipt|subtotal|hst|gst|pst|tax|total|debit|visa|mastercard|amex|approved|auth|terminal)\b/i.test(raw);

if (!date) {
  date = looksReceipt ? null : todayInTimeZone(tz);
}


  let jobName = null;
  const forJob = raw.match(/\bfor\s+(?:job\s+)?(.+?)(?:[.?!]|$)/i);
  if (forJob?.[1]) {
    const cand = String(forJob[1]).trim();
    if (cand && !isIsoDateToken(cand)) jobName = sanitizeJobNameCandidate(cand);
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

  // 2) ✅ NEW: "purchased $883 in railing at Rona"
  if (!item) {
    const inItem = raw.match(
      /\b(?:spent|spend|paid|pay|purchased|purchase|bought|buy|ordered|order|got)\b.*?\$\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?\s+\bin\s+(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\bfor\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
    );
    if (inItem?.[1]) item = String(inItem[1]).trim();
  }

  // 3) ✅ UPGRADED: "$883 - Railing at Rona" (after normalizeDashes)
  if (!item) {
    const dashItem = raw.match(
      /\$\s*[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?\s*-\s*(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\bfor\b|[.?!]|$)/i
    );
    if (dashItem?.[1]) item = String(dashItem[1]).trim();
  }

  // 4) Keep your "for <item> at/from <store>" rule (but don’t allow "for job ...")
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
function getInboundText(input, twilioMeta) {
  const direct = String(input ?? '').trim();

  const meta = twilioMeta || {};
  const resolved =
    meta.ResolvedInboundText ??
    meta.resolvedInboundText ??
    meta.Body ??
    meta.body ??
    '';

  const btn =
    meta.ButtonPayload ??
    meta.buttonPayload ??
    meta.ButtonText ??
    meta.buttonText ??
    '';

  // Prefer explicit resolved text if present, else fall back to input, else button text
  const out = String(resolved || direct || btn || '').trim();
  return out;
}

function isEditIntent(input, twilioMeta) {
  const meta = twilioMeta || {};
  const t = normLower(getInboundText(input, twilioMeta));
  const bp = normLower(meta.ButtonPayload || meta.buttonPayload);
  return t === 'edit' || bp === 'edit';
}

function isYesIntent(input, twilioMeta) {
  const meta = twilioMeta || {};
  const t = normLower(getInboundText(input, twilioMeta));
  const bp = normLower(meta.ButtonPayload || meta.buttonPayload);
  return t === 'yes' || t === 'y' || bp === 'yes';
}

function isCancelIntent(input, twilioMeta) {
  const meta = twilioMeta || {};
  const t = normLower(getInboundText(input, twilioMeta));
  const bp = normLower(meta.ButtonPayload || meta.buttonPayload);
  return t === 'cancel' || t === 'stop' || bp === 'cancel';
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
    t === 'skip' ||
    t === 'change job' ||
    t.startsWith('job ') || // text fallback like "job 1"
    t.startsWith('job_')    // list tokens like job_1_xxx
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
  const amt = draft?.amount || 'Unknown';
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

// Parse edit payload and merge into existing draft WITHOUT losing receipt/media linkage.
// ✅ Rule: Only overwrite fields the user explicitly intended to change.
async function applyEditPayloadToConfirmDraft(editText, existingDraft, ctx) {
  const { handleInputWithAI, parseExpenseMessage } = require('../../utils/aiErrorHandler');

  const tz = ctx?.tz || 'America/Toronto';
  const raw = String(editText || '').trim();
  const lc = raw.toLowerCase();

  // --------- helpers ---------
  const isUnknownish = (s) => {
    const x = String(s || '').trim().toLowerCase();
    return !x || x === 'unknown' || x.startsWith('unknown ');
  };

  const hasMoney = (s) => /\$?\s*-?\d{1,3}(?:,\d{3})*(?:\.\d{2})\b/.test(String(s || ''));
  const hasDateToken = (s) =>
    /\b(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{4}[\/.]\d{2}[\/.]\d{2})\b/.test(String(s || '')) ||
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(String(s || '')) ||
    /\b(today|yesterday|tomorrow)\b/i.test(String(s || ''));

  const explicit = {
    amount:
      /\b(amount|total|price|cost)\b/i.test(raw) || hasMoney(raw),
    date:
      /\b(date|day|on\s)\b/i.test(raw) || hasDateToken(raw),
    store:
      /\b(store|vendor|merchant|from|at)\b/i.test(raw),
    item:
      /\b(item|for|bought|purchase|description|desc)\b/i.test(raw),
    category:
      /\b(category|categorize|type)\b/i.test(raw),
    job:
      /\b(job|for job|change job|overhead)\b/i.test(raw)
  };

  // IMPORTANT: Do not strip to "" before parsing — pass the user's actual message.
  const aiRes = await handleInputWithAI(
    ctx?.fromKey,
    raw,
    'expense',
    parseExpenseMessage,
    ctx?.defaultData || {},
    { tz }
  );

  // If not confirmed, return null so caller can show aiRes.reply
  if (!aiRes || !aiRes.confirmed || !aiRes.data) {
    return { nextDraft: null, aiReply: aiRes?.reply || null };
  }

  const data = aiRes.data || {};
  const out = { ...(existingDraft || {}) };

  // ---------- preserve receipt/media linkage ALWAYS ----------
  out.media_asset_id =
    existingDraft?.media_asset_id || existingDraft?.mediaAssetId || data?.media_asset_id || data?.mediaAssetId || null;

  out.media_source_msg_id =
    existingDraft?.media_source_msg_id || existingDraft?.mediaSourceMsgId || data?.media_source_msg_id || data?.mediaSourceMsgId || null;

  out.source_msg_id =
    existingDraft?.source_msg_id || existingDraft?.sourceMsgId || data?.source_msg_id || data?.sourceMsgId || null;

  // Preserve receipt text fields so later normalize/backstop can keep working
  out.receiptText = existingDraft?.receiptText || existingDraft?.ocrText || existingDraft?.extractedText || out.receiptText || null;
  out.ocrText = existingDraft?.ocrText || out.ocrText || null;
  out.extractedText = existingDraft?.extractedText || out.extractedText || null;

  // ---------- guarded merges (only if explicitly changed) ----------
  if (explicit.amount) {
    // Avoid overwriting with "$0.00" or nonsense
    if (data.amount != null && !String(data.amount).includes('$0.00')) out.amount = data.amount;
  }

  if (explicit.date) {
    if (data.date && String(data.date).trim()) out.date = data.date;
  }

  if (explicit.store) {
    if (data.store && !isUnknownish(data.store)) out.store = data.store;
  }

  if (explicit.item) {
    if (data.item && !isUnknownish(data.item)) out.item = data.item;
    if (data.description && !isUnknownish(data.description)) out.description = data.description;
  }

  if (explicit.category) {
    if (data.category && !isUnknownish(data.category)) out.category = data.category;
    if (data.suggestedCategory && !isUnknownish(data.suggestedCategory)) out.suggestedCategory = data.suggestedCategory;
  }

  if (explicit.job) {
    // Keep your canonical fields
    if (data.jobName && !isUnknownish(data.jobName)) out.jobName = data.jobName;
    if (data.job_name && !isUnknownish(data.job_name)) out.job_name = data.job_name;

    // If parseExpenseMessage returns jobSource/job_no, keep them
    if (data.jobSource && String(data.jobSource).trim()) out.jobSource = data.jobSource;
    if (data.job_no != null) out.job_no = data.job_no;
  }

  // ---------- ensure we never accidentally null out strong values ----------
  // (AI sometimes sends blanks; we only set when non-empty above, so this is mostly redundant,
  // but it protects against weird schema outputs.)
  if (out.store && isUnknownish(out.store) && existingDraft?.store && !isUnknownish(existingDraft.store)) {
    out.store = existingDraft.store;
  }
  if (out.amount === '$0.00' && existingDraft?.amount && existingDraft.amount !== '$0.00') {
    out.amount = existingDraft.amount;
  }

  return { nextDraft: out, aiReply: null };
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
    twilioMeta?.[k] ??
    twilioMeta?.[String(k).toLowerCase()] ??
    twilioMeta?.[String(k).toUpperCase()] ??
    null;

  // Build inboundTwilioMeta first (defensive)
  const inboundTwilioMeta = {
    MessageSid: getTwilio('MessageSid'),
    OriginalRepliedMessageSid: getTwilio('OriginalRepliedMessageSid'),
    Body: getTwilio('Body'),
    ListId: getTwilio('ListId'),
    ListTitle: getTwilio('ListTitle'),
    ButtonPayload: getTwilio('ButtonPayload'),
    ButtonText: getTwilio('ButtonText'),
    WaId: getTwilio('WaId') || getTwilio('WaID') || getTwilio('waid')
  };

  // ✅ Canonical PA key (digits only)
  const paUserId =
    normalizeIdentityDigits(inboundTwilioMeta?.WaId) ||
    normalizeIdentityDigits(from) ||
    String(from || '').trim();

  // ✅ IMPORTANT: capture raw inbound text BEFORE modifying input.
  // This must see resolved text / button payload / body.
  const rawInboundText = getInboundText(input, twilioMeta);
  const inboundLower = normLower(rawInboundText);

  // Stable id for idempotency; prefer inbound MessageSid. Always fall back to something deterministic.
  const stableMsgId =
    String(sourceMsgId || '').trim() ||
    String(inboundTwilioMeta?.MessageSid || '').trim() ||
    String(userProfile?.last_message_sid || '').trim() ||
    String(`${from}:${Date.now()}`).trim();

  const safeMsgId = stableMsgId;
  const fromRaw = from;

  // ✅ If any helper still keys PAs by `from`, normalize `from` now:
  from = paUserId;
  console.info('[PA_KEY]', { from, waId: inboundTwilioMeta?.WaId, paUserId });

  // --------------------------------------------------------------------
// EARLY: EDIT state machine (must run BEFORE any parsing)
// --------------------------------------------------------------------
let pendingTxState = null;
try {
  pendingTxState = await getPendingTransactionState(paUserId);
} catch {
  pendingTxState = null; // fail-open
}

const inEditMode =
  !!(pendingTxState &&
     pendingTxState.kind === 'expense' &&
     (pendingTxState.edit_mode || pendingTxState.confirmDraft?.awaiting_edit));

const editIntent = isEditIntent(rawInboundText, twilioMeta);

// (1) User pressed Edit button / typed "edit" -> enter edit mode and prompt for corrected details
if (editIntent && !inEditMode) {
  try {
    const existingDraft = pendingTxState?.confirmDraft || pendingTxState?.draft || {};
    await mergePendingTransactionState(paUserId, {
      kind: 'expense',
      edit_mode: true,
      edit_started_at: Date.now(),
      confirmDraft: { ...existingDraft, awaiting_edit: true }
    });
  } catch {}

  const msg = [
    '✏️ Okay — send the corrected expense details in ONE message.',
    'Example:',
    'expense $14.21 spray foam insulation from Home Hardware on Sept 27 2025',
    'Reply "cancel" to discard.'
  ].join('\n');

  if (typeof twimlText === 'function') return twimlText(msg);
  return msg;
}

// (2) If we are in edit mode, treat next free-text as the edit payload (NOT as a new expense)
if (inEditMode) {
  // Allow control words to behave normally
  if (isCancelIntent(rawInboundText, twilioMeta) || isSkipIntent(rawInboundText, twilioMeta) || editIntent) {
    if (editIntent) {
      const msg = [
        '✏️ Send the corrected expense details in ONE message.',
        'Example: expense $14.21 spray foam insulation from Home Hardware on Sept 27 2025'
      ].join('\n');
      if (typeof twimlText === 'function') return twimlText(msg);
      return msg;
    }

    // Cancel -> exit edit mode (downstream cancel logic may also run later)
    if (isCancelIntent(rawInboundText, twilioMeta)) {
      try {
        await mergePendingTransactionState(paUserId, {
          kind: 'expense',
          edit_mode: false,
          edit_started_at: null,
          confirmDraft: { ...(pendingTxState?.confirmDraft || {}), awaiting_edit: false }
        });
      } catch {}
      // fall through to your existing cancel handling if any
    }

    // Skip -> exit edit mode but keep draft pending
    if (isSkipIntent(rawInboundText, twilioMeta)) {
      try {
        await mergePendingTransactionState(paUserId, {
          kind: 'expense',
          edit_mode: false,
          edit_started_at: null,
          confirmDraft: { ...(pendingTxState?.confirmDraft || {}), awaiting_edit: false }
        });
      } catch {}
      const msg = 'Okay — leaving that expense pending. What do you want to do next?';
      if (typeof twimlText === 'function') return twimlText(msg);
      return msg;
    }
  }

  // Consume this message as the edit payload
  const existingDraft = pendingTxState?.confirmDraft || pendingTxState?.draft || {};

  const { nextDraft, aiReply } = await applyEditPayloadToConfirmDraft(rawInboundText, existingDraft, {
    fromKey: paUserId,
    tz: userProfile?.timezone || userProfile?.tz || ownerProfile?.tz || 'America/Toronto',
    defaultData: {} // keep empty; your draft already carries job/media context
  });

  if (!nextDraft) {
    const msg = aiReply || 'I couldn’t understand that edit. Please resend with amount + date.';
    if (typeof twimlText === 'function') return twimlText(msg);
    return msg;
  }

  // Persist updated draft and exit edit mode (stateManager)
  try {
    await mergePendingTransactionState(paUserId, {
      kind: 'expense',
      edit_mode: false,
      edit_started_at: null,
      confirmDraft: { ...nextDraft, awaiting_edit: false }
    });
  } catch {}

  // ✅ ALSO persist into pending-actions confirm draft so YES submits the edited data
  try {
    const confirmPA0 = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
    if (confirmPA0?.payload?.draft) {
      await upsertPA({
        ownerId,
        userId: paUserId,
        kind: PA_KIND_CONFIRM,
        payload: {
          ...(confirmPA0.payload || {}),
          draft: { ...(confirmPA0.payload.draft || {}), ...nextDraft, awaiting_edit: false }
        },
        ttlSeconds: PA_TTL_SEC
      });

      // optional: refresh local confirmPA if later code uses it
      // confirmPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
    }
  } catch {}

  // Re-confirm using fail-open plain text (no templates required)
  const confirmMsg = formatExpenseConfirmText(nextDraft);
  if (typeof twimlText === 'function') return twimlText(confirmMsg);
  return confirmMsg;
}

// ---- from here on, continue with your existing handler logic ----
// Now it is safe to normalize the input for "new expense" parsing.
input = correctTradeTerms(stripExpensePrefixes(rawInboundText));


// ---- media linkage (function-scope) ----
// Allows deterministic/AI confirm drafts to carry media_asset_id into YES.
let flowMediaAssetId = null;
try {
  // NOTE: by this point you already normalized `from = paUserId`
  const pending = await getPendingTransactionState(from); // ✅ canonical key
  flowMediaAssetId =
    (pending?.pendingMediaMeta?.media_asset_id ||
      pending?.pendingMediaMeta?.mediaAssetId ||
      null) || null;
} catch {}
// Optional high-signal debug (after reparse attempt)
  try {
    const c = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
    console.info('[CONFIRM_DRAFT_AFTER_REPARSE]', {
      paUserId,
      needsReparse: !!c?.payload?.draft?.needsReparse,
      amount: c?.payload?.draft?.amount || null,
      date: c?.payload?.draft?.date || null,
      store: c?.payload?.draft?.store || null
    });
  } catch {}
// ✅ tz needed for reparse (safe default)
const tz = userProfile?.timezone || userProfile?.tz || 'America/Toronto';

// ✅ Only attempt reparse if confirm draft exists and is marked dirty
try {
  const c0 = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }).catch(() => null);
  const needs = !!c0?.payload?.draft?.needsReparse;

  if (needs) {
    // 1) Run your existing reparse pipeline (may or may not fill fields)
    try {
      await maybeReparseConfirmDraftExpense({ ownerId, paUserId, tz, userProfile });
    } catch (e) {
      console.warn('[EXPENSE] maybeReparseConfirmDraftExpense failed (ignored):', e?.message);
    }

    // 2) Backstop merge using the *latest* PA draft (never overwrite with null)
    const c1 = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }).catch(() => null);
    const draft1 = c1?.payload?.draft || {};

    // ✅ Receipt/OCR text to backstop parse from (prefer stored receipt text first)
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

    // ✅ Default currency (prefer explicit user currency, then owner currency, then locale hint, else CAD)
    const defaultCurrency =
      String(userProfile?.currency || '').trim().toUpperCase() ||
      String(ownerProfile?.currency || '').trim().toUpperCase() ||
      (/us/i.test(String(ownerProfile?.locale || '')) ? 'USD' : '') ||
      (/ca/i.test(String(ownerProfile?.locale || '')) ? 'CAD' : '') ||
      'CAD';

    const patch = back
      ? {
          store: back.store || null,
          date: back.dateIso || null,
          amount: back.total != null ? String(Number(back.total).toFixed(2)) : null,
          currency: back.currency || draft1?.currency || defaultCurrency
        }
      : {
          currency: draft1?.currency || defaultCurrency
        };

    const mergedDraft = mergeDraftNonNull(draft1, patch);

    const gotAmount = !!String(mergedDraft.amount || '').trim();
    const gotDate = !!String(mergedDraft.date || '').trim();
    const needsReparseNext = !(gotAmount && gotDate);

    await upsertPA({
      ownerId,
      userId: paUserId,
      kind: PA_KIND_CONFIRM,
      payload: {
        ...(c1?.payload || {}),
        draft: {
          ...mergedDraft,
          needsReparse: needsReparseNext
        }
      },
      ttlSeconds: PA_TTL_SEC
    });
  }

  // Optional high-signal debug (after reparse attempt)
  try {
    const c = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }).catch(() => null);
    console.info('[CONFIRM_DRAFT_AFTER_REPARSE]', {
      paUserId,
      needsReparse: !!c?.payload?.draft?.needsReparse,
      amount: c?.payload?.draft?.amount || null,
      date: c?.payload?.draft?.date || null,
      store: c?.payload?.draft?.store || null,
      currency: c?.payload?.draft?.currency || null
    });
  } catch {}
} catch (e) {
  console.warn('[EXPENSE] confirm reparse precheck failed (ignored):', e?.message);
}


async function resolveMediaAssetIdForFlow({ ownerId, userKey, rawDraft, flowMediaAssetId }) {
  // 1) Draft direct
  let id =
    (rawDraft?.media_asset_id || rawDraft?.mediaAssetId || null) ||
    (rawDraft?.pendingMediaMeta?.media_asset_id || rawDraft?.pendingMediaMeta?.mediaAssetId || null) ||
    null;

  if (id) return id;

  // 2) Function-scope fallback
  if (flowMediaAssetId) return flowMediaAssetId;

  // Helper: normalize a source msg id into the DB format "<userKey>:<sid>"
  const asDbSource = (sid) => {
    const s = String(sid || '').trim();
    if (!s) return null;
    // already looks like "userKey:SID"
    if (s.includes(':')) return s;
    return `${String(userKey || '').trim()}:${s}`;
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
    pending = await getPendingTransactionState(userKey);
  } catch {}

  id =
    (pending?.pendingMediaMeta?.media_asset_id || pending?.pendingMediaMeta?.mediaAssetId || null) ||
    null;

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


// ✅ Resolve media link early so confirm draft always carries it.
// This prevents job pick / change job / other merges from “losing” the link.
let resolvedFlowMediaAssetId = null;
try {
  const inferredSrc = String(sourceMsgId || '').trim()
    ? `${String(paUserId || '').trim()}:${String(sourceMsgId).trim()}`
    : null;

  resolvedFlowMediaAssetId = await resolveMediaAssetIdForFlow({
    ownerId,
    userKey: paUserId, // ✅ canonical
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


  // ✅ Local helper: reject + resend picker with ZERO reliance on outer scope vars
  async function rejectAndResendPicker({
    from,
    ownerId,
    userProfile,
    confirmFlowId,
    jobOptions,
    confirmDraft,
    reason,
    twilioMeta
  }) {
    console.warn('[JOB_PICK_REJECT]', {
      reason,
      from,
      ownerId,
      inboundBody: twilioMeta?.Body,
      inboundListId: twilioMeta?.ListId,
      inboundListTitle: twilioMeta?.ListTitle,
      repliedMsgSid: twilioMeta?.OriginalRepliedMessageSid,
      msgSid: twilioMeta?.MessageSid
    });

    const safeJobOptions = Array.isArray(jobOptions) ? jobOptions : [];

    // Send a fresh picker first (so the next tap has the newest state)
    await sendJobPickList({
      from,
      ownerId,
      userProfile,
      confirmFlowId:
        String(confirmFlowId || '').trim() ||
        stableMsgId ||
        `${normalizeIdentityDigits(from) || from}:${Date.now()}`,
      jobOptions: safeJobOptions,
      page: 0,
      pageSize: 8,
      context: 'expense_jobpick',
      confirmDraft: confirmDraft || null
    });

    return out(
      twimlText('That menu looks old — I just sent a fresh job list. Please pick again.'),
      false
    );
  }

  try {
    const lock = require('../../middleware/lock');
    if (lock?.acquireLock) await lock.acquireLock(lockKey, 8000).catch(() => null);
  } catch {}

  try {
    const tz = userProfile?.timezone || userProfile?.tz || 'UTC';

    /* ---- 1) Awaiting job pick ---- */
const pickPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB });

if (
  pickPA?.payload &&
  Array.isArray(pickPA.payload.jobOptions) &&
  pickPA.payload.jobOptions.length
) {
  // ✅ IMPORTANT: token should be computed from rawInboundText (not normalized input)
  const tok = normalizeDecisionToken(rawInboundText);
  const rawInput = String(input || '').trim();

  // ✅ use stored picker state ONLY (single source of truth)
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

  const effectiveConfirmFlowId =
    confirmFlowId || stableMsgId || `${normalizeIdentityDigits(from) || from}:${Date.now()}`;

  // ✅ Resume works even while we’re in the picker flow
if (tok === 'resume') {
  const confirmPA0 = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM }).catch(() => null);
  const draft0 = confirmPA0?.payload?.draft || null;

  if (draft0 && Object.keys(draft0).length) {
    try {
      return await resendConfirmExpense({ from, ownerId, tz, paUserId, userProfile });
    } catch (e) {
      console.warn('[EXPENSE] resume during pick failed; fallback to text:', e?.message);
      return out(twimlText(formatExpenseConfirmText(draft0)), false);
    }
  }

  return out(twimlText('I couldn’t find anything pending. What do you want to do next?'), false);
}


  // If user sent a brand new expense while waiting for job pick, clear state and continue parsing.
  if (looksLikeNewExpenseText(input)) {
    console.info('[EXPENSE] pick-job bypass: new expense detected, clearing PAs');
    try {
      await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB });
    } catch {}
    try {
      await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
    } catch {}
  } else {
    // Stale picker protection → resend page 0
    if (!sentAt || Date.now() - sentAt > PA_TTL_SEC * 1000) {
      return await sendJobPickList({
        from,
        ownerId,
        userProfile,
        confirmFlowId: effectiveConfirmFlowId,
        jobOptions,
        page: 0,
        pageSize: 8,
        context: 'expense_jobpick',
        confirmDraft
      });
    }

    // Observability
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
      displayedJobNos: (pickPA.payload.displayedJobNos || []).slice(0, 8),
      inbound: {
        MessageSid: inboundTwilioMeta?.MessageSid || null,
        OriginalRepliedMessageSid: inboundTwilioMeta?.OriginalRepliedMessageSid || null,
        ListId: inboundTwilioMeta?.ListId || null,
        ListTitle: inboundTwilioMeta?.ListTitle || null
      }
    });

    // Optional: remember last inbound picker token (safe, no schema change)
    try {
      await upsertPA({
        ownerId,
        userId: paUserId,
        kind: PA_KIND_PICK_JOB,
        payload: { ...(pickPA.payload || {}), lastInboundTextRaw: input, lastInboundText: rawInput },
        ttlSeconds: PA_TTL_SEC
      });
    } catch {}

    // Helper: detect picker-ish answers
    const looksLikePickerTap =
      /^jp:[0-9a-f]{8}:/i.test(rawInput) ||
      /^job_\d{1,10}_[0-9a-z]+$/i.test(rawInput) ||
      !!inboundTwilioMeta?.ListTitle ||
      !!inboundTwilioMeta?.ListId;

// inside pickPA branch, after `tok` computed:
if (tok === 'resume') {
  const confirmPA0 = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
  if (confirmPA0?.payload?.draft) {
    try {
      return await resendConfirmExpense({ from, ownerId, tz, paUserId, userProfile });

    } catch {}
    return out(twimlText(formatExpenseConfirmText(confirmPA0.payload.draft)), false);
  }
  return out(twimlText('No pending expense to resume.'), false);
}

        // "change job" while already picking -> resend page 0
        if (tok === 'change_job') {
          // ✅ Mark confirm draft dirty so we re-parse receipt fields after job changes
try {
  const confirmPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
  if (confirmPA?.payload?.draft) {
    await upsertPA({
      ownerId,
      userId: paUserId,
      kind: PA_KIND_CONFIRM,
      payload: {
        ...(confirmPA.payload || {}),
        draft: {
          ...(confirmPA.payload.draft || {}),
          needsReparse: true
        }
      },
      ttlSeconds: PA_TTL_SEC
    });
  }
} catch (e) {
  console.warn('[EXPENSE] change_job needsReparse set failed (ignored):', e?.message);
}

          return await sendJobPickList({
            from,
            ownerId,
            userProfile,
            confirmFlowId: effectiveConfirmFlowId,
            jobOptions,
            page: 0,
            pageSize: 8,
            context: 'expense_jobpick',
            confirmDraft
          });
        }

        // more → next page ✅
        if (tok === 'more') {
          if (!hasMore) {
            return out(
              twimlText('No more jobs to show. Reply with a number, job name, or "Overhead".'),
              false
            );
          }

          return await sendJobPickList({
            from,
            ownerId,
            userProfile,
            confirmFlowId: effectiveConfirmFlowId,
            jobOptions,
            page: page + 1,
            pageSize,
            context: 'expense_jobpick',
            confirmDraft
          });
        }

        // ✅ HARD GUARD: if confirm PA is missing but we got a picker reply, re-bootstrap from pickPA.confirmDraft
        let confirmPAForGuard = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });

        if (!confirmPAForGuard?.payload?.draft && (looksLikePickerTap || looksLikeJobPickerAnswer(rawInput))) {
          if (confirmDraft) {
            await ensureConfirmPAExists({ ownerId, from, draft: confirmDraft, sourceMsgId: stableMsgId });
            confirmPAForGuard = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
          } else {
            // Can't reconstruct → resend picker
            return await sendJobPickList({
              from,
              ownerId,
              userProfile,
              confirmFlowId: effectiveConfirmFlowId,
              jobOptions,
              page: 0,
              pageSize: 8,
              context: 'expense_jobpick',
              confirmDraft: null
            });
          }
        }

// ----------------------------
// 1) PICKER-TAP PATH (Twilio interactive replies)
// ----------------------------
if (looksLikePickerTap) {
  const pickJobOptions = Array.isArray(pickPA?.payload?.jobOptions) ? pickPA.payload.jobOptions : [];

  const sel = await resolveJobPickSelection({
    ownerId,
    from,
    input: rawInput, // ✅ use the same token you got from inbound resolver
    twilioMeta: inboundTwilioMeta,
    pickState: {
      flow,
      pickerNonce,
      displayedHash,
      displayedJobNos: Array.isArray(pickPA?.payload?.displayedJobNos) ? pickPA.payload.displayedJobNos : [],
      sentRows: Array.isArray(pickPA?.payload?.sentRows) ? pickPA.payload.sentRows : []
    }
  });

  // ✅ High-signal debug: which selection path resolved?
  console.info('[JOB_PICK_SELECTION]', {
    ok: !!sel?.ok,
    reason: sel?.reason || null,
    jobNo: sel?.jobNo || null,
    mode: sel?.meta?.mode || null,
    inboundBody: String(inboundTwilioMeta?.Body || '').slice(0, 40),
    inboundListTitle: String(inboundTwilioMeta?.ListTitle || '').slice(0, 60),
    inboundListId: String(inboundTwilioMeta?.ListId || '').slice(0, 60)
  });

  if (!sel.ok) {
    return await rejectAndResendPicker({
      from,
      ownerId,
      userProfile,
      confirmFlowId: effectiveConfirmFlowId,
      // ✅ resend the same universe of jobs that the picker state represents
      jobOptions: pickJobOptions.length ? pickJobOptions : jobOptions,
      confirmDraft,
      reason: sel.reason,
      twilioMeta: inboundTwilioMeta
    });
  }

  const chosenJobNo = Number(sel.jobNo);
  const chosen =
    pickJobOptions.find((j) => Number(j?.job_no ?? j?.jobNo) === Number(chosenJobNo)) || null;

  if (!chosen) {
    return await rejectAndResendPicker({
      from,
      ownerId,
      userProfile,
      confirmFlowId: effectiveConfirmFlowId,
      jobOptions: pickJobOptions.length ? pickJobOptions : jobOptions,
      confirmDraft,
      reason: 'job_not_found_in_pick_state',
      twilioMeta: inboundTwilioMeta
    });
  }

  // ✅ Ensure confirm draft exists (rebuild from pickPA.confirmDraft if needed)
  let confirmPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });

  if (!confirmPA?.payload?.draft) {
    const fallbackDraft = pickPA?.payload?.confirmDraft || null;
    if (fallbackDraft) {
      await upsertPA({
        ownerId,
        userId: paUserId,
        kind: PA_KIND_CONFIRM,
        payload: {
          draft: fallbackDraft,
          // ✅ IMPORTANT: keep the confirm flow id stable
          sourceMsgId: effectiveConfirmFlowId || null,
          type: 'expense'
        },
        ttlSeconds: PA_TTL_SEC
      });

      confirmPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
    }
  }

    // inside: if (confirmPA?.payload?.draft) { ... }
  const token = normalizeDecisionToken(rawInput); // ✅ use rawInput here

  // (Optional) you can allow "cancel/edit/yes/change_job" even if it came from a picker-ish inbound,
  // but DO NOT try to handle "resume" here. Resume belongs in the confirm block.
  // If user somehow sends a control word while picker state exists, just let the main confirm flow handle it.
  if (token === 'yes' || token === 'edit' || token === 'cancel' || token === 'change_job' || token === 'skip' || token === 'resume') {
    // fall through: do NOT treat it as a job pick
    // (returning nothing here will continue into your normal confirm block logic below)
  } else {
    // ✅ persist active job (best-effort)
    const userKey =
      String(paUserId || '').trim() ||
      String(userProfile?.wa_id || '').trim() ||
      String(from || '').trim();

    try {
      await persistActiveJobBestEffort({
        ownerId,
        userProfile,
        fromPhone: userKey,
        jobRow: chosen,
        jobNameFallback: chosen?.name
      });
    } catch {}

    // ✅ Patch confirm draft with the chosen job
    if (confirmPA?.payload?.draft) {
      try {
        await upsertPA({
          ownerId,
          userId: paUserId,
          kind: PA_KIND_CONFIRM,
          payload: {
            ...(confirmPA.payload || {}),
            draft: {
              ...(confirmPA.payload?.draft || {}),
              jobName: getJobDisplayName(chosen),
              jobSource: 'picked',
              job_no: Number(chosen.job_no ?? chosen.jobNo),
              job_id: chosen?.id || chosen?.job_id || null
            }
          },
          ttlSeconds: PA_TTL_SEC
        });
      } catch (e) {
        console.warn('[EXPENSE] confirm patch after job pick failed:', e?.message);
        return await rejectAndResendPicker({
          from,
          ownerId,
          userProfile,
          confirmFlowId: effectiveConfirmFlowId,
          jobOptions: pickJobOptions.length ? pickJobOptions : jobOptions,
          confirmDraft,
          reason: 'confirm_patch_failed_after_pick',
          twilioMeta: inboundTwilioMeta
        });
      }
    } else {
      return await rejectAndResendPicker({
        from,
        ownerId,
        userProfile,
        confirmFlowId: effectiveConfirmFlowId,
        jobOptions: pickJobOptions.length ? pickJobOptions : jobOptions,
        confirmDraft,
        reason: 'missing_confirm_after_pick',
        twilioMeta: inboundTwilioMeta
      });
    }

    // ✅ Clear pick state now that we have a job
    try {
      await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB });
    } catch {}

    // ✅ Immediately re-send confirm UI (interactive template if available)
    return await resendConfirmExpense({ from, ownerId, tz, paUserId, userProfile });
  }


}


        // ----------------------------
        // 2) TYPED INPUT PATH
        // ----------------------------
        const displayedJobNos = Array.isArray(pickPA.payload.displayedJobNos) ? pickPA.payload.displayedJobNos : [];
        const resolved = resolveJobOptionFromReply(rawInput, jobOptions, { page, pageSize, displayedJobNos });

console.info('[JOB_PICK_RESOLVED]', {
  input: rawInput,
  title: inboundTwilioMeta?.ListTitle,
  resolved
});


        if (!resolved) {
          return out(
            twimlText('Please reply with a job from the list, a number, job name, "Overhead", or "more".'),
            false
          );
        }

        if (resolved.kind === 'overhead') {
         // ✅ Ensure confirm draft exists (rebuild from pickPA.confirmDraft if needed)
let confirmPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });

if (!confirmPA?.payload?.draft) {
  const fallbackDraft = pickPA?.payload?.confirmDraft || null;

  if (fallbackDraft) {
    await upsertPA({
      ownerId,
      userId: paUserId,
      kind: PA_KIND_CONFIRM,
      payload: {
        draft: fallbackDraft,
        sourceMsgId: stableMsgId,
        type: 'expense'
      },
      ttlSeconds: PA_TTL_SEC
    });

    confirmPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
  }
}

// ✅ Update confirm draft with picked job (even if it was rebuilt)
if (confirmPA?.payload?.draft) {
  await upsertPA({
    ownerId,
    userId: paUserId,
    kind: PA_KIND_CONFIRM,
    payload: {
      ...(confirmPA.payload || {}),
      draft: {
        ...(confirmPA.payload.draft || {}),
        jobName: 'Overhead',
        jobSource: 'overhead',
        job_no: null
      }
    },
    ttlSeconds: PA_TTL_SEC
  });
} else {
  // If we STILL can’t rebuild, treat it as stale and re-send picker
  return await rejectAndResendPicker({
    from,
    ownerId,
    userProfile,
    confirmFlowId: confirmFlowId || stableMsgId || `${normalizeIdentityDigits(from) || from}:${Date.now()}`,
    jobOptions,
    reason: 'missing_confirm_after_pick',
    twilioMeta: inboundTwilioMeta
  });
}

try { await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB }); } catch {}
return await resendConfirmExpense({ from, ownerId, tz });

        }

        if (resolved.kind === 'job' && resolved.job?.job_no) {
          const confirmPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });

          try {
            await persistActiveJobBestEffort({
              ownerId,
              userProfile,
              fromPhone: userKey,
              jobRow: resolved.job,
              jobNameFallback: resolved.job?.name
            });
          } catch {}

          if (confirmPA?.payload?.draft) {
            await upsertPA({
              ownerId,
              userId: paUserId,
              kind: PA_KIND_CONFIRM,
              payload: {
                ...confirmPA.payload,
                draft: {
                  ...(confirmPA.payload.draft || {}),
                  jobName: getJobDisplayName(resolved.job),
                  jobSource: 'picked',
                  job_no: Number(resolved.job.job_no)
                }
              },
              ttlSeconds: PA_TTL_SEC
            });
          }

          try {
            await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB });
          } catch {}
          return await resendConfirmExpense({ from, ownerId, tz });
        }

        return await resendConfirmExpense({ from, ownerId, tz });
      }
    }

 // ---- 2) Confirm/edit/cancel (CONSOLIDATED) ----
let confirmPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
let bypassConfirmToAllowNewIntake = false;

if (confirmPA?.payload?.draft) {
  // Owner-only gate
  if (!isOwner) {
    await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
    return out(twimlText('⚠️ Only the owner can manage expenses.'), false);
  }

  const token = normalizeDecisionToken(rawInboundText);
  const lcRaw = String(rawInboundText || '').trim().toLowerCase();

  // ✅ 0) Receipt/media inbound bypass: do NOT nag; let receipt intake handle this inbound.
  try {
    const numMedia = Number(inboundTwilioMeta?.NumMedia || inboundTwilioMeta?.numMedia || 0);
    const looksLikeReceiptInbound = looksLikeReceiptText(rawInboundText) || numMedia > 0;

    if (looksLikeReceiptInbound) {
      console.info('[CONFIRM_BYPASS_FOR_RECEIPT_INBOUND]', { paUserId, numMedia });
      bypassConfirmToAllowNewIntake = true;
    }
  } catch {}

  // ✅ 1) If awaiting edit, consume edit payload FIRST (and RETURN)
  try {
    const draft0 = confirmPA?.payload?.draft || null;
    if (draft0?.awaiting_edit) {
      // Allow control tokens to fall through to normal logic
      if (!isControlDuringEdit(rawInboundText, inboundTwilioMeta)) {
        const tz0 = userProfile?.timezone || userProfile?.tz || ownerProfile?.tz || 'America/Toronto';

        const { nextDraft, aiReply } = await applyEditPayloadToConfirmDraft(
          rawInboundText,
          draft0,
          { fromKey: paUserId, tz: tz0, defaultData: {} }
        );

        if (!nextDraft) {
          return out(
            twimlText(aiReply || 'I couldn’t understand that edit. Please resend with amount + date.'),
            false
          );
        }

        await upsertPA({
          ownerId,
          userId: paUserId,
          kind: PA_KIND_CONFIRM,
          payload: {
            ...(confirmPA.payload || {}),
            draft: {
              ...(draft0 || {}),
              ...nextDraft,
              awaiting_edit: false
            }
          },
          ttlSeconds: PA_TTL_SEC
        });

        // ✅ Re-send confirm UI immediately (no nag message)
        try {
          return await resendConfirmExpense({ from, ownerId, tz: tz0, paUserId });
        } catch (e) {
          console.warn('[EXPENSE] resendConfirmExpense after edit payload failed (fallback):', e?.message);
          const merged = { ...(draft0 || {}), ...nextDraft, awaiting_edit: false };
          return out(twimlText(formatExpenseConfirmText(merged)), false);
        }
      }
    }
  } catch (e) {
    console.warn('[EXPENSE] awaiting_edit consume failed (ignored):', e?.message);
  }

  // ✅ 2) Currency-only reply consumption (only when it's a pure currency token)
  try {
    if (!['yes', 'edit', 'cancel', 'resume', 'skip', 'change_job'].includes(token)) {
      const draft = confirmPA?.payload?.draft || null;
      const draftCurrency = String(draft?.currency || '').trim();
      const awaitingCurrency = !!draft?.awaiting_currency;

      const tokCurrencyRaw = String(rawInboundText || '').trim().toUpperCase();
      const isCurrencyToken = /^(CAD|USD|EUR|GBP|C\$|US\$)$/.test(tokCurrencyRaw);

      if (draft && isCurrencyToken && (!draftCurrency || awaitingCurrency)) {
        const normalizedCurrency =
          tokCurrencyRaw === 'C$' ? 'CAD' : tokCurrencyRaw === 'US$' ? 'USD' : tokCurrencyRaw;

        await upsertPA({
          ownerId,
          userId: paUserId,
          kind: PA_KIND_CONFIRM,
          payload: {
            ...(confirmPA.payload || {}),
            draft: {
              ...(draft || {}),
              currency: normalizedCurrency,
              awaiting_currency: false
            }
          },
          ttlSeconds: PA_TTL_SEC
        });

        // refresh + resend
        try {
          confirmPA = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
        } catch {}

        return await resendConfirmExpense({ from, ownerId, tz, paUserId, userProfile });
      }
    }
  } catch (e) {
    console.warn('[EXPENSE] currency-only consume failed (ignored):', e?.message);
  }

  // decision tokens that MUST stay inside confirm flow
  const isDecisionToken =
    token === 'yes' ||
    token === 'edit' ||
    token === 'cancel' ||
    token === 'resume' ||
    token === 'skip' ||
    token === 'change_job';

  // “info commands” that should NOT be blocked by confirm draft
  const isNonIntakeQuery =
    /^show\b/.test(lcRaw) ||
    lcRaw.includes('last expense') ||
    lcRaw.includes('last revenue') ||
    /^help\b/.test(lcRaw) ||
    /^dashboard\b/.test(lcRaw) ||
    /^jobs?\b/.test(lcRaw) ||
    /^tasks?\b/.test(lcRaw) ||
    /^timesheet\b/.test(lcRaw);

  // ✅ bypass confirm nag for info commands (but do NOT bypass real decision tokens)
  if (!isDecisionToken && isNonIntakeQuery && !looksLikeNewExpenseText(rawInboundText)) {
    bypassConfirmToAllowNewIntake = true;
  }

  // ✅ If bypassing, fall through to normal routing below (do not nag, do not clear)
  if (!bypassConfirmToAllowNewIntake) {
    // Optional pending state (only used for allow_new_while_pending)
    let pendingNow = null;
    try {
      pendingNow = await getPendingTransactionState(paUserId);
    } catch {}

    // ✅ Resume: re-send confirm for the existing pending expense (no state changes)
    if (token === 'resume') {
      try {
        return await resendConfirmExpense({ from, ownerId, tz, paUserId, userProfile });
      } catch (e) {
        console.warn('[EXPENSE] resume confirm resend failed (fallback to text):', e?.message);
        return out(twimlText(formatExpenseConfirmText(confirmPA.payload.draft)), false);
      }
    }

    // ✅ Skip: keep current confirm draft pending, allow ONE new intake next.
    if (token === 'skip') {
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
            'Okay — I’ll keep that expense pending.',
            'Now send the *new* expense (or photo) you want to log.',
            'Tip: reply “resume” anytime to bring back the pending one.'
          ].join('\n')
        ),
        false
      );
    }

    // ✅ If user is trying to log a new expense while confirm pending:
    if (looksLikeNewExpenseText(rawInboundText)) {
      const allowNew = !!pendingNow?.allow_new_while_pending;

      if (!allowNew) {
        return out(
          twimlText(
            [
              'You’ve still got an expense waiting for confirmation.',
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
      // 🔁 Change Job (keep confirm PA)
      if (token === 'change_job') {
        const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
        if (!jobs.length) {
          return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);
        }

        // ✅ Mark confirm draft dirty so we re-parse receipt fields after job changes
        try {
          await upsertPA({
            ownerId,
            userId: paUserId,
            kind: PA_KIND_CONFIRM,
            payload: {
              ...(confirmPA.payload || {}),
              draft: {
                ...(confirmPA.payload?.draft || {}),
                needsReparse: true
              }
            },
            ttlSeconds: PA_TTL_SEC
          });
        } catch (e) {
          console.warn('[EXPENSE] change_job needsReparse set failed (ignored):', e?.message);
        }

        const confirmFlowId =
          String(confirmPA?.payload?.sourceMsgId || '').trim() ||
          String(stableMsgId || '').trim() ||
          `${normalizeIdentityDigits(from) || from}:${Date.now()}`;

        // IMPORTANT: send picker out-of-band; do NOT also return a TwiML body message
        await sendJobPickList({
          from,
          ownerId,
          userProfile,
          confirmFlowId,
          jobOptions: jobs,
          paUserId,
          page: 0,
          pageSize: 8,
          context: 'expense_jobpick',
          confirmDraft: confirmPA?.payload?.draft || null
        });

        return out(twimlText(''), true);
      }

      // ✏️ Edit: mark confirm draft as awaiting edit
      if (token === 'edit') {
        try {
          await upsertPA({
            ownerId,
            userId: paUserId,
            kind: PA_KIND_CONFIRM,
            payload: {
              ...(confirmPA.payload || {}),
              draft: {
                ...(confirmPA.payload?.draft || {}),
                awaiting_edit: true
              }
            },
            ttlSeconds: PA_TTL_SEC
          });
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

      // ❌ Cancel (delete confirm + pick) + clear allow_new_while_pending
      if (token === 'cancel') {
        await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
        try {
          await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB });
        } catch {}

        try {
          const p2 = await getPendingTransactionState(paUserId);
          if (p2?.allow_new_while_pending) {
            await mergePendingTransactionState(paUserId, {
              allow_new_while_pending: false,
              allow_new_set_at: null
            });
          }
        } catch {}

        return out(twimlText('❌ Cancelled. You’re cleared.'), false);
      }
    }

 // --------------------------------------------
// ✅ YES (HARDENED + DOES INSERT + MUST RETURN)
// --------------------------------------------
const userKey = paUserId; // canonical digits-based PA key
if (token === 'yes') {
  try {
    // Always operate on freshest confirm PA (avoid stale confirmPA var)
    let confirmPAFresh = null;
    try {
      confirmPAFresh = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
    } catch (e) {
      console.warn('[YES] getPA failed (ignored):', e?.message);
      confirmPAFresh = confirmPA || null;
    }
    if (!confirmPAFresh) confirmPAFresh = confirmPA || null;

    // If draft is marked dirty, reparse now (receipt-safe)
    if (confirmPAFresh?.payload?.draft?.needsReparse) {
      try {
        await maybeReparseConfirmDraftExpense({ ownerId, paUserId, tz, userProfile });
        confirmPAFresh = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
      } catch (e) {
        console.warn('[YES] maybeReparseConfirmDraftExpense failed (ignored):', e?.message);
      }
    }

    const rawDraft = confirmPAFresh?.payload?.draft ? { ...confirmPAFresh.payload.draft } : null;

    console.info('[YES_HANDLER_CONFIRM_PA]', {
      paUserId,
      hasConfirm: !!confirmPAFresh,
      hasDraft: !!rawDraft && !!Object.keys(rawDraft).length,
      paSourceMsgId: confirmPAFresh?.payload?.sourceMsgId || null,
      amount: rawDraft?.amount || null,
      date: rawDraft?.date || null,
      store: rawDraft?.store || null,
      currency: rawDraft?.currency || null,
      jobName: rawDraft?.jobName || null
    });

    if (!rawDraft || !Object.keys(rawDraft).length) {
      return out(
        twimlText(`I didn’t find an expense draft to submit. Reply "resume" to see what’s pending.`),
        false
      );
    }

    // Canonical txSourceMsgId (the confirm flow ID)
    const txSourceMsgId =
      String(confirmPAFresh?.payload?.sourceMsgId || '').trim() ||
      String(stableMsgId || '').trim() ||
      null;

    // Ensure media_source_msg_id always "userKey:msgId"
    if (!rawDraft.media_source_msg_id && txSourceMsgId) {
      rawDraft.media_source_msg_id = `${userKey}:${txSourceMsgId}`;
    } else if (rawDraft.media_source_msg_id) {
      const ms = String(rawDraft.media_source_msg_id || '').trim();
      if (ms && !ms.includes(':')) rawDraft.media_source_msg_id = `${userKey}:${ms}`;
    }

    // Resolve media asset id (draft -> flow -> pending -> DB)
    const mediaAssetId = await resolveMediaAssetIdForFlow({
      ownerId,
      userKey,
      rawDraft,
      flowMediaAssetId
    });

    // Receipt/OCR-first source text for normalization
    const sourceText = String(
      rawDraft?.receiptText ||
        rawDraft?.ocrText ||
        rawDraft?.media_transcript ||
        rawDraft?.mediaTranscript ||
        rawDraft?.originalText ||
        rawDraft?.draftText ||
        rawDraft?.text ||
        ''
    ).trim();

    let data = normalizeExpenseData(rawDraft, userProfile, sourceText);

    data.media_asset_id = mediaAssetId || data.media_asset_id || null;
    data.media_source_msg_id = rawDraft.media_source_msg_id || null;

    // ✅ Minimal gating
    const amountStr = String(data?.amount || '').trim();
    const dateStr = String(data?.date || '').trim();

    if (!amountStr || amountStr === '$0.00') {
      return out(
        twimlText(`I’m missing the total amount. Reply like: "Total 14.84 CAD" (or just "14.84").`),
        false
      );
    }
    if (!dateStr) {
      return out(twimlText(`I’m missing the date. Reply like: "The transaction date is 01/05/2026".`), false);
    }

    // ✅ Job resolution
    let jobName = data.jobName || rawDraft.jobName || null;
    let jobSource = jobName ? (data.jobSource || rawDraft.jobSource || 'typed') : null;

    if (!jobName) {
      jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
      if (jobName) jobSource = 'active';
    }

    if (jobName && looksLikeOverhead(jobName)) {
      jobName = 'Overhead';
      jobSource = 'overhead';
    }

    if (!jobName) {
      const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));

      await sendJobPickList({
        from,
        ownerId,
        userProfile,
        confirmFlowId: txSourceMsgId || `${normalizeIdentityDigits(from) || from}:${Date.now()}`,
        jobOptions: jobs,
        paUserId,
        page: 0,
        pageSize: 8,
        context: 'expense_jobpick',
        confirmDraft: {
          ...data,
          jobName: null,
          jobSource: null,
          media_asset_id: data.media_asset_id || null,
          media_source_msg_id: data.media_source_msg_id || null,
          originalText: rawDraft?.originalText || sourceText || '',
          draftText: rawDraft?.draftText || sourceText || ''
        }
      });

      // ✅ DO NOT send an extra TwiML message; the picker is already sent out-of-band
      return out(twimlText(''), true);
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

    // 1) Derive a clean amount number from "$14.84", "14.84", "Total 14.84 CAD", etc.
    const amountRaw = String(data?.amount ?? rawDraft?.amount ?? '').trim();
    const m = amountRaw.match(/-?\d+(?:\.\d+)?/);
    const amountNum = m ? Number(m[0]) : NaN;

    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return out(
        twimlText(`I couldn’t confirm the total amount from "${amountRaw}". Reply like: "14.84".`),
        false
      );
    }

    // 2) Convert to integer cents (always)
    const amountCents = Math.round(amountNum * 100);

    // 3) Canonicalize fields so pg.insertTransaction() can’t misread them
    data.amount = amountNum.toFixed(2); // ✅ clean "14.84"
    data.amount_cents = amountCents;

    // ✅ Ensure insertTransaction gets what it expects
    const sourceForDb = String(data.store || '').trim() || 'Unknown';
    const descForDb = String(data.item || data.description || '').trim() || 'Unknown';

    // 4) Insert (pass BOTH amount + amount_cents)
    await pg.insertTransaction({
      ownerId,
      owner_id: ownerId,
      userId: paUserId,
      user_id: paUserId,
      fromPhone: from,
      from,

      kind: 'expense',

      // keep your normalized fields too
      ...data,

      // ✅ DB-critical fields must come AFTER ...data so they win
      date: String(data.date || '').trim(),
      source: sourceForDb,
      description: descForDb,

      // ✅ force canonical amount forms
      amount: amountNum.toFixed(2),
      amount_cents: amountCents,

      jobName,
      jobSource,

      category: categoryStr,

      media_asset_id: data.media_asset_id || null,
      source_msg_id: txSourceMsgId || null
    });

    console.info('[EXPENSE_INSERT_OK]', {
      paUserId,
      txSourceMsgId: txSourceMsgId || null,
      media_asset_id: data.media_asset_id || null
    });

    // ✅ After successful log: clear confirm + picker + pending-state flags so we never nag incorrectly
    try {
      await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
    } catch {}
    try {
      await deletePA({ ownerId, userId: paUserId, kind: PA_KIND_PICK_JOB });
    } catch {}

    try {
      const p2 = await getPendingTransactionState(paUserId);
      if (p2?.allow_new_while_pending) {
        await mergePendingTransactionState(paUserId, {
          allow_new_while_pending: false,
          allow_new_set_at: null
        });
      }
    } catch {}

    // Optional: only keep if you KNOW this exists in your stateManager
    try {
      if (typeof state?.deletePendingMediaMeta === 'function') {
        await state.deletePendingMediaMeta(paUserId);
      }
    } catch {}

    const okMsg = [
      `✅ Logged expense ${String(data.amount || '').trim()} — ${data.store || 'Unknown Store'}`,
      data.date ? `Date: ${data.date}` : null,
      jobName ? `Job: ${jobName}` : null,
      categoryStr ? `Category: ${categoryStr}` : null
    ]
      .filter(Boolean)
      .join('\n');

    // ✅ IMPORTANT: TwiML is the correct “plain message” path
    return out(twimlText(okMsg), false);
  } catch (e) {
    console.error('[YES] handler failed:', e?.message);
    return out(
      twimlText(`Something went wrong submitting that expense. Reply "resume" and try again.`),
      false
    );
  }
}


    // Default while confirm pending
    return out(
      twimlText(
        [
          'You’ve still got an expense waiting for confirmation.',
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
} // ✅ IMPORTANT: closes the line-3559 confirmPA?.payload?.draft block

// If confirm draft exists but we bypassed (allow_new_while_pending), continue below into new-intake parsing.
// If no confirm draft exists, we also continue into new-intake parsing.


/* ---- 3) New expense parse (deterministic first) ---- */

// ✅ Receipt/OCR path: seed/patch CONFIRM PA so "Yes" has something real to submit.
// IMPORTANT: do NOT run deterministicExpenseParse on receipt blobs.
if (looksLikeReceiptText(input)) {
  let seededOk = false;

  // ✅ hoist so the picker try/catch can use them
  let txSourceMsgId = null;
  let mergedDraft = null;

  try {
    const receiptText = stripExpensePrefixes(String(input || '')).trim();
    const back = parseReceiptBackstop(receiptText);

    const locale0 = String(userProfile?.locale || ownerProfile?.locale || '').toLowerCase();
    const defaultCurrency =
      String(userProfile?.currency || '').trim().toUpperCase() ||
      String(ownerProfile?.currency || '').trim().toUpperCase() ||
      (locale0.includes('us') ? 'USD' : '') ||
      (locale0.includes('ca') ? 'CAD' : '') ||
      'CAD';

    const c0 = await getPA({ ownerId, userId: paUserId, kind: PA_KIND_CONFIRM });
    const draft0 = c0?.payload?.draft || {};

    // ✅ assign to hoisted var (NOT const)
    txSourceMsgId =
      String(c0?.payload?.sourceMsgId || '').trim() ||
      String(stableMsgId || '').trim() ||
      null;

    const userKey = String(paUserId || '').trim() || String(from || '').trim();

    const patch = {
      store: back?.store || null,
      date: back?.dateIso || null,
      amount: back?.total != null ? String(Number(back.total).toFixed(2)) : null,

      // ✅ Always have a currency (prefer parsed, then existing, then default)
      currency: back?.currency || draft0?.currency || defaultCurrency,

      receiptText,
      ocrText: receiptText,
      originalText: draft0.originalText || receiptText,
      draftText: draft0.draftText || receiptText
    };

    // ✅ assign to hoisted var (NOT const) — AFTER patch exists
    mergedDraft = mergeDraftNonNull(draft0, patch);

    if (!mergedDraft.media_source_msg_id && txSourceMsgId) {
      mergedDraft.media_source_msg_id = `${userKey}:${txSourceMsgId}`;
    } else if (mergedDraft.media_source_msg_id) {
      const ms = String(mergedDraft.media_source_msg_id || '').trim();
      if (ms && !ms.includes(':')) mergedDraft.media_source_msg_id = `${userKey}:${ms}`;
    }

    mergedDraft.media_asset_id =
      mergedDraft.media_asset_id || resolvedFlowMediaAssetId || flowMediaAssetId || null;

    const gotAmount = !!String(mergedDraft.amount || '').trim();
    const gotDate = !!String(mergedDraft.date || '').trim();

    await upsertPA({
      ownerId,
      userId: paUserId,
      kind: PA_KIND_CONFIRM,
      payload: {
        ...(c0?.payload || {}),
        type: 'expense',
        sourceMsgId: txSourceMsgId,
        draft: {
          ...mergedDraft,
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
      currency: mergedDraft.currency || null,
      needsReparse: !(gotAmount && gotDate),
      media_asset_id: mergedDraft.media_asset_id || null
    });

    seededOk = true;
  } catch (e) {
    console.warn('[RECEIPT_SEED_CONFIRM_PA] failed (ignored):', e?.message);
  }

  // ✅ Receipt intake UX: ALWAYS go to job picker first.
  // Never emit "issues"/confirm text on receipt intake.
  try {
    const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
    if (!jobs.length) {
      return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);
    }

    const confirmFlowId =
      String(txSourceMsgId || '').trim() ||
      String(stableMsgId || '').trim() ||
      `${normalizeIdentityDigits(from) || from}:${Date.now()}`;

    // IMPORTANT: send picker out-of-band; do NOT return whatever it returns.
    await sendJobPickList({
      from,
      ownerId,
      userProfile,
      confirmFlowId,
      jobOptions: jobs,
      paUserId,
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
            draftText: mergedDraft.draftText || mergedDraft.receiptText || ''
          }
        : null
    });

    return out(twimlText(''), true);
  } catch (e) {
    console.warn('[EXPENSE] receipt job picker send failed:', e?.message);

    // Fallback: if we couldn't seed OR picker, tell the user.
    if (!seededOk) {
      return out(twimlText('⚠️ I couldn’t read that receipt. Try sending it again.'), false);
    }

    // If seeded confirm but picker failed, re-send confirm instead of nag text.
    try {
      return await resendConfirmExpense({ from, ownerId, tz, paUserId, userProfile });
    } catch {
      return out(twimlText(''), true);
    }
  }


  // ✅ Hard stop: do NOT run deterministic parse on receipt blobs.
} else {
  // ✅ Non-receipt path: deterministic parse first
  const backstop = deterministicExpenseParse(input, userProfile);

  if (backstop && backstop.amount) {
    const sourceText0 = String(backstop?.originalText || backstop?.draftText || input || '').trim();
    const data0 = normalizeExpenseData(backstop, userProfile, sourceText0);

    data0.store = await normalizeVendorName(ownerId, data0.store);

    if (isUnknownItem(data0.item)) {
      const inferred = inferExpenseItemFallback(input);
      if (inferred) data0.item = inferred;
    }

    let category = await resolveExpenseCategory({ ownerId, data: data0, ownerProfile });
    category = category && String(category).trim() ? String(category).trim() : null;

    let jobName = data0.jobName || null;
    let jobSource = jobName ? 'typed' : null;

    if (!jobName) {
      jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
      if (jobName) jobSource = 'active';
    }

    if (jobName && looksLikeOverhead(jobName)) {
      jobName = 'Overhead';
      jobSource = 'overhead';
    }

    if (jobName) data0.item = stripEmbeddedDateAndJobFromItem(data0.item, { date: data0.date, jobName });

    const safeMsgId0 = String(stableMsgId || '').trim() || null;

    await upsertPA({
      ownerId,
      userId: paUserId,
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
          media_source_msg_id: safeMsgId0
            ? `${String(paUserId || '').trim()}:${String(safeMsgId0).trim()}`
            : null,

          originalText: input,
          draftText: input
        },
        sourceMsgId: safeMsgId0,
        type: 'expense'
      },
      ttlSeconds: PA_TTL_SEC
    });

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

    if (!jobName) {
      const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));

      const confirmFlowId =
        String(safeMsgId0 || '').trim() ||
        String(stableMsgId || '').trim() ||
        `${normalizeIdentityDigits(from) || from}:${Date.now()}`;

      // IMPORTANT: send picker out-of-band; do NOT also return a TwiML body message
      await sendJobPickList({
        from,
        ownerId,
        userProfile,
        confirmFlowId,
        jobOptions: jobs,
        paUserId,
        page: 0,
        pageSize: 8,
        context: 'expense_jobpick',
        confirmDraft: {
          ...data0,
          jobName: null,
          jobSource: null,
          media_asset_id: resolvedFlowMediaAssetId || flowMediaAssetId || null,
          media_source_msg_id: safeMsgId0
            ? `${String(paUserId || '').trim()}:${String(safeMsgId0).trim()}`
            : null,
          originalText: input,
          draftText: input
        }
      });

      return out(twimlText(''), true);
    }

    const summaryLine = buildExpenseSummaryLine({
      amount: data0.amount,
      item: data0.item,
      store: data0.store,
      date: data0.date,
      jobName,
      tz,
      sourceText: input
    });

    console.info('[CONFIRM_SEND]', { userId: paUserId, token: 'send_confirm' });
    return await sendConfirmExpenseOrFallback(from, `${summaryLine}${buildActiveJobHint(jobName, jobSource)}`);
  }
} // ✅ closes Section 3 else block


/* ---- 4) AI parsing fallback ---- */

const safeMsgId = String(stableMsgId || '').trim() || null;

const defaultData = {
  date: todayInTimeZone(tz),
  item: 'Unknown',
  amount: '$0.00',
  store: 'Unknown Store'
};

const aiRes = await handleInputWithAI(from, input, 'expense', parseExpenseMessage, defaultData, { tz });

let data = aiRes?.data || null;
let aiReply = aiRes?.reply || null;

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

if (data?.jobName) data.jobName = sanitizeJobNameCandidate(data.jobName);

if (data && isUnknownItem(data.item)) {
  const inferred = inferExpenseItemFallback(input);
  if (inferred) data.item = inferred;
}

const missingCore =
  !data ||
  !data.amount ||
  data.amount === '$0.00' ||
  !data.item ||
  data.item === 'Unknown' ||
  !data.store ||
  data.store === 'Unknown Store';

if (aiReply && missingCore) return out(twimlText(aiReply), false);

if (data && data.amount && data.amount !== '$0.00') {
  data.store = await normalizeVendorName(ownerId, data.store);

  let category = await resolveExpenseCategory({ ownerId, data, ownerProfile });
  category = category && String(category).trim() ? String(category).trim() : null;

  let jobName = data.jobName || null;
  let jobSource = jobName ? 'typed' : null;

  if (!jobName) {
    jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
    if (jobName) jobSource = 'active';
  }

  if (jobName && looksLikeOverhead(jobName)) {
    jobName = 'Overhead';
    jobSource = 'overhead';
  }

  if (jobName) data.item = stripEmbeddedDateAndJobFromItem(data.item, { date: data.date, jobName });

  await upsertPA({
    ownerId,
    userId: paUserId,
    kind: PA_KIND_CONFIRM,
    payload: {
      draft: {
        ...data,
        jobName,
        jobSource,
        suggestedCategory: category,
        job_id: null,
        job_no: null,

        media_asset_id: resolvedFlowMediaAssetId || flowMediaAssetId || null,
        media_source_msg_id: safeMsgId
          ? `${String(paUserId || '').trim()}:${String(safeMsgId).trim()}`
          : null,

        receiptText: data?.receiptText || data?.ocrText || data?.media_transcript || null,
        ocrText: data?.ocrText || null,

        originalText: input,
        draftText: input
      },
      sourceMsgId: safeMsgId,
      type: 'expense'
    },
    ttlSeconds: PA_TTL_SEC
  });

  if (!jobName) {
  const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
  if (!jobs.length) return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);

  const confirmFlowId =
    String(confirmPA?.payload?.sourceMsgId || '').trim() ||
    String(safeMsgId || '').trim() ||
    String(stableMsgId || '').trim() ||
    `${normalizeIdentityDigits(from) || from}:${Date.now()}`;

  await sendJobPickList({
    from,
    ownerId,
    userProfile,
    confirmFlowId,
    jobOptions: jobs,
    paUserId,
    page: 0,
    pageSize: 8,
    context: 'expense_jobpick',
    confirmDraft: {
      ...data,
      jobName: null,
      jobSource: null,
      media_asset_id: resolvedFlowMediaAssetId || flowMediaAssetId || null,
      media_source_msg_id: safeMsgId
        ? `${String(paUserId || '').trim()}:${String(safeMsgId).trim()}`
        : null,
      originalText: input,
      draftText: input
    }
  });

  // IMPORTANT: send picker out-of-band; do NOT also return a TwiML body message
  return out(twimlText(''), true);
}


  const summaryLine = buildExpenseSummaryLine({
    amount: data.amount,
    item: data.item,
    store: data.store,
    date: data.date || todayInTimeZone(tz),
    jobName,
    tz,
    sourceText: input
  });

  console.info('[CONFIRM_SEND]', { userId: paUserId, token: 'send_confirm' });
  return await sendConfirmExpenseOrFallback(from, `${summaryLine}${buildActiveJobHint(jobName, jobSource)}`);
}

return out(
  twimlText(`🤔 Couldn’t parse an expense from "${input}". Try "expense 84.12 nails from Home Depot".`),
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
  }
}

module.exports = { handleExpense };

