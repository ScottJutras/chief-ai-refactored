// handlers/commands/mileage.js
// Handles mileage log captures from WhatsApp.
// Trigger: "drove 45km to Harris job", "35 miles to Maple site", "mileage 60km"

'use strict';

const { getPool } = require('../../services/postgres');
const { canEmployeeLogMileage } = require('../../src/config/checkCapability');
const { logCapabilityDenial } = require('../../src/lib/capabilityDenials');
const { getEffectivePlanFromOwner } = require('../../src/config/effectivePlan');

// CRA 2024 rates (cents per km)
const CRA_RATE_FIRST_5000  = 72; // $0.72/km
const CRA_RATE_AFTER_5000  = 66; // $0.66/km
const CRA_TIER_KM          = 5000;

// IRS 2024 rate (cents per mile)
const IRS_RATE_CENTS        = 67; // $0.67/mile

/**
 * Detect if this message looks like a mileage log.
 * Keep it specific to avoid collisions with timeclock.
 */
function isMileageMessage(text) {
  const t = String(text || '').toLowerCase().trim();
  return (
    /\b(mileage|drove|driven)\b/.test(t) ||
    /\b\d+(\.\d+)?\s*(km|kilometer|kilometre|mi|mile|miles)\b/.test(t)
  );
}

/**
 * Parse distance + unit from raw text.
 * Returns { distance: number, unit: 'km'|'mi' } or null.
 */
function parseDistance(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(km|kilometer|kilometre|mi\b|mile|miles)/i);
  if (!m) return null;

  const distance = parseFloat(m[1]);
  const raw = m[2].toLowerCase();
  const unit = raw.startsWith('km') || raw.startsWith('kilo') ? 'km' : 'mi';

  return { distance, unit };
}

/**
 * Parse job name from a message.
 * Looks for patterns like "to <job>", "for <job>".
 */
function parseJobName(text) {
  // "to the Harris job", "to Harris job", "for the Maple renovation"
  const m = text.match(/(?:to|for)\s+(?:the\s+)?([A-Za-z0-9 '&\-]{2,50?}?)\s*(?:job|site|project|$)/i);
  if (m) return m[1].trim().replace(/\s+/g, ' ');
  return null;
}

/**
 * Parse date: look for "on YYYY-MM-DD" or "today" or "yesterday", else today.
 */
function parseDate(text) {
  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  const t = text.toLowerCase();
  const now = new Date();
  if (t.includes('yesterday')) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  return now.toISOString().slice(0, 10);
}

/**
 * Get YTD km for the owner to apply CRA tiered rate.
 */
async function getYtdKm(pool, ownerId) {
  const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
  const result = await pool.query(
    `SELECT COALESCE(SUM(distance), 0)::numeric AS ytd_km
       FROM mileage_logs
      WHERE owner_id = $1
        AND unit = 'km'
        AND trip_date >= $2`,
    [ownerId, yearStart]
  );
  return parseFloat(result.rows[0]?.ytd_km || 0);
}

/**
 * Calculate deductible amount in cents for a given distance + unit + country.
 * For CA: apply CRA tiered rates based on ytdKmBefore (km logged before this trip).
 */
function calcDeductible(distance, unit, country, ytdKmBefore) {
  if (unit === 'mi') {
    // IRS flat rate
    return Math.round(distance * IRS_RATE_CENTS);
  }

  // CRA tiered: km
  if (country !== 'CA') {
    // Non-CA fallback: use first-tier rate
    return Math.round(distance * CRA_RATE_FIRST_5000);
  }

  // Apply CRA tiered rate
  let remaining = distance;
  let totalCents = 0;

  const kmBefore = Math.min(ytdKmBefore, CRA_TIER_KM);
  const firstTierLeft = Math.max(0, CRA_TIER_KM - kmBefore);

  if (firstTierLeft > 0) {
    const firstTierKm = Math.min(remaining, firstTierLeft);
    totalCents += Math.round(firstTierKm * CRA_RATE_FIRST_5000);
    remaining -= firstTierKm;
  }

  if (remaining > 0) {
    totalCents += Math.round(remaining * CRA_RATE_AFTER_5000);
  }

  return totalCents;
}

/**
 * Insert a mileage log and return the row.
 * employeeUserId is non-null when an employee (non-owner) submits.
 */
async function insertMileageLog(pool, { tenantId, ownerId, employeeUserId, distance, unit, origin, destination, jobName, tripDate, rateCents, deductibleCents, sourceMsgId }) {
  const result = await pool.query(
    `INSERT INTO mileage_logs
       (tenant_id, owner_id, employee_user_id, job_name, trip_date, origin, destination,
        distance, unit, rate_cents, deductible_cents, source_msg_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
     ON CONFLICT (owner_id, source_msg_id) DO NOTHING
     RETURNING id`,
    [tenantId, ownerId, employeeUserId || null, jobName || null, tripDate,
     origin || null, destination || null,
     distance, unit, rateCents, deductibleCents, sourceMsgId || null]
  );
  return result.rows[0];
}

/**
 * Main handler for mileage messages.
 * isOwner: boolean — false when an employee is the sender.
 * ownerProfile: the owner's profile object (used for plan resolution).
 * paUserId: the actor's phone digits (for employee attribution).
 */
async function handleMileage({ text, ownerId, tenantId, country, sourceMsgId, isOwner, ownerProfile, paUserId }) {
  // ✅ Plan gate: employees need Starter+ to self-log mileage
  if (!isOwner) {
    const plan = getEffectivePlanFromOwner(ownerProfile);
    const gate = canEmployeeLogMileage(plan);
    if (!gate.allowed) {
      try {
        await logCapabilityDenial(getPool(), {
          owner_id: String(ownerId || '').trim(),
          user_id: String(paUserId || '').trim(),
          actor_role: 'employee',
          plan,
          capability: 'mileage',
          reason_code: gate.reason_code,
          upgrade_plan: gate.upgrade_plan || null,
          source_msg_id: sourceMsgId || null,
          context: { handler: 'mileage.handleMileage' },
        });
      } catch {}
      return gate.message || 'Employee mileage logging is available on Starter and Pro. Ask your employer to upgrade.';
    }
  }

  const dist = parseDistance(text);
  if (!dist) {
    return 'I couldn\'t read the distance. Try: "drove 45km to the Harris job" or "35 miles to site."';
  }

  const { distance, unit } = dist;
  const jobName = parseJobName(text);
  const tripDate = parseDate(text);
  const employeeUserId = isOwner ? null : (String(paUserId || '').trim() || null);

  const pool = getPool();

  // For CRA tiered rate we need YTD km
  let ytdKmBefore = 0;
  if (unit === 'km' && country === 'CA') {
    ytdKmBefore = await getYtdKm(pool, ownerId);
  }

  const rateCents = unit === 'mi' ? IRS_RATE_CENTS : (
    (ytdKmBefore < CRA_TIER_KM && country === 'CA') ? CRA_RATE_FIRST_5000 : CRA_RATE_AFTER_5000
  );

  const deductibleCents = calcDeductible(distance, unit, country, ytdKmBefore);
  const deductibleDollars = (deductibleCents / 100).toFixed(2);

  await insertMileageLog(pool, {
    tenantId,
    ownerId,
    employeeUserId,
    distance,
    unit,
    origin: null,
    destination: jobName || null,
    jobName,
    tripDate,
    rateCents,
    deductibleCents,
    sourceMsgId,
  });

  const rateLine = unit === 'km'
    ? `$${(rateCents / 100).toFixed(2)}/km (CRA ${ytdKmBefore >= CRA_TIER_KM ? 'after 5000km tier' : 'standard tier'})`
    : `$${(rateCents / 100).toFixed(2)}/mi (IRS)`;

  const jobLine = jobName ? ` • Job: ${jobName}` : '';

  return `Mileage logged ✓\n${distance} ${unit} on ${tripDate}${jobLine}\nRate: ${rateLine}\nDeductible: $${deductibleDollars}`;
}

module.exports = { handleMileage, isMileageMessage };
