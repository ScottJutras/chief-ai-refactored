// handlers/commands/expense.js
// COMPLETE DROP-IN (aligned to revenue.js + webhook Option A)
//
// ✅ Key fixes / alignments:
// - Pending-actions are KIND-AWARE:
//    • Uses pg.getPendingActionByKind / upsertPendingActionByKind / deletePendingActionByKind when present
//    • Otherwise falls back to SQL on public.pending_actions with TTL window (prevents “confirm hijack”)
// - Keeps your JOB_NO-FIRST rule (never trusts numeric job_id)
// - Job picker supports: jobno_<job_no>, numeric replies, exact/prefix job name, overhead, more, change job
// - Confirm flow: confirm PA → optional picker PA → confirm again
// - Returns an object { twiml, sentOutOfBand } (router can also accept string by using .twiml)
// - DB timeout UX: keeps confirm PA and asks user to tap Yes again
// - Keeps trade-term correction + deterministic parse + AI fallback
//
// Signature:
//   handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId)

const pg = require('../../services/postgres');
// Twilio helpers (WhatsApp list + fallback text)
const {
  sendWhatsAppInteractiveList,
  sendWhatsApp,
  sendQuickReply,
  sendTemplateMessage,
  sendTemplateQuickReply,
  toWhatsApp,
} = require('../../services/twilio');
const { toTemplateVar: twilioToTemplateVar, ...rest } = require('../../services/twilio');


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

/* ---------------- Pending Actions (KIND-AWARE) ---------------- */

const PA_KIND_PICK_JOB = 'pick_job_for_expense';
exports.PA_KIND_PICK_JOB = PA_KIND_PICK_JOB;
const PA_KIND_CONFIRM = 'confirm_expense';

const PA_TTL_MIN = Number(process.env.PENDING_TTL_MIN || 10);
const PA_TTL_SEC = PA_TTL_MIN * 60;
exports.PA_TTL_SEC = PA_TTL_SEC;

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

  // Preferred helper
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

  // SQL fallback with TTL window (prevents old PA reuse)
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
      [String(owner).replace(/\D/g, ''), String(user), k, String(PA_TTL_MIN)]
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

  console.info('[PA] upsert', {
    ownerId: String(owner).replace(/\D/g, ''),
    userId: String(user),
    kind: k
  });

  const ttl = Number(ttlSeconds || PA_TTL_SEC) || PA_TTL_SEC;

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
      [String(owner).replace(/\D/g, ''), String(user), String(k), JSON.stringify(payload || {})]
    );
  } catch (e) {
    // If no unique index exists, fall back to delete+insert
    try {
      await query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [
        String(owner).replace(/\D/g, ''),
        String(user),
        String(k)
      ]);
      await query(
        `
        INSERT INTO public.pending_actions (owner_id, user_id, kind, payload, created_at)
        VALUES ($1, $2, $3, $4::jsonb, NOW())
        `,
        [String(owner).replace(/\D/g, ''), String(user), String(k), JSON.stringify(payload || {})]
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
      String(owner).replace(/\D/g, ''),
      String(user),
      String(k)
    ]);
  } catch {}
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

/* ---------------- Twilio helpers ---------------- */

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

// Structured return (router can also just do res.send(r.twiml))
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
      .replace(/[\r\n\t]+/g, ' ')     // no newlines/tabs
      .replace(/\s{2,}/g, ' ')        // collapse spaces
      .trim()
      .slice(0, 900) || '—'
  );
}

async function sendWhatsAppTemplate({ to, templateSid, summaryLine }) {
  const client = getTwilioClient();
  const { waFrom, messagingServiceSid } = getSendFromConfig();

  if (!to) throw new Error('Missing "to"');
  if (!templateSid) throw new Error('Missing templateSid');

  const toClean = String(to).startsWith('whatsapp:') ? String(to) : `whatsapp:${String(to).replace(/^whatsapp:/, '')}`;

  const payload = {
    to: toClean,
    contentSid: templateSid,
    contentVariables: JSON.stringify({ '1': toTemplateVar(summaryLine) })
  };

  if (waFrom) payload.from = waFrom;
  else payload.messagingServiceSid = messagingServiceSid;

  const TIMEOUT_MS = 2500;
  const msg = await Promise.race([
    client.messages.create(payload),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Twilio send timeout')), TIMEOUT_MS))
  ]);

  return msg;
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

/* ---------------- helpers ---------------- */

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
  if (!s) return s;

  // ✅ 0) Preserve canonical tokens FIRST (prevents "jobix_6" -> "ix_6")
  if (/^jobno_\d{1,10}$/i.test(s)) return s.toLowerCase();
  if (/^jobix_\d{1,10}$/i.test(s)) return s.toLowerCase();

  // ✅ 1) If visible text contains stamped job number like "J8", convert to jobno_8
  // Example inbound ListTitle: "#3 J8 1559 MedwayPark Dr"
  const mStamp = s.match(/\bJ(\d{1,10})\b/i);
  if (mStamp?.[1]) return `jobno_${mStamp[1]}`;

  // ✅ 2) Twilio template list id format from Content Template:
  // Example: "job_6_112407c4" -> this "6" is the ROW INDEX, not job_no.
  const mTw = s.match(/^job_(\d{1,10})_[0-9a-z]+$/i);
  if (mTw?.[1]) return `jobix_${mTw[1]}`;

  // Keep "#3 ..." for resolver (it may be index). No-op.

  // Existing cleanup (safe now because tokens are already returned above)
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

function inferExpenseItemFallback(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;

  const rules = [
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

  const m = t.match(/\bof\s+([a-z0-9][a-z0-9\s\-]{2,40})\b/);
  if (m?.[1]) {
    const guess = m[1].trim();
    if (!guess.includes('unknown') && !guess.includes('stuff')) {
      return guess.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  return null;
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

  if (d.jobSource != null) {
    const js = String(d.jobSource).trim();
    d.jobSource = js || null;
  }

  if (d.job_no != null && !Number.isFinite(Number(d.job_no))) d.job_no = null;

  return d;
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

  // 1) "worth of <item>"
  const worthOf = raw.match(
  /\bworth\s+of\s+(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\bfor\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i);
  if (worthOf?.[1]) item = String(worthOf[1]).trim();

  // ✅ 2) "$4000 -Degreaser at Home Hardware ..." OR "$4000 - tar removal materials at ..."
  // (handles both hyphen styles; keeps it conservative so we don’t eat store/date/job)
  if (!item) {
    const dashItem = raw.match(
      /\$\s*[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?\s*-\s*(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\bfor\b|[.?!]|$)/i
    );
    if (dashItem?.[1]) item = String(dashItem[1]).trim();
  }

  // 3) "for <item> from/at <store>" (but avoid "for job X")
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

/* ---------------- Job list + picker mapping (JOB_NO-FIRST) ---------------- */
function sanitizeJobLabel(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ') // NBSP -> normal space
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function normalizeIdentityDigits(x) {
  const s = String(x || '').trim();
  if (!s) return null;
  return s.replace(/^whatsapp:/i, '').replace(/^\+/, '').replace(/\D/g, '') || null;
}
// Back-compat alias (some code calls normalizeIdentity)
function normalizeIdentity(x) {
  return normalizeIdentityDigits(x);
}

// Token / garbage job names that should NEVER be shown or selected
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

  // ✅ reject token garbage first
  if (looksLikeJobTokenName(lc)) return true;

  // reject obvious command-y “names”
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

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const jobNo = j?.job_no != null ? Number(j.job_no) : (j?.jobNo != null ? Number(j.jobNo) : null);
    if (jobNo == null || !Number.isFinite(jobNo)) continue;

    const rawId = j?.id != null ? String(j.id) : (j?.job_id != null ? String(j.job_id) : null);
    const safeUuidId = rawId && looksLikeUuid(rawId) ? rawId : null;

    out.push({ id: safeUuidId, job_no: jobNo, name });
  }

  return out;
}


function resolveJobOptionFromReply(rawInput, jobOptions, opts = {}) {
  const s = String(rawInput || '').trim();

  const jobList = Array.isArray(jobOptions) ? jobOptions : [];
  const page = Number(opts.page || 0) || 0;
  const pageSize = Number(opts.pageSize || 8) || 8;

  // ✅ the exact job_nos that were shown on screen (1..N mapping)
  const displayedJobNos = Array.isArray(opts.displayedJobNos) ? opts.displayedJobNos : null;

  // overhead
  if (/^(overhead|oh)$/i.test(s)) return { kind: 'overhead' };

  // "more"
  if (/^more(\s+jobs)?…?$/i.test(s)) return { kind: 'more' };

  // ---- A) Twilio list tap token: jobix_N ----
  // ✅ THIS is where you were wrong before.
  const mIx = s.match(/^jobix_(\d{1,10})$/i);
  if (mIx) {
    const ix = Number(mIx[1]);
    if (Number.isFinite(ix) && ix >= 1) {
      // Prefer the displayed mapping first
      if (displayedJobNos && displayedJobNos.length >= ix) {
        const jobNo = Number(displayedJobNos[ix - 1]);
        const job = jobList.find(j => Number(j?.job_no) === jobNo);
        if (job) return { kind: 'job', job: { job_no: Number(job.job_no), name: job.name || job.job_name || null } };
        return null;
      }

      // fallback: old behavior (page-local index), but less safe
      const start = page * pageSize;
      const candidate = jobList[start + (ix - 1)];
      if (candidate?.job_no != null) {
        return { kind: 'job', job: { job_no: Number(candidate.job_no), name: candidate.name || candidate.job_name || null } };
      }
    }
    return null;
  }

  // ---- B) stable token jobno_<job_no> ----
  const mNo = s.match(/^jobno_(\d{1,10})$/i);
  if (mNo) {
    const jobNo = Number(mNo[1]);
    const job = jobList.find(j => Number(j?.job_no) === jobNo);
    return job ? { kind: 'job', job: { job_no: Number(job.job_no), name: job.name || job.job_name || null } } : null;
  }

  // ---- C) numeric reply "1" means row 1 of *displayed slice* ----
  if (/^\d{1,10}$/.test(s)) {
    const ix = Number(s);
    if (Number.isFinite(ix) && ix >= 1) {
      if (displayedJobNos && displayedJobNos.length >= ix) {
        const jobNo = Number(displayedJobNos[ix - 1]);
        const job = jobList.find(j => Number(j?.job_no) === jobNo);
        return job ? { kind: 'job', job: { job_no: Number(job.job_no), name: job.name || job.job_name || null } } : null;
      }

      const start = page * pageSize;
      const candidate = jobList[start + (ix - 1)];
      if (candidate?.job_no != null) {
        return { kind: 'job', job: { job_no: Number(candidate.job_no), name: candidate.name || candidate.job_name || null } };
      }
    }
    return null;
  }

  // ---- D) name match (case-insensitive) ----
  const lc = s.toLowerCase();
  const byName = jobList.find(j => String(j?.name || j?.job_name || '').trim().toLowerCase() === lc);
  if (byName?.job_no != null) {
    return { kind: 'job', job: { job_no: Number(byName.job_no), name: byName.name || byName.job_name || null } };
  }

  return null;
}



const ENABLE_INTERACTIVE_LIST = (() => {
  const raw = process.env.TWILIO_ENABLE_INTERACTIVE_LIST ?? process.env.TWILIO_ENABLE_LIST_PICKER ?? 'true';
  return String(raw).trim().toLowerCase() !== 'false';
})();
exports.ENABLE_INTERACTIVE_LIST = ENABLE_INTERACTIVE_LIST;

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

  // Normal template path
  const payload = {
    to: toClean,
    contentSid: String(templateSid).trim(),
    // ✅ Also include body as a safety net (optional but helpful)
    body: safeBody,
    contentVariables: JSON.stringify({ '1': toTemplateVar(summaryLine) })
  };

  if (waFrom) payload.from = waFrom;
  else payload.messagingServiceSid = messagingServiceSid;

  return client.messages.create(payload);
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

  return `Which job is this expense for?\n\n${lines.join('\n')}\n\nReply with a number, job name, or "Overhead".${more}\nTip: reply "change job" to see the picker.`;
}
exports.buildTextJobPrompt = buildTextJobPrompt;
function looksLikeNewExpenseText(s = '') {
  const lc = String(s || '').trim().toLowerCase();
  if (!lc) return false;

  // strong prefix
  if (/^(expense|exp)\b/.test(lc)) return true;

  // NL expense signals (keep it simple, fast, low false-positive)
  return /\b(spent|bought|purchase|purchased|paid|receipt|cost|home\s*depot|rona|lowe'?s|home\s*hardware|beacon)\b/.test(lc)
    && /\$?\s*\d+(\.\d{1,2})?\b/.test(lc);
}
async function sendJobPickerOrFallback({ from, ownerId, jobOptions, page = 0, pageSize = 8 }) {
  const to = waTo(from);
  const JOBS_PER_PAGE = Math.min(8, Math.max(1, Number(pageSize || 8)));
  const p = Math.max(0, Number(page || 0));
  const start = p * JOBS_PER_PAGE;

  // ✅ Filter + de-dupe by job_no, and drop token-garbage names
  const seen = new Set();
  const clean = [];
  for (const j of (jobOptions || [])) {
    const n = j?.job_no != null ? Number(j.job_no) : null;
    if (n == null || !Number.isFinite(n)) continue;

    const nm = String(j?.name || j?.job_name || '').trim();
    if (!nm || isGarbageJobName(nm)) continue;

    if (seen.has(n)) continue;
    seen.add(n);

    clean.push({
      ...j,
      job_no: n,
      name: nm
    });
  }

  const slice = clean.slice(start, start + JOBS_PER_PAGE);

  // ✅ exact row order that the user sees (1-based index mapping)
  const displayedJobNos = (slice || [])
    .map((j) => (j?.job_no != null ? Number(j.job_no) : null))
    .filter((n) => Number.isFinite(n));

  const hasMore = start + JOBS_PER_PAGE < clean.length;

  await upsertPA({
    ownerId,
    userId: from,
    kind: PA_KIND_PICK_JOB,
    payload: {
      jobOptions: clean,
      page: p,
      pageSize: JOBS_PER_PAGE,
      hasMore,
      displayedJobNos,
      shownAt: Date.now()
    },
    ttlSeconds: PA_TTL_SEC
  });

  if (!ENABLE_INTERACTIVE_LIST || !to) {
    return out(twimlText(buildTextJobPrompt(clean, p, JOBS_PER_PAGE)), false);
  }

  const rows = slice.map((j) => {
    const full = sanitizeJobLabel(j?.name || j?.job_name || 'Untitled Job');
    const jobNo = Number(j?.job_no);

    const stamped = `J${jobNo} ${full}`;

    return {
      // IMPORTANT: list row ids should be stable
      id: `jobno_${jobNo}`,
      title: stamped.slice(0, 24),
      description: full.slice(0, 72)
    };
  });



  rows.push({ id: 'overhead', title: 'Overhead', description: 'Not tied to a job' });
  if (hasMore) rows.push({ id: 'more', title: 'More jobs…', description: 'Show next page' });

  const bodyText =
    `Pick a job (${start + 1}-${Math.min(start + JOBS_PER_PAGE, clean.length)} of ${clean.length}).` +
    `\n\nTip: You can also reply with a number (like "1").`;

  try {
    await sendWhatsAppInteractiveList({
      to,
      bodyText,
      buttonText: 'Pick a job',
      sections: [{ title: 'Active Jobs', rows }]
    });

    // ✅ IMPORTANT (Mode B):
    // Do NOT send a second plain-text WhatsApp message here.
    // Twilio-level DOUBLE_SEND_LIST_FALLBACK will do that when enabled.
    return out(twimlEmpty(), true);
  } catch (e) {
    console.warn('[JOB_PICKER] interactive list failed; falling back:', e?.message);
    return out(twimlText(buildTextJobPrompt(clean, p, JOBS_PER_PAGE)), false);
  }
}



/* ---------------- Active job resolution ---------------- */

let _ACTIVE_JOB_IDENTITY_OK = null;

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
    if (looksLikeJobTokenName(s)) continue; // never accept token garbage
    if (/^overhead$/i.test(s)) return 'Overhead';
    return s;
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

    const safeName =
      jobName && !looksLikeJobTokenName(jobName) ? String(jobName).trim() : null;

    const n = jobNo != null && Number.isFinite(Number(jobNo)) ? Number(jobNo) : null;

    // don’t persist overhead unless you explicitly want it
    if (safeName && /^overhead$/i.test(safeName)) return false;

    if (typeof pg.setActiveJobForIdentity === 'function') {
      // IMPORTANT: your postgres.js treats numeric jobId as job_no (job_no-first)
      await pg.setActiveJobForIdentity(owner, identity, n != null ? String(n) : null, safeName);
      console.info('[EXPENSE] persisted active job after log', { owner, identity, jobNo: n, jobName: safeName });
      return true;
    }

    // legacy fallback
    if (typeof pg.setActiveJob === 'function') {
      const jobRef = safeName || (n != null ? String(n) : null);
      if (!jobRef) return false;
      await pg.setActiveJob(owner, identity, jobRef);
      console.info('[EXPENSE] persisted active job via pg.setActiveJob after log', { owner, identity, jobRef });
      return true;
    }

    return false;
  } catch (e) {
    console.warn('[EXPENSE] persistActiveJobFromExpense failed (ignored):', e?.message);
    return false;
  }
}


async function resolveActiveJobName({ ownerId, userProfile, fromPhone }) {
  // 0) profile direct (but reject token garbage)
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

  // 1) Preferred: identity-based getter
  if (typeof pg.getActiveJobForIdentity === 'function') {
    try {
      const out = await pg.getActiveJobForIdentity(owner, identity);
      _ACTIVE_JOB_IDENTITY_OK = true;

      const n = pickActiveJobNameFromAny(out);
      if (n) return n;

      return null;
    } catch (e) {
      const msg = String(e?.message || '').toLowerCase();
      const code = String(e?.code || '');
      // disable on schema/table missing patterns
      if (code === '42P01' || msg.includes('memberships')) {
        _ACTIVE_JOB_IDENTITY_OK = false;
      }
      // fail-open
    }
  }

  // 2) Optional fallbacks (safe no-ops if missing)
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

function looksLikeJobPickerAnswer(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return false;

  if (/^(overhead|oh)$/i.test(s)) return true;
  if (/^more(\s+jobs)?…?$/i.test(s)) return true;

  // numeric reply (row index)
  if (/^\d{1,10}$/.test(s)) return true;

  // stable tokens
  if (/^jobno_\d{1,10}$/i.test(s)) return true;
  if (/^jobix_\d{1,10}$/i.test(s)) return true;

  // other legacy-ish tokens
  if (/^job_\d{1,10}_[0-9a-z]+$/i.test(s)) return true;
  if (/^#\s*\d{1,10}\b/.test(s)) return true;
  if (/\bJ\d{1,10}\b/i.test(s)) return true;

  // allow name attempts, reject obvious commands
  if (/^[a-z0-9][a-z0-9 _.'-]{2,}$/i.test(s)) {
    const lc = s.toLowerCase();
    if (/^(yes|no|edit|cancel|stop|change job|switch job|pick job|active jobs|show jobs|jobs)$/i.test(lc)) return false;
    return true;
  }

  return false;
}

if (pickPA?.payload?.jobOptions) {
  // If the user sent a brand new expense while we were waiting for a job pick,
  // clear state and fall through to normal parsing (do NOT return).
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
    const displayedJobNos = Array.isArray(pickPA.payload.displayedJobNos) ? pickPA.payload.displayedJobNos : null;

    const rawInput = String(input || '').trim();

    console.info('[EXPENSE] pick-job inbound', {
      input: rawInput,
      normalized: normalizeJobAnswer(rawInput),
      page,
      pageSize,
      jobsCount: jobOptions.length,
      displayedJobNosCount: Array.isArray(displayedJobNos) ? displayedJobNos.length : 0
    });

    if (tok === 'change_job') {
      return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page, pageSize });
    }

    if (tok === 'more') {
      if (!hasMore) {
        return out(twimlText('No more jobs to show. Reply with a number, job name, or "Overhead".'), false);
      }
      return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page: page + 1, pageSize });
    }

    if (!looksLikeJobPickerAnswer(rawInput)) {
      return out(twimlText('Please reply with a number, job name, "Overhead", or "more".'), false);
    }

    // ✅ IMPORTANT: pass displayedJobNos so jobix_N maps to the exact rendered rows
    const resolved = resolveJobOptionFromReply(rawInput, jobOptions, { page, pageSize, displayedJobNos });

    if (!resolved) {
      // If user tapped a list row, don't force a second reply: re-show picker.
      const looksLikeListTap =
        /^jobix_\d{1,10}$/i.test(rawInput) ||
        /^job_\d{1,10}_[0-9a-z]+$/i.test(rawInput) ||
        /^#\s*\d{1,10}\b/.test(rawInput);

      console.warn('[EXPENSE] pick-job could not resolve selection; reshowing picker', {
        rawInput,
        normalized: normalizeJobAnswer(rawInput),
        page,
        pageSize,
        hasMore,
        firstOptions: (jobOptions || []).slice(0, 12).map(j => ({ job_no: j?.job_no, name: j?.name }))
      });

      if (looksLikeListTap) {
        return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page, pageSize });
      }

      return out(twimlText('Please reply with a number, job name, "Overhead", or "more".'), false);
    }

    console.info('[EXPENSE] pick-job resolved', { input: rawInput, resolved, page, pageSize });

    if (resolved.kind === 'overhead') {
      const confirmPA = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
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

      if (confirmPA?.payload?.draft) {
        await upsertPA({
          ownerId,
          userId: from,
          kind: PA_KIND_CONFIRM,
          payload: {
            ...confirmPA.payload,
            draft: {
              ...(confirmPA.payload.draft || {}),
              jobName: resolved.job.name || null,
              jobSource: 'picked',
              job_no: Number(resolved.job.job_no)
            }
          },
          ttlSeconds: PA_TTL_SEC
        });
      }

      try { await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB }); } catch {}

      // re-fetch to build the freshest humanLine
      const confirmPA2 = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });

      const humanLine =
        buildExpenseSummaryLine({
          amount: confirmPA2?.payload?.draft?.amount,
          item: confirmPA2?.payload?.draft?.item,
          store: confirmPA2?.payload?.draft?.store,
          date: confirmPA2?.payload?.draft?.date,
          jobName: resolved.job.name || null,
          tz
        }) || 'Confirm expense?';

      return await sendConfirmExpenseOrFallback(from, humanLine);
    }

    return out(twimlText('Please reply with a number, job name, "Overhead", or "more".'), false);
  }
}



// ---- 2) Confirm/edit/cancel ----
const confirmPA = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });

if (confirmPA?.payload?.draft) {
  if (!isOwner) {
    await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
    return out(twimlText('⚠️ Only the owner can manage expenses.'), false);
  }

  const token = normalizeDecisionToken(input);
  const stableMsgId = String(confirmPA?.payload?.sourceMsgId || safeMsgId || '').trim() || null;

  if (token === 'change_job') {
    const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
    if (!jobs.length) return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);
    return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
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
    try { await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB }); } catch {}
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


// ✅ Strong Unknown handling (covers "Unknown", "Unknown ...", empty, etc.)
if (isUnknownItem(data.item)) {
  const src =
    rawDraft?.draftText ||
    rawDraft?.originalText ||
    rawDraft?.text ||
    rawDraft?.media_transcript ||
    rawDraft?.mediaTranscript ||
    rawDraft?.input ||
    '';

  let inferred = inferExpenseItemFallback(src);
  if (!inferred) inferred = inferExpenseItemFallback(input);
  if (inferred) data.item = inferred;
}

// ✅ Ensure item survives confirm->yes even if draft used "description"/"memo"
if (!data.item || isUnknownItem(data.item)) {
  const fallbackDesc =
    rawDraft?.item ||
    rawDraft?.description ||
    rawDraft?.desc ||
    rawDraft?.memo ||
    '';

  if (fallbackDesc && !isUnknownItem(fallbackDesc)) {
    data.item = cleanExpenseItemForDisplay(String(fallbackDesc).trim());
  }
}

// ✅ Strong Unknown handling (covers "Unknown", "Unknown ...", empty, etc.)
if (!data.item || isUnknownItem(data.item)) {
  const src =
    rawDraft?.draftText ||
    rawDraft?.originalText ||
    rawDraft?.text ||
    rawDraft?.media_transcript ||
    rawDraft?.mediaTranscript ||
    rawDraft?.input ||
    '';

  let inferred = inferExpenseItemFallback(src);
  if (!inferred) inferred = inferExpenseItemFallback(input);
  if (inferred) data.item = inferred;
}

// final safety
if (!data.item || isUnknownItem(data.item)) data.item = 'Unknown';

data.store = await normalizeVendorName(ownerId, data.store);
const category = await resolveExpenseCategory({ ownerId, data, ownerProfile });

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

// If still no job, keep confirm PA and show picker
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
  return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
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
      job: jobName,
      job_name: jobName,
      job_id: maybeJobId || null, // UUID only
      job_no: jobNo,              // job_no-first
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

// ✅ Persist active job after a successful log (even if duplicate)
try {
  await persistActiveJobFromExpense({
    ownerId,
    fromPhone: from,
    userProfile,
    jobNo,
    jobName
  });
} catch (e) {
  console.warn('[EXPENSE] persistActiveJobFromExpense failed (ignored):', e?.message);
}


// ✅ Persist active job after a successful log (even if duplicate)
await persistActiveJobFromExpense({
  ownerId,
  fromPhone: from,
  userProfile,
  jobNo,
  jobName
});

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
    ? '✅ Already logged (duplicate message).'
    : `✅ Logged expense\n${summaryLine}${category ? `\nCategory: ${category}` : ''}${buildActiveJobHint(jobName, jobSource)}`;

await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
try { await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB }); } catch {}

return out(twimlText(reply), false);

  }

  return out(
    twimlText('⚠️ Please choose Yes, Edit, Cancel, or Change Job.\nTip: reply "change job" to pick a different job.'),
    false
  );
}


    // ---- 3) New expense parse (deterministic first) ----
    const backstop = deterministicExpenseParse(input, userProfile);
if (backstop && backstop.amount) {
  const data0 = normalizeExpenseData(backstop, userProfile);
  data0.store = await normalizeVendorName(ownerId, data0.store);

  // ✅ add this block right here
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

      // ✅ Persist a text source so YES-path can recover item names reliably
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
        return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
      }

      const summaryLine = buildExpenseSummaryLine({
        amount: data0.amount,
        item: data0.item,
        store: data0.store,
        date: data0.date,
        jobName,
        tz
      });

      return await sendConfirmExpenseOrFallback(from, `${summaryLine}${buildActiveJobHint(jobName, jobSource)}`);
    }

    // ---- 4) AI parsing fallback ----
    const defaultData = { date: todayInTimeZone(tz), item: 'Unknown', amount: '$0.00', store: 'Unknown Store' };
    const aiRes = await handleInputWithAI(from, input, 'expense', parseExpenseMessage, defaultData, { tz });

    let data = aiRes?.data || null;
    let aiReply = aiRes?.reply || null;

    if (data) data = normalizeExpenseData(data, userProfile);
if (data?.jobName) data.jobName = sanitizeJobNameCandidate(data.jobName);

// ✅ add this block right here
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

      // ✅ Persist source text (fixes "Edit -> Unknown" regressions)
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
        return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
      }

      const summaryLine = buildExpenseSummaryLine({
        amount: data.amount,
        item: data.item,
        store: data.store,
        date: data.date || todayInTimeZone(tz),
        jobName,
        tz
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

// Backwards compatibility: if your router expects a string, it can do:
// const r = await handleExpense(...); res.send(typeof r === 'string' ? r : r.twiml);
module.exports = { handleExpense };
