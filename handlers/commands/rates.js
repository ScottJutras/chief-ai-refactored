'use strict';

/**
 * handlers/commands/rates.js
 * Owner command: set hourly cost rates per employee (internal cost, not visible to crew).
 *
 * Supported commands:
 *   set rate John $28/hour
 *   set rate John $28/hr
 *   set my rate $45/hour       (owner sets their own rate)
 *   set my rate $45/hr
 *
 * Writes to chiefos_crew_rates using owner_id + employee_name.
 * Idempotent: upserts on (owner_id, employee_name, effective_from).
 * Plan gate: Starter+ only (rates are a financial intelligence feature).
 */

const { Pool } = require('pg');
const { getEffectivePlanFromOwner } = require('../../src/config/effectivePlan');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function RESP(t) {
  const s = String(t ?? '').trim();
  if (!s) return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  const esc = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc}</Message></Response>`;
}

function DIGITS(x) {
  return String(x ?? '').replace(/^whatsapp:/i, '').replace(/^\+/, '').replace(/\D/g, '');
}

/**
 * Parse "set rate [name] $X/hour" or "set my rate $X/hour"
 * Returns { employeeName: string, ratePerHour: number } or null.
 */
function parseSetRate(text) {
  const s = String(text || '').trim();

  // "set my rate $45/hour" or "set my rate 45/hr"
  const mySelf = s.match(/^set\s+my\s+rate\s+\$?([\d]+(?:\.[\d]{1,2})?)\s*\/\s*h(?:r|our)?s?$/i);
  if (mySelf) {
    const rate = parseFloat(mySelf[1]);
    if (rate > 0) return { employeeName: '__owner__', ratePerHour: rate };
  }

  // "set rate John $28/hour" or "set rate John 28/hr"
  const named = s.match(/^set\s+rate\s+(.+?)\s+\$?([\d]+(?:\.[\d]{1,2})?)\s*\/\s*h(?:r|our)?s?$/i);
  if (named) {
    const name = String(named[1] || '').trim();
    const rate = parseFloat(named[2]);
    if (name && rate > 0) return { employeeName: name, ratePerHour: rate };
  }

  return null;
}

/**
 * Resolve tenant_id for an owner_id (for chiefos_crew_rates which requires tenant_id).
 */
async function resolveTenantId(ownerId) {
  const owner = String(ownerId || '').trim();
  if (!owner) return null;
  try {
    const r = await pool.query(
      `SELECT id FROM public.chiefos_tenants
        WHERE regexp_replace(coalesce(owner_id,''), '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g')
        ORDER BY created_at ASC LIMIT 1`,
      [owner]
    );
    return r?.rows?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve owner's display name for self-rate labelling.
 */
async function resolveOwnerName(ownerId, ownerProfile) {
  if (ownerProfile?.name) return String(ownerProfile.name).trim();
  if (ownerProfile?.display_name) return String(ownerProfile.display_name).trim();
  try {
    const r = await pool.query(
      `SELECT display_name, name FROM public.chiefos_tenant_actor_profiles
        WHERE owner_id::text = $1 AND is_owner = true LIMIT 1`,
      [String(ownerId)]
    );
    const row = r?.rows?.[0];
    return String(row?.display_name || row?.name || 'Owner').trim();
  } catch {
    return 'Owner';
  }
}

/**
 * Main handler.
 * Returns true if this command was handled (consumed), false to pass through.
 */
async function handleSetRate(from, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId) {
  const parsed = parseSetRate(text);
  if (!parsed) return false;

  try {
    if (!isOwner) {
      res.send(RESP('Only the Owner can set labor rates.'));
      return true;
    }

    const planKey = getEffectivePlanFromOwner(ownerProfile);
    if (planKey === 'free') {
      res.send(RESP(
        'Labor rate tracking is available on Starter and above.\n\n' +
        'Upgrade at usechiefos.com to unlock job profitability with real dollar costs.'
      ));
      return true;
    }

    const owner = DIGITS(String(ownerId || from || '').trim());
    if (!owner) {
      res.send(RESP('Unable to identify your account. Try again.'));
      return true;
    }

    const tenantId = await resolveTenantId(owner);
    if (!tenantId) {
      res.send(RESP('Unable to resolve your workspace. Try again.'));
      return true;
    }

    // Resolve display name for self-rate
    let employeeName = parsed.employeeName;
    if (employeeName === '__owner__') {
      employeeName = await resolveOwnerName(owner, ownerProfile);
    }

    const rateInCents = Math.round(parsed.ratePerHour * 100);
    const today = new Date().toISOString().slice(0, 10);

    await pool.query(
      `INSERT INTO public.chiefos_crew_rates
         (tenant_id, owner_id, employee_name, hourly_rate_cents, effective_from)
       VALUES ($1, $2, $3, $4, $5::date)
       ON CONFLICT (tenant_id, employee_name, effective_from)
       DO UPDATE SET hourly_rate_cents = EXCLUDED.hourly_rate_cents, updated_at = now()`,
      [tenantId, owner, employeeName, rateInCents, today]
    );

    const formatted = `$${parsed.ratePerHour.toFixed(2)}/hour`;
    res.send(RESP(
      `✅ Rate set: ${employeeName} — ${formatted}\n\n` +
      `This will appear in job profitability summaries going forward.\n` +
      `Try: kpis for [job name]`
    ));
    return true;

  } catch (e) {
    console.error('[rates] handleSetRate error:', e?.message);
    res.send(RESP('Could not save rate. Try again.'));
    return true;
  }
}

/**
 * Quick pattern check — call this before handleSetRate to avoid unnecessary parsing.
 */
function isSetRateCommand(text) {
  const s = String(text || '').toLowerCase().trim();
  return /^set\s+(my\s+)?rate\b/.test(s);
}

module.exports = { handleSetRate, isSetRateCommand };
