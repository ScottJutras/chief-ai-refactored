// services/agentTools/getJobKpis.js
const { query } = require('../postgres');

function fmtCents(n) {
  if (n == null) return '—';
  const s = (Math.trunc(n) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `$${s}`;
}

async function getJobKpis({ ownerId, jobNo, day }) {
  const owner = String(ownerId).replace(/\D/g,'');
  const { rows } = await query(
    `select *
       from public.job_kpis_daily
      where owner_id=$1 and job_no=$2 and day=$3
      limit 1`,
    [owner, jobNo, String(day).slice(0,10)]
  );
  const r = rows[0];
  if (!r) return `No KPIs yet for job #${jobNo} on ${day}.`;

  const lines = [
    `• Paid labour: ${(r.paid_minutes ?? 0)} min`,
    `• Drive: ${(r.drive_minutes ?? 0)} min`,
    `• Gross Profit: ${fmtCents(r.gross_profit_cents)} (${r.gross_margin_pct ?? '—'}%)`,
    `• Revenue: ${fmtCents(r.revenue_cents)}  |  COGS: ${fmtCents(r.cogs_cents)}`,
    `• Holdbacks (unreleased): ${fmtCents(r.holdback_cents)}  |  Change Orders: ${fmtCents(r.change_order_cents)}`,
    `• Open A/R: ${fmtCents(r.ar_total_cents)}  |  Open A/P: ${fmtCents(r.ap_total_cents)}`,
    (r.slippage_cents == null ? null : `• Profit vs Estimate (Slippage): ${fmtCents(r.slippage_cents)} ${r.slippage_cents>0?'(above)':'(below)'} estimate`)
  ].filter(Boolean);

  return [
    `Job #${jobNo} — ${day}`,
    ...lines,
    '',
    `Tip: Holdbacks tie up cash. If retainage > payroll for ~2 weeks, consider front-loading draws or negotiating a lower % on variants.`
  ].join('\n');
}

module.exports = { getJobKpis };
