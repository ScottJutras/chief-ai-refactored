// domain/transactions.js
const { query } = require('../services/postgres');

// Local helper: resolve a job by name or id (best-effort; returns {id,name} or null)
async function resolveJob(owner_id, jobRef) {
  if (!jobRef) return null;
  // Try by UUID id
  if (/^[0-9a-f-]{36}$/i.test(jobRef)) {
    const r = await query(
      `select id, coalesce(name, job_name) as name from public.jobs where owner_id=$1 and id=$2 limit 1`,
      [owner_id, jobRef]
    );
    return r.rows[0] || null;
  }
  // Try by job_no "#123" or plain number
  const m = String(jobRef).trim().match(/^#?(\d+)$/);
  if (m) {
    const r = await query(
      `select id, coalesce(name, job_name) as name from public.jobs where owner_id=$1 and job_no=$2 limit 1`,
      [owner_id, parseInt(m[1], 10)]
    );
    if (r.rows[0]) return r.rows[0];
  }
  // Finally by name
  const r = await query(
    `select id, coalesce(name, job_name) as name from public.jobs where owner_id=$1 and lower(coalesce(name,job_name))=lower($2) limit 1`,
    [owner_id, String(jobRef)]
  );
  return r.rows[0] || null;
}

function isoDateOrToday(d) {
  try { return d ? new Date(d).toISOString().slice(0,10) : new Date().toISOString().slice(0,10); }
  catch { return new Date().toISOString().slice(0,10); }
}

async function logExpense(cil, ctx) {
  const owner_id = ctx.owner_id;
  const job = cil.job ? await resolveJob(owner_id, cil.job) : null;

  await query(
    `insert into public.transactions
      (owner_id, job_id, kind, date, item, amount_cents, store, category, media_url, created_by, created_at)
     values
      ($1,$2,'expense',$3,$4,$5,$6,$7,$8,$9,now())`,
    [
      owner_id,
      job?.id || null,
      isoDateOrToday(cil.date),
      cil.item,
      cil.amount_cents,
      cil.store || null,
      cil.category || null,
      cil.media_url || null,
      ctx.actor_phone || null,
    ]
  );

  const dollars = (cil.amount_cents/100).toFixed(2);
  return { ok: true, summary: `✅ Expense logged: $${dollars} for ${cil.item}${job?.name ? ` on ${job.name}` : ''}.` };
}

async function logRevenue(cil, ctx) {
  const owner_id = ctx.owner_id;
  const job = cil.job ? await resolveJob(owner_id, cil.job) : null;

  await query(
    `insert into public.transactions
      (owner_id, job_id, kind, date, description, amount_cents, source, category, media_url, created_by, created_at)
     values
      ($1,$2,'revenue',$3,$4,$5,$6,$7,$8,$9,now())`,
    [
      owner_id,
      job?.id || null,
      isoDateOrToday(cil.date),
      cil.description,
      cil.amount_cents,
      cil.source || null,
      cil.category || null,
      cil.media_url || null,
      ctx.actor_phone || null,
    ]
  );

  const dollars = (cil.amount_cents/100).toFixed(2);
  return { ok: true, summary: `✅ Revenue logged: $${dollars} – ${cil.description}${job?.name ? ` on ${job.name}` : ''}.` };
}

module.exports = { logExpense, logRevenue };
