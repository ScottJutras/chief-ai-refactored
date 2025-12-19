// handlers/commands/job.js
// WhatsApp / SMS "job" command handler
// Signature:
//   handleJob(fromPhone, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId)

const pg = require('../../services/postgres');

function normaliseOwnerId(ownerId, fromPhone) {
  const base = ownerId || fromPhone;
  if (!base) return null;
  return String(base).replace(/\D/g, '');
}

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function respond(res, message) {
  const twiml = `<Response><Message>${escapeXml(message)}</Message></Response>`;
  if (res && typeof res.send === 'function' && !res.headersSent) {
    res.type('text/xml').send(twiml);
  }
  return twiml;
}

async function listJobs(ownerId) {
  const owner = pg.DIGITS(ownerId);

  const { rows } = await pg.query(
    `SELECT
        id,
        job_no,
        COALESCE(job_name, name) AS job_name,
        status,
        created_at
       FROM public.jobs
      WHERE owner_id = $1
      ORDER BY created_at DESC
      LIMIT 10`,
    [owner]
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
    const no = (j.job_no != null) ? `#${j.job_no} ` : '';
    return `${idx + 1}. ${no}${j.job_name} (${status}, created ${date})`;
  });

  return `Here are your recent jobs:\n\n${lines.join('\n')}`;
}

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
      jobName: name,
      sourceMsgId,
      status: 'open',
      active: true,
    });

    const job = out?.job;
    if (!job) return respond(res, `⚠️ I couldn't create that job right now. Try again.`);

    const jobName = job.job_name || job.name || name || 'Untitled Job';
    const jobNo = (job.job_no != null) ? job.job_no : '?';

    const reply = out.inserted
      ? `✅ Created job: "${jobName}" (Job #${jobNo}).\n\nNext:\n- Set active: "active job ${jobName}"\n- Log time: "clock in @ ${jobName}"\n- Log expense: "expense 84.12 nails from Home Depot"`
      : `✅ Already created that job (duplicate message): "${jobName}" (Job #${jobNo}).`;

    return respond(res, reply);
  }

  const help = `Job commands you can use:

- "create job Oak Street re-roof"
- "new job 12 Elm siding"
- "list jobs"`;

  return respond(res, help);
}

module.exports = { handleJob };
