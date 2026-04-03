// api/cron/overhead_reminders.js
// Daily cron: find recurring overhead items due today, create reminder records + send WhatsApp.
// Schedule: 8:00 AM UTC daily (see vercel.json)
'use strict';

const { Pool } = require('pg');
const { sendWhatsApp } = require('../../services/twilio');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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

    const now       = new Date();
    const todayDay  = now.getDate();
    const year      = now.getFullYear();
    const month     = now.getMonth() + 1; // 1–12

    // Find active recurring items due today with no payment or reminder this period
    const { rows: dueItems } = await pool.query(`
      SELECT
        oi.id,
        oi.tenant_id,
        oi.name,
        oi.amount_cents,
        oi.tax_amount_cents,
        oi.due_day,
        tap.phone_digits
      FROM overhead_items oi
      LEFT JOIN chiefos_tenant_actor_profiles tap
        ON tap.tenant_id = oi.tenant_id
      WHERE oi.active        = true
        AND oi.item_type     = 'recurring'
        AND oi.due_day       = $1
        AND NOT EXISTS (
          SELECT 1 FROM overhead_payments op
          WHERE op.item_id      = oi.id
            AND op.period_year  = $2
            AND op.period_month = $3
        )
        AND NOT EXISTS (
          SELECT 1 FROM overhead_reminders orr
          WHERE orr.item_id      = oi.id
            AND orr.period_year  = $2
            AND orr.period_month = $3
        )
    `, [todayDay, year, month]);

    let created  = 0;
    let notified = 0;

    for (const item of dueItems) {
      // Create pending reminder
      await pool.query(`
        INSERT INTO overhead_reminders
          (tenant_id, item_id, item_name, period_year, period_month, amount_cents, tax_amount_cents, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
        ON CONFLICT (item_id, period_year, period_month) DO NOTHING
      `, [item.tenant_id, item.id, item.name, year, month, item.amount_cents, item.tax_amount_cents]);
      created++;

      // Send WhatsApp notification if phone is available
      if (item.phone_digits) {
        const totalCents = (item.amount_cents || 0) + (item.tax_amount_cents || 0);
        const totalFmt   = `$${(totalCents / 100).toFixed(2)}`;
        const taxNote    = item.tax_amount_cents ? ' incl. tax' : '';
        const msg = [
          `💳 *Payment reminder*`,
          `${item.name} is due today (${totalFmt}${taxNote}).`,
          ``,
          `Log into ChiefOS to confirm the payment was made.`,
        ].join('\n');

        try {
          await sendWhatsApp(`+${item.phone_digits}`, msg);
          await pool.query(`
            UPDATE overhead_reminders
            SET whatsapp_sent_at = NOW()
            WHERE item_id = $1 AND period_year = $2 AND period_month = $3
          `, [item.id, year, month]);
          notified++;
        } catch (e) {
          console.error('[overhead_reminders] WhatsApp send failed for item', item.id, e?.message);
        }
      }
    }

    console.log(`[overhead_reminders] ${created} reminders created, ${notified} WhatsApp sent`);

    // Phase 3.3: also run receivables nudge daily
    let receivables = { checked: 0, sent: 0 };
    try {
      const { runReceivablesNudge } = require('../../workers/receivablesNudge');
      receivables = await runReceivablesNudge();
      console.log(`[overhead_reminders] receivables nudge: ${JSON.stringify(receivables)}`);
    } catch (e) {
      console.warn('[overhead_reminders] receivablesNudge failed (non-fatal):', e?.message);
    }

    return res.status(200).json({ ok: true, created, notified, receivables, now: now.toISOString() });

  } catch (err) {
    console.error('[overhead_reminders] fatal error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
};
