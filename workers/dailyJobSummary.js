'use strict';

/**
 * workers/dailyJobSummary.js
 * Phase 1.4 — End-of-Day Job Summary
 *
 * Runs at 22:00 UTC (~6PM ET). For each job with activity today,
 * generates a professional 3–4 sentence client-forwardable site update.
 */

const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { sendQuickReply } = require('../services/twilio');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }
function todayUtc() { return new Date().toISOString().slice(0, 10); }

async function fetchTodayJobActivity(ownerId, today) {
  const txResult = await pool.query(`
    SELECT
      t.job_id,
      j.name AS job_name, j.job_no, j.status AS job_status,
      SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents ELSE 0 END) AS rev,
      SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END) AS exp,
      STRING_AGG(DISTINCT t.source, ', ')   AS vendors,
      STRING_AGG(DISTINCT t.category, ', ') AS categories
    FROM public.transactions t
    JOIN public.jobs j ON j.id = t.job_id
    WHERE t.owner_id::text = $1
      AND t.date = $2::date
      AND t.job_id IS NOT NULL
    GROUP BY t.job_id, j.name, j.job_no, j.status
  `, [String(ownerId), today]).catch(() => null);

  const timeResult = await pool.query(`
    SELECT
      te.job_id::text AS job_id,
      SUM(EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in)) / 3600.0) AS hours,
      COUNT(DISTINCT te.employee_name) AS crew_count,
      STRING_AGG(DISTINCT te.employee_name, ', ') AS crew_names
    FROM public.time_entries_v2 te
    WHERE te.owner_id::text = $1
      AND te.clock_in::date = $2::date
      AND te.job_id IS NOT NULL
    GROUP BY te.job_id
  `, [String(ownerId), today]).catch(() => null);

  const photoResult = await pool.query(`
    SELECT job_id::text AS job_id, COUNT(*) AS photo_count
    FROM public.job_photos
    WHERE owner_id::text = $1 AND taken_at::date = $2::date
    GROUP BY job_id
  `, [String(ownerId), today]).catch(() => null);

  const phaseResult = await pool.query(`
    SELECT jp.job_id::text AS job_id, jp.name AS phase_name
    FROM public.job_phases jp
    WHERE jp.status = 'in_progress'
  `).catch(() => null);

  const timeByJob  = {};
  for (const r of (timeResult?.rows || [])) {
    timeByJob[r.job_id] = { hours: Math.round(Number(r.hours) * 10) / 10, crew_count: toInt(r.crew_count), crew_names: r.crew_names };
  }
  const photoByJob = {};
  for (const r of (photoResult?.rows || [])) { photoByJob[r.job_id] = toInt(r.photo_count); }
  const phaseByJob = {};
  for (const r of (phaseResult?.rows || [])) { phaseByJob[r.job_id] = r.phase_name; }

  const jobs = [];
  const seenJobIds = new Set();

  for (const r of (txResult?.rows || [])) {
    const jobId = String(r.job_id);
    seenJobIds.add(jobId);
    jobs.push({
      job_id: jobId, job_no: r.job_no, job_name: r.job_name || `Job ${r.job_no}`, job_status: r.job_status,
      revenue: toInt(r.rev), expenses: toInt(r.exp), vendors: r.vendors || '', categories: r.categories || '',
      hours: timeByJob[jobId]?.hours || 0, crew_count: timeByJob[jobId]?.crew_count || 0,
      crew_names: timeByJob[jobId]?.crew_names || '', photos: photoByJob[jobId] || 0,
      phase: phaseByJob[jobId] || null,
    });
  }

  for (const r of (timeResult?.rows || [])) {
    if (seenJobIds.has(r.job_id)) continue;
    const jobRow = await pool.query(
      `SELECT name, job_no, status FROM public.jobs WHERE id = $1 LIMIT 1`, [r.job_id]
    ).catch(() => null);
    const job = jobRow?.rows?.[0];
    if (!job) continue;
    jobs.push({
      job_id: r.job_id, job_no: job.job_no, job_name: job.name || `Job ${job.job_no}`, job_status: job.status,
      revenue: 0, expenses: 0, vendors: '', categories: '',
      hours: Math.round(Number(r.hours) * 10) / 10, crew_count: toInt(r.crew_count),
      crew_names: r.crew_names || '', photos: photoByJob[r.job_id] || 0, phase: phaseByJob[r.job_id] || null,
    });
  }

  return jobs;
}

async function generateJobSummary(activity, today) {
  const client = new Anthropic();

  const dataLines = [
    `Job: ${activity.job_name}${activity.phase ? ` — Phase: ${activity.phase}` : ''}`,
    `Date: ${today}`,
    activity.hours    ? `Hours on site: ${activity.hours}h (${activity.crew_count} crew: ${activity.crew_names})` : null,
    activity.expenses ? `Materials purchased: $${(activity.expenses / 100).toFixed(2)} from ${activity.vendors || 'various'}` : null,
    activity.revenue  ? `Revenue logged: $${(activity.revenue / 100).toFixed(2)}` : null,
    activity.photos   ? `Photos taken: ${activity.photos}` : null,
    activity.categories ? `Activity categories: ${activity.categories}` : null,
  ].filter(Boolean).join('\n');

  const system = [
    'You are generating a professional end-of-day site update for a contractor to send to their client.',
    'Write 3–4 sentences. Describe what was accomplished today: materials used, hours on site, notable progress.',
    'Professional but readable — no jargon. Past tense. First person plural ("we", "the crew").',
    'Do NOT include pricing or internal cost information.',
    'Output the update text only — no subject line, no header.',
  ].join(' ');

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages:   [{ role: 'user', content: dataLines }],
    system,
  });

  return response.content?.[0]?.text?.trim() || '';
}

async function runDailyJobSummary() {
  const today = todayUtc();

  // Post-rebuild canonical owner registry: public.users
  // (chiefos_tenant_actor_profiles DISCARDed per Decision 12).
  // user_id is the digits PK = phone_digits.
  const ownersResult = await pool.query(`
    SELECT owner_id, user_id AS phone_digits, tenant_id
      FROM public.users
     WHERE role = 'owner'
  `).catch(() => null);

  const owners = ownersResult?.rows || [];
  let processed = 0, sent = 0, errors = 0;

  for (const owner of owners) {
    try {
      const activities = await fetchTodayJobActivity(owner.owner_id, today);
      if (!activities.length) continue;

      for (const activity of activities) {
        if (activity.hours < 0.5 && (activity.expenses + activity.revenue) < 5000) continue;

        const signalKey = `daily_summary_${activity.job_id}_${today}`;

        const existing = await pool.query(
          `SELECT id FROM public.insight_log WHERE owner_id = $1 AND signal_key = $2 LIMIT 1`,
          [String(owner.owner_id), signalKey]
        ).catch(() => null);
        if (existing?.rows?.length) continue;

        processed++;

        const summary = await generateJobSummary(activity, today);
        if (!summary) continue;

        const header = `📋 *Daily Site Update — ${activity.job_name}*\n\n`;
        const fullMessage = header + summary + `\n\n_Reply "Forward" to send this to your client._`;

        await sendQuickReply(`+${owner.phone_digits}`, fullMessage, ['Forward to Client', 'Got it']);
        sent++;

        await pool.query(`
          INSERT INTO public.insight_log (tenant_id, owner_id, kind, signal_key, payload, message_text)
          VALUES ($1, $2, 'daily_summary', $3, $4, $5)
          ON CONFLICT (owner_id, signal_key) DO NOTHING
        `, [owner.tenant_id, String(owner.owner_id), signalKey, JSON.stringify(activity), fullMessage])
          .catch(e => console.error('[dailyJobSummary] insight_log insert failed:', e?.message));

        console.log(`[dailyJobSummary] sent for job ${activity.job_no} owner ${owner.owner_id}`);
      }
    } catch (err) {
      errors++;
      console.error(`[dailyJobSummary] error for owner ${owner.owner_id}:`, err?.message);
    }
  }

  return { processed, sent, errors };
}

module.exports = { runDailyJobSummary };
