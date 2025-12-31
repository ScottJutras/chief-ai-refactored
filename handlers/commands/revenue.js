// handlers/commands/revenue.js
// COMPLETE DROP-IN (aligned to expense.js Option A + webhook.js expectations)
//
// ✅ Alignments in this drop-in:
// - Uses pending_actions (PA) confirm flow like expense.js (PA_KIND_CONFIRM + PA_KIND_PICK_JOB)
// - Pending-actions access is KIND-AWARE:
//    • Uses pg.getPendingActionByKind / upsertPendingActionByKind / deletePendingActionByKind when present
//    • Otherwise falls back to SQL on public.pending_actions with TTL window
// - Job picker supports:
//    • WhatsApp interactive list row ids: jobno_<job_no>
//    • numeric replies ("2")
//    • exact job name / prefix match
//    • "overhead" + "more" + "change job"
// - Uses pg.insertTransaction with source_msg_id idempotency (if supported)
// - Consumes pendingMediaMeta from stateManager (media.js/transcription pipeline)
// - DB timeout UX: keep confirm PA and ask user to tap Yes again
//
// Signature expected by router:
//   handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId)

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


const { insertTransaction } = pg;

const state = require('../../utils/stateManager');

const ai = require('../../utils/aiErrorHandler');
const handleInputWithAI = ai.handleInputWithAI;
const parseRevenueMessage = ai.parseRevenueMessage;

const categorizeEntry =
  (typeof ai.categorizeEntry === 'function' && ai.categorizeEntry) || (async () => null); // fail-open

// ---- CIL validator (fail-open) ----
const cilMod = require('../../cil');
const { waTo, upsertPA, PA_KIND_PICK_JOB, PA_TTL_SEC, ENABLE_INTERACTIVE_LIST, out, twimlText, buildTextJobPrompt, twimlEmpty } = require('./expense');
const validateCIL =
  (cilMod && typeof cilMod.validateCIL === 'function' && cilMod.validateCIL) ||
  (cilMod && typeof cilMod.validateCil === 'function' && cilMod.validateCil) ||
  (cilMod && typeof cilMod.validate === 'function' && cilMod.validate) ||
  (typeof cilMod === 'function' && cilMod) ||
  null;

/* ---------------- Pending Actions (DB) ---------------- */

const PA_KIND_CONFIRM = 'confirm_revenue';
const PA_KIND_PICK_JOB = 'pick_job_for_revenue';

// TTL minutes should match webhook.js / postgres.js config
const PA_TTL_MIN = Number(process.env.PENDING_TTL_MIN || 10);
const PA_TTL_SEC = PA_TTL_MIN * 60;

// Prefer pg query if present
const { query } = pg;

// Prefer kind-aware helpers if present
const pgGetPendingActionByKind =
  (typeof pg.getPendingActionByKind === 'function' && pg.getPendingActionByKind) || null;
const pgUpsertPendingActionByKind =
  (typeof pg.upsertPendingActionByKind === 'function' && pg.upsertPendingActionByKind) ||
  (typeof pg.upsertPendingAction === 'function' && pg.upsertPendingAction) ||
  null;
const pgDeletePendingActionByKind =
  (typeof pg.deletePendingActionByKind === 'function' && pg.deletePendingActionByKind) || null;

// Best-effort KIND-aware PA access with SQL fallback
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
      [owner, user, k, String(PA_TTL_MIN)]
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
    // Assumes you have (owner_id,user_id,kind) unique OR this will error and we fall back to delete+insert
    await query(
      `
      INSERT INTO public.pending_actions (owner_id, user_id, kind, payload, created_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (owner_id, user_id, kind)
      DO UPDATE SET payload = EXCLUDED.payload, created_at = now()
      `,
      [owner, user, k, payload || {}]
    );
  } catch {
    try {
      await query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [owner, user, k]);
      await query(
        `
        INSERT INTO public.pending_actions (owner_id, user_id, kind, payload, created_at)
        VALUES ($1, $2, $3, $4, now())
        `,
        [owner, user, k, payload || {}]
      );
    } catch {
      // ignore
    }
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

  if (typeof query !== 'function') return;

  try {
    await query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [owner, user, k]);
  } catch {
    // ignore
  }
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
  if (!waFrom && !messagingServiceSid) throw new Error('Missing TWILIO_WHATSAPP_FROM or TWILIO_MESSAGING_SERVICE_SID');
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

async function sendConfirmRevenueOrFallback(from, summaryLine) {
  const sid = getRevenueConfirmTemplateSid();
  const to = waTo(from);

  if (sid && to) {
    try {
      await sendWhatsAppTemplate({ to, templateSid: sid, summaryLine });
      return twimlEmpty();
    } catch (e) {
      console.warn('[REVENUE] template send failed; falling back to TwiML:', e?.message);
    }
  }

  return twimlText(`✅ Confirm revenue\n${summaryLine}\n\nReply: Yes / Edit / Cancel / Change Job`);
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
    const fmt = new Intl.NumberFormat('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str || ''));
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

  if (d.jobSource != null) {
    const js = String(d.jobSource).trim();
    d.jobSource = js || null;
  }

  return d;
}

async function withTimeout(promise, ms, fallbackValue = '__TIMEOUT__') {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))]);
}

/* ---------------- Active job resolution ---------------- */

async function resolveActiveJobName({ ownerId, userProfile, fromPhone }) {
  const directName = userProfile?.active_job_name || userProfile?.activeJobName || null;
  if (directName && String(directName).trim()) return String(directName).trim();

  if (typeof pg.getActiveJobForIdentity === 'function') {
    try {
      const out = await pg.getActiveJobForIdentity(String(ownerId), String(fromPhone));
      const nm = out?.active_job_name ?? out?.activeJobName ?? null;
      if (nm && String(nm).trim()) return String(nm).trim();
    } catch {}
  }

  return null;
}

/* ---------------- Media: consume pendingMediaMeta from stateManager ---------------- */

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

async function consumePendingMediaMeta(from) {
  try {
    const getPending = state.getPendingTransactionState || state.getPendingState || (async () => null);

    const mergePending =
      state.mergePendingTransactionState ||
      (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

    const pending = await getPending(from);
    const m = pending?.pendingMediaMeta || null;
    if (!m) return null;

    const raw = {
      url: m.url || m.media_url || null,
      type: m.type || m.media_type || null,
      transcript: truncateText(m.transcript || m.media_transcript || null, MAX_MEDIA_TRANSCRIPT_CHARS),
      confidence: m.confidence ?? m.media_confidence ?? null
    };

    const mediaMeta = typeof pg.normalizeMediaMeta === 'function' ? pg.normalizeMediaMeta(raw) : raw;

    const source_msg_id = m.source_msg_id ? String(m.source_msg_id) : null;

    await mergePending(from, { pendingMediaMeta: null });

    return { mediaMeta, source_msg_id };
  } catch {
    return null;
  }
}

/* ---------------- CIL (fail-open) ---------------- */

function buildRevenueCIL({ from, data, jobName, category, sourceMsgId }) {
  const cents = toCents(data.amount);

  const description =
    String(data.description || '').trim() && data.description !== 'Unknown' ? String(data.description).trim() : 'Revenue Logged';

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

function assertRevenueCILOrClarify({ from, data, jobName, category, sourceMsgId }) {
  try {
    const cil = buildRevenueCIL({ from, data, jobName, category, sourceMsgId });

    if (typeof validateCIL !== 'function') return { ok: true, cil, skipped: true };

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

/* ---------------- Job options + picker ---------------- */

async function listOpenJobsDetailedBestEffort(ownerId, limit = 50) {
  if (typeof pg.listOpenJobsDetailed === 'function') {
    try {
      const rows = await pg.listOpenJobsDetailed(ownerId, limit);
      return Array.isArray(rows) ? rows : [];
    } catch {}
  }

  if (typeof pg.listOpenJobs === 'function') {
    try {
      const rows = await pg.listOpenJobs(ownerId, { limit });
      if (!Array.isArray(rows)) return [];
      if (typeof rows[0] === 'string') return rows.map((name) => ({ name, job_name: name }));
      return rows;
    } catch {}
  }

  return [];
}

function normalizeJobOptions(jobRows) {
  const out = [];
  const seen = new Set();

  for (const r of jobRows || []) {
    const name = String(r?.name || r?.job_name || r || '').trim();
    if (!name) continue;
    const job_no = r?.job_no != null && Number.isFinite(Number(r.job_no)) ? Number(r.job_no) : null;

    const key = `${String(job_no ?? '').trim()}::${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: r?.id != null ? String(r.id) : null, // may be integer in your jobs table (do NOT use as tx.job_id)
      job_no,
      name
    });
  }

  return out;
}

function buildTextJobPrompt(jobOptions, page, pageSize) {
  const p = Math.max(0, Number(page || 0));
  const ps = Math.min(8, Math.max(1, Number(pageSize || 8)));

  const start = p * ps;
  const slice = (jobOptions || []).slice(start, start + ps);

  const lines = slice.map((j, i) => {
    const name = String(j?.name || j?.job_name || 'Untitled Job').trim();
    const jobNo = j?.job_no != null ? Number(j.job_no) : null;
    const prefix = jobNo != null && Number.isFinite(jobNo) ? `#${jobNo} ` : '';
    return `${i + 1}) ${prefix}${name}`;
  });

  const hasMore = start + ps < (jobOptions || []).length;
  const more = hasMore ? `\nReply "more" for more jobs.` : '';

  return `Which job is this revenue for?\n\n${lines.join('\n')}\n\nReply with a number, job name, or "Overhead".${more}\nTip: reply "change job" to see the picker.`;
}

const ENABLE_INTERACTIVE_LIST = (() => {
  const raw = process.env.TWILIO_ENABLE_INTERACTIVE_LIST ?? process.env.TWILIO_ENABLE_LIST_PICKER ?? 'true';
  return String(raw).trim().toLowerCase() !== 'false';
})();

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

function looksLikeNewRevenueText(s = '') {
  const lc = String(s || '').trim().toLowerCase();
  if (!lc) return false;

  if (/^(revenue|rev|received|deposit|paid|payment)\b/.test(lc)) return true;

  return /\b(received|deposit|paid|payment|etransfer|e-transfer|interac|invoice|cheque|check)\b/.test(lc)
    && /\$?\s*\d+(\.\d{1,2})?\b/.test(lc);
}


async function sendJobPickerOrFallback({ from, ownerId, jobOptions, page = 0, pageSize = 8 }) {
  const to = waTo(from);
  const JOBS_PER_PAGE = Math.min(8, Math.max(1, Number(pageSize || 8)));
  const p = Math.max(0, Number(page || 0));
  const start = p * JOBS_PER_PAGE;

  const clean = (jobOptions || []).filter((j) => {
    const n = j?.job_no != null ? Number(j.job_no) : null;
    return n != null && Number.isFinite(n);
  });

  const slice = clean.slice(start, start + JOBS_PER_PAGE);
  const hasMore = start + JOBS_PER_PAGE < clean.length;

  await upsertPA({
    ownerId,
    userId: from,
    kind: PA_KIND_PICK_JOB,
    payload: { jobOptions: clean, page: p, pageSize: JOBS_PER_PAGE, hasMore, shownAt: Date.now() },
    ttlSeconds: PA_TTL_SEC
  });

  if (!ENABLE_INTERACTIVE_LIST || !to) {
    // plain text (TwiML) fallback
    return out(twimlText(buildTextJobPrompt(clean, p, JOBS_PER_PAGE)), false);
  }

  const rows = slice.map((j) => {
    const full = String(j?.name || j?.job_name || 'Untitled Job').trim();
    const jobNo = Number(j.job_no);
    return { id: `jobno_${jobNo}`, title: full.slice(0, 24), description: `#${jobNo} ${full.slice(0, 72)}` };
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


function resolveJobOptionFromReply(input, jobOptions, { page = 0, pageSize = 8 } = {}) {
  const raw = normalizeJobAnswer(input);
  const t = String(raw || '').trim();
  if (!t) return null;

  const lc = t.toLowerCase();
  if (looksLikeOverhead(t)) return { kind: 'overhead' };
  if (lc === 'more' || lc === 'more jobs' || lc === 'more jobs…') return { kind: 'more' };

  const p = Math.max(0, Number(page || 0));
  const ps = Math.min(8, Math.max(1, Number(pageSize || 8)));

  // 1) jobno_123
  const mJobNo = t.match(/^jobno_(\d{1,10})$/i);
  if (mJobNo?.[1]) {
    const jobNo = Number(mJobNo[1]);
    if (!Number.isFinite(jobNo)) return null;

    const opt = (jobOptions || []).find((j) => Number(j?.job_no) === jobNo) || null;
    if (!opt) return null;

    return { kind: 'job', job: opt };
  }

  // 2) "#6 Happy Street" OR "6 Happy Street" -> job_no = 6
  const mHash = t.match(/^#?\s*(\d{1,10})\b/);
  if (mHash?.[1]) {
    const jobNo = Number(mHash[1]);
    if (Number.isFinite(jobNo)) {
      const opt = (jobOptions || []).find((j) => Number(j?.job_no) === jobNo) || null;
      if (opt) return { kind: 'job', job: opt };
    }
  }

  // 3) Page index selection
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return null;

    const start = p * ps;
    const idx = start + (n - 1);
    const opt = (jobOptions || [])[idx] || null;
    if (!opt) return null;

    const jobNo = opt?.job_no != null ? Number(opt.job_no) : null;
    if (jobNo == null || !Number.isFinite(jobNo)) return null;

    return { kind: 'job', job: opt };
  }

  // 4) Name match
  const opt =
    (jobOptions || []).find((j) => String(j?.name || j?.job_name || '').trim().toLowerCase() === lc) ||
    (jobOptions || []).find((j) => String(j?.name || j?.job_name || '').trim().toLowerCase().startsWith(lc.slice(0, 24))) ||
    null;

  if (opt) {
    const jobNo = opt?.job_no != null ? Number(opt.job_no) : null;
    if (jobNo == null || !Number.isFinite(jobNo)) return null;
    return { kind: 'job', job: opt };
  }

  return null;
}


function buildRevenueSummaryLine({ amount, source, date, jobName, tz }) {
  const amt = String(amount || '').trim();
  const src = String(source || '').trim();
  const dt = formatDisplayDate(date, tz);
  const jb = jobName ? String(jobName).trim() : '';

  const lines = [];
  lines.push(`💰 ${amt}`);
  if (src && src !== 'Unknown') lines.push(`👤 ${src}`);
  if (dt) lines.push(`📅 ${dt}`);
  if (jb) lines.push(`🧰 ${jb}`);

  return lines.join('\n');
}

/* ---------------- main handler ---------------- */

async function handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  input = stripRevenuePrefixes(input);

  const safeMsgId = String(sourceMsgId || `${from}:${Date.now()}`).trim();
  const tz = userProfile?.timezone || userProfile?.tz || 'America/Toronto';

  try {
   // ---- 1) Awaiting job pick ----
const pickPA = await getPA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });

if (pickPA?.payload?.jobOptions) {
  // If the user sent brand new revenue while we were waiting for a job pick,
  // clear state and fall through to normal parsing (do NOT return).
  if (looksLikeNewRevenueText(input)) {
    console.info('[REVENUE] pick-job bypass: new revenue detected, clearing PAs');
    try { await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB }); } catch {}
    try { await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM }); } catch {}
  } else {
    const tok = normalizeDecisionToken(input);

    const jobOptions = Array.isArray(pickPA.payload.jobOptions) ? pickPA.payload.jobOptions : [];
    const page = Number(pickPA.payload.page || 0) || 0;
    const pageSize = Number(pickPA.payload.pageSize || 8) || 8;
    const hasMore = !!pickPA.payload.hasMore;

    if (tok === 'change_job') {
      return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page, pageSize });
    }

    if (tok === 'more') {
      if (!hasMore) return twimlText('No more jobs to show. Reply with a number, job name, or "Overhead".');
      return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page: page + 1, pageSize });
    }

    const resolved = resolveJobOptionFromReply(input, jobOptions, { page, pageSize });
    if (!resolved) return twimlText('Please reply with a number, job name, "Overhead", or "more".');

    const confirm = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
    if (!confirm?.payload?.draft) {
      await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
      return twimlText('Got it. Now resend the revenue details.');
    }

    if (resolved.kind === 'overhead') {
      confirm.payload.draft.jobName = 'Overhead';
      confirm.payload.draft.jobSource = 'overhead';
      confirm.payload.draft.job = { id: null, job_no: null, name: 'Overhead' };
      confirm.payload.draft.job_id = null;
    } else if (resolved.kind === 'job') {
      const jobName = resolved.job?.name ? String(resolved.job.name).trim() : null;
      const jobId = resolved.job?.id ? String(resolved.job.id).trim() : null;

      confirm.payload.draft.jobName = jobName || confirm.payload.draft.jobName || null;
      confirm.payload.draft.jobSource = 'picked';

      confirm.payload.draft.job = {
        id: jobId && looksLikeUuid(jobId) ? jobId : null,
        job_no: resolved.job?.job_no != null ? Number(resolved.job.job_no) : null,
        name: jobName || null
      };

      confirm.payload.draft.job_id = jobId && looksLikeUuid(jobId) ? jobId : null;
    } else {
      return twimlText('Please reply with a number, job name, "Overhead", or "more".');
    }

    await upsertPA({
      ownerId,
      userId: from,
      kind: PA_KIND_CONFIRM,
      payload: confirm.payload,
      ttlSeconds: PA_TTL_SEC
    });
    await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });

    const summaryLine = buildRevenueSummaryLine({
      amount: confirm.payload.draft.amount,
      source: confirm.payload.draft.source,
      date: confirm.payload.draft.date,
      jobName: confirm.payload.draft.jobName,
      tz
    });

    const summaryLineWithHint = `${summaryLine}${buildActiveJobHint(confirm.payload.draft.jobName, confirm.payload.draft.jobSource)}`;
    return await sendConfirmRevenueOrFallback(from, summaryLineWithHint);
  }
}

// ---- 2) Confirm/edit/cancel ----
const confirmPA = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });

if (confirmPA?.payload?.draft) {
  if (!isOwner) {
    await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
    return twimlText('⚠️ Only the owner can manage revenue.');
  }

  const token = normalizeDecisionToken(input);
  const stableMsgId = String(confirmPA?.payload?.sourceMsgId || safeMsgId || '').trim() || null;

  if (token === 'change_job') {
    const jobs = normalizeJobOptions(await listOpenJobsDetailedBestEffort(ownerId, 50));
    if (!jobs.length) return twimlText('No jobs found. Reply "Overhead" or create a job first.');
    return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
  }

  if (token === 'edit') {
    await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
    return twimlText('✏️ Edit revenue\nResend it in one line like:\nreceived $2500 from ClientName "date/today" for <job>');
  }

  if (token === 'cancel') {
    await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
    try { await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB }); } catch {}
    return twimlText('❌ Operation cancelled.');
  }

  if (token === 'yes') {
    const rawDraft = { ...(confirmPA.payload.draft || {}) };

    const consumed = await consumePendingMediaMeta(from);
    const mediaMeta = consumed?.mediaMeta || null;
    const stableMsgId2 = String(consumed?.source_msg_id || stableMsgId || safeMsgId).trim();

    const rawJobId =
      rawDraft?.job_id ?? rawDraft?.jobId ?? rawDraft?.job?.id ?? rawDraft?.job?.job_id ?? null;

    if (rawJobId != null && /^\d+$/.test(String(rawJobId).trim())) {
      console.warn('[REVENUE] refusing numeric job id; forcing null', { job_id: rawJobId });
      if (rawDraft.job && typeof rawDraft.job === 'object') rawDraft.job.id = null;
      rawDraft.job_id = null;
      rawDraft.jobId = null;
    }

    const maybeJobId = rawJobId != null && looksLikeUuid(String(rawJobId)) ? String(rawJobId).trim() : null;

    let data = normalizeRevenueData(rawDraft, tz);

    let category =
      data.suggestedCategory ||
      (await withTimeout(Promise.resolve(categorizeEntry('revenue', data, ownerProfile)), 1200, null)) ||
      null;
    if (category && String(category).trim()) category = String(category).trim();
    else category = null;

    const pickedJobName = data.jobName && String(data.jobName).trim() ? String(data.jobName).trim() : null;

    let jobName = pickedJobName || rawDraft?.jobName || null;
    let jobSource = rawDraft?.jobSource || (pickedJobName ? 'typed' : null);

    if (!jobName) {
      jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
      if (jobName) jobSource = 'active';
    }

    if (jobName && looksLikeOverhead(jobName)) {
      jobName = 'Overhead';
      jobSource = 'overhead';
    }

    if (!jobName) {
      const jobs = normalizeJobOptions(await listOpenJobsDetailedBestEffort(ownerId, 50));

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
            job_id: maybeJobId || null
          },
          sourceMsgId: stableMsgId2
        },
        ttlSeconds: PA_TTL_SEC
      });

      if (!jobs.length) return twimlText('No jobs found. Reply "Overhead" or create a job first.');
      return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
    }

    const gate = assertRevenueCILOrClarify({ from, data, jobName, category, sourceMsgId: stableMsgId2 });
    if (!gate.ok) return twimlText(String(gate.reply || '').slice(0, 1500));

    const amountCents = toCents(data.amount);
    if (!amountCents || amountCents <= 0) throw new Error('Invalid amount');

    const writeResult = await withTimeout(
      insertTransaction(
        {
          ownerId: DIGITS(ownerId),
          kind: 'revenue',
          date: data.date || todayInTimeZone(tz),
          description: String(data.description || '').trim() || 'Revenue received',
          amount_cents: amountCents,
          amount: toNumberAmount(data.amount),
          source: String(data.source || '').trim() || 'Unknown',
          job: jobName,
          job_name: jobName,
          job_id: maybeJobId || null,
          category: category ? String(category).trim() : null,
          user_name: userProfile?.name || 'Unknown User',
          source_msg_id: stableMsgId2,
          ...(mediaMeta ? { mediaMeta } : {})
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
            jobSource: jobSource || null,
            suggestedCategory: category,
            job_id: maybeJobId || null
          },
          sourceMsgId: stableMsgId2
        },
        ttlSeconds: PA_TTL_SEC
      });

      return twimlText('⚠️ Saving is taking longer than expected (database slow). Please tap Yes again in a few seconds.');
    }

    const summaryLine = buildRevenueSummaryLine({
      amount: data.amount,
      source: data.source,
      date: data.date || todayInTimeZone(tz),
      jobName,
      tz
    });

    const activeHint = buildActiveJobHint(jobName, jobSource);

    const reply =
      writeResult?.inserted === false
        ? '✅ Already logged that revenue (duplicate message).'
        : `✅ Logged revenue\n${summaryLine}${category ? `\nCategory: ${category}` : ''}${activeHint}`;

    await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
    try { await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB }); } catch {}

    return twimlText(reply);
  }

  return twimlText('⚠️ Please choose Yes, Edit, Cancel, or Change Job.\nTip: reply "change job" to pick a different job.');
}


    // ---------------- 3) First-pass parse (deterministic, then AI fallback) ----------------
    const defaultData = {
      date: todayInTimeZone(tz),
      description: 'Revenue received',
      amount: '$0.00',
      source: 'Unknown'
    };

    const aiRes = await handleInputWithAI(from, input, 'revenue', parseRevenueMessage, defaultData, { tz });

    let data = aiRes?.data || null;
    let aiReply = aiRes?.reply || null;

    if (data) data = normalizeRevenueData(data, tz);

    if (aiReply) return twimlText(aiReply);

    const missingCore = !data || !data.amount || data.amount === '$0.00';
    if (missingCore) {
      return twimlText(`🤔 Couldn’t parse a revenue from "${input}". Try "received $2500 from ClientName date/today for <job>".`);
    }

    let category = (await withTimeout(Promise.resolve(categorizeEntry('revenue', data, ownerProfile)), 1200, null)) || null;
    if (category && String(category).trim()) category = String(category).trim();
    else category = null;

    let jobName = (data.jobName && String(data.jobName).trim()) || null;
    let jobSource = jobName ? 'typed' : null;

    if (!jobName) {
      jobName = (await resolveActiveJobName({ ownerId, userProfile, fromPhone: from })) || null;
      if (jobName) jobSource = 'active';
    }

    if (jobName && looksLikeOverhead(jobName)) {
      jobName = 'Overhead';
      jobSource = 'overhead';
    }

    await upsertPA({
      ownerId,
      userId: from,
      kind: PA_KIND_CONFIRM,
      payload: {
        draft: { ...data, jobName, jobSource: jobSource || null, suggestedCategory: category },
        sourceMsgId: safeMsgId
      },
      ttlSeconds: PA_TTL_SEC
    });

    if (!jobName) {
      const jobs = normalizeJobOptions(await listOpenJobsDetailedBestEffort(ownerId, 50));
      return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
    }

    const summaryLine = buildRevenueSummaryLine({
      amount: data.amount,
      source: data.source,
      date: data.date || todayInTimeZone(tz),
      jobName,
      tz
    });

    const summaryLineWithHint = `${summaryLine}${buildActiveJobHint(jobName, jobSource)}`;
    return await sendConfirmRevenueOrFallback(from, summaryLineWithHint);
  } catch (error) {
    console.error(`[ERROR] handleRevenue failed for ${from}:`, error?.message, {
      code: error?.code,
      detail: error?.detail,
      constraint: error?.constraint
    });
    return twimlText('⚠️ Error logging revenue. Please try again.');
  }
}

module.exports = { handleRevenue };
