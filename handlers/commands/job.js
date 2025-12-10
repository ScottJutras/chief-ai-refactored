// handlers/commands/job.js
// WhatsApp / SMS "job" command handler
//
// Called from:
//  - routes/webhook.js (for live Twilio messages)
//  - services/tools/job.js (AI tools wrapper)
//
// Signature expected by services/tools/job.js:
//   handleJob(fromPhone, text, userProfile, ownerId, ownerProfile, isOwner, res)

const { resolveJobRef, createDraftJob } = require('../../services/jobs');
const { query } = require('../../services/postgres');

function normaliseOwnerId(ownerId, fromPhone) {
  // Your owner ids are numeric string IDs (phone-like)
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

/**
 * Build and optionally send a TwiML response.
 * - If res is provided (from Express webhook), send it.
 * - Always return { twiml } so other callers can use the string.
 */
function respond(res, message) {
  const twiml = `<Response><Message>${escapeXml(message)}</Message></Response>`;

  if (res && typeof res.send === 'function' && !res.headersSent) {
    res.type('text/xml').send(twiml);
  }

  return { twiml };
}

async function listJobs(ownerId) {
  const { rows } = await query(
    `SELECT id, name, status, created_at
       FROM jobs
      WHERE owner_id = $1
      ORDER BY created_at DESC
      LIMIT 10`,
    [ownerId]
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
    const date =
      j.created_at
        ? new Date(j.created_at).toLocaleDateString('en-CA')
        : 'n/a';
    return `${idx + 1}. ${j.name} (${status}, created ${date})`;
  });

  return `Here are your recent jobs:\n\n${lines.join('\n')}`;
}

async function createJob(ownerId, name) {
  const cleanName = name && name.trim().length ? name.trim() : 'Untitled Job';
  const job = await createDraftJob(ownerId, cleanName);

  return `✅ Created job: "${job.name}".

Next:
- Log time: "log 3 hours to ${job.name}"
- Log materials: "log $450 materials to ${job.name}"
Chief will tie these into your job KPIs and dashboard.`;
}

/**
 * Main handler: routes simple natural commands:
 * - "create job Oak St" / "new job Oak St"
 * - "jobs" / "list jobs"
 * - Fallback help text
 */
async function handleJob(fromPhone, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const owner = normaliseOwnerId(ownerId, fromPhone);
  if (!owner) {
    return respond(
      res,
      `I couldn't figure out which account this belongs to yet.

Try starting from WhatsApp with "Hi Chief" so I can link your number.`
    );
  }

  const msg = (text || '').trim();

  // --- List jobs ---
  if (/^(jobs|list jobs|show jobs)\b/i.test(msg)) {
    const reply = await listJobs(owner);
    return respond(res, reply);
  }

  // --- Create job ---
  if (/^(create|new)\s+job\b/i.test(msg)) {
    const name = msg.replace(/^(create|new)\s+job\b/i, '').trim();
    const reply = await createJob(owner, name);
    return respond(res, reply);
  }

  // You can add more patterns here later (set active job, rename, etc.)

  // --- Fallback help ---
  const help = `Job commands you can use:

- "create job Oak Street re-roof"
- "new job 12 Elm siding"
- "list jobs"

Chief will then let you log time, materials, and receipts to those jobs and show profit per job on the dashboard.`;

  return respond(res, help);
}

module.exports = handleJob;
