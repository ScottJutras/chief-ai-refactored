// domain/invoice.js
const { query } = require('../services/postgres');

// ---------- helpers ----------
const TAX = { HST_ON: 0.13, HST_NB: 0.15, GST_5: 0.05, PST_BC: 0.12 };
const taxRate = (code='HST_ON') => TAX[code] ?? 0.13;

async function getOne(sql, params) {
  const r = await query(sql, params);
  return r.rows[0] || null;
}

// Resolve a job by id / job_no / name (returns {id, name} or throws if required)
async function resolveJobRef(owner_id, ref, { required = true } = {}) {
  if (!ref) {
    if (required) throw new Error('Job is required');
    return null;
  }
  // UUID?
  if (/^[0-9a-f-]{36}$/i.test(String(ref.id || ref))) {
    const r = await getOne(
      `select id, coalesce(name,job_name) as name from public.jobs where owner_id=$1 and id=$2 limit 1`,
      [owner_id, ref.id || ref]
    );
    if (!r && required) throw new Error('Job not found');
    return r;
  }
  // job_no?
  const rawName = ref.name || ref;
  const m = String(rawName).match(/^#?(\d+)$/);
  if (m) {
    const r = await getOne(
      `select id, coalesce(name,job_name) as name from public.jobs where owner_id=$1 and job_no=$2 limit 1`,
      [owner_id, parseInt(m[1], 10)]
    );
    if (!r && required) throw new Error('Job not found');
    return r;
  }
  // by name
  const r = await getOne(
    `select id, coalesce(name,job_name) as name from public.jobs where owner_id=$1 and lower(coalesce(name,job_name))=lower($2) limit 1`,
    [owner_id, String(rawName)]
  );
  if (!r && required) throw new Error('Job not found');
  return r;
}

// ---------- create invoice from CIL line items ----------
async function createInvoice(cil, ctx) {
  const owner_id = ctx.owner_id;
  const job = await resolveJobRef(owner_id, cil.job_ref, { required: true });

  const lineItems = Array.isArray(cil.line_items) ? cil.line_items : [];
  const subtotal_cents = lineItems.reduce((s, li) => s + (li.qty * li.unit_price_cents), 0);
  const code = cil.tax_code || 'HST_ON';
  const tax_cents = Math.round(subtotal_cents * taxRate(code));
  const total_cents = subtotal_cents + tax_cents;

  const r = await query(
    `insert into invoices
      (owner_id, job_id, agreement_id, invoice_kind, status,
       subtotal_cents, tax_cents, total_cents, tax_code, due_date,
       line_items, meta, created_at)
     values
      ($1,$2,$3,$4,'draft',
       $5,$6,$7,$8,$9,
       $10,$11, now())
     returning id`,
    [
      owner_id,
      job.id,
      cil.agreement_id || null,
      cil.invoice_kind || 'standard',
      subtotal_cents, tax_cents, total_cents,
      code,
      cil.due_date || null,
      JSON.stringify(lineItems),
      JSON.stringify({ source_msg_id: ctx.source_msg_id || null }),
    ]
  );

  return {
    ok: true,
    invoice_id: r.rows[0].id,
    job_id: job.id,
    summary: `🧾 Draft invoice for "${job.name}" → $${(total_cents/100).toFixed(2)} (${code}).`,
  };
}

// ---------- draft next invoice from agreement.payment_schedule ----------
async function draftNextInvoiceForAgreement({ owner_id, agreement_id, tax_code = 'HST_ON', due_date = null }) {
  // 1) Load agreement
  const A = await getOne(
    `select id, contract_price_cents, deposit_cents, retainage_pct, payment_schedule, job_id
       from agreements
      where owner_id=$1 and id=$2 limit 1`,
    [owner_id, agreement_id]
  );
  if (!A) return { ok:false, summary:'Agreement not found.' };

  const schedule = Array.isArray(A.payment_schedule) ? A.payment_schedule : [];

  // 2) What’s already invoiced?
  const existing = await query(
    `select invoice_kind, (meta->>'milestone_label') as label
       from invoices
      where owner_id=$1 and agreement_id=$2 and status <> 'void'`,
    [owner_id, agreement_id]
  );
  const taken = new Set(existing.rows.map(r => `${r.invoice_kind}:${r.label || ''}`));

  // 3) Decide next segment
  let kind = 'standard';
  let label = null;
  let amount_cents = null;

  // Deposit first
  if ((A.deposit_cents || 0) > 0 && !taken.has('deposit:')) {
    kind = 'deposit';
    amount_cents = A.deposit_cents;
  } else {
    // Next progress milestone
    for (const ms of schedule) {
      const key = `progress:${ms.label || ''}`;
      if (!taken.has(key)) {
        kind = 'progress';
        label = ms.label || null;
        if (ms.amount_cents) amount_cents = ms.amount_cents;
        else if (ms.pct_of_contract) amount_cents = Math.round((ms.pct_of_contract/100) * A.contract_price_cents);
        break;
      }
    }
    // Holdback / retainage last
    if (amount_cents == null && (A.retainage_pct || 0) > 0 && !taken.has('holdback:')) {
      kind = 'holdback';
      label = 'retainage';
      amount_cents = Math.round((A.retainage_pct/100) * A.contract_price_cents);
    }
  }

  if (!amount_cents || amount_cents <= 0) {
    return { ok:false, summary:'No next invoice to draft (all items invoiced).' };
  }

  // 4) Totals
  const rate = taxRate(tax_code);
  const tax_cents = Math.round(amount_cents * rate);
  const total_cents = amount_cents + tax_cents;

  // 5) Insert draft invoice
  const ins = await query(
    `insert into invoices
      (owner_id, agreement_id, job_id, invoice_kind, status,
       subtotal_cents, tax_cents, total_cents, tax_code, due_date, meta, created_at)
     values
      ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10, now())
     returning id`,
    [owner_id, agreement_id, A.job_id || null, kind, amount_cents, tax_cents, total_cents, tax_code, due_date, JSON.stringify({ milestone_label: label })]
  );

  return {
    ok: true,
    data: { invoice_id: ins.rows[0].id },
    summary: `🧾 Draft ${kind} invoice created for $${(total_cents/100).toFixed(2)}${label ? ` (${label})` : ''}.`,
  };
}

module.exports = { createInvoice, draftNextInvoiceForAgreement };
