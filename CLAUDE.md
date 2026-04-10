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

Read CHIEFOS_EXECUTION_PLAN.md before starting any work.
Current Phase: 3 — Onboarding & Conversational Intelligence Polish
Phase 1 ✅ COMPLETE | Phase 2 ✅ COMPLETE | Phase 3 🔄 IN PROGRESS
Remaining Phase 3 build items:
  - Live PWA install verification (Android + iOS)
Do not accept work outside the current phase unless explicitly approved by the developer.
Before suggesting any new feature or refactor, check if it is already built (see CHIEFOS_EXECUTION_PLAN.md audit notes) to avoid rebuilding working code.
