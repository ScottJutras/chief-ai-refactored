// handlers/commands/revenue.js
// COMPLETE DROP-IN (BETA-ready; aligned to expense.js patterns + postgres.js expectations)
//
// ✅ Key alignments / fixes vs your pasted revenue.js:
// - Removes duplicate/contradicting helper definitions (your file had multiple waTo/twimlText/sendWhatsAppTemplate/etc)
// - Pending-actions are KIND-AWARE (prefers pg.*ByKind helpers; SQL fallback w/ TTL window)
// - Job picker is JOB_NO-FIRST and deterministic, matching expense.js safety model
//   • supports: jobno_<job_no>, jobix_<row>, numeric replies, "#<job_no>", "J<job_no>", exact job name, overhead, more, change job
//   • stores displayedJobNos to map jobix_/numeric to the exact rows shown
// - Confirm flow mirrors expense.js: confirm PA → optional picker PA → confirm again
// - Uses pg.insertTransaction with source_msg_id idempotency (if supported)
// - Consumes pendingMediaMeta from stateManager (media.js / transcription pipeline)
// - DB timeout UX: keeps confirm PA and asks user to tap Yes again
// - Persists active job after successful log (best-effort), like expense.js
//
// Signature expected by router:
//   handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId)

const pg = require('../../services/postgres');
const state = require('../../utils/stateManager');

const ai = require('../../utils/aiErrorHandler');
const handleInputWithAI = ai.handleInputWithAI;
const parseRevenueMessage = ai.parseRevenueMessage;

const { sendWhatsAppInteractiveList } = require('../../services/twilio');

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

/* ---------------- Constants ---------------- */

const PA_KIND_CONFIRM = 'confirm_revenue';
const PA_KIND_PICK_JOB = 'pick_job_for_revenue';

const PA_TTL_MIN = Number(process.env.PENDING_TTL_MIN || 10);
const PA_TTL_SEC = PA_TTL_MIN * 60;

const ENABLE_INTERACTIVE_LIST = (() => {
  const raw = process.env.TWILIO_ENABLE_INTERACTIVE_LIST ?? process.env.TWILIO_ENABLE_LIST_PICKER ?? 'true';
  return String(raw).trim().toLowerCase() !== 'false';
})();

const DIGITS = (x) => String(x ?? '').replace(/^whatsapp:/i, '').replace(/^\+/, '').replace(/\D/g, '');
const looksLikeUuid = (str) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str || '').trim());

/* ---------------- Pending Actions (KIND-AWARE w/ SQL fallback) ---------------- */

const { query, insertTransaction } = pg;

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
      [DIGITS(owner), String(user), String(k), String(PA_TTL_MIN)]
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
      [DIGITS(owner), String(user), String(k), JSON.stringify(payload || {})]
    );
  } catch (e) {
    // If no unique index exists, fall back to delete+insert
    try {
      await query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [
        DIGITS(owner),
        String(user),
        String(k)
      ]);
      await query(
        `
        INSERT INTO public.pending_actions (owner_id, user_id, kind, payload, created_at)
        VALUES ($1, $2, $3, $4::jsonb, NOW())
        `,
        [DIGITS(owner), String(user), String(k), JSON.stringify(payload || {})]
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
      DIGITS(owner),
      String(user),
      String(k)
    ]);
  } catch {}
}

/* ---------------- TwiML helpers (no duplicates) ---------------- */

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

function out(twiml, sentOutOfBand = false) {
  return { twiml, sentOutOfBand: !!sentOutOfBand };
}

function waTo(from) {
  const d = DIGITS(from);
  return d ? `whatsapp:+${d}` : null;
}

/* ---------------- Date / money helpers ---------------- */

const todayInTimeZone =
  (typeof pg.todayInTZ === 'function' && pg.todayInTZ) ||
  ((tz = 'America/Toronto') => {
    try {
      const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      // en-CA is YYYY-MM-DD in most runtimes; if not, fallback below
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
    return `$${Number(n).toFixed(2)}`;
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

  d.date = String(d.date || '').trim() || todayInTimeZone(tz);

  const desc = String(d.description || '').trim();
  d.description = desc || 'Revenue received';

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

  // keep job_no if present
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

  const owner = DIGITS(ownerId);
  const identity =
    DIGITS(fromPhone) ||
    DIGITS(userProfile?.phone_e164) ||
    DIGITS(userProfile?.phone) ||
    DIGITS(userProfile?.from) ||
    DIGITS(userProfile?.user_id) ||
    DIGITS(userProfile?.id) ||
    DIGITS(userProfile?.userId) ||
    null;

  if (!owner || !identity) return null;

  if (typeof pg.getActiveJobForIdentity === 'function') {
    try {
      const out = await pg.getActiveJobForIdentity(owner, identity);
      return pickActiveJobNameFromAny(out);
    } catch {}
  }

  // optional fallbacks
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
    const owner = DIGITS(ownerId);
    const identity =
      DIGITS(fromPhone) ||
      DIGITS(userProfile?.phone_e164) ||
      DIGITS(userProfile?.phone) ||
      DIGITS(userProfile?.from) ||
      DIGITS(userProfile?.user_id) ||
      DIGITS(userProfile?.id) ||
      DIGITS(userProfile?.userId) ||
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
    return { ok: false, reply: `⚠️ Couldn't log that revenue yet. Try: "received $2500 for <job> today".` };
  }
}

/* ---------------- Job list + picker (JOB_NO-FIRST; deterministic) ---------------- */
function parseTwilioJobIndexToken(s) {
  const m = String(s || '').trim().match(/^job_(\d{1,10})_[0-9a-z]+$/i);
  if (!m?.[1]) return null;
  const ix = Number(m[1]);
  return Number.isFinite(ix) && ix >= 1 ? ix : null;
}

// tiny nonce for “this picker instance”
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

    const jobNo =
      j?.job_no != null ? Number(j.job_no) : j?.jobNo != null ? Number(j.jobNo) : null;
    if (jobNo == null || !Number.isFinite(jobNo)) continue;

    const key = String(jobNo);
    if (seen.has(key)) continue;
    seen.add(key);

    const rawId = j?.id != null ? String(j.id) : j?.job_id != null ? String(j.job_id) : null;
    const safeUuidId = rawId && looksLikeUuid(rawId) ? rawId : null;

    out.push({ id: safeUuidId, job_no: jobNo, name });
  }

  // deterministic order (critical for row mapping)
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


function resolveJobOptionFromReply(rawInput, jobOptions, opts = {}) {
  const s0 = String(rawInput || '').trim();
  const s = normalizeJobAnswer(s0);
  const jobList = Array.isArray(jobOptions) ? jobOptions : [];

  const page = Number(opts.page || 0) || 0;
  const pageSize = Number(opts.pageSize || 8) || 8;
  const displayedJobNos = Array.isArray(opts.displayedJobNos) ? opts.displayedJobNos : null;

  if (/^(overhead|oh)$/i.test(s)) return { kind: 'overhead' };
  if (/^more(\s+jobs)?…?$/i.test(s)) return { kind: 'more' };

  // ✅ Twilio list token: job_<ix>_<hash> (INDEX ONLY)
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

  // jobix_N (row index)
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

  // jobno_<job_no>
  const mNo = String(s).match(/^jobno_(\d{1,10})$/i);
  if (mNo?.[1]) {
    const jobNo = Number(mNo[1]);
    const job = jobList.find((j) => Number(j?.job_no) === jobNo);
    return job ? { kind: 'job', job: { job_no: Number(job.job_no), name: job.name || null, id: job.id || null } } : null;
  }

  // numeric reply "1" means row 1 of displayed slice
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

  // "#1556" => job_no
  const mHash = String(s).match(/^#?\s*(\d{1,10})\b/);
  if (mHash?.[1]) {
    const jobNo = Number(mHash[1]);
    const job = jobList.find((j) => Number(j?.job_no) === jobNo);
    return job ? { kind: 'job', job: { job_no: Number(job.job_no), name: job.name || null, id: job.id || null } } : null;
  }

  // exact name
  const lc = String(s).trim().toLowerCase();
  const byName = jobList.find((j) => String(j?.name || '').trim().toLowerCase() === lc);
  if (byName?.job_no != null) {
    return { kind: 'job', job: { job_no: Number(byName.job_no), name: byName.name || null, id: byName.id || null } };
  }

  return null;
}


async function sendJobPickerOrFallback({ from, ownerId, jobOptions, page = 0, pageSize = 8 }) {
  const to = waTo(from);
  const JOBS_PER_PAGE = Math.min(8, Math.max(1, Number(pageSize || 8)));
  const p = Math.max(0, Number(page || 0));
  const start = p * JOBS_PER_PAGE;

  // Filter + de-dupe by job_no, drop token-garbage names (match expense.js)
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

  // ✅ Deterministic order (interactive list == text == resolver)
  clean.sort((a, b) => Number(a.job_no) - Number(b.job_no));

  const slice = clean.slice(start, start + JOBS_PER_PAGE);

  // ✅ Store the exact job_no’s rendered on THIS page (for mapping jobix / numeric replies)
  const displayedJobNos = slice
    .map((j) => (j?.job_no != null ? Number(j.job_no) : null))
    .filter((n) => Number.isFinite(n));

  const hasMore = start + JOBS_PER_PAGE < clean.length;

  const pickerNonce = makePickerNonce();

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
    shownAt: Date.now(),
    pickerNonce,              // ✅ NEW
    context: 'expense_jobpick' // ✅ NEW (use 'revenue_jobpick' in revenue.js)
  },
  ttlSeconds: PA_TTL_SEC
});


  if (!ENABLE_INTERACTIVE_LIST || !to) {
    return out(twimlText(buildTextJobPrompt(clean, p, JOBS_PER_PAGE)), false);
  }

  // ✅ Interactive rows: stable id is jobno_<job_no>
  const rows = slice.map((j) => {
    const full = sanitizeJobLabel(j?.name || j?.job_name || 'Untitled Job');
    const jobNo = Number(j?.job_no);
    const stamped = `J${jobNo} ${full}`;

    return {
      id: `jobno_${jobNo}`,          // stable token; if Twilio returns it we win
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

    return out(twimlEmpty(), true);
  } catch (e) {
    console.warn('[REVENUE] interactive list failed; falling back:', e?.message);
    return out(twimlText(buildTextJobPrompt(clean, p, JOBS_PER_PAGE)), false);
  }
}


/* ---------------- Confirm message builder ---------------- */

function buildActiveJobHint(jobName, jobSource) {
  if (jobSource !== 'active' || !jobName) return '';
  return `\n\n🧠 Using active job: ${jobName}\nTip: reply "change job" to pick another`;
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

async function sendConfirmRevenueOrFallback(from, summaryLine) {
  // For revenue we keep it simple like expense.js fallback (template optional)
  // If you want templates here, wire like expense.js (contentSid + contentVariables) with your env var(s).
  return out(twimlText(`✅ Confirm revenue\n${summaryLine}\n\nReply: Yes / Edit / Cancel / Change Job`), false);
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

/* ---------------- main handler ---------------- */

async function handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  input = stripRevenuePrefixes(input);

  const safeMsgId = String(sourceMsgId || `${from}:${Date.now()}`).trim();
  const tz = userProfile?.timezone || userProfile?.tz || 'America/Toronto';

  try {
  // ---- 1) Awaiting job pick ----
  const pickPA = await getPA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });

  if (pickPA?.payload?.jobOptions) {
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
      const displayedJobNos = Array.isArray(pickPA.payload.displayedJobNos) ? pickPA.payload.displayedJobNos : [];
      const shownAt = Number(pickPA.payload.shownAt || 0) || 0;

      if (!shownAt || (Date.now() - shownAt) > (PA_TTL_SEC * 1000)) {
        return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page: 0, pageSize: 8 });
      }

      let rawInput = String(input || '').trim();

      // ✅ Twilio list token -> index-only -> jobno_<actual>
      const twIx = parseTwilioJobIndexToken(rawInput);
      if (twIx != null) {
        if (!displayedJobNos.length || displayedJobNos.length < twIx) {
          return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page, pageSize });
        }
        rawInput = `jobno_${Number(displayedJobNos[twIx - 1])}`;
      }

      // ✅ Coerce router-emitted jobix_#
      rawInput = coerceJobixToJobno(rawInput, displayedJobNos);

      console.info('[JOB_PICK_DEBUG]', {
        input,
        rawInput,
        shownAt,
        page,
        displayedJobNos: (displayedJobNos || []).slice(0, 8)
      });

      // ✅ Optional: remember last inbound picker token
      try {
        await upsertPA({
          ownerId,
          userId: from,
          kind: PA_KIND_PICK_JOB,
          payload: { ...(pickPA.payload || {}), lastInboundTextRaw: input, lastInboundText: rawInput },
          ttlSeconds: PA_TTL_SEC
        });
      } catch {}

      if (tok === 'change_job') {
        return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page, pageSize });
      }

      if (tok === 'more') {
        if (!hasMore) {
          return out(twimlText('No more jobs to show. Reply with a number, job name, or "Overhead".'), false);
        }
        return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page: page + 1, pageSize });
      }

      const resolved = resolveJobOptionFromReply(rawInput, jobOptions, { page, pageSize, displayedJobNos });

      if (!resolved) {
        const looksLikeListTap =
          /^jobno_\d{1,10}$/i.test(rawInput) ||
          /^jobix_\d{1,10}$/i.test(rawInput) ||
          /^job_\d{1,10}_[0-9a-z]+$/i.test(rawInput) ||
          /^#\s*\d{1,10}\b/.test(rawInput);

        if (looksLikeListTap) {
          return await sendJobPickerOrFallback({ from, ownerId, jobOptions, page, pageSize });
        }

        return out(twimlText('Please reply with a number, job name, "Overhead", or "more".'), false);
      }

      const confirm = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
      if (!confirm?.payload?.draft) {
        await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });
        return out(twimlText('Got it. Now resend the revenue details.'), false);
      }

      const draft = { ...(confirm.payload.draft || {}) };

      if (resolved.kind === 'overhead') {
        draft.jobName = 'Overhead';
        draft.jobSource = 'overhead';
        draft.job_no = null;
        draft.job_id = null;
      } else if (resolved.kind === 'job' && resolved.job?.job_no != null) {
        const jobName = resolved.job?.name ? String(resolved.job.name).trim() : null;
        draft.jobName = jobName || draft.jobName || null;
        draft.jobSource = 'picked';
        draft.job_no = Number(resolved.job.job_no);
        const jobId = resolved.job?.id && looksLikeUuid(resolved.job.id) ? String(resolved.job.id) : null;
        draft.job_id = jobId;
      } else {
        return out(twimlText('Please reply with a number, job name, "Overhead", or "more".'), false);
      }

      await upsertPA({
        ownerId,
        userId: from,
        kind: PA_KIND_CONFIRM,
        payload: { ...confirm.payload, draft },
        ttlSeconds: PA_TTL_SEC
      });
      await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB });

      const summaryLine = buildRevenueSummaryLine({
        amount: draft.amount,
        source: draft.source,
        date: draft.date,
        jobName: draft.jobName,
        tz
      });

      const summaryLineWithHint = `${summaryLine}${buildActiveJobHint(draft.jobName, draft.jobSource)}`;
      return await sendConfirmRevenueOrFallback(from, summaryLineWithHint);
    }
  }

    // ---- 2) Confirm/edit/cancel ----
    const confirmPA = await getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });

    if (confirmPA?.payload?.draft) {
      if (!isOwner) {
        await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
        return out(twimlText('⚠️ Only the owner can manage revenue.'), false);
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
          twimlText('✏️ Edit revenue\nResend it in one line like:\nreceived $2500 from ClientName today for <job>'),
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

        // mediaMeta can override source_msg_id if transcription pipeline supplies it
        const consumed = await consumePendingMediaMeta(from);
        const mediaMeta = consumed?.mediaMeta || null;
        const stableMsgId2 = String(consumed?.source_msg_id || stableMsgId || safeMsgId).trim();

        // Never allow numeric job id to be written into tx.job_id
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

        // category (best-effort)
        let category =
          data.suggestedCategory ||
          (await withTimeout(Promise.resolve(categorizeEntry('revenue', data, ownerProfile)), 1200, null)) ||
          null;
        if (category && String(category).trim()) category = String(category).trim();
        else category = null;

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
              sourceMsgId: stableMsgId2
            },
            ttlSeconds: PA_TTL_SEC
          });

          if (!jobs.length) return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);
          return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
        }

        const gate = assertRevenueCILOrClarify({ from, data, jobName, category, sourceMsgId: stableMsgId2 });
        if (!gate.ok) return out(twimlText(String(gate.reply || '').slice(0, 1500)), false);

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
              job_id: maybeJobId || null, // UUID only
              job_no: jobNo,              // job_no-first (matches expense.js / your job picker model)
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
                job_id: maybeJobId || null,
                job_no: jobNo
              },
              sourceMsgId: stableMsgId2
            },
            ttlSeconds: PA_TTL_SEC
          });

          return out(
            twimlText('⚠️ Saving is taking longer than expected (database slow). Please tap Yes again in a few seconds.'),
            false
          );
        }

        // Persist active job after successful log (best-effort)
        try {
          await persistActiveJobFromRevenue({ ownerId, fromPhone: from, userProfile, jobNo, jobName });
        } catch {}

        const summaryLine = buildRevenueSummaryLine({
          amount: data.amount,
          source: data.source,
          date: data.date || todayInTimeZone(tz),
          jobName,
          tz
        });

        const reply =
          writeResult?.inserted === false
            ? '✅ Already logged that revenue (duplicate message).'
            : `✅ Logged revenue\n${summaryLine}${category ? `\nCategory: ${category}` : ''}${buildActiveJobHint(jobName, jobSource)}`;

        await deletePA({ ownerId, userId: from, kind: PA_KIND_CONFIRM });
        try { await deletePA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB }); } catch {}

        return out(twimlText(reply), false);
      }

      return out(
        twimlText('⚠️ Please choose Yes, Edit, Cancel, or Change Job.\nTip: reply "change job" to pick a different job.'),
        false
      );
    }

    // ---- 3) New revenue parse (AI first-pass; keep behavior; beta hardening) ----
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

    // Keep your behavior: if AI produced a reply, respect it (but only if core is missing)
    const missingCore = !data || !data.amount || data.amount === '$0.00';
    if (aiReply && missingCore) return out(twimlText(aiReply), false);

    if (missingCore) {
      return out(
        twimlText(`🤔 Couldn’t parse a revenue from "${input}". Try "received $2500 from ClientName today for <job>".`),
        false
      );
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
        draft: {
          ...data,
          jobName,
          jobSource: jobSource || null,
          suggestedCategory: category,
          job_id: null,
          job_no: null,

          // Persist source text so YES-path can recover context if needed later
          originalText: input,
          draftText: input
        },
        sourceMsgId: safeMsgId,
        type: 'revenue'
      },
      ttlSeconds: PA_TTL_SEC
    });

    if (!jobName) {
      const jobs = normalizeJobOptions(await listOpenJobsDetailed(ownerId, 50));
      if (!jobs.length) return out(twimlText('No jobs found. Reply "Overhead" or create a job first.'), false);
      return await sendJobPickerOrFallback({ from, ownerId, jobOptions: jobs, page: 0, pageSize: 8 });
    }

    const summaryLine = buildRevenueSummaryLine({
      amount: data.amount,
      source: data.source,
      date: data.date || todayInTimeZone(tz),
      jobName,
      tz
    });

    return await sendConfirmRevenueOrFallback(from, `${summaryLine}${buildActiveJobHint(jobName, jobSource)}`);
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
