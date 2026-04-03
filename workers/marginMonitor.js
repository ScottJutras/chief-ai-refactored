'use strict';

/**
 * workers/marginMonitor.js
 * Phase 1.3 — Smart Margin Alert
 *
 * Runs every 6 hours. For each active job whose margin has fallen below the
 * threshold (default 20%), or is declining rapidly, sends a WhatsApp alert —
 * at most once every 7 days per job.
 */

const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { sendQuickReply } = require('../services/twilio');
const { computeJobPnl } = require('../services/agentTools/jobPnl');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DEFAULT_THRESHOLD_PCT = 20;
const ALERT_COOLDOWN_DAYS   = 7;
const TREND_DROP_THRESHOLD  = 10;

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }

async function getMarginThreshold(tenantId) {
  try {
    const r = await pool.query(
      `SELECT settings FROM public.chiefos_tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    const settings = r?.rows?.[0]?.settings;
    if (settings?.margin_alert_threshold_pct != null) {
      return Number(settings.margin_alert_threshold_pct);
    }
  } catch { /* use default */ }
  return DEFAULT_THRESHOLD_PCT;
}

async function marginSevenDaysAgo(ownerId, jobId) {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
    const dateTo = sevenDaysAgo.toISOString().slice(0, 10);

    const r = await pool.query(`
      SELECT
        SUM(CASE WHEN kind = 'revenue' THEN amount_cents ELSE 0 END) AS rev,
        SUM(CASE WHEN kind = 'expense' THEN amount_cents ELSE 0 END) AS exp
      FROM public.transactions
      WHERE owner_id::text = $1
        AND job_id::text   = $2
        AND date           <= $3::date
    `, [String(ownerId), String(jobId), dateTo]);

    const rev = toInt(r?.rows?.[0]?.rev);
    const exp = toInt(r?.rows?.[0]?.exp);
    if (!rev) return null;
    return Math.round(((rev - exp) / rev) * 100);
  } catch { return null; }
}

async function generateMarginAlert(pnl, threshold, prevMargin) {
  const client = new Anthropic();

  const trendNote = prevMargin !== null ? `7 days ago the margin was ${prevMargin}%.` : '';

  const topExpenses = Object.entries(pnl.expenses_by_category || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([cat, cents]) => `${cat} $${(cents / 100).toFixed(0)}`).join(', ');

  const prompt = [
    `Job: ${pnl.job_name || `Job ${pnl.job_no}`}`,
    `Current margin: ${pnl.margin_pct}% (threshold: ${threshold}%)`,
    trendNote,
    `Revenue to date: $${(pnl.revenue_cents / 100).toFixed(2)}`,
    `Total costs: $${(pnl.expense_cents / 100).toFixed(2)}`,
    `Top expense categories: ${topExpenses || 'n/a'}`,
    `Labour: $${(pnl.labour_cents / 100).toFixed(2)}`,
  ].filter(Boolean).join('\n');

  const system = [
    'You are Chief, a plain-language CFO for contractors.',
    'Write a short (3–4 sentence) WhatsApp alert about this job\'s margin problem.',
    'Be specific and direct. Name the job. Name the margin. Name what\'s eating into it.',
    'End with one concrete action the contractor can take.',
    'Tone: trusted advisor, not alarmist. Use *bold* for the job name only.',
  ].join(' ');

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 250,
    messages:   [{ role: 'user', content: prompt }],
    system,
  });

  return response.content?.[0]?.text?.trim() || '';
}

async function runMarginMonitor() {
  const now   = new Date();
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const jobsResult = await pool.query(`
    SELECT
      j.id, j.job_no, j.name, j.owner_id,
      tap.phone_digits, tap.tenant_id
    FROM public.jobs j
    JOIN public.chiefos_tenant_actor_profiles tap
      ON tap.owner_id::text = j.owner_id::text
    WHERE j.status NOT IN ('archived', 'cancelled', 'completed')
      AND tap.phone_digits IS NOT NULL
      AND tap.phone_digits != ''
  `).catch(() => null);

  const jobs = jobsResult?.rows || [];
  let checked = 0, alerted = 0, errors = 0;

  for (const job of jobs) {
    try {
      checked++;
      const threshold = await getMarginThreshold(job.tenant_id);

      const pnl = await computeJobPnl({ ownerId: String(job.owner_id), jobId: String(job.id) });
      if (pnl.error || pnl.margin_pct === null) continue;
      if (pnl.revenue_cents < 10000) continue;

      const prevMargin = await marginSevenDaysAgo(job.owner_id, job.id);
      const trendDrop  = prevMargin !== null ? (prevMargin - pnl.margin_pct) : 0;

      const belowThreshold = pnl.margin_pct < threshold;
      const rapidDrop      = trendDrop >= TREND_DROP_THRESHOLD && pnl.margin_pct < (threshold + 15);

      if (!belowThreshold && !rapidDrop) continue;

      const signalKey = rapidDrop && !belowThreshold
        ? `margin_trend_${job.id}_${year}_${String(now.getUTCMonth() + 1).padStart(2,'0')}_w${Math.ceil(now.getUTCDate()/7)}`
        : `margin_alert_${job.id}_${year}_${String(month).padStart(2,'0')}`;

      const existing = await pool.query(
        `SELECT sent_at FROM public.insight_log WHERE owner_id = $1 AND signal_key = $2 LIMIT 1`,
        [String(job.owner_id), signalKey]
      ).catch(() => null);

      if (existing?.rows?.length) {
        const sentAt = new Date(existing.rows[0].sent_at);
        const daysSince = (now - sentAt) / 86400000;
        if (daysSince < ALERT_COOLDOWN_DAYS) continue;
      }

      const alertText = await generateMarginAlert(pnl, threshold, prevMargin);
      if (!alertText) continue;

      const prefix = rapidDrop && !belowThreshold ? `⚠️ *Margin Trend Alert*\n\n` : `🔴 *Low Margin Alert*\n\n`;
      const fullMessage = prefix + alertText;

      await sendQuickReply(`+${job.phone_digits}`, fullMessage, ['View Breakdown', 'Got it']);
      alerted++;

      await pool.query(`
        INSERT INTO public.insight_log (tenant_id, owner_id, kind, signal_key, payload, message_text)
        VALUES ($1, $2, 'margin_alert', $3, $4, $5)
        ON CONFLICT (owner_id, signal_key) DO UPDATE SET
          sent_at = NOW(), message_text = EXCLUDED.message_text, payload = EXCLUDED.payload
      `, [
        job.tenant_id, String(job.owner_id), signalKey,
        JSON.stringify({ job_id: job.id, job_no: job.job_no, margin_pct: pnl.margin_pct, prev_margin: prevMargin, threshold }),
        fullMessage,
      ]).catch(e => console.error('[marginMonitor] insight_log insert failed:', e?.message));

      console.log(`[marginMonitor] alerted owner ${job.owner_id} for job ${job.job_no} — margin ${pnl.margin_pct}%`);

    } catch (err) {
      errors++;
      console.error(`[marginMonitor] error for job ${job.id}:`, err?.message);
    }
  }

  return { checked, alerted, errors };
}

module.exports = { runMarginMonitor };
