// handlers/commands/expense.js
// COMPLETE DROP-IN (Option A): store jobOptions (id/job_no/name) in pending_actions
// - Fixes "invalid input syntax for uuid: '1'" by mapping numeric replies -> job object (never uuid-cast)
// - Fixes Twilio Interactive List error by including TOP-LEVEL `body` in create(payload)
// - Keeps your existing parsing + category + CIL validation + template confirm + lock + idempotent insertTransaction
//
// REQUIRED in postgres.js (preferred):
//   - upsertPendingAction({ ownerId, userId, kind, payload, ttlSeconds })
//   - getPendingAction({ ownerId, userId, kind })   (or readPendingAction / fetchPendingAction / etc.)
//   - deletePendingAction({ ownerId, userId, kind })
//
// If those are not present, this file will try direct SQL against public.pending_actions as a fallback.

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

const pgUpsertPendingAction =
  (typeof pg.upsertPendingAction === 'function' && pg.upsertPendingAction) ||
  (typeof pg.savePendingAction === 'function' && pg.savePendingAction) ||
  null;

const pgGetPendingAction =
  (typeof pg.getPendingAction === 'function' && pg.getPendingAction) ||
  (typeof pg.readPendingAction === 'function' && pg.readPendingAction) ||
  (typeof pg.fetchPendingAction === 'function' && pg.fetchPendingAction) ||
  null;

const pgDeletePendingAction =
  (typeof pg.deletePendingAction === 'function' && pg.deletePendingAction) ||
  (typeof pg.clearPendingAction === 'function' && pg.clearPendingAction) ||
  null;

async function upsertPA({ ownerId, userId, kind, payload, ttlSeconds = 600 }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  if (!owner || !user || !kind) return;

  if (pgUpsertPendingAction) {
    await pgUpsertPendingAction({ ownerId: owner, userId: user, kind, payload, ttlSeconds });
    return;
  }

  // Fallback SQL (expects: public.pending_actions(owner_id,user_id,kind,payload,expires_at,created_at/updated_at))
  try {
    await query(
      `
      INSERT INTO public.pending_actions (owner_id, user_id, kind, payload, expires_at)
      VALUES ($1, $2, $3, $4::jsonb, NOW() + ($5 || ' seconds')::interval)
      ON CONFLICT (owner_id, user_id, kind)
      DO UPDATE SET payload = EXCLUDED.payload,
                    expires_at = EXCLUDED.expires_at
      `,
      [owner, user, String(kind), JSON.stringify(payload || {}), Number(ttlSeconds || 600)]
    );
  } catch (e) {
    console.warn('[PA] upsert fallback failed (ignored):', e?.message);
  }
}

async function getPA({ ownerId, userId, kind }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  if (!owner || !user || !kind) return null;

  if (pgGetPendingAction) {
    try {
      const r = await pgGetPendingAction({ ownerId: owner, userId: user, kind });
      // allow either {payload} or the payload itself
      if (!r) return null;
      if (r.payload) return r;
      if (typeof r === 'object') return { payload: r };
      return null;
    } catch (e) {
      console.warn('[PA] getPendingAction failed (ignored):', e?.message);
    }
  }

  try {
    const r = await query(
      `
      SELECT payload
        FROM public.pending_actions
       WHERE owner_id = $1
         AND user_id = $2
         AND kind = $3
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1
      `,
      [owner, user, String(kind)]
    );
    const row = r?.rows?.[0];
    if (!row) return null;
    return { payload: row.payload || null };
  } catch (e) {
    return null;
  }
}

async function deletePA({ ownerId, userId, kind }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  if (!owner || !user || !kind) return;

  if (pgDeletePendingAction) {
    try {
      await pgDeletePendingAction({ ownerId: owner, userId: user, kind });
      return;
    } catch (e) {
      console.warn('[PA] deletePendingAction failed (ignored):', e?.message);
    }
  }

  try {
    await query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [
      owner,
      user,
      String(kind)
    ]);
  } catch {}
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
    `Please confirm this Expense:\n${summaryLine}\n\nReply yes/edit/cancel.\nTip: reply "change job" to pick a different job.`
  );
}

/* ---------------- WhatsApp Interactive List ---------------- */

const ENABLE_INTERACTIVE_LIST = (() => {
  const raw = process.env.TWILIO_ENABLE_INTERACTIVE_LIST ?? process.env.TWILIO_ENABLE_LIST_PICKER ?? 'true';
  return String(raw).trim().toLowerCase() !== 'false';
})();

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

function buildTextJobPrompt(jobOptions, page, pageSize) {
  const start = page * pageSize;
  const slice = (jobOptions || []).slice(start, start + pageSize);
  const lines = slice.map((j, i) => `${start + i + 1}) ${j?.name || 'Untitled Job'}`);
  const hasMore = start + pageSize < (jobOptions || []).length;

  const more = hasMore ? `\nReply "more" for more jobs.` : '';
  return `Which job is this expense for?\n\n${lines.join(
    '\n'
  )}\n\nReply with a number, job name, or "Overhead".${more}\nTip: reply "change job" to see the picker.`;
}

async function sendWhatsAppInteractiveList({ to, bodyText, buttonText, sections }) {
  const client = getTwilioClient();
  const { waFrom, messagingServiceSid } = getSendFromConfig();

  const payload = {
    to,
    ...(waFrom ? { from: waFrom } : { messagingServiceSid }),

    // ✅ Fix: Twilio requires either `body` or media in the message create call
    body: String(bodyText || '').slice(0, 1600),

    interactive: {
      type: 'list',
      body: { text: String(bodyText || '').slice(0, 1024) },
      action: {
        button: String(buttonText || 'Pick a job').slice(0, 20),
        sections
      }
    }
  };

  const TIMEOUT_MS = 3000;
  const msg = await Promise.race([
    client.messages.create(payload),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Twilio send timeout')), TIMEOUT_MS))
  ]);

  console.info('[INTERACTIVE_LIST] sent', {
    to: payload.to,
    from: payload.from || null,
    messagingServiceSid: payload.messagingServiceSid || null,
    sid: msg?.sid || null,
    status: msg?.status || null
  });

  return msg;
}

/* ---------------- helpers ---------------- */

const MAX_MEDIA_TRANSCRIPT_CHARS =
  (typeof pg.MEDIA_TRANSCRIPT_MAX_CHARS === 'number' && pg.MEDIA_TRANSCRIPT_MAX_CHARS) || 8000;

const truncateText =
  (typeof pg.truncateText === 'function' && pg.truncateText) ||
  ((str, maxChars) => {
    if (!str) return null;
    const s = String(str);
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars);
  });

function normalizeDecisionToken(input) {
  const s = String(input || '').trim().toLowerCase();
  if (s === 'yes' || s === 'y' || s === 'confirm') return 'yes';
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
    String(str || '')
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

function buildExpenseSummaryLine({ amount, item, store, date, jobName }) {
  const amt = String(amount || '').trim();
  const it = cleanExpenseItemForDisplay(item);
  const st = String(store || '').trim() || 'Unknown Store';
  const dt = String(date || '').trim();
  const jb = jobName ? String(jobName).trim() : '';

  const itLower = it.toLowerCase();
  const parts = [];
  parts.push(`Expense: ${amt} for ${it}`);
  if (st && st !== 'Unknown Store' && !itLower.includes(`from ${st.toLowerCase()}`)) parts.push(`from ${st}`);
  if (dt && !itLower.includes(dt.toLowerCase())) parts.push(`on ${dt}`);
  if (jb && !itLower.includes(jb.toLowerCase())) parts.push(`for ${jb}`);
  return parts.join(' ') + '.';
}

/* ---------------- Active job resolution (aligned) ---------------- */

async function resolveActiveJobName({ ownerId, userProfile, fromPhone }) {
  const ownerParam = String(ownerId || '').trim();

  const directName = userProfile?.active_job_name || userProfile?.activeJobName || null;
  if (directName && String(directName).trim()) return String(directName).trim();

  // Canonical in postgres.js (NOTE: your postgres.js replacement expects (ownerId, userId), so we pass fromPhone)
  if (typeof pg.getActiveJobForIdentity === 'function') {
    try {
      const out = await pg.getActiveJobForIdentity(String(ownerId), String(fromPhone));
      const n = out?.active_job_name || out?.activeJobName || null;
      if (n && String(n).trim()) return String(n).trim();

      const ref = out?.active_job_id ?? out?.activeJobId ?? null;
      if (ref != null) {
        const s = String(ref).trim();
        if (looksLikeUuid(s)) {
          const r = await query(
            `select coalesce(name, job_name) as job_name
               from public.jobs
              where owner_id = $1 and id = $2::uuid
              limit 1`,
            [ownerParam, s]
          );
          if (r?.rows?.[0]?.job_name) return String(r.rows[0].job_name).trim();
        }
        if (/^\d+$/.test(s)) {
          const r = await query(
            `select coalesce(name, job_name) as job_name
               from public.jobs
              where owner_id = $1 and job_no = $2::int
              limit 1`,
            [ownerParam, Number(s)]
          );
          if (r?.rows?.[0]?.job_name) return String(r.rows[0].job_name).trim();
        }
      }
    } catch (e) {
      console.warn('[EXPENSE] resolveActiveJobName failed (ignored):', e?.message);
    }
  }

  return null;
}

/* ---------------- category heuristics ---------------- */

function vendorDefaultCategory(store) {
  const s = String(store || '').toLowerCase();
  if (
    /(home depot|homedepot|rona|lowe|lowes|home hardware|convoy|gentek|groupe|abc supply|beacon|roofmart|kent)/i.test(
      s
    )
  ) {
    return 'Materials';
  }
  if (/(esso|shell|petro|ultramar|pioneer|circle\s*k)/i.test(s)) return 'Fuel';
  return null;
}

function inferExpenseCategoryHeuristic(data) {
  const memo = `${data?.item || ''} ${data?.store || ''}`.toLowerCase();

  if (
    /\b(lumber|plywood|drywall|shingle|shingles|nails|screws|concrete|rebar|insulation|caulk|adhesive|materials?|siding|vinyl\s*siding|soffit|fascia|eavestrough|gutter|flashing|wrap|tyvek|house\s*wrap|sheathing|osb|studs|joists|truss|paint|primer|stain)\b/.test(
      memo
    )
  )
    return 'Materials';
  if (/\b(gas|diesel|fuel|petro|esso|shell)\b/.test(memo)) return 'Fuel';
  if (/\b(tool|saw|drill|blade|bit|ladder|hammer)\b/.test(memo)) return 'Tools';
  if (/\b(subcontract|sub-contractor|subcontractor)\b/.test(memo)) return 'Subcontractors';
  if (/\b(office|paper|printer|ink|stationery)\b/.test(memo)) return 'Office Supplies';

  return null;
}

function formatMoneyDisplay(n) {
  try {
    const fmt = new Intl.NumberFormat('en-CA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return `$${fmt.format(n)}`;
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function normalizeExpenseData(data, userProfile) {
  const tz = userProfile?.timezone || userProfile?.tz || 'UTC';
  const d = { ...(data || {}) };

  if (d.amount != null) {
    const n = toNumberAmount(d.amount);
    if (Number.isFinite(n) && n > 0) d.amount = formatMoneyDisplay(n);
  }

  d.date = String(d.date || '').trim() || todayInTimeZone(tz);
  d.item = cleanExpenseItemForDisplay(d.item);
  d.store = String(d.store || '').trim() || 'Unknown Store';

  if (d.jobName != null) {
    const j = String(d.jobName).trim();
    d.jobName = j || null;
  }

  if (d.suggestedCategory != null) {
    const c = String(d.suggestedCategory).trim();
    d.suggestedCategory = c || null;
  }

  return d;
}

/* --------- NL money/date helpers --------- */

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
    if (cand && !isIsoDateToken(cand)) jobName = cand;
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

    actor: {
      actor_id: String(userProfile?.user_id || from || 'unknown'),
      role: 'owner',
      phone_e164: from && String(from).startsWith('+') ? String(from) : undefined
    },

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
    if (typeof validateCIL !== 'function') {
      console.warn('[EXPENSE] validateCIL missing; skipping CIL validation (fail-open).');
      return { ok: true, cil: null, skipped: true };
    }

    const cil1 = buildExpenseCIL_LogExpense({ from, data, jobName, category, sourceMsgId });
    try {
      validateCIL(cil1);
      return { ok: true, cil: cil1, variant: 'LogExpense' };
    } catch {
      const cil2 = buildExpenseCIL_Legacy({ ownerId, from, userProfile, data, jobName, category, sourceMsgId });
      validateCIL(cil2);
      return { ok: true, cil: cil2, variant: 'Legacy' };
    }
  } catch (e) {
    console.warn('[EXPENSE] CIL validate failed', {
      message: e?.message,
      name: e?.name,
      details: e?.errors || e?.issues || null
    });
    return { ok: false, reply: `⚠️ Couldn't log that expense yet. Try: "expense 84.12 nails from Home Depot".` };
  }
}

async function withTimeout(promise, ms, fallbackValue = '__TIMEOUT__') {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))]);
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

async function listOpenJobsDetailed(ownerId, limit = 50) {
  // Prefer a postgres.js helper if you have one
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

  // SQL fallback (best-effort; adjust status column in DB later if needed)
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
    // Last resort: your old listOpenJobs if present
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

    out.push({
      id: j?.id ? String(j.id) : null,
      job_no: j?.job_no != null ? Number(j.job_no) : null,
      name
    });
  }

  return out;
}

function resolveJobOptionFromReply(input, jobOptions) {
  const raw = normalizeJobAnswer(input);
  const t = String(raw || '').trim();
  if (!t) return null;

  if (looksLikeOverhead(t)) return { kind: 'overhead' };
  if (t.toLowerCase() === 'more' || t.toLowerCase() === 'more jobs' || t.toLowerCase() === 'more jobs…')
    return { kind: 'more' };

  // numeric: "1" means first row shown (absolute index)
  if (/^\d+$/.test(t)) {
    const idx = Number(t);
    const opt = (jobOptions || [])[idx - 1] || null;
    if (opt) return { kind: 'job', job: opt };
    return null;
  }

  // match by name (case-insensitive)
  const lc = t.toLowerCase();
  const opt =
    (jobOptions || []).find((j) => String(j.name || '').toLowerCase() === lc) ||
    (jobOptions || []).find((j) => String(j.name || '').toLowerCase().startsWith(lc.slice(0, 24))) ||
    null;

  if (opt) return { kind: 'job', job: opt };

  // allow raw name input as "job"
  return { kind: 'job', job: { id: null, job_no: null, name: t } };
}

async function sendJobPickerOrFallback({ from, ownerId, jobOptions, page = 0, pageSize = 8 }) {
  const to = waTo(from);
  const JOBS_PER_PAGE = Math.min(Number(pageSize || 8), 8);
  const start = page * JOBS_PER_PAGE;
  const slice = (jobOptions || []).slice(start, start + JOBS_PER_PAGE);
  const hasMore = start + JOBS_PER_PAGE < (jobOptions || []).length;

  // Persist picker context in pending_actions (Option A)
  await upsertPA({
    ownerId,
    userId: from,
    kind: PA_KIND_PICK_JOB,
    payload: {
      jobOptions,
      page,
      pageSize: JOBS_PER_PAGE,
      hasMore,
      shownAt: Date.now()
    },
    ttlSeconds: 600
  });

  if (!ENABLE_INTERACTIVE_LIST || !to) {
    return twimlText(buildTextJobPrompt(jobOptions, page, JOBS_PER_PAGE));
  }

  const rows = [];

  for (let i = 0; i < slice.length; i++) {
    const absIdx = start + i + 1;
    const full = slice[i]?.name || 'Untitled Job';
    const rowId = `job_${absIdx}_${stableHash(full)}`;

    rows.push({
      id: rowId, // we still accept list row id, but numeric mapping uses absIdx
      title: String(full).slice(0, 24),
      description: (slice[i]?.job_no != null ? `#${slice[i].job_no} ` : '') + String(full).slice(0, 72)
    });
  }

  rows.push({
    id: 'overhead',
    title: 'Overhead',
    description: 'Not tied to a job'
  });

  if (hasMore) {
    rows.push({
      id: 'more',
      title: 'More jobs…',
      description: `Show jobs ${start + JOBS_PER_PAGE + 1}+`
    });
  }

  const bodyText =
    `Here are your active jobs (${start + 1}-${Math.min(start + JOBS_PER_PAGE, jobOptions.length)} of ${
      jobOptions.length
    }).\n` +
    `Pick one to assign this expense.\n\n` +
    `Tip: You can reply with a number too (like "1").`;

  const sections = [{ title: 'Active Jobs', rows }];

  try {
    await sendWhatsAppInteractiveList({
      to,
      bodyText,
      buttonText: 'Pick a job',
      sections
    });
    return twimlEmpty();
  } catch (e) {
    console.warn('[EXPENSE] interactive list failed; falling back to text:', e?.message);
    return twimlText(buildTextJobPrompt(jobOptions, page, JOBS_PER_PAGE));
  }
}

/* ---------------- media normalization (aligned) ---------------- */

function normalizeMediaMetaForTx(pendingMediaMeta) {
  if (!pendingMediaMeta) return null;

  // If postgres.js provides normalizeMediaMeta, use it
  if (typeof pg.normalizeMediaMeta === 'function') {
    try {
      return pg.normalizeMediaMeta({
        url: pendingMediaMeta.url || null,
        type: pendingMediaMeta.type || null,
        transcript: truncateText(pendingMediaMeta.transcript, MAX_MEDIA_TRANSCRIPT_CHARS),
        confidence: pendingMediaMeta.confidence ?? null
      });
    } catch {}
  }

  return {
    url: pendingMediaMeta.url || null,
    type: pendingMediaMeta.type || null,
    transcript: truncateText(pendingMediaMeta.transcript, MAX_MEDIA_TRANSCRIPT_CHARS),
    confidence: pendingMediaMeta.confidence ?? null
  };
}

/* ---------------- main handler ---------------- */

async function handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  input = stripExpensePrefixes(input);

  const lockKey = `lock:${from}`;
  const safeMsgId = String(sourceMsgId || `${from}:${Date.now()}`).trim();

  // best-effort lock acquire
  try {
    const lock = require('../../middleware/lock');
    if (lock?.acquireLock) {
      await lock.acquireLock(lockKey, 8000).catch(() => null);
    }
  } catch {}

  let reply;

  try {
    const tz = userProfile?.timezone || userProfile?.tz || 'UTC';
    const defaultData = {
      date: todayInTimeZone(tz),
      item: 'Unknown',
      amount: '$0.00',
      store: 'Unknown Store'
    };

    // ---- 1) If we're awaiting a job pick (Option A) ----
    const pickPA = await getPA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
    if (pickPA?.payload?.jobOptions && (pickPA.payload?.awaiting === true || true)) {
      const tok = normalizeDecisionToken(input);

      const jobOptions = Array.isArray(pickPA.payload.jobOptions) ? pickPA.payload.jobOptions : [];
      const page = Number(pickPA.payload.page || 0) || 0;
      const pageSize = Number(pickPA.payload.pageSize || 8) || 8;
      const hasMore = !!pickPA.payload.hasMore;

      if (tok === 'change_job') {
        // resend same page
        return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page, pageSize });
      }

      if (tok === 'more') {
        if (!hasMore) {
          return twimlText('No more jobs to show. Reply with a number, job name, or "Overhead".');
        }
        return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page: page + 1, pageSize });
      }

      // Also support WhatsApp list row ids: "job_3_abcd", "overhead", "more"
      const raw = String(input || '').trim();
      if (raw === 'overhead') {
        // continue to confirm
        const confirm = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
        if (confirm?.payload?.draft) {
          confirm.payload.draft.jobName = 'Overhead';
          confirm.payload.draft.job = { id: null, job_no: null, name: 'Overhead' };
          await upsertPA({
            ownerId,
            userId: from,
            kind: PA_KIND_CONFIRM,
            payload: confirm.payload,
            ttlSeconds: 600
          });
          await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });

          const s = buildExpenseSummaryLine({
            amount: confirm.payload.draft.amount,
            item: confirm.payload.draft.item,
            store: confirm.payload.draft.store,
            date: confirm.payload.draft.date,
            jobName: 'Overhead'
          });
          return await sendConfirmExpenseOrFallback(from, s);
        }
        // if confirm missing, just ack and clear picker
        await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
        return twimlText('Got it. Now resend the expense details.');
      }

      if (raw === 'more') {
        return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page: page + 1, pageSize });
      }

      // If list row id like job_1_hash, parse its number prefix
      let numericFromRowId = null;
      const m = raw.match(/^job_(\d+)_/i);
      if (m?.[1]) numericFromRowId = m[1];

      const resolved = resolveJobOptionFromReply(numericFromRowId || input, jobOptions);
      if (resolved?.kind === 'more') {
        return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page: page + 1, pageSize });
      }

      if (resolved?.kind === 'overhead') {
        // same handling as above
        const confirm = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
        if (confirm?.payload?.draft) {
          confirm.payload.draft.jobName = 'Overhead';
          confirm.payload.draft.job = { id: null, job_no: null, name: 'Overhead' };
          await upsertPA({
            ownerId,
            userId: from,
            kind: PA_KIND_CONFIRM,
            payload: confirm.payload,
            ttlSeconds: 600
          });
          await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });

          const s = buildExpenseSummaryLine({
            amount: confirm.payload.draft.amount,
            item: confirm.payload.draft.item,
            store: confirm.payload.draft.store,
            date: confirm.payload.draft.date,
            jobName: 'Overhead'
          });
          return await sendConfirmExpenseOrFallback(from, s);
        }
        await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
        return twimlText('Got it. Now resend the expense details.');
      }

      if (resolved?.kind === 'job' && resolved.job?.name) {
        const confirm = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
        if (confirm?.payload?.draft) {
          confirm.payload.draft.jobName = String(resolved.job.name).trim();
          confirm.payload.draft.job = {
            id: resolved.job.id ? String(resolved.job.id) : null,
            job_no: resolved.job.job_no != null ? Number(resolved.job.job_no) : null,
            name: String(resolved.job.name).trim()
          };

          await upsertPA({
            ownerId,
            userId: from,
            kind: PA_KIND_CONFIRM,
            payload: confirm.payload,
            ttlSeconds: 600
          });

          await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });

          const s = buildExpenseSummaryLine({
            amount: confirm.payload.draft.amount,
            item: confirm.payload.draft.item,
            store: confirm.payload.draft.store,
            date: confirm.payload.draft.date,
            jobName: confirm.payload.draft.jobName
          });
          return await sendConfirmExpenseOrFallback(from, s);
        }

        // If confirm is missing, we can’t continue; clear picker and ask to resend
        await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
        return twimlText('Got it. Now resend the expense details.');
      }

      return twimlText('Please reply with a number, job name, "Overhead", or "more".');
    }

    // ---- 2) Confirm/edit/cancel flow (Option A) ----
    const confirmPA = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
    if (confirmPA?.payload?.draft) {
      if (!isOwner) {
        await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
        reply = '⚠️ Only the owner can manage expenses.';
        return twimlText(reply);
      }

      const token = normalizeDecisionToken(input);
      const stableMsgId = String(confirmPA?.payload?.sourceMsgId || safeMsgId).trim();

      if (token === 'change_job') {
        const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
        if (!jobs.length) return twimlText('No jobs found. Reply "Overhead" or create a job first.');
        return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
      }

      if (token === 'edit') {
        await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
        return twimlText('✏️ Okay — resend the expense in one line (e.g., "expense $84.12 nails from Home Depot today for <job>").');
      }

      if (token === 'cancel') {
        await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
        return twimlText('❌ Operation cancelled.');
      }

      if (token === 'yes') {
        const rawDraft = confirmPA.payload.draft || {};
        const mediaMeta = normalizeMediaMetaForTx(confirmPA.payload.pendingMediaMeta || null);

        let data = normalizeExpenseData(rawDraft, userProfile);
        data.store = await normalizeVendorName(ownerId, data.store);

        const category = await resolveExpenseCategory({ ownerId, data, ownerProfile });

        // If the draft already has a picked job, use it. Else fall back to active job, else pick.
        const pickedJobName = rawDraft.jobName && String(rawDraft.jobName).trim() ? String(rawDraft.jobName).trim() : null;
        const pickedJob = rawDraft.job && typeof rawDraft.job === 'object' ? rawDraft.job : null;

        const jobName = pickedJobName || (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;

        if (!jobName) {
          const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
          await upsertPA({
            ownerId,
            userId: from,
            kind: PA_KIND_CONFIRM,
            payload: { ...confirmPA.payload, draft: { ...data, suggestedCategory: category }, sourceMsgId: stableMsgId },
            ttlSeconds: 600
          });
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
        if (!gate.ok) return twimlText(String(gate.reply || '').slice(0, 1500));

        const amountCents = toCents(data.amount);
        if (!amountCents || amountCents <= 0) throw new Error('Invalid amount');

        // Pass job info. insertTransaction can resolve job_id from job/job_name;
        // if you have job_id support, include picked uuid when present.
        const maybeJobId = pickedJob?.id && looksLikeUuid(String(pickedJob.id)) ? String(pickedJob.id) : null;

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
              job_id: maybeJobId || null,

              category: category ? String(category).trim() : null,
              user_name: userProfile?.name || 'Unknown User',
              source_msg_id: stableMsgId,
              mediaMeta: mediaMeta
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
            payload: { ...confirmPA.payload, draft: { ...data, jobName, suggestedCategory: category }, sourceMsgId: stableMsgId },
            ttlSeconds: 600
          });
          return twimlText('⚠️ Saving is taking longer than expected (database slow). Please tap Yes again in a few seconds.');
        }

        const summaryLine = buildExpenseSummaryLine({
          amount: data.amount,
          item: data.item,
          store: data.store,
          date: data.date || todayInTimeZone(tz),
          jobName
        });

        reply =
          writeResult?.inserted === false
            ? '✅ Already logged that expense (duplicate message).'
            : `✅ Expense logged: ${summaryLine}${category ? ` (Category: ${category})` : ''}`;

        await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
        return twimlText(reply);
      }

      return twimlText('⚠️ Please choose Yes, Edit, or Cancel.\nTip: reply "change job" to pick a different job.');
    }

    // ---- 3) No pending actions: parse a new expense ----

    const backstop = deterministicExpenseParse(input, userProfile);
    if (backstop && backstop.amount) {
      const data0 = normalizeExpenseData(backstop, userProfile);
      data0.store = await normalizeVendorName(ownerId, data0.store);

      const category = await resolveExpenseCategory({ ownerId, data: data0, ownerProfile });

      // prefer explicit job in text, else active job
      const jobName = data0.jobName || (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
      if (jobName) data0.item = stripEmbeddedDateAndJobFromItem(data0.item, { date: data0.date, jobName });

      // Save confirm state in pending_actions
      await upsertPA({
        ownerId,
        userId: from,
        kind: PA_KIND_CONFIRM,
        payload: {
          draft: { ...data0, jobName, suggestedCategory: category, job: jobName ? { id: null, job_no: null, name: jobName } : null },
          sourceMsgId: safeMsgId,
          type: 'expense'
        },
        ttlSeconds: 600
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
        jobName
      });
      return await sendConfirmExpenseOrFallback(from, summaryLine);
    }

    // AI ingestion fallback (tz-aware)
    const aiRes = await handleInputWithAI(from, input, 'expense', parseExpenseMessage, defaultData, { tz });

    let data = aiRes?.data || null;
    let aiReply = aiRes?.reply || null;

    if (aiReply && /\bcategory\b/i.test(aiReply)) aiReply = null;
    if (data) data = normalizeExpenseData(data, userProfile);

    const missingCore =
      !data ||
      !data.amount ||
      data.amount === '$0.00' ||
      !data.item ||
      data.item === 'Unknown' ||
      !data.store ||
      data.store === 'Unknown Store';

    if (aiReply && missingCore) {
      // Treat as "needs clarification"
      return twimlText(aiReply);
    }

    if (data && data.amount && data.amount !== '$0.00') {
      data.store = await normalizeVendorName(ownerId, data.store);

      const category = await resolveExpenseCategory({ ownerId, data, ownerProfile });

      const jobName = data.jobName || (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
      if (jobName) data.item = stripEmbeddedDateAndJobFromItem(data.item, { date: data.date, jobName });

      await upsertPA({
        ownerId,
        userId: from,
        kind: PA_KIND_CONFIRM,
        payload: {
          draft: { ...data, jobName, suggestedCategory: category, job: jobName ? { id: null, job_no: null, name: jobName } : null },
          sourceMsgId: safeMsgId,
          type: 'expense'
        },
        ttlSeconds: 600
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
        jobName
      });
      return await sendConfirmExpenseOrFallback(from, summaryLine);
    }

    reply = `🤔 Couldn’t parse an expense from "${input}". Try "expense 84.12 nails from Home Depot".`;
    return twimlText(reply);
  } catch (error) {
    console.error(`[ERROR] handleExpense failed for ${from}:`, error?.message, {
      code: error?.code,
      detail: error?.detail,
      constraint: error?.constraint
    });
    reply = '⚠️ Error logging expense. Please try again.';
    return twimlText(reply);
  } finally {
    try {
      const lock = require('../../middleware/lock');
      if (lock?.releaseLock) await lock.releaseLock(lockKey);
    } catch {}
  }
}

module.exports = { handleExpense };
