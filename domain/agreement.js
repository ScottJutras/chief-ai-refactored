// domain/agreement.js
const { v4: uuidv4 } = require('uuid');
const { ensureNotDuplicate, recordAudit } = require('../services/audit');
const { getOne, insertOneReturning } = require('../services/db');
const { resolveJobRef } = require('../services/jobs');

async function createAgreement(cil, ctx) {
  const owner_id = ctx.owner_id;
  const idempotencyKey = cil.idempotency_key || ctx.source_msg_id;

  await ensureNotDuplicate(owner_id, idempotencyKey);

  const job = await resolveJobRef(owner_id, cil.job_ref, { allowCreate: false });

  if (cil.quote_id) {
    const quote = await getOne(
      'SELECT id, status, total_cents FROM quotes WHERE owner_id = $1 AND id = $2',
      [owner_id, cil.quote_id]
    );
    if (!quote) {
      const err = new Error('Quote not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (quote.status !== 'accepted') {
      const err = new Error('Quote not accepted yet');
      err.code = 'CONFLICT';
      throw err;
    }
  }

  const agreementId = uuidv4();
  const agreement = await insertOneReturning(
    `INSERT INTO agreements (
        id, owner_id, job_id, quote_id,
        terms, contract_price_cents,
        deposit_cents, retainage_pct, retainage_release_days,
        payment_schedule,
        start_date, sig_required, status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft')
      RETURNING *`,
    [
      agreementId,
      owner_id,
      job.id,
      cil.quote_id || null,
      cil.terms || null,
      cil.contract_price_cents || null,
      cil.deposit_cents || 0,
      cil.retainage_pct ?? null,
      cil.retainage_release_days ?? null,
      JSON.stringify(cil.payment_schedule || []),
      cil.start_date || null,
      cil.sig_required ?? true,
    ]
  );

  await recordAudit({
    owner_id,
    key: idempotencyKey,
    action: 'create_agreement',
    details: { agreement_id: agreementId, job_id: job.id },
  });

  return {
    ok: true,
    agreement_id: agreementId,
    job_id: job.id,
    summary: `Agreement drafted for job "${job.name}".`,
  };
}

module.exports = { createAgreement };
