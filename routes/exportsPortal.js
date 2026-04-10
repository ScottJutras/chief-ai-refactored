// routes/exportsPortal.js
// Portal export pack: XLSX and PDF exports for job P&L, expenses, timesheets, year-end bundle
//
// POST /api/exports/expenses       → XLSX all expenses grouped by job
// POST /api/exports/timesheet      → XLSX timesheet with hours + labor cost
// POST /api/exports/job-pnl        → PDF for a single job (body: { job_id })
// POST /api/exports/year-end       → ZIP containing all three
//
// All routes require portal auth (tenant boundary enforced).
// Starter+ plan required for exports.

'use strict';

const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const pg = require('../services/postgres');
const { requirePortalUser } = require('../middleware/requirePortalUser');
const { getEffectivePlanKey } = require('../src/config/getEffectivePlanKey');

router.use(express.json({ limit: '32kb' }));

function bad(res, status, msg) { return res.status(status).json({ ok: false, error: msg }); }

function dollarsFmt(cents) {
  return '$' + (Math.abs(Number(cents || 0)) / 100).toFixed(2);
}

function toDate(v) {
  if (!v) return '';
  try { return new Date(v).toLocaleDateString('en-CA'); } catch { return String(v); }
}

// Shared auth + plan gate
async function authExport(req, res) {
  const tenantId = req.tenantId;
  const ownerId  = req.ownerId;
  if (!tenantId || !ownerId) { bad(res, 401, 'Missing tenant context'); return null; }

  // Require Starter+
  try {
    const owner = await pg.getOwner(ownerId);
    const plan = getEffectivePlanKey(owner);
    if (plan === 'free') {
      bad(res, 403, 'Exports require Starter or Pro plan');
      return null;
    }
  } catch {
    bad(res, 500, 'Plan check failed');
    return null;
  }

  return { tenantId, ownerId };
}

// ─── Tax category map ─────────────────────────────────────────────────────
// Maps ChiefOS expense categories → QuickBooks account name, CRA T2125 line,
// IRS Schedule C line. Used in CSV export and appended to XLSX.

const TAX_CATEGORY_MAP = {
  'materials':         { qb: 'Job Materials',           cra: 'Line 8811 – Materials',          irs: 'Line 38 – Materials' },
  'subcontractor':     { qb: 'Subcontractors',           cra: 'Line 8960 – Subcontracts',       irs: 'Line 11 – Contract labor' },
  'fuel':              { qb: 'Fuel & Gas',               cra: 'Line 9281 – Fuel costs',         irs: 'Line 9 – Car and truck expenses' },
  'equipment rental':  { qb: 'Equipment Rental',         cra: 'Line 8910 – Rent',               irs: 'Line 20b – Rent/lease equipment' },
  'equipment':         { qb: 'Tools & Equipment',        cra: 'Line 9270 – Other expenses',     irs: 'Line 22 – Supplies' },
  'tools':             { qb: 'Tools & Equipment',        cra: 'Line 9270 – Other expenses',     irs: 'Line 22 – Supplies' },
  'permits':           { qb: 'Permits & Licenses',       cra: 'Line 8760 – Business fees',      irs: 'Line 23 – Taxes and licenses' },
  'insurance':         { qb: 'Insurance Expense',        cra: 'Line 8690 – Insurance',          irs: 'Line 15 – Insurance' },
  'advertising':       { qb: 'Advertising',              cra: 'Line 8520 – Advertising',        irs: 'Line 8 – Advertising' },
  'office':            { qb: 'Office Expenses',          cra: 'Line 8810 – Office expenses',    irs: 'Line 18 – Office expense' },
  'phone':             { qb: 'Telephone',                cra: 'Line 9270 – Other expenses',     irs: 'Line 25 – Utilities' },
  'vehicle':           { qb: 'Automobile Expense',       cra: 'Line 9281 – Motor vehicle',      irs: 'Line 9 – Car and truck expenses' },
  'mileage':           { qb: 'Mileage/Auto',             cra: 'Line 9281 – Motor vehicle',      irs: 'Line 9 – Car and truck expenses' },
  'meals':             { qb: 'Meals & Entertainment',    cra: 'Line 8523 – Meals (50%)',        irs: 'Line 24b – Meals (50%)' },
  'travel':            { qb: 'Travel',                   cra: 'Line 9200 – Travel',             irs: 'Line 24a – Travel' },
  'professional fees': { qb: 'Professional Fees',        cra: 'Line 8860 – Professional fees',  irs: 'Line 17 – Legal and professional' },
  'overhead':          { qb: 'Overhead',                 cra: 'Line 9270 – Other expenses',     irs: 'Line 28 – Other expenses' },
  'other':             { qb: 'Other Job Expense',        cra: 'Line 9270 – Other expenses',     irs: 'Line 28 – Other expenses' },
};

function getTaxCategory(category) {
  if (!category) return { qb: 'Other Job Expense', cra: 'Line 9270 – Other expenses', irs: 'Line 28 – Other expenses' };
  const key = String(category).toLowerCase().trim();
  return TAX_CATEGORY_MAP[key] || { qb: category, cra: 'Line 9270 – Other expenses', irs: 'Line 28 – Other expenses' };
}

// ─── Helper: fetch all expenses for a tenant ───────────────────────────────

async function fetchExpenses(tenantId) {
  const r = await pg.query(
    `SELECT
       t.id,
       t.date,
       t.amount_cents,
       t.description,
       t.category,
       t.vendor,
       j.job_no,
       COALESCE(j.job_name, j.name, 'No job') AS job_name,
       t.created_at
     FROM public.transactions t
     LEFT JOIN public.jobs j ON j.id = t.job_id AND j.tenant_id = t.tenant_id
     WHERE t.tenant_id = $1
       AND t.kind = 'expense'
     ORDER BY t.date DESC, t.id DESC`,
    [tenantId]
  );
  return r?.rows || [];
}

// ─── Helper: fetch timesheet with labor cost ──────────────────────────────

async function fetchTimesheet(tenantId, ownerId) {
  const r = await pg.query(
    `SELECT
       te.id,
       te.clock_in,
       te.clock_out,
       te.duration_minutes,
       te.employee_name,
       COALESCE(j.job_no, 0)      AS job_no,
       COALESCE(j.job_name, j.name, 'No job') AS job_name,
       cr.hourly_rate_cents,
       ROUND((te.duration_minutes::numeric / 60.0) * COALESCE(cr.hourly_rate_cents, 0)) AS labor_cents
     FROM public.time_entries_v2 te
     LEFT JOIN public.jobs j
       ON j.id = te.job_id AND j.tenant_id = te.tenant_id
     LEFT JOIN public.chiefos_crew_rates cr
       ON cr.owner_id = te.owner_id::text
      AND LOWER(cr.employee_name) = LOWER(te.employee_name)
     WHERE te.tenant_id = $1
     ORDER BY te.clock_in DESC`,
    [tenantId]
  );
  return r?.rows || [];
}

// ─── Helper: fetch job P&L data ───────────────────────────────────────────

async function fetchJobPnl(tenantId, ownerId, jobId) {
  const jobRow = await pg.query(
    `SELECT id, job_no, job_name, name, status, created_at
     FROM public.jobs
     WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [jobId, tenantId]
  );
  const job = jobRow?.rows?.[0];
  if (!job) return null;

  const txRow = await pg.query(
    `SELECT kind, SUM(amount_cents) AS total
     FROM public.transactions
     WHERE job_id = $1 AND tenant_id = $2
     GROUP BY kind`,
    [jobId, tenantId]
  );
  const txTotals = {};
  for (const row of (txRow?.rows || [])) {
    txTotals[row.kind] = Number(row.total || 0);
  }

  const laborRow = await pg.query(
    `SELECT
       ROUND(SUM((te.duration_minutes::numeric / 60.0) * COALESCE(cr.hourly_rate_cents, 0))) AS labor_cents,
       SUM(te.duration_minutes) AS total_minutes
     FROM public.time_entries_v2 te
     LEFT JOIN public.chiefos_crew_rates cr
       ON cr.owner_id = te.owner_id::text
      AND LOWER(cr.employee_name) = LOWER(te.employee_name)
     WHERE te.tenant_id = $1 AND te.job_id = $2`,
    [tenantId, jobId]
  );
  const laborCents  = Number(laborRow?.rows?.[0]?.labor_cents  || 0);
  const totalMinutes = Number(laborRow?.rows?.[0]?.total_minutes || 0);

  const revenueCents  = txTotals['revenue']  || 0;
  const materialCents = txTotals['expense']  || 0;
  const totalCostCents = materialCents + laborCents;
  const netCents = revenueCents - totalCostCents;
  const marginPct = revenueCents > 0 ? Math.round((netCents / revenueCents) * 100) : null;

  return {
    job,
    revenueCents,
    materialCents,
    laborCents,
    totalMinutes,
    totalCostCents,
    netCents,
    marginPct,
  };
}

// ─── XLSX: Expenses by Job ─────────────────────────────────────────────────

async function buildExpensesXlsx(expenses) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ChiefOS';
  wb.created = new Date();

  const ws = wb.addWorksheet('Expenses by Job');

  ws.columns = [
    { header: 'Date',              key: 'date',        width: 14 },
    { header: 'Job #',             key: 'job_no',      width: 10 },
    { header: 'Job Name',          key: 'job_name',     width: 28 },
    { header: 'Vendor',            key: 'vendor',       width: 22 },
    { header: 'Category',          key: 'category',     width: 20 },
    { header: 'QuickBooks Account',key: 'qb_account',   width: 26 },
    { header: 'CRA T2125 Line',    key: 'cra_line',     width: 28 },
    { header: 'IRS Schedule C',    key: 'irs_line',     width: 26 },
    { header: 'Description',       key: 'description',  width: 36 },
    { header: 'Amount',            key: 'amount',       width: 14, style: { numFmt: '"$"#,##0.00' } },
  ];

  // Header styling
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F1117' } };
    cell.alignment = { vertical: 'middle' };
  });

  let totalCents = 0;
  for (const row of expenses) {
    const cents = Number(row.amount_cents || 0);
    totalCents += cents;
    const tax = getTaxCategory(row.category);
    ws.addRow({
      date:        toDate(row.date),
      job_no:      row.job_no || '',
      job_name:    row.job_name || 'No job',
      vendor:      row.vendor || '',
      category:    row.category || '',
      qb_account:  tax.qb,
      cra_line:    tax.cra,
      irs_line:    tax.irs,
      description: row.description || '',
      amount:      cents / 100,
    });
  }

  // Totals row
  const totalRow = ws.addRow({ description: 'TOTAL', amount: totalCents / 100 });
  totalRow.font = { bold: true };
  totalRow.getCell('amount').numFmt = '"$"#,##0.00';

  return wb.xlsx.writeBuffer();
}

// ─── XLSX: Timesheet with Labor Cost ──────────────────────────────────────

async function buildTimesheetXlsx(rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ChiefOS';
  wb.created = new Date();

  const ws = wb.addWorksheet('Timesheet');

  ws.columns = [
    { header: 'Employee',   key: 'employee',   width: 22 },
    { header: 'Job #',      key: 'job_no',     width: 10 },
    { header: 'Job Name',   key: 'job_name',   width: 28 },
    { header: 'Clock In',   key: 'clock_in',   width: 20 },
    { header: 'Clock Out',  key: 'clock_out',  width: 20 },
    { header: 'Hours',      key: 'hours',      width: 10, style: { numFmt: '0.00' } },
    { header: 'Rate/hr',    key: 'rate',       width: 12, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Labor Cost', key: 'labor_cost', width: 14, style: { numFmt: '"$"#,##0.00' } },
  ];

  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F1117' } };
    cell.alignment = { vertical: 'middle' };
  });

  let totalMinutes = 0;
  let totalLaborCents = 0;

  for (const row of rows) {
    const minutes = Number(row.duration_minutes || 0);
    const laborCents = Number(row.labor_cents || 0);
    const rateCents  = Number(row.hourly_rate_cents || 0);
    totalMinutes    += minutes;
    totalLaborCents += laborCents;

    ws.addRow({
      employee:   row.employee_name || '',
      job_no:     row.job_no || '',
      job_name:   row.job_name || 'No job',
      clock_in:   row.clock_in ? new Date(row.clock_in).toLocaleString('en-CA') : '',
      clock_out:  row.clock_out ? new Date(row.clock_out).toLocaleString('en-CA') : '',
      hours:      (minutes / 60).toFixed(2),
      rate:       rateCents > 0 ? rateCents / 100 : '',
      labor_cost: laborCents > 0 ? laborCents / 100 : '',
    });
  }

  // Totals row
  const totalRow = ws.addRow({
    employee:   'TOTAL',
    hours:      (totalMinutes / 60).toFixed(2),
    labor_cost: totalLaborCents / 100,
  });
  totalRow.font = { bold: true };
  totalRow.getCell('labor_cost').numFmt = '"$"#,##0.00';

  // Note if rates are missing
  const missingRates = rows.filter((r) => !r.hourly_rate_cents || Number(r.hourly_rate_cents) === 0);
  if (missingRates.length > 0) {
    ws.addRow([]);
    ws.addRow({ employee: `Note: ${missingRates.length} entries have no hourly rate set. Text "set rate [name] $X/hour" to Chief to add rates.` });
  }

  return wb.xlsx.writeBuffer();
}

// ─── CSV: Expenses (QuickBooks-compatible) ────────────────────────────────

function csvEsc(v) {
  const s = String(v ?? '').replace(/"/g, '""');
  return /[",\n\r]/.test(s) ? `"${s}"` : s;
}

function buildExpensesCsv(expenses) {
  const headers = ['Date','Job #','Job Name','Vendor','Category','QuickBooks Account','CRA T2125 Line','IRS Schedule C','Description','Amount'];
  const lines = [headers.map(csvEsc).join(',')];
  for (const row of expenses) {
    const tax = getTaxCategory(row.category);
    lines.push([
      toDate(row.date),
      row.job_no || '',
      row.job_name || 'No job',
      row.vendor || '',
      row.category || '',
      tax.qb,
      tax.cra,
      tax.irs,
      row.description || '',
      ((Number(row.amount_cents || 0)) / 100).toFixed(2),
    ].map(csvEsc).join(','));
  }
  // Total row
  const totalCents = expenses.reduce((s, r) => s + Number(r.amount_cents || 0), 0);
  lines.push(['', '', '', '', '', '', '', '', 'TOTAL', (totalCents / 100).toFixed(2)].map(csvEsc).join(','));
  return lines.join('\r\n');
}

// ─── Helper: fetch payroll summary by employee ────────────────────────────

async function fetchPayrollSummary(tenantId, ownerId, dateFrom, dateTo) {
  const from = dateFrom || (() => {
    const d = new Date(); const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1)); d.setUTCHours(0,0,0,0); return d.toISOString().slice(0,10);
  })();
  const to = dateTo || (() => {
    const d = new Date(); const day = d.getUTCDay();
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
    const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6); return sun.toISOString().slice(0,10);
  })();

  const r = await pg.query(`
    SELECT
      te.employee_name,
      ROUND(SUM(EXTRACT(EPOCH FROM (te.clock_out - te.clock_in)) / 3600.0)::numeric, 2)::float AS total_hours,
      cr.hourly_rate_cents
    FROM public.time_entries_v2 te
    LEFT JOIN LATERAL (
      SELECT hourly_rate_cents
      FROM public.chiefos_crew_rates
      WHERE owner_id::text = $1
        AND LOWER(employee_name) = LOWER(te.employee_name)
        AND effective_from <= $2::date
      ORDER BY effective_from DESC LIMIT 1
    ) cr ON true
    WHERE te.tenant_id = $4
      AND te.clock_in  >= $2::timestamptz
      AND te.clock_in  <= ($3::date + interval '1 day')::timestamptz
      AND te.deleted_at IS NULL
      AND te.kind      = 'shift'
      AND te.clock_out IS NOT NULL
    GROUP BY te.employee_name, cr.hourly_rate_cents
    ORDER BY te.employee_name
  `, [ownerId, from, to, tenantId]);

  const OT = 40;
  return (r?.rows || []).map((row) => {
    const hrs  = Number(row.total_hours)      || 0;
    const rate = Number(row.hourly_rate_cents) || 0;
    const reg  = Math.min(hrs, OT);
    const ot   = Math.max(0, hrs - OT);
    const regPay = Math.round(reg * rate);
    const otPay  = Math.round(ot  * rate * 1.5);
    return {
      employee_name:    row.employee_name,
      hourly_rate_cents: rate,
      total_hours:       hrs,
      regular_hours:     parseFloat(reg.toFixed(2)),
      ot_hours:          parseFloat(ot.toFixed(2)),
      regular_pay_cents: regPay,
      ot_pay_cents:      otPay,
      gross_pay_cents:   regPay + otPay,
      rate_missing:      rate === 0,
    };
  });
}

// ─── XLSX: Payroll Summary ─────────────────────────────────────────────────

async function buildPayrollXlsx(rows, dateFrom, dateTo) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ChiefOS';
  wb.created = new Date();

  const ws = wb.addWorksheet('Payroll Summary');

  // Period header
  ws.addRow([`Pay Period: ${dateFrom} to ${dateTo}`]);
  ws.getRow(1).font = { bold: true, size: 12 };
  ws.addRow([]);

  const headerRow = ws.addRow(['Employee','Hourly Rate','Total Hours','Regular Hours','OT Hours','Regular Pay','OT Pay (1.5×)','Gross Pay']);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F1117' } };
    cell.alignment = { vertical: 'middle' };
  });

  ws.columns = [
    { key: 'employee',    width: 24 },
    { key: 'rate',        width: 14, style: { numFmt: '"$"#,##0.00' } },
    { key: 'total_hrs',   width: 14, style: { numFmt: '0.00' } },
    { key: 'reg_hrs',     width: 16, style: { numFmt: '0.00' } },
    { key: 'ot_hrs',      width: 12, style: { numFmt: '0.00' } },
    { key: 'reg_pay',     width: 16, style: { numFmt: '"$"#,##0.00' } },
    { key: 'ot_pay',      width: 16, style: { numFmt: '"$"#,##0.00' } },
    { key: 'gross',       width: 16, style: { numFmt: '"$"#,##0.00' } },
  ];

  let totalGross = 0;
  for (const row of rows) {
    const dataRow = ws.addRow([
      row.employee_name,
      row.rate_missing ? 'No rate set' : row.hourly_rate_cents / 100,
      row.total_hours,
      row.regular_hours,
      row.ot_hours,
      row.rate_missing ? '' : row.regular_pay_cents / 100,
      row.rate_missing ? '' : row.ot_pay_cents / 100,
      row.rate_missing ? '' : row.gross_pay_cents / 100,
    ]);
    if (row.ot_hours > 0) {
      dataRow.getCell(5).font = { color: { argb: 'FFD97706' } }; // amber for OT
    }
    if (!row.rate_missing) totalGross += row.gross_pay_cents;
  }

  // Totals row
  const totRow = ws.addRow(['TOTAL', '', '', '', '', '', '', totalGross / 100]);
  totRow.font = { bold: true };
  totRow.getCell(8).numFmt = '"$"#,##0.00';

  // Disclaimer
  ws.addRow([]);
  ws.addRow(['Note: ChiefOS calculates labour costs only. Your payroll provider handles deductions, taxes, and direct deposits.']);
  ws.addRow(['Set missing rates via WhatsApp: "set rate [name] $X/hour"']);

  return wb.xlsx.writeBuffer();
}

// ─── CSV: Payroll Summary ──────────────────────────────────────────────────

function buildPayrollCsv(rows, dateFrom, dateTo) {
  const headers = ['Pay Period','Employee','Hourly Rate','Total Hours','Regular Hours','OT Hours','Regular Pay','OT Pay (1.5x)','Gross Pay'];
  const period  = `${dateFrom} to ${dateTo}`;
  const lines   = [headers.map(csvEsc).join(',')];
  for (const row of rows) {
    lines.push([
      period,
      row.employee_name,
      row.rate_missing ? '' : (row.hourly_rate_cents / 100).toFixed(2),
      row.total_hours.toFixed(2),
      row.regular_hours.toFixed(2),
      row.ot_hours.toFixed(2),
      row.rate_missing ? '' : (row.regular_pay_cents / 100).toFixed(2),
      row.rate_missing ? '' : (row.ot_pay_cents / 100).toFixed(2),
      row.rate_missing ? '' : (row.gross_pay_cents / 100).toFixed(2),
    ].map(csvEsc).join(','));
  }
  const totalGross = rows.filter((r) => !r.rate_missing).reduce((s, r) => s + r.gross_pay_cents, 0);
  lines.push(['', 'TOTAL', '', '', '', '', '', '', (totalGross / 100).toFixed(2)].map(csvEsc).join(','));
  lines.push(['', 'Note: Labour costs only. Payroll provider handles deductions and taxes.', '', '', '', '', '', '', ''].map(csvEsc).join(','));
  return lines.join('\r\n');
}

// ─── PDF: Single Job P&L ──────────────────────────────────────────────────

function buildJobPnlPdf(pnlData) {
  const { job, revenueCents, materialCents, laborCents, totalMinutes, totalCostCents, netCents, marginPct } = pnlData;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 60 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const jobLabel = job.job_name || job.name || `Job #${job.job_no}`;
    const generatedOn = new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });

    // Header bar
    doc.rect(0, 0, doc.page.width, 70).fill('#0f1117');
    doc.fillColor('#ffffff').fontSize(20).font('Helvetica-Bold')
      .text('Job P&L Report', 60, 20);
    doc.fontSize(11).font('Helvetica')
      .text(`Generated ${generatedOn}`, 60, 46);

    doc.fillColor('#000000');
    doc.moveDown(3);

    // Job title
    doc.fontSize(16).font('Helvetica-Bold').text(jobLabel);
    if (job.job_no) doc.fontSize(11).font('Helvetica').fillColor('#666666').text(`Job #${job.job_no}`);
    doc.fillColor('#000000').moveDown(1.2);

    // P&L table
    const tableX   = 60;
    const valueX   = 380;
    const rowH     = 26;
    let y = doc.y;

    function pnlRow(label, cents, { bold = false, separator = false, color = '#000000' } = {}) {
      if (separator) {
        doc.moveTo(tableX, y - 4).lineTo(560, y - 4).strokeColor('#cccccc').lineWidth(0.5).stroke();
      }
      doc.fontSize(11).font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fillColor(color)
        .text(label, tableX, y)
        .text(dollarsFmt(cents), valueX, y, { align: 'right', width: 120 });
      y += rowH;
    }

    pnlRow('Revenue',          revenueCents,  { bold: true, color: '#16a34a' });
    pnlRow('Materials / Expenses', materialCents, { separator: true });
    pnlRow('Labour Cost',      laborCents);
    pnlRow('Total Costs',      totalCostCents, { separator: true, bold: true });

    // Net margin row
    const netColor = netCents >= 0 ? '#16a34a' : '#dc2626';
    doc.moveTo(tableX, y - 4).lineTo(560, y - 4).strokeColor('#000000').lineWidth(1.5).stroke();
    pnlRow('Net Profit', netCents, { bold: true, color: netColor });

    // Margin %
    if (marginPct !== null) {
      doc.fontSize(13).font('Helvetica-Bold').fillColor(netColor)
        .text(`Margin: ${marginPct}%`, tableX, y);
      y += rowH;
    }

    // Labour hours note
    if (totalMinutes > 0) {
      doc.moveDown(0.5);
      doc.fontSize(9).font('Helvetica').fillColor('#888888')
        .text(`Total labour: ${(totalMinutes / 60).toFixed(1)} hrs`, tableX);
    }

    // Footer
    doc.fontSize(8).fillColor('#aaaaaa')
      .text('Generated by ChiefOS — chiefos.com', 60, doc.page.height - 40, { align: 'center', width: doc.page.width - 120 });

    doc.end();
  });
}

// ─── Route: Expenses XLSX ─────────────────────────────────────────────────

router.post('/expenses', requirePortalUser(), async (req, res) => {
  try {
    const ctx = await authExport(req, res);
    if (!ctx) return;

    const expenses = await fetchExpenses(ctx.tenantId);
    const buf = await buildExpensesXlsx(expenses);

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="chiefos-expenses-${dateStr}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buf);
  } catch (e) {
    console.error('[EXPORT_EXPENSES]', e?.message);
    return bad(res, 500, 'export_failed');
  }
});

// ─── Route: Timesheet XLSX ────────────────────────────────────────────────

router.post('/timesheet', requirePortalUser(), async (req, res) => {
  try {
    const ctx = await authExport(req, res);
    if (!ctx) return;

    const rows = await fetchTimesheet(ctx.tenantId, ctx.ownerId);
    const buf = await buildTimesheetXlsx(rows);

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="chiefos-timesheet-${dateStr}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buf);
  } catch (e) {
    console.error('[EXPORT_TIMESHEET]', e?.message);
    return bad(res, 500, 'export_failed');
  }
});

// ─── Route: Job P&L PDF ───────────────────────────────────────────────────

router.post('/job-pnl', requirePortalUser(), async (req, res) => {
  try {
    const ctx = await authExport(req, res);
    if (!ctx) return;

    const jobId = Number(req.body?.job_id);
    if (!jobId || !Number.isInteger(jobId)) return bad(res, 400, 'Missing job_id');

    const pnlData = await fetchJobPnl(ctx.tenantId, ctx.ownerId, jobId);
    if (!pnlData) return bad(res, 404, 'Job not found');

    const buf = await buildJobPnlPdf(pnlData);
    const jobLabel = (pnlData.job.job_name || pnlData.job.name || `job-${pnlData.job.job_no || jobId}`)
      .replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const dateStr = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="chiefos-pnl-${jobLabel}-${dateStr}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buf);
  } catch (e) {
    console.error('[EXPORT_JOB_PNL]', e?.message);
    return bad(res, 500, 'export_failed');
  }
});

// ─── Route: Year-end bundle (ZIP) ─────────────────────────────────────────

router.post('/year-end', requirePortalUser(), async (req, res) => {
  try {
    const ctx = await authExport(req, res);
    if (!ctx) return;

    // Lazy-load archiver (optional dep — graceful degradation)
    let archiver;
    try { archiver = require('archiver'); } catch {}

    if (!archiver) {
      // Fallback: return expenses XLSX if archiver not installed
      const expenses = await fetchExpenses(ctx.tenantId);
      const buf = await buildExpensesXlsx(expenses);
      const dateStr = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="chiefos-year-end-${dateStr}.xlsx"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(buf);
    }

    const year = req.body?.year || new Date().getFullYear();
    const dateStr = new Date().toISOString().slice(0, 10);

    // Build all exports in parallel
    const [expenses, timesheetRows] = await Promise.all([
      fetchExpenses(ctx.tenantId),
      fetchTimesheet(ctx.tenantId, ctx.ownerId),
    ]);

    const [expensesBuf, timesheetBuf] = await Promise.all([
      buildExpensesXlsx(expenses),
      buildTimesheetXlsx(timesheetRows),
    ]);

    const expensesCsv = buildExpensesCsv(expenses);

    // Fetch all jobs for P&L PDF bundle
    const jobsRes = await pg.query(
      `SELECT id FROM public.jobs WHERE tenant_id = $1 AND status NOT IN ('archived', 'cancelled') ORDER BY created_at DESC LIMIT 50`,
      [ctx.tenantId]
    );
    const jobs = jobsRes?.rows || [];

    const archive = archiver('zip', { zlib: { level: 6 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="chiefos-year-end-${year}-${dateStr}.zip"`);
    res.setHeader('Cache-Control', 'no-store');
    archive.pipe(res);

    archive.append(Buffer.from(expensesBuf), { name: `expenses-${year}.xlsx` });
    archive.append(Buffer.from(timesheetBuf), { name: `timesheet-${year}.xlsx` });
    archive.append(Buffer.from('\uFEFF' + expensesCsv), { name: `expenses-quickbooks-${year}.csv` });

    // Add individual job P&L PDFs
    for (const job of jobs) {
      try {
        const pnlData = await fetchJobPnl(ctx.tenantId, ctx.ownerId, job.id);
        if (!pnlData || pnlData.revenueCents === 0) continue;
        const pdfBuf = await buildJobPnlPdf(pnlData);
        const jobLabel = (pnlData.job.job_name || pnlData.job.name || `job-${pnlData.job.job_no || job.id}`)
          .replace(/[^a-z0-9]/gi, '-').toLowerCase();
        archive.append(pdfBuf, { name: `job-pnl/${jobLabel}.pdf` });
      } catch {
        // skip failed jobs
      }
    }

    await archive.finalize();
  } catch (e) {
    console.error('[EXPORT_YEAR_END]', e?.message);
    if (!res.headersSent) return bad(res, 500, 'export_failed');
  }
});

// ─── Route: Expenses CSV (QuickBooks-compatible) ──────────────────────────

router.post('/expenses-csv', requirePortalUser(), async (req, res) => {
  try {
    const ctx = await authExport(req, res);
    if (!ctx) return;

    const expenses = await fetchExpenses(ctx.tenantId);
    const csv = buildExpensesCsv(expenses);

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chiefos-expenses-qb-${dateStr}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send('\uFEFF' + csv); // BOM for Excel UTF-8 compatibility
  } catch (e) {
    console.error('[EXPORT_EXPENSES_CSV]', e?.message);
    return bad(res, 500, 'export_failed');
  }
});

// ─── Route: Payroll XLSX ──────────────────────────────────────────────────

router.post('/payroll', requirePortalUser(), async (req, res) => {
  try {
    const ctx = await authExport(req, res);
    if (!ctx) return;

    const dateFrom = req.body?.date_from || null;
    const dateTo   = req.body?.date_to   || null;
    const format   = String(req.body?.format || 'xlsx').toLowerCase();

    const rows = await fetchPayrollSummary(ctx.tenantId, ctx.ownerId, dateFrom, dateTo);

    // Resolve actual date range for headers
    const from = dateFrom || (() => {
      const d = new Date(); const day = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1)); return d.toISOString().slice(0,10);
    })();
    const to = dateTo || (() => {
      const d = new Date(); const day = d.getUTCDay();
      const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
      const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6); return sun.toISOString().slice(0,10);
    })();

    const periodStr = `${from}-to-${to}`;

    if (format === 'csv') {
      const csv = buildPayrollCsv(rows, from, to);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="chiefos-payroll-${periodStr}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.send('\uFEFF' + csv);
    }

    const buf = await buildPayrollXlsx(rows, from, to);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="chiefos-payroll-${periodStr}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buf);
  } catch (e) {
    console.error('[EXPORT_PAYROLL]', e?.message);
    return bad(res, 500, 'export_failed');
  }
});

module.exports = router;
