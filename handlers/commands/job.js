// handlers/commands/job.js
// COMPLETE DROP-IN (aligned to latest postgres.js + expense.js expectations)
//
// Key alignments:
// - ENABLE_LIST_PICKER default now matches expense.js behavior (true unless explicitly "false")
// - Uses pg.setActiveJobForIdentity / pg.setActiveJob aliases if present (canonical path)
// - Keeps best-effort legacy SQL fallback for active job persistence
// - Stores a robust picker map (numeric + name + id -> job name) so replying "1" or selecting works
// - Safe Twilio Content list-picker (Content API) with caching
//
// Signature:
//   handleJob(fromPhone, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId)

const pg = require('../../services/postgres');
const state = require('../../utils/stateManager');

// ✅ fetch polyfill so list-picker doesn't silently fall back if fetch isn't present
const fetch = global.fetch || require('node-fetch');

const getPendingTransactionState = state.getPendingTransactionState;
const deletePendingTransactionState =
  state.deletePendingTransactionState ||
  state.deletePendingState ||
  state.clearPendingTransactionState ||
  null;

const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

/* ---------------- helpers ---------------- */

function ownerDigits(ownerId, fromPhone) {
  const base = ownerId || fromPhone;
  const s = String(base || '').trim();
  if (!s) return null;
  return String(s).replace(/\D/g, '') || null;
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
  const digits = s.replace(/\D/g, '');
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

    const key = s.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function isPickerOpenCommand(lc) {
  return /^(show\s+active\s+jobs|active\s+jobs|list\s+active\s+jobs|pick\s+job|change\s+job)\b/.test(lc);
}

function isCancelLike(lc) {
  return /^(cancel|stop|no)\b/.test(lc);
}

function isMoreLike(lc) {
  return /^(more|more jobs|more jobs…)\b/.test(lc);
}

/* ---------------- Twilio list-picker content helpers ---------------- */

// Align with expense.js: enable unless explicitly false
const ENABLE_LIST_PICKER = (() => {
  const raw = process.env.TWILIO_ENABLE_LIST_PICKER ?? process.env.TWILIO_ENABLE_INTERACTIVE_LIST ?? 'true';
  return String(raw).trim().toLowerCase() !== 'false';
})();

const CONTENT_API_BASE = 'https://content.twilio.com/v1/Content';

// in-memory cache (best-effort)
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
  if (!waFrom && !messagingServiceSid) {
    throw new Error('Missing TWILIO_WHATSAPP_FROM or TWILIO_MESSAGING_SERVICE_SID');
  }
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

  const payload = {
    to: toClean,
    contentSid,
    contentVariables: JSON.stringify({})
  };

  if (waFrom) payload.from = waFrom;
  else payload.messagingServiceSid = messagingServiceSid;

  const TIMEOUT_MS = 3000;
  const msg = await Promise.race([
    client.messages.create(payload),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Twilio send timeout')), TIMEOUT_MS))
  ]);

  console.info('[JOB_LIST_PICKER] sent', {
    to: payload.to,
    from: payload.from || null,
    messagingServiceSid: payload.messagingServiceSid || null,
    contentSid: payload.contentSid,
    sid: msg?.sid || null,
    status: msg?.status || null
  });

  return msg;
}

/* ---------------- Active job persistence (ALIGNED with services/postgres.js) ---------------- */
/**
 * Canonical: pg.setActiveJobForIdentity(ownerId, identity, jobId, jobName)
 * Aliases: pg.setActiveJob / pg.setActiveJobForUser / pg.saveActiveJob / etc.
 *
 * We also keep SQL best-effort fallbacks to avoid "works in dev, breaks in prod" schema drift.
 */
async function persistActiveJobBestEffort({ ownerId, userProfile, fromPhone, jobRow, jobNameFallback }) {
  const owner = String(ownerId || '').replace(/\D/g, '');

  const identity =
    fromPhone ||
    userProfile?.from ||
    userProfile?.phone ||
    userProfile?.phone_e164 ||
    userProfile?.user_id ||
    userProfile?.id ||
    userProfile?.userId ||
    null;

  const userId =
    userProfile?.id ||
    userProfile?.user_id ||
    userProfile?.userId ||
    userProfile?.phone ||
    fromPhone ||
    null;

  if (!owner || !identity) {
    console.warn('[JOB] persistActiveJobBestEffort: missing owner/identity', { ownerId, identity, userId });
    return false;
  }

  const jobId = jobRow?.id || jobRow?.job_id || null;
  const jobNo = jobRow?.job_no ?? jobRow?.jobNo ?? null;
  const jobName =
    String(jobRow?.name || jobRow?.job_name || jobNameFallback || '').trim() || null;

  // prefer a stable ref if postgres.js supports it
  const jobRef = jobId || jobNo || jobName;

  // 1) Canonical identity-based setter
  if (typeof pg.setActiveJobForIdentity === 'function') {
    try {
      await pg.setActiveJobForIdentity(owner, String(identity), jobId || null, jobName || null);
      console.info('[JOB] persisted active job via pg.setActiveJobForIdentity', { owner, identity, jobId, jobName });
      return true;
    } catch (e) {
      console.warn('[JOB] pg.setActiveJobForIdentity failed:', e?.message);
    }
  }

  // 2) Canonical setActiveJob(ownerId, userId, jobRef/jobName)
  if (typeof pg.setActiveJob === 'function' && jobRef) {
    try {
      await pg.setActiveJob(owner, String(userId || identity), String(jobRef));
      console.info('[JOB] persisted active job via pg.setActiveJob', { owner, userId: String(userId || identity), jobRef });
      return true;
    } catch (e) {
      console.warn('[JOB] pg.setActiveJob failed:', e?.message);
    }
  }

  // 3) Legacy helper candidates
  const fnCandidates = ['setActiveJobForUser', 'setUserActiveJob', 'updateUserActiveJob', 'saveActiveJob', 'setActiveJobForPhone'];

  for (const fn of fnCandidates) {
    if (typeof pg[fn] !== 'function') continue;

    try {
      // common signature (owner, identity, jobId, jobName)
      await pg[fn](owner, String(userId || identity), jobId || null, jobName || null);
      console.info('[JOB] persisted active job via pg.' + fn, { owner, userId: String(userId || identity), jobId, jobName });
      return true;
    } catch (e1) {
      try {
        // alternate signature (owner, identity, jobRef)
        await pg[fn](owner, String(userId || identity), String(jobRef || ''));
        console.info('[JOB] persisted active job via pg.' + fn, { owner, userId: String(userId || identity), jobRef });
        return true;
      } catch (e2) {
        console.warn('[JOB] pg.' + fn + ' failed:', e2?.message || e1?.message);
      }
    }
  }

  // 4) Fall back to direct SQL attempts (fail-open across schema variants)
  const sqlAttempts = [
    {
      label: 'public.users (id)',
      sql: `UPDATE public.users
              SET active_job_id = COALESCE($3, active_job_id),
                  active_job_name = COALESCE(NULLIF($4,''), active_job_name),
                  updated_at = NOW()
            WHERE owner_id = $1 AND id = $2`
    },
    {
      label: 'public.users (user_id)',
      sql: `UPDATE public.users
              SET active_job_id = COALESCE($3, active_job_id),
                  active_job_name = COALESCE(NULLIF($4,''), active_job_name),
                  updated_at = NOW()
            WHERE owner_id = $1 AND user_id = $2`
    },
    {
      label: 'public.user_profiles',
      sql: `UPDATE public.user_profiles
              SET active_job_id = COALESCE($3, active_job_id),
                  active_job_name = COALESCE(NULLIF($4,''), active_job_name),
                  updated_at = NOW()
            WHERE owner_id = $1 AND user_id = $2`
    },
    {
      label: 'public.memberships',
      sql: `UPDATE public.memberships
              SET active_job_id = COALESCE($3, active_job_id),
                  active_job_name = COALESCE(NULLIF($4,''), active_job_name),
                  updated_at = NOW()
            WHERE owner_id = $1 AND user_id = $2`
    }
  ];

  const userKey = String(userId || identity);

  for (const a of sqlAttempts) {
    try {
      const r = await pg.query(a.sql, [owner, userKey, jobId, jobName]);
      if (r?.rowCount) {
        console.info('[JOB] persisted active job via SQL', { table: a.label, owner, userKey, jobId, jobName });
        return true;
      }
    } catch {}
  }

  console.warn('[JOB] persistActiveJobBestEffort: no persistence route succeeded');
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

async function listActiveJobNames(ownerId, { limit = 50 } = {}) {
  if (typeof pg.listOpenJobs === 'function') {
    const out = await pg.listOpenJobs(String(ownerId), { limit });
    return Array.isArray(out) ? out : [];
  }

  const { rows } = await pg.query(
    `SELECT COALESCE(name, job_name) AS job_name
       FROM public.jobs
      WHERE owner_id = $1
        AND (status IS NULL OR status IN ('open','active','draft'))
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT $2`,
    [String(ownerId), Number(limit)]
  );

  return rows.map((r) => r.job_name).filter(Boolean);
}

/* ---------------- picker rendering + state ---------------- */

function buildTextPicker(jobs, page, perPage) {
  const start = page * perPage;
  const slice = jobs.slice(start, start + perPage);
  const lines = slice.map((j, i) => `${start + i + 1}) ${j}`);
  const hasMore = start + perPage < jobs.length;
  const more = hasMore ? `\nReply "more" for more jobs.` : '';
  return `Which job should I set active?\n\n${lines.join(
    '\n'
  )}\n\nReply with a number, job name, or "Overhead".${more}`;
}

function buildPickerMap(jobs, page, perPage) {
  const start = page * perPage;
  const slice = jobs.slice(start, start + perPage);

  // We store a *rich* map so resolve can support:
  // - "1" (absolute)
  // - job_<N>_<hash> (list-picker id)
  // - exact name / lower name
  const map = {
    num: {},
    name: {},
    id: {}
  };

  for (let i = 0; i < slice.length; i++) {
    const absIdx = start + i + 1;
    const full = slice[i];
    const rowId = `job_${absIdx}_${stableHash(full)}`;

    map.num[String(absIdx)] = full;
    map.name[String(full).toLowerCase()] = full;
    map.name[String(full).slice(0, 24).toLowerCase()] = full;
    map.id[rowId] = full;
  }

  map.name.overhead = 'Overhead';
  map.num.overhead = 'Overhead';
  map.id.overhead = 'Overhead';

  map.name.more = '__MORE__';
  map.num.more = '__MORE__';
  map.id.more = '__MORE__';

  return map;
}

async function clearPickerState(fromPhone) {
  await mergePendingTransactionState(fromPhone, {
    awaitingActiveJobPick: false,
    activeJobPickPage: null,
    activeJobPickMap: null,
    activeJobPickHasMore: null,
    activeJobPickTotal: null
  });
}

async function sendActiveJobPickerOrFallback({ res, fromPhone, ownerId, jobs, page = 0, perPage = 8 }) {
  const to = waTo(fromPhone);
  const uniq = dedupeJobs(jobs);

  const start = page * perPage;
  const slice = uniq.slice(start, start + perPage);
  const hasMore = start + perPage < uniq.length;

  const pickerMap = buildPickerMap(uniq, page, perPage);

  await mergePendingTransactionState(fromPhone, {
    awaitingActiveJobPick: true,
    activeJobPickPage: page,
    activeJobPickMap: pickerMap,
    activeJobPickHasMore: hasMore,
    activeJobPickTotal: uniq.length
  });

  console.info('[JOB_PICKER] render', {
    enableListPicker: ENABLE_LIST_PICKER,
    hasTo: !!to,
    page,
    perPage,
    total: uniq.length
  });

  if (!ENABLE_LIST_PICKER || !to) {
    return respond(res, buildTextPicker(uniq, page, perPage));
  }

  const items = [];
  for (let i = 0; i < slice.length && items.length < 10; i++) {
    const absIdx = start + i + 1;
    const full = slice[i];
    items.push({
      item: `#${absIdx} ${String(full).slice(0, 20)}`.slice(0, 24),
      id: `job_${absIdx}_${stableHash(full)}`,
      description: String(full).slice(0, 72)
    });
  }

  if (items.length < 10) items.push({ item: 'Overhead', id: 'overhead', description: 'Not tied to a job' });
  if (hasMore && items.length < 10) items.push({ item: 'More jobs…', id: 'more', description: 'Show the next page' });

  const body = `Pick your active job (${start + 1}-${Math.min(start + perPage, uniq.length)} of ${uniq.length}).`;
  const button = 'Pick job';

  try {
    await sendWhatsAppListPicker({
      to,
      body,
      button,
      items,
      cacheKey: `active_jobs:${ownerId}:${page}:${stableHash(JSON.stringify(items))}`
    });

    if (res && typeof res.send === 'function' && !res.headersSent) {
      res.type('text/xml').send(twimlEmpty());
    }
    return twimlEmpty();
  } catch (e) {
    console.warn('[JOB] list-picker send failed; falling back to text:', e?.message);
    return respond(res, buildTextPicker(uniq, page, perPage));
  }
}

function resolvePickerReply(raw, pending) {
  const s = String(raw || '').trim();
  const lc = s.toLowerCase();

  if (!s) return null;
  if (isMoreLike(lc)) return '__MORE__';
  if (lc === 'overhead' || lc === 'oh') return 'Overhead';

  const map = pending?.activeJobPickMap || null;

  // list-picker ids
  if (map?.id && map.id[s]) return map.id[s];

  // list-picker ids: job_<N>_<hash>
  const m = s.match(/^job_(\d+)_/i);
  if (m?.[1] && map?.num?.[String(m[1])]) return map.num[String(m[1])];

  // numeric
  if (/^\d+$/.test(s) && map?.num?.[s]) return map.num[s];

  // name matches
  if (map?.name?.[lc]) return map.name[lc];

  return s;
}

/* ---------------- main handler ---------------- */

async function handleJob(fromPhone, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId) {
  const owner = ownerDigits(ownerId, fromPhone);
  if (!owner) {
    return respond(res, `I couldn't figure out which account this belongs to yet.`);
  }

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
      const jobs = dedupeJobs(await listActiveJobNames(owner, { limit: 50 }));
      return await sendActiveJobPickerOrFallback({ res, fromPhone, ownerId: owner, jobs, page: 0, perPage: 8 });
    }

    const resolved = resolvePickerReply(msg, pending);

    if (resolved === '__MORE__') {
      const all = dedupeJobs(await listActiveJobNames(owner, { limit: 50 }));
      const nextPage = Number(pending.activeJobPickPage || 0) + 1;
      return await sendActiveJobPickerOrFallback({
        res,
        fromPhone,
        ownerId: owner,
        jobs: all,
        page: nextPage,
        perPage: 8
      });
    }

    const jobName = resolved && String(resolved).trim() ? String(resolved).trim() : null;

    if (!jobName) {
      return respond(res, `⚠️ I didn’t catch that. Reply with a number, job name, "Overhead", or "more".`);
    }

    if (isPickerOpenCommand(jobName.toLowerCase()) || isCancelLike(jobName.toLowerCase())) {
      return respond(res, `⚠️ Reply with a number or a job name from the list (or "cancel").`);
    }

    await clearPickerState(fromPhone);

    if (jobName === 'Overhead') {
      // optional: you could also clear active job in DB, but leaving as-is keeps backward behavior
      return respond(res, `✅ Okay — using Overhead (no active job).`);
    }

    try {
      const j = await pg.activateJobByName(owner, jobName);

      await persistActiveJobBestEffort({
        ownerId: owner,
        userProfile,
        fromPhone,
        jobRow: j,
        jobNameFallback: jobName
      });

      const finalName = j?.name || j?.job_name || jobName;
      const jobNo = j?.job_no ?? '?';

      return respond(
        res,
        `✅ Active job set to: "${finalName}" (Job #${jobNo}).

Now you can:
- "clock in"
- "expense 84.12 nails"
- "task - order shingles due tomorrow"`
      );
    } catch (e) {
      console.warn('[JOB] activateJobByName failed:', e?.message);
      return respond(res, `⚠️ I couldn't set that active job. Try: "active job ${jobName}"`);
    }
  }

  // --- Open picker ---
  if (isPickerOpenCommand(lc)) {
    const jobs = dedupeJobs(await listActiveJobNames(owner, { limit: 50 }));
    return await sendActiveJobPickerOrFallback({ res, fromPhone, ownerId: owner, jobs, page: 0, perPage: 8 });
  }

  // --- Direct set active job ---
  if (/^(active\s+job|set\s+active|switch\s+job)\b/i.test(msg)) {
    const name = msg.replace(/^(active\s+job|set\s+active|switch\s+job)\b/i, '').trim();
    if (!name) return respond(res, `Which job should I set active? Try: "active job Oak Street"`);

    const j = await pg.activateJobByName(owner, name);

    await persistActiveJobBestEffort({
      ownerId: owner,
      userProfile,
      fromPhone,
      jobRow: j,
      jobNameFallback: name
    });

    const jobName = j?.name || j?.job_name || name;
    const jobNo = j?.job_no ?? '?';

    return respond(
      res,
      `✅ Active job set to: "${jobName}" (Job #${jobNo}).

Now you can:
- "clock in"
- "expense 84.12 nails"
- "task - order shingles due tomorrow"`
    );
  }

  // --- List jobs ---
  if (/^(jobs|list jobs|show jobs)\b/i.test(msg)) {
    const reply = await listJobs(owner);
    return respond(res, reply);
  }

  // --- Create job (idempotent) ---
  if (/^(create|new)\s+job\b/i.test(msg)) {
    const name = msg.replace(/^(create|new)\s+job\b/i, '').trim();

    const out = await pg.createJobIdempotent({
      ownerId: owner,
      name,
      sourceMsgId
    });

    if (!out?.job) return respond(res, `⚠️ I couldn't create that job right now. Try again.`);

    const jobName = out.job.job_name || out.job.name || name || 'Untitled Job';
    const jobNo = out.job.job_no ?? '?';

    if (out.inserted) {
      return respond(
        res,
        `✅ Created job: "${jobName}" (Job #${jobNo}).

Next:
- Switch: "change job"
- Time: "clock in @ ${jobName}"
- Expense: "expense 84.12 nails from Home Depot today"`
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
- "active job Oak Street re-roof"
- "list jobs"`
  );
}

module.exports = { handleJob };
