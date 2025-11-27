// handlers/commands/job_kpis.js
// High-level KPIs backed by transactions + pricing_items

const {
  getJobFinanceSnapshot,
  getOwnerPricingItems,
  getActiveJob, // if this exists in services/postgres; otherwise we’ll fall back to userProfile
} = require('../../services/postgres');

/**
 * Parse an optional job name from text.
 * Example: "kpis for Roof Repair" → "Roof Repair"
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

/**
 * Main handler for "kpis for ..." style commands.
 *
 * @returns {Promise<string>} human readable summary
 */
async function handleJobKpis(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  // 1) Decide which job we’re talking about
  const explicitJobName = parseJobNameFromText(text);

  let jobId = userProfile?.active_job_id || null;
  let jobName = userProfile?.active_job_name || null;

  // If user specified a job name in the command text, prefer that.
  if (explicitJobName) {
    jobName = explicitJobName;
    // Optional: if you have a "findJobByName" helper, resolve jobId here.
    // For now, we just show owner-level KPIs with that label.
  }

  // 2) Pull finance snapshot (scoped to jobId if we have one)
  const snapshot = await getJobFinanceSnapshot(ownerId, jobId);
  const rev = snapshot.total_revenue_cents;
  const exp = snapshot.total_expense_cents;
  const prof = snapshot.profit_cents;
  const margin = snapshot.margin_pct;

  // 3) Pull pricing catalog to surface a few common items
  const pricing = await getOwnerPricingItems(ownerId);
  const sample = (pricing || []).slice(0, 5);

  const lines = [];

  if (jobId || jobName) {
    lines.push(
      `KPIs for job: ${jobName || '(active job)'}`,
      '---------------------------------'
    );
  } else {
    lines.push(
      `KPIs across all jobs`,
      '---------------------'
    );
  }

  lines.push(
    `Revenue:  ${formatDollars(rev)}`,
    `Expenses: ${formatDollars(exp)}`,
    `Profit:   ${formatDollars(prof)}`
  );

  if (margin != null) {
    lines.push(`Margin:   ${margin.toFixed(1)}%`);
  }

  if (sample.length > 0) {
    lines.push('', 'Sample pricing items:');
    for (const row of sample) {
      const label = row.item_name || 'Item';
      const unit = row.unit || 'each';
      const costStr = formatDollars(row.unit_cost_cents);
      const kind = row.kind || 'material';
      lines.push(`• ${label} (${kind}, ${unit}) — ${costStr}`);
    }
  } else {
    lines.push('', 'No pricing items saved yet.');
  }

  lines.push('', 'Tip: you can add materials with “add material shingles at $120.50”.');

  return lines.join('\n');
}

module.exports = { handleJobKpis };
