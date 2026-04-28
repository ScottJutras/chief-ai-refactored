// services/actorContext.js
//
// Single source of truth for "who is performing this action" in the rebuild schema.
//
// Identity model (Engineering Constitution §2):
//   - tenant_id (uuid)         — portal/RLS boundary
//   - owner_id  (digit string) — ingestion/audit boundary
//   - user_id / actorId (digit string) — actor identity, scoped under owner_id
//
// R3 resolution paths:
//   - Portal:   auth.uid() → public.users (via auth_user_id + tenant_id) → user_id
//   - WhatsApp: senderPhoneDigits IS the user_id (phone-digit PK on public.users)
//
// Rebuild schema anchor: migrations/2026_04_21_rebuild_identity_tenancy.sql §2
// Amendment anchor: migrations/2026_04_23_amendment_p1a4_users_auth_user_id.sql (P1A-4)

const crypto = require('crypto');
const pg = require('./postgres');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^\d{7,}$/;

function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }
function isDigits(v) { return typeof v === 'string' && DIGITS_RE.test(v); }

/**
 * Resolve actor identity from a portal auth user within a tenant.
 * Defense-in-depth: requires both auth_user_id (globally unique) AND tenant_id match.
 *
 * @param {string} authUserId - auth.uid() (uuid).
 * @param {string} tenantId - resolved tenant uuid.
 * @returns {Promise<{ actorId: string|null, role: string|null, phonePaired: boolean }>}
 */
async function resolvePortalActor(authUserId, tenantId) {
  if (!isUuid(authUserId) || !isUuid(tenantId)) {
    return { actorId: null, role: null, phonePaired: false };
  }

  try {
    const { rows } = await pg.query(
      `
      select user_id, role
        from public.users
       where auth_user_id = $1::uuid
         and tenant_id = $2::uuid
       limit 1
      `,
      [authUserId, tenantId]
    );
    const row = rows[0];
    if (!row) return { actorId: null, role: null, phonePaired: false };
    return {
      actorId: String(row.user_id),
      role: row.role || null,
      phonePaired: true,
    };
  } catch (e) {
    console.warn('[actorContext] resolvePortalActor failed:', e?.message);
    return { actorId: null, role: null, phonePaired: false };
  }
}

/**
 * Resolve actor identity from a WhatsApp sender phone.
 * On webhook paths, actor IS the sender — this is a validation wrapper that
 * narrows by ownerId (tenant root) to guard against cross-tenant surprises.
 *
 * @param {string} senderPhoneDigits - digit-only string.
 * @param {string} ownerId - tenant's owner_id digit-string.
 * @returns {Promise<{ actorId: string|null, role: string|null, userId: string|null }>}
 */
async function resolveWhatsAppActor(senderPhoneDigits, ownerId) {
  if (!isDigits(senderPhoneDigits) || !isDigits(ownerId)) {
    return { actorId: null, role: null, userId: null };
  }

  try {
    const { rows } = await pg.query(
      `
      select user_id, role, owner_id
        from public.users
       where user_id = $1
         and owner_id = $2
       limit 1
      `,
      [senderPhoneDigits, ownerId]
    );
    const row = rows[0];
    if (!row) return { actorId: null, role: null, userId: null };
    return {
      actorId: String(row.user_id),
      role: row.role || null,
      userId: String(row.user_id),
    };
  } catch (e) {
    console.warn('[actorContext] resolveWhatsAppActor failed:', e?.message);
    return { actorId: null, role: null, userId: null };
  }
}

/**
 * Build a complete, frozen actor context for emission / audit purposes.
 * Read from req fields populated by userProfile + requirePortalUser middlewares.
 *
 * Consumers: services/activityLog.js (and, post-R3a, crew emission sites).
 *
 * R3a: includes correlationId threaded through the request per §17.21.
 *
 * @param {object} req - Express req or equivalent.
 * @returns {object} frozen actor context.
 */
function buildActorContext(req) {
  const ctx = {
    tenantId: (req && req.tenantId) || null,
    ownerId: (req && req.ownerId) || null,
    actorId: (req && req.actorId) || null,
    actorRole: (req && req.actorRole) || null,
    portalUserId: (req && req.portalUserId) || null,
    source: (req && req.source) || inferSource(req),
    sourceMsgId: (req && req.sourceMsgId) || null,
    traceId: (req && req.traceId) || null,
    correlationId: (req && req.correlationId) || null,
  };
  return Object.freeze(ctx);
}

/**
 * Ensure a correlation_id is attached to the request (idempotent).
 * Call once per handler invocation; same correlationId across multiple
 * emissions within one request enables §17.21 causal-chain reconstruction.
 *
 * @param {object} req
 * @returns {string} the correlationId (new or existing).
 */
function ensureCorrelationId(req) {
  if (req && req.correlationId) return req.correlationId;
  const id = crypto.randomUUID();
  if (req) req.correlationId = id;
  return id;
}

function inferSource(req) {
  if (!req) return 'unknown';
  if (req.portalUserId) return 'portal';
  if (req.from || req.body?.From) return 'whatsapp';
  return 'unknown';
}

module.exports = {
  resolvePortalActor,
  resolveWhatsAppActor,
  buildActorContext,
  ensureCorrelationId,
};
