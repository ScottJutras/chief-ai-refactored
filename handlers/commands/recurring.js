'use strict';

/**
 * handlers/commands/recurring.js
 * Recurring / overhead expense management.
 *
 * Supported commands (owner-only):
 *   recurring $200/month storage unit
 *   recurring $85/week truck payment
 *   recurring $1200/quarter insurance
 *   recurring $500/year software
 *   list recurring
 *   stop recurring [name]
 *
 * Writes to public.overhead_items (upsert by name).
 * Idempotent: ON CONFLICT (owner_id, source_msg_id).
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function RESP(t) {
  const s = String(t ?? '').trim();
  if (!s) return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  const e = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${e}</Message></Response>`;
}

function DIGITS(x) {
  return String(x ?? '').replace(/^whatsapp:/i,'').replace(/^\+/,'').replace(/\D/g,'');
}

const FREQ_MAP = {
  month: 'monthly', monthly: 'monthly',
  week:  'weekly',  weekly:  'weekly',
  quarter: 'quarterly', quarterly: 'quarterly',
  year: 'annual', annual: 'annual', annually: 'annual',
};

/**
 * Parse "recurring $200/month storage unit" → { amountCents, frequency, name }
 * Returns null if not a match.
 */
function parseRecurring(text) {
  const s = String(text || '').trim();

  const m = s.match(
    /^recurring\s+\$?([\d]+(?:\.[\d]{1,2})?)\s*\/\s*(month|monthly|week|weekly|quarter|quarterly|year|annual|annually)\s+(.+)$/i
  );
  if (!m) return null;

  const amount = parseFloat(m[1]);
  const freq   = FREQ_MAP[m[2].toLowerCase()] || 'monthly';
  const name   = m[3].trim();
  if (!name || amount <= 0) return null;

  return { amountCents: Math.round(amount * 100), frequency: freq, name };
}

function parseStopRecurring(text) {
  const m = String(text || '').trim().match(/^stop\s+recurring\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function isListRecurring(text) {
  return /^(list|show)\s+recurring\b/i.test(String(text || '').trim());
}

function isRecurringCommand(text) {
  const s = String(text || '').trim().toLowerCase();
  return /^recurring\b/.test(s) || /^stop\s+recurring\b/.test(s) || /^(list|show)\s+recurring\b/.test(s);
}

async function resolveTenantId(ownerId) {
  try {
    const r = await pool.query(
      `SELECT id FROM public.chiefos_tenants
       WHERE regexp_replace(coalesce(owner_id,''), '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g')
       ORDER BY created_at ASC LIMIT 1`,
      [String(ownerId)]
    );
    return r?.rows?.[0]?.id ?? null;
  } catch { return null; }
}

function nextDueDate(frequency) {
  const d = new Date();
  switch (frequency) {
    case 'weekly':    d.setUTCDate(d.getUTCDate() + 7);   break;
    case 'monthly':   d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'quarterly': d.setUTCMonth(d.getUTCMonth() + 3); break;
    case 'annual':    d.setUTCFullYear(d.getUTCFullYear() + 1); break;
  }
  return d.toISOString().slice(0, 10);
}

function freqLabel(f) {
  return { monthly:'month', weekly:'week', quarterly:'quarter', annual:'year' }[f] || f;
}

async function handleRecurring(from, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId) {
  if (!isRecurringCommand(text)) return false;

  if (!isOwner) {
    res.send(RESP('Only the Owner can manage recurring expenses.'));
    return true;
  }

  const owner = DIGITS(String(ownerId || from || ''));
  if (!owner) { res.send(RESP('Unable to identify your account.')); return true; }

  // ── LIST ──────────────────────────────────────────────────────────────────
  if (isListRecurring(text)) {
    try {
      const rows = await pool.query(
        `SELECT name, frequency, amount_cents FROM public.overhead_items
         WHERE owner_id = $1 AND active = true
         ORDER BY name`,
        [owner]
      );
      if (!rows?.rows?.length) {
        res.send(RESP(`No recurring expenses set.\n\nAdd one like:\nrecurring $200/month storage unit`));
        return true;
      }
      const list = rows.rows.map(r =>
        `• ${r.name}: $${(r.amount_cents / 100).toFixed(0)}/${freqLabel(r.frequency)}`
      ).join('\n');
      res.send(RESP(`📋 Recurring expenses:\n\n${list}\n\nTo stop one: stop recurring [name]`));
    } catch (e) {
      res.send(RESP('Could not load recurring expenses. Try again.'));
    }
    return true;
  }

  // ── STOP ─────────────────────────────────────────────────────────────────
  const stopName = parseStopRecurring(text);
  if (stopName) {
    try {
      const r = await pool.query(
        `UPDATE public.overhead_items SET active = false, updated_at = now()
         WHERE owner_id = $1 AND LOWER(name) LIKE LOWER($2) AND active = true
         RETURNING name`,
        [owner, `%${stopName}%`]
      );
      if (r?.rows?.length) {
        res.send(RESP(`✅ Stopped recurring expense: "${r.rows[0].name}"`));
      } else {
        res.send(RESP(`No active recurring expense found matching "${stopName}".`));
      }
    } catch (e) {
      res.send(RESP('Could not stop that recurring expense. Try again.'));
    }
    return true;
  }

  // ── CREATE ────────────────────────────────────────────────────────────────
  const parsed = parseRecurring(text);
  if (!parsed) {
    res.send(RESP(
      'Usage: recurring $[amount]/[frequency] [name]\n\n' +
      'Examples:\n' +
      '• recurring $200/month storage unit\n' +
      '• recurring $85/week truck payment\n' +
      '• recurring $1200/quarter insurance'
    ));
    return true;
  }

  try {
    const tenantId = await resolveTenantId(owner);
    if (!tenantId) { res.send(RESP('Unable to resolve workspace. Try again.')); return true; }

    const nextDue = nextDueDate(parsed.frequency);
    const msgId = sourceMsgId || null;

    await pool.query(
      `INSERT INTO public.overhead_items
         (tenant_id, owner_id, name, frequency, amount_cents, category, next_due_at, source_msg_id)
       VALUES ($1, $2, $3, $4, $5, 'Overhead', $6, $7)
       ON CONFLICT (owner_id, source_msg_id) WHERE source_msg_id IS NOT NULL
       DO UPDATE SET
         name         = EXCLUDED.name,
         frequency    = EXCLUDED.frequency,
         amount_cents = EXCLUDED.amount_cents,
         next_due_at  = EXCLUDED.next_due_at,
         active       = true,
         updated_at   = now()`,
      [tenantId, owner, parsed.name, parsed.frequency, parsed.amountCents, nextDue, msgId]
    );

    const fmtAmt = `$${(parsed.amountCents / 100).toFixed(0)}`;
    res.send(RESP(
      `✅ Recurring expense set:\n` +
      `${parsed.name} — ${fmtAmt}/${freqLabel(parsed.frequency)}\n\n` +
      `I'll remind you each ${freqLabel(parsed.frequency)} to confirm it.\n\n` +
      `To see all recurring: list recurring\n` +
      `To stop it: stop recurring ${parsed.name}`
    ));
  } catch (e) {
    console.error('[recurring] error:', e?.message);
    res.send(RESP('Could not save recurring expense. Try again.'));
  }

  return true;
}

module.exports = { handleRecurring, isRecurringCommand };
