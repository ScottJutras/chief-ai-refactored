// handlers/commands/job.js
// WhatsApp / SMS "job" command handler
// Signature:
//   handleJob(fromPhone, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId)

const pg = require('../../services/postgres');
const state = require('../../utils/stateManager');

const getPendingTransactionState = state.getPendingTransactionState;
const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));
const deletePendingTransactionState = state.deletePendingTransactionState;

/* ---------------- TwiML helpers ---------------- */

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

/* ---------------- WhatsApp helpers ---------------- */

function isWhatsAppFrom(fromPhone) {
  return /^whatsapp:/i.test(String(fromPhone || '').trim());
}

function waTo(fromPhone) {
  // expects "whatsapp:+1555..." OR "+1555..." OR "1555..."
  const s = String(fromPhone || '').trim();
  if (s.startsWith('whatsapp:')) return s;
  const digits = s.replace(/\D/g, '');
  return digits ? `whatsapp:+${digits}` : null;
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

  console.info('[JOB] interactive list sent', {
    to: payload.to,
    from: payload.from || null,
    messagingServiceSid: payload.messagingServiceSid || null,
    sid: msg?.sid || null,
    status: msg?.status || null
  });

  return msg;
}

/* ---------------- tolerant owner id ---------------- */

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(str || '')
  );
}

function normaliseOwnerId(ownerId, fromPhone) {
  // Preferred: UUID ownerId (newer flow)
  if (ownerId && looksLikeUuid(ownerId)) return String(ownerId);

  // Otherwise keep whatever string we got (some installs use text IDs)
  if (ownerId && String(ownerId).trim()) return String(ownerId).trim();

  // Last resort: digits from phone (older installs)
  const digits = String(fromPhone || '').replace(/^whatsapp:/i, '').replace(/\D/g, '');
  return digits || null;
}

/* ---------------- job list picker logic ---------------- */

const ENABLE_INTERACTIVE_LIST = (() => {
  const raw = process.env.TWILIO_ENABLE_INTERACTIVE_LIST ?? 'true';
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

function dedupeJobs(list) {
  const out = [];
  const seen = new Set();
  for (const j of list || []) {
    const s = String(j || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
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
  return `Which job should I set active?\n\n${lines.join('\n')}\n\nReply with a number, job name, or "Overhead".${more}`;
}

function buildPickerMaps(jobs, page, pageSize) {
  const start = page * pageSize;
  const slice = jobs.slice(start, start + pageSize);

  const idMap = {};   // rowId -> jobName or special
  const nameMap = {}; // lower(title/desc) -> jobName or special
  const numMap = {};  // "12" -> jobName (absolute index)

  for (let i = 0; i < slice.length; i++) {
    const absIdx = start + i + 1;
    const full = slice[i];
    const rowId = `job_${absIdx}_${stableHash(full)}`;

    idMap[rowId] = full;
    numMap[String(absIdx)] = full;

    nameMap[String(full).toLowerCase()] = full;
    nameMap[String(full).slice(0, 24).toLowerCase()] = full;
  }

  idMap['overhead'] = 'Overhead';
  idMap['more'] = '__MORE__';

  nameMap['overhead'] = 'Overhead';
  nameMap['more jobs…'] = '__MORE__';
  nameMap['more jobs'] = '__MORE__';
  nameMap['more'] = '__MORE__';

  return { idMap, nameMap, numMap };
}

async function listActiveJobNames(ownerId, { limit = 50 } = {}) {
  // Use existing helper if available (your expense.js uses this)
  if (typeof pg.listOpenJobs === 'function') {
    const out = await pg.listOpenJobs(ownerId, { limit });
    return Array.isArray(out) ? out : [];
  }

  // Fallback query
  const { rows } = await pg.query(
    `select coalesce(name, job_name) as job_name
       from public.jobs
      where owner_id = $1
        and (status is null or status in ('open','active','draft'))
      order by updated_at desc nulls last, created_at desc
      limit $2`,
    [ownerId, Number(limit)]
  );

  return rows.map(r => r.job_name).filter(Boolean);
}

async function sendActiveJobsPickerOrFallback(fromPhone, ownerId, page = 0, pageSize = 8) {
  const to = waTo(fromPhone);
  const all = dedupeJobs(await listActiveJobNames(ownerId, { limit: 50 }));
  const JOBS_PER_PAGE = Math.min(pageSize, 8);

  const start = page * JOBS_PER_PAGE;
  const slice = all.slice(start, start + JOBS_PER_PAGE);
  const hasMore = start + JOBS_PER_PAGE < all.length;

  const { idMap, nameMap, numMap } = buildPickerMaps(all, page, JOBS_PER_PAGE);

  // Store in pending state so we can resolve list replies
  await mergePendingTransactionState(fromPhone, {
    awaitingActiveJobPick: true,
    activeJobPickPage: page,
    activeJobPickIdMap: idMap,
    activeJobPickNameMap: nameMap,
    activeJobPickNumMap: numMap,
    activeJobPickHasMore: hasMore,
    activeJobPickTotal: all.length
  });

  if (!isWhatsAppFrom(fromPhone) || !ENABLE_INTERACTIVE_LIST || !to) {
    const fallback = all.length
      ? buildTextJobPrompt(all, page, JOBS_PER_PAGE)
      : `You don’t have any active jobs yet.\n\nReply: "create job <name>" (or "list jobs").`;
    return twimlText(fallback);
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
    `Pick the job you want to set as Active (${start + 1}-${Math.min(start + JOBS_PER_PAGE, all.length)} of ${all.length}).`;

  try {
    await sendWhatsAppInteractiveList({
      to,
      bodyText,
      buttonText: 'Pick a job',
      sections: [{ title: 'Active Jobs', rows }]
    });
    return twimlEmpty();
  } catch (e) {
    console.warn('[JOB] interactive list failed; falling back to text:', e?.message);
    const fallback = all.length
      ? buildTextJobPrompt(all, page, JOBS_PER_PAGE)
      : `You don’t have any active jobs yet.\n\nReply: "create job <name>" (or "list jobs").`;
    return twimlText(fallback);
  }
}

/* ---------------- resolve job selection reply ---------------- */

function resolvePickedJob(input, pending) {
  const t = String(input || '').trim();
  if (!t) return null;

  const lc = t.toLowerCase();

  // typed paging
  if (lc === 'more' || lc === 'more jobs' || lc === 'more jobs…') return '__MORE__';
  if (lc === 'overhead' || lc === 'oh') return 'Overhead';

  // interactive list row id
  if (pending?.activeJobPickIdMap && pending.activeJobPickIdMap[t]) return pending.activeJobPickIdMap[t];

  // numeric (absolute)
  if (/^\d+$/.test(t) && pending?.activeJobPickNumMap?.[t]) return pending.activeJobPickNumMap[t];

  // interactive title
  if (pending?.activeJobPickNameMap) {
    const hit = pending.activeJobPickNameMap[lc];
    if (hit) return hit;
  }

  // fall back to treating as job name
  return t;
}

/* ---------------- main handler ---------------- */

async function handleJob(fromPhone, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId) {
  const owner = normaliseOwnerId(ownerId, fromPhone);
  if (!owner) {
    return respond(
      res,
      `I couldn't figure out which account this belongs to yet.\n\nTry starting from WhatsApp with "Hi Chief" so I can link your number.`
    );
  }

  const msg = String(text || '').trim();
  const lc = msg.toLowerCase();

  // 1) If we're awaiting a job pick, interpret the reply first
  const pending = await getPendingTransactionState(fromPhone);
  if (pending?.awaitingActiveJobPick) {
    const picked = resolvePickedJob(msg, pending);

    if (picked === '__MORE__') {
      const nextPage = Number(pending.activeJobPickPage || 0) + 1;
      const twiml = await sendActiveJobsPickerOrFallback(fromPhone, owner, nextPage, 8);
      if (res && !res.headersSent) return res.type('text/xml').send(twiml);
      return twiml;
    }

    // Clear picker state (keep other pending fields, if any)
    await mergePendingTransactionState(fromPhone, {
      awaitingActiveJobPick: false,
      activeJobPickPage: null,
      activeJobPickIdMap: null,
      activeJobPickNameMap: null,
      activeJobPickNumMap: null,
      activeJobPickHasMore: null,
      activeJobPickTotal: null
    });

    const name = picked || null;
    if (!name) return respond(res, `Which job should I set active? Try "change job".`);

    // Set active job (best effort)
    try {
      if (typeof pg.activateJobByName === 'function') {
        const j = await pg.activateJobByName(owner, name);
        const jobName = j?.name || j?.job_name || name;
        const jobNo = j?.job_no ?? '';
        return respond(
          res,
          `✅ Active job set to: "${jobName}"${jobNo ? ` (Job #${jobNo})` : ''}.\n\nNow you can:\n- "clock in"\n- "expense 84.12 nails"\n- "task - order shingles due tomorrow"`
        );
      }
    } catch (e) {
      console.warn('[JOB] activateJobByName failed:', e?.message);
    }

    // If activate helper not available
    return respond(res, `✅ Got it — I’ll treat "${name}" as your active job for now.\n\nNext: "clock in" or log an expense.`);
  }

  // 2) GLOBAL COMMANDS: change job / show active jobs
  if (/^(change\s+job|switch\s+job|pick\s+job|show\s+active\s+jobs|active\s+jobs|list\s+active\s+jobs)\b/i.test(msg)) {
    const twiml = await sendActiveJobsPickerOrFallback(fromPhone, owner, 0, 8);
    if (res && !res.headersSent) return res.type('text/xml').send(twiml);
    return twiml;
  }

  // 3) Active job set directly by name: "active job Roof Repair"
  if (/^(active\s+job|set\s+active)\b/i.test(msg)) {
    const name = msg.replace(/^(active\s+job|set\s+active)\b/i, '').trim();
    if (!name) {
      const twiml = await sendActiveJobsPickerOrFallback(fromPhone, owner, 0, 8);
      if (res && !res.headersSent) return res.type('text/xml').send(twiml);
      return twiml;
    }

    try {
      if (typeof pg.activateJobByName === 'function') {
        const j = await pg.activateJobByName(owner, name);
        const jobName = j?.name || j?.job_name || name;
        const jobNo = j?.job_no ?? '';
        return respond(
          res,
          `✅ Active job set to: "${jobName}"${jobNo ? ` (Job #${jobNo})` : ''}.\n\nNow you can:\n- "clock in"\n- "expense 84.12 nails"\n- "task - order shingles due tomorrow"`
        );
      }
    } catch (e) {
      console.warn('[JOB] activateJobByName failed:', e?.message);
    }

    return respond(res, `✅ Active job set to: "${name}".`);
  }

  // 4) List jobs (recent)
  if (/^(jobs|list jobs|show jobs)\b/i.test(msg)) {
    try {
      const { rows } = await pg.query(
        `SELECT id, job_no, COALESCE(name, job_name) AS job_name, status, created_at
           FROM public.jobs
          WHERE owner_id = $1
          ORDER BY created_at DESC
          LIMIT 10`,
        [owner]
      );

      if (!rows.length) {
        return respond(
          res,
          `You don't have any jobs yet.\n\nTry:\n- "create job Oak Street re-roof"\n- "create job 12 Elm - siding"`
        );
      }

      const lines = rows.map((j, idx) => {
        const status = j.status || 'unknown';
        const date = j.created_at ? new Date(j.created_at).toLocaleDateString('en-CA') : 'n/a';
        const no = j.job_no != null ? `#${j.job_no} ` : '';
        return `${idx + 1}. ${no}${j.job_name} (${status}, created ${date})`;
      });

      return respond(res, `Here are your recent jobs:\n\n${lines.join('\n')}\n\nTip: "change job" to set your active job.`);
    } catch (e) {
      console.warn('[JOB] list jobs failed:', e?.message);
      return respond(res, `⚠️ I couldn’t list jobs right now. Try again.`);
    }
  }

  // 5) Create job
  if (/^(create|new)\s+job\b/i.test(msg)) {
    const name = msg.replace(/^(create|new)\s+job\b/i, '').trim();

    try {
      if (typeof pg.createJobIdempotent === 'function') {
        const out = await pg.createJobIdempotent({
          ownerId: owner,
          name,
          sourceMsgId
        });

        if (!out?.job) return respond(res, `⚠️ I couldn't create that job right now. Try again.`);

        const jobName = out.job.job_name || out.job.name || name || 'Untitled Job';
        const jobNo = out.job.job_no ?? '';

        if (out.inserted) {
          return respond(
            res,
            `✅ Created job: "${jobName}"${jobNo ? ` (Job #${jobNo})` : ''}.\n\nNext:\n- Set active: "active job ${jobName}"\n- Log time: "clock in @ ${jobName}"\n- Log expense: "expense 84.12 nails from Home Depot"`
          );
        }

        if (out.reason === 'already_exists') {
          return respond(res, `✅ That job already exists: "${jobName}"${jobNo ? ` (Job #${jobNo})` : ''}.\n\nWant to switch to it? Reply: "active job ${jobName}"`);
        }

        return respond(res, `✅ Already handled that message: "${jobName}"${jobNo ? ` (Job #${jobNo})` : ''}.`);
      }

      // If helper missing, fall back to telling user
      return respond(res, `⚠️ Job creation isn’t wired on this build yet.`);
    } catch (e) {
      console.warn('[JOB] create job failed:', e?.message);
      return respond(res, `⚠️ I couldn't create that job right now. Try again.`);
    }
  }

  // Help
  return respond(
    res,
    `Job commands you can use:\n\n- "create job Oak Street re-roof"\n- "change job"\n- "active job Oak Street re-roof"\n- "list jobs"\n- "show active jobs"`
  );
}

module.exports = { handleJob };
