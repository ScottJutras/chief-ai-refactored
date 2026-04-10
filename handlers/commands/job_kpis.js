// handlers/commands/job_kpis.js
// Job profitability summary — revenue, materials, labor cost, net margin.
// Labor cost uses time_entries_v2 × chiefos_crew_rates (hours × hourly_rate_cents).

const { Pool } = require('pg');
const {
  getJobFinanceSnapshot,
  getOwnerPricingItems,
} = require('../../services/postgres');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/**
 * Parse an optional job name from text.
 * "kpis for Roof Repair" → "Roof Repair"
 */
function parseJobNameFromText(text) {
  const m = String(text || '').match(/kpis?\s+for\s+(.+)$/i);
  if (!m) return null;
  return m[1].trim();
}

/**
 * Format cents as $X,XXX.XX
 */
function formatDollars(cents) {
  const n = Number(cents) || 0;
  const v = (n / 100).toFixed(2);
  return `$${v.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function toFloat(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Resolve job_id and name from a job name string (fuzzy match).
 */
async function resolveJobByName(ownerId, jobName) {
  if (!jobName) return null;
  try {
    const r = await pool.query(
      `SELECT id, name, job_no
         FROM public.jobs
        WHERE owner_id::text = $1
          AND lower(name) LIKE lower($2)
          AND status NOT IN ('archived', 'cancelled')
        ORDER BY created_at DESC
        LIMIT 1`,
      [String(ownerId), `%${jobName}%`]
    );
    return r?.rows?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Compute labor cost for a job from time_entries_v2 × chiefos_crew_rates.
 * Returns { laborCents, laborHours, byEmployee, hasRates }
 */
async function computeJobLaborCost(ownerId, jobId) {
  try {
    const r = await pool.query(
      `SELECT
         te.employee_name,
         SUM(EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in)) / 3600.0) AS hours,
         COALESCE(cr.hourly_rate_cents, 0) AS rate_cents
       FROM public.time_entries_v2 te
       LEFT JOIN public.chiefos_crew_rates cr
         ON cr.owner_id = $1
         AND LOWER(cr.employee_name) = LOWER(te.employee_name)
       WHERE te.owner_id::text = $1
         AND te.job_id::text = $2
       GROUP BY te.employee_name, cr.hourly_rate_cents`,
      [String(ownerId), String(jobId)]
    );

    const rows = r?.rows || [];
    let laborCents = 0;
    let laborHours = 0;
    let hasRates = false;
    const byEmployee = [];

    for (const row of rows) {
      const hours = toFloat(row.hours);
      const rate = toInt(row.rate_cents);
      if (rate > 0) hasRates = true;
      const cost = Math.round(hours * rate);
      laborCents += cost;
      laborHours += hours;
      byEmployee.push({ name: row.employee_name || 'Unknown', hours, rate, cost });
    }

    return {
      laborCents,
      laborHours: Math.round(laborHours * 10) / 10,
      byEmployee,
      hasRates,
    };
  } catch {
    return { laborCents: 0, laborHours: 0, byEmployee: [], hasRates: false };
  }
}

/**
 * Main handler for "kpis for ..." style commands.
 * Returns a human-readable string (not TwiML — caller wraps it).
 */
async function handleJobKpis(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const explicitJobName = parseJobNameFromText(text);

  let jobId = userProfile?.active_job_id || null;
  let jobName = userProfile?.active_job_name || null;

  // Prefer explicitly named job over active job
  if (explicitJobName) {
    const resolved = await resolveJobByName(ownerId, explicitJobName);
    if (resolved) {
      jobId   = String(resolved.id);
      jobName = resolved.name;
    } else {
      jobName = explicitJobName;
    }
  }

  // Pull finance snapshot (revenue + material expenses from transactions)
  const snapshot = await getJobFinanceSnapshot(ownerId, jobId);
  const rev = toInt(snapshot?.total_revenue_cents);
  const matExp = toInt(snapshot?.total_expense_cents);

  // Pull labor cost from time entries × rates
  const labor = jobId
    ? await computeJobLaborCost(ownerId, jobId)
    : { laborCents: 0, laborHours: 0, byEmployee: [], hasRates: false };

  const totalExp = matExp + labor.laborCents;
  const profit   = rev - totalExp;
  const margin   = rev > 0 ? Math.round((profit / rev) * 100) : null;

  const lines = [];

  const jobLabel = jobName || '(all jobs)';
  const headerLine = jobId
    ? `📊 Job P&L: ${jobLabel}`
    : `📊 P&L across all jobs`;
  lines.push(headerLine, '─'.repeat(Math.min(headerLine.length, 30)));

  lines.push(`Revenue:    ${formatDollars(rev)}`);

  if (matExp > 0) {
    lines.push(`Materials:  ${formatDollars(matExp)}`);
  }

  if (labor.laborHours > 0) {
    if (labor.laborCents > 0) {
      lines.push(`Labor:      ${formatDollars(labor.laborCents)} (${labor.laborHours}h)`);
    } else {
      lines.push(`Labor:      ${labor.laborHours}h logged — set rates for $ values`);
    }
  }

  if (matExp > 0 || labor.laborCents > 0) {
    lines.push(`Total cost: ${formatDollars(totalExp)}`);
  }

  lines.push(`Net profit: ${formatDollars(profit)}`);

  if (margin !== null) {
    const marginEmoji = margin >= 30 ? '✅' : margin >= 20 ? '⚠️' : '🔴';
    lines.push(`Margin:     ${margin}% ${marginEmoji}`);
  }

  // Labor breakdown by employee (if rates are set and multiple crew)
  if (labor.byEmployee.length > 1 && labor.hasRates) {
    lines.push('', 'Labor breakdown:');
    for (const emp of labor.byEmployee) {
      const costStr = emp.cost > 0 ? ` — ${formatDollars(emp.cost)}` : '';
      lines.push(`  ${emp.name}: ${emp.hours}h${costStr}`);
    }
  }

  // Upsell nudge if labor hours logged but no rates set
  if (labor.laborHours > 0 && !labor.hasRates) {
    lines.push('', `Tip: set labor rates to see full P&L.\nTry: set rate [name] $X/hour`);
  }

  return lines.join('\n');
}

module.exports = { handleJobKpis };
