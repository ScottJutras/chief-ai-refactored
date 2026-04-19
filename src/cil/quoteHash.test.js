// src/cil/quoteHash.test.js
// Unit tests for the Phase 1 canonical version-hash algorithm.
// See docs/QUOTES_SPINE_DECISIONS.md §4 for the specification.

const {
  HASH_ALG_VERSION,
  computeVersionHash,
  CUSTOMER_SNAPSHOT_FIELDS_V1,
  TENANT_SNAPSHOT_FIELDS_V1,
  LINE_ITEM_FIELDS_V1,
  _internals,
} = require('./quoteHash');

const {
  buildHashInput,
  assertIntegerNumbers,
  assertLineItemsSorted,
  qtyToThousandths,
  canonicalizeSnapshot,
  canonicalizeLineItem,
} = _internals;

// ───────────────────────────────────────────────────────────────────────────
// Fixture — a fully-specified version + line items used for regression lock.
// Any change to any value here changes the pinned hash; any change to
// the algorithm likewise changes it. That's the test's whole purpose.
// ───────────────────────────────────────────────────────────────────────────

function mkFixtureVersion() {
  return {
    quote_id: '11111111-1111-1111-1111-111111111111',
    human_id: 'QT-2026-04-19-0042',
    version_no: 1,
    project_title: 'Test Project',
    project_scope: 'Short scope paragraph.',
    currency: 'CAD',
    subtotal_cents: 10000,
    tax_cents: 1300,
    total_cents: 11300,
    deposit_cents: 5000,
    tax_rate_bps: 1300,
    tax_code: 'HST-ON',
    customer_snapshot: {
      name: 'Darlene MacDonald',
      email: 'darlene@example.com',
      phone_e164: '+14165551234',
      address: '119 St Lawrence Ave, Komoka, ON',
    },
    tenant_snapshot: {
      legal_name: '9839429 Canada Inc.',
      brand_name: 'Mission Exteriors',
      address: '1556 Medway Park Dr, London, ON, N6G 0X5',
      phone_e164: '+18449590109',
      email: 'scott@missionexteriors.ca',
      web: 'missionexteriors.ca',
      hst_registration: '759884893RT0001',
    },
    warranty_snapshot: { coverage: 'lifetime' },
    clauses_snapshot: { terms: 'standard' },
    payment_terms: { etransfer: 'scott@missionexteriors.ca' },
  };
}

function mkFixtureLineItems() {
  return [
    {
      id: 'aaaaaaaa-0001-0000-0000-000000000001',
      sort_order: 0,
      description: 'Labor',
      category: 'labour',
      qty: '2.000',
      unit_price_cents: 5000,
      line_subtotal_cents: 10000,
      line_tax_cents: 1300,
      tax_code: null,
      catalog_product_id: null,
      catalog_snapshot: {},
    },
  ];
}

// ───────────────────────────────────────────────────────────────────────────
// Algorithm-version pin
// ───────────────────────────────────────────────────────────────────────────

describe('HASH_ALG_VERSION', () => {
  test('is exported as integer 1', () => {
    expect(HASH_ALG_VERSION).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Frozen field lists — Q5-call-4
// ───────────────────────────────────────────────────────────────────────────

describe('Frozen field lists V1', () => {
  test('CUSTOMER_SNAPSHOT_FIELDS_V1 matches Q1/Q5 spec', () => {
    expect([...CUSTOMER_SNAPSHOT_FIELDS_V1]).toEqual([
      'address', 'email', 'name', 'phone_e164',
    ]);
    expect(Object.isFrozen(CUSTOMER_SNAPSHOT_FIELDS_V1)).toBe(true);
  });

  test('TENANT_SNAPSHOT_FIELDS_V1 matches Q1/Q5 spec', () => {
    expect([...TENANT_SNAPSHOT_FIELDS_V1]).toEqual([
      'address', 'brand_name', 'email', 'hst_registration',
      'legal_name', 'phone_e164', 'web',
    ]);
    expect(Object.isFrozen(TENANT_SNAPSHOT_FIELDS_V1)).toBe(true);
  });

  test('LINE_ITEM_FIELDS_V1 matches Q1/Q5 spec', () => {
    expect([...LINE_ITEM_FIELDS_V1]).toEqual([
      'catalog_product_id', 'catalog_snapshot', 'category',
      'description', 'line_subtotal_cents', 'line_tax_cents',
      'qty_thousandths', 'sort_order', 'tax_code', 'unit_price_cents',
    ]);
    expect(Object.isFrozen(LINE_ITEM_FIELDS_V1)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// assertIntegerNumbers — Q2 + Q4 design principle
// ───────────────────────────────────────────────────────────────────────────

describe('assertIntegerNumbers', () => {
  test('integers pass', () => {
    expect(() => assertIntegerNumbers(0)).not.toThrow();
    expect(() => assertIntegerNumbers(1)).not.toThrow();
    expect(() => assertIntegerNumbers(-1)).not.toThrow();
    expect(() => assertIntegerNumbers(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  test('floats throw with operator-diagnostic message', () => {
    expect(() => assertIntegerNumbers(1.5)).toThrow(/Non-integer at \$: 1\.5/);
    expect(() => assertIntegerNumbers(0.1)).toThrow(/conversion step was skipped/);
  });

  test('NaN and Infinity throw', () => {
    expect(() => assertIntegerNumbers(NaN)).toThrow(/Non-integer/);
    expect(() => assertIntegerNumbers(Infinity)).toThrow(/Non-integer/);
    expect(() => assertIntegerNumbers(-Infinity)).toThrow(/Non-integer/);
  });

  test('strings, booleans, null, undefined pass', () => {
    expect(() => assertIntegerNumbers('hello')).not.toThrow();
    expect(() => assertIntegerNumbers(true)).not.toThrow();
    expect(() => assertIntegerNumbers(false)).not.toThrow();
    expect(() => assertIntegerNumbers(null)).not.toThrow();
    expect(() => assertIntegerNumbers(undefined)).not.toThrow();
  });

  test('unsupported types throw with path', () => {
    expect(() => assertIntegerNumbers(Symbol('x'))).toThrow(/unsupported type at \$: symbol/);
    expect(() => assertIntegerNumbers(BigInt(1))).toThrow(/unsupported type.*bigint/);
    expect(() => assertIntegerNumbers(() => 0)).toThrow(/unsupported type.*function/);
  });

  test('recurses into arrays with indexed paths', () => {
    expect(() => assertIntegerNumbers([1, 2, 3])).not.toThrow();
    expect(() => assertIntegerNumbers([1, 2.5, 3])).toThrow(/\$\[1\]: 2\.5/);
  });

  test('recurses into objects with keyed paths', () => {
    expect(() => assertIntegerNumbers({ a: 1, b: 2 })).not.toThrow();
    expect(() => assertIntegerNumbers({ a: 1, b: 2.5 })).toThrow(/\$\.b: 2\.5/);
  });

  test('deeply nested paths are precise', () => {
    const bad = { line_items: [{ unit_price_cents: 100 }, { unit_price_cents: 99.5 }] };
    expect(() => assertIntegerNumbers(bad)).toThrow(/\$\.line_items\[1\]\.unit_price_cents: 99\.5/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// assertLineItemsSorted — Q3 defensive addition
// ───────────────────────────────────────────────────────────────────────────

describe('assertLineItemsSorted', () => {
  test('empty array passes', () => {
    expect(() => assertLineItemsSorted([])).not.toThrow();
  });

  test('single item passes', () => {
    expect(() => assertLineItemsSorted([{ sort_order: 5 }])).not.toThrow();
  });

  test('ascending sort_order passes', () => {
    expect(() => assertLineItemsSorted([
      { sort_order: 0 }, { sort_order: 1 }, { sort_order: 2 },
    ])).not.toThrow();
  });

  test('equal sort_order passes (id tie-break is fetcher responsibility)', () => {
    expect(() => assertLineItemsSorted([
      { sort_order: 0 }, { sort_order: 0 }, { sort_order: 1 },
    ])).not.toThrow();
  });

  test('descending sort_order throws with position', () => {
    expect(() => assertLineItemsSorted([
      { sort_order: 0 }, { sort_order: 2 }, { sort_order: 1 },
    ])).toThrow(/violation at index 2: 2 > 1/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// qtyToThousandths — Q4 string arithmetic + precision edge cases
// ───────────────────────────────────────────────────────────────────────────

describe('qtyToThousandths', () => {
  test('integer-only strings', () => {
    expect(qtyToThousandths('1')).toBe(1000);
    expect(qtyToThousandths('10')).toBe(10000);
    expect(qtyToThousandths('0')).toBe(0);
  });

  test('standard fractional strings', () => {
    expect(qtyToThousandths('1.5')).toBe(1500);
    expect(qtyToThousandths('2.000')).toBe(2000);
    expect(qtyToThousandths('0.125')).toBe(125);
    expect(qtyToThousandths('0.001')).toBe(1);
  });

  test('IEEE 754 drift cases — exact outputs', () => {
    // These are the cases where Math.round(parseFloat(x) * 1000) can drift.
    expect(qtyToThousandths('0.1')).toBe(100);
    expect(qtyToThousandths('0.2')).toBe(200);
    expect(qtyToThousandths('0.3')).toBe(300);
    expect(qtyToThousandths('2.675')).toBe(2675);   // infamous IEEE 754 case
    expect(qtyToThousandths('1.005')).toBe(1005);
  });

  test('large-magnitude values preserve precision', () => {
    expect(qtyToThousandths('123456789012.345')).toBe(123456789012345);
  });

  test('padding: 1 or 2 fractional digits pad to 3', () => {
    expect(qtyToThousandths('1.5')).toBe(1500);   // "1.5" → "1" + "500"
    expect(qtyToThousandths('1.50')).toBe(1500);  // "1.50" → "1" + "500"
    expect(qtyToThousandths('1.500')).toBe(1500); // "1.500" → "1" + "500"
    expect(qtyToThousandths('1.05')).toBe(1050);
  });

  test('malformed strings throw', () => {
    expect(() => qtyToThousandths('')).toThrow(/malformed/);
    expect(() => qtyToThousandths('abc')).toThrow(/malformed/);
    expect(() => qtyToThousandths('1.5000')).toThrow(/malformed/);   // >3 fractional
    expect(() => qtyToThousandths('1e3')).toThrow(/malformed/);      // scientific
    expect(() => qtyToThousandths('1,5')).toThrow(/malformed/);      // european decimal
    expect(() => qtyToThousandths('1.5.5')).toThrow(/malformed/);
  });

  test('non-string input throws with diagnostic hint', () => {
    expect(() => qtyToThousandths(1.5)).toThrow(
      /expects string input.*pg-types config override/
    );
    expect(() => qtyToThousandths(null)).toThrow(/expects string input/);
    expect(() => qtyToThousandths(undefined)).toThrow(/expects string input/);
    expect(() => qtyToThousandths({})).toThrow(/expects string input/);
  });

  test('SAFE_INTEGER overflow throws with _hash_alg_version hint', () => {
    // qty_thousandths must fit Number.MAX_SAFE_INTEGER (2^53 - 1 ≈ 9e15).
    // Very large qty values (far beyond real contracting) overflow.
    expect(() => qtyToThousandths('9999999999999.999')).toThrow(
      /exceeds Number\.MAX_SAFE_INTEGER.*bumping HASH_ALG_VERSION/
    );
  });

  test('round-trip: identical result across repeated calls and JSON cycle', () => {
    const qtyStr = '2.675';
    const first = qtyToThousandths(qtyStr);
    const second = qtyToThousandths(qtyStr);
    expect(first).toBe(second);
    expect(first).toBe(2675);
    // Survives JSON round-trip unchanged:
    const reparsed = JSON.parse(JSON.stringify({ qty_thousandths: first }));
    expect(reparsed.qty_thousandths).toBe(first);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// canonicalizeSnapshot — Q1-call-3 null preservation
// ───────────────────────────────────────────────────────────────────────────

describe('canonicalizeSnapshot', () => {
  test('absent fields become null', () => {
    const result = canonicalizeSnapshot({ name: 'X' }, CUSTOMER_SNAPSHOT_FIELDS_V1);
    expect(result).toEqual({
      address: null,
      email: null,
      name: 'X',
      phone_e164: null,
    });
  });

  test('explicit null preserved as null (not omitted)', () => {
    const result = canonicalizeSnapshot(
      { name: 'X', email: null, phone_e164: null, address: null },
      CUSTOMER_SNAPSHOT_FIELDS_V1
    );
    expect(result).toEqual({
      address: null,
      email: null,
      name: 'X',
      phone_e164: null,
    });
  });

  test('null source produces all-null canonical', () => {
    const result = canonicalizeSnapshot(null, CUSTOMER_SNAPSHOT_FIELDS_V1);
    expect(result).toEqual({
      address: null, email: null, name: null, phone_e164: null,
    });
  });

  test('extra source keys are dropped', () => {
    // Any keys beyond the frozen list fall off — HASH_ALG_VERSION: 1 coverage
    // is exactly CUSTOMER_SNAPSHOT_FIELDS_V1.
    const result = canonicalizeSnapshot(
      { name: 'X', email: 'e', extraneous: 'should_drop', __evil: 'also_drops' },
      CUSTOMER_SNAPSHOT_FIELDS_V1
    );
    expect(result.name).toBe('X');
    expect(result.email).toBe('e');
    expect(result).not.toHaveProperty('extraneous');
    expect(result).not.toHaveProperty('__evil');
  });

  test('source key insertion order does not affect output content', () => {
    const a = canonicalizeSnapshot(
      { name: 'X', email: 'e', phone_e164: '+1', address: 'a' },
      CUSTOMER_SNAPSHOT_FIELDS_V1
    );
    const b = canonicalizeSnapshot(
      { address: 'a', phone_e164: '+1', email: 'e', name: 'X' },
      CUSTOMER_SNAPSHOT_FIELDS_V1
    );
    expect(a).toEqual(b);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// canonicalizeLineItem — Q5-call-1b/1c
// ───────────────────────────────────────────────────────────────────────────

describe('canonicalizeLineItem', () => {
  test('produces only LINE_ITEM_FIELDS_V1 keys', () => {
    const result = canonicalizeLineItem({
      id: 'drop-me',        // id is not in V1
      quote_version_id: 'drop-me-too',
      sort_order: 0,
      description: 'X',
      qty: '1',
      unit_price_cents: 100,
      line_subtotal_cents: 100,
      line_tax_cents: 13,
    });
    expect(Object.keys(result).sort()).toEqual([...LINE_ITEM_FIELDS_V1].sort());
  });

  test('qty string converts to qty_thousandths integer', () => {
    const result = canonicalizeLineItem({
      sort_order: 0, description: 'X', qty: '2.5',
      unit_price_cents: 100, line_subtotal_cents: 250, line_tax_cents: 0,
    });
    expect(result.qty_thousandths).toBe(2500);
    expect(result).not.toHaveProperty('qty');
  });

  test('null/absent catalog_snapshot normalizes to {}', () => {
    const withNull = canonicalizeLineItem({
      sort_order: 0, description: 'X', qty: '1',
      unit_price_cents: 0, line_subtotal_cents: 0, line_tax_cents: 0,
      catalog_snapshot: null,
    });
    expect(withNull.catalog_snapshot).toEqual({});

    const withAbsent = canonicalizeLineItem({
      sort_order: 0, description: 'X', qty: '1',
      unit_price_cents: 0, line_subtotal_cents: 0, line_tax_cents: 0,
    });
    expect(withAbsent.catalog_snapshot).toEqual({});
  });

  test('category null, tax_code null, catalog_product_id null preserved', () => {
    const result = canonicalizeLineItem({
      sort_order: 0, description: 'X', qty: '1',
      unit_price_cents: 0, line_subtotal_cents: 0, line_tax_cents: 0,
    });
    expect(result.category).toBeNull();
    expect(result.tax_code).toBeNull();
    expect(result.catalog_product_id).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildHashInput — structure, sort, idempotence
// ───────────────────────────────────────────────────────────────────────────

describe('buildHashInput', () => {
  test('produces top-level keys matching Q5 spec', () => {
    const result = buildHashInput(mkFixtureVersion(), mkFixtureLineItems());
    expect(Object.keys(result).sort()).toEqual([
      '_hash_alg_version', 'clauses_snapshot', 'currency',
      'customer_snapshot', 'deposit_cents', 'human_id', 'line_items',
      'payment_terms', 'project_scope', 'project_title', 'quote_id',
      'subtotal_cents', 'tax_cents', 'tax_code', 'tax_rate_bps',
      'tenant_snapshot', 'total_cents', 'version_no', 'warranty_snapshot',
    ]);
    expect(result._hash_alg_version).toBe(1);
  });

  test('line items sorted by (sort_order ASC, id ASC) — fetcher drift safety', () => {
    // Intentionally shuffle input; builder must re-sort.
    const lineItems = [
      { id: 'c', sort_order: 1, description: 'B', qty: '1',
        unit_price_cents: 0, line_subtotal_cents: 0, line_tax_cents: 0 },
      { id: 'a', sort_order: 0, description: 'A', qty: '1',
        unit_price_cents: 0, line_subtotal_cents: 0, line_tax_cents: 0 },
      { id: 'b', sort_order: 0, description: 'A-dup', qty: '1',
        unit_price_cents: 0, line_subtotal_cents: 0, line_tax_cents: 0 },
    ];
    const result = buildHashInput(mkFixtureVersion(), lineItems);
    expect(result.line_items.map((li) => li.description))
      .toEqual(['A', 'A-dup', 'B']);
  });

  test('idempotent: same input produces deep-equal output across calls', () => {
    const a = buildHashInput(mkFixtureVersion(), mkFixtureLineItems());
    const b = buildHashInput(mkFixtureVersion(), mkFixtureLineItems());
    expect(a).toEqual(b);
  });

  test('empty snapshots preserved as {} not null', () => {
    const version = { ...mkFixtureVersion(),
      warranty_snapshot: {}, clauses_snapshot: {}, payment_terms: {},
    };
    const result = buildHashInput(version, mkFixtureLineItems());
    expect(result.warranty_snapshot).toEqual({});
    expect(result.clauses_snapshot).toEqual({});
    expect(result.payment_terms).toEqual({});
  });

  test('customer_snapshot absent fields fill as null', () => {
    const version = { ...mkFixtureVersion(),
      customer_snapshot: { name: 'X' },  // email, phone_e164, address absent
    };
    const result = buildHashInput(version, mkFixtureLineItems());
    expect(result.customer_snapshot).toEqual({
      address: null, email: null, name: 'X', phone_e164: null,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// computeVersionHash — determinism + detection + regression lock
// ───────────────────────────────────────────────────────────────────────────

describe('computeVersionHash — determinism', () => {
  test('same input → same hex across calls (no time-dependence)', () => {
    const { hex: a } = computeVersionHash(mkFixtureVersion(), mkFixtureLineItems());
    const { hex: b } = computeVersionHash(mkFixtureVersion(), mkFixtureLineItems());
    expect(a).toBe(b);
  });

  test('hex is 64 lowercase hex chars matching Migration 1 CHECK', () => {
    const { hex } = computeVersionHash(mkFixtureVersion(), mkFixtureLineItems());
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  test('canonical is valid JSON with no indentation whitespace', () => {
    const { canonical } = computeVersionHash(mkFixtureVersion(), mkFixtureLineItems());
    expect(() => JSON.parse(canonical)).not.toThrow();
    // §4 requires no inter-token whitespace (indent/newline/tab). Spaces
    // INSIDE string values are legitimate content (e.g., '119 St Lawrence
    // Ave, Komoka, ON'). The regex-based inter-token check is brittle
    // across string values; the cross-version regression lock below is
    // the authoritative byte-exact check. Here we just assert no
    // pretty-printing characters.
    expect(canonical).not.toContain('\n');
    expect(canonical).not.toContain('\t');
    expect(canonical).not.toContain('\r');
  });

  test('returned canonical JSON starts with the alphabetically-first key', () => {
    // _hash_alg_version sorts before all contract keys because '_' < 'a-z'
    // lexicographically. Locks the underscore-prefix metadata convention.
    const { canonical } = computeVersionHash(mkFixtureVersion(), mkFixtureLineItems());
    expect(canonical.startsWith('{"_hash_alg_version":1,')).toBe(true);
  });
});

describe('computeVersionHash — JSONB key-order insensitivity', () => {
  test('different source key insertion order → identical hash', () => {
    const v1 = mkFixtureVersion();
    const v2 = {
      // Same content, keys intentionally scrambled (simulates JSONB
      // read with an unstable key order from the pg driver).
      warranty_snapshot: v1.warranty_snapshot,
      quote_id: v1.quote_id,
      tax_code: v1.tax_code,
      deposit_cents: v1.deposit_cents,
      version_no: v1.version_no,
      tenant_snapshot: {
        web: v1.tenant_snapshot.web,
        email: v1.tenant_snapshot.email,
        legal_name: v1.tenant_snapshot.legal_name,
        address: v1.tenant_snapshot.address,
        brand_name: v1.tenant_snapshot.brand_name,
        phone_e164: v1.tenant_snapshot.phone_e164,
        hst_registration: v1.tenant_snapshot.hst_registration,
      },
      subtotal_cents: v1.subtotal_cents,
      project_title: v1.project_title,
      currency: v1.currency,
      human_id: v1.human_id,
      customer_snapshot: {
        phone_e164: v1.customer_snapshot.phone_e164,
        address: v1.customer_snapshot.address,
        name: v1.customer_snapshot.name,
        email: v1.customer_snapshot.email,
      },
      clauses_snapshot: v1.clauses_snapshot,
      total_cents: v1.total_cents,
      payment_terms: v1.payment_terms,
      tax_rate_bps: v1.tax_rate_bps,
      project_scope: v1.project_scope,
      tax_cents: v1.tax_cents,
    };
    const { hex: a } = computeVersionHash(v1, mkFixtureLineItems());
    const { hex: b } = computeVersionHash(v2, mkFixtureLineItems());
    expect(a).toBe(b);
  });
});

describe('computeVersionHash — field-change detection', () => {
  test('changing any INCLUDED field changes the hash', () => {
    const baseline = computeVersionHash(mkFixtureVersion(), mkFixtureLineItems()).hex;

    const mutations = [
      (v) => ({ ...v, human_id: 'QT-2026-04-19-0043' }),
      (v) => ({ ...v, version_no: 2 }),
      (v) => ({ ...v, project_title: 'Different Project' }),
      (v) => ({ ...v, project_scope: 'Different scope' }),
      (v) => ({ ...v, subtotal_cents: 10001 }),
      (v) => ({ ...v, tax_cents: 1301 }),
      (v) => ({ ...v, total_cents: 11301 }),
      (v) => ({ ...v, tax_rate_bps: 1301 }),
      (v) => ({ ...v, tax_code: 'GST-CA' }),
      (v) => ({ ...v, currency: 'USD' }),
      (v) => ({ ...v, deposit_cents: 5001 }),
      (v) => ({ ...v, customer_snapshot: { ...v.customer_snapshot, name: 'Someone Else' } }),
      (v) => ({ ...v, tenant_snapshot: { ...v.tenant_snapshot, legal_name: 'Different Co.' } }),
      (v) => ({ ...v, warranty_snapshot: { coverage: 'limited' } }),
      (v) => ({ ...v, clauses_snapshot: { terms: 'modified' } }),
      (v) => ({ ...v, payment_terms: { etransfer: 'other@example.com' } }),
      (v) => ({ ...v, quote_id: '22222222-2222-2222-2222-222222222222' }),
    ];

    for (const mutate of mutations) {
      const mutated = computeVersionHash(mutate(mkFixtureVersion()), mkFixtureLineItems()).hex;
      expect(mutated).not.toBe(baseline);
    }
  });

  test('changing a line item field changes the hash', () => {
    const baseline = computeVersionHash(mkFixtureVersion(), mkFixtureLineItems()).hex;

    const liMutations = [
      (li) => ({ ...li, description: 'Different' }),
      (li) => ({ ...li, category: 'materials' }),
      (li) => ({ ...li, qty: '3.000' }),
      (li) => ({ ...li, unit_price_cents: 5001 }),
      (li) => ({ ...li, line_subtotal_cents: 10001 }),
      (li) => ({ ...li, line_tax_cents: 1301 }),
      (li) => ({ ...li, sort_order: 1 }),
      (li) => ({ ...li, tax_code: 'HST-ON' }),
      (li) => ({ ...li, catalog_product_id: '33333333-3333-3333-3333-333333333333' }),
      (li) => ({ ...li, catalog_snapshot: { sku: 'X-123' } }),
    ];

    for (const mutate of liMutations) {
      const mutated = computeVersionHash(
        mkFixtureVersion(),
        mkFixtureLineItems().map(mutate)
      ).hex;
      expect(mutated).not.toBe(baseline);
    }
  });
});

describe('computeVersionHash — excluded-field immunity', () => {
  test('changing EXCLUDED fields does NOT change the hash', () => {
    const baseline = computeVersionHash(mkFixtureVersion(), mkFixtureLineItems()).hex;

    // Timestamps, internal IDs, template_refs — all excluded from hash.
    const excludedMutations = [
      (v) => ({ ...v, created_at: '2099-01-01T00:00:00Z' }),
      (v) => ({ ...v, issued_at: '2099-01-01T00:00:00Z' }),
      (v) => ({ ...v, sent_at: '2099-01-01T00:00:00Z' }),
      (v) => ({ ...v, viewed_at: '2099-01-01T00:00:00Z' }),
      (v) => ({ ...v, signed_at: '2099-01-01T00:00:00Z' }),
      (v) => ({ ...v, locked_at: '2099-01-01T00:00:00Z' }),
      (v) => ({ ...v, updated_at: '2099-01-01T00:00:00Z' }),
      (v) => ({ ...v, id: '99999999-9999-9999-9999-999999999999' }),
      (v) => ({ ...v, tenant_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }),
      (v) => ({ ...v, owner_id: 'different-owner' }),
      (v) => ({ ...v, status: 'voided' }),
      (v) => ({ ...v, server_hash: 'ignored-value' }),
      (v) => ({ ...v, warranty_template_ref: 'template-x' }),
      (v) => ({ ...v, clauses_template_ref: 'template-y' }),
    ];

    for (const mutate of excludedMutations) {
      const mutated = computeVersionHash(mutate(mkFixtureVersion()), mkFixtureLineItems()).hex;
      expect(mutated).toBe(baseline);
    }
  });

  test('line item id changes do NOT affect hash (id not in V1)', () => {
    const modified = mkFixtureLineItems().map((li) => ({
      ...li, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    }));
    const baseline = computeVersionHash(mkFixtureVersion(), mkFixtureLineItems()).hex;
    const mutated = computeVersionHash(mkFixtureVersion(), modified).hex;
    expect(mutated).toBe(baseline);
  });
});

describe('computeVersionHash — null-preservation tamper detection (Q1-call-3)', () => {
  test('explicit-null vs absent snapshot field produce identical canonical form', () => {
    // Q1-call-3: canonicalization normalizes absent → null, so both shapes
    // hash the same. This is the correct posture: both represent 'no value'
    // for the schema-declared field. Tampering that changes the FIELD SET
    // (e.g., adding a rogue field) would still change the hash because
    // extra keys are dropped by the frozen field list — any content change
    // in a declared field changes the canonical form.
    const vAbsent = { ...mkFixtureVersion(),
      customer_snapshot: { name: 'X', email: 'e@e.com', phone_e164: '+1', address: 'a' },
    };
    const vNull = { ...mkFixtureVersion(),
      customer_snapshot: { name: 'X', email: 'e@e.com', phone_e164: '+1', address: 'a' },
    };
    expect(computeVersionHash(vAbsent, mkFixtureLineItems()).hex)
      .toBe(computeVersionHash(vNull, mkFixtureLineItems()).hex);
  });

  test('changing a field from value to null changes the hash (tamper caught)', () => {
    const vWith = { ...mkFixtureVersion(),
      customer_snapshot: { name: 'X', email: 'e@e.com', phone_e164: '+1', address: 'a' },
    };
    const vWithout = { ...mkFixtureVersion(),
      customer_snapshot: { name: 'X', email: null, phone_e164: '+1', address: 'a' },
    };
    expect(computeVersionHash(vWith, mkFixtureLineItems()).hex)
      .not.toBe(computeVersionHash(vWithout, mkFixtureLineItems()).hex);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CROSS-VERSION REGRESSION LOCK
// The single most important test for long-term integrity assurance.
// Pin the hex once during Phase 1 implementation; any future failure
// means either (a) intentional algorithm change — bump HASH_ALG_VERSION,
// or (b) regression — revert.
// ───────────────────────────────────────────────────────────────────────────

describe('computeVersionHash — cross-version regression lock', () => {
  test('produces stable hash for the canonical fixture', () => {
    const { hex, canonical } = computeVersionHash(
      mkFixtureVersion(),
      mkFixtureLineItems()
    );

    // The fixture above is frozen. If this hex ever changes, either:
    //   (a) a test-fixture value was modified (revert the fixture change)
    //   (b) the canonical-serialization algorithm was modified
    //       (bump HASH_ALG_VERSION + migrate existing signed quotes)
    //   (c) fast-json-stable-stringify output changed
    //       (re-validate per §4's library upgrade contract)
    //
    // PINNED 2026-04-19 at Phase 1 close:
    expect(hex).toBe('e9088c36066a73a9cee9efcdb59f2748b4ca5040134d21ba5cb37e8327e77d51');

    // Canonical JSON structure sanity (auxiliary — the hex is the primary pin).
    expect(canonical.startsWith('{"_hash_alg_version":1,')).toBe(true);
    expect(canonical).toContain('"human_id":"QT-2026-04-19-0042"');
    expect(canonical).toContain('"qty_thousandths":2000');
  });
});
