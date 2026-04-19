// src/config/tenantProfiles.js
//
// Temporary bootstrap source for tenant_snapshot content at CreateQuote
// time. Frozen lookup from tenant_id → TenantSnapshotZ-shaped object.
//
// Why this file exists:
//   `chiefos_tenants` today carries only identity + locale columns
//   (name, country, province, tax_code) — not the rich branding data a
//   rendered quote needs (legal name, HST registration, mailing address,
//   contact phone/email/web). The standalone Mission Exteriors build
//   hardcoded these values inline; ChiefOS's handler needs a source.
//
//   Snapshots are immutable per §6 — quote versions freeze the tenant
//   snapshot at creation time. If we shipped CreateQuote with empty
//   snapshots and later filled them in, the early quotes would be
//   permanently empty (can't backfill locked versions). Fail-closed is
//   safer: a missing profile throws CIL_INTEGRITY_ERROR with
//   TENANT_PROFILE_MISSING, preventing an empty-snapshot quote from
//   being created.
//
// Migration path:
//   When a DB-backed tenant-profile table ships, the handler's
//   composeTenantSnapshot swaps this config-file read for a query.
//   TenantSnapshotZ contract is unchanged; source is detail. See §20
//   addendum on tenant_snapshot source.
//
// Adding a new tenant:
//   Add an Object.freeze entry keyed by tenant_id UUID. Values must
//   match TenantSnapshotZ (phone in E.164 format; email RFC-valid).

const TENANT_PROFILES = Object.freeze({
  // Mission Exteriors (Forest City's sibling tenant; owner Scott Jutras).
  // Values sourced from mission-quote-standalone/lib/quotes.js tenant block.
  // Phone converted from standalone's display form "844.959.0109" to E.164.
  '86907c28-a9ea-4318-819d-5a012192119b': Object.freeze({
    legal_name: '9839429 Canada Inc.',
    brand_name: 'Mission Exteriors',
    address: '1556 Medway Park Dr, London, ON, N6G 0X5',
    phone_e164: '+18449590109',
    email: 'scott@missionexteriors.ca',
    web: 'missionexteriors.ca',
    hst_registration: '759884893RT0001',
  }),
});

/**
 * Look up a tenant profile by tenant_id. Caller responsible for routing
 * to CIL_INTEGRITY_ERROR on missing — this function returns undefined
 * rather than throwing so tests can exercise the missing-profile path
 * without constructing a CilIntegrityError themselves.
 *
 * @param {string} tenantId - uuid
 * @returns {Object | undefined} TenantSnapshotZ-shaped object, or undefined
 *                                if tenant not in bootstrap config.
 */
function getTenantProfile(tenantId) {
  return TENANT_PROFILES[tenantId];
}

module.exports = { TENANT_PROFILES, getTenantProfile };
