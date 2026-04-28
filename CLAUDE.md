# CLAUDE.md — ChiefOS

## What This Project Is

ChiefOS is an AI-native, WhatsApp-first operating system for small businesses. It has one authoritative reasoning interface (Chief) for the owner/operator and many ingestion inputs (the senses) for employees/contractors. The MVP spine is complete. Beta expansion is in progress.

Stack: Twilio → Vercel (Express) → Supabase (Postgres + RLS + Storage). Serverless-first. Provider-agnostic LLM layer.

## Critical Architecture Rules

### Identity Model (Dual-Boundary — Never Collapse)

- **tenant_id (uuid):** Portal/RLS boundary. All portal queries MUST filter by tenant_id. Resolved via membership table.
- **owner_id (digits string):** Ingestion/audit boundary. All WhatsApp/backend writes MUST include owner_id. Must resolve deterministically to tenant_id.
- **user_id (digits string):** Actor identity. Scoped under owner_id. NEVER used as tenant boundary.
- **UUIDs:** Row identifiers only. Never tenant boundary, user identity, or owner identity.
- If tenant resolution is ambiguous → **FAIL CLOSED** (block write, log error, treat as Free tier).

### Query Rules

Every query MUST include a tenant boundary key appropriate to the surface:

```sql
-- Portal queries: use tenant_id
SELECT ... FROM <table> WHERE tenant_id = $1 AND ...;

-- Ingestion/backend queries: use owner_id  
SELECT ... FROM <table> WHERE owner_id = $1 AND ...;

-- Updates/deletes: NEVER by UUID alone
UPDATE <table> SET ... WHERE owner_id = $1 AND id = $2;
```

**FORBIDDEN:** `WHERE id = $1` alone. `WHERE user_id = $1` alone. Queries without tenant boundary. Cross-tenant joins. Implicit ownership inference.

### Canonical Data

- Financial truth: `public.transactions` (kind = expense/revenue/etc.)
- Portal reads via tenant-safe views (e.g., `chiefos_portal_expenses`)
- Legacy expense tables are archived — do NOT reintroduce as read surfaces
- Compatibility views may include placeholder columns (e.g., deleted_at = NULL) for UI stability

### CIL (Canonical Intermediate Language)

All ingestion MUST follow: Ingress → CIL Draft → Validation → Domain Mutation.
No direct ingestion-to-database writes. No LLM creativity at this layer.
Amounts in cents. ISO datetimes. E.164 phone normalization.

### Idempotency

All writes MUST be idempotent. Enforced by (owner_id, source_msg_id, kind) or per-kind unique constraints.
Replays must never create duplicates.

### Plan Gating (Fail-Closed)

- Plan resolves by owner_id, never by user_id or cached state
- If plan lookup fails → treat as Free, block gated actions
- Check quota BEFORE execution, consume BEFORE execution (never after)
- Reason codes: NOT_INCLUDED, OVER_QUOTA

## Key Tables

- `public.transactions` — canonical financial spine (expenses, revenue)
- `public.time_entries_v2` — timeclock entries
- `public.jobs` — job spine (job_int_id for linkage)
- `public.file_exports` — generated export files
- `public.media_assets` — receipts, images, documents
- `chiefos_portal_expenses` — portal-safe expense view
- `chiefos_portal_users` — portal membership (tenant_id scoping)

## Error Handling

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

Every response within 8 seconds. Never expose stack traces. Never crash on malformed input. Safe-fail with user-facing message.

## One Mind, Many Senses

- Exactly ONE reasoning seat per business (the Owner via Chief)
- Employees are ingestion identities only — they capture facts, not reasoning
- Micro-apps are senses: capture/confirm/submit only, no reasoning
- Scale by adding senses, never by adding minds

## Stage Awareness

- MVP: COMPLETE
- Beta: IN PROGRESS (sequenced via Execution Playbook)
- Public monetized launch: NOT APPROVED

Beta pause rule: if transport stability, tenant isolation, idempotency, or plan enforcement regress → all Beta work stops until restored.

## Beta Exclusions (Do Not Build)

Multi-seat reasoning. Autonomous forecasting. Auto-execution of financial changes. Cross-tenant benchmarking. Silent data mutation. Predictive analytics without history. Payroll. Autonomous advice.

## Migration Safety

- Never change owner_id datatype without full migration plan
- Never remove owner_id from ingestion/audit tables
- Never infer tenant from user_id alone
- Any migration touching transactions, time_entries, exports, or quotas requires regression test + cross-tenant isolation test
- All migrations must be timestamped, documented, idempotent, and reversible

## Pre-Commit Checklist

Before any deployment:
- [ ] All queries include tenant boundary (tenant_id or owner_id)
- [ ] No cross-tenant joins
- [ ] Writes are idempotent (source_msg_id / dedupe_hash)
- [ ] Plan gating is fail-closed
- [ ] No PII in logs
- [ ] Exports verify tenant boundary before returning bytes
- [ ] Error responses include traceId, never stack traces

## Active Execution Plan

Reference docs by name only. Do NOT pre-load.

## Context Budget (binding)

For any session, do not pre-load more than 2 reference docs.

If a task would require reading more than 2 reference docs, use the Agent/Explore subagent — it reads what it needs and returns a 1-page summary. The bulk never enters the parent session context.

If a task references "the rebuild" or "the quotes spine" generically, ask the user which specific surface before reading anything. Do not pre-load FOUNDATION_CURRENT.md, REBUILD_MIGRATION_MANIFEST.md, QUOTES_SPINE_DECISIONS.md, or session reports speculatively.

If the user asks about a completed session, read only the specific SESSION_*_REPORT.md they reference. Other session reports stay in `docs/_archive/sessions/` and are not auto-loaded.

When verifying schema, decisions-log entries, or handler precedents: use targeted reads (specific line ranges via the `view` tool) rather than full-file loads. The decisions-log and schema docs are large; targeted reads pull only what's needed.

Verification-first discipline is non-negotiable. Pre-implementation verification (grep actual source, read actual handler precedents, check actual schema constraints) MUST continue. Targeted reads ARE verification; defensive pre-loading of full files is not. Do not soften verification rigor in pursuit of token savings.

## Current Reference Docs (root + docs/, small)

- `CLAUDE.md` — this file (always loaded)
- `FOUNDATION_CURRENT.md` — canonical schema state summary (load only when schema-relevant)
- `REBUILD_MIGRATION_MANIFEST.md` — migration apply order (load only when migration-relevant)
- `PHASE_4_5_DECISIONS_AND_HANDOFF.md` — current forward planning (load only when sequencing decisions are involved)
- `PHASE_5_PRE_CUTOVER_CHECKLIST.md` — cutover validation list (load only at cutover time)
- `docs/QUOTES_SPINE_DECISIONS.md` — active CIL architecture patterns (§3A, §17.19-§17.25, §17.26 reservation). Load when quote-spine handler work is active.
- `docs/QUOTES_SPINE_CEREMONIES.md` — production ceremony archives (§27, §28, §30, future §31/§32). Load only when ceremony work is active.
- `docs/PHASE_A_SESSION_3_LOCKQUOTE_HANDOFF.md` — current Phase A session handoff. Load when resuming Phase A work.

## Historical Reference (archived, do not auto-load)

- `docs/_archive/sessions/` — all completed R-session and amendment reports
- `docs/_archive/foundation/FOUNDATION_P1_SCHEMA_DESIGN_FULL.md` — full schema design history (read only if FOUNDATION_CURRENT.md is insufficient)
- `docs/_archive/handoffs/` — superseded handoff docs

## Session Discipline

- `/clear` between unrelated tasks (rebuild work vs portal UI work vs feature build)
- Directives reference docs by name; Claude Code reads only what the directive's "Reference docs" section explicitly lists
- Session reports stay terse (30-50 lines) and are filed to `docs/_archive/sessions/` once the session closes


## Rebuild Remediation Protocol (Active)

The foundation rebuild is mid-remediation. R-sessions (R1-R9) migrate call sites from pre-rebuild to rebuild shape. Sessions are governed by directives; this section is the persistent context.

### Quarantined Zones (do not modify outside their dedicated session)

- **Crew cluster** (`services/crewControl.js`, `routes/crewControl.js`, `routes/crewReview.js`): pending R3b. Contains scope-conflict headers. Writes to pre-rebuild `chiefos_activity_logs` shape — will break at cutover; awaiting founder decisions F2/F3/F4 from R3a report.
- **Actor-memory cluster** (`services/postgres.js` `getActorMemory` / `patchActorMemory` + callers in `services/agent/index.js`, `services/answerChief.js`, `services/orchestrator.js`): pending R4c. Writes to DISCARDed `chief_actor_memory` table.

### Canonical Helpers (use, don't reinvent)

- `services/actorContext.js` — exports `resolvePortalActor`, `resolveWhatsAppActor`, `buildActorContext`, `ensureCorrelationId`
- `services/activityLog.js` — exports `emitActivityLog`, `emitActivityLogBatch`. Single write surface for `chiefos_activity_logs` (flat rebuild shape per FOUNDATION §3.11)
- Middleware populates: `req.tenantId`, `req.ownerId`, `req.actorId`, `req.actorRole`, `req.correlationId`, `req.isPhonePaired`

### Identity Addendum (P1A-4)

`public.users.auth_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL` is the reverse pointer for portal↔WhatsApp linkage. UNIQUE on non-NULL. Populated by OTP verification in `routes/webhook.js` via `services/phoneLinkOtp.js`. Nullable because most ingestion identities are not paired to a portal auth user.

### Session Directive Protocol

R-session directives are intentionally terse. They reference authoritative docs (FOUNDATION_CURRENT.md, the specific session reports under `docs/_archive/sessions/` cited by name, this CLAUDE.md) rather than restating them. When executing a directive:

- Read "Reference docs" entries only if the session needs them
- Skip "zero-context preflight" steps — CLAUDE.md is the preflight
- Produce terse session reports: Status, Files changed, Findings (1-line bullets), Bugs flagged (severity + file:line + 1-line), Next blocks on. 30-50 lines max. Full diffs live in git.
- Do not write executive summaries unless the directive asks for one
- Do not repeat scope exclusions from CLAUDE.md in the session report

### Introspection Discipline

Every session that modifies code must verify its assumptions against actual schema/code before authoring. The introspection-first pattern has caught real bugs (F2 camelCase/snake_case in R4b-finalize, column-shape drift in multiple amendments). Scope: verify what could have drifted since the previous session, not what's stable.

### STOP Conditions (universal)

Halt and report if:
- Scope expands beyond the directive (more files than expected, new architectural decisions needed)
- Schema drift between spec and migration files
- Cross-tenant leakage risk discovered
- Directive conflicts with this CLAUDE.md (CLAUDE.md wins)