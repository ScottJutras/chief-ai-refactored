// handlers/commands/revenue.js
// COMPLETE DROP-IN (aligned to latest postgres.js + expense.js patterns)
//
// Alignments included:
// - Uses pg.todayInTZ if available (TZ-safe dates)
// - Uses pg.insertTransaction canonical path with idempotency via source_msg_id (if supported)
// - Uses pg.normalizeMediaMeta + transcript truncation (schema-aware media columns)
// - Mirrors expense.js confirm flow: "db timeout" => keep pending + ask user to tap Yes again
// - Adds "change job" + Interactive List job picker + numeric map (same UX as expense.js)
// - Uses pg.getActiveJobForIdentity canonical path when present (active-job fix)
// - Deterministic parse first (money/date/job) then AI fallback
//
// Signature expected by router:
//   handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId)

const pg = require('../../services/postgres');
const { query, insertTransaction, listOpenJobs } = pg;

const state = require('../../utils/stateManager');
const getPendingTransactionState = state.getPendingTransactionState;
const deletePendingTransactionState =
  state.deletePendingTransactionState ||
  state.deletePendingState ||
  state.clearPendingTransactionState ||
  null;

const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

const ai = require('../../utils/aiErrorHandler');
const handleInputWithAI = ai.handleInputWithAI;
const parseRevenueMessage = ai.parseRevenueMessage;

const detectErrors =
  (typeof ai.detectErrors === 'function' && ai.detectErrors) ||
  (typeof ai.detectError === 'function' && ai.detectError) ||
  (async () => null); // fail-open

const categorizeEntry =
  (typeof ai.categorizeEntry === 'function' && ai.categorizeEntry) || (async () => null); // fail-open

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

function getRevenueConfirmTemplateSid() {
  return (
    process.env.TWILIO_REVENUE_CONFIRM_TEMPLATE_SID ||
    process.env.REVENUE_CONFIRM_TEMPLATE_SID ||
    process.env.TWILIO_TEMPLATE_REVENUE_CONFIRM_SID ||
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

async function sendConfirmRevenueOrFallback(from, summaryLine) {
  const sid = getRevenueConfirmTemplateSid();
  const to = waTo(from);

  console.info('[REVENUE] confirm template attempt', { from, to, hasSid: !!sid, sid: sid || null });

  if (sid && to) {
    try {
      await sendWhatsAppTemplate({ to, templateSid: sid, summaryLine });
      console.info('[REVENUE] confirm template sent OK', { to, sid });
      return twimlEmpty();
    } catch (e) {
      console.warn('[REVENUE] template send failed; falling back to TwiML:', e?.message);
    }
  }

  return twimlText(
    `Please confirm this Revenue:\n${summaryLine}\n\nReply yes/edit/cancel.\nTip: reply "change job" to pick a different job.`
  );
}

/* ---------------- WhatsApp Interactive List (job picker) ---------------- */

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
  return `Which job is this revenue for?\n\n${lines.join(
    '\n'
  )}\n\nReply with a number, job name, or "Overhead".${more}\nTip: reply "change job" to see the picker.`;
}

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
    awaitingRevenueJob: true,
    awaitingRevenueJobPage: page,
    revenueJobPickerIdMap: idMap,
    revenueJobPickerNameMap: nameMap,
    revenueJobPickerNumMap: numMap,
    revenueJobPickerHasMore: hasMore,
    revenueJobPickerTotal: uniq.length
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

  rows.push({ id: 'overhead', title: 'Overhead', description: 'Not tied to a job' });

  if (hasMore) {
    rows.push({ id: 'more', title: 'More jobs…', description: `Show jobs ${start + JOBS_PER_PAGE + 1}+` });
  }

  const bodyText =
    `Here are your active jobs (${start + 1}-${Math.min(start + JOBS_PER_PAGE, uniq.length)} of ${
      uniq.length
    }).\n` + `Pick one to assign this revenue.\n\nTip: You can switch your current job anytime.`;

  const sections = [{ title: 'Active Jobs', rows }];

  try {
    await sendWhatsAppInteractiveList({ to, bodyText, buttonText: 'Pick a job', sections });
    return twimlEmpty();
  } catch (e) {
    console.warn('[REVENUE] interactive list failed; falling back to text:', e?.message);
    return twimlText(buildTextJobPrompt(uniq, page, JOBS_PER_PAGE));
  }
}

/* ---------------- Utilities ---------------- */

const DIGITS = (x) => String(x ?? '').replace(/\D/g, '');

const todayInTimeZone =
  (typeof pg.todayInTZ === 'function' && pg.todayInTZ) ||
  ((tz = 'America/Toronto') => {
    try {
      const dtf = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      return dtf.format(new Date());
    } catch {
      return new Date().toISOString().split('T')[0];
    }
  });

const parseNaturalDateTz =
  (typeof ai.parseNaturalDate === 'function' && ai.parseNaturalDate) ||
  ((s, tz) => {
    const t = String(s || '').trim().toLowerCase();
    const today = todayInTimeZone(tz);
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

function stripRevenuePrefixes(input) {
  let s = String(input || '').trim();
  s = s.replace(/^(edit\s+)?revenue\s*:\s*/i, '');
  s = s.replace(/^(edit\s+)?received\s*:\s*/i, '');
  s = s.replace(/^edit\s*:\s*/i, '');
  return s.trim();
}

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
    const fmt = new Intl.NumberFormat('en-CA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return `$${fmt.format(n)}`;
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function normalizeJobAnswer(text) {
  let s = String(text || '').trim();
  s = s.replace(/^(job\s*name|job)\s*[:\-]?\s*/i, '');
  s = s.replace(/^(create|new)\s+job\s+/i, '');
  s = s.replace(/[?]+$/g, '').trim();
  return s;
}

function looksLikeOverhead(s) {
  const t = String(s || '').trim().toLowerCase();
  return t === 'overhead' || t === 'oh';
}

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(str || '')
  );
}

function looksLikeAddress(s) {
  const t = String(s || '').trim();
  if (!/\d/.test(t)) return false;
  return /\b(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|cir|circle|way|trail|trl|pkwy|park)\b/i.test(
    t
  );
}

function normalizeRevenueData(data, tz) {
  const d = { ...(data || {}) };

  if (d.amount != null) {
    const n = toNumberAmount(d.amount);
    if (Number.isFinite(n) && n > 0) d.amount = formatMoneyDisplay(n);
  }

  d.date = String(d.date || '').trim() || todayInTimeZone(tz);
  d.description = String(d.description || '').trim() || 'Revenue received';

  const src = String(d.source || '').trim();
  d.source = src || 'Unknown';

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

async function withTimeout(promise, ms, fallbackValue = '__TIMEOUT__') {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))]);
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
      console.warn('[REVENUE] pg.getActiveJobForIdentity failed (ignored):', e?.message);
    }
  }

  // Legacy best-effort fallbacks (safe if schemas still exist)
  const ownerParam = String(ownerId || '').trim();
  const userId = extractUserId(userProfile, fromPhone);
  const phone = normalizeE164ish(fromPhone);

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
             WHERE owner_id = $1 AND id = $2
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
        console.info('[REVENUE] active job fetched from DB', {
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
      console.warn('[revenue] resolveActiveJobName uuid failed:', e?.message);
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
      console.warn('[revenue] resolveActiveJobName job_no failed:', e?.message);
    }
  }

  return null;
}

/* ---------------- Media normalization (aligned to postgres.js) ---------------- */

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

function normalizeMediaMetaForTx(pendingMediaMeta) {
  if (!pendingMediaMeta) return null;

  if (typeof pg.normalizeMediaMeta === 'function') {
    try {
      return pg.normalizeMediaMeta({
        url: pendingMediaMeta.url || pendingMediaMeta.media_url || null,
        type: pendingMediaMeta.type || pendingMediaMeta.media_type || null,
        transcript: truncateText(
          pendingMediaMeta.transcript || pendingMediaMeta.media_transcript || null,
          MAX_MEDIA_TRANSCRIPT_CHARS
        ),
        confidence: pendingMediaMeta.confidence ?? pendingMediaMeta.media_confidence ?? null
      });
    } catch {}
  }

  // fallback (insertTransaction handles or ignores depending on schema)
  return {
    url: pendingMediaMeta.url || pendingMediaMeta.media_url || null,
    type: pendingMediaMeta.type || pendingMediaMeta.media_type || null,
    transcript: truncateText(
      pendingMediaMeta.transcript || pendingMediaMeta.media_transcript || null,
      MAX_MEDIA_TRANSCRIPT_CHARS
    ),
    confidence: pendingMediaMeta.confidence ?? pendingMediaMeta.media_confidence ?? null
  };
}

/* ---------------- CIL (fail-open) ---------------- */

function buildRevenueCIL({ from, data, jobName, category, sourceMsgId }) {
  const cents = toCents(data.amount);

  const description =
    String(data.description || '').trim() && data.description !== 'Unknown'
      ? String(data.description).trim()
      : 'Revenue Logged';

  return {
    type: 'LogRevenue',
    job: jobName ? String(jobName) : undefined,
    description,
    amount_cents: cents,
    source: data.source && data.source !== 'Unknown' ? String(data.source) : undefined,
    date: data.date ? String(data.date) : undefined,
    category: category ? String(category) : undefined,
    source_msg_id: sourceMsgId ? String(sourceMsgId) : undefined,
    actor_phone: from ? String(from) : undefined
  };
}

function assertRevenueCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  try {
    const cil = buildRevenueCIL({ ownerId, from, userProfile, data, jobName, category, sourceMsgId });

    if (typeof validateCIL !== 'function') {
      console.warn('[REVENUE] validateCIL missing; skipping CIL validation (fail-open).');
      return { ok: true, cil, skipped: true };
    }

    validateCIL(cil);
    return { ok: true, cil };
  } catch (e) {
    console.warn('[REVENUE] CIL validate failed', {
      message: e?.message,
      name: e?.name,
      details: e?.errors || e?.issues || e?.cause || null
    });
    return { ok: false, reply: `⚠️ Couldn't log that Revenue yet. Try: "received $2500 for <job> today".` };
  }
}

/* --------- Deterministic parse --------- */

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
  const cleaned = String(token || '').trim().replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return formatMoneyDisplay(n);
}

function deterministicRevenueParse(input, tz) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const token = extractMoneyToken(raw);

  // If token is a big bare integer, could be job # or address — require $ form to accept.
  if (token && /^\d{4,}$/.test(String(token).replace(/,/g, ''))) {
    const hasDollar = /\$\s*\d/.test(raw);
    if (!hasDollar) return null;
  }

  const amount = moneyToFixed(token);
  if (!amount) return null;

  // Date
  let date = null;
  if (/\btoday\b/i.test(raw)) date = parseNaturalDateTz('today', tz);
  else if (/\byesterday\b/i.test(raw)) date = parseNaturalDateTz('yesterday', tz);
  else if (/\btomorrow\b/i.test(raw)) date = parseNaturalDateTz('tomorrow', tz);
  else {
    const iso = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (iso?.[1]) date = iso[1];
    if (!date) {
      const nat = raw.match(/\b(?:on\s+)?([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/);
      if (nat?.[1]) date = parseNaturalDateTz(nat[1], tz);
    }
  }
  if (!date) date = todayInTimeZone(tz);

  // Job patterns
  let jobName = null;

  const forMatch = raw.match(
    /\bfor\s+(.+?)(?:\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
  );
  if (forMatch?.[1]) {
    const candidate = normalizeJobAnswer(forMatch[1]);
    if (!/^\$?\s*\d[\d,]*(?:\.\d{1,2})?$/.test(candidate)) jobName = candidate;
  }

  if (!jobName) {
    const jobMatch = raw.match(
      /\bjob\s+(.+?)(?:\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
    );
    if (jobMatch?.[1]) jobName = normalizeJobAnswer(jobMatch[1]);
  }

  // Payer "from X"
  let source = 'Unknown';
  const fromMatch = raw.match(
    /\bfrom\s+(.+?)(?:\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
  );
  if (fromMatch?.[1]) {
    const token2 = normalizeJobAnswer(fromMatch[1]);
    if (looksLikeAddress(token2) || looksLikeAddress(fromMatch[1])) {
      jobName = jobName || token2;
      source = 'Unknown';
    } else {
      source = token2;
    }
  }

  if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

  return normalizeRevenueData(
    {
      date,
      description: 'Revenue received',
      amount,
      source,
      jobName: jobName || null
    },
    tz
  );
}

function buildRevenueSummaryLine({ amount, source, date, jobName }) {
  const amt = String(amount || '').trim();
  const src = String(source || '').trim();
  const dt = String(date || '').trim();
  const jb = jobName ? String(jobName).trim() : '';

  const parts = [];
  parts.push(`Revenue: ${amt}`);
  if (src && src !== 'Unknown') parts.push(`from ${src}`);
  if (dt) parts.push(`on ${dt}`);
  if (jb) parts.push(`for ${jb}`);
  return parts.join(' ') + '.';
}

function resolveJobFromReply(input, pending) {
  const raw = normalizeJobAnswer(input);
  const t = String(raw || '').trim();
  if (!t) return null;

  if (looksLikeOverhead(t)) return 'Overhead';

  const lc = t.toLowerCase();
  if (lc === 'more' || lc === 'more jobs' || lc === 'more jobs…') return '__MORE__';

  if (pending?.revenueJobPickerIdMap && pending.revenueJobPickerIdMap[t]) {
    return pending.revenueJobPickerIdMap[t];
  }

  if (/^\d+$/.test(t) && pending?.revenueJobPickerNumMap?.[t]) {
    return pending.revenueJobPickerNumMap[t];
  }

  if (pending?.revenueJobPickerNameMap) {
    const mapped = pending.revenueJobPickerNameMap[String(t).toLowerCase()];
    if (mapped) return mapped;
  }

  return t;
}

/* ---------------- main handler ---------------- */

async function handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  input = stripRevenuePrefixes(input);

  const lockKey = `lock:${from}`;
  const safeMsgId = String(sourceMsgId || `${from}:${Date.now()}`).trim();

  let reply;

  try {
    const tz = userProfile?.timezone || userProfile?.tz || 'UTC';

    const defaultData = {
      date: todayInTimeZone(tz),
      description: 'Revenue received',
      amount: '$0.00',
      source: 'Unknown'
    };

    let pending = await getPendingTransactionState(from);

    if (pending?.isEditing && pending?.type === 'revenue') {
      if (typeof deletePendingTransactionState === 'function') await deletePendingTransactionState(from);
      pending = null;
    }

    // Awaiting job selection (interactive list or text)
    if (pending?.awaitingRevenueJob && pending?.pendingRevenue) {
      const tok = normalizeDecisionToken(input);

      if (tok === 'change_job') {
        const all = dedupeJobs(await listOpenJobs(ownerId, { limit: 50 }));
        const page = Number(pending.awaitingRevenueJobPage || 0) || 0;
        return await sendJobPickerOrFallback(from, ownerId, all, page, 8);
      }

      const resolved = resolveJobFromReply(input, pending);

      if (resolved === '__MORE__') {
        const all = dedupeJobs(await listOpenJobs(ownerId, { limit: 50 }));
        const nextPage = Number(pending.awaitingRevenueJobPage || 0) + 1;
        return await sendJobPickerOrFallback(from, ownerId, all, nextPage, 8);
      }

      const finalJob = resolved || null;

      const merged = normalizeRevenueData({ ...pending.pendingRevenue, jobName: finalJob }, tz);

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingRevenue: merged,
        awaitingRevenueJob: false,
        awaitingRevenueJobPage: null,
        revenueJobPickerIdMap: null,
        revenueJobPickerNameMap: null,
        revenueJobPickerNumMap: null,
        revenueJobPickerHasMore: null,
        revenueJobPickerTotal: null
      });

      const summaryLine = buildRevenueSummaryLine({
        amount: merged.amount,
        source: merged.source,
        date: merged.date,
        jobName: merged.jobName
      });

      return await sendConfirmRevenueOrFallback(from, summaryLine);
    }

    // Confirm/edit/cancel flow
    if (pending?.pendingRevenue) {
      if (!isOwner) {
        if (typeof deletePendingTransactionState === 'function') await deletePendingTransactionState(from);
        reply = '⚠️ Only the owner can manage revenue.';
        return twimlText(reply);
      }

      const token = normalizeDecisionToken(input);
      const stableMsgId = String(pending?.revenueSourceMsgId || safeMsgId).trim();

      if (token === 'change_job') {
        await mergePendingTransactionState(from, {
          ...(pending || {}),
          awaitingRevenueJob: true,
          awaitingRevenueJobPage: 0
        });

        const all = dedupeJobs(await listOpenJobs(ownerId, { limit: 50 }));
        return await sendJobPickerOrFallback(from, ownerId, all, 0, 8);
      }

      if (token === 'yes') {
        const rawData = pending.pendingRevenue || {};
        const mediaMeta = normalizeMediaMetaForTx(pending?.pendingMediaMeta || null);

        let data = normalizeRevenueData(rawData, tz);

        let category =
          data.suggestedCategory ||
          (await withTimeout(Promise.resolve(categorizeEntry('revenue', data, ownerProfile)), 1200, null)) ||
          null;
        if (category && String(category).trim()) category = String(category).trim();

        let jobName = (data.jobName && String(data.jobName).trim()) || null;
        if (!jobName) {
          jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
        }
        if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

        if (!jobName) {
          await mergePendingTransactionState(from, {
            ...(pending || {}),
            pendingRevenue: { ...data, suggestedCategory: category },
            awaitingRevenueJob: true,
            awaitingRevenueJobPage: 0,
            revenueSourceMsgId: stableMsgId,
            type: 'revenue'
          });

          const all = dedupeJobs(await listOpenJobs(ownerId, { limit: 50 }));
          return await sendJobPickerOrFallback(from, ownerId, all, 0, 8);
        }

        const gate = assertRevenueCILOrClarify({
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
              kind: 'revenue',
              date: data.date || todayInTimeZone(tz),
              description: String(data.description || '').trim() || 'Revenue received',
              amount_cents: amountCents,
              amount: toNumberAmount(data.amount),
              source: String(data.source || '').trim() || 'Unknown',
              job: jobName,
              job_name: jobName,
              category: category ? String(category).trim() : null,
              user_name: userProfile?.name || 'Unknown User',
              source_msg_id: stableMsgId,
              mediaMeta: mediaMeta
            },
            { timeoutMs: 4500 }
          ),
          5000,
          '__DB_TIMEOUT__'
        );

        if (writeResult === '__DB_TIMEOUT__') {
          await mergePendingTransactionState(from, {
            ...(pending || {}),
            pendingRevenue: { ...data, jobName, suggestedCategory: category },
            revenueSourceMsgId: stableMsgId,
            type: 'revenue'
          });

          reply = `⚠️ Saving is taking longer than expected (database slow). Please tap Yes again in a few seconds.`;
          return twimlText(reply);
        }

        const summaryLine = buildRevenueSummaryLine({
          amount: data.amount,
          source: data.source,
          date: data.date || todayInTimeZone(tz),
          jobName
        });

        reply =
          writeResult?.inserted === false
            ? '✅ Already logged that revenue (duplicate message).'
            : `✅ Revenue logged: ${summaryLine}${category ? ` (Category: ${category})` : ''}`;

        if (typeof deletePendingTransactionState === 'function') await deletePendingTransactionState(from);
        return twimlText(reply);
      }

      if (token === 'edit') {
        if (typeof deletePendingTransactionState === 'function') await deletePendingTransactionState(from);
        reply =
          '✏️ Okay — resend the revenue in one line (e.g., "received $2500 from ClientName today for <job>").';
        return twimlText(reply);
      }

      if (token === 'cancel') {
        if (typeof deletePendingTransactionState === 'function') await deletePendingTransactionState(from);
        reply = '❌ Operation cancelled.';
        return twimlText(reply);
      }

      reply = `⚠️ Please choose Yes, Edit, or Cancel.\nTip: reply "change job" to pick a different job.`;
      return twimlText(reply);
    }

    // Backstop deterministic parse
    const backstop = deterministicRevenueParse(input, tz);
    if (backstop && backstop.amount) {
      const data0 = normalizeRevenueData(backstop, tz);

      // normalize "source" that actually contains a job/address
      const existingJob = String(data0.jobName || '').trim();
      const srcRaw = String(data0.source || '').trim();
      if (!existingJob && srcRaw) {
        const srcClean = normalizeJobAnswer(srcRaw);
        const srcLooksJob =
          /^\s*job\b/i.test(srcRaw) || looksLikeAddress(srcClean) || looksLikeAddress(srcRaw);
        if (srcLooksJob) {
          data0.jobName = looksLikeOverhead(srcClean) ? 'Overhead' : srcClean;
          data0.source = 'Unknown';
        }
      }

      const category =
        (await withTimeout(Promise.resolve(categorizeEntry('revenue', data0, ownerProfile)), 1200, null)) ||
        null;

      let jobName = data0.jobName || (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
      if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingRevenue: { ...data0, jobName, suggestedCategory: category },
        revenueSourceMsgId: safeMsgId,
        type: 'revenue',
        awaitingRevenueJob: !jobName,
        awaitingRevenueJobPage: 0
      });

      if (!jobName) {
        const all = dedupeJobs(await listOpenJobs(ownerId, { limit: 50 }));
        return await sendJobPickerOrFallback(from, ownerId, all, 0, 8);
      }

      const summaryLine = buildRevenueSummaryLine({
        amount: data0.amount,
        source: data0.source,
        date: data0.date,
        jobName
      });
      return await sendConfirmRevenueOrFallback(from, summaryLine);
    }

    // AI ingestion fallback (tz-aware)
    const aiRes = await handleInputWithAI(from, input, 'revenue', parseRevenueMessage, defaultData, { tz });

    let data = aiRes?.data || null;
    let aiReply = aiRes?.reply || null;

    if (data) data = normalizeRevenueData(data, tz);

    if (aiReply) {
      // If AI asks a clarification question, store as edit flow (matches expense.js “don’t hard fail”)
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingRevenue: null,
        isEditing: true,
        type: 'revenue'
      });
      return twimlText(aiReply);
    }

    const missingCore = !data || !data.amount || data.amount === '$0.00';

    if (missingCore) {
      reply = `🤔 Couldn’t parse a revenue from "${input}". Try "received $2500 from ClientName today for <job>".`;
      return twimlText(reply);
    }

    // Optional sanity checks (fail-open)
    try {
      let errors = await detectErrors(data, 'revenue');
      if (errors == null) errors = await detectErrors('revenue', data);
      if (errors) {
        const s = String(errors);
        if (!/client:\s*missing|source:\s*missing/i.test(s)) {
          // ignore optional payer/source missing; otherwise allow AI flow to still proceed
        }
      }
    } catch {}

    // normalize "source" that actually contains a job/address
    const existingJob = String(data.jobName || '').trim();
    const srcRaw = String(data.source || '').trim();
    if (!existingJob && srcRaw) {
      const srcClean = normalizeJobAnswer(srcRaw);
      const srcLooksJob =
        /^\s*job\b/i.test(srcRaw) || looksLikeAddress(srcClean) || looksLikeAddress(srcRaw);
      if (srcLooksJob) {
        data.jobName = looksLikeOverhead(srcClean) ? 'Overhead' : srcClean;
        data.source = 'Unknown';
      }
    }

    const category =
      (await withTimeout(Promise.resolve(categorizeEntry('revenue', data, ownerProfile)), 1200, null)) || null;

    let jobName = (data.jobName && String(data.jobName).trim()) || null;
    if (!jobName) jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
    if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

    await mergePendingTransactionState(from, {
      ...(pending || {}),
      pendingRevenue: { ...data, jobName, suggestedCategory: category },
      revenueSourceMsgId: safeMsgId,
      type: 'revenue',
      awaitingRevenueJob: !jobName,
      awaitingRevenueJobPage: 0
    });

    if (!jobName) {
      const all = dedupeJobs(await listOpenJobs(ownerId, { limit: 50 }));
      return await sendJobPickerOrFallback(from, ownerId, all, 0, 8);
    }

    const summaryLine = buildRevenueSummaryLine({
      amount: data.amount,
      source: data.source,
      date: data.date || todayInTimeZone(tz),
      jobName
    });
    return await sendConfirmRevenueOrFallback(from, summaryLine);
  } catch (error) {
    console.error(`[ERROR] handleRevenue failed for ${from}:`, error?.message, {
      code: error?.code,
      detail: error?.detail,
      constraint: error?.constraint
    });
    reply = '⚠️ Error logging revenue. Please try again.';
    return twimlText(reply);
  } finally {
    try {
      await require('../../middleware/lock').releaseLock(lockKey);
    } catch {}
  }
}

module.exports = { handleRevenue };
