// domain/quote.js
const { v4: uuidv4 } = require('uuid');
const { ensureNotDuplicate, recordAudit } = require('../services/audit');
const { insertOneReturning } = require('../services/db');
const { resolveJobRef } = require('../services/jobs');

async function createQuote(cil, ctx) {
  const owner_id = ctx.owner_id;
  const idempotencyKey = cil.idempotency_key || ctx.source_msg_id;

  await ensureNotDuplicate(owner_id, idempotencyKey);

  const job = await resolveJobRef(owner_id, cil.job_ref, { allowCreate: false });

  const totalCents =
    cil.total_cents ??
    (cil.line_items || []).reduce(
      (sum, li) => sum + li.qty * li.unit_price_cents,
      0
    );

  const quoteId = uuidv4();
  const quote = await insertOneReturning(
    `INSERT INTO quotes (
        id, owner_id, job_id,
        line_items, description, total_cents, status
      )
      VALUES ($1,$2,$3,$4,$5,$6,'draft')
      RETURNING *`,
    [
      quoteId,
      owner_id,
      job.id,
      JSON.stringify(cil.line_items || []),
      cil.description || null,
      totalCents,
    ]
  );

  await recordAudit({
    owner_id,
    key: idempotencyKey,
    action: 'create_quote',
    details: { quote_id: quoteId, job_id: job.id },
  });

  return {
    ok: true,
    quote_id: quoteId,
    job_id: job.id,
    summary: `Quote drafted for job "${job.name}" (total ${(totalCents / 100).toFixed(2)}).`,
  };
}

module.exports = { createQuote };
