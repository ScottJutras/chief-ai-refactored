// handlers/commands/job.js
// WhatsApp / SMS "job" command handler
// Signature:
//   handleJob(fromPhone, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId)

const pg = require('../../services/postgres');
const state = require('../../utils/stateManager');

const getPendingTransactionState = state.getPendingTransactionState;
const deletePendingTransactionState = state.deletePendingTransactionState;

const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

/* ---------------- helpers ---------------- */

function normaliseOwnerId(ownerId, fromPhone) {
  // NOTE: ownerId is likely a UUID (preferred). Do NOT DIGITS() it here.
  // Just stringify and trust upstream mapping (webhook maps phone->uuid).
  const base = ownerId || fromPhone;
  if (!base) return null;
  return String(base).trim();
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
  // expects "+1555..." OR "1555..." OR "whatsapp:+1555..."
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

function dedupeJobs(list) {
  const out = [];
  const seen = new Set();
  for (const j of list || []) {
    const s = String(j || '').trim();
    if (!s) continue;
    const key = s.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/* ---------------- Twilio list-picker content helpers ---------------- */

const ENABLE_LIST_PICKER =
  String(process.env.TWILIO_ENABLE_LIST_PICKER || '').trim().toLowerCase() === 'true';

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
- "create job 12 Elm - siding"
and then log time/expenses to those jobs.`;
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
  return `Which job should I set active?\n\n${lines.join('\n')}\n\nReply with a number, job name, or "Overhead".${more}`;
}

function buildPickerMap(jobs, page, perPage) {
  const start = page * perPage;
  const slice = jobs.slice(start, start + perPage);
  const map = {};

  for (let i = 0; i < slice.length; i++) {
    const idx = start + i + 1; // absolute number
    map[String(idx)] = slice[i];
  }

  for (const j of slice) {
    map[String(j).toLowerCase()] = j;
  }

  return map;
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

  // If list picker is disabled or we can't build a WhatsApp "to", fallback to text
  if (!ENABLE_LIST_PICKER || !to) {
    return respond(res, buildTextPicker(uniq, page, perPage));
  }

  // Build list-picker items (max 10)
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

  // Overhead
  if (items.length < 10) {
    items.push({ item: 'Overhead', id: 'overhead', description: 'Not tied to a job' });
  }

  // More
  if (hasMore && items.length < 10) {
    items.push({ item: 'More jobs…', id: 'more', description: 'Show the next page' });
  }

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

    // IMPORTANT: return empty TwiML to avoid double-sending
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
  if (lc === 'more' || lc === 'more jobs' || lc === 'more jobs…') return '__MORE__';
  if (lc === 'overhead' || lc === 'oh') return 'Overhead';

  // list-picker ids: job_<N>_<hash>
  const m = s.match(/^job_(\d+)_/i);
  if (m?.[1]) return pending?.activeJobPickMap?.[String(m[1])] || null;

  // number
  if (/^\d+$/.test(s)) return pending?.activeJobPickMap?.[s] || null;

  // job name (case-insensitive)
  if (pending?.activeJobPickMap?.[lc]) return pending.activeJobPickMap[lc];

  // free text job name
  return s;
}

/* ---------------- main handler ---------------- */

async function handleJob(fromPhone, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId) {
  const owner = normaliseOwnerId(ownerId, fromPhone);
  if (!owner) {
    return respond(
      res,
      `I couldn't figure out which account this belongs to yet.

Try starting from WhatsApp with "Hi Chief" so I can link your number.`
    );
  }

  const msg = String(text || '').trim();
  const lc = msg.toLowerCase();

  // ✅ If we're awaiting a pick, handle the reply first
  const pending = await getPendingTransactionState(fromPhone);
  if (pending?.awaitingActiveJobPick) {
    const resolved = resolvePickerReply(msg, pending);

    if (resolved === '__MORE__') {
      const all = dedupeJobs(await listActiveJobNames(owner, { limit: 50 }));
      const nextPage = Number(pending.activeJobPickPage || 0) + 1;
      return await sendActiveJobPickerOrFallback({ res, fromPhone, ownerId: owner, jobs: all, page: nextPage, perPage: 8 });
    }

    const jobName = resolved && String(resolved).trim() ? String(resolved).trim() : null;

    await mergePendingTransactionState(fromPhone, {
      awaitingActiveJobPick: false,
      activeJobPickPage: null,
      activeJobPickMap: null,
      activeJobPickHasMore: null,
      activeJobPickTotal: null
    });

    if (!jobName || jobName === 'Overhead') {
      return respond(res, `✅ Okay — no active job set (Overhead).`);
    }

    // activate
    try {
      const j = await pg.activateJobByName(owner, jobName);
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

  // ✅ Global job picker commands
  if (/^(show\s+active\s+jobs|active\s+jobs|list\s+active\s+jobs|pick\s+job|change\s+job)\b/i.test(msg)) {
    const jobs = dedupeJobs(await listActiveJobNames(owner, { limit: 50 }));
    return await sendActiveJobPickerOrFallback({ res, fromPhone, ownerId: owner, jobs, page: 0, perPage: 8 });
  }

  // Active job by name (direct)
  if (/^(active\s+job|set\s+active|switch\s+job)\b/i.test(msg)) {
    const name = msg.replace(/^(active\s+job|set\s+active|switch\s+job)\b/i, '').trim();
    if (!name) return respond(res, `Which job should I set active? Try: "active job Oak Street"`);

    const j = await pg.activateJobByName(owner, name);
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

  // List jobs
  if (/^(jobs|list jobs|show jobs)\b/i.test(msg)) {
    const reply = await listJobs(owner);
    return respond(res, reply);
  }

  // Create job
  if (/^(create|new)\s+job\b/i.test(msg)) {
    const name = msg.replace(/^(create|new)\s+job\b/i, '').trim();

    const out = await pg.createJobIdempotent({
      ownerId: owner,
      name,
      sourceMsgId
    });

    if (!out?.job) {
      return respond(res, `⚠️ I couldn't create that job right now. Try again.`);
    }

    const jobName = out.job.job_name || out.job.name || name || 'Untitled Job';
    const jobNo = out.job.job_no ?? '?';

    if (out.inserted) {
      return respond(
        res,
        `✅ Created job: "${jobName}" (Job #${jobNo}).

Next:
- Set active: "change job" (or "active job ${jobName}")
- Log time: "clock in @ ${jobName}"
- Log expense: "expense 84.12 nails from Home Depot"`
      );
    }

    if (out.reason === 'already_exists') {
      return respond(
        res,
        `✅ That job already exists: "${jobName}" (Job #${jobNo}).

Want to switch to it? Reply: "active job ${jobName}"`
      );
    }

    return respond(res, `✅ Already handled that message: "${jobName}" (Job #${jobNo}).`);
  }

  const help = `Job commands you can use:

- "create job Oak Street re-roof"
- "change job" (shows active jobs picker)
- "active job Oak Street re-roof"
- "list jobs"`;

  return respond(res, help);
}

module.exports = { handleJob };
