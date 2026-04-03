'use strict';

/**
 * services/anomalyDetector.js
 * Phase 2.1 — Anomaly Detection & Proactive Flagging
 *
 * Three detection functions (deterministic SQL — no LLM for detection):
 *   1. Vendor price anomaly  — new tx > avg + 2.5σ for that vendor
 *   2. Category spend spike  — MTD spend > 150% of trailing 3-month monthly average
 *   3. Revenue/expense imbalance — active job expenses > 80% of total quoted revenue
 *
 * LLM (Haiku) only generates the human-readable alert text.
 * Rate limit: max 3 anomaly alerts per day per tenant.
 */

const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { sendWhatsApp } = require('./twilio');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const MAX_ALERTS_PER_DAY   = 3;
const VENDOR_SIGMA_THRESHOLD = 2.5;
const CATEGORY_SPIKE_RATIO   = 1.5;
const JOB_EXPENSE_RATIO      = 0.80;

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }
function fmt(cents) { return `$${(Math.abs(cents) / 100).toFixed(2)}`; }

async function detectVendorAnomalies(ownerId) {
  const result = await pool.query(`
    WITH vendor_stats AS (
      SELECT
        source                               AS vendor,
        AVG(amount_cents)                    AS avg_90d,
        STDDEV(amount_cents)                 AS stddev_90d,
        COUNT(*)                             AS tx_count
      FROM public.transactions
      WHERE owner_id::text = $1
        AND kind           = 'expense'
        AND date           >= NOW() - INTERVAL '90 days'
      GROUP BY source
      HAVING COUNT(*) >= 3
    ),
    recent_tx AS (
      SELECT
        t.id,
        t.source        AS vendor,
        t.amount_cents,
        t.date,
        t.description
      FROM public.transactions t
      WHERE t.owner_id::text = $1
        AND t.kind           = 'expense'
        AND t.date           >= NOW() - INTERVAL '3 days'
    )
    SELECT
      rt.id,
      rt.vendor,
      rt.amount_cents,
      rt.date,
      rt.description,
      vs.avg_90d,
      vs.stddev_90d,
      ROUND(rt.amount_cents / NULLIF(vs.avg_90d, 0), 2) AS ratio
    FROM recent_tx rt
    JOIN vendor_stats vs ON vs.vendor = rt.vendor
    WHERE rt.amount_cents > (vs.avg_90d + $2 * COALESCE(vs.stddev_90d, vs.avg_90d * 0.3))
    ORDER BY ratio DESC
    LIMIT 5
  `, [String(ownerId), VENDOR_SIGMA_THRESHOLD]).catch(() => null);

  return (result?.rows || []).map(r => ({
    type:         'vendor_price',
    vendor:       r.vendor,
    amount_cents: toInt(r.amount_cents),
    avg_cents:    Math.round(Number(r.avg_90d)),
    ratio:        Number(r.ratio),
    date:         r.date,
    description:  r.description,
    tx_id:        r.id,
  }));
}

async function detectCategorySpikes(ownerId) {
  const now     = new Date();
  const year    = now.getUTCFullYear();
  const month   = now.getUTCMonth() + 1;
  const mtdFrom = `${year}-${String(month).padStart(2, '0')}-01`;

  const result = await pool.query(`
    WITH monthly_avg AS (
      SELECT
        category,
        AVG(monthly_total)  AS avg_monthly,
        COUNT(*)            AS months
      FROM (
        SELECT
          category,
          DATE_TRUNC('month', date)  AS mo,
          SUM(amount_cents)          AS monthly_total
        FROM public.transactions
        WHERE owner_id::text = $1
          AND kind           = 'expense'
          AND date           >= NOW() - INTERVAL '3 months'
          AND date           < $2::date
        GROUP BY category, mo
      ) sub
      GROUP BY category
      HAVING COUNT(*) >= 2
    ),
    mtd AS (
      SELECT
        category,
        SUM(amount_cents) AS mtd_total
      FROM public.transactions
      WHERE owner_id::text = $1
        AND kind           = 'expense'
        AND date           >= $2::date
      GROUP BY category
    )
    SELECT
      m.category,
      m.mtd_total,
      ma.avg_monthly,
      ROUND(m.mtd_total::numeric / NULLIF(ma.avg_monthly, 0), 2) AS ratio
    FROM mtd m
    JOIN monthly_avg ma ON ma.category = m.category
    WHERE m.mtd_total > ma.avg_monthly * $3
    ORDER BY ratio DESC
    LIMIT 5
  `, [String(ownerId), mtdFrom, CATEGORY_SPIKE_RATIO]).catch(() => null);

  return (result?.rows || []).map(r => ({
    type:      'category_spike',
    category:  r.category,
    mtd_cents: toInt(r.mtd_total),
    avg_cents: Math.round(Number(r.avg_monthly)),
    ratio:     Number(r.ratio),
  }));
}

async function detectJobImbalances(ownerId) {
  const result = await pool.query(`
    WITH job_totals AS (
      SELECT
        j.id,
        j.job_no,
        j.name,
        j.quoted_revenue_cents,
        SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents ELSE 0 END) AS rev_actual,
        SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END) AS exp_actual
      FROM public.jobs j
      LEFT JOIN public.transactions t ON t.job_id = j.id
      WHERE j.owner_id::text = $1
        AND j.status NOT IN ('archived', 'cancelled', 'completed')
      GROUP BY j.id, j.job_no, j.name, j.quoted_revenue_cents
    )
    SELECT
      id,
      job_no,
      name,
      quoted_revenue_cents,
      rev_actual,
      exp_actual,
      ROUND(exp_actual::numeric / NULLIF(quoted_revenue_cents, 0), 2) AS expense_ratio
    FROM job_totals
    WHERE quoted_revenue_cents > 0
      AND exp_actual > (quoted_revenue_cents * $2)
      AND rev_actual < (quoted_revenue_cents * 0.9)
    ORDER BY expense_ratio DESC
    LIMIT 3
  `, [String(ownerId), JOB_EXPENSE_RATIO]).catch(() => null);

  return (result?.rows || []).map(r => ({
    type:         'job_imbalance',
    job_id:       String(r.id),
    job_no:       r.job_no,
    job_name:     r.name,
    quoted_cents: toInt(r.quoted_revenue_cents),
    rev_cents:    toInt(r.rev_actual),
    exp_cents:    toInt(r.exp_actual),
    ratio:        Number(r.expense_ratio),
  }));
}

async function generateAnomalyMessage(anomalies) {
  const client = new Anthropic();

  const lines = anomalies.map(a => {
    if (a.type === 'vendor_price') {
      return `Vendor price anomaly: ${a.vendor} charged ${fmt(a.amount_cents)} — ${a.ratio.toFixed(1)}x your usual spend of ${fmt(a.avg_cents)}`;
    }
    if (a.type === 'category_spike') {
      return `Category spike: ${a.category} is ${fmt(a.mtd_cents)} this month (${a.ratio.toFixed(1)}x your usual ${fmt(a.avg_cents)}/month)`;
    }
    if (a.type === 'job_imbalance') {
      return `Job ${a.job_no} (${a.job_name}): expenses are ${(a.ratio * 100).toFixed(0)}% of quoted revenue ${fmt(a.quoted_cents)} — ${fmt(a.exp_cents)} spent, only ${fmt(a.rev_cents)} logged`;
    }
    return null;
  }).filter(Boolean).join('\n');

  const system = [
    'You are Chief, a plain-language CFO for contractors.',
    'Write a short (3–5 sentence total) WhatsApp message about these financial anomalies.',
    'Be specific. Name the vendor, category, or job. Ask if it was intentional or possibly an error.',
    'Use *bold* only for key figures. Conversational, not alarming.',
  ].join(' ');

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages:   [{ role: 'user', content: lines }],
    system,
  });

  return response.content?.[0]?.text?.trim() || '';
}

async function runAnomalyDetectionForOwner({ ownerId, tenantId, phoneDigits }) {
  const today = new Date().toISOString().slice(0, 10);

  const countResult = await pool.query(`
    SELECT COUNT(*) AS cnt
    FROM public.insight_log
    WHERE owner_id = $1
      AND kind     = 'anomaly'
      AND sent_at::date = $2::date
  `, [String(ownerId), today]).catch(() => null);

  const sentToday = toInt(countResult?.rows?.[0]?.cnt);
  if (sentToday >= MAX_ALERTS_PER_DAY) {
    return { anomalies: 0, sent: false };
  }

  const [vendorAnomalies, categorySpikes, jobImbalances] = await Promise.all([
    detectVendorAnomalies(ownerId),
    detectCategorySpikes(ownerId),
    detectJobImbalances(ownerId),
  ]);

  const allAnomalies = [...vendorAnomalies, ...categorySpikes, ...jobImbalances];
  if (!allAnomalies.length) return { anomalies: 0, sent: false };

  const newAnomalies = [];
  for (const a of allAnomalies) {
    const signalKey = a.type === 'vendor_price'   ? `anomaly_vendor_${a.vendor}_${today}`
                    : a.type === 'category_spike' ? `anomaly_cat_${a.category}_${today}`
                    : `anomaly_job_${a.job_id}_${today}`;

    const existing = await pool.query(
      `SELECT id FROM public.insight_log WHERE owner_id = $1 AND signal_key = $2 LIMIT 1`,
      [String(ownerId), signalKey]
    ).catch(() => null);

    if (!existing?.rows?.length) {
      newAnomalies.push({ ...a, signalKey });
    }
  }

  if (!newAnomalies.length) return { anomalies: 0, sent: false };

  const toSend = newAnomalies.slice(0, MAX_ALERTS_PER_DAY - sentToday);

  const message = await generateAnomalyMessage(toSend);
  if (!message) return { anomalies: 0, sent: false };

  const fullMessage = `🔍 *Chief Spotted Something*\n\n${message}`;
  await sendWhatsApp(`+${phoneDigits}`, fullMessage);

  for (const a of toSend) {
    await pool.query(`
      INSERT INTO public.insight_log
        (tenant_id, owner_id, kind, signal_key, payload, message_text)
      VALUES ($1, $2, 'anomaly', $3, $4, $5)
      ON CONFLICT (owner_id, signal_key) DO NOTHING
    `, [
      tenantId,
      String(ownerId),
      a.signalKey,
      JSON.stringify(a),
      fullMessage,
    ]).catch(e => console.error('[anomalyDetector] insight_log insert failed:', e?.message));
  }

  return { anomalies: toSend.length, sent: true };
}

async function runAnomalyDetection() {
  const ownersResult = await pool.query(`
    SELECT DISTINCT owner_id, phone_digits, tenant_id
    FROM public.chiefos_tenant_actor_profiles
    WHERE phone_digits IS NOT NULL AND phone_digits != ''
  `).catch(() => null);

  const owners = ownersResult?.rows || [];
  let totalAnomalies = 0, ownersSent = 0, errors = 0;

  for (const owner of owners) {
    try {
      const r = await runAnomalyDetectionForOwner({
        ownerId:     owner.owner_id,
        tenantId:    owner.tenant_id,
        phoneDigits: owner.phone_digits,
      });
      totalAnomalies += r.anomalies;
      if (r.sent) ownersSent++;
    } catch (err) {
      errors++;
      console.error(`[anomalyDetector] error for owner ${owner.owner_id}:`, err?.message);
    }
  }

  return { totalAnomalies, ownersSent, errors };
}

module.exports = {
  runAnomalyDetection,
  runAnomalyDetectionForOwner,
  detectVendorAnomalies,
  detectCategorySpikes,
  detectJobImbalances,
};
