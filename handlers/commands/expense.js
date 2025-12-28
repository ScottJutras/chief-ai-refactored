// handlers/commands/expense.js
// COMPLETE DROP-IN (aligned to latest postgres.js + idempotent writes + active-job fix)
//
// Key alignments:
// - Uses pg.getActiveJobForIdentity() when present (canonical per-identity active job)
// - Uses pg.insertTransaction() which now schema-maps media + can populate transactions.job_id
// - Keeps Interactive List + numeric map
// - Adds robust pending-state deletion fallbacks (state manager naming drift)
// - Adds best-effort lock acquire + always releases
// - Fail-open everywhere (never hard-fail on schema mismatch)

const pg = require('../../services/postgres');
const { query, insertTransaction, listOpenJobs } = pg;

const getCategorySuggestion =
  (typeof pg.getCategorySuggestion === 'function' && pg.getCategorySuggestion) || (async () => null);

const normalizeVendorName =
  (typeof pg.normalizeVendorName === 'function' && pg.normalizeVendorName) ||
  (typeof pg.normalizeVendor === 'function' && pg.normalizeVendor) ||
  (async (_ownerId, vendor) => {
    const s = String(vendor || '').trim();
    return s || 'Unknown Store';
  });

const state = require('../../utils/stateManager');

const getPendingTransactionState =
  state.getPendingTransactionState ||
  state.getPendingState ||
  (async () => null);

// ✅ robust delete (stateManager naming drift)
const deletePendingTransactionState =
  state.deletePendingTransactionState ||
  state.deletePendingState ||
  state.clearPendingTransactionState ||
  state.clearPendingState ||
  (async (_key) => {});

const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

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

/* ---------------- WhatsApp Interactive List (FREE-FORM, dynamic) ---------------- */

const ENABLE_INTERACTIVE_LIST = (() => {
  const raw =
    process.env.TWILIO_ENABLE_INTERACTIVE_LIST ??
    process.env.TWILIO_ENABLE_LIST_PICKER ??
    'true';
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

function dedupeJobs(list) {
  const out = [];
  const seen = new Set();
  for (const j of list || []) {
    const s = String(j || '').trim();
    if (!s) continue;
    if (isGarbageJobName(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function buildTextJobPrompt(jobs, page, pageSize) {
  const start = page * pageSize;
  const slice = jobs.slice(start, start + pageSize);
  const lines = slice.map((j, i) => `${start + i + 1}) ${j}`);
  const hasMore = start + pageSize < jobs.length;

  const more = hasMore ? `\nReply "more" for more jobs.` : '';
  return `Which job is this expense for?\n\n${lines.join(
    '\n'
  )}\n\nReply with a number, job name, or "Overhead".${more}\nTip: reply "change job" to see the picker.`;
}

// ✅ IMPORTANT: includes numeric map so replying "1" works reliably
function buildJobPickerMapping(jobs, page, pageSize) {
  const start = page * pageSize;
  const slice = jobs.slice(start, start + pageSize);

  const idMap = {}; // rowId -> jobName
  const nameMap = {}; // lower(title/desc) -> jobName
  const numMap = {}; // "1" -> jobName (absolute index)

  for (let i = 0; i < slice.length; i++) {
    const absIdx = start + i + 1;
    const fullName = slice[i];
    const rowId = `job_${absIdx}_${stableHash(fullName)}`;

    idMap[rowId] = fullName;
    numMap[String(absIdx)] = fullName;

    nameMap[String(fullName).toLowerCase()] = fullName;
    nameMap[String(fullName).slice(0, 24).toLowerCase()] = fullName;
  }

  idMap.overhead = 'Overhead';
  idMap.more = '__MORE__';

  nameMap.overhead = 'Overhead';
  nameMap['more jobs…'] = '__MORE__';
  nameMap['more jobs'] = '__MORE__';
  nameMap.more = '__MORE__';

  numMap.overhead = 'Overhead';
  numMap.more = '__MORE__';

  return { idMap, nameMap, numMap };
}

async function sendWhatsAppInteractiveList({ to, bodyText, buttonText, sections }) {
  const client = getTwilioClient();
  const { waFrom, messagingServiceSid } = getSendFromConfig();

  const payload = {
    to,
    ...(waFrom ? { from: waFrom } : { messagingServiceSid }),
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

async function sendJobPickerOrFallback(from, ownerId, jobs, page = 0, pageSize = 8) {
  const to = waTo(from);
  const uniq = dedupeJobs(jobs);

  const JOBS_PER_PAGE = Math.min(pageSize, 8);
  const start = page * JOBS_PER_PAGE;
  const slice = uniq.slice(start, start + JOBS_PER_PAGE);
  const hasMore = start + JOBS_PER_PAGE < uniq.length;

  const { idMap, nameMap, numMap } = buildJobPickerMapping(uniq, page, JOBS_PER_PAGE);

  await mergePendingTransactionState(from, {
    awaitingExpenseJob: true,
    awaitingExpenseJobPage: page,
    expenseJobPickerIdMap: idMap,
    expenseJobPickerNameMap: nameMap,
    expenseJobPickerNumMap: numMap,
    expenseJobPickerHasMore: hasMore,
    expenseJobPickerTotal: uniq.length
  });

  if (!ENABLE_INTERACTIVE_LIST || !to) {
    return twimlText(buildTextJobPrompt(uniq, page, JOBS_PER_PAGE));
  }

  const rows = [];

  for (let i = 0; i < slice.length; i++) {
    const absIdx = start + i + 1;
    const full = slice[i];
    const rowId = `job_${absIdx}_${stableHash(full)}`;

    rows.push({
      id: rowId,
      title: String(full).slice(0, 24),
      description: String(full).slice(0, 72)
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
    `Here are your active jobs (${start + 1}-${Math.min(start + JOBS_PER_PAGE, uniq.length)} of ${
      uniq.length
    }).\n` +
    `Pick one to assign this expense.\n\n` +
    `Tip: You can switch your current job anytime.`;

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
    return twimlText(buildTextJobPrompt(uniq, page, JOBS_PER_PAGE));
  }
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
  if (st && st !== 'Unknown Store' && !itLower.includes(`from ${st.toLowerCase()}`))
    parts.push(`from ${st}`);
  if (dt && !itLower.includes(dt.toLowerCase())) parts.push(`on ${dt}`);
  if (jb && !itLower.includes(jb.toLowerCase())) parts.push(`for ${jb}`);
  return parts.join(' ') + '.';
}

/* ---------------- Active job resolution (aligned to postgres.js) ---------------- */

function extractUserId(userProfile, fromPhone) {
  return (
    userProfile?.id ||
    userProfile?.user_id ||
    userProfile?.userId ||
    userProfile?.member_id ||
    userProfile?.membership_id ||
    fromPhone ||
    null
  );
}

function normalizeE164ish(fromPhone) {
  const raw = String(fromPhone || '').trim();
  if (!raw) return null;
  if (raw.startsWith('+')) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

async function bestEffortFetchActiveJobFieldsFromDb({ ownerId, userProfile, fromPhone }) {
  const ownerParam = String(ownerId || '').trim();
  const userId = extractUserId(userProfile, fromPhone);
  const phone = normalizeE164ish(fromPhone);

  // ✅ Canonical in postgres.js
  if (typeof pg.getActiveJobForIdentity === 'function') {
    try {
      const out = await pg.getActiveJobForIdentity(String(ownerId), String(fromPhone));
      if (out?.active_job_name || out?.activeJobName) {
        return {
          active_job_name: String(out.active_job_name || out.activeJobName).trim(),
          active_job_id: out.active_job_id ?? out.activeJobId ?? null
        };
      }
      if (out?.active_job_id || out?.activeJobId) {
        return { active_job_name: null, active_job_id: out.active_job_id ?? out.activeJobId };
      }
    } catch (e) {
      console.warn('[EXPENSE] pg.getActiveJobForIdentity failed (ignored):', e?.message);
    }
  }

  // Legacy best-effort fallbacks (safe if schemas still exist)
  const attempts = [
    {
      label: 'memberships by user_id',
      sql: `SELECT active_job_id, active_job_name
              FROM public.memberships
             WHERE owner_id = $1 AND user_id = $2
             LIMIT 1`,
      params: [ownerParam, String(userId)]
    },
    {
      label: 'memberships by phone',
      sql: `SELECT active_job_id, active_job_name
              FROM public.memberships
             WHERE owner_id = $1 AND (phone = $2 OR phone_e164 = $2 OR member_phone = $2)
             LIMIT 1`,
      params: [ownerParam, phone]
    },
    {
      label: 'users by id',
      sql: `SELECT active_job_id, active_job_name
              FROM public.users
             WHERE owner_id = $1 AND user_id = $2
             LIMIT 1`,
      params: [ownerParam, String(userId)]
    },
    {
      label: 'users by phone',
      sql: `SELECT active_job_id, active_job_name
              FROM public.users
             WHERE owner_id = $1 AND (phone = $2 OR phone_e164 = $2)
             LIMIT 1`,
      params: [ownerParam, phone]
    },
    {
      label: 'user_profiles by user_id',
      sql: `SELECT active_job_id, active_job_name
              FROM public.user_profiles
             WHERE owner_id = $1 AND user_id = $2
             LIMIT 1`,
      params: [ownerParam, String(userId)]
    }
  ];

  for (const a of attempts) {
    if (!a.params?.[1]) continue;
    try {
      const r = await query(a.sql, a.params);
      const row = r?.rows?.[0];
      if (!row) continue;
      const name = row.active_job_name != null ? String(row.active_job_name).trim() : null;
      const id = row.active_job_id != null ? row.active_job_id : null;
      if (name || id) {
        console.info('[EXPENSE] active job fetched from DB', {
          where: a.label,
          hasName: !!name,
          hasId: !!id
        });
        return { active_job_name: name || null, active_job_id: id };
      }
    } catch {}
  }

  return null;
}

async function resolveActiveJobName({ ownerId, userProfile, fromPhone }) {
  const ownerParam = String(ownerId || '').trim();

  const directName = userProfile?.active_job_name || userProfile?.activeJobName || null;
  if (directName && String(directName).trim()) return String(directName).trim();

  const directRef = userProfile?.active_job_id ?? userProfile?.activeJobId ?? null;

  let ref = directRef;
  let name = null;

  if (ref == null) {
    const fetched = await bestEffortFetchActiveJobFieldsFromDb({ ownerId, userProfile, fromPhone });
    if (fetched?.active_job_name && String(fetched.active_job_name).trim()) {
      return String(fetched.active_job_name).trim();
    }
    ref = fetched?.active_job_id ?? null;
    name = fetched?.active_job_name ?? null;
  }

  if (name && String(name).trim()) return String(name).trim();
  if (ref == null) return null;

  const s = String(ref).trim();

  // If uuid ref, try uuid join
  if (looksLikeUuid(s)) {
    try {
      const r = await query(
        `select coalesce(name, job_name) as job_name
           from public.jobs
          where owner_id = $1 and id = $2::uuid
          limit 1`,
        [ownerParam, s]
      );
      if (r?.rows?.[0]?.job_name) return r.rows[0].job_name;
    } catch (e) {
      console.warn('[expense] resolveActiveJobName uuid failed:', e?.message);
    }
  }

  // If job_no ref, try job_no
  if (/^\d+$/.test(s)) {
    try {
      const r = await query(
        `select coalesce(name, job_name) as job_name
           from public.jobs
          where owner_id = $1 and job_no = $2::int
          limit 1`,
        [ownerParam, Number(s)]
      );
      if (r?.rows?.[0]?.job_name) return r.rows[0].job_name;
    } catch (e) {
      console.warn('[expense] resolveActiveJobName job_no failed:', e?.message);
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

function resolveJobFromReply(input, pending) {
  const raw = normalizeJobAnswer(input);
  const t = String(raw || '').trim();
  if (!t) return null;

  if (looksLikeOverhead(t)) return 'Overhead';

  const lc = t.toLowerCase();
  if (lc === 'more' || lc === 'more jobs' || lc === 'more jobs…') return '__MORE__';

  if (pending?.expenseJobPickerIdMap && pending.expenseJobPickerIdMap[t]) {
    return pending.expenseJobPickerIdMap[t];
  }

  if (/^\d+$/.test(t) && pending?.expenseJobPickerNumMap?.[t]) {
    return pending.expenseJobPickerNumMap[t];
  }

  if (pending?.expenseJobPickerNameMap) {
    const mapped = pending.expenseJobPickerNameMap[String(t).toLowerCase()];
    if (mapped) return mapped;
  }

  return t;
}

/* ---------------- media normalization (aligned) ---------------- */

function normalizeMediaMetaForTx(pendingMediaMeta) {
  if (!pendingMediaMeta) return null;

  // If postgres.js provides normalizeMediaMeta, use it (keeps consistent columns)
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

  // fallback shape
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

    let pending = await getPendingTransactionState(from);

    if (pending?.isEditing && pending?.type === 'expense') {
      await deletePendingTransactionState(from);
      pending = null;
    }

    // Awaiting job selection (interactive list or text)
    if (pending?.awaitingExpenseJob && pending?.pendingExpense) {
      const tok = normalizeDecisionToken(input);

      if (tok === 'change_job') {
        const all = dedupeJobs(await listOpenJobs(ownerId, { limit: 50 }));
        const page = Number(pending.awaitingExpenseJobPage || 0) || 0;
        return await sendJobPickerOrFallback(from, ownerId, all, page, 8);
      }

      const resolved = resolveJobFromReply(input, pending);

      if (resolved === '__MORE__') {
        const all = dedupeJobs(await listOpenJobs(ownerId, { limit: 50 }));
        const nextPage = Number(pending.awaitingExpenseJobPage || 0) + 1;
        return await sendJobPickerOrFallback(from, ownerId, all, nextPage, 8);
      }

      const finalJob = resolved || null;

      const merged = normalizeExpenseData({ ...pending.pendingExpense, jobName: finalJob }, userProfile);
      merged.store = await normalizeVendorName(ownerId, merged.store);
      merged.item = stripEmbeddedDateAndJobFromItem(merged.item, { date: merged.date, jobName: merged.jobName });

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: merged,
        awaitingExpenseJob: false,
        awaitingExpenseJobPage: null,
        expenseJobPickerIdMap: null,
        expenseJobPickerNameMap: null,
        expenseJobPickerNumMap: null,
        expenseJobPickerHasMore: null,
        expenseJobPickerTotal: null
      });

      const summaryLine = buildExpenseSummaryLine({
        amount: merged.amount,
        item: merged.item,
        store: merged.store,
        date: merged.date,
        jobName: merged.jobName
      });
      return await sendConfirmExpenseOrFallback(from, summaryLine);
    }

    // Confirm/edit/cancel flow
    if (pending?.pendingExpense || pending?.pendingDelete?.type === 'expense') {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = '⚠️ Only the owner can manage expenses.';
        return twimlText(reply);
      }

      const token = normalizeDecisionToken(input);
      const stableMsgId = String(pending?.expenseSourceMsgId || safeMsgId).trim();

      if (token === 'change_job' && pending?.pendingExpense) {
        await mergePendingTransactionState(from, {
          ...(pending || {}),
          awaitingExpenseJob: true,
          awaitingExpenseJobPage: 0
        });

        const all = dedupeJobs(await listOpenJobs(ownerId, { limit: 50 }));
        return await sendJobPickerOrFallback(from, ownerId, all, 0, 8);
      }

      if (token === 'yes' && pending?.pendingExpense) {
        const rawData = pending.pendingExpense || {};
        const mediaMeta = normalizeMediaMetaForTx(pending?.pendingMediaMeta || null);

        let data = normalizeExpenseData(rawData, userProfile);
        data.store = await normalizeVendorName(ownerId, data.store);

        const category = await resolveExpenseCategory({ ownerId, data, ownerProfile });

        // ✅ Resolve job by: pending -> canonical active-job -> null
        const jobName =
          (data.jobName && String(data.jobName).trim()) ||
          (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) ||
          null;

        if (!jobName) {
          await mergePendingTransactionState(from, {
            ...(pending || {}),
            pendingExpense: { ...data, suggestedCategory: category },
            awaitingExpenseJob: true,
            awaitingExpenseJobPage: 0,
            expenseSourceMsgId: stableMsgId,
            type: 'expense'
          });

          const all = dedupeJobs(await listOpenJobs(ownerId, { limit: 50 }));
          return await sendJobPickerOrFallback(from, ownerId, all, 0, 8);
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

        // ✅ idempotent write by source_msg_id (when schema supports it)
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
              // IMPORTANT: pass jobName both ways; postgres.js will resolve and populate job_id if possible
              job: jobName,
              job_name: jobName,
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
          await mergePendingTransactionState(from, {
            ...(pending || {}),
            pendingExpense: { ...data, jobName, suggestedCategory: category },
            expenseSourceMsgId: stableMsgId,
            type: 'expense'
          });

          reply = `⚠️ Saving is taking longer than expected (database slow). Please tap Yes again in a few seconds.`;
          return twimlText(reply);
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

        await deletePendingTransactionState(from);
        return twimlText(reply);
      }

      if (token === 'edit') {
        await deletePendingTransactionState(from);
        reply =
          '✏️ Okay — resend the expense in one line (e.g., "expense $84.12 nails from Home Depot today for <job>").';
        return twimlText(reply);
      }

      if (token === 'cancel') {
        await deletePendingTransactionState(from);
        reply = '❌ Operation cancelled.';
        return twimlText(reply);
      }

      reply = `⚠️ Please choose Yes, Edit, or Cancel.\nTip: reply "change job" to pick a different job.`;
      return twimlText(reply);
    }

    // Backstop deterministic parse
    const backstop = deterministicExpenseParse(input, userProfile);
    if (backstop && backstop.amount) {
      const data0 = normalizeExpenseData(backstop, userProfile);
      data0.store = await normalizeVendorName(ownerId, data0.store);

      const category = await resolveExpenseCategory({ ownerId, data: data0, ownerProfile });

      const jobName =
        data0.jobName || (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;

      if (jobName) data0.item = stripEmbeddedDateAndJobFromItem(data0.item, { date: data0.date, jobName });

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: { ...data0, jobName, suggestedCategory: category },
        expenseSourceMsgId: safeMsgId,
        type: 'expense',
        awaitingExpenseJob: !jobName,
        awaitingExpenseJobPage: 0
      });

      if (!jobName) {
        const all = dedupeJobs(await listOpenJobs(ownerId, { limit: 50 }));
        return await sendJobPickerOrFallback(from, ownerId, all, 0, 8);
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
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: null,
        isEditing: true,
        type: 'expense'
      });
      return twimlText(aiReply);
    }

    if (data && data.amount && data.amount !== '$0.00') {
      data.store = await normalizeVendorName(ownerId, data.store);

      const category = await resolveExpenseCategory({ ownerId, data, ownerProfile });

      const jobName =
        data.jobName || (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;

      if (jobName) data.item = stripEmbeddedDateAndJobFromItem(data.item, { date: data.date, jobName });

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: { ...data, jobName, suggestedCategory: category },
        expenseSourceMsgId: safeMsgId,
        type: 'expense',
        awaitingExpenseJob: !jobName,
        awaitingExpenseJobPage: 0
      });

      if (!jobName) {
        const all = dedupeJobs(await listOpenJobs(ownerId, { limit: 50 }));
        return await sendJobPickerOrFallback(from, ownerId, all, 0, 8);
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
