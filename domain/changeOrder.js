// domain/changeOrder.js
const { v4: uuidv4 } = require('uuid');
const { ensureNotDuplicate, recordAudit } = require('../services/audit');
const { getOne, insertOneReturning } = require('../services/db');
const { resolveJobRef } = require('../services/jobs');

function makeError(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

/**
 * cil: validated CreateChangeOrder CIL
 * ctx: { owner_id, source_msg_id, actor_phone }
 */
async function createChangeOrder(cil, ctx) {
  const owner_id = ctx.owner_id;
  const idempotencyKey = cil.idempotency_key || ctx.source_msg_id;

  await ensureNotDuplicate(owner_id, idempotencyKey);

  const job = await resolveJobRef(owner_id, cil.job_ref, { allowCreate: false });

  // Optional: ensure agreement exists if you require it before COs
  let agreement_id = null;
  if (cil.agreement_id) {
    const agreement = await getOne(
      'SELECT id, status FROM agreements WHERE owner_id = $1 AND id = $2',
      [owner_id, cil.agreement_id]
    );
    if (!agreement) throw makeError('Agreement not found', 'NOT_FOUND');
    if (agreement.status !== 'signed' && agreement.status !== 'draft') {
      // you can relax this if you like
      throw makeError('Agreement not in a valid state for change orders', 'CONFLICT');
    }
    agreement_id = agreement.id;
  }

  const lineItems = cil.line_items || [];
  const changeId = uuidv4();

  const change = await insertOneReturning(
    `INSERT INTO change_orders (
        id, owner_id, job_id, agreement_id,
        description, amount_cents, line_items,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'draft')
      RETURNING *`,
    [
      changeId,
      owner_id,
      job.id,
      agreement_id,
      cil.description,
      cil.amount_cents,
      JSON.stringify(lineItems),
    ]
  );

  await recordAudit({
    owner_id,
    key: idempotencyKey,
    action: 'create_change_order',
    details: { change_id: changeId, job_id: job.id },
  });

  return {
    ok: true,
    change_id: changeId,
    job_id: job.id,
    summary: `Change order drafted for job "${job.name}" for $${(
      cil.amount_cents / 100
    ).toFixed(2)}.`,
  };
}

module.exports = { createChangeOrder };
