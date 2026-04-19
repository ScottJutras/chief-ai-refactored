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

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  SIGNATURE_BUCKET,
  SIGNATURE_STORAGE_KEY_RE,
  SIG_ERR,

  // Format helpers (pure)
  buildSignatureStorageKey,
  parseSignatureStorageKey,

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

    // Section 3: upload error classifier
    // classifySupabaseUploadError,
  },
};
