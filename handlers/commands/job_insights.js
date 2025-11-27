// handlers/commands/job_insights.js

const {
  getOwnerJobsFinance,
} = require('../../services/postgres');

/**
 * Try to find the best matching job for this owner from the free-form text.
 *
 * We use simple fuzzy matching over job names for now.
 */
function findBestJobFromText(text, jobs) {
  const lc = String(text || '').toLowerCase();

  // Exact-ish containment: job name inside text OR text inside job name
  let best = null;
  let bestScore = 0;

  for (const job of jobs) {
    const name = String(job.name || '').trim();
    if (!name) continue;

    const ln = name.toLowerCase();

    let score = 0;

    // Strong hit: full name appears in text
    if (lc.includes(ln)) score += 3;

    // Token overlap score
    const words = ln.split(/\s+/).filter(Boolean);
    for (const w of words) {
      if (w.length < 3) continue;
      if (lc.includes(w)) score += 1;
    }

    // Mild boost if status is active or completed
    if (job.status === 'active') score += 0.5;
    if (job.status === 'completed') score += 0.5;

    if (score > bestScore) {
      bestScore = score;
      best = job;
    }
  }

  // Require at least some minimal score to avoid bad guesses
  if (!best || bestScore < 2) return null;
  return best;
}

/**
 * Build a human-friendly message summarizing job KPIs.
 */
function formatJobKpiMessage(job) {
  const {
    name,
    status,
    created_at,
    completed_at,
    revenue_cents,
    expense_cents,
    profit_cents,
    margin_pct,
  } = job;

  const dollars = (cents) =>
    (Number(cents || 0) / 100).toLocaleString('en-CA', {
      style: 'currency',
      currency: 'CAD',
      maximumFractionDigits: 2,
    });

  const started = created_at
    ? new Date(created_at).toLocaleDateString('en-CA')
    : null;
  const finished = completed_at
    ? new Date(completed_at).toLocaleDateString('en-CA')
    : null;

  let line1 = `Job: ${name}`;
  if (status) line1 += ` (${status})`;

  const lines = [
    line1,
    '',
    `Revenue: ${dollars(revenue_cents)}`,
    `Costs:   ${dollars(expense_cents)}`,
    `Profit:  ${dollars(profit_cents)}${margin_pct != null ? ` (${margin_pct.toFixed(1)}% margin)` : ''}`,
  ];

  if (started || finished) {
    lines.push('');
    if (started && finished) {
      lines.push(`Timeline: ${started} → ${finished}`);
    } else if (started) {
      lines.push(`Started: ${started}`);
    } else if (finished) {
      lines.push(`Completed: ${finished}`);
    }
  }

  // Small coaching nudge
  if (margin_pct != null) {
    if (margin_pct < 20) {
      lines.push('', `Note: Margin is on the thin side. You might want to raise prices or tighten materials/labour on similar jobs.`);
    } else if (margin_pct >= 35 && margin_pct < 50) {
      lines.push('', `Note: Solid gross margin. This is a good benchmark for similar work.`);
    } else if (margin_pct >= 50) {
      lines.push('', `Note: Excellent margin. This is the kind of job you want more of.`);
    }
  }

  return lines.join('\n');
}

/**
 * Main entry used by webhook.js
 *
 * @param {object} params
 * @param {string} params.ownerId
 * @param {string} params.text     full user message (we'll pull job name from here)
 */
async function handleJobInsights({ ownerId, text }) {
  if (!ownerId) return `I couldn’t determine which account this belongs to.`;

  const jobs = await getOwnerJobsFinance(ownerId);
  if (!jobs || !jobs.length) {
    return `I don’t see any jobs yet. Try "create job Roof Repair" first.`;
  }

  const best = findBestJobFromText(text, jobs);
  if (!best) {
    const sampleNames = jobs.slice(0, 3).map((j) => j.name).filter(Boolean);
    const hint =
      sampleNames.length > 0
        ? `For example: "How did the ${sampleNames[0]} job do?"`
        : '';
    return `I couldn’t tell which job you meant. Try asking like: "How did the Lauren Watson job do?" ${hint}`;
  }

  return formatJobKpiMessage(best);
}

module.exports = {
  handleJobInsights,
};
