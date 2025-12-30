// handlers/commands/expense.js
// COMPLETE DROP-IN (Option A): pending_actions-driven confirm + job picker
//
// ✅ Fixes in this drop-in:
// - ✅ FIX: numeric reply "1" no longer becomes job_id="1" (maps to UUID from stored jobOptions)
// - ✅ FIX: interactive list row ids now carry the *job UUID* (job_1_<uuid>) when available
// - ✅ FIX: if list picker UI fails to display, fallback message includes job names (so user can still pick)
// - ✅ Keep: trade-term correction layer (Gentek, siding, soffit/fascia/eavestrough)
// - ✅ Keep: uses deletePendingActionByKind + kind-aware pending action helpers
// - ✅ Keep: confirm template sending + TwiML fallback
//
// Notes:
// - We only pass job_id to insertTransaction when it is a UUID.
// - If your DB/jobs table truly uses UUID ids (as your error indicates), listOpenJobsDetailed must return those UUIDs.

const pg = require('../../services/postgres');
const { query, insertTransaction } = pg;

const getCategorySuggestion =
  (typeof pg.getCategorySuggestion === 'function' && pg.getCategorySuggestion) || (async () => null);

const normalizeVendorName =
  (typeof pg.normalizeVendorName === 'function' && pg.normalizeVendorName) ||
  (typeof pg.normalizeVendor === 'function' && pg.normalizeVendor) ||
  (async (_ownerId, vendor) => {
    const s = String(vendor || '').trim();
    return s || 'Unknown Store';
  });

const ai = require('../../utils/aiErrorHandler');
const handleInputWithAI = ai.handleInputWithAI;
const parseExpenseMessage = ai.parseExpenseMessage;

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

// ---- CIL validator (fail-open) ----
const cilMod = require('../../cil');
const validateCIL =
  (cilMod && typeof cilMod.validateCIL === 'function' && cilMod.validateCIL) ||
  (cilMod && typeof cilMod.validateCil === 'function' && cilMod.validateCil) ||
  (cilMod && typeof cilMod.validate === 'function' && cilMod.validate) ||
  (typeof cilMod === 'function' && cilMod) ||
  null;

/* ---------------- Pending Actions (Option A) ---------------- */

const PA_KIND_PICK_JOB = 'pick_job_for_expense';
const PA_KIND_CONFIRM = 'confirm_expense';

// Prefer kind-aware helpers
const pgUpsertPendingAction =
  (typeof pg.upsertPendingAction === 'function' && pg.upsertPendingAction) ||
  (typeof pg.savePendingAction === 'function' && pg.savePendingAction) ||
  null;

const pgGetPendingActionByKind =
  (typeof pg.getPendingActionByKind === 'function' && pg.getPendingActionByKind) ||
  (typeof pg.getPendingAction === 'function' && pg.getPendingAction) ||
  null;

const pgDeletePendingActionByKind =
  (typeof pg.deletePendingActionByKind === 'function' && pg.deletePendingActionByKind) || null;

async function upsertPA({ ownerId, userId, kind, payload, ttlSeconds = 600 }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  if (!owner || !user || !kind) return;

  if (pgUpsertPendingAction) {
    try {
      await pgUpsertPendingAction({ ownerId: owner, userId: user, kind, payload, ttlSeconds });
      return;
    } catch (e) {
      console.warn('[PA] upsertPendingAction failed; falling back:', e?.message);
    }
  }

  // Fallback SQL (best effort)
  try {
    await query(
      `
      INSERT INTO public.pending_actions (owner_id, user_id, kind, payload, created_at)
      VALUES ($1, $2, $3, $4::jsonb, NOW())
      ON CONFLICT (owner_id, user_id, kind)
      DO UPDATE SET payload = EXCLUDED.payload,
                    created_at = NOW()
      `,
      [String(owner).replace(/\D/g, ''), String(user), String(kind), JSON.stringify(payload || {})]
    );
  } catch (e) {
    console.warn('[PA] upsert fallback failed (ignored):', e?.message);
  }
}

async function getPA({ ownerId, userId, kind }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  const k = String(kind || '').trim();
  if (!owner || !user || !k) return null;

  if (pgGetPendingActionByKind) {
    try {
      const r = await pgGetPendingActionByKind({ ownerId: owner, userId: user, kind: k });
      return r || null;
    } catch (e) {
      console.warn('[PA] getPendingActionByKind failed (ignored):', e?.message);
    }
  }

  // SQL fallback
  try {
    const r = await query(
      `
      SELECT id, kind, payload, created_at
        FROM public.pending_actions
       WHERE owner_id = $1
         AND user_id = $2
         AND kind = $3
       ORDER BY created_at DESC
       LIMIT 1
      `,
      [String(owner).replace(/\D/g, ''), String(user), k]
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
    } catch (e) {
      console.warn('[PA] deletePendingActionByKind failed; falling back:', e?.message);
    }
  }

  // Fallback SQL
  try {
    await query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [
      String(owner).replace(/\D/g, ''),
      String(user),
      k
    ]);
  } catch {}
}

/* ---------------- Trade-term correction layer (STT + parsing robustness) ---------------- */

function correctTradeTerms(text) {
  let s = String(text || '');

  // Gentek
  s = s.replace(/\bgen\s*tech\b/gi, 'Gentek');
  s = s.replace(/\bgentech\b/gi, 'Gentek');
  s = s.replace(/\bgentek\b/gi, 'Gentek');

  // Siding
  s = s.replace(/\bsighting\b/gi, 'siding');

  // Other common contractor terms
  s = s.replace(/\bsoffet\b/gi, 'soffit');
  s = s.replace(/\bfacia\b/gi, 'fascia');
  s = s.replace(/\beaves\s*trough\b/gi, 'eavestrough');

  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/* ---------------- Twilio Template / Messaging helpers ---------------- */

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

function twimlEmpty() {
  return `<Response></Response>`;
}

function waTo(from) {
  const d = String(from || '').replace(/\D/g, '');
  return d ? `whatsapp:+${d}` : null;
}

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
  if (!waFrom && !messagingServiceSid) {
    throw new Error('Missing TWILIO_WHATSAPP_FROM or TWILIO_MESSAGING_SERVICE_SID');
  }
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

async function sendWhatsAppTemplate({ to, templateSid, summaryLine }) {
  const client = getTwilioClient();
  const { waFrom, messagingServiceSid } = getSendFromConfig();

  if (!to) throw new Error('Missing "to"');
  if (!templateSid) throw new Error('Missing templateSid');

  const toClean = String(to).startsWith('whatsapp:')
    ? String(to)
    : `whatsapp:${String(to).replace(/^whatsapp:/, '')}`;

  const payload = {
    to: toClean,
    contentSid: templateSid,
    contentVariables: JSON.stringify({ '1': String(summaryLine || '').slice(0, 900) })
  };

  if (waFrom) payload.from = waFrom;
  else payload.messagingServiceSid = messagingServiceSid;

  const TIMEOUT_MS = 2500;
  const msg = await Promise.race([
    client.messages.create(payload),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Twilio send timeout')), TIMEOUT_MS))
  ]);

  console.info('[TEMPLATE] sent', {
    to: payload.to,
    from: payload.from || null,
    messagingServiceSid: payload.messagingServiceSid || null,
    contentSid: payload.contentSid,
    sid: msg?.sid || null,
    status: msg?.status || null
  });

  return msg;
}

function buildActiveJobHint(jobName, jobSource) {
  if (jobSource !== 'active' || !jobName) return '';
  return `\n\n🧠 Using active job: ${jobName}\nTip: reply "change job" to pick another`;
}

async function sendConfirmExpenseOrFallback(from, summaryLine) {
  const sid = getExpenseConfirmTemplateSid();
  const to = waTo(from);

  console.info('[EXPENSE] confirm template attempt', { from, to, hasSid: !!sid, sid: sid || null });

  if (sid && to) {
    try {
      await sendWhatsAppTemplate({ to, templateSid: sid, summaryLine });
      console.info('[EXPENSE] confirm template sent OK', { to, sid });
      return twimlEmpty();
    } catch (e) {
      console.warn('[EXPENSE] template send failed; falling back to TwiML:', e?.message);
    }
  }

  return twimlText(
    `✅ Confirm expense\n${summaryLine}\n\nReply: Yes / Edit / Cancel / Change Job`
  );
}

/* ---------------- helpers ---------------- */

function normalizeDecisionToken(input) {
  const s = String(input || '').trim().toLowerCase();

  // Button payloads / friendly variants
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
  s = s.replace(/^(edit\s+)?expense\s*:\s*/i, '');
  s = s.replace(/^edit\s*:\s*/i, '');
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
  s = s.replace(/^(job\s*name|job)\s*[:\-]?\s*/i, '');
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
  let s = String(item || '').trim();

  if (date) {
    const d = String(date).trim();
    if (d) s = s.replace(new RegExp(`\\bon\\s+${escapeRegExp(d)}\\b`, 'ig'), ' ');
  }

  if (jobName) {
    const j = String(jobName).trim();
    if (j) {
      s = s.replace(/\bfor\s+job\s+.+$/i, ' ');
      s = s.replace(new RegExp(`\\bfor\\s+${escapeRegExp(j)}\\b.*$`, 'i'), ' ');
    }
  }

  s = s.replace(/\bfor\s+a\s+job\b/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s || 'Unknown';
}
function inferExpenseItemFallback(text = '') {
  const s = String(text || '').trim();
  if (!s) return null;

  // Common: "purchased $383 of lumber today at Convoy Supply"
  // Capture after "of" up to a stop word.
  const m1 = s.match(/\bof\s+([^.,;]+?)(?:\s+\b(today|yesterday|on|at|from|for)\b|[.,;]|$)/i);
  if (m1 && m1[1]) return String(m1[1]).trim();

  // Another common: "spent $50 on nails"
  const m2 = s.match(/\bon\s+([^.,;]+?)(?:\s+\b(today|yesterday|on|at|from|for)\b|[.,;]|$)/i);
  if (m2 && m2[1]) return String(m2[1]).trim();

  // Another: "$50 nails at Home Depot"
  const m3 = s.match(/\$\s*\d[\d,]*(?:\.\d{1,2})?\s+([^.,;]+?)(?:\s+\b(at|from|for|today|yesterday|on)\b|[.,;]|$)/i);
  if (m3 && m3[1]) return String(m3[1]).trim();

  return null;
}
async function consumePendingMediaMeta(state, from) {
  try {
    const pending = await state.getPendingTransactionState(from);
    const m = pending?.pendingMediaMeta || null;
    if (!m) return null;

    // OPTIONAL: clear after consuming so it doesn't leak into next txn
    // If you prefer "merge" only, set to null fields.
    if (typeof state.mergePendingTransactionState === 'function') {
      await state.mergePendingTransactionState(from, { pendingMediaMeta: null });
    }

    return {
      media_url: m.url || null,
      media_type: m.type || null,
      media_transcript: m.transcript || null,
      media_confidence: m.confidence ?? null,
      source_msg_id: m.source_msg_id || null
    };
  } catch {
    return null;
  }
}


/**
 * ✅ Prevent jobName becoming a copy of the description:
 */
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

function buildExpenseSummaryLine({ amount, item, store, date, jobName, tz }) {
  const amt = String(amount || '').trim();
  const it = cleanExpenseItemForDisplay(item);
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


/* ---------------- category heuristics ---------------- */

function vendorDefaultCategory(store) {
  const s = String(store || '').toLowerCase();
  if (/(home depot|homedepot|rona|lowe|lowes|home hardware|convoy|gentek|abc supply|beacon|roofmart|kent)/i.test(s)) {
    return 'Materials';
  }
  if (/(esso|shell|petro|ultramar|pioneer|circle\s*k)/i.test(s)) return 'Fuel';
  return null;
}

function inferExpenseItemFallback(text) {
  const t = String(text || '').toLowerCase();

  // Most common trade materials
  const rules = [
    { re: /\blumber\b|\b2x4\b|\b2x6\b|\bplywood\b|\bosb\b|\bstud(s)?\b/, item: 'Lumber' },
    { re: /\bshingle(s)?\b|\broofing\b|\bunderlayment\b|\bice\s*&?\s*water\b/, item: 'Roofing materials' },
    { re: /\bnail(s)?\b|\bscrew(s)?\b|\bfastener(s)?\b|\bdeck\s*screw(s)?\b/, item: 'Fasteners' },
    { re: /\bcaulk\b|\bsealant\b|\badhesive\b|\bglue\b/, item: 'Sealants/adhesives' },
    { re: /\bconcrete\b|\bmortar\b|\bgrout\b|\bquikrete\b/, item: 'Concrete' },
    { re: /\binsulation\b|\bfoam\b|\bvapou?r\s*barrier\b/, item: 'Insulation' },
    { re: /\bpaint\b|\bprimer\b|\bstain\b/, item: 'Paint' },
    { re: /\btool(s)?\b|\bblade(s)?\b|\bbit(s)?\b|\bsaw\b/, item: 'Tools/supplies' },
  ];

  for (const r of rules) {
    if (r.re.test(t)) return r.item;
  }

  // Pattern: "$123 of X"
  const m = t.match(/\bof\s+([a-z0-9][a-z0-9\s\-]{2,40})\b/);
  if (m?.[1]) {
    const guess = m[1].trim();
    if (!guess.includes('unknown') && !guess.includes('stuff')) {
      // title-case-ish
      return guess.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  return null;
}


function formatMoneyDisplay(n) {
  try {
    const fmt = new Intl.NumberFormat('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `$${fmt.format(n)}`;
  } catch {
    return `$${n.toFixed(2)}`;
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

  return d;
}

/* --------- deterministic parser (kept + jobName sanity) --------- */

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
  const raw = String(input || '').trim();
  if (!raw) return null;

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
  const worthOf = raw.match(/\bworth\s+of\s+(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\bfor\b|[.?!]|$)/i);
  if (worthOf?.[1]) item = String(worthOf[1]).trim();

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

async function resolveExpenseCategory({ ownerId, data, ownerProfile }) {
  const vendor = String(data?.store || '').trim() || 'Unknown Store';
  const itemText = String(data?.item || '').trim();

  if (data?.suggestedCategory && String(data.suggestedCategory).trim()) {
    return String(data.suggestedCategory).trim();
  }

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

/* ---------------- Job list + Option A mapping ---------------- */

function stableHash(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function isGarbageJobName(name) {
  const lc = String(name || '').trim().toLowerCase();
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
      .map((x) => ({
        id: x.id || null,
        job_no: x.job_no ?? null,
        name: x.name ? String(x.name).trim() : null
      }))
      .filter((j) => j.name && !isGarbageJobName(j.name));
  } catch {
    if (typeof pg.listOpenJobs === 'function') {
      try {
        const names = await pg.listOpenJobs(ownerId, { limit });
        return (names || [])
          .map((n) => ({ id: null, job_no: null, name: String(n || '').trim() }))
          .filter((j) => j.name && !isGarbageJobName(j.name));
      } catch {}
    }
  }

  return [];
}

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str || ''));
}

function normalizeJobOptions(jobRows) {
  const out = [];
  const seen = new Set();

  for (const j of jobRows || []) {
    const name = String(j?.name || '').trim();
    if (!name) continue;
    if (isGarbageJobName(name)) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // ✅ IMPORTANT: your jobs.id is integer text ("1"), but transactions.job_id is UUID.
    // So we only keep id if it's a UUID; otherwise null.
    const rawId = j?.id != null ? String(j.id) : null;
    const safeUuidId = rawId && looksLikeUuid(rawId) ? rawId : null;

    out.push({
      id: safeUuidId, // ✅ null in your current schema, and that's correct
      job_no: j?.job_no != null ? Number(j.job_no) : null,
      name
    });
  }
  return out;
}


/**
 * ✅ Robust: resolve job selection from:
 * - "job_3_<uuid>" interactive id
 * - "3" numeric
 * - job name
 */
function resolveJobOptionFromReply(input, jobOptions, { page = 0, pageSize = 8 } = {}) {
  const raw = normalizeJobAnswer(input);
  const t = String(raw || '').trim();
  if (!t) return null;

  const lc = t.toLowerCase();

  // --- special tokens ---
  if (looksLikeOverhead(t)) return { kind: 'overhead' };
  if (lc === 'more' || lc === 'more jobs' || lc === 'more jobs…') return { kind: 'more' };

  const p = Math.max(0, Number(page || 0));
  const ps = Math.min(8, Math.max(1, Number(pageSize || 8)));

  // --- interactive id: jobno_<job_no> ---
  const mJobNo = t.match(/^jobno_(\d{1,10})$/i);
  if (mJobNo?.[1]) {
    const jobNo = Number(mJobNo[1]);
    if (!Number.isFinite(jobNo)) return null;

    const opt = (jobOptions || []).find((j) => Number(j?.job_no) === jobNo) || null;
    if (!opt) return null;

    return {
      kind: 'job',
      job: {
        job_no: Number(opt.job_no),
        name: String(opt.name || opt.job_name || '').trim() || null
      }
    };
  }

  // --- numeric reply: maps to CURRENT PAGE (1..N on that page) ---
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return null;

    const start = p * ps;
    const idx = start + (n - 1);

    const opt = (jobOptions || [])[idx] || null;
    if (!opt) return null;

    const jobNo = opt?.job_no != null ? Number(opt.job_no) : null;
    if (jobNo == null || !Number.isFinite(jobNo)) return null;

    return {
      kind: 'job',
      job: {
        job_no: jobNo,
        name: String(opt.name || opt.job_name || '').trim() || null
      }
    };
  }

  // --- typed name lookup (exact or prefix) ---
  const opt =
    (jobOptions || []).find((j) => String(j?.name || j?.job_name || '').trim().toLowerCase() === lc) ||
    (jobOptions || []).find((j) =>
      String(j?.name || j?.job_name || '').trim().toLowerCase().startsWith(lc.slice(0, 24))
    ) ||
    null;

  if (opt) {
    const jobNo = opt?.job_no != null ? Number(opt.job_no) : null;
    if (jobNo == null || !Number.isFinite(jobNo)) return null;

    return {
      kind: 'job',
      job: {
        job_no: jobNo,
        name: String(opt.name || opt.job_name || '').trim() || null
      }
    };
  }

  // job_no-only mode: if it doesn't match, reprompt
  return null;
}



const ENABLE_INTERACTIVE_LIST = (() => {
  const raw = process.env.TWILIO_ENABLE_INTERACTIVE_LIST ?? process.env.TWILIO_ENABLE_LIST_PICKER ?? 'true';
  return String(raw).trim().toLowerCase() !== 'false';
})();

async function sendWhatsAppInteractiveList({ to, bodyText, buttonText, sections }) {
  const client = getTwilioClient();
  const { waFrom, messagingServiceSid } = getSendFromConfig();

  if (!to) throw new Error('Missing "to"');

  const payload = {
    to: String(to).startsWith('whatsapp:') ? String(to) : `whatsapp:${String(to).replace(/^whatsapp:/, '')}`,
    ...(waFrom ? { from: waFrom } : { messagingServiceSid }),
    body: String(bodyText || '').slice(0, 1600),

    // ✅ WhatsApp interactive list for Twilio Messaging API:
    // Use persistentAction with "action=" + JSON string.
    persistentAction: [
      `action=${JSON.stringify({
        type: 'list',
        body: { text: String(bodyText || '').slice(0, 1024) },
        action: {
          button: String(buttonText || 'Pick a job').slice(0, 20),
          sections: Array.isArray(sections) ? sections : []
        }
      })}`
    ]
  };

  const TIMEOUT_MS = 3500;
  const msg = await Promise.race([
    client.messages.create(payload),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Twilio send timeout')), TIMEOUT_MS))
  ]);

  console.info('[INTERACTIVE_LIST] sent', { to: payload.to, sid: msg?.sid || null, status: msg?.status || null });
  return msg;
}


function buildTextJobPrompt(jobOptions, page, pageSize) {
  const p = Math.max(0, Number(page || 0));
  const ps = Math.min(8, Math.max(1, Number(pageSize || 8)));

  const start = p * ps;
  const slice = (jobOptions || []).slice(start, start + ps);

  // IMPORTANT: numbers displayed are 1..N *for this page*
  const lines = slice.map((j, i) => {
    const name = String(j?.name || j?.job_name || 'Untitled Job').trim();
    const jobNo = j?.job_no != null ? Number(j.job_no) : null;
    const prefix = jobNo != null && Number.isFinite(jobNo) ? `#${jobNo} ` : '';
    return `${i + 1}) ${prefix}${name}`;
  });

  const hasMore = start + ps < (jobOptions || []).length;
  const more = hasMore ? `\nReply "more" for more jobs.` : '';

  return `Which job is this expense for?\n\n${lines.join(
    '\n'
  )}\n\nReply with a number, job name, or "Overhead".${more}\nTip: reply "change job" to see the picker.`;
}


/**
 * ✅ If the list-picker UI fails to show, the user still sees job names right in the message.
 */
function buildBodyTextWithNames(jobOptions, start, count) {
  const slice = (jobOptions || []).slice(start, start + count);
  const lines = slice.map((j, i) => `${start + i + 1}) ${j?.name || 'Untitled Job'}`);
  const extra = lines.length ? `\n\n${lines.join('\n')}` : '';
  return extra;
}

async function sendJobPickerOrFallback({ from, ownerId, jobOptions, page = 0, pageSize = 8 }) {
  const to = waTo(from);
  const JOBS_PER_PAGE = Math.min(8, Math.max(1, Number(pageSize || 8)));
  const p = Math.max(0, Number(page || 0));
  const start = p * JOBS_PER_PAGE;

  // job_no-only: only include jobs with a usable job_no
  const clean = (jobOptions || []).filter((j) => {
    const n = j?.job_no != null ? Number(j.job_no) : null;
    return n != null && Number.isFinite(n);
  });

  const slice = clean.slice(start, start + JOBS_PER_PAGE);
  const hasMore = start + JOBS_PER_PAGE < clean.length;

  // ✅ Persist picker context so replies resolve correctly
  await upsertPA({
    ownerId,
    userId: from,
    kind: PA_KIND_PICK_JOB,
    payload: {
      jobOptions: clean,          // IMPORTANT: store filtered list
      page: p,
      pageSize: JOBS_PER_PAGE,
      hasMore,
      shownAt: Date.now()
    },
    ttlSeconds: 600
  });

  // Text fallback
  if (!ENABLE_INTERACTIVE_LIST || !to) {
    return twimlText(buildTextJobPrompt(clean, p, JOBS_PER_PAGE));
  }

  const rows = [];
  for (let i = 0; i < slice.length; i++) {
    const full = String(slice[i]?.name || slice[i]?.job_name || 'Untitled Job').trim();
    const jobNo = Number(slice[i].job_no);

    rows.push({
      id: `jobno_${jobNo}`,
      title: full.slice(0, 24),
      description: `#${jobNo} ${full.slice(0, 72)}`
    });
  }

  rows.push({ id: 'overhead', title: 'Overhead', description: 'Not tied to a job' });
  if (hasMore) {
    rows.push({
      id: 'more',
      title: 'More jobs…',
      description: `Show next page`
    });
  }

  const bodyText =
    `Pick a job (${start + 1}-${Math.min(start + JOBS_PER_PAGE, clean.length)} of ${clean.length}).` +
    `\n\nTip: You can also reply with a number (like "1").`;

  try {
    const r = await sendWhatsAppInteractiveList({
      to,
      bodyText,
      buttonText: 'Pick a job',
      sections: [{ title: 'Active Jobs', rows }]
    });

    console.info('[JOB_PICKER] interactive sent', { to, ok: true, sid: r?.sid || null });
    return twimlEmpty();
  } catch (e) {
    console.warn('[JOB_PICKER] interactive list failed; falling back:', e?.message);
    return twimlText(buildTextJobPrompt(clean, p, JOBS_PER_PAGE));
  }
}



/* ---------------- Active job resolution (aligned + self-disabling) ---------------- */

// cache: null = unknown, false = don't call, true = ok
let _ACTIVE_JOB_IDENTITY_OK = null;

async function resolveActiveJobName({ ownerId, userProfile, fromPhone }) {
  const directName = userProfile?.active_job_name || userProfile?.activeJobName || null;
  if (directName && String(directName).trim()) return String(directName).trim();

  if (_ACTIVE_JOB_IDENTITY_OK === false) return null;

  if (typeof pg.getActiveJobForIdentity === 'function') {
    try {
      const out = await pg.getActiveJobForIdentity(String(ownerId), String(fromPhone));
      _ACTIVE_JOB_IDENTITY_OK = true;

      const n = out?.active_job_name || out?.activeJobName || null;
      if (n && String(n).trim()) return String(n).trim();
    } catch (e) {
      const msg = String(e?.message || '').toLowerCase();
      const code = String(e?.code || '');

      // If memberships table is missing, permanently stop calling to avoid log spam.
      if (code === '42P01' || msg.includes('relation "public.memberships" does not exist') || msg.includes('public.memberships')) {
        _ACTIVE_JOB_IDENTITY_OK = false;
        return null;
      }

      // otherwise: fail open
    }
  }

  return null;
}


/* ---------------- CIL builders (kept) ---------------- */

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

/* ---------------- main handler ---------------- */

async function handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  input = correctTradeTerms(stripExpensePrefixes(input));

  const lockKey = `lock:${from}`;
  const safeMsgId = String(sourceMsgId || `${from}:${Date.now()}`).trim();

  try {
    const lock = require('../../middleware/lock');
    if (lock?.acquireLock) await lock.acquireLock(lockKey, 8000).catch(() => null);
  } catch {}

  try {
    const tz = userProfile?.timezone || userProfile?.tz || 'UTC';

    // ---- 1) Awaiting job pick ----
const pickPA = await getPA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
if (pickPA?.payload?.jobOptions) {
  const tok = normalizeDecisionToken(input);
  const jobOptions = Array.isArray(pickPA.payload.jobOptions) ? pickPA.payload.jobOptions : [];
  const page = Number(pickPA.payload.page || 0) || 0;
  const pageSize = Number(pickPA.payload.pageSize || 8) || 8;
  const hasMore = !!pickPA.payload.hasMore;

  if (tok === 'change_job') return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page, pageSize });

  if (tok === 'more') {
    if (!hasMore) return twimlText('No more jobs to show. Reply with a number, job name, or "Overhead".');
    return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page: page + 1, pageSize });
  }

  const resolved = resolveJobOptionFromReply(input, jobOptions, { page, pageSize });
  if (!resolved) return twimlText('Please reply with a number, job name, "Overhead", or "more".');

  const confirm = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
  if (!confirm?.payload?.draft) {
    await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
    return twimlText('Got it. Now resend the expense details.');
  }

  if (resolved.kind === 'overhead') {
    confirm.payload.draft.jobName = 'Overhead';
    confirm.payload.draft.jobSource = 'overhead';
    confirm.payload.draft.job = { id: null, job_no: null, name: 'Overhead' };
    confirm.payload.draft.job_id = null;
  } else if (resolved.kind === 'job') {
    const jobName = resolved.job?.name ? String(resolved.job.name).trim() : null;
    const jobNo =
      resolved.job?.job_no != null && Number.isFinite(Number(resolved.job.job_no))
        ? Number(resolved.job.job_no)
        : null;

    confirm.payload.draft.jobName = jobName || confirm.payload.draft.jobName || null;
    confirm.payload.draft.jobSource = 'picked';

    confirm.payload.draft.job = {
      id: null,
      job_no: jobNo,
      name: jobName || null
    };

    // job_no-only: never set tx.job_id from the picker
    confirm.payload.draft.job_id = null;
  } else if (resolved.kind === 'more') {
    return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page: page + 1, pageSize });
  } else {
    return twimlText('Please reply with a number, job name, "Overhead", or "more".');
  }

  await upsertPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM, payload: confirm.payload, ttlSeconds: 600 });
  await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });

  const s = buildExpenseSummaryLine({
    amount: confirm.payload.draft.amount,
    item: confirm.payload.draft.item,
    store: confirm.payload.draft.store,
    date: confirm.payload.draft.date,
    jobName: confirm.payload.draft.jobName,
    tz
  });

  return await sendConfirmExpenseOrFallback(from, s);
}

    // ---- 2) Confirm/edit/cancel ----
const confirmPA = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });

if (confirmPA?.payload?.draft) {
  if (!isOwner) {
    await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
    return twimlText('⚠️ Only the owner can manage expenses.');
  }

  const token = normalizeDecisionToken(input);
  const stableMsgId = String(confirmPA?.payload?.sourceMsgId || safeMsgId || '').trim() || null;

  if (token === 'change_job') {
    const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
    if (!jobs.length) return twimlText('No jobs found. Reply "Overhead" or create a job first.');
    // IMPORTANT: this will return twimlEmpty() if interactive list was sent successfully
    return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
  }

  if (token === 'edit') {
    await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
    return twimlText(
  `✏️ Edit expense\nResend it in one line like:\nexpense $84.12 nails from Home Depot "date/today" for <job>`
);

  }

  if (token === 'cancel') {
    await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
    // Also clear the picker PA (prevents “cancel didn’t work” feel)
    try {
      await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
    } catch {}
    return twimlText('❌ Operation cancelled.');
  }

  if (token === 'yes') {
    // Work on a copy so we can mutate safely
    const rawDraft = { ...(confirmPA.payload.draft || {}) };

    // Pull *any* job id signal
    const rawJobId =
      rawDraft?.job_id ??
      rawDraft?.jobId ??
      rawDraft?.job?.id ??
      rawDraft?.job?.job_id ??
      null;

    // 🔒 HARD GUARD: refuse numeric ids (your jobs.id is integer; tx.job_id is UUID)
    if (rawJobId != null && /^\d+$/.test(String(rawJobId).trim())) {
      console.warn('[EXPENSE] refusing numeric job id; forcing null', { job_id: rawJobId });
      if (rawDraft.job && typeof rawDraft.job === 'object') rawDraft.job.id = null;
      rawDraft.job_id = null;
      rawDraft.jobId = null;
    }

    // ✅ Keep UUID only
    const maybeJobId =
      rawJobId != null && looksLikeUuid(String(rawJobId)) ? String(rawJobId).trim() : null;

    // Normalize expense payload
    let data = normalizeExpenseData(rawDraft, userProfile);

    // Fallback item inference ("$383 of lumber ...")
    if (!data.item || !String(data.item).trim() || String(data.item).trim().toLowerCase() === 'unknown') {
      const src =
        rawDraft?.draftText ||
        rawDraft?.originalText ||
        rawDraft?.text ||
        rawDraft?.media_transcript ||
        rawDraft?.mediaTranscript ||
        '';
      const inferred = inferExpenseItemFallback(src);
      if (inferred) data.item = inferred;
    }

    data.store = await normalizeVendorName(ownerId, data.store);

    const category = await resolveExpenseCategory({ ownerId, data, ownerProfile });

    const pickedJobName =
  rawDraft.jobName && String(rawDraft.jobName).trim() ? String(rawDraft.jobName).trim() : null;

// Prefer what we already knew from PA (picker/overhead/etc)
let jobSource = rawDraft?.jobSource || (pickedJobName ? 'typed' : null);

let jobName = pickedJobName || null;

if (!jobName) {
  jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;

  // Only call it "active" if we didn't already have a stronger source
  if (jobName && !jobSource) jobSource = 'active';
}

if (jobName && looksLikeOverhead(jobName)) {
  jobName = 'Overhead';
  jobSource = 'overhead';
}




    // If still no jobName, ask them to pick one
    if (!jobName) {
      const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));

      await upsertPA({
        ownerId,
        userId: from,
        kind: PA_KIND_CONFIRM,
        payload: {
          ...confirmPA.payload,
          // Keep the draft in PA, but never store numeric job_id
          draft: {
  ...data,
  jobName: null,
  jobSource: jobSource || null,
  suggestedCategory: category,
  job_id: maybeJobId || null
},


          sourceMsgId: stableMsgId
        },
        ttlSeconds: 600
      });

      return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
    }

    // Ensure item doesn’t include embedded job/date
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
    if (!gate.ok) return twimlText(String(gate.reply || '').slice(0, 1500));

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
          job: jobName,
          job_name: jobName,

          // ✅ UUID only, otherwise null
          job_id: null,
          job_no: rawDraft?.job?.job_no != null ? Number(rawDraft.job.job_no) : null,


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
  job_id: maybeJobId || null
},

          sourceMsgId: stableMsgId
        },
        ttlSeconds: 600
      });

      return twimlText('⚠️ Saving is taking longer than expected (database slow). Please tap Yes again in a few seconds.');
    }
const activeHint =
  jobSource === 'active'
    ? `\n\n🧠 Using active job: ${jobName}\nTip: reply "change job" to pick another`
    : '';

    const summaryLine = buildExpenseSummaryLine({
      amount: data.amount,
      item: data.item,
      store: data.store,
      date: data.date || todayInTimeZone(tz),
      jobName,
      tz
    });

   const reply =
  writeResult?.inserted === false
    ? `✅ Already logged (duplicate message).`
    : `✅ Logged expense\n${summaryLine}${category ? `\nCategory: ${category}` : ''}${activeHint}`;



    await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
    // Cleanup picker too
    try {
      await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
    } catch {}

    return twimlText(reply);
  }

  return twimlText('⚠️ Please choose Yes, Edit, Cancel, or Change Job.\nTip: reply "change job" to pick a different job.');
}

    // ---- 3) New expense parse (deterministic first) ----
const backstop = deterministicExpenseParse(input, userProfile);
if (backstop && backstop.amount) {
  const data0 = normalizeExpenseData(backstop, userProfile);
  data0.store = await normalizeVendorName(ownerId, data0.store);

  let category = await resolveExpenseCategory({ ownerId, data: data0, ownerProfile });
  if (category && String(category).trim()) category = String(category).trim();
  else category = null;

  // Job resolution + source
  let jobName = data0.jobName || null;
  let jobSource = jobName ? 'typed' : 'unknown';

  if (!jobName) {
    jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
    if (jobName) jobSource = 'active';
  }

  if (jobName && looksLikeOverhead(jobName)) {
    jobName = 'Overhead';
    jobSource = 'overhead';
  }

  // ✅ Strip embedded date/job from item once jobName is known
  if (jobName) {
    data0.item = stripEmbeddedDateAndJobFromItem(data0.item, { date: data0.date, jobName });
  }

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
        job: jobName ? { id: null, job_no: null, name: jobName } : null,
        job_id: null
      },
      sourceMsgId: safeMsgId,
      type: 'expense'
    },
    ttlSeconds: 600
  });

  if (!jobName) {
    const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
    return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
  }

  const activeHint =
  jobSource === 'active'
    ? `\n\n🧠 Using active job: ${jobName}\nTip: reply "change job" to pick another`
    : '';

  const summaryLine = buildExpenseSummaryLine({
    amount: data0.amount,
    item: data0.item,
    store: data0.store,
    date: data0.date,
    jobName,
    tz
  });

  return await sendConfirmExpenseOrFallback(from, `${summaryLine}${activeHint}`);
}

// ---- 4) AI parsing fallback ----
const defaultData = {
  date: todayInTimeZone(tz),
  item: 'Unknown',
  amount: '$0.00',
  store: 'Unknown Store'
};

const aiRes = await handleInputWithAI(from, input, 'expense', parseExpenseMessage, defaultData, { tz });

let data = aiRes?.data || null;
let aiReply = aiRes?.reply || null;

if (data) data = normalizeExpenseData(data, userProfile);
if (data?.jobName) data.jobName = sanitizeJobNameCandidate(data.jobName);

const missingCore =
  !data ||
  !data.amount ||
  data.amount === '$0.00' ||
  !data.item ||
  data.item === 'Unknown' ||
  !data.store ||
  data.store === 'Unknown Store';

if (aiReply && missingCore) return twimlText(aiReply);

if (data && data.amount && data.amount !== '$0.00') {
  data.store = await normalizeVendorName(ownerId, data.store);

  let category = await resolveExpenseCategory({ ownerId, data, ownerProfile });
  if (category && String(category).trim()) category = String(category).trim();
  else category = null;

  // Job resolution + source (same logic as deterministic path)
  let jobName = data.jobName || null;
  let jobSource = jobName ? 'typed' : 'unknown';

  if (!jobName) {
    jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
    if (jobName) jobSource = 'active';
  }

  if (jobName && looksLikeOverhead(jobName)) {
    jobName = 'Overhead';
    jobSource = 'overhead';
  }

  // ✅ Strip embedded date/job from item once jobName is known
  if (jobName) {
    data.item = stripEmbeddedDateAndJobFromItem(data.item, { date: data.date, jobName });
  }

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

        // expense schema: job_id stays null (UUID-only); job_no comes from picker later
        job_id: null
      },
      sourceMsgId: safeMsgId,
      type: 'expense'
    },
    ttlSeconds: 600
  });

  if (!jobName) {
    const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
    return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
  }

  const activeHint =
  jobSource === 'active'
    ? `\n\n🧠 Using active job: ${jobName}\nTip: reply "change job" to pick another`
    : '';

  const summaryLine = buildExpenseSummaryLine({
    amount: data.amount,
    item: data.item,
    store: data.store,
    date: data.date || todayInTimeZone(tz),
    jobName,
    tz
  });

  return await sendConfirmExpenseOrFallback(from, `${summaryLine}${activeHint}`);
}

return twimlText(`🤔 Couldn’t parse an expense from "${input}". Try "expense 84.12 nails from Home Depot".`);

  } catch (error) {
    console.error(`[ERROR] handleExpense failed for ${from}:`, error?.message, {
      code: error?.code,
      detail: error?.detail,
      constraint: error?.constraint
    });
    return twimlText('⚠️ Error logging expense. Please try again.');
  } finally {
    try {
      const lock = require('../../middleware/lock');
      if (lock?.releaseLock) await lock.releaseLock(lockKey);
    } catch {}
  }
}

module.exports = { handleExpense };
