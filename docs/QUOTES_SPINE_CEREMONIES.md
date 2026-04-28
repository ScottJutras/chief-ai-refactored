# Quote Spine Ceremony Archives

Production-exercise ceremony artifacts for Quote spine handlers.
Each top-level §N entry documents a real production run, captured
values, and anomaly-stop check outcomes. Active architectural
patterns referenced by these ceremonies live in
`docs/QUOTES_SPINE_DECISIONS.md`.

Sectioning: §27 SignQuote, §28 ViewQuote, §29 reserved (cross-quote
pointer enforcement), §30 LockQuote, §31 expected VoidQuote,
§32 expected ReissueQuote.

Section-number convention: numbers persist across the
DECISIONS↔CEREMONIES split. §27 has always been and will always
be §27, regardless of which file holds it.

---

## §27. Phase 3 ceremony — SignQuote exercised against production (2026-04-21)

**Status.** Phase 3's final section. Production ceremony proving
`handleSignQuote` (the 23-step SignQuote orchestration from Section 5)
executes end-to-end against real Postgres + Supabase Storage. First
customer-initiated CIL handler exercised in production. Parallels §22
(SendQuote) and §26 (Phase 2C Storage ceremony).

### Scope

Match-path only (signer_name matches share_token.recipient_name →
`name_match_at_sign=true`; no `integrity.name_mismatch_signed` event
emitted). Mismatch path is covered by Section 5 unit tests. Ceremony's
job is proving the full chain works against production, not exercising
every branch.

### Ceremony identity

| Field | Value |
|---|---|
| tenant_id         | `00000000-c3c3-c3c3-c3c3-000000000001` |
| owner_id          | `00000000001` |
| quote_id          | `00000000-c3c3-c3c3-c3c3-000000000002` |
| version_id        | `00000000-c3c3-c3c3-c3c3-000000000003` |
| line_item_id      | `00000000-c3c3-c3c3-c3c3-0000000000a1` |
| share_token_id    | `00000000-c3c3-c3c3-c3c3-000000000005` |
| synthetic_sent_event_id | `00000000-c3c3-c3c3-c3c3-000000000007` |
| share_token       | `SjBkxvAvPEx8CX3UFJ6mrT` (deterministic from seed) |
| human_id          | `QT-CEREMONY-2026-04-21-PHASE3` |
| project_title     | `Phase 3 SignQuote Ceremony` |
| job_id            | `1740` (allocated by jobs.id serial) |

The `c3c3-c3c3-c3c3` hex namespace distinguishes Phase 3 ceremony rows
from Phase 2C's `c2c2-c2c2-c2c2`.

### Fixture PNG

- Shape: real 1×1 grayscale with `tEXt` "Description" = "ChiefOS Phase 3
  SignQuote ceremony fixture - 2026-04-21"
- Size: 146 bytes (deterministic across reruns)
- SHA-256: `3bf500c9f868709756de44da89da7151e741a54c84eaad1edd64c6fb8c52935b`

Four-way SHA confirmation: fixture bytes (computed at script load) =
signature_png_sha256 (DB row) = portal retrieve downloaded SHA = public
retrieve downloaded SHA.

### Handler-generated artifacts

| Field | Value |
|---|---|
| signature_id         | `8b9b982d-6268-4da8-b25e-5cf29228d197` |
| signed_event_id      | `9245f83d-ed77-4a2c-bc35-9d68a036c07a` |
| correlation_id       | `06cc4c9e-6406-4ffe-8de3-40f5c0af362d` |
| signed_at (signature row) | `2026-04-21T10:40:46.700808Z` |
| version.locked_at    | `2026-04-21T10:40:46.700808Z` |
| version.signed_at    | `2026-04-21T10:40:46.700808Z` |
| quote.updated_at     | `2026-04-21T10:40:46.700808Z` |

All four state-transition timestamps share a single transaction_timestamp
(NOW() inside a transaction returns the transaction start time) — txn-
coherent.

### Server hash — first Phase-1-to-Phase-3 integration artifact

**`server_hash = 1e12cc5287c6edc79c9990a3aee47dab30598ddafea0816ea25b058e8b648485`**

This hex is the SHA-256 of Phase 1's canonical serialization of the
ceremony version + line items. Pinning this value in §27 means any
future regression against this ceremony's version rows must produce
this exact hash. Changes to `computeVersionHash` (requiring a new
`_hash_alg_version` per Phase 1's discipline) would produce a different
value; the §27 pin detects such drift.

The hash is written to three places in a single transaction:
- `chiefos_quote_signatures.version_hash_at_sign` (forensic residue)
- `chiefos_quote_versions.server_hash` (version's permanent record)
- `chiefos_quote_events.payload->>'version_hash_at_sign'` on the
  lifecycle.signed event (redundant carrier for event-stream self-
  sufficiency)

### Storage key (170 chars exactly)

```
chiefos-signatures/00000000-c3c3-c3c3-c3c3-000000000001/00000000-c3c3-c3c3-c3c3-000000000002/00000000-c3c3-c3c3-c3c3-000000000003/8b9b982d-6268-4da8-b25e-5cf29228d197.png
```

Matches `SIGNATURE_STORAGE_KEY_RE` (app-layer) and Migration 6's DB
CHECK constraint byte-for-byte. Object verified present in bucket:
size 146 bytes, mime `image/png`.

### Events chain (ordered by global_seq)

| seq | kind | correlation_id | emitted_at | notes |
|---|---|---|---|---|
| 1505 | `lifecycle.sent` | NULL | 10:40:32 | seed-inserted (synthetic); `payload.ceremony_synthetic=true` |
| 1506 | `lifecycle.signed` | `06cc4c9e-…362d` | 10:40:43 | handler step 14; `payload.version_hash_at_sign` present |
| 1507 | `notification.sent` | **same** `06cc4c9e-…362d` | 10:40:43 | handler step 22; `payload.provider_message_id = 37336e10-…7a2a` |

**Two consecutive handler-emitted events share the correlation_id — first
production validation of DB3 Q3.6 wiring.** A single
`SELECT … WHERE correlation_id = '06cc4c9e-…362d'` returns the two
events that form the complete execution trace of this SignQuote call.
The synthetic lifecycle.sent event (seed-inserted) carries NULL
correlation_id, correctly reflecting that it wasn't part of this
handler invocation.

### Postmark dispatch

- Recipient: `scott.tirakian@gmail.com` (same target as Mission §22;
  consistency aids future email archaeology)
- MessageID: `37336e10-0bd5-43f3-9b2d-e31f73ff7a2a`
- Email content: contractor confirmation with name-match status line
  ("MATCHED") and full signature metadata

### What Phase 3 validated that prior sections could not

- **First production emission of correlation_id** on
  `chiefos_quote_events`. SendQuote's existing helpers leave NULL
  (pre-Phase-3); SignQuote wires. §17.21 formalizes the pattern and
  documents the SendQuote asymmetry.
- **First production integration of Phase 1's `computeVersionHash`**
  with a real quote's version row + line items. Pinned hex
  `1e12cc52…8485` is the cross-phase integration artifact.
- **First strict-immutable signature row** committed in production.
  Migration 4's strict-immutability trigger exercised — no UPDATE
  attempted or permitted by handler code.
- **First §17.20 exercise**: pre-BEGIN external write (PNG upload) →
  post-BEGIN INSERT (signature row), with cleanup-on-txn-failure
  posture per §25.6 Direction A. Inversion of §17.19's post-commit
  pattern is correct for strict-immutable target tables.
- **First customer-initiated CIL handler** in production. `actor.role =
  'customer'` validated against BaseCILZ via `.omit({ actor: true })
  .extend(...)` pattern (formalized below as §14.11).

### Formalizations landing in this session close

| Principle | Section | Status |
|---|---|---|
| Post-commit paired notification events | §17.19 | Second exercise formalizes (proposed by §22) |
| Pre-BEGIN external write for strict-immutable INSERT | §17.20 | Introduced |
| correlation_id wiring + SendQuote asymmetry | §17.21 | Introduced |
| Invariant-assertion discipline | §17.22 | Introduced |
| Customer-initiated actor role (auth-orthogonal) | §14.11 | Introduced |
| Customer-initiated actions not plan-gated | §14.12 | Introduced |
| NAME_MATCH_RULE_ID in event payload | §11a refinement | Added |

### Retention posture

Fixture + ceremony rows retained per §25.6 indefinite-retention default
and §26 precedent. Manual cleanup query (documented, not committed):

```sql
DELETE FROM chiefos_quote_signatures     WHERE tenant_id = '00000000-c3c3-c3c3-c3c3-000000000001';
DELETE FROM chiefos_quote_events         WHERE tenant_id = '00000000-c3c3-c3c3-c3c3-000000000001';
DELETE FROM chiefos_quote_share_tokens   WHERE tenant_id = '00000000-c3c3-c3c3-c3c3-000000000001';
DELETE FROM chiefos_quote_line_items     WHERE tenant_id = '00000000-c3c3-c3c3-c3c3-000000000001';
DELETE FROM chiefos_quote_versions       WHERE tenant_id = '00000000-c3c3-c3c3-c3c3-000000000001';
DELETE FROM chiefos_quotes               WHERE tenant_id = '00000000-c3c3-c3c3-c3c3-000000000001';
DELETE FROM jobs                         WHERE owner_id = '00000000001' AND job_name = 'Phase 3 Ceremony Job';
DELETE FROM chiefos_tenants              WHERE id = '00000000-c3c3-c3c3-c3c3-000000000001';
DELETE FROM users                        WHERE user_id = '00000000001';
-- Supabase dashboard: delete bucket object at storage_key above.
```

### Findings surfaced by ceremony

**One minor return-shape gap** (fixed in this commit alongside §27):
`handleSignQuote`'s return shape's `signature.storage_key` was null —
`buildSignQuoteReturnShape` reads `sigResult.storageKey` but
`insertSignature` doesn't return that field. The key IS correctly
persisted in DB + bucket (verified via MCP). Fix: handler passes its
local `storageKey` through the composer's `sigResult` parameter.
Regression-lock test added.

Flag for future handler sections: exact-key-match tests on return
shapes (like §25.7's Q7 surface contract) catch field-drop bugs at
unit-test time rather than at ceremony time.

**§27 committed 2026-04-21.** Phase 3 complete. Phase 2 + Phase 3
fully closed. Next session candidates flagged in execution plan.

---

## §28. Phase A Session 2 — ViewQuote exercised against production (2026-04-23)

**Status.** Phase A Session 2's closing ceremony. Production exercise proving
`handleViewQuote` (the 7-step ViewQuote orchestration from Section 4) executes
end-to-end against real Postgres. Second customer-initiated CIL handler
exercised in production (first was SignQuote §27). First handler whose
exclusive idempotency surface is state-driven (§17.23) — no INSERT with 23505
idempotency path.

### Scope

Happy-path only (pre-txn loadViewContext returns sent-state; markQuoteViewed
transitions sent→viewed; emitLifecycleCustomerViewed fires). Already-viewed /
signed / locked paths, share-token-not-found path, draft / voided rejection
paths covered by Section 4's 10 integration tests. Ceremony validates the
chain against production, not each branch.

### Ceremony identity

| Field | Value |
|---|---|
| tenant_id         | `00000000-c4c4-c4c4-c4c4-000000000001` |
| owner_id          | `00000000002` |
| quote_id          | `00000000-c4c4-c4c4-c4c4-000000000002` |
| version_id        | `00000000-c4c4-c4c4-c4c4-000000000003` |
| line_item_id      | `00000000-c4c4-c4c4-c4c4-0000000000a1` |
| share_token_id    | `00000000-c4c4-c4c4-c4c4-000000000005` |
| synthetic_sent_event_id | `00000000-c4c4-c4c4-c4c4-000000000007` |
| share_token       | `HAstYeR6QB8VD9XF7zfRFN` (deterministic from seed v2) |
| human_id          | `QT-CEREMONY-2026-04-23-PHASE-A-S2` |
| project_title     | `Phase A Session 2 ViewQuote Ceremony` |
| job_id            | `3414` (allocated by jobs.id serial) |

The `c4c4-c4c4-c4c4` hex namespace distinguishes Phase A Session 2 ceremony
rows from Phase 3's `c3c3-c3c3-c3c3` and Phase 2C's `c2c2-c2c2-c2c2`.

### Share-token derivation

`HAstYeR6QB8VD9XF7zfRFN` is `bs58.encode(sha256('chiefos-phase-a-session-2-viewquote-ceremony-share-token-seed-v2').subarray(0, 16))`.
Seed version **v2** — v1 derived to 21 characters (the ~2.83% short-output
case documented in §17.22's post-mortem of `generateShareToken`). Migration
3's `chiefos_qst_token_format` CHECK requires exactly 22. Seed iterated until
output was 22 chars; v1 is orphaned and documented here for integrity.

### Seed posture — SQL INSERT, not handler chain

§27 established seeding via explicit INSERT (not `handleCreateQuote` +
`handleSendQuote`). Handlers allocate UUIDs via `crypto.randomUUID()`
internally, incompatible with deterministic c4c4 identity. The Phase A
Session 2 seed follows the same posture — raw INSERTs at c4c4 IDs in
`scripts/ceremony_seed_phase_a_session2.js`.

Seed inserts: user, tenant, job, quote (sent), version (sent, unlocked),
line_item, share_token (unexpired), synthetic lifecycle.sent event with
`payload.ceremony_synthetic=true`. The synthetic event preserves event-
stream chronology; without it, the share_token would appear without a
prior lifecycle.sent anchor.

### Handler-generated artifacts

| Field | Value |
|---|---|
| correlation_id       | `c83f405d-e8e6-4d70-9dd1-f33e0b7a909c` |
| quote.status (before / after) | `sent` / `viewed` |
| version.status (before / after) | `sent` / `viewed` |
| quote.updated_at     | `2026-04-23T12:24:38.513Z` (txn NOW()) |
| version.viewed_at    | `2026-04-23T12:24:38.513Z` (same txn NOW()) |

**Txn-timestamp coherence.** `quote.updated_at === version.viewed_at` —
both are `NOW()` within the same transaction (Postgres returns the
transaction-start timestamp for all `NOW()` calls in a given BEGIN scope).
§17.24 header-first ordering landed both UPDATEs atomically in a single
`pg.withClient` scope.

### Events chain (ordered by global_seq)

| seq | kind | correlation_id | emitted_at | notes |
|---|---|---|---|---|
| 3233 | `lifecycle.sent` | NULL | `12:24:22.867Z` | seed-inserted (synthetic); `payload.ceremony_synthetic=true` |
| 3234 | `lifecycle.customer_viewed` | `c83f405d-…909c` | `12:24:38.388Z` | handler step 6; `payload.source_msg_id` echoed from CIL input |

**Single handler-emitted event per invocation.** Unlike §27's SignQuote
ceremony (which emits two events, lifecycle.signed + notification.sent,
sharing a correlation_id), ViewQuote emits ONE event. §17.21's intra-handler
cross-event correlation_id wiring is trivially satisfied (only one event
to wire). §17.23 state-driven idempotency fills the structural invariant
role that §17.21 cross-event coherence plays for multi-event handlers.

### emitted_at vs. updated_at (intentional 125ms divergence)

`lifecycle.customer_viewed.emitted_at` (`12:24:38.388Z`) precedes
`quote.updated_at` (`12:24:38.513Z`) by 125 ms. This is intentional, not a
drift:

- `emitted_at` is populated from `data.occurred_at` in the CIL input —
  when the customer clicked the share link (client-perceived event time).
- `quote.updated_at` is `NOW()` inside the handler's transaction —
  when the server committed the state flip.

Matches SendQuote and SignQuote precedents. `emitted_at` is the customer's
event clock; `updated_at` is the server's commit clock. Gap reflects
handler execution time (network + parse + load + txn BEGIN).

### source_msg_id payload echo

`lifecycle.customer_viewed.payload.source_msg_id = 'ceremony-phase-a-s2-viewquote-run-1'`
(matches CIL input). First production exercise of §17.25 echo-if-present
posture — helper uses strict `!== undefined` to pass through, does not
filter or fabricate.

### What Phase A Session 2 validated that prior sections could not

- **First production exercise of state-driven idempotency (§17.23).**
  ViewQuote has no INSERT-with-natural-unique-constraint idempotency
  surface; retries on viewed/signed/locked quotes take the
  `alreadyViewedReturnShape` pre-txn routing branch. The ceremony
  exercises the first-invocation happy-path; re-running without re-seeding
  exercises the already-viewed retry branch, validating the state-read-
  enforced idempotency pattern.
- **First production header-first dual-row transition (§17.24).**
  `markQuoteViewed` flips `chiefos_quotes.status` and
  `chiefos_quote_versions.status` in sequence, both predicated on
  `status='sent'`. SignQuote's `updateQuoteSigned` + `updateVersionLocked`
  are two separate helpers for distinct concerns (version lock, header
  signed) — ViewQuote's symmetric dual-row flip is cleaner.
- **First production exercise of echo-if-present posture (§17.25).**
  The `payload.source_msg_id` field is an audit-only passthrough when
  Zod-optional fields reach helpers. Strict `!== undefined` keeps Zod
  contract violations visible rather than masking them.
- **First production demonstration that §17.21 cross-event correlation_id
  scales down to single-event handlers.** ViewQuote emits only one event
  per call, but the correlation_id wiring discipline still applies:
  `meta.correlation_id === lifecycle.customer_viewed.correlation_id`.
  Pinning this relationship matters for future multi-event ViewQuote
  successors (e.g., a hypothetical RejectQuote emitting lifecycle.rejected
  + notification.sent).

### Anomaly-stop validation (ran before documentation)

The ceremony runner (`scripts/real_view_quote_ceremony.js`) executes 10
inline anomaly checks before writing §28:
1. `events_emitted` exactly `['lifecycle.customer_viewed']`
2. `meta.already_existed === false`
3. `meta.correlation_id` UUID-shaped and non-null
4. `result.quote.status === 'viewed'`
5. `result.version.status === 'viewed'`
6. `lifecycle.customer_viewed` event count === 1
7. `lifecycle.customer_viewed` event row's `correlation_id === meta.correlation_id`
8. `payload.source_msg_id === CIL input's source_msg_id`
9. `quote.updated_at === version.viewed_at` (single-txn coherence)
10. Post-state: `quote.status === 'viewed' AND version.status === 'viewed'` at DB

All 10 passed. No anomalies. Documentation proceeded.

### Formalizations landing in this session close

| Principle | Section | Status |
|---|---|---|
| State-driven idempotency (bundled with post-rollback re-read recovery) | §17.23 | Introduced (first exerciser: ViewQuote) |
| Header-first ordering for dual-row state transitions | §17.24 | Introduced (first exerciser: markQuoteViewed) |
| Echo-if-present posture for Zod-optional audit fields | §17.25 | Introduced (first exerciser: emitLifecycleCustomerViewed) |
| Co-transition between header and version status; voided asymmetry | §3A | Amended (supersedes handoff narrative "§3.3" references) |
| SendQuote markQuoteSent version.status leak fix | commit `0dedea58` | Landed pre-ceremony (discovered during Section 4; regression-locked in SendQuote Section 7) |

Composition note: the handoff proposed four §17.N subsections (state-driven
idempotency, post-rollback re-read, header-first ordering, echo-if-present).
Composition review bundled the first two into §17.23 — the recovery path
only fires in response to the detection signal, never independently; they
are one discipline, not two. Net three new subsections.

### Retention posture

Ceremony rows retained per §25.6 indefinite-retention default and §26/§27
precedent. `chiefos_quote_events` immutability trigger prevents DELETE;
manual cleanup query (documented, not committed) would be:

```sql
-- c4c4 namespace cleanup (runs outside DB-enforced immutability):
UPDATE public.chiefos_quotes
  SET status='voided', voided_at=NOW(), voided_reason='c4c4-ceremony-cleanup'
  WHERE id = '00000000-c4c4-c4c4-c4c4-000000000002';
-- share_tokens, line_items, versions: preserved for forensic continuity
-- events: DB-immutable, preserved indefinitely
```

### Cross-reference map

- **§3A** (co-transition asymmetry for voided) — exercised by Section 4 Test 11
- **§17.23** (state-driven idempotency) — exercised by Sections 2-4, formalized here
- **§17.24** (header-first ordering) — exercised by Sections 3-4, formalized here
- **§17.25** (echo-if-present posture) — exercised by Section 3, formalized here
- Section 6 router registration adds ViewQuote to `NEW_IDIOM_HANDLERS`

---

## §29. Cross-quote pointer enforcement (RESERVED)

The 4-column composite FK pattern for cross-quote pointer enforcement,
if needed. Renumbered from §28 placeholder after ViewQuote claimed §28.
No production exercise yet; ceremony to be authored if/when a downstream
handler requires explicit cross-quote referential integrity beyond what
the existing single-FK constraints provide.

---

## §30. Phase A Session 3 — LockQuote exercised against production (2026-04-24)

**Status.** Phase A Session 3's closing ceremony. Production exercise proving
`handleLockQuote` (the 7-step LockQuote orchestration from §2) executes
end-to-end against real Postgres. Third new-idiom CIL handler exercised in
production after SignQuote (§27) and ViewQuote (§28). First system-initiated
handler in Phase A. Second §17.23 state-driven idempotency exerciser. First
ceremony that verifies §3A header-only asymmetry against live DB state
(version row untouched post-lock).

### Scope

Happy-path only (pre-txn `loadLockContext` returns signed-state;
`markQuoteLocked` transitions header signed→locked WITHOUT touching version;
`emitLifecycleLocked` fires). Already-locked / draft-sent-viewed rejection /
voided rejection / concurrent-transition recovery / cross-tenant+cross-owner
fail-closed paths covered by §2's 10 integration tests. Ceremony validates
the happy path against production, not each branch.

### Ceremony identity

| Field | Value |
|---|---|
| tenant_id         | `00000000-c5c5-c5c5-c5c5-000000000001` |
| owner_id          | `00000000003` |
| quote_id          | `00000000-c5c5-c5c5-c5c5-000000000002` |
| version_id        | `00000000-c5c5-c5c5-c5c5-000000000003` |
| share_token_id    | `00000000-c5c5-c5c5-c5c5-000000000005` |
| synthetic_sent_event_id   | `00000000-c5c5-c5c5-c5c5-000000000007` |
| synthetic_signed_event_id | `00000000-c5c5-c5c5-c5c5-000000000008` |
| synthetic_signature_id    | `00000000-c5c5-c5c5-c5c5-000000000009` |
| share_token       | `MGBi1RsGiGNFMxxFf232Qe` (deterministic from seed) |
| human_id          | `QT-CEREMONY-2026-04-24-PHASE-A-S3` |
| project_title     | `Phase A Session 3 LockQuote Ceremony` |
| job_id            | `4331` (allocated by jobs.id serial) |

The `c5c5-c5c5-c5c5` hex namespace distinguishes Phase A Session 3 ceremony
rows from Phase A Session 2's `c4c4-c4c4-c4c4` and Phase 3's `c3c3-c3c3-c3c3`.

### Share-token derivation

`MGBi1RsGiGNFMxxFf232Qe` is `bs58.encode(sha256('chiefos-phase-a-session-3-lockquote-ceremony-share-token-seed').subarray(0, 16))`,
via `deriveDeterministicShareToken` shared helper with bounded retry
(`scripts/_ceremony_shared.js`). Single-shot seed (no v-iteration footgun);
the Session 2 v2-iteration lesson held — bounded-retry helper resolved the
§17.22 short-output case without manual iteration.

Note: LockQuote is system-only in Phase A (`LockQuoteActorZ` is
`z.literal('system')`); the share_token here anchors the pre-existing
synthetic lifecycle.sent event chain. It is NOT presented to a customer
during the ceremony — no customer surface is exercised by LockQuote.

### Seed posture — SQL INSERT, signed-state pre-state

§27/§28 established seeding via explicit INSERT (not handler chain);
same posture here. The LockQuote pre-state must be `quote.status='signed'`
with `version.status='signed'` AND `version.locked_at IS NOT NULL` per
§17.22 invariant. Seed at `scripts/ceremony_seed_phase_a_session3.js`
inserts: user, tenant, job, quote (signed), version (signed, locked_at set,
server_hash 64-hex), share_token (30-day expiry), synthetic lifecycle.sent
event (`payload.ceremony_synthetic=true`), synthetic lifecycle.signed event
(`payload.version_hash_at_sign=c5c5…` + `ceremony_synthetic=true`), synthetic
signature row (storage_key matches `chiefos_qs_png_storage_key_format`
regex; no bucket upload — LockQuote does not read the signature row).

Line-items omitted per §27 Phase 2C precedent: `chiefos_qli_parent_locked`
trigger forbids INSERT on a locked version row. Totals zeroed (0/0/0) to
satisfy `chiefos_qv_totals_balance`.

### Handler-generated artifacts

| Field | Value |
|---|---|
| correlation_id       | `f69516da-528a-4988-90a7-83870f63f7e0` |
| quote.status (before / after) | `signed` / `locked` |
| version.status (before / after) | `signed` / `signed` (§3A — UNCHANGED) |
| version.locked_at (before / after) | `22:52:12.319Z` / `22:52:12.319Z` (§3A — UNCHANGED) |
| version.server_hash (before / after) | `c5c5…c5c5` / `c5c5…c5c5` (§3A — UNCHANGED) |
| quote.updated_at     | `2026-04-24T22:53:20.359Z` (txn NOW()) |
| lifecycle.locked.emitted_at | `2026-04-24T22:53:19.805Z` (data.occurred_at) |

**§3A header-only asymmetry — production-verified.** The version row is
DB-immutable post-sign (`trg_chiefos_quote_versions_guard_immutable`); had
`markQuoteLocked` attempted ANY version-row UPDATE, the trigger would have
rejected the transaction. The ceremony verifies at handler-return AND at
post-ceremony DB read that `version.status`, `version.locked_at`,
`version.server_hash`, and `version.signed_at` are ALL byte-identical
pre-to-post. This is the first production exercise making §3A a captured
artifact rather than a design principle.

### Events chain (ordered by global_seq)

| seq | kind | correlation_id | emitted_at | notes |
|---|---|---|---|---|
| 4419 | `lifecycle.sent`   | NULL | `22:51:12.319Z` | seed-inserted (synthetic); `payload.ceremony_synthetic=true` |
| 4420 | `lifecycle.signed` | NULL | `22:52:12.319Z` | seed-inserted (synthetic); `payload.version_hash_at_sign=c5c5…`; `payload.ceremony_synthetic=true` |
| 4421 | `lifecycle.locked` | `f69516da-…f7e0` | `22:53:19.805Z` | handler Step 6; `payload.source_msg_id` echoed from CIL input |

**Single handler-emitted event per invocation.** Like ViewQuote (§28),
LockQuote emits ONE event. §17.21's intra-handler cross-event correlation_id
wiring is trivially satisfied (only one event to wire); §17.23 state-driven
idempotency fills the structural invariant role for single-event handlers.

### emitted_at vs. updated_at (intentional 554ms divergence)

`lifecycle.locked.emitted_at` (`22:53:19.805Z`) precedes `quote.updated_at`
(`22:53:20.359Z`) by 554 ms. Same semantic pattern as §28's ViewQuote:

- `emitted_at` is populated from `data.occurred_at` in the CIL input — when
  the system-cron fired the LockQuote CIL (client-perceived event time).
- `quote.updated_at` is `NOW()` inside the handler's transaction — when the
  server committed the state flip.

Gap reflects handler execution time (ctx preflight + Zod parse +
loadLockContext pre-txn load + txn BEGIN + markQuoteLocked +
emitLifecycleLocked + COMMIT). Larger than §28's 125 ms gap because the
ceremony runner invokes the handler via Node `require`, not via a warm
HTTP handler.

### source_msg_id payload echo

`lifecycle.locked.payload.source_msg_id = 'ceremony-phase-a-s3-lockquote-run-1'`
(matches CIL input). Second production exercise of §17.25 echo-if-present
posture (first was ViewQuote §28) — confirms the strict `!== undefined`
pattern holds for system-initiated handlers as well as customer-initiated.

### What Phase A Session 3 validated that prior sections could not

- **First production verification of §3A post-sign immutability.**
  §28 established §3A as co-transition discipline for sent→viewed (both
  rows flip). §30 is the first production exercise of the ASYMMETRIC
  branch: header flips, version does NOT. The version-row-unchanged
  anomaly-stop check in the ceremony runner locks this as captured artifact
  — any future regression where LockQuote or a sibling handler mutates
  a post-sign version row would fail the check loudly.
- **Second production exercise of state-driven idempotency (§17.23).**
  LockQuote has no INSERT-with-natural-unique-constraint surface; retries
  on locked quotes take the `alreadyLockedReturnShape` pre-txn routing
  branch. First run is the sole happy-path exercise; re-running without
  re-seed exercises the prior-state retry branch. Confirms §17.23 scales
  across handler types (customer-initiated viewed, system-initiated locked).
- **First system-actor handler in production.** SendQuote, SignQuote, and
  ViewQuote are all customer- or portal-actor origination patterns. LockQuote
  is the first handler where `actor.role='system'` is the ONLY valid
  value (`LockQuoteActorZ = z.literal('system')` in Phase A). Confirms
  the system-actor path threads identity cleanly through ctx preflight →
  loadLockContext → markQuoteLocked → emitLifecycleLocked without
  customer-surface assumptions leaking in.
- **No-plan-gating posture captured.** LockQuote intentionally omits plan
  gating per G6 follow-through: creation consumes the plan gate;
  lifecycle state transitions (send, sign, view, lock, void, reissue) are
  transitively gated via creation. §2's handler has an inline comment
  reserving a next-free §17.N slot if Phase A.5+ introduces independent
  gating semantics for owner-initiated vs. system-initiated locks.

### Anomaly-stop validation (ran before documentation)

The ceremony runner (`scripts/real_lock_quote_ceremony.js`) executes
inline anomaly checks before writing §30. Happy-path set:

1. `events_emitted` exactly `['lifecycle.locked']`
2. `meta.already_existed === false`
3. `meta.correlation_id` UUID-shaped and non-null
4. `result.quote.status === 'locked'`
5. **`result.version.status === 'signed'` (CRITICAL §3A)**
6. `lifecycle.locked` event count === 1
7. `lifecycle.locked` event row's `correlation_id === meta.correlation_id`
8. `payload.source_msg_id === CIL input's source_msg_id`
9. **DB-side: `version.locked_at` UNCHANGED pre-to-post (§3A)**
10. **DB-side: `version.server_hash` UNCHANGED pre-to-post (§3A)**
11. **DB-side: `version.status === 'signed'` post-lock (§3A)**
12. `quote.status === 'locked'` post-lock (header-flip completeness)
13. `quote.updated_at` strictly AFTER `version.locked_at` (timestamp ordering)

All 13 passed. No anomalies. Documentation proceeded.

### Formalizations landing in this session close

| Principle | Section | Status |
|---|---|---|
| §17.24 forward-applicability correction | §17.24 | Amended (LockQuote bullet corrected — header-only per §3A, §17.24 does NOT apply) |
| §3A header-only asymmetry | §3A | Production-verified (first captured artifact — version row unchanged post-lock) |
| Path B no-plan-gating posture | §2 handler inline comment | Reserved next-free §17.N slot if Phase A.5+ develops independent gating |

**No new §17.N subsection originated this session.** Unlike Phase 3
(originated §17.19–§17.22) and Phase A Session 2 (originated §17.23/§17.24/§17.25
+ §3A), Session 3 consumed prior formalizations cleanly and corrected one
forward-applicability bullet. This reflects the maturity of the Phase A
architecture — LockQuote's clean arc is a trailing indicator that the
Session 2 formalizations landed at the right level of abstraction.

### Five discipline notes (Session 3 lessons)

1. **Schema-verify forward-applicability.** Future §17.N formalizations
   that list forward exercisers must schema-verify each listed handler
   before commit. The §17.24 LockQuote dual-row bullet was drafted in
   Session 2 before §3A post-sign immutability was canonical; corrected
   here after §2 implementation revealed the drift. Drafting multiple
   forward bullets simultaneously without per-handler schema check is how
   incoherence enters the decisions log.
2. **Surface-enum questions are product-level.** When a handler decision
   involves surface enumeration (`source`, `actor.role`, `channel`),
   surface the product-intent question before the technical-implementation
   question. Mid-session scope expansion often indicates a missing phase
   or missing principle in the plan, not a missing handler detail.
   Session 3's parity-principle discussion produced Phase A.5 as a named
   phase — the right answer was "elevate to plan," not "absorb into
   handler scope."
3. **SIG_ERR rename backlog.** `SIG_ERR` has become a misnomer — houses
   `QUOTE_NOT_SIGNED`, `QUOTE_VOIDED`, `QUOTE_NOT_SENT` (none sign-related).
   Consider renaming to `QUOTE_ERR` or `LOAD_ERR` in a post-Phase-A
   housekeeping pass after VoidQuote + ReissueQuote ship and the right
   name is clearer. Do not rename inline during handler work.
4. **Mid-session checkpoint discipline.** When a Claude Code session must
   `/clear` mid-arc, the outgoing session commits a `_CHECKPOINT.md`
   document summarizing scope lockdowns, implementation-time nuances, and
   approved-but-unstarted work. Distinct from `_HANDOFF.md`
   (session-boundary artifacts). Fresh session reads checkpoint before
   accepting directives; checkpoint is deleted when arc closes. Session 3
   exercised this cleanly (`d6f97bc6` introduction → deletion in the §30
   close-out commit).
5. **Directives are proposals, not ground truth.** Pre-implementation
   verification — grepping actual source, reading actual handler precedents,
   checking actual schema constraints — is the contract. Halt-and-surface
   when drift detected. Session 3 LockQuote arc caught three directive
   corrections this way (QuoteRefInputZ at-least-one contract, plan-gating
   precedent, `ctx.versionServerHash` field naming); verification prevented
   silent incoherence in production code.

### Retention posture

Ceremony rows retained per §25.6 indefinite-retention default and §26/§27/§28
precedent. `chiefos_quote_events` immutability trigger prevents DELETE;
manual cleanup query (documented, not committed) would be:

```sql
-- c5c5 namespace cleanup (runs outside DB-enforced immutability):
UPDATE public.chiefos_quotes
  SET status='voided', voided_at=NOW(), voided_reason='c5c5-ceremony-cleanup'
  WHERE id = '00000000-c5c5-c5c5-c5c5-000000000002';
-- share_tokens, signatures, versions: preserved for forensic continuity
-- events: DB-immutable, preserved indefinitely
```

### Cross-reference map

- **§3A** (post-sign version-row immutability) — exercised by §2 Block 1 Test 1 AND captured at §30 as first production artifact
- **§17.23** (state-driven idempotency) — second exerciser (LockQuote); first was ViewQuote §28
- **§17.24** (header-first ordering) — forward-applicability corrected; LockQuote does NOT exercise (single-row header UPDATE)
- **§17.25** (echo-if-present posture) — second production exercise (LockQuote); first was ViewQuote §28
- §2 router registration adds LockQuote to `NEW_IDIOM_HANDLERS`

---

## §31. Phase A Session 4 — VoidQuote exercised against production (2026-04-25)

**Status.** Phase A Session 4's closing ceremony. Production exercise proving
`handleVoidQuote` (the Step 0–7 VoidQuote orchestration from §2) executes
end-to-end against real Postgres. Sixth new-idiom CIL handler exercised in
production after CreateQuote, SendQuote, SignQuote (§27), ViewQuote (§28),
and LockQuote (§30). Third §17.23 state-driven idempotency exerciser (after
ViewQuote §28 and LockQuote §30). Second ceremony to verify §3A header-only
asymmetry against live DB state — first was LockQuote §30 (post-sign
immutability case); §31 captures the **canonical asymmetry case** (any-of-
five → voided header-only flip; version row enum at Migration 1 line 121
excludes 'voided', so version is unchanged across the void transition
regardless of source state).

### Scope

Happy-path only (pre-txn `loadVoidContext` returns sent-state;
`markQuoteVoided` transitions header sent→voided WITHOUT touching version;
`emitLifecycleVoided` fires with `payload.voided_reason` per
`chiefos_qe_payload_voided` CHECK obligation). Already-voided idempotent
retry path (Step 5 pre-txn routing → `alreadyVoidedReturnShape` with
persisted voided_reason from header) covered by §2's integration tests
plus the ceremony's exit-0 idempotent re-run path. Concurrent-transition
recovery (§17.23 recovery half via Step 7a re-read) covered by §2's
integration tests. Cross-tenant + cross-owner fail-closed and unknown-
quote_ref paths covered by §2's integration tests. Ceremony validates
the happy path against production, not each branch.

### Source state — sent (representative)

VoidQuote can fire from any of 5 prior states {draft, sent, viewed, signed,
locked}. The ceremony picks `sent` as the representative path — most
operationally common void source (a quote was sent and rejected/superseded
by ops), exercises the §17.23 single-event happy path, and avoids the
§17.22 signed/locked locked_at-NOT-NULL invariant chain so the seed is
minimal (no synthetic signature row, no synthetic lifecycle.signed event).
Other source states are state-machine-symmetric per the §3A canonical
asymmetry argument; future ceremonies may re-exercise from signed or
locked if a regression target emerges.

### Ceremony identity

| Field | Value |
|---|---|
| tenant_id         | `00000000-c6c6-c6c6-c6c6-000000000001` |
| owner_id          | `00000000004` |
| quote_id          | `00000000-c6c6-c6c6-c6c6-000000000002` |
| version_id        | `00000000-c6c6-c6c6-c6c6-000000000003` |
| line_item_id      | `00000000-c6c6-c6c6-c6c6-0000000000a1` |
| share_token_id    | `00000000-c6c6-c6c6-c6c6-000000000005` |
| synthetic_sent_event_id | `00000000-c6c6-c6c6-c6c6-000000000007` |
| share_token       | (deterministic via `deriveDeterministicShareToken` shared helper) |
| human_id          | `QT-CEREMONY-2026-04-25-PHASE-A-S4` |
| project_title     | `Phase A Session 4 VoidQuote Ceremony` |
| job_id            | `6779` (allocated by jobs.id serial) |

The `c6c6-c6c6-c6c6` hex namespace distinguishes Phase A Session 4 ceremony
rows from Phase A Session 3's `c5c5-c5c5-c5c5`, Phase A Session 2's
`c4c4-c4c4-c4c4`, and Phase 3's `c3c3-c3c3-c3c3`.

### Seed posture — SQL INSERT, sent-state pre-state

§27/§28/§30 established seeding via explicit INSERT (not handler chain);
same posture here. The VoidQuote pre-state is `quote.status='sent'` with
`version.status='sent'`, `version.locked_at IS NULL`, and
`version.server_hash IS NULL` — no §17.22 invariant assertion fires for
pre-sign source states. Seed at `scripts/ceremony_seed_phase_a_session4.js`
inserts: user, tenant, job, quote (sent), version (sent, unlocked, hash
NULL), 1 line_item (allowed pre-lock), share_token (30-day expiry),
synthetic lifecycle.sent event (`payload.ceremony_synthetic=true`).

No signature row, no synthetic lifecycle.signed event — sent state has
neither. Mirrors §28 ViewQuote seed exactly (same source state); diverges
from §30 LockQuote seed (which required signed-state with locked_at + hash
+ signature).

### Handler-generated artifacts

| Field | Value |
|---|---|
| correlation_id       | `52b48aa0-7306-4bde-9154-9339160b5bb7` |
| quote.status (before / after) | `sent` / `voided` |
| version.status (before / after) | `sent` / `sent` (§3A — UNCHANGED) |
| version.sent_at (before / after) | `20:57:54.634Z` / `20:57:54.634Z` (§3A — UNCHANGED) |
| version.locked_at (before / after) | `NULL` / `NULL` (§3A — UNCHANGED) |
| version.server_hash (before / after) | `NULL` / `NULL` (§3A — UNCHANGED) |
| quote.updated_at     | `2026-04-25T20:58:17.926Z` (txn NOW()) |
| quote.voided_at      | `2026-04-25T20:58:17.926Z` (same txn NOW()) |
| quote.voided_reason  | `Phase A Session 4 ceremony — representative system-initiated void from sent state` |
| lifecycle.voided.emitted_at | `2026-04-25T20:58:17.926Z` (= quote.updated_at; data.occurred_at within ms) |

**Single-txn coherence.** `quote.updated_at === quote.voided_at` — both
`NOW()` within the same transaction (Postgres returns the transaction-
start timestamp for all `NOW()` calls in a given BEGIN scope).
`markQuoteVoided` sets both columns in a single UPDATE. The
`lifecycle.voided` event row's `emitted_at` is populated from
`data.occurred_at` (CIL input), which the ceremony runner timestamps at
invocation time — within milliseconds of the txn-start clock.

**§3A canonical asymmetry — production-verified.** Unlike LockQuote (§30,
post-sign-immutability case where `trg_chiefos_quote_versions_guard_immutable`
DB-rejects any version UPDATE), VoidQuote's pre-sign source states have a
mutable version row by DB rules — it is the **handler's discipline** plus
the version-status enum's exclusion of `'voided'` that keeps the version
row unchanged. The ceremony verifies at handler-return AND at post-ceremony
DB read that `version.status`, `version.sent_at`, `version.locked_at`,
and `version.server_hash` are ALL byte-identical pre-to-post. This is the
first production exercise making §3A's **canonical** asymmetry case (the
five-source-state → single-target case) a captured artifact. Combined with
§30's post-sign-immutability artifact, §3A now has both arms of the
asymmetry production-verified.

### Events chain (ordered by global_seq)

| seq | kind | correlation_id | emitted_at | notes |
|---|---|---|---|---|
| 6625 | `lifecycle.sent`   | NULL | (seed time) | seed-inserted (synthetic); `payload.ceremony_synthetic=true` |
| 6626 | `lifecycle.voided` | `52b48aa0-…5bb7` | `20:58:17Z` | handler Step 6; `payload.voided_reason` populated; `payload.source_msg_id` echoed from CIL input |

**Single handler-emitted event per invocation.** Like ViewQuote (§28) and
LockQuote (§30), VoidQuote emits ONE event. §17.21's intra-handler cross-
event correlation_id wiring is trivially satisfied (only one event to wire);
§17.23 state-driven idempotency fills the structural invariant role for
single-event handlers. No `notification.*` paired event — VoidQuote is
system-only in Phase A and has no customer surface.

### Payload CHECK obligation — production-verified

`chiefos_qe_payload_voided` (Migration 2 line 190-191) requires
`payload ? 'voided_reason'` when `kind='lifecycle.voided'`. The handler's
`emitLifecycleVoided` assembles `payload.voided_reason` from
`data.voided_reason` (VoidQuoteCILZ `z.string().min(1)` enforced upstream).
Anomaly-stop check #9 confirmed the CHECK is satisfied at production
INSERT time:

```
payload.voided_reason = "Phase A Session 4 ceremony — representative system-initiated void from sent state"
```

This is the first production exercise of a per-kind payload CHECK
constraint in the Quotes spine. SignQuote (§27) writes
`payload.version_hash_at_sign` to satisfy `chiefos_qe_payload_signed`
similarly, but the pattern was less load-bearing because SignQuote's
payload assembly is constrained by Phase 1's hash-spec; VoidQuote's
voided_reason is the first **CIL-input-sourced** payload CHECK obligation.

### source_msg_id payload echo

`lifecycle.voided.payload.source_msg_id = 'ceremony-phase-a-s4-voidquote-run-1'`
(matches CIL input). Third production exercise of §17.25 echo-if-present
posture (after ViewQuote §28 and LockQuote §30) — confirms strict
`!== undefined` pattern holds for system-initiated handlers across distinct
state transitions (sent→viewed, signed→locked, sent→voided).

### What Phase A Session 4 validated that prior sections could not

- **First production verification of §3A canonical asymmetry (five-source
  → header-only voided flip).** §28 established §3A as co-transition
  discipline for sent→viewed (both rows flip). §30 captured the post-sign
  immutability arm (header flips, version DB-immutable). §31 captures the
  **canonical asymmetry arm**: header flips to `voided`; version row is
  unchanged across the transition by handler discipline (the version-
  status enum at Migration 1 line 121 excludes `'voided'`, making any
  version UPDATE attempt a constitutional violation). Combined with §30,
  §3A now has both arms production-verified.
- **First production exercise of CIL-input-sourced payload CHECK.**
  `chiefos_qe_payload_voided` requires `payload.voided_reason` when
  `kind='lifecycle.voided'`. Handler discipline pulls
  `data.voided_reason` (Zod-enforced `z.string().min(1)`) into the event
  payload at emit time. This is the first per-kind payload CHECK whose
  satisfaction depends on a CIL input field (not a handler-derived value
  like §27's `version_hash_at_sign`).
- **Third production exercise of state-driven idempotency (§17.23).**
  VoidQuote has no INSERT-with-natural-unique-constraint surface; retries
  on already-voided quotes take the `alreadyVoidedReturnShape` Step 5
  pre-txn routing branch, returning persisted `voided_reason` from the
  header (§17.21 retry-path posture: silently drop current call's
  voided_reason; return the original). First run is the sole happy-path
  exercise; re-running without re-seed exercises the prior-state retry
  branch. §17.23 now has three exercisers across customer-initiated
  (ViewQuote §28) and system-initiated (LockQuote §30, VoidQuote §31)
  handlers — the discipline scales across the full Phase A handler set.
- **Dual-actor schema, single ceremony actor.** `VoidQuoteActorZ` is a
  discriminated union of `'owner'` and `'system'` roles (unlike LockQuote's
  `z.literal('system')`). The ceremony exercises the system path only —
  cron-initiated auto-void shape — but `loadVoidContext` is actor-oblivious
  per Posture A, so the owner path is structurally the same. No new
  formalization needed; §14.11/§14.12 customer-actor patterns from §27
  remain orthogonal (VoidQuote has no customer surface in Phase A).
- **Second ceremony exercising §17.25 + §17.23 in combination, third
  overall.** Confirms the 2026-04-23 §17.23/§17.24/§17.25/§3A formalization
  cluster from §28 has now been exercised across three handlers without
  amendment — the formalization landed at the right level of abstraction.

### Anomaly-stop validation (ran before documentation)

The ceremony runner (`scripts/real_void_quote_ceremony.js`) executes 17
inline anomaly checks before writing §31. Happy-path set:

1. `events_emitted` exactly `['lifecycle.voided']`
2. `meta.already_existed === false`
3. `meta.correlation_id` UUID-shaped and non-null
4. `result.quote.status === 'voided'`
5. `result.quote.voided_reason === CIL.voided_reason` (exact match)
6. `result.quote.voided_at` populated (truthy timestamp)
7. **`result.version.status === before.v_status` (CRITICAL §3A pass-through)**
8. `lifecycle.voided` event row count === 1
9. **`lifecycle.voided` payload.voided_reason populated and matches CIL input (CHECK obligation)**
10. `lifecycle.voided` payload.source_msg_id matches CIL input (§17.25 echo)
11. **DB-side: `version.status` UNCHANGED pre-to-post (§3A)**
12. **DB-side: `version.sent_at` UNCHANGED pre-to-post (§3A)**
13. **DB-side: `version.locked_at` UNCHANGED pre-to-post (§3A)**
14. **DB-side: `version.server_hash` UNCHANGED pre-to-post (§3A)**
15. `quote.status === 'voided'` post-void (header-flip completeness)
16. `quote.voided_at` populated post-void
17. `quote.voided_reason` persisted post-void matches CIL input

All 17 passed. No anomalies. Documentation proceeded.

### Formalizations landing in this session close

| Principle | Section | Status |
|---|---|---|
| §3A canonical asymmetry (five-source → header-only voided) | §3A | Production-verified (second captured artifact — first was §30 post-sign immutability arm) |
| §17.23 state-driven idempotency | §17.23 | Third exerciser (after ViewQuote §28 and LockQuote §30) |
| §17.25 echo-if-present posture | §17.25 | Third exerciser (after ViewQuote §28 and LockQuote §30) |
| `chiefos_qe_payload_voided` CHECK | §12/§14 (existing) | First production exercise of CIL-input-sourced payload CHECK |

**No new §17.N subsection originated this session.** Continuing the §30
trend: Session 4 consumed prior formalizations cleanly. The §17.23/§17.24/
§17.25/§3A cluster from §28 has now been exercised across three handlers
(ViewQuote, LockQuote, VoidQuote) without amendment — strong signal the
formalization landed at the right level of abstraction. §17.26 remains
free for a ReissueQuote-specific sub-amendment if that handler's
supersession write pattern reveals a regime not covered by §17.23.

### Retention posture

Ceremony rows retained per §25.6 indefinite-retention default and
§26/§27/§28/§30 precedent. `chiefos_quote_events` immutability trigger
prevents DELETE; the ceremony's terminal state (`quote.status='voided'`)
is itself the operational cleanup marker. No additional cleanup query
required — the c6c6 quote is already voided post-ceremony.

### Cross-reference map

- **§3A** (canonical asymmetry: five-source → header-only voided) — exercised by §2 integration tests AND captured at §31 as second production artifact (first was §30)
- **§17.23** (state-driven idempotency) — third exerciser (VoidQuote); prior were ViewQuote §28, LockQuote §30
- **§17.24** (header-first ordering) — does NOT apply to VoidQuote (single-row header UPDATE; same disposition as §30 LockQuote)
- **§17.25** (echo-if-present posture) — third exerciser (VoidQuote); prior were ViewQuote §28, LockQuote §30
- **`chiefos_qe_payload_voided` CHECK** — first production exercise of CIL-input-sourced payload CHECK obligation
- §3 router registration adds VoidQuote to `NEW_IDIOM_HANDLERS`

---

## §32. ReissueQuote ceremony (RESERVED)

Expected Phase A Session 5 if the ReissueQuote handler arc warrants
production-exercise capture. Handler shape and ceremony script TBD.
