'use strict';

/**
 * workers/receivablesNudge.js
 * Phase 3.3 — Receivables Intelligence & Invoice Follow-Up
 *
 * Checks for revenue entries > 30 days old with payment_status = 'pending'.
 * Sends a proactive WhatsApp nudge with an offer to draft a client follow-up.
 * Piggybacked on the overhead_reminders cron (8AM UTC daily).
 */

const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { sendQuickReply } = require('../services/twilio');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const OVERDUE_THRESHOLD_DAYS = 30;

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }

async function generateFollowUpDraft({ jobName, amountCents, daysPending, customerRef }) {
  const client = new Anthropic();

  const prompt = [
    `Job: ${jobName}`,
    `Outstanding amount: $${(amountCents / 100).toFixed(2)}`,
    `Days since invoiced: ${daysPending}`,
    customerRef ? `Client: ${customerRef}` : null,
  ].filter(Boolean).join('\n');

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages:   [{ role: 'user', content: prompt }],
    system: [
      'Write a short, professional invoice follow-up message a contractor can send to their client.',
      '2–3 sentences. Polite and direct. Reference the job and amount.',
      'Do NOT include placeholders like [Your Name] — write it in first person generically.',
      'Output the message text only.',
    ].join(' '),
  });

  return response.content?.[0]?.text?.trim() || null;
}

async function runReceivablesNudge() {
  const now = new Date();

  // Post-rebuild canonical: public.users keyed by (owner_id, role='owner')
  // (chiefos_tenant_actor_profiles DISCARDed per Decision 12).
  // user_id is the digits PK = phone_digits.
  const overdueResult = await pool.query(`
    SELECT
      t.owner_id,
      u.user_id    AS phone_digits,
      t.tenant_id,
      j.name       AS job_name,
      j.job_no,
      t.id         AS tx_id,
      t.amount_cents,
      t.date       AS revenue_date,
      t.customer_ref,
      (NOW()::date - t.date) AS days_pending
    FROM public.transactions t
    JOIN public.jobs j ON j.id = t.job_id
    JOIN public.users u ON u.owner_id = t.owner_id AND u.role = 'owner'
    WHERE t.kind           = 'revenue'
      AND COALESCE(t.payment_status, 'pending') = 'pending'
      AND t.date           <= NOW() - ($1 || ' days')::interval
    ORDER BY t.owner_id, days_pending DESC
  `, [OVERDUE_THRESHOLD_DAYS]).catch(() => null);

  const rows = overdueResult?.rows || [];
  if (!rows.length) return { checked: 0, sent: 0 };

  const byOwner = {};
  for (const r of rows) {
    if (!byOwner[r.owner_id]) {
      byOwner[r.owner_id] = { phone: r.phone_digits, tenant: r.tenant_id, items: [] };
    }
    byOwner[r.owner_id].items.push(r);
  }

  let sent = 0, errors = 0;

  for (const [ownerId, { phone, tenant, items }] of Object.entries(byOwner)) {
    try {
      const topItem = items.reduce((a, b) => (b.days_pending > a.days_pending ? b : a));
      const signalKey = `receivable_nudge_${topItem.tx_id}_${now.toISOString().slice(0, 7)}`;

      const existing = await pool.query(
        `SELECT id FROM public.insight_log WHERE owner_id = $1 AND signal_key = $2 LIMIT 1`,
        [String(ownerId), signalKey]
      ).catch(() => null);
      if (existing?.rows?.length) continue;

      const totalOverdue = items.reduce((s, r) => s + toInt(r.amount_cents), 0);
      const oldestDays   = topItem.days_pending;

      const nudge = [
        `💰 *Overdue Receivables*`,
        ``,
        `You have *${items.length} unpaid invoice${items.length > 1 ? 's' : ''}* totalling *$${(totalOverdue / 100).toFixed(2)}*.`,
        ``,
        `Oldest: *${topItem.job_name}* — $${(topItem.amount_cents / 100).toFixed(2)} is ${oldestDays} days outstanding.`,
        ``,
        `Want me to draft a follow-up message for the client?`,
      ].join('\n');

      await sendQuickReply(`+${phone}`, nudge, ['Draft Follow-up', 'Got it']);
      sent++;

      await pool.query(`
        INSERT INTO public.insight_log (tenant_id, owner_id, kind, signal_key, payload, message_text)
        VALUES ($1, $2, 'receivable_nudge', $3, $4, $5)
        ON CONFLICT (owner_id, signal_key) DO NOTHING
      `, [
        tenant, String(ownerId), signalKey,
        JSON.stringify({ count: items.length, total_cents: totalOverdue, oldest_days: oldestDays }),
        nudge,
      ]).catch(() => {});

      console.log(`[receivablesNudge] sent to ${ownerId} — ${items.length} overdue, $${(totalOverdue / 100).toFixed(2)}`);

    } catch (err) {
      errors++;
      console.error(`[receivablesNudge] error for owner ${ownerId}:`, err?.message);
    }
  }

  return { checked: Object.keys(byOwner).length, sent, errors };
}

async function sendFollowUpDraft({ ownerId, phone, jobName, amountCents, daysPending, customerRef }) {
  const draft = await generateFollowUpDraft({ jobName, amountCents, daysPending, customerRef });
  if (!draft) return false;

  const msg = `📝 *Follow-up draft for ${jobName}:*\n\n_${draft}_\n\nCopy and send this to your client.`;
  await sendQuickReply(`+${phone}`, msg, ['Mark as Paid', 'Not yet']);
  return true;
}

module.exports = { runReceivablesNudge, sendFollowUpDraft };
