/**
 * src/cil/quoteHash.js — Canonical version hashing for the Quote spine.
 * See docs/QUOTES_SPINE_DECISIONS.md §4 for full specification.
 *
 * Public API:
 *   - HASH_ALG_VERSION (number)           — algorithm version pin (currently 1)
 *   - computeVersionHash(version, lineItems) → { hex, canonical }
 *   - CUSTOMER_SNAPSHOT_FIELDS_V1 (frozen array)
 *   - TENANT_SNAPSHOT_FIELDS_V1   (frozen array)
 *   - LINE_ITEM_FIELDS_V1         (frozen array)
 *
 * _internals exports (tests + internal tooling only; subject to change
 * without major-version coordination):
 *   - buildHashInput, assertIntegerNumbers, assertLineItemsSorted,
 *     qtyToThousandths, canonicalizeSnapshot, canonicalizeLineItem
 *
 * Frozen field lists are deliberately NOT read from Zod schemas
 * (CustomerSnapshotZ.shape / TenantSnapshotZ.shape). Schema evolution is
 * a legitimate product activity that must not silently affect past
 * hashes. Adding a field to hashing requires bumping HASH_ALG_VERSION
 * and explicit migration logic for existing signed quotes.
 */

const crypto = require('crypto');
const stableStringify = require('fast-json-stable-stringify');

// ───────────────────────────────────────────────────────────────────────────
// Algorithm version pin. Exported for verifier dispatch: future v2 callers
// read storedAlgVersion and route to the corresponding algorithm module.
// ───────────────────────────────────────────────────────────────────────────

const HASH_ALG_VERSION = 1;

// ───────────────────────────────────────────────────────────────────────────
// Frozen field lists for _hash_alg_version: 1.
// Any change here requires bumping HASH_ALG_VERSION and coordinating
// migration for existing signed quotes. Do NOT read from Zod .shape.
// ───────────────────────────────────────────────────────────────────────────

const CUSTOMER_SNAPSHOT_FIELDS_V1 = Object.freeze([
  'address',
  'email',
  'name',
  'phone_e164',
]);

const TENANT_SNAPSHOT_FIELDS_V1 = Object.freeze([
  'address',
  'brand_name',
  'email',
  'hst_registration',
  'legal_name',
  'phone_e164',
  'web',
]);

const LINE_ITEM_FIELDS_V1 = Object.freeze([
  'catalog_product_id',
  'catalog_snapshot',
  'category',
  'description',
  'line_subtotal_cents',
  'line_tax_cents',
  'qty_thousandths',
  'sort_order',
  'tax_code',
  'unit_price_cents',
]);

// ───────────────────────────────────────────────────────────────────────────
// Precondition assertions. Canonicalization preconditions are defended at
// the function boundary. Violations throw loud rather than silently
// degrading — a hash computed on corrupted input would verify successfully
// against the same corrupted input permanently. Silent integrity breach is
// worse than a loud throw.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Recursively asserts every numeric value in the hash input is a finite
 * integer. Strings, booleans, nulls, undefined pass through. Arrays/
 * objects recurse. Unsupported types (symbol, function, bigint) throw.
 */
function assertIntegerNumbers(v, path = '$') {
  if (v === null || v === undefined) return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error(
        `Canonical hash input must contain only integer numbers. ` +
        `Non-integer at ${path}: ${v}. This usually indicates a conversion step was ` +
        `skipped (e.g., qty not converted to qty_thousandths, or a float leaked from a computation).`
      );
    }
    return;
  }
  if (typeof v === 'string' || typeof v === 'boolean') return;
  if (Array.isArray(v)) {
    v.forEach((item, i) => assertIntegerNumbers(item, `${path}[${i}]`));
    return;
  }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) assertIntegerNumbers(v[k], `${path}.${k}`);
    return;
  }
  throw new Error(`Canonical hash input contains unsupported type at ${path}: ${typeof v}`);
}

/**
 * Defends the sort_order ASC, id ASC invariant required by §4. The
 * fetcher that builds hash input is expected to ORDER BY at the SQL
 * layer; this assertion catches upstream ORDER BY bugs loudly rather
 * than hashing silently-misordered items.
 */
function assertLineItemsSorted(lineItems) {
  for (let i = 1; i < lineItems.length; i++) {
    const prev = lineItems[i - 1];
    const curr = lineItems[i];
    if (prev.sort_order > curr.sort_order) {
      throw new Error(
        `line_items must be sorted by sort_order ASC; violation at index ${i}: ${prev.sort_order} > ${curr.sort_order}`
      );
    }
    if (prev.sort_order === curr.sort_order) {
      // After canonicalization, line_items no longer carry `id` (it's not
      // in LINE_ITEM_FIELDS_V1). The fetcher is responsible for the id-tie-
      // break; by the time the canonicalized form reaches this assertion
      // only sort_order ordering can be verified here. Equal sort_order
      // values are allowed — trust the fetcher's id tie-break upstream.
      continue;
    }
  }
}

/**
 * qty → qty_thousandths integer via string arithmetic. See §4 Q4 in
 * decisions log: IEEE 754 intermediate (parseFloat × 1000) drifts on
 * certain decimals (0.1, 0.2, 2.675 boundaries). String arithmetic is
 * exact for every numeric(18,3) input within Number.MAX_SAFE_INTEGER.
 *
 * Bounded by SAFE_INTEGER (~9×10¹⁵); exceeds throws with a hint to
 * bump HASH_ALG_VERSION and adopt BigInt serialization. In qty_thousandths
 * terms this corresponds to qty ~9×10¹² — implausibly large for real
 * contracting quotes.
 *
 * Strict: rejects non-string input (pg's default for numeric(18,3) is
 * string; a Number here indicates a pg-types config override). Rejects
 * >3 fractional digits (schema extension to numeric(18,6) would be a
 * HASH_ALG_VERSION bump).
 */
function qtyToThousandths(qtyStr) {
  if (typeof qtyStr !== 'string') {
    throw new Error(
      `qtyToThousandths expects string input (pg numeric(18,3) default); got ${typeof qtyStr}: ${qtyStr}. ` +
      `A pg-types config override may be coercing numeric to Number — verify pool configuration.`
    );
  }
  const match = /^(-?)(\d+)(?:\.(\d{0,3}))?$/.exec(qtyStr);
  if (!match) {
    throw new Error(`qtyToThousandths: malformed numeric string: ${qtyStr}`);
  }
  const [, sign, wholePart, fracPart = ''] = match;
  // Pad fractional to exactly 3 digits. slice(0, 3) is defense-in-depth
  // — the regex already rejects >3 fractional digits.
  const fracPadded = (fracPart + '000').slice(0, 3);
  const combined = wholePart + fracPadded;
  const asInt = Number(combined);
  if (!Number.isSafeInteger(asInt)) {
    throw new Error(
      `qtyToThousandths: result ${combined} exceeds Number.MAX_SAFE_INTEGER. ` +
      `Hash input cannot represent this qty precisely — consider bumping HASH_ALG_VERSION ` +
      `to use BigInt serialization.`
    );
  }
  return sign === '-' ? -asInt : asInt;
}

// ───────────────────────────────────────────────────────────────────────────
// Canonicalization — per §4 schema-driven field enumeration.
// Absent fields become null per Q1-call-3 (preserves tamper detection;
// normalizes JSONB storage shape variance).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Walk a source snapshot object against a frozen field list and produce
 * a canonical object where every declared field is present with explicit
 * value (null when absent in the source).
 */
function canonicalizeSnapshot(snapshot, frozenFields) {
  const source = snapshot || {};
  const result = {};
  for (const field of frozenFields) {
    result[field] = source[field] !== undefined ? source[field] : null;
  }
  return result;
}

/**
 * Canonicalize a single line item row into the LINE_ITEM_FIELDS_V1 shape.
 * Responsibilities: qty → qty_thousandths; numeric fields coerced to
 * Number (assertIntegerNumbers will reject drift); catalog_snapshot
 * null/absent → {}; nullable fields normalized to explicit null.
 */
function canonicalizeLineItem(lineItem) {
  const qty_thousandths = qtyToThousandths(lineItem.qty);
  // Normalize null/absent catalog_snapshot to {} per Q5-call-1c (matches
  // the absent-field-to-null pattern adapted for object-typed fields).
  const catalog_snapshot = lineItem.catalog_snapshot || {};
  const source = {
    catalog_product_id: lineItem.catalog_product_id !== undefined
      ? lineItem.catalog_product_id
      : null,
    catalog_snapshot,
    category: lineItem.category !== undefined ? lineItem.category : null,
    description: lineItem.description,
    line_subtotal_cents: Number(lineItem.line_subtotal_cents),
    line_tax_cents: Number(lineItem.line_tax_cents),
    qty_thousandths,
    sort_order: Number(lineItem.sort_order),
    tax_code: lineItem.tax_code !== undefined ? lineItem.tax_code : null,
    unit_price_cents: Number(lineItem.unit_price_cents),
  };
  // Build output containing only LINE_ITEM_FIELDS_V1 keys. Any extra keys
  // on the input (schema evolution, columns added after v1) are dropped —
  // HASH_ALG_VERSION: 1's field coverage is frozen.
  const result = {};
  for (const field of LINE_ITEM_FIELDS_V1) {
    result[field] = source[field];
  }
  return result;
}

/**
 * buildHashInput — assembles the canonical JSON object for
 * stableStringify. Single source of truth for the field shape shared
 * between write path (SignQuote handler) and read path (future
 * verifier).
 *
 * Line items are sorted by (sort_order ASC, id ASC) at this layer
 * (belt-and-suspenders; callers SHOULD already ORDER BY at the SQL
 * layer). id is used for tie-break before canonicalization strips it
 * (id is not in LINE_ITEM_FIELDS_V1).
 */
function buildHashInput(version, lineItems) {
  const sortedLineItems = [...lineItems].sort((a, b) => {
    const ao = Number(a.sort_order);
    const bo = Number(b.sort_order);
    if (ao !== bo) return ao - bo;
    // Stable string compare on id for deterministic tie-break. UUIDs are
    // hex-like; localeCompare is the portable choice.
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  return {
    _hash_alg_version: HASH_ALG_VERSION,
    clauses_snapshot: version.clauses_snapshot || {},
    currency: version.currency,
    customer_snapshot: canonicalizeSnapshot(version.customer_snapshot, CUSTOMER_SNAPSHOT_FIELDS_V1),
    deposit_cents: Number(version.deposit_cents),
    human_id: version.human_id,
    line_items: sortedLineItems.map(canonicalizeLineItem),
    payment_terms: version.payment_terms || {},
    project_scope: version.project_scope !== undefined ? version.project_scope : null,
    project_title: version.project_title,
    quote_id: version.quote_id,
    subtotal_cents: Number(version.subtotal_cents),
    tax_cents: Number(version.tax_cents),
    tax_code: version.tax_code !== undefined ? version.tax_code : null,
    tax_rate_bps: Number(version.tax_rate_bps),
    tenant_snapshot: canonicalizeSnapshot(version.tenant_snapshot, TENANT_SNAPSHOT_FIELDS_V1),
    total_cents: Number(version.total_cents),
    version_no: Number(version.version_no),
    warranty_snapshot: version.warranty_snapshot || {},
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

/**
 * computeVersionHash — produces the server_hash value for a quote
 * version. Runs the full canonicalization pipeline:
 *   1. buildHashInput (schema-driven field enumeration, sort, normalize)
 *   2. assertLineItemsSorted
 *   3. assertIntegerNumbers (recursive)
 *   4. stableStringify (recursive lexicographic key order, no whitespace,
 *      nulls preserved)
 *   5. SHA-256 over UTF-8 bytes
 *
 * Returns { hex, canonical }:
 *   - hex is persistent (stored as chiefos_quote_versions.server_hash).
 *   - canonical is transient — available for logging, diffing, and
 *     dispute resolution. Never persisted. Storing canonical alongside
 *     hex would create drift risk and bloat rows.
 *
 * The canonical JSON string IS the signed artifact: dispute resolution
 * uses byte-for-byte comparison of canonical, not just hash comparison.
 */
function computeVersionHash(version, lineItems) {
  const hashInput = buildHashInput(version, lineItems);
  assertLineItemsSorted(hashInput.line_items);
  assertIntegerNumbers(hashInput);
  const canonical = stableStringify(hashInput);
  const hex = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return { hex, canonical };
}

module.exports = {
  HASH_ALG_VERSION,
  computeVersionHash,
  CUSTOMER_SNAPSHOT_FIELDS_V1,
  TENANT_SNAPSHOT_FIELDS_V1,
  LINE_ITEM_FIELDS_V1,
  _internals: {
    buildHashInput,
    assertIntegerNumbers,
    assertLineItemsSorted,
    qtyToThousandths,
    canonicalizeSnapshot,
    canonicalizeLineItem,
  },
};
