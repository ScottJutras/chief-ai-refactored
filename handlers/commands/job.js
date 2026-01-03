// handlers/commands/job.js
// COMPLETE DROP-IN (BETA-ready; aligned to revenue.js + expense.js + postgres.js)
//
// ✅ What this version fixes / aligns:
// - Job picker IDs now match revenue/expense: `jobno_<job_no>` (stable), plus legacy `job_<n>_<hash>` support
// - Picker state stores jobOptions + displayedJobNos so replies "1" (page-relative), "#6", "jobno_6", or job name work reliably
// - Active-job persistence aligns with revenue.js safety rules:
//   • NEVER write non-UUID into job_id columns
//   • Prefer pg.setActiveJobForIdentity(owner, identityDigits, jobId(uuid|null), jobName|null)
//   • Fallback to pg.setActiveJob(owner, identityDigits, jobRef) and other aliases
//   • Last-resort SQL updates are UUID-only
// - ENABLE_LIST_PICKER default matches expense.js behavior (true unless explicitly "false")
// - Uses Twilio interactive list helper if available (services/twilio), otherwise falls back to Twilio Content API list-picker, otherwise text
// - Keeps existing commands: list jobs, create job idempotent, set active job by name, open picker, cancel, more
//
// Signature:
//   handleJob(fromPhone, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId)

const pg = require('../../services/postgres');
const state = require('../../utils/stateManager');

// Twilio helpers (preferred)
let sendWhatsAppInteractiveList = null;
try {
  const tw = require('../../services/twilio');
  sendWhatsAppInteractiveList = typeof tw.sendWhatsAppInteractiveList === 'function' ? tw.sendWhatsAppInteractiveList : null;
} catch {}

// ✅ fetch polyfill so Content API list-picker doesn't silently fail
const fetch = global.fetch || require('node-fetch');

const getPendingTransactionState = state.getPendingTransactionState || state.getPendingState || (async () => null);
const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

/* ---------------- helpers ---------------- */

function DIGITS(x) {
  return String(x ?? '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\D/g, '');
}

function ownerDigits(ownerId, fromPhone) {
  const base = ownerId || fromPhone;
  const s = String(base || '').trim();
  if (!s) return null;
  return DIGITS(s) || null;
}

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlText(message) {
  return `<Response><Message>${escapeXml(message)}</Message></Response>`;
}

function twimlEmpty() {
  return `<Response></Response>`;
}

function respond(res, message) {
  const twiml = twimlText(message);
  if (res && typeof res.send === 'function' && !res.headersSent) {
    res.type('text/xml').send(twiml);
  }
  return twiml;
}

function waTo(fromPhone) {
  const s = String(fromPhone || '').trim();
  if (!s) return null;
  if (s.startsWith('whatsapp:')) return s;
  const digits = DIGITS(s);
  return digits ? `whatsapp:+${digits}` : null;
}

function stableHash(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(str || '').trim()
  );
}

function isGarbageJobName(name) {
  const lc = String(name || '').trim().toLowerCase();
  return (
    !lc ||
    lc === 'cancel' ||
    lc === 'show active jobs' ||
    lc === 'active jobs' ||
    lc === 'change job' ||
    lc === 'switch job' ||
    lc === 'pick job' ||
    lc === 'job list' ||
    lc === 'jobs'
  );
}

function sanitizeJobLabel(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isPickerOpenCommand(lc) {
  return /^(show\s+active\s+jobs|active\s+jobs|list\s+active\s+jobs|pick\s+job|change\s+job|show\s+job\s+list|job\s+list)\b/.test(
    lc
  );
}

function isCancelLike(lc) {
  return /^(cancel|stop|no)\b/.test(lc);
}

function isMoreLike(lc) {
  return /^(more|more jobs|more jobs…)\b/.test(lc);
}

function normalizeJobAnswer(text) {
  let s = String(text || '').trim();
  if (!s) return s;

  // canonical tokens
  if (/^jobno_\d{1,10}$/i.test(s)) return s.toLowerCase();
  if (/^jobix_\d{1,10}$/i.test(s)) return s.toLowerCase();

  // legacy Content API row id: job_<N>_<hash> (absolute row)
  const mLegacy = s.match(/^job_(\d{1,10})_[0-9a-z]+$/i);
  if (mLegacy?.[1]) return `jobix_${mLegacy[1]}`;

  // "#6 ..." or "J6 ..." (job_no stamp)
  const mHash = s.match(/^#?\s*(\d{1,10})\b/);
  if (mHash?.[1]) return `jobno_${mHash[1]}`;
  const mStamp = s.match(/\bJ(\d{1,10})\b/i);
  if (mStamp?.[1]) return `jobno_${mStamp[1]}`;

  // cleanup
  s = s.replace(/^(job\s*name|job)\s*[:\-]?\s*/i, '');
  s = s.replace(/[?]+$/g, '').trim();
  return s;
}

/* ---------------- feature flags ---------------- */

// Align with expense.js: enable unless explicitly false
const ENABLE_LIST_PICKER = (() => {
  const raw = process.env.TWILIO_ENABLE_LIST_PICKER ?? process.env.TWILIO_ENABLE_INTERACTIVE_LIST ?? 'true';
  return String(raw).trim().toLowerCase() !== 'false';
})();

/* ---------------- Twilio Content API list-picker fallback (kept) ---------------- */

const CONTENT_API_BASE = 'https://content.twilio.com/v1/Content';
const _contentSidCache = new Map(); // key -> { sid, at }
const CONTENT_SID_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function _cacheGet(key) {
  const v = _contentSidCache.get(key);
  if (!v) return null;
  if (Date.now() - v.at > CONTENT_SID_CACHE_TTL_MS) {
    _contentSidCache.delete(key);
    return null;
  }
  return v.sid;
}
function _cacheSet(key, sid) {
  _contentSidCache.set(key, { sid, at: Date.now() });
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

async function createListPickerContent({ friendlyName, body, button, items }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error('Missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN');

  const payload = {
    friendly_name: friendlyName || `active_job_picker_${Date.now()}`,
    language: 'en',
    types: {
      'twilio/list-picker': {
        body: String(body || '').slice(0, 1024),
        button: String(button || 'Select').slice(0, 20),
        items: (items || []).slice(0, 10).map((it) => ({
          item: String(it.item || '').slice(0, 24),
          id: String(it.id || '').slice(0, 200),
          description: String(it.description || '').slice(0, 72)
        }))
      }
    }
  };

  const res = await fetch(CONTENT_API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
    },
    body: JSON.stringify(payload)
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Content API create failed (${res.status}): ${txt?.slice(0, 300)}`);

  const json = JSON.parse(txt);
  if (!json?.sid) throw new Error('Content API create returned no sid');
  return json.sid;
}

async function sendWhatsAppListPicker({ to, body, button, items, cacheKey }) {
  const client = getTwilioClient();
  const { waFrom, messagingServiceSid } = getSendFromConfig();

  const toClean = String(to).startsWith('whatsapp:') ? String(to) : `whatsapp:${String(to)}`;

  const key = cacheKey || stableHash(JSON.stringify({ body, button, items }));
  let contentSid = _cacheGet(key);

  if (!contentSid) {
    contentSid = await createListPickerContent({
      friendlyName: `active_job_picker_${key}`,
      body,
      button,
      items
    });
    _cacheSet(key, contentSid);
  }

  const payload = { to: toClean, contentSid, contentVariables: JSON.stringify({}) };
  if (waFrom) payload.from = waFrom;
  else payload.messagingServiceSid = messagingServiceSid;

  const TIMEOUT_MS = 3000;
  return Promise.race([
    client.messages.create(payload),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Twilio send timeout')), TIMEOUT_MS))
  ]);
}

/* ---------------- Active job persistence (ALIGNED with postgres.js + revenue.js safety) ---------------- */
/**
 * Canonical: pg.setActiveJobForIdentity(ownerDigits, identityDigits, jobId(uuid|null), jobName|null)
 * Also supports: pg.setActiveJob(ownerDigits, identityDigits, jobRef) (jobRef = jobName or job_no)
 *
 * Rules:
 * - NEVER persist tokens as jobName (jobno_/jobix_/job_<n>_<hash>/#6)
 * - NEVER write non-UUID into job_id / active_job_id columns
 * - Prefer identity = DIGITS(fromPhone) so it aligns with pg.getActiveJobForIdentity(owner, fromPhone)
 */
async function persistActiveJobBestEffort({ ownerId, userProfile, fromPhone, jobRow, jobNameFallback }) {
  const owner = DIGITS(ownerId);
  const identity =
    DIGITS(fromPhone) ||
    DIGITS(userProfile?.phone_e164) ||
    DIGITS(userProfile?.phone) ||
    DIGITS(userProfile?.from) ||
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

  const rawId = jobRow?.id ?? jobRow?.job_id ?? null;
  const rawJobNo = jobRow?.job_no ?? jobRow?.jobNo ?? null;

  const rawNameRow = sanitizeJobLabel(jobRow?.name || jobRow?.job_name || jobRow?.jobName || '');
  const rawNameFallback = sanitizeJobLabel(jobNameFallback || '');

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

  // 3) Other aliases (best-effort)
  const fnCandidates = [
    'setActiveJobForUser',
    'setUserActiveJob',
    'updateUserActiveJob',
    'saveActiveJob',
    'setActiveJobForPhone'
  ];

  for (const fn of fnCandidates) {
    if (typeof pg[fn] !== 'function') continue;
    try {
      // Try (owner, identity, jobUuid, jobName)
      await pg[fn](owner, String(identity), jobUuid || null, jobName || null);
      return true;
    } catch {
      try {
        if (!jobRef) throw new Error('missing jobRef');
        // Try (owner, identity, jobRef)
        await pg[fn](owner, String(identity), String(jobRef));
        return true;
      } catch (e2) {
        console.warn('[JOB] pg.' + fn + ' failed:', e2?.message);
      }
    }
  }

  // 4) SQL fallback (UUID ONLY)
  const sqlAttempts = [
    {
      label: 'public.users',
      sql: `UPDATE public.users
              SET active_job_id = COALESCE($3::uuid, active_job_id),
                  active_job_name = COALESCE(NULLIF($4,''), active_job_name),
                  updated_at = NOW()
            WHERE owner_id = $1 AND user_id = $2`
    },
    {
      label: 'public.user_profiles',
      sql: `UPDATE public.user_profiles
              SET active_job_id = COALESCE($3::uuid, active_job_id),
                  active_job_name = COALESCE(NULLIF($4,''), active_job_name),
                  updated_at = NOW()
            WHERE owner_id = $1 AND user_id = $2`
    },
    {
      label: 'public.memberships',
      sql: `UPDATE public.memberships
              SET active_job_id = COALESCE($3::uuid, active_job_id),
                  active_job_name = COALESCE(NULLIF($4,''), active_job_name),
                  updated_at = NOW()
            WHERE owner_id = $1 AND user_id = $2`
    }
  ];

  if (jobUuid && typeof pg.query === 'function') {
    for (const a of sqlAttempts) {
      try {
        const r = await pg.query(a.sql, [owner, String(identity), jobUuid, jobName || '']);
        if (r?.rowCount) return true;
      } catch {}
    }
  }

  return false;
}

/* ---------------- DB helpers ---------------- */

async function listJobs(ownerId) {
  const { rows } = await pg.query(
    `SELECT
        id,
        job_no,
        COALESCE(name, job_name) AS job_name,
        status,
        created_at
       FROM public.jobs
      WHERE owner_id = $1
      ORDER BY created_at DESC
      LIMIT 10`,
    [String(ownerId)]
  );

  if (!rows.length) {
    return `You don't have any jobs yet.

Try:
- "create job Oak Street re-roof"
- "create job 12 Elm - siding"`;
  }

  const lines = rows.map((j, idx) => {
    const status = j.status || 'unknown';
    const date = j.created_at ? new Date(j.created_at).toLocaleDateString('en-CA') : 'n/a';
    const no = j.job_no != null ? `#${j.job_no} ` : '';
    return `${idx + 1}. ${no}${j.job_name} (${status}, created ${date})`;
  });

  return `Here are your recent jobs:\n\n${lines.join('\n')}`;
}

// Best-effort detailed active jobs list (aligned with revenue.js expectations)
async function listActiveJobsDetailed(ownerId, { limit = 50 } = {}) {
  if (typeof pg.listOpenJobsDetailed === 'function') {
    try {
      const rows = await pg.listOpenJobsDetailed(String(ownerId), limit);
      if (Array.isArray(rows)) {
        return rows.map((r) => ({
          id: r?.id != null ? String(r.id) : null,
          job_no: r?.job_no != null ? Number(r.job_no) : null,
          name: sanitizeJobLabel(r?.name || r?.job_name || r?.jobName || '')
        }));
      }
    } catch {}
  }

  // SQL fallback (most reliable when available)
  if (typeof pg.query === 'function') {
    try {
      const { rows } = await pg.query(
        `SELECT id, job_no, COALESCE(name, job_name) AS name
           FROM public.jobs
          WHERE owner_id = $1
            AND (status IS NULL OR status IN ('open','active','draft'))
          ORDER BY updated_at DESC NULLS LAST, created_at DESC
          LIMIT $2`,
        [String(ownerId), Number(limit)]
      );

      return (rows || []).map((r) => ({
        id: r?.id != null ? String(r.id) : null,
        job_no: r?.job_no != null ? Number(r.job_no) : null,
        name: sanitizeJobLabel(r?.name || '')
      }));
    } catch {}
  }

  // pg.listOpenJobs fallback (names only, no job_no)
  if (typeof pg.listOpenJobs === 'function') {
    try {
      const out = await pg.listOpenJobs(String(ownerId), { limit });
      return (Array.isArray(out) ? out : []).map((name, idx) => ({
        id: null,
        job_no: idx + 1, // last-resort pseudo-number; still stable per list ordering but not DB job_no
        name: sanitizeJobLabel(name)
      }));
    } catch {}
  }

  return [];
}

function normalizeJobOptions(jobRows) {
  const out = [];
  const seen = new Set();

  for (const r of jobRows || []) {
    const name = sanitizeJobLabel(r?.name || r?.job_name || r || '');
    if (!name || isGarbageJobName(name)) continue;

    const job_no = r?.job_no != null && Number.isFinite(Number(r.job_no)) ? Number(r.job_no) : null;
    if (job_no == null) continue;

    if (seen.has(job_no)) continue;
    seen.add(job_no);

    const rawId = r?.id != null ? String(r.id) : null;
    const safeUuidId = rawId && looksLikeUuid(rawId) ? rawId : null;

    out.push({ id: safeUuidId, job_no, name });
  }

  // deterministic
  out.sort((a, b) => Number(a.job_no) - Number(b.job_no));
  return out;
}

/* ---------------- picker rendering + state ---------------- */

function buildTextPicker(jobOptions, page, perPage) {
  const start = page * perPage;
  const slice = jobOptions.slice(start, start + perPage);

  const lines = slice.map((j, i) => {
    const n = j?.job_no != null ? Number(j.job_no) : null;
    const prefix = n != null ? `#${n} ` : '';
    return `${i + 1}) ${prefix}${j.name}`;
  });

  const hasMore = start + perPage < jobOptions.length;
  const more = hasMore ? `\nReply "more" for more jobs.` : '';

  return `Which job should I set active?\n\n${lines.join('\n')}\n\nReply with a number, "#jobno", job name, or "Overhead".${more}`;
}

async function clearPickerState(fromPhone) {
  await mergePendingTransactionState(fromPhone, {
    awaitingActiveJobPick: false,
    activeJobPickPage: null,
    activeJobPickHasMore: null,
    activeJobPickTotal: null,
    activeJobOptions: null,
    activeJobPickDisplayedJobNos: null
  });
}

function resolvePickerReply(raw, pending) {
  const s0 = String(raw || '').trim();
  const lc0 = s0.toLowerCase();
  if (!s0) return null;

  if (isMoreLike(lc0)) return { kind: 'more' };
  if (lc0 === 'overhead' || lc0 === 'oh') return { kind: 'overhead' };

  const token = normalizeJobAnswer(s0);

  const jobOptions = Array.isArray(pending?.activeJobOptions) ? pending.activeJobOptions : [];
  const page = Number(pending?.activeJobPickPage || 0) || 0;
  const pageSize = Number(pending?.activeJobPickPerPage || 8) || 8;
  const displayedJobNos = Array.isArray(pending?.activeJobPickDisplayedJobNos)
    ? pending.activeJobPickDisplayedJobNos
    : null;

  // jobno_<job_no>
  const mNo = String(token).match(/^jobno_(\d{1,10})$/i);
  if (mNo?.[1]) {
    const jobNo = Number(mNo[1]);
    const job = jobOptions.find((j) => Number(j?.job_no) === jobNo);
    return job ? { kind: 'job', job } : null;
  }

  // jobix_<n> (row index) — if we have displayedJobNos, resolve to job_no
  const mIx = String(token).match(/^jobix_(\d{1,10})$/i);
  if (mIx?.[1]) {
    const ix = Number(mIx[1]);
    if (displayedJobNos && displayedJobNos.length >= ix) {
      const jobNo = Number(displayedJobNos[ix - 1]);
      const job = jobOptions.find((j) => Number(j?.job_no) === jobNo);
      return job ? { kind: 'job', job } : null;
    }
    // fallback: treat as page-relative index
    const start = page * pageSize;
    const job = jobOptions[start + (ix - 1)];
    return job ? { kind: 'job', job } : null;
  }

  // numeric "1" = page-relative index
  if (/^\d{1,10}$/.test(String(s0).trim())) {
    const ix = Number(s0);
    if (displayedJobNos && displayedJobNos.length >= ix) {
      const jobNo = Number(displayedJobNos[ix - 1]);
      const job = jobOptions.find((j) => Number(j?.job_no) === jobNo);
      return job ? { kind: 'job', job } : null;
    }
    const start = page * pageSize;
    const job = jobOptions[start + (ix - 1)];
    return job ? { kind: 'job', job } : null;
  }

  // exact name match (case-insensitive)
  const name = sanitizeJobLabel(s0);
  const job =
    jobOptions.find((j) => String(j?.name || '').trim().toLowerCase() === name.toLowerCase()) || null;
  return job ? { kind: 'job', job } : { kind: 'name', name };
}

async function sendActiveJobPickerOrFallback({ res, fromPhone, ownerId, jobOptions, page = 0, perPage = 8 }) {
  const to = waTo(fromPhone);
  const JOBS_PER_PAGE = Math.min(8, Math.max(1, Number(perPage || 8)));
  const p = Math.max(0, Number(page || 0));
  const start = p * JOBS_PER_PAGE;

  const clean = normalizeJobOptions(jobOptions || []);
  const slice = clean.slice(start, start + JOBS_PER_PAGE);
  const hasMore = start + JOBS_PER_PAGE < clean.length;

  const displayedJobNos = slice
    .map((j) => (j?.job_no != null ? Number(j.job_no) : null))
    .filter((n) => Number.isFinite(n));

  await mergePendingTransactionState(fromPhone, {
    awaitingActiveJobPick: true,
    activeJobPickPage: p,
    activeJobPickPerPage: JOBS_PER_PAGE,
    activeJobPickHasMore: hasMore,
    activeJobPickTotal: clean.length,
    activeJobOptions: clean,
    activeJobPickDisplayedJobNos: displayedJobNos
  });

  // If no picker
  if (!ENABLE_LIST_PICKER || !to) {
    return respond(res, buildTextPicker(clean, p, JOBS_PER_PAGE));
  }

  // Prefer interactive list helper (same flow as revenue/expense)
  if (sendWhatsAppInteractiveList) {
    const rows = slice.map((j, idx) => {
      const jobNo = Number(j.job_no);
      const full = sanitizeJobLabel(j.name);
      return {
        id: `jobno_${jobNo}`,
        title: `J${jobNo} ${full}`.slice(0, 24),
        description: full.slice(0, 72)
      };
    });

    rows.push({ id: 'overhead', title: 'Overhead', description: 'Not tied to a job' });
    if (hasMore) rows.push({ id: 'more', title: 'More jobs…', description: 'Show next page' });

    const bodyText =
      `Pick your active job (${start + 1}-${Math.min(start + JOBS_PER_PAGE, clean.length)} of ${clean.length}).` +
      `\n\nTip: You can also reply with a number (like "1").`;

    try {
      await sendWhatsAppInteractiveList({
        to,
        bodyText,
        buttonText: 'Pick job',
        sections: [{ title: 'Active Jobs', rows }]
      });

      if (res && typeof res.send === 'function' && !res.headersSent) {
        res.type('text/xml').send(twimlEmpty());
      }
      return twimlEmpty();
    } catch (e) {
      console.warn('[JOB] sendWhatsAppInteractiveList failed; falling back:', e?.message);
      return respond(res, buildTextPicker(clean, p, JOBS_PER_PAGE));
    }
  }

  // Content API list-picker fallback (kept)
  const items = [];
  for (let i = 0; i < slice.length && items.length < 10; i++) {
    const jobNo = Number(slice[i].job_no);
    const full = slice[i].name;
    items.push({
      item: `J${jobNo} ${String(full).slice(0, 18)}`.slice(0, 24),
      id: `jobno_${jobNo}`, // ✅ stable, aligned to revenue/expense
      description: String(full).slice(0, 72)
    });
  }
  if (items.length < 10) items.push({ item: 'Overhead', id: 'overhead', description: 'Not tied to a job' });
  if (hasMore && items.length < 10) items.push({ item: 'More jobs…', id: 'more', description: 'Show the next page' });

  const body = `Pick your active job (${start + 1}-${Math.min(start + JOBS_PER_PAGE, clean.length)} of ${clean.length}).`;
  const button = 'Pick job';

  try {
    await sendWhatsAppListPicker({
      to,
      body,
      button,
      items,
      cacheKey: `active_jobs:${ownerId}:${p}:${stableHash(JSON.stringify(items))}`
    });

    if (res && typeof res.send === 'function' && !res.headersSent) {
      res.type('text/xml').send(twimlEmpty());
    }
    return twimlEmpty();
  } catch (e) {
    console.warn('[JOB] list-picker send failed; falling back to text:', e?.message);
    return respond(res, buildTextPicker(clean, p, JOBS_PER_PAGE));
  }
}

/* ---------------- job activation helpers ---------------- */

async function activateJobBestEffort(owner, selector) {
  const s = sanitizeJobLabel(selector);
  if (!s) throw new Error('missing selector');

  // jobno_#
  const mNo = s.match(/^jobno_(\d{1,10})$/i);
  if (mNo?.[1]) {
    const jobNo = Number(mNo[1]);
    if (Number.isFinite(jobNo)) {
      // Try dedicated helpers if present
      const fns = ['activateJobByNo', 'activateJobByJobNo', 'activateJobByNumber'];
      for (const fn of fns) {
        if (typeof pg[fn] === 'function') {
          try {
            return await pg[fn](owner, jobNo);
          } catch {}
        }
      }
      // SQL fallback
      if (typeof pg.query === 'function') {
        const r = await pg.query(
          `UPDATE public.jobs
              SET status = COALESCE(status, 'active'),
                  updated_at = NOW()
            WHERE owner_id = $1 AND job_no = $2
        RETURNING id, job_no, COALESCE(name, job_name) AS name`,
          [String(owner), Number(jobNo)]
        );
        if (r?.rows?.[0]) return r.rows[0];
      }
    }
  }

  // by name (existing behavior)
  if (typeof pg.activateJobByName === 'function') {
    return await pg.activateJobByName(owner, s);
  }

  // other aliases
  const fnCandidates = ['activateJob', 'setJobActive', 'setActiveJobByName'];
  for (const fn of fnCandidates) {
    if (typeof pg[fn] !== 'function') continue;
    try {
      return await pg[fn](owner, s);
    } catch {}
  }

  // last resort SQL name match
  if (typeof pg.query === 'function') {
    const r = await pg.query(
      `UPDATE public.jobs
          SET status = COALESCE(status, 'active'),
              updated_at = NOW()
        WHERE owner_id = $1
          AND LOWER(COALESCE(name, job_name)) = LOWER($2)
    RETURNING id, job_no, COALESCE(name, job_name) AS name`,
      [String(owner), s]
    );
    if (r?.rows?.[0]) return r.rows[0];
  }

  throw new Error('activate failed');
}

/* ---------------- main handler ---------------- */

async function handleJob(fromPhone, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId) {
  const owner = ownerDigits(ownerId, fromPhone);
  if (!owner) return respond(res, `I couldn't figure out which account this belongs to yet.`);

  const msg = String(text || '').trim();
  const lc = msg.toLowerCase();

  const pending = await getPendingTransactionState(fromPhone);

  // --- Awaiting picker selection ---
  if (pending?.awaitingActiveJobPick) {
    if (isCancelLike(lc)) {
      await clearPickerState(fromPhone);
      return respond(res, `❌ Cancelled. (No active job changed.)`);
    }

    if (isPickerOpenCommand(lc)) {
      const jobs = normalizeJobOptions(await listActiveJobsDetailed(owner, { limit: 50 }));
      return await sendActiveJobPickerOrFallback({ res, fromPhone, ownerId: owner, jobOptions: jobs, page: 0, perPage: 8 });
    }

    const resolved = resolvePickerReply(msg, pending);

    if (!resolved) {
      return respond(res, `⚠️ I didn’t catch that. Reply with a number, "#jobno", job name, "Overhead", or "more".`);
    }

    if (resolved.kind === 'more') {
      const all = normalizeJobOptions(await listActiveJobsDetailed(owner, { limit: 50 }));
      const nextPage = Number(pending.activeJobPickPage || 0) + 1;
      const hasMore = !!pending.activeJobPickHasMore;
      if (!hasMore) return respond(res, `No more jobs to show. Reply with a number, job name, or "Overhead".`);
      return await sendActiveJobPickerOrFallback({
        res,
        fromPhone,
        ownerId: owner,
        jobOptions: all,
        page: nextPage,
        perPage: 8
      });
    }

    await clearPickerState(fromPhone);

    if (resolved.kind === 'overhead') {
      // keep backward behavior (no DB change)
      return respond(res, `✅ Okay — using Overhead (no active job).`);
    }

    // If we got a job object from picker, use it; otherwise try name.
    const pickedJob = resolved.kind === 'job' ? resolved.job : null;
    const pickedName = pickedJob?.name || (resolved.kind === 'name' ? resolved.name : null);
    const pickedJobNo = pickedJob?.job_no != null ? Number(pickedJob.job_no) : null;

    try {
      // Activate job
      const selector = pickedJobNo != null ? `jobno_${pickedJobNo}` : pickedName;
      const j = await activateJobBestEffort(owner, selector);

      await persistActiveJobBestEffort({
        ownerId: owner,
        userProfile,
        fromPhone,
        jobRow: j,
        jobNameFallback: pickedName || j?.name
      });

      const finalName = sanitizeJobLabel(j?.name || j?.job_name || pickedName || 'Untitled Job');
      const jobNo = j?.job_no ?? pickedJobNo ?? '?';

      return respond(
        res,
        `✅ Active job set to: "${finalName}" (Job #${jobNo}).

Now you can:
- "clock in"
- "expense 84.12 nails"
- "received $2500 deposit"
- "task - order shingles due tomorrow"`
      );
    } catch (e) {
      console.warn('[JOB] activate/persist failed:', e?.message);
      return respond(res, `⚠️ I couldn't set that active job. Try: "active job ${pickedName || 'Oak Street'}"`);
    }
  }

  // --- Open picker ---
  if (isPickerOpenCommand(lc)) {
    const jobs = normalizeJobOptions(await listActiveJobsDetailed(owner, { limit: 50 }));
    return await sendActiveJobPickerOrFallback({ res, fromPhone, ownerId: owner, jobOptions: jobs, page: 0, perPage: 8 });
  }

  // --- Direct set active job ---
  if (/^(active\s+job|set\s+active|switch\s+job)\b/i.test(msg)) {
    const rest = msg.replace(/^(active\s+job|set\s+active|switch\s+job)\b/i, '').trim();
    if (!rest) return respond(res, `Which job should I set active? Try: "active job Oak Street"`);

    try {
      const selector = normalizeJobAnswer(rest);
      const j = await activateJobBestEffort(owner, selector);

      await persistActiveJobBestEffort({
        ownerId: owner,
        userProfile,
        fromPhone,
        jobRow: j,
        jobNameFallback: rest
      });

      const jobName = sanitizeJobLabel(j?.name || j?.job_name || rest);
      const jobNo = j?.job_no ?? '?';

      return respond(
        res,
        `✅ Active job set to: "${jobName}" (Job #${jobNo}).

Now you can:
- "clock in"
- "expense 84.12 nails"
- "received $2500 deposit"
- "task - order shingles due tomorrow"`
      );
    } catch (e) {
      console.warn('[JOB] direct activate failed:', e?.message);
      return respond(res, `⚠️ I couldn't set that active job. Try "change job" to pick from a list.`);
    }
  }

  // --- List jobs ---
  if (/^(jobs|list jobs|show jobs|show job list|job list)\b/i.test(msg)) {
    const reply = await listJobs(owner);
    return respond(res, reply);
  }

  // --- Create job (idempotent) ---
  if (/^(create|new|start)\s+job\b/i.test(msg)) {
    const name = msg.replace(/^(create|new|start)\s+job\b/i, '').trim();

    if (!name) {
      return respond(res, `What should the job be called? Example: "create job Oak Street re-roof"`);
    }

    if (typeof pg.createJobIdempotent !== 'function') {
      return respond(res, `⚠️ createJobIdempotent() isn't available in postgres.js yet.`);
    }

    const out = await pg.createJobIdempotent({
      ownerId: owner,
      name,
      sourceMsgId
    });

    if (!out?.job) return respond(res, `⚠️ I couldn't create that job right now. Try again.`);

    const jobName = sanitizeJobLabel(out.job.job_name || out.job.name || name || 'Untitled Job');
    const jobNo = out.job.job_no ?? '?';

    if (out.inserted) {
      return respond(
        res,
        `✅ Created job: "${jobName}" (Job #${jobNo}).

Next:
- Switch: "change job"
- Time: "clock in @ ${jobName}"
- Expense: "expense 84.12 nails from Home Depot today"
- Revenue: "received $2500 deposit today"`
      );
    }

    if (out.reason === 'already_exists') {
      return respond(res, `✅ That job already exists: "${jobName}" (Job #${jobNo}).`);
    }

    return respond(res, `✅ Already handled that message: "${jobName}" (Job #${jobNo}).`);
  }

  return respond(
    res,
    `Job commands you can use:

- "create job Oak Street re-roof"
- "change job" (shows active jobs picker)
- "active job Oak Street re-roof" (or "active job #6")
- "list jobs"`
  );
}

module.exports = { handleJob };
