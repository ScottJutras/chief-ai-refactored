// services/jobsKpis.js
// ------------------------------------------------------------
// Job-level KPI engine for contractors.
// Built on:
//   - job_kpis_summary view   (per-job financial rollup)
//   - job_kpis_daily table    (per-day job KPIs & minutes)
//   - jobs table              (names, status, created_at)
//
// GOAL: Jobs are the primary lens. Whenever possible, KPIs are
// keyed by job_no and job_name, not just company-level totals.
//
// This module returns:
//   {
//     ownerId,
//     jobs: [ { ...job metrics & derived KPIs... } ],
//     aggregates: { ...portfolio KPIs & buckets... }
//   }
//
// Safe assumptions (based on your schema so far):
//   job_kpis_summary:
//     owner_id           text
//     job_no             text or int
//     revenue_cents      bigint
//     cogs_cents         bigint
//     gross_profit_cents bigint
//     gross_margin_pct   numeric
//     holdback_cents     bigint
//     change_order_cents bigint
//     ar_total_cents     bigint
//     ap_total_cents     bigint
//     slippage_cents     bigint
//
//   job_kpis_daily:
//     owner_id, job_no
//     day                date
//     revenue_cents, cogs_cents, gross_profit_cents, gross_margin_pct
//     paid_minutes       int
//     drive_minutes      int
//     holdback_cents, change_order_cents, ar_total_cents, ap_total_cents
//     slippage_cents
//
//   jobs:
//     owner_id
//     job_no        (assumed; if missing, JOIN will still be safe if you add it later)
//     name
//     status
//     created_at
//
// NOTES:
// - Everything is tolerant: if a query fails or a column is missing,
//   we log and degrade gracefully rather than crashing the app.
// ------------------------------------------------------------

const { query } = require('./postgres');

function normalizeOwnerId(ownerId) {
  if (!ownerId) return null;
  // Your owner IDs are phone-like numeric strings; strip non-digits.
  return String(ownerId).replace(/\D/g, '');
}

// Small helpers
function toNum(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function diffDays(a, b) {
  if (!a || !b) return null;
  const ms = a.getTime() - b.getTime();
  return Math.round(ms / 86_400_000); // 1000*60*60*24
}

/**
 * Fetch base per-job financial KPIs from job_kpis_summary
 * plus job metadata from jobs (name, status, created_at).
 */
async function loadBaseJobRows(ownerId, { limit = 200 } = {}) {
  const owner = normalizeOwnerId(ownerId);
  if (!owner) throw new Error('getJobKpiSummary: ownerId is required');

  // We keep this simple: if jobs.job_no doesn't exist yet,
  // you can adjust the JOIN later. For now, we assume it does.
  const sql = `
    SELECT
      s.owner_id,
      s.job_no,
      s.revenue_cents,
      s.cogs_cents,
      s.gross_profit_cents,
      s.gross_margin_pct,
      s.holdback_cents,
      s.change_order_cents,
      s.ar_total_cents,
      s.ap_total_cents,
      s.slippage_cents,
      j.name      AS job_name,
      j.status    AS job_status,
      j.created_at AS job_created_at
    FROM job_kpis_summary s
    LEFT JOIN jobs j
      ON j.owner_id = s.owner_id
     AND j.job_no   = s.job_no
    WHERE s.owner_id = $1
    ORDER BY s.gross_profit_cents DESC NULLS LAST
    LIMIT $2
  `;

  const { rows } = await query(sql, [owner, limit]);
  return rows;
}

/**
 * Fetch per-job activity from job_kpis_daily:
 * - first_day / last_day (for job aging & duration)
 * - paid_minutes / drive_minutes (for crew efficiency)
 */
async function loadJobActivity(ownerId) {
  const owner = normalizeOwnerId(ownerId);
  const sql = `
    SELECT
      owner_id,
      job_no,
      MIN(day) AS first_day,
      MAX(day) AS last_day,
      SUM(paid_minutes)  AS paid_minutes,
      SUM(drive_minutes) AS drive_minutes
    FROM job_kpis_daily
    WHERE owner_id = $1
    GROUP BY owner_id, job_no
  `;
  const { rows } = await query(sql, [owner]);

  const map = new Map();
  for (const r of rows) {
    map.set(String(r.job_no), {
      first_day: r.first_day ? new Date(r.first_day) : null,
      last_day: r.last_day ? new Date(r.last_day) : null,
      paid_minutes: toNum(r.paid_minutes),
      drive_minutes: toNum(r.drive_minutes),
    });
  }
  return map;
}

/**
 * Main entry point:
 * Get job-level KPIs + portfolio aggregates for a contractor.
 *
 * Derived KPIs (per job):
 *  - job_age_days
 *  - active_days
 *  - labour_hours
 *  - drive_hours
 *  - revenue_per_labour_hour_cents
 *  - gross_profit_per_labour_hour_cents
 *  - drive_share_pct
 *  - holdback_pct_of_contract
 *  - cash_collected_cents
 *  - cash_position_now_cents
 *  - cash_after_all_paid_cents
 *  - holdback_age_days (approx)
 *  - is_leaking_profit (slippage < 0)
 *  - contractor-friendly tags (good, watch, bad)
 *
 * Aggregates:
 *  - total_revenue_cents
 *  - total_gross_profit_cents
 *  - avg_gross_margin_pct
 *  - avg_revenue_per_labour_hour_cents
 *  - avg_drive_share_pct
 *  - holdback_buckets_cents: { "0_30", "31_60", "61_90", "90_plus" }
 *  - counts: { jobs, leaking_jobs, high_margin_jobs }
 */
async function getJobKpiSummary(ownerId, { limit = 200 } = {}) {
  const owner = normalizeOwnerId(ownerId);
  if (!owner) throw new Error('getJobKpiSummary: ownerId is required');

  let baseRows = [];
  let activityByJob = new Map();

  // 1) Base financials + metadata
  try {
    baseRows = await loadBaseJobRows(owner, { limit });
  } catch (err) {
    console.error('[JOB_KPIS] base query failed:', err.message);
    baseRows = [];
  }

  // 2) Activity (aging + crew minutes)
  try {
    activityByJob = await loadJobActivity(owner);
  } catch (err) {
    console.error('[JOB_KPIS] activity query failed:', err.message);
    activityByJob = new Map();
  }

  const now = new Date();

  const jobs = [];
  let totalRevenue = 0;
  let totalGrossProfit = 0;
  let marginSum = 0;
  let marginCount = 0;
  let labourHoursSum = 0;
  let revPerHrSum = 0;
  let revPerHrCount = 0;
  let driveShareSum = 0;
  let driveShareCount = 0;

  const holdbackBuckets = {
    '0_30': 0,
    '31_60': 0,
    '61_90': 0,
    '90_plus': 0,
  };

  let leakingJobs = 0;
  let highMarginJobs = 0;

  for (const row of baseRows) {
    const jobKey = String(row.job_no);
    const act = activityByJob.get(jobKey) || {};

    const revenue_cents = toNum(row.revenue_cents);
    const cogs_cents = toNum(row.cogs_cents);
    const gross_profit_cents = toNum(row.gross_profit_cents);
    const gross_margin_pct = row.gross_margin_pct != null ? Number(row.gross_margin_pct) : null;
    const holdback_cents = toNum(row.holdback_cents);
    const change_order_cents = toNum(row.change_order_cents);
    const ar_total_cents = toNum(row.ar_total_cents);
    const ap_total_cents = toNum(row.ap_total_cents);
    const slippage_cents = toNum(row.slippage_cents);

    const paid_minutes = toNum(act.paid_minutes);
    const drive_minutes = toNum(act.drive_minutes);
    const labour_hours = paid_minutes / 60;
    const drive_hours = drive_minutes / 60;

    const job_created_at = row.job_created_at ? new Date(row.job_created_at) : null;
    const first_day = act.first_day || job_created_at || null;
    const last_day = act.last_day || job_created_at || null;

    const job_age_days = first_day ? diffDays(now, first_day) : null;
    const active_days = first_day && last_day ? diffDays(last_day, first_day) + 1 : null;

    // Contractor KPIs
    let revenue_per_labour_hour_cents = null;
    let gross_profit_per_labour_hour_cents = null;
    let drive_share_pct = null;

    if (labour_hours > 0) {
      revenue_per_labour_hour_cents = revenue_cents / labour_hours;
      gross_profit_per_labour_hour_cents = gross_profit_cents / labour_hours;
      revPerHrSum += revenue_per_labour_hour_cents;
      revPerHrCount += 1;
    }

    if (paid_minutes > 0) {
      drive_share_pct = (drive_minutes * 100) / paid_minutes;
      driveShareSum += drive_share_pct;
      driveShareCount += 1;
    }

    const holdback_pct_of_contract =
      revenue_cents > 0 ? (holdback_cents * 100) / revenue_cents : null;

    // Cashflow approximations (per job)
    // cash_collected ≈ invoiced - AR - holdback
    const cash_collected_cents = revenue_cents - ar_total_cents - holdback_cents;

    // cash_position_now ≈ collected - AP
    const cash_position_now_cents = cash_collected_cents - ap_total_cents;

    // cash_after_all_paid ≈ revenue - cogs - AP
    const cash_after_all_paid_cents = revenue_cents - cogs_cents - ap_total_cents;

    // Approx holdback age: since last revenue day (if any)
    const holdback_age_days =
      holdback_cents > 0 && last_day ? diffDays(now, last_day) : null;

    // Slippage & tags
    const is_leaking_profit = slippage_cents < 0;
    const leak_amount_cents = Math.abs(Math.min(slippage_cents, 0));

    let performance_tag = 'ok';
    if (gross_margin_pct != null) {
      if (gross_margin_pct >= 30) performance_tag = 'high_margin';
      else if (gross_margin_pct < 15) performance_tag = 'thin_margin';
    }
    if (is_leaking_profit) performance_tag = 'leaking_profit';

    // Aggregate portfolio metrics
    totalRevenue += revenue_cents;
    totalGrossProfit += gross_profit_cents;
    if (gross_margin_pct != null) {
      marginSum += gross_margin_pct;
      marginCount += 1;
    }
    labourHoursSum += labour_hours;

    if (is_leaking_profit) leakingJobs += 1;
    if (!is_leaking_profit && gross_margin_pct != null && gross_margin_pct >= 30) {
      highMarginJobs += 1;
    }

    if (holdback_cents > 0 && holdback_age_days != null) {
      if (holdback_age_days <= 30) {
        holdbackBuckets['0_30'] += holdback_cents;
      } else if (holdback_age_days <= 60) {
        holdbackBuckets['31_60'] += holdback_cents;
      } else if (holdback_age_days <= 90) {
        holdbackBuckets['61_90'] += holdback_cents;
      } else {
        holdbackBuckets['90_plus'] += holdback_cents;
      }
    }

    jobs.push({
      owner_id: row.owner_id,
      job_no: row.job_no,
      job_name: row.job_name || null,
      job_status: row.job_status || null,
      job_created_at: job_created_at ? job_created_at.toISOString() : null,

      // Raw financials
      revenue_cents,
      cogs_cents,
      gross_profit_cents,
      gross_margin_pct,
      holdback_cents,
      change_order_cents,
      ar_total_cents,
      ap_total_cents,
      slippage_cents,

      // Activity
      first_day: first_day ? first_day.toISOString().slice(0, 10) : null,
      last_day: last_day ? last_day.toISOString().slice(0, 10) : null,
      job_age_days,
      active_days,

      // Crew / labour efficiency
      paid_minutes,
      drive_minutes,
      labour_hours,
      drive_hours,
      revenue_per_labour_hour_cents,
      gross_profit_per_labour_hour_cents,
      drive_share_pct,

      // Cashflow & holdbacks
      cash_collected_cents,
      cash_position_now_cents,
      cash_after_all_paid_cents,
      holdback_pct_of_contract,
      holdback_age_days,

      // Interpretation flags
      is_leaking_profit,
      leak_amount_cents,
      performance_tag, // 'high_margin' | 'thin_margin' | 'leaking_profit' | 'ok'
    });
  }

  const avg_margin_pct = marginCount ? marginSum / marginCount : null;
  const avg_revenue_per_labour_hour_cents =
    revPerHrCount ? revPerHrSum / revPerHrCount : null;
  const avg_drive_share_pct =
    driveShareCount ? driveShareSum / driveShareCount : null;

  return {
    ownerId: owner,
    jobs,
    aggregates: {
      total_revenue_cents: totalRevenue,
      total_gross_profit_cents: totalGrossProfit,
      avg_gross_margin_pct: avg_margin_pct,
      labour_hours_sum: labourHoursSum,
      avg_revenue_per_labour_hour_cents,
      avg_drive_share_pct,
      holdback_buckets_cents: holdbackBuckets,
      counts: {
        jobs: jobs.length,
        leaking_jobs: leakingJobs,
        high_margin_jobs: highMarginJobs,
      },
    },
  };
}

module.exports = {
  getJobKpiSummary,
};
