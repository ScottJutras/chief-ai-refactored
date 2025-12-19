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
        COALESCE(name, job_name) AS job_name,
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

  // Active job (switch context)
  if (/^(active\s+job|set\s+active|switch\s+job)\b/i.test(msg)) {
    const name = msg.replace(/^(active\s+job|set\s+active|switch\s+job)\b/i, '').trim();
    if (!name) return respond(res, `Which job should I set active? Try: "active job Oak Street"`);

    const j = await pg.activateJobByName(owner, name);
    const jobName = j?.name || name;
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
      sourceMsgId,
    });

    if (!out?.job) {
      return respond(res, `⚠️ I couldn't create that job right now. Try again.`);
    }

    const jobName = out.job.job_name || name || 'Untitled Job';
    const jobNo = out.job.job_no ?? '?';

    if (out.inserted) {
      return respond(
        res,
        `✅ Created job: "${jobName}" (Job #${jobNo}).

Next:
- Set active: "active job ${jobName}"
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

    // duplicate Twilio message / retry
    return respond(
      res,
      `✅ Already handled that message: "${jobName}" (Job #${jobNo}).`
    );
  }

  const help = `Job commands you can use:

- "create job Oak Street re-roof"
- "active job Oak Street re-roof"
- "list jobs"`;

  return respond(res, help);
}

module.exports = { handleJob };
