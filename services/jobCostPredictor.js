'use strict';

/**
 * services/jobCostPredictor.js
 * Phase 3.1 — Predictive Job Costing
 *
 * When a new job is created, analyzes historical completed jobs with similar names
 * and returns P25/P50/P75 cost ranges for labour, materials, and subcontractors.
 *
 * Requires at least 3 completed jobs with transaction history to generate predictions.
 */

const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }

const MIN_COMPARABLE_JOBS = 3;

function extractKeywords(jobName) {
  return String(jobName || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'job', 'project'].includes(w));
}

function similarityScore(name1, name2) {
  const kw1 = new Set(extractKeywords(name1));
  const kw2 = new Set(extractKeywords(name2));
  if (!kw1.size || !kw2.size) return 0;
  const intersection = new Set([...kw1].filter(k => kw2.has(k)));
  return intersection.size / Math.max(kw1.size, kw2.size);
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

async function predictJobCosts({ ownerId, newJobName, estimatedRevenueCents }) {
  if (!ownerId) return null;

  const jobsResult = await pool.query(`
    SELECT
      j.id,
      j.name,
      j.job_no,
      j.created_at,
      SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents ELSE 0 END)                    AS revenue,
      SUM(CASE WHEN t.kind = 'expense' AND t.category ILIKE '%labour%'
               OR t.kind = 'expense' AND t.category ILIKE '%labor%'
               THEN t.amount_cents ELSE 0 END)                                             AS labour,
      SUM(CASE WHEN t.kind = 'expense' AND t.category ILIKE '%material%'
               OR t.kind = 'expense' AND t.category ILIKE '%supply%'
               OR t.kind = 'expense' AND t.category ILIKE '%supplies%'
               THEN t.amount_cents ELSE 0 END)                                             AS materials,
      SUM(CASE WHEN t.kind = 'expense' AND t.category ILIKE '%sub%'
               THEN t.amount_cents ELSE 0 END)                                             AS subcontractors,
      SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END)                    AS total_expenses
    FROM public.jobs j
    LEFT JOIN public.transactions t ON t.job_id = j.id
    WHERE j.owner_id::text = $1
      AND j.status IN ('completed', 'archived', 'invoiced')
    GROUP BY j.id, j.name, j.job_no, j.created_at
    HAVING SUM(t.amount_cents) > 0
    ORDER BY j.created_at DESC
    LIMIT 50
  `, [String(ownerId)]).catch(() => null);

  const completedJobs = (jobsResult?.rows || []).map(r => ({
    id:             String(r.id),
    name:           r.name,
    job_no:         r.job_no,
    revenue:        toInt(r.revenue),
    labour:         toInt(r.labour),
    materials:      toInt(r.materials),
    subcontractors: toInt(r.subcontractors),
    total_expenses: toInt(r.total_expenses),
    similarity:     similarityScore(newJobName, r.name),
  }));

  if (completedJobs.length < MIN_COMPARABLE_JOBS) {
    return {
      has_prediction:   false,
      reason:           `Need at least ${MIN_COMPARABLE_JOBS} completed jobs for predictions. You have ${completedJobs.length}.`,
      comparable_count: completedJobs.length,
    };
  }

  let comparable = completedJobs.filter(j => j.similarity >= 0.15);
  if (comparable.length < MIN_COMPARABLE_JOBS) {
    if (estimatedRevenueCents) {
      comparable = completedJobs
        .map(j => ({ ...j, scaleSim: j.revenue > 0 ? 1 - Math.abs(j.revenue - estimatedRevenueCents) / Math.max(j.revenue, estimatedRevenueCents) : 0 }))
        .filter(j => j.scaleSim > 0.4)
        .sort((a, b) => b.scaleSim - a.scaleSim);
    }
  }

  if (comparable.length < MIN_COMPARABLE_JOBS) {
    comparable = completedJobs.slice(0, 10);
  }

  function pct(arr, field) {
    const vals = arr.map(j => j[field]).filter(v => v > 0).sort((a, b) => a - b);
    if (!vals.length) return { p25: null, p50: null, p75: null };
    return { p25: percentile(vals, 25), p50: percentile(vals, 50), p75: percentile(vals, 75) };
  }

  const avgRevenue = comparable.reduce((s, j) => s + j.revenue, 0) / comparable.length;
  const avgLabourPct = avgRevenue > 0
    ? Math.round((comparable.reduce((s, j) => s + j.labour, 0) / comparable.length / avgRevenue) * 100)
    : null;
  const avgMaterialsPct = avgRevenue > 0
    ? Math.round((comparable.reduce((s, j) => s + j.materials, 0) / comparable.length / avgRevenue) * 100)
    : null;

  const totalCostPct = pct(comparable, 'total_expenses');
  const outlierWarning = estimatedRevenueCents && totalCostPct.p75
    ? (estimatedRevenueCents * 0.7 > totalCostPct.p75 * 1.5
      ? 'Your estimate is significantly higher than similar past jobs. Is this a larger scope?'
      : null)
    : null;

  return {
    has_prediction:   true,
    new_job_name:     newJobName,
    comparable_count: comparable.length,
    comparable_jobs:  comparable.slice(0, 5).map(j => ({ job_no: j.job_no, name: j.name, similarity: Math.round(j.similarity * 100) })),
    predictions: {
      labour:         pct(comparable, 'labour'),
      materials:      pct(comparable, 'materials'),
      subcontractors: pct(comparable, 'subcontractors'),
      total_cost:     totalCostPct,
    },
    benchmarks: {
      avg_labour_pct_of_revenue:    avgLabourPct,
      avg_materials_pct_of_revenue: avgMaterialsPct,
    },
    outlier_warning: outlierWarning,
  };
}

async function generateCostSuggestionMessage({ ownerId, newJobName, estimatedRevenueCents }) {
  const prediction = await predictJobCosts({ ownerId, newJobName, estimatedRevenueCents });
  if (!prediction?.has_prediction) return null;

  const client = new Anthropic();
  const fmt = (cents) => cents ? `$${Math.round(cents / 100).toLocaleString()}` : null;
  const p = prediction.predictions;

  const dataLines = [
    `New job: ${newJobName}${estimatedRevenueCents ? ` (est. $${Math.round(estimatedRevenueCents / 100).toLocaleString()})` : ''}`,
    `Based on ${prediction.comparable_count} similar completed jobs:`,
    p.labour.p25    ? `Labour: ${fmt(p.labour.p25)}–${fmt(p.labour.p75)} (median ${fmt(p.labour.p50)})` : null,
    p.materials.p25 ? `Materials: ${fmt(p.materials.p25)}–${fmt(p.materials.p75)} (median ${fmt(p.materials.p50)})` : null,
    p.subcontractors.p25 ? `Subcontractors: ${fmt(p.subcontractors.p25)}–${fmt(p.subcontractors.p75)}` : null,
    p.total_cost.p50 ? `Total cost estimate: ~${fmt(p.total_cost.p50)} (range ${fmt(p.total_cost.p25)}–${fmt(p.total_cost.p75)})` : null,
    prediction.outlier_warning || null,
  ].filter(Boolean).join('\n');

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 250,
    messages:   [{ role: 'user', content: dataLines }],
    system: 'You are Chief. Write a short (3–4 sentence) WhatsApp message suggesting budget ranges for this new job based on historical data. Sound like a practical advisor. End with: "Reply with your line items and I\'ll track against these benchmarks."',
  });

  return response.content?.[0]?.text?.trim() || null;
}

module.exports = { predictJobCosts, generateCostSuggestionMessage };
