// domain/lead.js
const { v4: uuidv4 } = require('uuid');
const { ensureNotDuplicate, recordAudit } = require('../services/audit');
const { insertOneReturning } = require('../services/db');
const { resolveJobRef, createDraftJob } = require('../services/jobs');

/**
 * ctx: { owner_id, source_msg_id, actor_phone }
 * cil: validated CreateLead CIL object
 */
async function createLead(cil, ctx) {
  const owner_id = ctx.owner_id;
  const idempotencyKey = cil.idempotency_key || ctx.source_msg_id;

  await ensureNotDuplicate(owner_id, idempotencyKey);

  // Decide: do we attach this lead to an existing Job or create a new "lead job"?
  let job;
  if (cil.job_ref) {
    job = await resolveJobRef(owner_id, cil.job_ref, { allowCreate: true });
  } else {
    // For lead creation, it’s very natural to create a "lead job" automatically
    const jobName = `${cil.customer.name} - Lead`;
    job = await createDraftJob(owner_id, jobName);
  }

  const leadId = uuidv4();
  const lead = await insertOneReturning(
    `INSERT INTO leads (
        id, owner_id, job_id,
        customer_name, customer_phone, customer_email, customer_address,
        notes, source_channel
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
    [
      leadId,
      owner_id,
      job.id,
      cil.customer.name,
      cil.customer.phone,
      cil.customer.email,
      cil.customer.address,
      cil.notes || null,
      'whatsapp',
    ]
  );

  await recordAudit({
    owner_id,
    key: idempotencyKey,
    action: 'create_lead',
    details: { lead_id: leadId, job_id: job.id },
  });

  return {
    ok: true,
    lead_id: leadId,
    job_id: job.id,
    summary: `New lead created for ${cil.customer.name} and attached to job "${job.name}".`,
  };
}

module.exports = { createLead };
