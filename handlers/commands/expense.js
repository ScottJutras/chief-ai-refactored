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
  const sid = getExpenseConfirmTemplateSid();
  const to = waTo(from);

  if (sid && to) {
    try {
      await sendWhatsAppTemplate({ to, templateSid: sid, summaryLine });
      return out(twimlEmpty(), true);
    } catch (e) {
      console.warn('[EXPENSE] template send failed; falling back to TwiML:', e?.message);
    }
  }

  return out(twimlText(`✅ Confirm expense\n${summaryLine}\n\nReply: Yes / Edit / Cancel / Change Job`), false);
}

/* ---------------- misc helpers ---------------- */

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
    if (j) {
      s = s.replace(new RegExp(`\\bfor\\s+${escapeRegExp(j)}\\s*$`, 'i'), ' ');
    }
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
    { re: /\brailing(s)?\b|\bhandrail(s)?\b|\bguard\s*rail(s)?\b/, item: 'Railing' }, // ✅ added
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

  // "worth of X" fallback (your existing behavior)
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

  // We accept variants:
  // - "expense $84 on nails from ..."
  // - "$84 on nails from ..."
  // - "paid $84 on nails at ..."
  // Keep it conservative: we only take "on <item>" when it clearly precedes from/at/for/date/end.
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

    // 3) "$883 railing at Rona" (fallback: token between amount and at/from/on/for)
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


// rowId = jp:<flow>:<nonce>:jn:<jobNo>:h:<sig>
function makeRowId({ flow, nonce, jobNo, secret }) {
  const base = `${flow}|${nonce}|${jobNo}`;
  const sig = hmac12(secret, base);
  return `jp:${flow}:${nonce}:jn:${jobNo}:h:${sig}`;
}

function parseRowId(rowId) {
  const s = String(rowId || '').trim();
  const m = s.match(/^jp:([0-9a-f]{8}):([0-9a-z]{6,16}):jn:(\d{1,10}):h:([0-9a-f]{10,16})$/i);
  if (!m) return null;
  return { flow: m[1], nonce: m[2], jobNo: Number(m[3]), sig: m[4] };
}

async function resolveJobPickSelection({ ownerId, from, input, twilioMeta }) {
  const pickPA = await getPA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
  if (!pickPA?.payload) return { ok: false, reason: 'no_pick_state' };

  const { flow, pickerNonce, displayedJobNos, displayedHash, pickerMsgSid } = pickPA.payload;

  const parsed = parseRowId(input);
  if (!parsed) return { ok: false, reason: 'bad_row_id' };

  const secret = String(process.env.JOB_PICKER_HMAC_SECRET || '').trim() || null;
if (!secret) {
  console.warn('[JOB_PICK] missing JOB_PICKER_HMAC_SECRET; falling back to text picker');
  return out(twimlText(buildTextJobPrompt(clean, p, ps)), false);
}

  if (!secret) return { ok: false, reason: 'missing_secret' };

  const base = `${parsed.flow}|${parsed.nonce}|${parsed.jobNo}`;
  const expected = hmac12(secret, base);
  if (expected !== parsed.sig) return { ok: false, reason: 'bad_sig' };

  if (String(parsed.flow) !== String(flow)) return { ok: false, reason: 'flow_mismatch' };
  if (String(parsed.nonce) !== String(pickerNonce)) return { ok: false, reason: 'nonce_mismatch' };

  if (!Array.isArray(displayedJobNos) || !displayedJobNos.includes(parsed.jobNo)) {
    return { ok: false, reason: 'job_not_in_displayed' };
  }

  const repliedSid =
    twilioMeta?.OriginalRepliedMessageSid ||
    twilioMeta?.OriginalRepliedMessageSid ||
    null;

  if (pickerMsgSid && repliedSid && String(pickerMsgSid) !== String(repliedSid)) {
    return { ok: false, reason: 'replied_sid_mismatch' };
  }

  return { ok: true, jobNo: parsed.jobNo, meta: { flow, pickerNonce, displayedHash } };
}

async function rejectAndResendPicker({ from, ownerId, confirmFlowId, jobOptions, context = 'expense_jobpick' }) {
  try {
    await sendJobPickList({
      from,
      ownerId,
      confirmFlowId,
      jobOptions,
      page: 0,
      pageSize: 8,
      context
    });
  } catch (e) {
    console.warn('[JOB_PICK] resend picker failed (ignored):', e?.message);
  }

  return out(twimlText('That menu looks old—sending a fresh job list now. Please pick again.'), false);
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

function formatMoneyDisplay(n) {
  try {
    const fmt = new Intl.NumberFormat('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `$${fmt.format(n)}`;
  } catch {
    return `$${Number(n).toFixed(2)}`;
  }
}

function normalizeExpenseData(data, userProfile) {
  const tz = userProfile?.timezone || userProfile?.tz || 'America/Toronto';
  const d = { ...(data || {}) };

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

async function sendJobPickList({
  from,
  ownerId,
  confirmFlowId,          // REQUIRED: stable id for the current confirm flow (stableMsgId / confirmPA.sourceMsgId)
  jobOptions,
  page = 0,
  pageSize = 8,
  context = 'expense_jobpick' // set 'revenue_jobpick' in revenue.js
}) {
  const to = waTo(from);
  const ps = Math.min(8, Math.max(1, Number(pageSize || 8)));
  const p = Math.max(0, Number(page || 0));
  const start = p * ps;

  // Filter + de-dupe by job_no, drop token-garbage names
  const seen = new Set();
  const clean = [];
  for (const j of jobOptions || []) {
    const n = j?.job_no != null ? Number(j.job_no) : j?.jobNo != null ? Number(j.jobNo) : null;
    if (n == null || !Number.isFinite(n)) continue;

    const nm = sanitizeJobLabel(j?.name || j?.job_name || j?.jobName || '');
    if (!nm || isGarbageJobName(nm)) continue;

    if (seen.has(n)) continue;
    seen.add(n);

    // Keep uuid id ONLY
    const rawId = j?.id != null ? String(j.id) : j?.job_id != null ? String(j.job_id) : null;
    const safeUuidId = rawId && looksLikeUuid(rawId) ? rawId : null;

    clean.push({ ...j, id: safeUuidId, job_no: n, name: nm });
  }

  // Deterministic order
  clean.sort((a, b) => Number(a.job_no) - Number(b.job_no));

  const slice = clean.slice(start, start + ps);

  const displayedJobNos = slice
    .map((j) => (j?.job_no != null ? Number(j.job_no) : null))
    .filter((n) => Number.isFinite(n));

  const hasMore = start + ps < clean.length;

  const secret = String(process.env.JOB_PICKER_HMAC_SECRET || '').trim() || null;
if (!secret) {
  console.warn('[JOB_PICK] missing JOB_PICKER_HMAC_SECRET; falling back to text picker');
  return out(twimlText(buildTextJobPrompt(clean, p, ps)), false);
}

  if (!secret) {
    console.warn('[JOB_PICK] missing JOB_PICKER_HMAC_SECRET; falling back to text list (safe)');
    return out(twimlText(buildTextJobPrompt(clean, p, ps)), false);
  }

  // Per-send instance
  const pickerNonce = makePickerNonce();
console.info('[CRYPTO_DEBUG]', {
  cryptoType: typeof crypto,
  nodeCryptoHashFn: typeof nodeCrypto?.createHash
});

  // Flow binding (ties selections to THIS confirm flow)
  const flow = sha8(String(confirmFlowId || '').trim() || `${normalizeIdentityDigits(from) || from}:${Date.now()}`);

  const displayedHash = sha8(displayedJobNos.join(','));

  // Persist picker state BEFORE sending UI
  await upsertPA({
    ownerId,
    userId: from,
    kind: PA_KIND_PICK_JOB,
    payload: {
      context,
      flow,
      confirmFlowId: String(confirmFlowId || '').trim() || null,
      page: p,
      pageSize: ps,
      hasMore,
      displayedJobNos,
      displayedHash,
      pickerNonce,
      sentAt: Date.now(),
      pickerMsgSid: null
    },
    ttlSeconds: PA_TTL_SEC
  });

  // If interactive lists are disabled or no WA destination, send text prompt
  if (!ENABLE_INTERACTIVE_LIST || !to) {
    return out(twimlText(buildTextJobPrompt(clean, p, ps)), false);
  }

  // Row ids encode jobNo + nonce + flow + signature (NO INDEX MEANING)
  const rows = slice.map((j) => {
    const jobNo = Number(j.job_no);
    const name = sanitizeJobLabel(j.name);

    return {
      id: makeRowId({ flow, nonce: pickerNonce, jobNo, secret }),
      title: `Job #${jobNo} — ${name}`.slice(0, 24),
      description: name.slice(0, 72)
    };
  });

  const bodyText =
    context === 'revenue_jobpick'
      ? 'Which job is this revenue for?'
      : 'Which job is this expense for?';

  const sections = [{ title: 'Jobs', rows }];

  console.info('[JOB_PICK_SEND]', {
    context,
    flow,
    pickerNonce,
    page: p,
    displayedHash,
    displayedJobNos,
    rows: rows.map((r) => ({ id: r.id, title: r.title }))
  });

  // Send list
  const res = await sendWhatsAppInteractiveList({
    to,
    bodyText,
    buttonText: 'Pick job',
    sections
  });

  // Store outbound sid if available (strong stale protection)
  if (res?.sid) {
    try {
      const pickPA = await getPA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
      if (pickPA?.payload?.pickerNonce === pickerNonce) {
        await upsertPA({
          ownerId,
          userId: from,
          kind: PA_KIND_PICK_JOB,
          payload: { ...(pickPA.payload || {}), pickerMsgSid: res.sid },
          ttlSeconds: PA_TTL_SEC
        });
      }
    } catch {}
  }

  return res;
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
  if (!date) date = todayInTimeZone(tz);

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

/* ---------------- main handler ---------------- */

async function handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  input = correctTradeTerms(stripExpensePrefixes(input));

  const lockKey = `lock:${from}`;

  // Stable id for idempotency; prefer inbound MessageSid. Always fall back to something deterministic.
  const stableMsgId =
    String(sourceMsgId || '').trim() ||
    String(userProfile?.last_message_sid || '').trim() ||
    String(`${from}:${Date.now()}`).trim();

  // Back-compat alias (if older code still references safeMsgId)
  const safeMsgId = stableMsgId;


  try {
    const lock = require('../../middleware/lock');
    if (lock?.acquireLock) await lock.acquireLock(lockKey, 8000).catch(() => null);
  } catch {}

  try {
    const tz = userProfile?.timezone || userProfile?.tz || 'UTC';

    /* ---- 1) Awaiting job pick ---- */
const pickPA = await getPA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });

function looksLikeJobPickerAnswer(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return false;

  if (/^(overhead|oh)$/i.test(s)) return true;
  if (/^more(\s+jobs)?…?$/i.test(s)) return true;

  // NEW signed row ids
  if (/^jp:[0-9a-f]{8}:/i.test(s)) return true;

  // legacy/manual inputs (keep)
  if (/^\d{1,10}$/.test(s)) return true;
  if (/^jobno_\d{1,10}$/i.test(s)) return true;
  if (/^jobix_\d{1,10}$/i.test(s)) return true;
  if (/^job_\d{1,10}_[0-9a-z]+$/i.test(s)) return true;
  if (/^#\s*\d{1,10}\b/.test(s)) return true;
  if (/\bJ\d{1,10}\b/i.test(s)) return true;

  if (/^[a-z0-9][a-z0-9 _.'-]{2,}$/i.test(s)) {
    const lc = s.toLowerCase();
    if (/^(yes|no|edit|cancel|stop|change job|switch job|pick job|active jobs|show jobs|jobs)$/i.test(lc)) return false;
    return true;
  }

  return false;
}

if (pickPA?.payload?.jobOptions) {
  // If user sent a brand new expense while waiting for job pick, clear state and continue parsing.
  if (looksLikeNewExpenseText(input)) {
    console.info('[EXPENSE] pick-job bypass: new expense detected, clearing PAs');
    try { await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB }); } catch {}
    try { await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM }); } catch {}
  } else {
    const tok = normalizeDecisionToken(input);

    const jobOptions = Array.isArray(pickPA.payload.jobOptions) ? pickPA.payload.jobOptions : [];
    const page = Number(pickPA.payload.page || 0) || 0;
    const pageSize = Number(pickPA.payload.pageSize || 8) || 8;
    const hasMore = !!pickPA.payload.hasMore;

    // NEW state
    const flow = String(pickPA.payload.flow || '').trim() || null;
    const confirmFlowId = String(pickPA.payload.confirmFlowId || '').trim() || null;
    const sentAt = Number(pickPA.payload.sentAt || 0) || 0;

    // Stale picker protection (time-based)
    if (!sentAt || (Date.now() - sentAt) > (PA_TTL_SEC * 1000)) {
      return await sendJobPickList({
        from,
        ownerId,
        confirmFlowId: confirmFlowId || `${normalizeIdentityDigits(from) || from}:${Date.now()}`,
        jobOptions,
        page: 0,
        pageSize: 8,
        context: 'expense_jobpick'
      });
    }

    let rawInput = String(input || '').trim();

    // Debug
    console.info('[JOB_PICK_DEBUG]', {
      input,
      rawInput,
      flow,
      confirmFlowId,
      sentAt,
      page,
      displayedJobNos: (pickPA.payload.displayedJobNos || []).slice(0, 8),
      pickerNonce: pickPA.payload.pickerNonce
    });

    // Optional: remember last inbound picker token
    try {
      await upsertPA({
        ownerId,
        userId: from,
        kind: PA_KIND_PICK_JOB,
        payload: { ...(pickPA.payload || {}), lastInboundTextRaw: input, lastInboundText: rawInput },
        ttlSeconds: PA_TTL_SEC
      });
    } catch {}

    // Change job → re-send list (same flow id)
    if (tok === 'change_job') {
      return await sendJobPickList({
        from,
        ownerId,
        confirmFlowId: confirmFlowId || `${normalizeIdentityDigits(from) || from}:${Date.now()}`,
        jobOptions,
        page,
        pageSize,
        context: 'expense_jobpick'
      });
    }

    // More → next page
    if (tok === 'more') {
      if (!hasMore) {
        return out(twimlText('No more jobs to show. Reply with a number, job name, or "Overhead".'), false);
      }
      return await sendJobPickList({
        from,
        ownerId,
        confirmFlowId: confirmFlowId || `${normalizeIdentityDigits(from) || from}:${Date.now()}`,
        jobOptions,
        page: page + 1,
        pageSize,
        context: 'expense_jobpick'
      });
    }

    if (!looksLikeJobPickerAnswer(rawInput)) {
      return out(twimlText('Please reply with a job from the list, a number, job name, "Overhead", or "more".'), false);
    }

    // ✅ NEW PATH: signed picker id
    if (/^jp:[0-9a-f]{8}:/i.test(rawInput)) {
      const pick = await resolveJobPickSelection({
        ownerId,
        from,
        input: rawInput,
        twilioMeta: userProfile // best available container (or pass req.body if you have it)
      });

      console.info('[JOB_PICK_IN]', {
        ok: pick.ok,
        reason: pick.reason || null,
        input: rawInput,
        stored: {
          flow: pickPA.payload.flow,
          pickerNonce: pickPA.payload.pickerNonce,
          displayedHash: pickPA.payload.displayedHash,
          pickerMsgSid: pickPA.payload.pickerMsgSid || null
        }
      });

      if (!pick.ok) {
        return await rejectAndResendPicker({
          from,
          ownerId,
          confirmFlowId: confirmFlowId || `${normalizeIdentityDigits(from) || from}:${Date.now()}`,
          jobOptions,
          context: 'expense_jobpick'
        });
      }

      const chosenJobNo = Number(pick.jobNo);
      const chosen = (jobOptions || []).find((j) => Number(j?.job_no) === chosenJobNo) || null;

      if (!chosen) {
        return await rejectAndResendPicker({
          from,
          ownerId,
          confirmFlowId: confirmFlowId || `${normalizeIdentityDigits(from) || from}:${Date.now()}`,
          jobOptions,
          context: 'expense_jobpick'
        });
      }

      // Treat as resolved job
      const resolved = { kind: 'job', job: chosen };

      // ---- APPLY RESOLVED JOB (same as your current block) ----
      const confirmPA = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });

      // Persist active job immediately
      try {
        await persistActiveJobBestEffort({
          ownerId,
          userProfile,
          fromPhone: from,
          jobRow: resolved.job,
          jobNameFallback: resolved.job?.name
        });
      } catch (e) {
        console.warn('[EXPENSE] persistActiveJobBestEffort (pick) failed (ignored):', e?.message);
      }

      const pickedJobName = getJobDisplayName(resolved.job);

      if (confirmPA?.payload?.draft) {
        await upsertPA({
          ownerId,
          userId: from,
          kind: PA_KIND_CONFIRM,
          payload: {
            ...confirmPA.payload,
            draft: {
              ...(confirmPA.payload.draft || {}),
              jobName: pickedJobName,
              jobSource: 'picked',
              job_no: Number(resolved.job.job_no)
            }
          },
          ttlSeconds: PA_TTL_SEC
        });
      }

      try { await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB }); } catch {}

      const confirmPA2 = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });

      const srcText =
        confirmPA2?.payload?.humanLine ||
        confirmPA2?.payload?.summaryLine ||
        confirmPA2?.payload?.draft?.draftText ||
        confirmPA2?.payload?.draft?.originalText ||
        input ||
        '';

      const humanLine =
        buildExpenseSummaryLine({
          amount: confirmPA2?.payload?.draft?.amount,
          item: confirmPA2?.payload?.draft?.item,
          store: confirmPA2?.payload?.draft?.store,
          date: confirmPA2?.payload?.draft?.date,
          jobName: pickedJobName,
          tz,
          sourceText: srcText
        }) || 'Confirm expense?';

      return await sendConfirmExpenseOrFallback(from, humanLine);
    }

    // ---- LEGACY PATH (typed inputs) keep your existing resolver ----
    const displayedJobNos = Array.isArray(pickPA.payload.displayedJobNos) ? pickPA.payload.displayedJobNos : [];
    const resolved = resolveJobOptionFromReply(rawInput, jobOptions, { page, pageSize, displayedJobNos });

    if (!resolved) {
      return out(twimlText('Please reply with a job from the list, a number, job name, "Overhead", or "more".'), false);
    }

    if (resolved.kind === 'overhead') {
      const confirmPA = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });

      if (confirmPA?.payload?.draft && looksLikeNewExpenseText(input)) {
        console.info('[EXPENSE] confirm pause: new expense detected while confirm pending');
        return out(
          twimlText(
            'Hang on one sec 🙂 It looks like you were in the middle of logging something.\n' +
            'Tap Yes/Edit/Change Job/Cancel to finish it. If you want to start fresh, reply "Cancel".'
          ),
          false
        );
      }

      if (confirmPA?.payload?.draft) {
        await upsertPA({
          ownerId,
          userId: from,
          kind: PA_KIND_CONFIRM,
          payload: {
            ...confirmPA.payload,
            draft: { ...(confirmPA.payload.draft || {}), jobName: 'Overhead', jobSource: 'overhead', job_no: null }
          },
          ttlSeconds: PA_TTL_SEC
        });
      }
      try { await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB }); } catch {}
      const line = confirmPA?.payload?.humanLine || confirmPA?.payload?.summaryLine || null;
      return await sendConfirmExpenseOrFallback(from, line || 'Confirm expense?');
    }

    if (resolved.kind === 'job' && resolved.job?.job_no) {
      const confirmPA = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });

      try {
        await persistActiveJobBestEffort({
          ownerId,
          userProfile,
          fromPhone: from,
          jobRow: resolved.job,
          jobNameFallback: resolved.job?.name
        });
      } catch (e) {
        console.warn('[EXPENSE] persistActiveJobBestEffort (pick) failed (ignored):', e?.message);
      }

      const pickedJobName = getJobDisplayName(resolved.job);

      if (confirmPA?.payload?.draft) {
        await upsertPA({
          ownerId,
          userId: from,
          kind: PA_KIND_CONFIRM,
          payload: {
            ...confirmPA.payload,
            draft: {
              ...(confirmPA.payload.draft || {}),
              jobName: pickedJobName,
              jobSource: 'picked',
              job_no: Number(resolved.job.job_no)
            }
          },
          ttlSeconds: PA_TTL_SEC
        });
      }

      try { await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB }); } catch {}

      const confirmPA2 = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });

      const srcText =
        confirmPA2?.payload?.humanLine ||
        confirmPA2?.payload?.summaryLine ||
        confirmPA2?.payload?.draft?.draftText ||
        confirmPA2?.payload?.draft?.originalText ||
        input ||
        '';

      const humanLine =
        buildExpenseSummaryLine({
          amount: confirmPA2?.payload?.draft?.amount,
          item: confirmPA2?.payload?.draft?.item,
          store: confirmPA2?.payload?.draft?.store,
          date: confirmPA2?.payload?.draft?.date,
          jobName: pickedJobName,
          tz,
          sourceText: srcText
        }) || 'Confirm expense?';

      return await sendConfirmExpenseOrFallback(from, humanLine);
    }

    return out(twimlText('Please reply with a job from the list, a number, job name, "Overhead", or "more".'), false);
  }
}


    // ---- 2) Confirm/edit/cancel ----
let confirmPA = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });

// ✅ If user sends a brand new revenue message while confirm draft exists,
// pause and ask them to cancel explicitly (instead of mis-parsing)
if (confirmPA?.payload?.draft && looksLikeNewExpenseText(input)) {
  console.info('[REVENUE] confirm pause: new revenue detected while confirm pending');

  return out(
    twimlText(
      'Hang on one sec 🙂 It looks like you were in the middle of logging something.\n' +
      'If you want to start fresh, just reply "Cancel".'
    ),
    false
  );
}

if (confirmPA?.payload?.draft) {
  if (!isOwner) {
    await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
    return out(twimlText('⚠️ Only the owner can manage revenue.'), false);
  }

  const token = normalizeDecisionToken(input);

  if (token === 'change_job') {
    const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
    if (!jobs.length) return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);
    return await sendJobPickList({
  from,
  ownerId,
  confirmFlowId: stableMsgId,
  jobOptions: jobs,
  page: 0,
  pageSize: 8,
  context: 'expense_jobpick'
});

  }

      if (token === 'edit') {
        await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
        return out(
          twimlText('✏️ Edit expense\nResend it in one line like:\nexpense $84.12 nails from Home Depot today for <job>'),
          false
        );
      }

      if (token === 'cancel') {
        await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
        try {
          await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
        } catch {}
        return out(twimlText('❌ Operation cancelled.'), false);
      }

      if (token === 'yes') {
  const rawDraft = { ...(confirmPA.payload.draft || {}) };

  // Never allow numeric job_id to be written into tx.job_id
  const rawJobId =
    rawDraft?.job_id ?? rawDraft?.jobId ?? rawDraft?.job?.id ?? rawDraft?.job?.job_id ?? null;

  if (rawJobId != null && /^\d+$/.test(String(rawJobId).trim())) {
    console.warn('[EXPENSE] refusing numeric job id; forcing null', { job_id: rawJobId });
    if (rawDraft.job && typeof rawDraft.job === 'object') rawDraft.job.id = null;
    rawDraft.job_id = null;
    rawDraft.jobId = null;
  }

  const maybeJobId = rawJobId != null && looksLikeUuid(String(rawJobId)) ? String(rawJobId).trim() : null;

  let data = normalizeExpenseData(rawDraft, userProfile);

  // Strong Unknown handling
  if (!data.item || isUnknownItem(data.item)) {
    const src =
      rawDraft?.draftText ||
      rawDraft?.originalText ||
      rawDraft?.text ||
      rawDraft?.media_transcript ||
      rawDraft?.mediaTranscript ||
      rawDraft?.input ||
      '';

    // ✅ FIRST: handle the two real-world patterns (dash / "in <item> at")
    let inferred = inferItemFromDashOrInPattern(src);

    // ✅ THEN: your existing patterns
    if (!inferred) inferred = inferItemFromOnPattern(src);
    if (!inferred) inferred = inferExpenseItemFallback(src);
    if (!inferred) inferred = inferItemFromDashOrInPattern(input);
    if (!inferred) inferred = inferItemFromOnPattern(input);
    if (!inferred) inferred = inferExpenseItemFallback(input);

    if (inferred) data.item = inferred;
  }

  if (!data.item || isUnknownItem(data.item)) {
    const fallbackDesc = rawDraft?.item || rawDraft?.description || rawDraft?.desc || rawDraft?.memo || '';
    if (fallbackDesc && !isUnknownItem(fallbackDesc)) {
      data.item = cleanExpenseItemForDisplay(String(fallbackDesc).trim());
    }
  }

  if (!data.item || isUnknownItem(data.item)) data.item = 'Unknown';

  data.store = await normalizeVendorName(ownerId, data.store);
  const category = await resolveExpenseCategory({ ownerId, data, ownerProfile });

  // ---- job resolution ----
  const pickedJobName = data.jobName && String(data.jobName).trim() ? String(data.jobName).trim() : null;

  let jobName = pickedJobName || rawDraft?.jobName || null;
  let jobSource = rawDraft?.jobSource || (pickedJobName ? 'typed' : null);

  let jobNo =
    rawDraft?.job_no != null && Number.isFinite(Number(rawDraft.job_no))
      ? Number(rawDraft.job_no)
      : rawDraft?.job?.job_no != null && Number.isFinite(Number(rawDraft.job.job_no))
        ? Number(rawDraft.job.job_no)
        : null;

  if (!jobName) {
    jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
    if (jobName) jobSource = 'active';
  }

  if (jobName && looksLikeOverhead(jobName)) {
    jobName = 'Overhead';
    jobSource = 'overhead';
    jobNo = null;
  }

  // ✅ CRITICAL: if we have jobNo, canonicalize jobName from DB (fixes “Change Job → wrong name”)
  if (jobNo != null) {
    const canonical = await resolveJobNameByNo(ownerId, jobNo);
    if (canonical) {
      jobName = canonical;
      // if they picked from picker, prefer 'picked'
      if (jobSource !== 'active') jobSource = jobSource || 'picked';
    }
  }

  // still no job -> keep confirm PA and show picker
  if (!jobName) {
    const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));

    await upsertPA({
      ownerId,
      userId: from,
      kind: PA_KIND_CONFIRM,
      payload: {
        ...confirmPA.payload,
        draft: {
          ...data,
          jobName: null,
          jobSource: jobSource || null,
          suggestedCategory: category,
          job_id: maybeJobId || null,
          job_no: jobNo
        },
        sourceMsgId: stableMsgId
      },
      ttlSeconds: PA_TTL_SEC
    });

    if (!jobs.length) return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);
    return await sendJobPickList({
  from,
  ownerId,
  confirmFlowId: stableMsgId,
  jobOptions: jobs,
  page: 0,
  pageSize: 8,
  context: 'expense_jobpick'
});

  }

  data.item = stripEmbeddedDateAndJobFromItem(data.item, { date: data.date, jobName });

  const gate = assertExpenseCILOrClarify({
    ownerId,
    from,
    userProfile,
    data,
    jobName,
    category,
    sourceMsgId: stableMsgId
  });
  if (!gate.ok) return out(twimlText(String(gate.reply || '').slice(0, 1500)), false);

  const amountCents = toCents(data.amount);
  if (!amountCents || amountCents <= 0) throw new Error('Invalid amount');

  const writeResult = await withTimeout(
    insertTransaction(
      {
        ownerId,
        kind: 'expense',
        date: data.date || todayInTimeZone(tz),
        description: String(data.item || '').trim() || 'Unknown',
        amount_cents: amountCents,
        amount: toNumberAmount(data.amount),
        source: String(data.store || '').trim() || 'Unknown',

        // ✅ prefer job_no as job ref (stable), but keep name too
        job: jobNo != null ? String(jobNo) : jobName,
        job_name: jobName,
        job_id: maybeJobId || null, // UUID only
        job_no: jobNo,

        category: category ? String(category).trim() : null,
        user_name: userProfile?.name || 'Unknown User',
        source_msg_id: stableMsgId
      },
      { timeoutMs: 4500 }
    ),
    5200,
    '__DB_TIMEOUT__'
  );

  if (writeResult === '__DB_TIMEOUT__') {
    await upsertPA({
      ownerId,
      userId: from,
      kind: PA_KIND_CONFIRM,
      payload: {
        ...confirmPA.payload,
        draft: {
          ...data,
          jobName,
          jobSource,
          suggestedCategory: category,
          job_id: maybeJobId || null,
          job_no: jobNo
        },
        sourceMsgId: stableMsgId
      },
      ttlSeconds: PA_TTL_SEC
    });

    return out(
      twimlText('⚠️ Saving is taking longer than expected (database slow). Please tap Yes again in a few seconds.'),
      false
    );
  }

  // ✅ Persist active job after success (aligned with identity-based lookup)
try {
  await persistActiveJobBestEffort({
    ownerId,
    userProfile,
    fromPhone: from,
    jobRow: { id: maybeJobId || null, job_no: jobNo, name: jobName },
    jobNameFallback: jobName
  });
} catch (e) {
  console.warn('[EXPENSE] persistActiveJobBestEffort (post-insert) failed (ignored):', e?.message);
}


  // ✅ best available source text to recover item if needed
  const srcText =
    rawDraft?.draftText ||
    rawDraft?.originalText ||
    rawDraft?.text ||
    rawDraft?.input ||
    input ||
    '';

  const summaryLine = buildExpenseSummaryLine({
    amount: data.amount,
    item: data.item,
    store: data.store,
    date: data.date || todayInTimeZone(tz),
    jobName,
    tz,
    sourceText: srcText
  });

  const reply =
    writeResult?.inserted === false
      ? '✅ Already logged (duplicate message).'
      : `✅ Logged expense\n${summaryLine}${category ? `\nCategory: ${category}` : ''}${buildActiveJobHint(jobName, jobSource)}`;

  await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
  try {
    await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
  } catch {}

  return out(twimlText(reply), false);
}


      return out(
        twimlText('⚠️ Please choose Yes, Edit, Cancel, or Change Job.\nTip: reply "change job" to pick a different job.'),
        false
      );
    }

    /* ---- 3) New expense parse (deterministic first) ---- */
    const backstop = deterministicExpenseParse(input, userProfile);
    if (backstop && backstop.amount) {
      const data0 = normalizeExpenseData(backstop, userProfile);
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

      await upsertPA({
        ownerId,
        userId: from,
        kind: PA_KIND_CONFIRM,
        payload: {
          draft: {
            ...data0,
            jobName,
            jobSource,
            suggestedCategory: category,
            job_id: null,
            job_no: null,
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
  return await sendJobPickList({
  from,
  ownerId,
  confirmFlowId: stableMsgId,
  jobOptions: jobs,
  page: 0,
  pageSize: 8,
  context: 'expense_jobpick'
});

}

// ✅ deterministic parse: the best source is the user input itself
const summaryLine = buildExpenseSummaryLine({
  amount: data0.amount,
  item: data0.item,
  store: data0.store,
  date: data0.date,
  jobName,
  tz,
  sourceText: input
});

return await sendConfirmExpenseOrFallback(from, `${summaryLine}${buildActiveJobHint(jobName, jobSource)}`);

    }

    /* ---- 4) AI parsing fallback ---- */
    const defaultData = { date: todayInTimeZone(tz), item: 'Unknown', amount: '$0.00', store: 'Unknown Store' };
    const aiRes = await handleInputWithAI(from, input, 'expense', parseExpenseMessage, defaultData, { tz });

    let data = aiRes?.data || null;
    let aiReply = aiRes?.reply || null;

    if (data) data = normalizeExpenseData(data, userProfile);
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
        userId: from,
        kind: PA_KIND_CONFIRM,
        payload: {
          draft: {
            ...data,
            jobName,
            jobSource,
            suggestedCategory: category,
            job_id: null,
            job_no: null,
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
  return await sendJobPickList({
  from,
  ownerId,
  confirmFlowId: stableMsgId,
  jobOptions: jobs,
  page: 0,
  pageSize: 8,
  context: 'expense_jobpick'
});

}

// ✅ AI parse: prefer draftText/originalText if you stored it, else input
const srcText = input;

const summaryLine = buildExpenseSummaryLine({
  amount: data.amount,
  item: data.item,
  store: data.store,
  date: data.date || todayInTimeZone(tz),
  jobName,
  tz,
  sourceText: srcText
});

return await sendConfirmExpenseOrFallback(from, `${summaryLine}${buildActiveJobHint(jobName, jobSource)}`);

    }

    return out(twimlText(`🤔 Couldn’t parse an expense from "${input}". Try "expense 84.12 nails from Home Depot".`), false);
  } catch (error) {
    console.error(`[ERROR] handleExpense failed for ${from}:`, error?.message, {
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
