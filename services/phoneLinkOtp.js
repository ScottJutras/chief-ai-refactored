// services/phoneLinkOtp.js
// Phone-link OTP generation + verification for portal↔WhatsApp linkage.
//
// Flow:
//   1. Portal UI calls generatePhoneLinkOtp(authUserId, phoneDigits) via a
//      service-role endpoint. UPSERTs portal_phone_link_otp (PK on auth_user_id).
//   2. User sends the 6-digit code via WhatsApp from phoneDigits.
//   3. Webhook calls verifyPhoneLinkOtp(senderPhone, candidateCode). On match,
//      writes public.users.auth_user_id atomically with the OTP DELETE.
//
// Security:
//   - OTP plaintext is NEVER persisted or logged; only sha256(code + pepper).
//   - Constant-time comparison via crypto.timingSafeEqual prevents timing oracles.
//   - UNIQUE(auth_user_id) on public.users blocks double-pairing.
//
// Schema anchor: migrations/2026_04_21_rebuild_identity_tenancy.sql §5
// + migrations/2026_04_23_amendment_p1a4_users_auth_user_id.sql (P1A-4).

const crypto = require('crypto');
const pg = require('./postgres');

const DEFAULT_TTL_MINUTES = 10;
const OTP_LENGTH = 6;
const PEPPER = process.env.PHONE_LINK_OTP_PEPPER || '';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE_DIGITS_RE = /^\d{7,}$/;

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code) + PEPPER, 'utf8').digest('hex');
}

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

function isPhoneDigits(v) {
  return typeof v === 'string' && PHONE_DIGITS_RE.test(v);
}

/**
 * Generate a new OTP for phone-link verification.
 * Creates or replaces the row in portal_phone_link_otp (PK on auth_user_id).
 *
 * @param {string} authUserId - UUID of the portal user (auth.uid()).
 * @param {string} phoneDigits - Digit-only string matching phone_digits format CHECK.
 * @param {object} [options]
 * @param {number} [options.ttlMinutes=10]
 * @returns {Promise<{ code: string, expiresAt: Date }>}
 */
async function generatePhoneLinkOtp(authUserId, phoneDigits, options = {}) {
  if (!isUuid(authUserId)) {
    throw new Error('generatePhoneLinkOtp: authUserId must be a uuid');
  }
  if (!isPhoneDigits(phoneDigits)) {
    throw new Error('generatePhoneLinkOtp: phoneDigits must be digit-only, length >= 7');
  }

  const ttlMinutes = Number(options.ttlMinutes) > 0 ? Number(options.ttlMinutes) : DEFAULT_TTL_MINUTES;

  // randomInt is uniform; range [100000, 1000000) guarantees 6 digits.
  const code = String(crypto.randomInt(100000, 1000000));
  const otpHash = hashCode(code);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  await pg.query(
    `
    insert into public.portal_phone_link_otp
      (auth_user_id, phone_digits, otp_hash, expires_at, created_at)
    values ($1::uuid, $2, $3, $4, now())
    on conflict (auth_user_id) do update
       set phone_digits = excluded.phone_digits,
           otp_hash     = excluded.otp_hash,
           expires_at   = excluded.expires_at,
           created_at   = now()
    `,
    [authUserId, phoneDigits, otpHash, expiresAt.toISOString()]
  );

  return { code, expiresAt };
}

/**
 * Verify an inbound WhatsApp message against outstanding OTPs for the sender phone.
 * On match: writes public.users.auth_user_id, deletes the consumed OTP row.
 *
 * @param {string} phoneDigits - Sender phone, digit-only.
 * @param {string} candidateCode - Numeric code extracted from the message body.
 * @returns {Promise<{ paired: boolean, authUserId?: string, tenantId?: string, userId?: string, error?: string }>}
 */
async function verifyPhoneLinkOtp(phoneDigits, candidateCode) {
  if (!isPhoneDigits(phoneDigits)) return { paired: false };
  if (typeof candidateCode !== 'string' || candidateCode.length !== OTP_LENGTH || !/^\d+$/.test(candidateCode)) {
    return { paired: false };
  }

  const candidateHash = hashCode(candidateCode);
  const candidateHashBuf = Buffer.from(candidateHash, 'hex');

  const { rows: otpRows } = await pg.query(
    `
    select auth_user_id, otp_hash
      from public.portal_phone_link_otp
     where phone_digits = $1
       and expires_at > now()
    `,
    [phoneDigits]
  );

  // Constant-time compare all candidates. Do NOT short-circuit on first match —
  // evaluate every row, then decide. Timing is bounded by row count.
  const matches = [];
  for (const row of otpRows) {
    const rowHashBuf = Buffer.from(String(row.otp_hash || ''), 'hex');
    if (rowHashBuf.length !== candidateHashBuf.length) continue;
    if (crypto.timingSafeEqual(rowHashBuf, candidateHashBuf)) {
      matches.push(row);
    }
  }

  if (matches.length === 0) return { paired: false };
  if (matches.length > 1) {
    console.error('[phoneLinkOtp] AMBIGUOUS_OTP: multiple hash matches', { phoneDigits });
    return { paired: false, error: 'AMBIGUOUS_OTP' };
  }

  const matchedAuthUid = matches[0].auth_user_id;

  // Look up the ingestion-identity row that this pairing targets.
  const { rows: userRows } = await pg.query(
    `
    select user_id, tenant_id, auth_user_id
      from public.users
     where user_id = $1
     limit 1
    `,
    [phoneDigits]
  );

  if (userRows.length === 0) {
    // OTP was generated against a phone that has no ingestion identity row.
    console.warn('[phoneLinkOtp] users row missing for phone', { phoneDigits });
    return { paired: false };
  }

  const userRow = userRows[0];

  if (userRow.auth_user_id && userRow.auth_user_id !== matchedAuthUid) {
    console.warn('[phoneLinkOtp] IDENTITY_CONFLICT: users row already paired to a different auth_user', {
      phoneDigits,
      existing: userRow.auth_user_id,
      attempted: matchedAuthUid,
    });
    return { paired: false, error: 'IDENTITY_CONFLICT' };
  }

  // Atomic pair + consume. Guard UPDATE with auth_user_id IS NULL to prevent
  // concurrent double-pairing; DELETE the consumed OTP either way.
  await pg.query('begin');
  try {
    await pg.query(
      `
      update public.users
         set auth_user_id = $1::uuid,
             updated_at   = now()
       where user_id = $2
         and auth_user_id is null
      `,
      [matchedAuthUid, phoneDigits]
    );

    await pg.query(
      `delete from public.portal_phone_link_otp where auth_user_id = $1::uuid`,
      [matchedAuthUid]
    );

    await pg.query('commit');
  } catch (e) {
    try { await pg.query('rollback'); } catch { /* ignore */ }
    throw e;
  }

  return {
    paired: true,
    authUserId: matchedAuthUid,
    tenantId: userRow.tenant_id,
    userId: userRow.user_id,
  };
}

/**
 * Check whether an auth user's phone is currently paired.
 *
 * @param {string} authUserId
 * @returns {Promise<boolean>}
 */
async function isPhonePaired(authUserId) {
  if (!isUuid(authUserId)) return false;
  try {
    const { rows } = await pg.query(
      `select 1 from public.users where auth_user_id = $1::uuid limit 1`,
      [authUserId]
    );
    return rows.length > 0;
  } catch (e) {
    console.warn('[phoneLinkOtp] isPhonePaired lookup failed:', e?.message);
    return false;
  }
}

module.exports = {
  generatePhoneLinkOtp,
  verifyPhoneLinkOtp,
  isPhonePaired,
};
