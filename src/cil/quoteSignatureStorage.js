// src/cil/quoteSignatureStorage.js
// ChiefOS Quotes Spine — Phase 2 storage layer for signature PNGs.
// Consumes services/supabaseAdmin.js as the infrastructure primitive.
//
// Architectural rules in docs/QUOTES_SPINE_DECISIONS.md §25:
//   §25.1 — Dedicated chiefos-signatures bucket; tenant-first path;
//           combined self-describing storage_key
//   §25.2 — Service-role writes; proxied streaming reads; 60s internal TTL
//   §25.3 — Helper-built/parsed; DB CHECK mirrors app regex; pre-
//           generated PK for strict-immutable write sequencing
//   §25.4 — Four-invariant upload: structural + size + integrity +
//           immutability
//   §25.5 — Retrieval helpers NEVER return signed URLs to callers;
//           enumeration-minimizing error taxonomy (SHARE_TOKEN_MISMATCH
//           collapses to SHARE_TOKEN_NOT_FOUND)
//   §25.6 — Indefinite retention; orphan cleanup best-effort (pattern A)
//   §25.7 — DI for pg + supabaseAdmin; _internals test surface
//
// Error model: helpers throw CilIntegrityError with code drawn from
// SIG_ERR. Route handlers map SIG_ERR[err.code].status → HTTP status.
//
// Section progression:
//   Section 1: constants + format helpers        (this commit)
//   Section 2: PNG validation + SHA-256          (next)
//   Section 3: upload + orphan cleanup
//   Section 4: retrieval helpers (portal + public)
//   Section 5: DB CHECK micro-migration + bucket provisioning
//   Section 6: module assembly + integration tests

const crypto = require('crypto');
const { CilIntegrityError } = require('./utils');

// ─── §25.1 Bucket + path convention ─────────────────────────────────────────

// Module-local bucket constant per §25.3 rule 4 (no shared buckets.js grab-
// bag). Future audit-kind buckets (chiefos-quote-pdfs, chiefos-tenant-logos)
// define their own constants in their own helper modules.
const SIGNATURE_BUCKET = 'chiefos-signatures';

// ─── §25.3 storage_key format enforcement ───────────────────────────────────

// Must match chiefos_qs_png_storage_key_format CHECK in
// migrations/2026_04_19_chiefos_qs_png_storage_key_format.sql (Phase 2B
// Section 5). Drift between these two regexes is a §25 violation — keep
// byte-identical.
//
// Shape: chiefos-signatures/{tenantId}/{quoteId}/{versionId}/{signatureId}.png
// Length: exactly 170 chars (19 bucket + 4×36 UUIDs + 3 separators + 4 ext).
// UUIDs: lowercase hex, canonical 8-4-4-4-12.
const SIGNATURE_STORAGE_KEY_RE = new RegExp(
  '^chiefos-signatures/' +
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' +   // tenantId
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' +   // quoteId
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' +   // quoteVersionId
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' +    // signatureId
  '\\.png$'
);

// ─── §25.5 error taxonomy ───────────────────────────────────────────────────

// Single source of truth for signature-storage error codes + HTTP status
// mapping. Helpers throw `new CilIntegrityError({ code: SIG_ERR.X.code, ... })`.
// Route handlers map `SIG_ERR[err.code].status` → HTTP status.
//
// Deeply frozen (outer + inner Object.freeze) so neither new keys nor
// status-value mutation is possible at runtime. Enumeration-minimizing:
// no SHARE_TOKEN_MISMATCH entry (collapsed to SHARE_TOKEN_NOT_FOUND per
// §25.5 addendum 3).
const SIG_ERR = Object.freeze({
  SIGNATURE_NOT_FOUND:   Object.freeze({ code: 'SIGNATURE_NOT_FOUND',   status: 404 }),
  SHARE_TOKEN_NOT_FOUND: Object.freeze({ code: 'SHARE_TOKEN_NOT_FOUND', status: 404 }),
  SHARE_TOKEN_EXPIRED:   Object.freeze({ code: 'SHARE_TOKEN_EXPIRED',   status: 410 }),
  SHARE_TOKEN_REVOKED:   Object.freeze({ code: 'SHARE_TOKEN_REVOKED',   status: 410 }),
  STORAGE_KEY_MALFORMED: Object.freeze({ code: 'STORAGE_KEY_MALFORMED', status: 500 }),
  STORAGE_FETCH_FAILED:  Object.freeze({ code: 'STORAGE_FETCH_FAILED',  status: 502 }),
  PNG_MALFORMED:         Object.freeze({ code: 'PNG_MALFORMED',         status: 400 }),
  PNG_TOO_LARGE:         Object.freeze({ code: 'PNG_TOO_LARGE',         status: 400 }),
  PNG_TOO_SMALL:         Object.freeze({ code: 'PNG_TOO_SMALL',         status: 400 }),
  PNG_UPLOAD_FAILED:     Object.freeze({ code: 'PNG_UPLOAD_FAILED',     status: 500 }),
  PNG_UPLOAD_DUPLICATE:  Object.freeze({ code: 'PNG_UPLOAD_DUPLICATE',  status: 500 }),
  PNG_BUCKET_MISSING:    Object.freeze({ code: 'PNG_BUCKET_MISSING',    status: 500 }),
  BAD_REQUEST:           Object.freeze({ code: 'BAD_REQUEST',           status: 400 }),
});

// ─── §25.3 Format helpers (pure) ────────────────────────────────────────────

/**
 * buildSignatureStorageKey — constructs a signature storage_key string per
 * §25.1 path template.
 *
 * Two orthogonal validations:
 *   1. Length = 170 (bucket 19 + 4×UUID 36 + 3 separators + '.png' 4).
 *   2. Regex match (SIGNATURE_STORAGE_KEY_RE).
 *
 * Input validation is implicit: if any input is not a valid lowercase UUID,
 * the composed string fails both length and regex checks. Called once per
 * SignQuote handler execution; signatureId is pre-generated via
 * crypto.randomUUID() per §25.3 strict-immutable write-path sequencing.
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.quoteId
 * @param {string} params.quoteVersionId
 * @param {string} params.signatureId
 * @returns {string} storage_key of exact length 170
 * @throws {CilIntegrityError} STORAGE_KEY_MALFORMED
 */
function buildSignatureStorageKey({ tenantId, quoteId, quoteVersionId, signatureId }) {
  const key = `${SIGNATURE_BUCKET}/${tenantId}/${quoteId}/${quoteVersionId}/${signatureId}.png`;
  if (key.length !== 170) {
    throw new CilIntegrityError({
      code: SIG_ERR.STORAGE_KEY_MALFORMED.code,
      message: 'Storage key has wrong length',
      hint: `expected 170, got ${key.length}; one or more inputs may not be valid UUIDs`,
    });
  }
  if (!SIGNATURE_STORAGE_KEY_RE.test(key)) {
    throw new CilIntegrityError({
      code: SIG_ERR.STORAGE_KEY_MALFORMED.code,
      message: 'Storage key failed format regex',
      hint: `key: ${key}`,
    });
  }
  return key;
}

/**
 * parseSignatureStorageKey — decomposes a signature storage_key string into
 * its five logical segments. Mirror of build.
 *
 * Two orthogonal validations: regex match, then explicit bucket-constant
 * check.
 *
 * Defense-in-depth bucket check: unreachable under the current regex (which
 * hardcodes 'chiefos-signatures'), but kept in case the regex is ever
 * broadened in a future §25 revision. An unreachable-now branch protecting
 * a future surface is cheaper than retrofitting the check later.
 *
 * @param {string} storageKey
 * @returns {{ bucket: string, tenantId: string, quoteId: string,
 *            quoteVersionId: string, signatureId: string }}
 * @throws {CilIntegrityError} STORAGE_KEY_MALFORMED
 */
function parseSignatureStorageKey(storageKey) {
  if (typeof storageKey !== 'string' || !SIGNATURE_STORAGE_KEY_RE.test(storageKey)) {
    throw new CilIntegrityError({
      code: SIG_ERR.STORAGE_KEY_MALFORMED.code,
      message: 'Storage key failed format regex',
      hint: `key: ${typeof storageKey === 'string' ? storageKey : `<${typeof storageKey}>`}`,
    });
  }
  const [bucket, tenantId, quoteId, quoteVersionId, signatureIdWithExt] = storageKey.split('/');
  if (bucket !== SIGNATURE_BUCKET) {
    // Unreachable under current regex; see JSDoc.
    throw new CilIntegrityError({
      code: SIG_ERR.STORAGE_KEY_MALFORMED.code,
      message: 'Storage key bucket mismatch',
      hint: `expected ${SIGNATURE_BUCKET}, got ${bucket}`,
    });
  }
  const signatureId = signatureIdWithExt.replace(/\.png$/, '');
  return { bucket, tenantId, quoteId, quoteVersionId, signatureId };
}

// ─── §25.4 PNG validation constants ─────────────────────────────────────────

// PNG file signature per RFC 2083 §3.1
// Hex:   89 50 4E 47 0D 0A 1A 0A
// ASCII: \x89 P N G \r \n \x1A \n
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

// PNG IEND chunk (end-of-image) per RFC 2083 §11.2.5
// Length (0x00000000) + Type "IEND" (0x49454E44) + CRC (0xAE426082)
const PNG_IEND_TRAILER = Buffer.from([
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4E, 0x44,
  0xAE, 0x42, 0x60, 0x82,
]);

// §25.4 invariant 2: decoded size bounds.
// Min 100 B: PNG structural minimum is ~67 B (8 magic + 25 IHDR + 22 IDAT +
//            12 IEND); 100 gives buffer room and rejects stub/empty inputs.
// Max 2 MB:  iPhone retina canvas full-coverage is ~500 KB – 1 MB; 2 MB is
//            generous headroom. Signature PNGs above this are implausible.
const PNG_MIN_BYTES = 100;
const PNG_MAX_BYTES = 2 * 1024 * 1024;

// §25.4 Tightening 1: computed from PNG_MAX_BYTES so changes to MAX propagate.
// Worst-case base64 expansion: 4 chars per 3 bytes + padding + slack for
// MIME-style whitespace-wrapping.
const PNG_MAX_BASE64_LENGTH = Math.ceil(PNG_MAX_BYTES / 3) * 4 + 16;

// §25.4 invariant 1: data URL regex. Base64 alphabet [A-Za-z0-9+/=] plus
// whitespace (for MIME-style line wrapping which is stripped during
// normalization). Case-sensitive by design — typical browser-emitted data
// URLs are lowercase `data:image/png;base64,`.
const DATA_URL_PNG_RE = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/;

// ─── §25.4 PNG validation helpers (internal — consumed by Section 3) ────────

/**
 * extractAndNormalizeBase64 — pulls the base64 payload out of a PNG data URL
 * and strips MIME-style whitespace (CRLF, tabs, spaces). Fails closed on:
 *   - Non-PNG data URL / wrong MIME / case-mismatched prefix
 *   - Whitespace-only base64 body (normalizes to empty)
 *   - Oversized normalized base64 (PNG_MAX_BASE64_LENGTH precheck)
 *
 * The precheck avoids decoding obviously-oversized input. Decoded size
 * bounds are enforced separately in validatePngBuffer (§25.4 invariant 2
 * applies at both transport-encoded and decoded stages).
 *
 * @param {string} dataUrl
 * @returns {string} normalized base64 payload (no whitespace)
 * @throws {CilIntegrityError} PNG_MALFORMED | PNG_TOO_LARGE
 */
function extractAndNormalizeBase64(dataUrl) {
  if (typeof dataUrl !== 'string') {
    throw new CilIntegrityError({
      code: SIG_ERR.PNG_MALFORMED.code,
      message: 'Expected PNG data URL',
      hint: `Input type ${typeof dataUrl}; expected string`,
    });
  }
  const match = DATA_URL_PNG_RE.exec(dataUrl);
  if (!match) {
    throw new CilIntegrityError({
      code: SIG_ERR.PNG_MALFORMED.code,
      message: 'Expected PNG data URL',
      hint: 'Input did not match data:image/png;base64,<base64> format',
    });
  }
  const normalized = match[1].replace(/\s/g, '');
  if (normalized.length === 0) {
    throw new CilIntegrityError({
      code: SIG_ERR.PNG_MALFORMED.code,
      message: 'Base64 payload empty after whitespace strip',
      hint: 'Data URL had whitespace-only body',
    });
  }
  if (normalized.length > PNG_MAX_BASE64_LENGTH) {
    throw new CilIntegrityError({
      code: SIG_ERR.PNG_TOO_LARGE.code,
      message: 'PNG base64 payload exceeds size limit',
      hint: `base64 length ${normalized.length} exceeds PNG_MAX_BASE64_LENGTH (${PNG_MAX_BASE64_LENGTH})`,
    });
  }
  return normalized;
}

/**
 * validatePngBuffer — structural validation per §25.4 invariant 1 (V2
 * posture: magic bytes + IEND trailer). Size bounds per invariant 2.
 *
 * V2 scope: asserts "this buffer is structurally a PNG file" via header +
 * trailer check. Does NOT validate chunk CRCs, IHDR internals, or IDAT
 * deflate integrity — that would require full PNG chunk parsing or a
 * decoder library, explicitly out of scope for signature validation
 * (§25.4 rationale note). Threat-model-matched: customer-drawn canvas
 * toDataURL() output; crafted-payload risk narrow.
 *
 * Assert-no-throw pattern: returns void on success.
 *
 * @param {Buffer} buffer
 * @throws {CilIntegrityError} PNG_MALFORMED | PNG_TOO_SMALL | PNG_TOO_LARGE
 */
function validatePngBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new CilIntegrityError({
      code: SIG_ERR.PNG_MALFORMED.code,
      message: 'Expected Node Buffer',
      hint: `Input type ${typeof buffer}; expected Buffer`,
    });
  }
  if (buffer.length < PNG_MIN_BYTES) {
    throw new CilIntegrityError({
      code: SIG_ERR.PNG_TOO_SMALL.code,
      message: 'PNG decoded size below minimum',
      hint: `decoded size ${buffer.length} below PNG_MIN_BYTES (${PNG_MIN_BYTES})`,
    });
  }
  if (buffer.length > PNG_MAX_BYTES) {
    throw new CilIntegrityError({
      code: SIG_ERR.PNG_TOO_LARGE.code,
      message: 'PNG decoded size exceeds maximum',
      hint: `decoded size ${buffer.length} exceeds PNG_MAX_BYTES (${PNG_MAX_BYTES})`,
    });
  }
  if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new CilIntegrityError({
      code: SIG_ERR.PNG_MALFORMED.code,
      message: 'PNG magic bytes mismatch',
      hint: 'First 8 bytes do not match PNG signature (RFC 2083 §3.1)',
    });
  }
  if (!buffer.subarray(-12).equals(PNG_IEND_TRAILER)) {
    throw new CilIntegrityError({
      code: SIG_ERR.PNG_MALFORMED.code,
      message: 'PNG IEND trailer mismatch',
      hint: 'Last 12 bytes do not match PNG IEND chunk (RFC 2083 §11.2.5)',
    });
  }
}

/**
 * computePngSha256 — §25.4 invariant 3: SHA-256 of the exact decoded bytes
 * persisted to the bucket. Computed once at write time; not recomputed on
 * re-fetch (verification is a separate operation per §25.6).
 *
 * Callers upstream of this helper have already validated via
 * validatePngBuffer, so the defensive Buffer check here is belt-and-
 * suspenders.
 *
 * @param {Buffer} buffer
 * @returns {string} 64-char lowercase hex SHA-256 digest
 * @throws {CilIntegrityError} PNG_MALFORMED when input is not a Buffer
 */
function computePngSha256(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new CilIntegrityError({
      code: SIG_ERR.PNG_MALFORMED.code,
      message: 'Expected Node Buffer',
      hint: `computePngSha256 input type ${typeof buffer}; expected Buffer`,
    });
  }
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ─── §25.2 / §25.7 admin-client gate (shared by Sections 3 + 4) ─────────────

/**
 * requireAdmin — asserts supabaseAdmin.getAdminClient() returns a non-null
 * client, throws a CilIntegrityError with a configurable code otherwise.
 *
 * Section 3 (upload) calls with PNG_UPLOAD_FAILED.
 * Section 4 (retrieve) will call with STORAGE_FETCH_FAILED.
 *
 * cleanupOrphanPng does NOT use this — its error posture is best-effort
 * (console.warn, no throw), which diverges from requireAdmin's throw-on-null
 * contract.
 *
 * @param {object} supabaseAdmin
 * @param {string} errCode — SIG_ERR.*.code to attach on failure
 * @returns {object} admin client (never null)
 * @throws {CilIntegrityError}
 */
function requireAdmin(supabaseAdmin, errCode) {
  const admin = supabaseAdmin && supabaseAdmin.getAdminClient
    ? supabaseAdmin.getAdminClient()
    : null;
  if (!admin) {
    throw new CilIntegrityError({
      code: errCode || SIG_ERR.PNG_UPLOAD_FAILED.code,
      message: 'Supabase admin client unavailable',
      hint: 'services/supabaseAdmin.getAdminClient() returned null; check SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars',
    });
  }
  return admin;
}

// ─── §25.5 Supabase-layer error classifier (internal) ───────────────────────

/**
 * classifySupabaseUploadError — maps raw Supabase StorageError to a
 * CilIntegrityError with an appropriate SIG_ERR code.
 *
 * Always returns CilIntegrityError. Never re-throws. Network-transient
 * failures fall into PNG_UPLOAD_FAILED; CIL-layer idempotency via
 * source_msg_id handles retry semantics at a higher level.
 *
 * Classification (substring match on error.message, case-insensitive):
 *   "already exists"              → PNG_UPLOAD_DUPLICATE
 *   "bucket not found" / "bucket does not exist" → PNG_BUCKET_MISSING
 *   anything else                 → PNG_UPLOAD_FAILED (auth, network, generic)
 *
 * Defensive shape handling: Supabase library has changed error shapes
 * across major versions. We accept anything with a .message field; coerce
 * strings to their own text; non-object non-string inputs degrade to
 * 'unknown supabase error' with generic PNG_UPLOAD_FAILED.
 *
 * No dedicated AUTH_FAILED code — hint text surfaces auth-specific
 * diagnosis (status 401/403, "not authorized" message) for operators
 * without bloating SIG_ERR; handler retry policy is identical for all
 * non-duplicate non-bucket-missing failures.
 *
 * @param {object|string} supabaseError
 * @returns {CilIntegrityError}
 */
function classifySupabaseUploadError(supabaseError) {
  const rawMessage =
    (supabaseError && typeof supabaseError === 'object' && supabaseError.message)
      ? String(supabaseError.message)
      : (typeof supabaseError === 'string' ? supabaseError : 'unknown supabase error');
  const msg = rawMessage.toLowerCase();
  const status = (supabaseError && typeof supabaseError === 'object')
    ? (supabaseError.statusCode ?? supabaseError.status ?? null)
    : null;

  if (msg.includes('already exists')) {
    return new CilIntegrityError({
      code: SIG_ERR.PNG_UPLOAD_DUPLICATE.code,
      message: 'Signature PNG upload hit duplicate key',
      hint:
        `Supabase: ${rawMessage}; storage_key already exists in bucket. ` +
        'Most likely cause: a prior upload with this signatureId succeeded but its cleanup ' +
        'or INSERT failed, leaving an orphan. Check the future reaper queue (§25.6 Direction A). ' +
        'Collision via crypto.randomUUID() is astronomically unlikely.',
    });
  }
  if (msg.includes('bucket not found') || msg.includes('bucket does not exist')) {
    return new CilIntegrityError({
      code: SIG_ERR.PNG_BUCKET_MISSING.code,
      message: 'Signature bucket missing',
      hint: `Supabase: ${rawMessage}; run the §25.7 bucket provisioning step (${SIGNATURE_BUCKET} bucket, private, 2MB, image/png only)`,
    });
  }
  return new CilIntegrityError({
    code: SIG_ERR.PNG_UPLOAD_FAILED.code,
    message: 'Signature PNG upload failed',
    hint: `Supabase: ${rawMessage}${status ? ` (status ${status})` : ''}`,
  });
}

// ─── §25.4 Upload pipeline ──────────────────────────────────────────────────

/**
 * uploadSignaturePng — §25.4 four-invariant upload pipeline for signature
 * PNGs. Composes Section 2 validators + SHA-256 + §25.3 storage_key parse
 * + service-role upload with upsert:false (non-negotiable per §25.4 inv 4).
 *
 * Caller responsibility (per §25.3 strict-immutable write-path sequencing):
 *   1. Pre-generate signatureId via crypto.randomUUID()
 *   2. Call buildSignatureStorageKey(...) to produce storageKey
 *   3. Pass storageKey to this helper
 *   4. On success, INSERT signature row with storageKey + returned sha256
 *   5. On INSERT failure, call cleanupOrphanPng({ supabaseAdmin, storageKey })
 *
 * Pipeline (matches Q4 step sequence):
 *   a. extractAndNormalizeBase64(pngDataUrl) — §25.4 inv 1 + inv 2 (base64 precheck)
 *   b. Buffer.from(..., 'base64') — decode
 *   c. validatePngBuffer(...) — §25.4 inv 1 (structural) + inv 2 (decoded size)
 *   d. computePngSha256(...) — §25.4 inv 3
 *   e. parseSignatureStorageKey(storageKey) — §25.3 rule 3 (helper-parsed)
 *   f. path = storageKey.slice(SIGNATURE_BUCKET.length + 1)
 *   g. requireAdmin(supabaseAdmin, PNG_UPLOAD_FAILED) — §25.2 rule 1 + §25.7 DI
 *   h. admin.storage.from(BUCKET).upload(path, buffer, { contentType, upsert:false })
 *   i. if (error) throw classifySupabaseUploadError(error) — §25.5
 *   j. return { pngBuffer, sha256 }
 *
 * @param {object} params
 * @param {string} params.pngDataUrl   — raw data:image/png;base64,... string
 * @param {string} params.storageKey   — pre-built from buildSignatureStorageKey
 * @param {object} params.supabaseAdmin — services/supabaseAdmin module (DI)
 * @returns {Promise<{ pngBuffer: Buffer, sha256: string }>}
 * @throws {CilIntegrityError}
 *   PNG_MALFORMED | PNG_TOO_SMALL | PNG_TOO_LARGE | STORAGE_KEY_MALFORMED |
 *   PNG_UPLOAD_DUPLICATE | PNG_BUCKET_MISSING | PNG_UPLOAD_FAILED
 */
async function uploadSignaturePng({ pngDataUrl, storageKey, supabaseAdmin }) {
  const normalized = extractAndNormalizeBase64(pngDataUrl);
  const pngBuffer = Buffer.from(normalized, 'base64');
  validatePngBuffer(pngBuffer);
  const sha256 = computePngSha256(pngBuffer);

  // Validate input storageKey; parseSignatureStorageKey throws on malformed.
  parseSignatureStorageKey(storageKey);
  const path = storageKey.slice(SIGNATURE_BUCKET.length + 1);

  const admin = requireAdmin(supabaseAdmin, SIG_ERR.PNG_UPLOAD_FAILED.code);

  const { error } = await admin.storage.from(SIGNATURE_BUCKET).upload(
    path,
    pngBuffer,
    { contentType: 'image/png', upsert: false }
  );
  if (error) throw classifySupabaseUploadError(error);

  return { pngBuffer, sha256 };
}

// ─── §25.6 Direction A best-effort orphan cleanup ───────────────────────────

/**
 * cleanupOrphanPng — §25.6 Direction A best-effort orphan cleanup.
 *
 * Called from handleSignQuote's INSERT-catch block when upload succeeded
 * but the signature row INSERT failed. Best-effort: swallows ALL errors
 * with console.warn; never throws. Caller is already in an error path
 * and will re-throw its own original error; this helper must not mask it.
 *
 * Diverges from requireAdmin's throw-on-null contract — cleanup's null-
 * admin case is a warning, not an error, because the caller is already
 * failing and we're just being polite about orphan bytes.
 *
 * @param {object} params
 * @param {object} params.supabaseAdmin — services/supabaseAdmin module
 * @param {string} params.storageKey    — same key used for the upload
 * @returns {Promise<void>}
 */
async function cleanupOrphanPng({ supabaseAdmin, storageKey }) {
  try {
    // Defensive parse — if storageKey is malformed, skip cleanup cleanly.
    parseSignatureStorageKey(storageKey);
    const path = storageKey.slice(SIGNATURE_BUCKET.length + 1);

    const admin = supabaseAdmin && supabaseAdmin.getAdminClient
      ? supabaseAdmin.getAdminClient()
      : null;
    if (!admin) {
      console.warn('[SIG_CLEANUP] supabaseAdmin unavailable; orphan left for reaper:', storageKey);
      return;
    }

    const { error } = await admin.storage.from(SIGNATURE_BUCKET).remove([path]);
    if (error) {
      console.warn('[SIG_CLEANUP] remove failed; orphan left for reaper:', storageKey, error.message);
    }
  } catch (cleanupErr) {
    console.warn('[SIG_CLEANUP] threw; orphan left for reaper:', storageKey, cleanupErr && cleanupErr.message);
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  SIGNATURE_BUCKET,
  SIGNATURE_STORAGE_KEY_RE,
  SIG_ERR,

  // Format helpers (pure)
  buildSignatureStorageKey,
  parseSignatureStorageKey,

  // Write path (Section 3)
  uploadSignaturePng,
  cleanupOrphanPng,

  // Placeholders — populated by later sections. Mirror quoteHash.js pattern:
  // declaring future _internals contents as comments keeps the full test
  // surface visible from each section's diff and prevents later-section
  // diffs surprising readers with newly-appearing internals.
  _internals: {
    // Section 2: PNG validation + SHA-256 helpers
    PNG_MAGIC,
    PNG_IEND_TRAILER,
    PNG_MIN_BYTES,
    PNG_MAX_BYTES,
    PNG_MAX_BASE64_LENGTH,
    DATA_URL_PNG_RE,
    extractAndNormalizeBase64,
    validatePngBuffer,
    computePngSha256,

    // Section 3: admin gate + error classifier
    requireAdmin,
    classifySupabaseUploadError,
  },
};
