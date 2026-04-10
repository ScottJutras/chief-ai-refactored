// api/cron/overhead_reminders.js
// Daily cron: find recurring overhead items due today (or overdue), send WhatsApp reminder,
// create overhead_reminders record, then advance next_due_at to the next period.
// Schedule: 8:00 AM UTC daily (see vercel.json)
'use strict';

const { Pool } = require('pg');
const { sendWhatsApp } = require('../../services/twilio');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function advanceNextDue(currentDate, frequency) {
  const d = new Date(currentDate);
  switch (frequency) {
    case 'weekly':    d.setUTCDate(d.getUTCDate() + 7);   break;
    case 'monthly':   d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'quarterly': d.setUTCMonth(d.getUTCMonth() + 3); break;
    case 'annual':    d.setUTCFullYear(d.getUTCFullYear() + 1); break;
    default:          d.setUTCMonth(d.getUTCMonth() + 1); break;
  }
  return d.toISOString().slice(0, 10);
}

function freqLabel(f) {
  return { monthly: 'month', weekly: 'week', quarterly: 'quarter', annual: 'year' }[f] || f;
}

// period key so dedup works across frequencies: YYYY-WW for weekly, YYYY-MM for monthly/quarterly/annual
function periodKey(date, frequency) {
  const d = new Date(date);
  if (frequency === 'weekly') {
    // ISO week number
    const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d - jan1) / 86400000 + jan1.getUTCDay() + 1) / 7);
    return { year: d.getUTCFullYear(), month: week }; // re-use month column as week number for weekly
  }
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    // Auth: Vercel cron sends X-Vercel-Cron: 1; manual calls need CRON_SECRET
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const provided = req.headers['x-cron-secret'] || req.query?.secret || '';
    const expected  = process.env.CRON_SECRET || '';
    if (!isVercelCron && (!expected || provided !== expected)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Find active recurring items due today or overdue (next_due_at <= today)
    const { rows: dueItems } = await pool.query(`
      SELECT
        oi.id,
        oi.tenant_id,
        oi.owner_id,
        oi.name,
        oi.amount_cents,
        oi.tax_amount_cents,
        oi.frequency,
        oi.next_due_at
      FROM public.overhead_items oi
      WHERE oi.active       = true
        AND oi.next_due_at <= $1
    `, [today]);

    let created  = 0;
    let notified = 0;
    let advanced = 0;

    for (const item of dueItems) {
      const { year, month: periodMonth } = periodKey(item.next_due_at || today, item.frequency);

      // Check if reminder already created this period
      const existing = await pool.query(`
        SELECT id FROM public.overhead_reminders
        WHERE item_id      = $1
          AND period_year  = $2
          AND period_month = $3
        LIMIT 1
      `, [item.id, year, periodMonth]).catch(() => null);

      if (!existing?.rows?.length) {
        // Create pending reminder record
        await pool.query(`
          INSERT INTO public.overhead_reminders
            (tenant_id, item_id, item_name, period_year, period_month, amount_cents, tax_amount_cents, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
          ON CONFLICT (item_id, period_year, period_month) DO NOTHING
        `, [item.tenant_id, item.id, item.name, year, periodMonth, item.amount_cents, item.tax_amount_cents]);
        created++;
      }

      // owner_id is already the digits (e.g. "15551234567")
      const phoneDigits = String(item.owner_id || '').replace(/\D/g, '');
      if (phoneDigits) {
        const totalCents = (item.amount_cents || 0) + (item.tax_amount_cents || 0);
        const totalFmt   = `$${(totalCents / 100).toFixed(0)}`;
        const taxNote    = item.tax_amount_cents ? ' (incl. tax)' : '';
        const freqWord   = freqLabel(item.frequency);
        const msg = [
          `💳 Overhead reminder`,
          `${item.name} — ${totalFmt}/${freqWord}${taxNote} is due today.`,
          ``,
          `Reply "paid ${item.name}" to confirm, or "list recurring" to see all.`,
        ].join('\n');

        try {
          await sendWhatsApp(`whatsapp:+${phoneDigits}`, msg);
          await pool.query(`
            UPDATE public.overhead_reminders
            SET whatsapp_sent_at = NOW(), status = 'sent'
            WHERE item_id = $1 AND period_year = $2 AND period_month = $3
          `, [item.id, year, periodMonth]);
          notified++;
        } catch (e) {
          console.error('[overhead_reminders] WhatsApp send failed for item', item.id, e?.message);
        }
      }

      // Advance next_due_at to the next period
      const nextDue = advanceNextDue(item.next_due_at || today, item.frequency);
      await pool.query(`
        UPDATE public.overhead_items
        SET next_due_at = $1, updated_at = NOW()
        WHERE id = $2
      `, [nextDue, item.id]);
      advanced++;
    }

    console.log(`[overhead_reminders] ${created} reminders created, ${notified} WhatsApp sent, ${advanced} items advanced`);

    // Also run receivables nudge daily
    let receivables = { checked: 0, sent: 0 };
    try {
      const { runReceivablesNudge } = require('../../workers/receivablesNudge');
      receivables = await runReceivablesNudge();
      console.log(`[overhead_reminders] receivables nudge: ${JSON.stringify(receivables)}`);
    } catch (e) {
      console.warn('[overhead_reminders] receivablesNudge failed (non-fatal):', e?.message);
    }

    return res.status(200).json({ ok: true, created, notified, advanced, receivables, today });

  } catch (err) {
    console.error('[overhead_reminders] fatal error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
};
