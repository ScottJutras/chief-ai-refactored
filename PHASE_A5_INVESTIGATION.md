# Phase A.5 Investigation

```
STATUS: ACTIVE — Phase A closed at commit 971ca0ea (Session 5 ReissueQuote
landed 2026-04-25). GATED marker lifted. Sessions 6 (A.5 Slice 1) and 7
(A.5 Slice 2) may proceed against this directive. See §8 Addendum for
Session 5 deltas.
```

**Date:** 2026-04-25
**Author:** Claude Code (per Phase A Close → Phase A.5 Open directive)
**Authority:** Project Instructions v4.0 (Tier 6), Execution Playbook v4.0 (Tier 3), Engineering Constitution v4.0 (Tier 1), North Star §14 (deterministic retrieval first), CLAUDE.md (tenant boundaries, fail-closed identity, CIL enforcement).

---

## 0. Founder-facing summary

### 0.1 What A.5 looks like end-to-end

Phase A.5 turns the six (soon-seven) Phase A CIL handlers — currently invokable only via `applyCIL` from internal call sites — into two owner-facing surfaces:

- **WhatsApp commands.** The owner types `/quote for Anderson 2 cabinets $4200`, `/lock the Anderson quote`, `/void QT-2026-04-25-0003 — wrong scope`, `/reissue the Anderson quote`. ChiefOS resolves the quote reference deterministically, asks for confirmation per "no silent mutation," then dispatches into the corresponding Phase A handler.
- **Portal quote detail page.** A new `/quotes/[quoteId]` route in the Next.js app shows quote header + version + line items + signature status, with owner-only action buttons (Lock / Void / Reissue / View Signature / Download PDF) that POST to a new Express action API which itself calls into the Phase A handlers.

Both surfaces share two prerequisites: (a) a schema widening (`LockQuoteCILZ.source` and `VoidQuoteCILZ.source` from `z.literal('system')` to `z.enum(['portal','whatsapp','system'])`), and (b) the ReissueQuote handler from Session 5. The portal surface adds one more: a new `chiefos_portal_quotes` SECURITY INVOKER view to honor the CLAUDE.md compat-view-over-direct-table mandate.

End user signal A.5 unlocks: an owner can manage the full quote lifecycle from either surface without ever leaving WhatsApp or the portal, with all state changes flowing through the same audited CIL spine.

### 0.2 Minimum-viable shippable slice

**Slice 1 (WhatsApp): V2 + V1.** Deterministic resolver + four commands. Ships standalone for WhatsApp users. Estimated surface change: 1 new module (`src/cil/quoteResolver.js`), 1 new commands file (`handlers/commands/quoteSpine.js` or extension of existing `handlers/commands/quote.js`), 1 dispatcher edit (`handlers/commands/index.js`), 1 schema-widening edit (`src/cil/quotes.js` — two literal→enum changes), 1 test file each for resolver and commands.

**Slice 2 (Portal): V3 + V4.** Detail page + action API. Depends on Slice 1's schema widening landing. Surface change: 1 new migration (`chiefos_portal_quotes` view), 1 new Next.js route file, 1 new Express route file, 1 dispatcher edit (`index.js`), 1 shared `mustOwner` middleware (promoted from `routes/crewAdmin.js`), tests.

Counts intentionally exclude ReissueQuote (Session 5 territory).

### 0.3 Decisions A–D (founder approval ledger)

| ID | Decision | Recommendation | Tradeoff | Founder status |
|---|---|---|---|---|
| A | Widen `LockQuoteCILZ.source` and `VoidQuoteCILZ.source` from `z.literal('system')` to `z.enum(['portal','whatsapp','system'])` | APPROVE — already commented as Phase A.5 intent in source (`src/cil/quotes.js:3946-3950`, `4618-4622`) | Trivial widening; no behavioral change to existing system callers; unblocks both A.5 surfaces | **APPROVED 2026-04-26.** Already commented as Phase A.5 intent in source. Required for portal action API to invoke Lock/Void handlers without source-spoofing. Slice 1 schema task. |
| B | Portal action API idempotency: client-supplied `Idempotency-Key` header → CIL `source_msg_id` | APPROVE the header strategy | Lock/Void are state-machine-idempotent already so the key buys traceability not safety; Reissue (Session 5) needs it for the source_msg_id unique constraint and benefits properly. Alternative server-issued nonces add a round-trip with no correctness gain. | **APPROVED 2026-04-26.** State-machine idempotency on Lock/Void is the safety net; the header buys traceability and forward-compatibility with Reissue's source_msg_id unique constraint shipped in Session 5. Reject server-issued action-id nonces — header pattern is industry-standard and gives clients deterministic retry semantics. |
| C | Portal action API endpoint shape: REST `POST /api/quotes/:quoteId/{lock,void,reissue}` (matching `routes/jobsPortal.js` pattern) | APPROVE REST | Matches existing portal mutation pattern (jobsPortal.js, crewAdmin.js); RPC alternative would diverge from precedent without benefit | **APPROVED 2026-04-26.** Matches existing routes/jobsPortal.js pattern. Consistency with established portal action surface outweighs RPC ergonomics. Reject RPC POST /api/quotes/action body-dispatch — would create a second action-routing pattern in the portal API and increase cognitive load. |
| D | `chiefos_portal_quotes` view scope: SECURITY INVOKER, joins `chiefos_quotes + chiefos_quote_versions + chiefos_quote_line_items + customers + jobs`, RLS via `chiefos_portal_users` membership | APPROVE the join shape (column list in §V3 below) | Matches `chiefos_portal_expenses` precedent (`migrations/2026_04_22_rebuild_views.sql:57`); SECURITY INVOKER means the underlying RLS policies do the work | **APPROVED CONDITIONALLY 2026-04-26.** View concept and join shape (chiefos_quotes + chiefos_quote_versions + chiefos_quote_line_items + customers + jobs) approved. SECURITY INVOKER + tenant_id boundary via membership confirmed. Column list requires final founder review before migration ships in Session 7 — flag any column that surfaces PII beyond existing customer view exposure pattern, or any column that would create implicit trust-surface expansion. Session 6 (Slice 1) is unblocked regardless; this Decision only gates Session 7 implementation. |

### 0.4 Doc-debt items surfaced

- `CHIEFOS_EXECUTION_PLAN.md` — VoidQuote checkbox is still `[ ]` despite Session 4 close at commit `f4b54fe4`. Recommend Session 5 wrap updates the box and adds the ReissueQuote box state.
- No `PHASE_A_SESSION_4_VOIDQUOTE_HANDOFF.md` exists. The Session 3 handoff is the most recent canonical statement of Phase A scope. Recommend Session 5 wrap backfills a brief Session 4 handoff (or rolls Session 4 + Session 5 into one combined post-Phase-A handoff).

### 0.5 Doc conflicts with Tier-1/3/6 authorities

None observed. All proposals comply with CLAUDE.md tenant boundaries, CIL enforcement (Ingress → Draft → Validation → Mutation), idempotency requirements, and fail-closed plan gating. North Star §14 satisfied (deterministic retrieval first; LLM scores candidates rather than queries DB freely).

---

## 1. V1 — Resolver design (`src/cil/quoteResolver.js`)

### 1.1 Current routing pattern

`src/cil/router.js:33-41` is pure type-dispatch — it receives a pre-formed `rawCil` with `type` already set and looks the type up in the frozen `NEW_IDIOM_HANDLERS` map. There is no intent classification, no entity resolution, no LLM call inside `router.js`. Classification + entity resolution happen upstream, before `applyCIL` is invoked.

The codebase has exactly one existing fuzzy-name pattern: `handlers/commands/index.js:467-474` (batch-receipts confirm flow) does an `ILIKE` job lookup with `LIMIT 1` and `ORDER BY created_at DESC`. There is no general fuzzy resolver, no Levenshtein, no pgvector entity retrieval. `services/tools/rag.js` is corpus retrieval (knowledge), not entity retrieval. `services/orchestrator.js` and `services/actorContext.js` resolve actor identity but not domain entities.

### 1.2 Quote table addressable columns (from `migrations/2026_04_18_chiefos_quotes_spine.sql`)

| Column | Table | Suitability for resolution |
|---|---|---|
| `human_id` | `chiefos_quotes` | Exact-match key (e.g. `QT-2026-04-25-0003`); unique per tenant |
| `status` | `chiefos_quotes` | Filter (`draft/sent/viewed/signed/locked/voided`) |
| `job_id` | `chiefos_quotes` | FK joinable to `public.jobs.name` for "the quote on the Anderson kitchen job" patterns |
| `customer_id` | `chiefos_quotes` | FK joinable to `public.customers.name` |
| `created_at` | `chiefos_quotes` | Date filter ("from Tuesday") |
| `customer_snapshot->>'name'` | `chiefos_quote_versions` (JSONB, frozen at create per `quotes.js:177-184`) | Fuzzy ILIKE match |
| `sent_at` | `chiefos_quote_versions` | Date filter ("the one I sent yesterday") |

Indexes available: `chiefos_quotes_owner_status_idx (owner_id, status)`, `chiefos_quotes_job_idx (job_id)`, `chiefos_quotes_customer_idx (customer_id)`. All ladder queries can hit indexes.

### 1.3 Deterministic ladder

```
resolveQuoteRef(rawText, { ownerId, tenantId, tz })
  → { kind: 'resolved', quote_id, human_id, version_id }
  | { kind: 'ambiguous', candidates: [{quote_id, human_id, customer_name, total_cents, status, created_at}] }
  | { kind: 'not_found', tried: ['human_id'|'customer'|'date'|'compound'] }
```

Ladder rungs (each rung includes `WHERE owner_id = $1` as the first predicate, fail-closed per CLAUDE.md):

1. **Rung 1 — `human_id` regex.** Match `/QT-\d{4}-\d{2}-\d{2}-\w+/i` in `rawText`. If matched, run `WHERE owner_id = $1 AND human_id = $2`. Single row → return resolved. Zero rows → return not_found (don't fall through; the user typed an explicit ID and was wrong).
2. **Rung 2 — Customer-name extraction + ILIKE.** Extract candidate name tokens (strip stopwords + verbs: "the", "lock", "void", "Anderson's" → "Anderson"). Run `WHERE owner_id = $1 AND v.customer_snapshot->>'name' ILIKE $2 ORDER BY q.created_at DESC LIMIT 5`. 1 row → resolved. 2–5 rows → ambiguous (surface candidate list to user). 0 rows → fall through.
3. **Rung 3 — Date extraction.** Use `chrono-node` (already a dep — see `tasks.js`, `timeclock.js` precedent) to extract date references ("yesterday", "Tuesday", "last week"). Apply to `q.created_at AT TIME ZONE $tz` or `qv.sent_at AT TIME ZONE $tz` per intent (sent_at if "I sent", created_at otherwise). 1 row → resolved. >1 rows → ambiguous. 0 rows → fall through.
4. **Rung 4 — Compound (name + date).** Apply rungs 2 and 3 together to narrow ambiguous matches.
5. **Rung 5 — LLM fallback (only if all deterministic rungs returned 0 OR >5 candidates).** Pass the candidate list (top 5 by `created_at DESC` from rung 2) to the LLM with the user's raw text and ask it to *score* candidates. **The LLM does not query the DB; it scores a deterministically-retrieved candidate list.** Compliant with North Star §14.

### 1.4 Confirm/edit flow ("no silent mutation")

The resolver itself never mutates. It returns a resolution; the caller (commands handler) is responsible for the confirm prompt:

- **resolved** → caller renders confirmation: `"Lock QT-2026-04-25-0003 ($4,200, Anderson Kitchen)? This is irreversible. Reply yes/cancel."` State stored in `stateManager` keyed on `owner_id` (per Phase A.5 owner-boundary requirement) as `pendingQuoteAction: { action, quote_id, human_id, voided_reason? }`.
- **ambiguous** → caller renders disambiguation: `"Which Anderson quote? Reply 1, 2, or 3.\n1. QT-2026-04-25-0003 ($4,200, signed)\n2. QT-2026-04-20-0001 ($3,800, locked)\n3. QT-2026-04-12-0007 ($1,200, voided)"`. Subsequent reply re-enters the resolver with the chosen `quote_id`.
- **not_found** for `/quote for ...` (create intent) → proceed to CreateQuote draft. For `/lock`, `/void`, `/reissue` (mutate intent) → respond: `"No quote found matching '<text>'. Try the QT-… ID or check the customer name."` Do not silently create.

### 1.5 Failure modes

| Mode | Behavior |
|---|---|
| Owner_id missing or unresolvable | Block resolution, return `error: { code: 'TENANT_AMBIGUOUS' }`. Fail-closed per CLAUDE.md. |
| Tenant_id mismatch with owner_id (resolver called with both) | Block, log, return `TENANT_AMBIGUOUS`. |
| LLM fallback unavailable (rate limit, network) | Return `kind: 'ambiguous'` with the deterministic top-5 candidates. Owner picks manually. |
| `chrono-node` parse failure | Skip rung 3, continue to rung 4. Don't fail the whole resolution. |
| User reply to disambiguation isn't `1|2|3` | Re-prompt once; on second invalid reply, cancel pending state. |

### 1.6 File placement

New file: `src/cil/quoteResolver.js`. Sibling to `quotes.js` (handlers) and `router.js` (dispatch). Tests at `src/cil/quoteResolver.test.js` following the existing unit/integration split (mock supabase for unit; `describeIfDb` block for integration).

---

## 2. V2 — WhatsApp command surface

### 2.1 Existing wiring pattern (`handlers/commands/index.js`)

Each command type has:
- A regex pre-filter exported from its handler file: `isXxxCommand(raw)` → boolean
- A handler function: `handleXxx(from, raw, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId)` → boolean (true = handled)
- Dispatcher in `index.js` calls the pre-filter, then the handler, then `safeCleanup({ from, ownerId })`, then `return true`

Pattern exemplified by `handlers/commands/expense.js`, `tasks.js`, `timeclock.js`. The current `handlers/commands/quote.js` exports `isQuoteCommand` (matches `^quote\s+for\b`) and `handleQuoteCommand`, but the handler is **NOT registered** in `index.js` — it's intercepted earlier by the Pro-gate regex at `index.js:330-341` and short-circuits.

### 2.2 Pro-gate constraint at `index.js:330` — resolve by **narrowing**, not reordering

The existing gate uses regex `/agent|quote|metrics.../i` to block all quote text from non-Pro tiers. **Reordering** the dispatcher to register the new commands before the gate fires is fragile (someone refactors the gate later, the gate moves, the order is silently broken). **Narrowing** is explicit: change the gate's regex to require non-command intent (e.g., `/(?<!\/)(?:agent|quote|metrics).../i` — exclude when prefixed by `/`) or split the gate into two passes (commands first, prose second).

Recommended: split the gate. New shape:
1. Command pre-filter pass (`/^\/(?:quote|lock|void|reissue|...)\b/i`) — these route to handlers regardless of plan tier; the handlers themselves call `requirePlan(ownerId, 'pro')` if needed and return `OVER_QUOTA` per CLAUDE.md.
2. Prose Pro-gate pass — existing regex, gates conversational quote/metrics talk.

This preserves plan gating (handlers do their own check; CLAUDE.md fail-closed by `owner_id`) while making the command surface explicit.

### 2.3 Confirm/edit flow

Existing precedent: `handlers/commands/expense.js` and `handlers/commands/revenue.js` own per-handler confirm state via `stateManager` pending records and consume `yes/edit/cancel` decision tokens themselves before `index.js`'s generic block runs (`index.js:347-370`). Decision-token detection regex at `index.js:348-350`.

A.5 commands follow the same pattern. State key: `pendingQuoteAction: { action, quote_id, human_id, voided_reason?, draft? }`. Stored under `owner_id` (not `from`), per CLAUDE.md owner-boundary rule.

### 2.4 Command specs (per Feature Spec Template — Project Instructions §5)

#### `/quote` (CreateQuote)

| Field | Value |
|---|---|
| Intent rule | `/^\/quote\b/i` OR existing `^quote\s+for\b` (preserve back-compat) |
| Resolver use | Job + customer name lookup (existing `customers` and `jobs` tables) |
| CIL draft fields | `{ type: 'CreateQuote', source: 'whatsapp', source_msg_id, owner_id, tenant_id, occurred_at, actor: { role, actor_id }, job_id_or_name, customer_id_or_name, project_title, line_items, tax_rate_bps }` |
| Validation | `CreateQuoteCILZ.safeParse` (existing, in `quotes.js`) |
| Target handler | `handleCreateQuote` (registered `router.js:34`) |
| Confirm flow | Render line-item summary + total. Owner replies `yes/edit/cancel` before `applyCIL` runs. |
| Idempotency | `(owner_id, source_msg_id)` UNIQUE on `chiefos_quotes` (existing) |

#### `/lock` (LockQuote)

| Field | Value |
|---|---|
| Intent rule | `/^\/lock\s+/i` OR `/^lock\s+(quote\b|QT-)/i` |
| Resolver use | Fuzzy `quoteResolver` |
| CIL draft fields | `{ type: 'LockQuote', source: 'whatsapp', source_msg_id, owner_id, tenant_id, occurred_at, actor: { role: 'owner', actor_id }, quote_ref: { quote_id } }` |
| Validation | `LockQuoteCILZ.safeParse` — **PREREQUISITE: widen `source` from `z.literal('system')` to `z.enum(['portal','whatsapp','system'])` per Decision A** |
| Target handler | `handleLockQuote` (registered `router.js:38`) |
| Confirm flow | "Lock QT-…-NNNN ($X, Customer)? This is irreversible. Reply yes/cancel." |
| Idempotency | State-machine: `loadLockContext` returns existing-state for already-locked quotes; `alreadyLockedReturnShape` short-circuits without DB write (`quotes.js:4384`). source_msg_id echoed to event row for traceability. |

#### `/void` (VoidQuote)

| Field | Value |
|---|---|
| Intent rule | `/^\/void\s+/i` |
| Resolver use | Fuzzy `quoteResolver` |
| CIL draft fields | `{ type: 'VoidQuote', source: 'whatsapp', source_msg_id, owner_id, tenant_id, occurred_at, actor: { role: 'owner', actor_id }, quote_ref: { quote_id }, voided_reason }` |
| Validation | `VoidQuoteCILZ.safeParse` — **PREREQUISITE: widen `source` per Decision A** |
| Target handler | `handleVoidQuote` (registered `router.js:39`) |
| Confirm flow | "Void QT-…-NNNN? Reason: '<extracted reason>'. Reply yes/cancel." If no reason extracted, prompt: "Why? Reply with a brief reason or 'cancel'." |
| Idempotency | State-machine: already-voided returns `_avoidShape` without DB write (existing test coverage at end of `quotes.test.js`). |

#### `/reissue` (ReissueQuote — gated on Session 5)

| Field | Value |
|---|---|
| Intent rule | `/^\/reissue\s+/i` |
| Resolver use | Fuzzy `quoteResolver` (typically resolves to a voided quote) |
| CIL draft fields | `{ type: 'ReissueQuote', source: 'whatsapp', source_msg_id, owner_id, tenant_id, occurred_at, actor: { role: 'owner', actor_id }, quote_ref: { quote_id } }` |
| Validation | `ReissueQuoteCILZ.safeParse` — **schema does not yet exist; Session 5 deliverable** |
| Target handler | `handleReissueQuote` — **does not yet exist; Session 5 deliverable; replace `router.js:40` stub** |
| Confirm flow | "Reissue QT-…-NNNN as new draft? Reply yes/cancel." |
| Idempotency | `(owner_id, source_msg_id)` UNIQUE per Session 5 spec (Reissue is a creation event, so constraint-based not state-machine-based). |

### 2.5 Schema-widening prerequisite (Decision A)

`src/cil/quotes.js:3946-3950` (LockQuoteCILZ) and `src/cil/quotes.js:4618-4622` (VoidQuoteCILZ) both have:

```js
source: z.literal('system'),  // Widens in Phase A.5 to z.enum(['portal','whatsapp','system'])
```

Change both to:

```js
source: z.enum(['portal', 'whatsapp', 'system']),
```

Plus update Zod tests in `quotes.test.js` for both schemas (one test per schema asserting all three values pass). No data migration needed; `chiefos_quote_events.actor_source` is already `text` and accepts any string.

### 2.6 File placement

Either: extend existing `handlers/commands/quote.js` to add `isLockCommand`, `handleLockCommand`, etc. (denser; keeps the quote surface in one file). Or: new `handlers/commands/quoteSpine.js` (clearer separation between legacy `quote for` syntax and new `/lock`/`/void`/`/reissue` slash commands). Recommend new file — the legacy quote.js handler is documented as not persisting and pending the CIL spine; mixing the two surfaces in one file invites confusion.

---

## 3. V3 — Portal quote detail view

### 3.1 Pattern choice: `[id]` route, not Slideover

The portal has two detail-view precedents:
- **Slideover model** (expenses): `chiefos-site/app/app/activity/expenses/page.tsx:177+` — list page owns `editOpen + draft` state, renders `<Slideover>` inline. Suitable for sub-views of repeating ledger rows.
- **`[id]` route model** (jobs): `chiefos-site/app/app/jobs/[jobId]/page.tsx:1` — top-level entity page, deep-linkable, fetches via `apiFetch` + Bearer token to Express API.

Quotes are top-level entities (deep-linkable from email, signature page, share token). Use the `[id]` route model.

Route: `chiefos-site/app/app/quotes/[quoteId]/page.tsx`.

### 3.2 Tenant boundary enforcement

Two-layer:
1. **Session gate.** `useTenantGate()` at the top of the client component. Redirects to `/login` if no tenant. Pulls `tenantId` from `/api/whoami`.
2. **Query filter + RLS.** `supabase.from('chiefos_portal_quotes').select(...).eq('tenant_id', tenantId).eq('id', quoteId)` — explicit `tenant_id` filter as belt-and-suspenders on top of the view's RLS policy. Pattern matches `chiefos_portal_expenses` reads (`WelcomeClient.tsx:401`).

`requirePortalUser` middleware (`middleware/requirePortalUser.js:54`) sets `req.tenantId`, `req.portalRole`, `req.ownerId`, `req.actorId`, `req.isPhonePaired`, `req.supabaseAccessToken` — these are available to any Express route the page calls into.

### 3.3 `chiefos_portal_quotes` SECURITY INVOKER view (Decision D)

**New migration required:** `migrations/2026_04_25_chiefos_portal_quotes_view.sql` (timestamped, idempotent, reversible per CLAUDE.md migration rules).

```sql
CREATE OR REPLACE VIEW public.chiefos_portal_quotes
WITH (security_invoker = true) AS
SELECT
  q.id,
  q.tenant_id,
  q.owner_id,
  q.human_id,
  q.status,
  q.source,
  q.created_at,
  q.updated_at,
  q.voided_at,
  q.voided_reason,
  q.current_version_id,
  q.job_id,
  j.name AS job_name,
  q.customer_id,
  c.name AS customer_name,
  c.email AS customer_email,
  c.phone AS customer_phone,
  c.address AS customer_address,
  qv.id AS version_id,
  qv.version_no,
  qv.project_title,
  qv.total_cents,
  qv.tax_rate_bps,
  qv.locked_at,
  qv.sent_at,
  qv.server_hash,
  qv.superseded_by_version_id
FROM public.chiefos_quotes q
LEFT JOIN public.jobs j ON j.id = q.job_id
LEFT JOIN public.customers c ON c.id = q.customer_id
LEFT JOIN public.chiefos_quote_versions qv ON qv.id = q.current_version_id;

GRANT SELECT ON public.chiefos_portal_quotes TO authenticated;
```

`SECURITY INVOKER` makes the underlying RLS policies on `chiefos_quotes`, `chiefos_quote_versions`, `customers`, `jobs` do the tenant-isolation work. The portal user's JWT carries `auth.uid()`; the existing `chiefos_quotes_tenant_read` policy filters on `tenant_id IN (SELECT tenant_id FROM chiefos_portal_users WHERE user_id = auth.uid())`. No new policies needed.

Companion read for line items (smaller view, separate migration or same file):

```sql
CREATE OR REPLACE VIEW public.chiefos_portal_quote_line_items
WITH (security_invoker = true) AS
SELECT li.id, li.tenant_id, li.quote_id, li.version_id,
       li.position, li.description, li.quantity, li.unit_price_cents, li.line_total_cents
FROM public.chiefos_quote_line_items li;

GRANT SELECT ON public.chiefos_portal_quote_line_items TO authenticated;
```

### 3.4 Page spec

| Section | Behavior |
|---|---|
| Header | `human_id` + status badge (color-coded: draft=gray, sent=blue, viewed=cyan, signed=green, locked=indigo, voided=red) |
| Customer card | Name, email, phone, address — from view |
| Job card | `job_name` + link to `/jobs/[jobId]` |
| Version metadata | `version_no`, `created_at`, `sent_at`, `locked_at`, `voided_at + voided_reason` (when applicable) |
| Line items table | From `chiefos_portal_quote_line_items` filtered by `version_id = current_version_id` |
| Totals | `total_cents`, tax breakdown via `tax_rate_bps` |
| Signature panel | Status from `chiefos_quote_signatures` (separate read; existing table per migrations); link to share token if signed |
| Action buttons (owner-only, conditional) | Lock (when `status='signed'`), Void (when `status IN ('draft','sent','viewed','signed','locked')`), Reissue (when `status='voided'`), View Signature (when `status IN ('signed','locked')`), Download PDF (always) |

Owner-only gating at component level via `req.portalRole === 'owner'` (read from `useTenantGate` extension or new `useActorRole` hook; document choice during implementation). Server-side enforcement happens in V4 — UI gating is UX, not security.

### 3.5 Failure modes

| Mode | Behavior |
|---|---|
| Quote not in tenant (RLS filtered out) | 404 page ("Quote not found") — do NOT distinguish "doesn't exist" from "wrong tenant" (don't leak existence) |
| `current_version_id` null | Render header + status only; line items section shows "No version available" |
| Customer or job FK soft-deleted | Render with `customer_name = '(deleted customer)'`; the view's LEFT JOIN preserves the quote row |

---

## 4. V4 — Portal action API

### 4.1 Endpoint shape (Decision C)

REST, matching `routes/jobsPortal.js` precedent:

```
POST /api/quotes/:quoteId/lock        body: {}
POST /api/quotes/:quoteId/void        body: { voided_reason: string }
POST /api/quotes/:quoteId/reissue     body: {}
```

File: `routes/quotesPortal.js`. Mounted in `index.js` alongside other portal routes.

### 4.2 Auth chain

```js
router.post(
  '/api/quotes/:quoteId/lock',
  requirePortalUser(),    // sets req.tenantId, req.portalRole, req.ownerId, req.actorId
  express.json(),
  async (req, res) => {
    mustOwner(req.portalRole);   // 403 PERMISSION_DENIED if not owner
    // ... applyCIL call
  }
);
```

`mustOwner` helper currently file-local at `routes/crewAdmin.js:71`. **Promote to shared middleware** (`middleware/requireOwnerRole.js`) during A.5 implementation; both crewAdmin and quotesPortal then import from the shared location. CLAUDE.md "owner-only action" pattern.

### 4.3 Idempotency strategy (Decision B)

Client (Next.js page) generates `crypto.randomUUID()` per action submission, sends as header:

```
Idempotency-Key: 7c9e6679-7425-40de-944b-e07fc1f90ae7
```

Express adapter maps to CIL envelope:

```js
const idempotencyKey = req.headers['idempotency-key'] ?? crypto.randomUUID();
const cilEnvelope = {
  type: 'LockQuote',
  source: 'portal',                  // requires Decision A widening
  source_msg_id: idempotencyKey,
  tenant_id: req.tenantId,
  occurred_at: new Date().toISOString(),
  actor: { role: 'owner', actor_id: req.actorId || req.ownerId },
  quote_ref: { quote_id: req.params.quoteId },
};
const ctx = {
  owner_id: req.ownerId,
  tenant_id: req.tenantId,
  traceId: req.correlationId ?? crypto.randomUUID(),
  source_msg_id: idempotencyKey,
};
const result = await applyCIL(cilEnvelope, ctx);
```

Why this works:
- **Lock/Void:** state-machine-idempotent (already-locked / already-voided short-circuit return shapes). The Idempotency-Key buys traceability in `chiefos_quote_events.external_event_id`, not safety. A double-click → second request hits already-locked → returns same `_alreadyLocked` shape.
- **Reissue:** `(owner_id, source_msg_id)` UNIQUE constraint on `chiefos_quotes` per Session 5 spec. The Idempotency-Key is the dedup key. A double-click → second request raises unique-violation → handler catches → returns existing reissued-quote shape with `meta.already_existed = true`.

If the client omits the header (curl, retry script), the adapter generates a fresh UUID — first-call semantics, no dedup. This is intentional and matches the existing optional posture of `source_msg_id` on `LockQuoteCILZ` / `VoidQuoteCILZ`.

### 4.4 Audit logging

No separate audit-table writes. Each Phase A handler emits a `lifecycle.*` row into `chiefos_quote_events` inside its transaction:
- `handleLockQuote` → `emitLifecycleLocked` (per existing impl)
- `handleVoidQuote` → `emitLifecycleVoided`
- `handleReissueQuote` (Session 5) → `emitLifecycleReissued`

Event row carries `actor_user_id` (from `req.actorId`), `actor_source = 'portal'`, `correlation_id` (from CIL ctx), `external_event_id` (the Idempotency-Key). This IS the audit chain — CLAUDE.md compliant.

### 4.5 Calls into Phase A handlers — no logic duplication

The route file is **adapter only**. It validates the inbound HTTP request, builds the CIL envelope, calls `applyCIL`. All domain logic (state-machine transitions, version creation, event emission, idempotency checks) lives in `src/cil/quotes.js`. This preserves the CIL contract: Ingress → Draft → Validation → Domain Mutation, with the route playing only the Ingress role.

### 4.6 Request validation

- `quoteId` is a UUID — validate at route level: `if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.quoteId)) return 400`. Or use `zod.string().uuid()`.
- `voided_reason` (void endpoint only) — non-empty string, max 500 chars.
- All other validation lives inside the CIL Zod schemas (`LockQuoteCILZ`, `VoidQuoteCILZ`, `ReissueQuoteCILZ`). The route does not duplicate.

### 4.7 Error responses

Per CLAUDE.md error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Owner-only action",
    "hint": "Ask the owner to perform this action",
    "traceId": "abc123"
  }
}
```

Status code mapping:
- `PERMISSION_DENIED` → 403
- `TENANT_AMBIGUOUS` → 403 (don't leak whether the entity exists)
- CIL validation failure → 422
- State-machine illegal transition (e.g., void already-voided) → 200 with `meta.already_voided = true` (idempotent return), **not** an error
- Internal error → 500 with traceId, no stack

---

## 5. V5 — Dependency map + slicing

### 5.1 Dependency graph

```
                  ┌──────────────────────────────┐
                  │ Decision A — schema widening │
                  │ (LockQuoteCILZ.source,       │
                  │  VoidQuoteCILZ.source)       │
                  └────────────┬─────────────────┘
                               │
                ┌──────────────┴──────────────┐
                │                             │
                ▼                             ▼
        ┌───────────────┐            ┌───────────────┐
        │   SLICE 1     │            │   SLICE 2     │
        │  (WhatsApp)   │            │   (Portal)    │
        │               │            │               │
        │  V1 resolver  │            │  V3 detail    │
        │  V2 commands  │            │  V4 actions   │
        └───────┬───────┘            └───────┬───────┘
                │                            │
                │                            ▼
                │                   ┌────────────────────┐
                │                   │ Migration:         │
                │                   │ chiefos_portal_    │
                │                   │ quotes view        │
                │                   │ (Decision D)       │
                │                   └────────────────────┘
                │
                └─────── Both slices: /reissue (and reissue button)
                         depend on Session 5 (ReissueQuote handler)
```

### 5.2 Recommended ship order

1. **Session 5 (Phase A close):** Implement ReissueQuote per `PHASE_A_SESSION_5_REISSUEQUOTE_DIRECTIVE.md`.
2. **Re-verify Phase A close:** Re-run `PHASE_A_CLOSE_VERIFICATION.md` harness; lift GATED marker on this doc.
3. **Session 6 (A.5 Slice 1):** Schema widening (Decision A) + V1 resolver + V2 commands (`/quote`, `/lock`, `/void`, `/reissue`). Single PR. Ships WhatsApp lifecycle to owners.
4. **Session 7 (A.5 Slice 2):** `chiefos_portal_quotes` view migration (Decision D) + V3 detail page + V4 action API (Decisions B, C). Single PR. Ships portal lifecycle.

Sessions 6 and 7 are independent post-Session-5; could run in parallel in two worktrees if a second contributor is available.

### 5.3 File/handler counts

**Session 5 (ReissueQuote):**
- 1 schema (`ReissueQuoteCILZ` in `quotes.js`)
- 1 handler (`handleReissueQuote` in `quotes.js`)
- 2-3 DB primitives in `quotes.js` (e.g., `loadReissueContext`, `insertReissuedVersion`, `markPriorVersionSuperseded`)
- 1 router edit (uncomment `router.js:40`)
- 1 ceremony entry (§32 in `docs/QUOTES_SPINE_CEREMONIES.md`)
- Test additions to `quotes.test.js` (~15-25 cases: schema, primitives, handler happy path, immutability, idempotency replay, cross-tenant isolation, supersession chain integrity)

**Session 6 (Slice 1: V2 + V1):**
- 1 new module (`src/cil/quoteResolver.js`)
- 1 new commands file (`handlers/commands/quoteSpine.js`)
- 1 dispatcher edit (`handlers/commands/index.js` — split Pro-gate + register new commands)
- 2 schema edits (`quotes.js` — widen Lock + Void source)
- 2 new test files (`quoteResolver.test.js`, `quoteSpine.test.js`)
- ~30-50 test cases total

**Session 7 (Slice 2: V3 + V4):**
- 1 new migration (`chiefos_portal_quotes` view + line items companion view)
- 1 new Next.js route (`chiefos-site/app/app/quotes/[quoteId]/page.tsx`)
- 1 new Express route (`routes/quotesPortal.js`)
- 1 new shared middleware (`middleware/requireOwnerRole.js`, promoting from `crewAdmin.js:71`)
- 1 dispatcher edit (`index.js` — mount `quotesPortal`)
- 1 portal SDK addition (`chiefos-site/lib/quoteActions.ts` for the three POST calls)
- Test additions: integration test for `quotesPortal.js` (cross-tenant + idempotency); UI test for the page is optional unless test infrastructure is established
- ~20-40 test cases

(Counts exclude the doc-debt items in §0.4.)

---

## 6. Decisions needing founder approval (consolidated)

Restated from §0.3 with full context:

### Decision A — Schema widening: `LockQuoteCILZ.source` and `VoidQuoteCILZ.source`

**Recommendation:** APPROVE.

`source: z.literal('system')` → `source: z.enum(['portal', 'whatsapp', 'system'])`.

**Why:** Both schemas already carry the comment "Widens in Phase A.5" (`quotes.js:3946-3950`, `4618-4622`). System callers continue to pass `'system'`; new portal callers pass `'portal'`; new WhatsApp callers pass `'whatsapp'`. No behavioral change; the `source` field flows into `chiefos_quote_events.actor_source` for audit traceability.

**Tradeoff:** None observable. The alternative (separate schemas per source) would multiply schema count and validation complexity for zero gain.

**Founder status:** _pending_

### Decision B — Portal action API idempotency: client-supplied `Idempotency-Key` header

**Recommendation:** APPROVE.

UI generates `crypto.randomUUID()` per action submission; sends as `Idempotency-Key` header; route adapter maps to CIL envelope `source_msg_id`.

**Why:** Lock/Void are state-machine-idempotent in the existing handlers. Reissue (Session 5) will use `(owner_id, source_msg_id)` UNIQUE per the existing CreateQuote pattern. The header strategy unifies both: it's the dedup key for Reissue and the trace key for Lock/Void. Matches existing CIL `source_msg_id` optional posture.

**Tradeoff:** Server-issued nonce alternative (option B in initial investigation) requires a round-trip per action; rejected as overkill. DB-level constraint on `(quote_id, action_type, day)` (option C) blocks legitimate same-day Reissue+Void cycles; rejected as wrong model.

**Founder status:** _pending_

### Decision C — Portal action API endpoint shape: REST

**Recommendation:** APPROVE REST.

`POST /api/quotes/:quoteId/lock`, `POST /api/quotes/:quoteId/void`, `POST /api/quotes/:quoteId/reissue`. File: `routes/quotesPortal.js`.

**Why:** Matches existing portal mutation pattern (`routes/jobsPortal.js`, `routes/crewAdmin.js`). RPC alternative (`POST /api/quotes/action` with action body) diverges from precedent without benefit and complicates future per-action authorization rules.

**Tradeoff:** None observable.

**Founder status:** _pending_

### Decision D — `chiefos_portal_quotes` view scope

**Recommendation:** APPROVE the view spec in §3.3 above.

SECURITY INVOKER, joins `chiefos_quotes + chiefos_quote_versions + chiefos_quote_line_items + customers + jobs`, RLS via `chiefos_portal_users` membership.

**Why:** Matches `chiefos_portal_expenses` precedent (`migrations/2026_04_22_rebuild_views.sql:57`). SECURITY INVOKER means underlying RLS policies do the work — no policy duplication.

**Tradeoff:** Wide view denormalizes some columns (`customer_name`, `job_name`) that could be fetched via separate queries; the wider join saves the page from N+1 fetches at the cost of a slightly heavier read. Acceptable per detail-page read pattern.

**Founder status:** _pending_

---

## 7. Doc-debt addenda (carry into Session 5 wrap)

1. **`CHIEFOS_EXECUTION_PLAN.md`:** VoidQuote checkbox (Phase A handler list) is `[ ]` despite Session 4 close at `f4b54fe4`. Update to `[x]` during Session 5 wrap. Add ReissueQuote checkbox state alongside.
2. **Missing `PHASE_A_SESSION_4_VOIDQUOTE_HANDOFF.md`:** Session 4 (VoidQuote) did not produce its own handoff doc. Two options:
   - (a) Backfill Session 4 handoff during Session 5 wrap (state-of-Phase-A snapshot before Session 5 changes).
   - (b) Skip and produce one consolidated `PHASE_A_CLOSE_HANDOFF.md` after Session 5 closes Phase A — this is cleaner per CLAUDE.md handoff discipline ("Phase-arc handoffs are rewritten state-reflection per session, not appended-to").

   Recommendation: (b). One Phase A close handoff after Session 5; archive `PHASE_A_SESSION_3_LOCKQUOTE_HANDOFF.md` to `docs/_archive/handoffs/` in the same commit.

---

## §8. Addendum — Session 5 deltas (2026-04-25)

**Summary:** No material V1/V2/V3/V4/V5 spec changes. ReissueQuote slotted into the predicted integration points. Two minor tightenings noted for Session 6/7 pre-flight; both are additive and do not alter the slice contracts.

### §8.1 V1 Resolver — no delta

The deterministic ladder (regex → ILIKE → date → compound → LLM scoring) is unchanged. ReissueQuote does not introduce any new addressable column on `chiefos_quotes` or `chiefos_quote_versions` beyond `source_msg_id` (which is internal-dedup-only, not user-addressable). The resolver design specified in §1 stands as-authored.

### §8.2 V2 Commands — minor pin on `/reissue` handler target

The `/reissue` command spec at §2.4 refers to `handleReissueQuote` as "Session 5 deliverable." That handler now exists at `src/cil/quotes.js` (registered in `src/cil/router.js:40`). The command spec stands as-authored. **`ReissueQuoteCILZ.source` shipped as `z.enum(['portal','whatsapp','system'])` directly** — Session 6 widening (Decision A on Lock/Void) does not affect Reissue (the Reissue schema was authored fresh, not widened).

### §8.3 V3 Portal — no delta

`chiefos_portal_quotes` view migration spec at §3.3 is unchanged. The view does NOT need a `source_msg_id` column (internal-dedup-only). It DOES expose `current_version_id` which now reflects ReissueQuote-driven version swings — already in the proposed column list.

### §8.4 V4 Portal action API — pin on idempotency surface for Reissue

Session 5 implementation confirmed the proposed Idempotency-Key strategy (Decision B) works for ReissueQuote: the partial UNIQUE on `chiefos_quote_versions(owner_id, source_msg_id)` (Migration 2026_04_25 §1.2) is the dedup surface; the portal adapter maps `Idempotency-Key` header → CIL envelope `source_msg_id` → version row `source_msg_id` column. Replays land on the §17.10 idempotent_retry path via `lookupPriorReissuedVersion` → `alreadyReissuedReturnShape` with `meta.already_existed = true`. **Decision B remains recommended.**

### §8.5 V5 Dependency map — minor

Session 5 added one prerequisite migration (`2026_04_25_chiefos_quote_versions_source_msg_id.sql`). Apply order: between `rebuild_rls_coverage_gap_fix` and `drift_detection_script` per `REBUILD_MIGRATION_MANIFEST.md`. Already applied in Session 5; no Session 6/7 work depends on this except `/reissue` which expects the partial UNIQUE to exist.

### §8.6 Doc-debt items resolved

- `CHIEFOS_EXECUTION_PLAN.md` — VoidQuote and ReissueQuote checkboxes both updated to `[x]` in this session's commit set. (Was listed as Session 5 wrap task.)
- `PHASE_A_SESSION_4_VOIDQUOTE_HANDOFF.md` — NOT backfilled (founder Decision: option b confirmed). Replaced by `PHASE_A_CLOSE_HANDOFF.md` which covers the full Phase A arc.
- `docs/PHASE_A_SESSION_3_LOCKQUOTE_HANDOFF.md` archived to `docs/_archive/handoffs/` per CLAUDE.md handoff discipline.

### §8.7 New follow-up surfaced during Session 5 (not a V-spec delta)

`CIL_TO_EVENT_ACTOR_SOURCE` map (`src/cil/quotes.js:105`) has no entry for the `'portal'` CIL source value — it currently maps to `undefined → null` in the audit `actor_source` column. Session 6's Decision A (LockQuoteCILZ/VoidQuoteCILZ source widening) should add the `portal: 'portal'` entry alongside the schema widening. ReissueQuote integration test #9 (`source enum widening`) pins this gap with a tolerant assertion (`expect([null, 'portal']).toContain(rows[0].actor_source)`); failing that test in Session 6 means Session 6 needs to tighten the assertion to expect `'portal'` once the map is updated.

### §8.8 Recommendation

Session 6 (A.5 Slice 1: V1 + V2) and Session 7 (A.5 Slice 2: V3 + V4) may proceed against the V1–V5 specs as authored, with the §8.7 map-update folded into Session 6 alongside Decision A. No re-scoping needed; no founder approval changes needed.
