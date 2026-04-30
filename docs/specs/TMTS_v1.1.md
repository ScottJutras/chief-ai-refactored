# ChiefOS — Trial Architecture Technical Specification

**Document version:** 1.1
**Status:** Implementation-ready
**Owner:** Scott Jutras
**Last Updated:** April 28, 2026
**Audience:** Development team (Scott + Claude Code; future hires)
**Authority:** Subordinate to Engineering Constitution v4.0, Monetization & Pricing v4.0, North Star v4.0
**Stage:** Pre-launch (zero users)

**Changes from v1.0:**
- Reframed from "migration" to "pre-launch architecture" — no existing users to preserve
- Trial reduced from 30 days to 14 days
- Extension state removed (no separate 14-day card-collection state)
- Founding Member tier removed entirely
- Read-only window reduced from 90 days to 14 days
- Added landing page acquisition flow (usechiefos.com/start)
- Added schema audit as Phase 0 prerequisite
- Added dual-trigger trial clock start (WhatsApp message OR portal login)
- Added auth architecture (magic link → password → SMS new-device verification → optional WebAuthn)
- Added conversational onboarding choreography (replacing scheduled-broadcast reminder model)
- Added WhatsApp template library specification
- Removed all migration sections (no existing users)

**Amendment 2026-04-29 (in-place; no version bump):** §5.1, §6, §16.2 phone storage location corrected from `public.users.phone_number` to `public.chiefos_tenants.phone_e164`. Reason discovered during Phase 0 audit: `public.users` is multi-actor-per-owner (the rebuilt schema stores N user rows per owner), so phone correctly belongs on the 1:1 tenant record. Column renamed `phone_number` → `phone_e164` for format-explicitness. Partial `UNIQUE INDEX ... WHERE phone_e164 IS NOT NULL` named explicitly as the structural anti-abuse mechanism per §16.2 intent. Implementation: migration `2026_04_29_phase0_p1_phone_e164_on_chiefos_tenants.sql` + RPC amendment `2026_04_29_amendment_p1a13_chiefos_finish_signup_rpc_phone_e164.sql`.

**Amendment 2026-04-29 (Phase 0 p2+p3):** §4.1 audit list clarified — `paid_breaks_policy` is binary enum (`paid`|`unpaid`) per implementation, default `'unpaid'`, lives on `chiefos_tenants`. `tax_region` added as GENERATED column from `country || '-' || province` on `chiefos_tenants`; `tax_code` retained as distinct tax-math regime (`HST_ON`, `GST_ONLY`, etc.). Dead `region` column dropped. Implementation: migration `2026_04_29_phase0_p2_p3_chiefos_tenants_paid_breaks_and_tax_region.sql`.

**Amendment 2026-04-29 (Phase 1 PR-A — lifecycle + plan_key placement):** §5.1, §5.2, §6, §7, §8, §9.4 corrected. All 12 §5.1 lifecycle/activation columns + `reminders_sent` JSONB are placed on `public.chiefos_tenants`, NOT `public.users`. §5.2 `plan_key` is moved to `public.chiefos_tenants` and dropped from `public.users`. Reason: every column is per-business state; `public.users` is multi-actor-per-owner (UNIQUE `(owner_id, user_id)`), so per-business state on that table forces denormalization across crew rows. Same precedent that drove `phone_e164` → `chiefos_tenants` in the prior amendment. §5.2 also corrects the constraint name (`users_plan_key_check` → `users_plan_key_chk`, the actual production name) and adds the explicit `DROP COLUMN users.plan_key` step. §6 plan-resolution and §7/§8/§9.4 transition logic now read/write lifecycle and plan_key via `chiefos_tenants` keyed by `owner_id` (or by JOIN through `users.tenant_id` where the entry surface is owner_id-bound). Implementation: migration `2026_04_29_phase1_pra_lifecycle_and_plan_key_on_chiefos_tenants.sql` + RPC amendment `2026_04_29_amendment_p1a14_chiefos_finish_signup_rpc_lifecycle_and_plan.sql`. Application-code reads of `users.plan_key` tracked under `P1B-application-code-plan-key-source-update` for post-Phase-1 cleanup.

**Amendment 2026-04-29 (Phase 1 PR-B — §5.4 split into landing_events + acquisition_events):** §5.4 rewritten. The v1.1 spec literal had two structural defects: (a) `user_id UUID REFERENCES public.users(id)` does not compile because `public.users` has no `id` column (PK is `user_id text`); (b) pre-signup events fire before any tenant row exists, so a single table with NOT NULL tenant FK is impossible. Resolution: split into two tables. `public.landing_events` captures pre-signup anonymous funnel (`landing_page_viewed`, `landing_page_form_submitted`, `whatsapp_deep_link_clicked`) — no `tenant_id`, no RLS (service-role only). `public.acquisition_events` captures post-signup tenant-scoped events (`first_whatsapp_message_sent`, `first_portal_login`, `first_capture`, `first_job_created`, `first_ask_chief_question`, `paid_conversion`) — `tenant_id UUID NOT NULL REFERENCES chiefos_tenants(id) ON DELETE CASCADE`, RLS enabled with SELECT policy scoped via `chiefos_portal_users` membership. Both tables share `anonymous_session_id TEXT` to bridge end-to-end funnel queries via `UNION ALL`. INSERTs occur via SECURITY DEFINER functions or service-role contexts (no INSERT policy for portal users). Implementation: migration `2026_04_29_phase1_prb_acquisition_events_and_landing_events.sql`. Event-emitting application code is a subsequent workstream.

---

## 1. Purpose

This document specifies the trial-based access architecture for ChiefOS at pre-launch. It is binding on all development work touching plan resolution, quota enforcement, billing, user lifecycle, onboarding, and acquisition flows. Any deviation requires explicit owner approval.

This is greenfield architecture in a pre-launch product. No customer data exists yet. The architectural rigor is engineered for the contractor signing up tomorrow, not for any historical state.

---

## 2. Scope

### What this specification defines

- The complete user lifecycle from ad click through paid conversion or archive
- The acquisition-to-activation flow via landing page → WhatsApp or portal
- The conversational onboarding choreography for the 14-day trial
- The Stripe integration for Starter, Pro, and Enterprise tiers
- The auth architecture (magic link, password, SMS verification, optional biometric)
- The portal cooperation pattern (when WhatsApp came first vs portal came first)
- The WhatsApp template library required for re-engagement
- Edge cases, testing requirements, deployment sequence

### What is intentionally excluded

- Founding Member tier (decision: not pursuing)
- Extension state between trial and paid (decision: trial converts directly to paid or read-only)
- Crew member onboarding for Pro plans (existing architecture preserved; not modified here)
- Multi-language support (English only at launch)
- Native mobile app (PWA only at launch)
- Voice authentication (decision: not pursuing)
- Migration of existing users (no existing users to migrate)

---

## 3. Stage Gate Prerequisites

Before any code in this specification is implemented, the following must be confirmed true. These are non-negotiable per the Beta Pause Rule (Engineering Constitution Section 5; Execution Playbook Section 3).

### 3.1 Twilio WhatsApp production status

**Required:** ChiefOS uses a Twilio production WhatsApp Business number, not a sandbox number.

**Verification step:** Confirm the WhatsApp number in active use does not require users to send a "join [keyword]" code before receiving messages. Sandbox numbers require this; production numbers do not.

**Reason this matters:** The acquisition flow depends on contractors clicking a deep link, sending "Hi Chief," and receiving an immediate response. Sandbox numbers break this flow because the contractor must first send a join code, which destroys the activation experience.

If currently on sandbox: production approval is a 2-4 week dependency through Twilio + Meta business verification. This must be initiated before development begins, or development blocks waiting for it.

### 3.2 Stripe webhook signature verification

**Required:** Existing Stripe webhook handler verifies signature on every event and rejects unsigned or malformed requests.

**Verification step:** Test with a deliberately malformed signature; verify rejection logged and 400 response returned.

### 3.3 RLS and identity boundary integrity

**Required:** Per Engineering Constitution Section 2, the dual-boundary identity model is correctly enforced. Specifically:

- `tenant_id` (uuid) is the portal/RLS boundary
- `owner_id` (digits) is the ingestion/audit boundary
- `user_id` (digits) is the actor identity scoped under owner_id
- These are not collapsed into a single ID anywhere in the codebase

**Verification step:** Run cross-tenant isolation test (Engineering Constitution Section 6) before development begins. If any test fails, this is a higher-priority fix than the trial architecture.

### 3.4 Backups verified

**Required:** Database backups have run successfully within the past 24 hours and a restore-from-backup procedure has been validated against staging.

**Reason:** Even though there are no production users, the architecture work introduces schema changes that should be reversible if a serious issue surfaces during initial launch.

### 3.5 Schema audit (Phase 0)

This is the first development task before any new code is written. See Section 4.

---

## 4. Phase 0 — Schema Audit and Consolidation

Before any new code is written, audit the existing schema for business-state field consolidation. This is required because v1.1 architecture assumes a single canonical source of truth for each piece of business state, and that assumption needs to be verified in the actual codebase.

### 4.1 Fields to audit

For each of the following business-state fields, identify every location where it is read or written:

- `business_name` — the contractor's company name
- `timezone` — IANA timezone string (e.g., "America/Toronto")
- `tax_region` — country/province code for tax handling (e.g., "CA-ON" for Ontario, Canada). Implementation: GENERATED column on `chiefos_tenants` from `country || '-' || province`. Distinct from `tax_code` (tax-math regime, e.g., `HST_ON`). Both columns retained.
- `paid_breaks_policy` — TEXT enum on `chiefos_tenants` with CHECK (`'paid'` | `'unpaid'`). Default `'unpaid'`. Set during onboarding wizard per §14.2. Distinct from `auto_lunch_deduct_minutes`.
- `phone_number` — owner's primary phone (canonical for owner_id derivation)
- `email` — owner's primary email (canonical for portal auth and Stripe)

### 4.2 Audit procedure

For each field, document:

1. Which table(s) contain a column for this field
2. Which code paths write to which column
3. Which code paths read from which column
4. Whether write source and read source are the same column
5. If multiple sources exist, which is canonical

The output is a markdown document: `schema-audit-2026-04-28.md` listing each field, its current state, and any consolidation needed.

### 4.3 Consolidation rules

For any field with multiple write or read locations:

- **Designate one canonical source.** This is almost always the `users` (or equivalent owner-record) table.
- **Remove duplicate columns** elsewhere, OR convert them to read-only computed views that pull from the canonical source.
- **Update all read paths** to read from the canonical source.
- **Update all write paths** to write to the canonical source.
- **Verify no race conditions** where two paths could write conflicting values to different sources.

Per Engineering Constitution Section 5, any migration touching these fields requires a regression test, cross-tenant isolation test, and pre/post comparison.

### 4.4 Output of Phase 0

- Documented current state of business state fields
- Schema migrations (if needed) to consolidate to canonical sources
- Updated code paths that read and write through canonical sources only
- Regression test confirming no field-level discrepancies

**Phase 0 must complete before Phase 1 begins.** Trial architecture cannot ship cleanly on top of inconsistent business state.

---

## 5. Database Schema Changes

### 5.1 Users table modifications

The canonical per-business record is `public.chiefos_tenants` (1:1 with each business). Per Amendment 2026-04-29 (Phase 1 PR-A), all lifecycle/activation columns live on `chiefos_tenants`, not on `public.users` (which is multi-actor-per-owner). Add the following columns:

```sql
-- File: migrations/2026_04_29_phase1_pra_lifecycle_and_plan_key_on_chiefos_tenants.sql
-- Purpose: Add lifecycle columns to support trial-based access model
-- Stage: Pre-launch (zero users); reversible without data loss

BEGIN;

-- Add lifecycle state column with explicit default
ALTER TABLE public.chiefos_tenants
  ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'pre_trial'
    CONSTRAINT chiefos_tenants_lifecycle_state_chk
      CHECK (lifecycle_state IN ('pre_trial', 'trial', 'paid', 'read_only', 'archived'));

-- Add trial timestamps
ALTER TABLE public.chiefos_tenants
  ADD COLUMN trial_started_at TIMESTAMPTZ,
  ADD COLUMN trial_ends_at    TIMESTAMPTZ;

-- Add read-only timestamps
ALTER TABLE public.chiefos_tenants
  ADD COLUMN read_only_started_at TIMESTAMPTZ,
  ADD COLUMN read_only_ends_at    TIMESTAMPTZ;

-- Add archive timestamps
ALTER TABLE public.chiefos_tenants
  ADD COLUMN archived_at               TIMESTAMPTZ,
  ADD COLUMN data_deletion_eligible_at TIMESTAMPTZ;

-- Add tracking fields for activation events (telemetry-grade attribution)
ALTER TABLE public.chiefos_tenants
  ADD COLUMN first_whatsapp_message_at TIMESTAMPTZ,
  ADD COLUMN first_portal_login_at     TIMESTAMPTZ,
  ADD COLUMN first_capture_at          TIMESTAMPTZ,
  ADD COLUMN first_job_created_at      TIMESTAMPTZ;

-- Add reminders tracking (idempotent reminder dispatch)
ALTER TABLE public.chiefos_tenants
  ADD COLUMN reminders_sent JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Indexes for lifecycle state queries
CREATE INDEX idx_chiefos_tenants_lifecycle_state ON public.chiefos_tenants(lifecycle_state);
CREATE INDEX idx_chiefos_tenants_trial_ends_at ON public.chiefos_tenants(trial_ends_at)
  WHERE lifecycle_state = 'trial';
CREATE INDEX idx_chiefos_tenants_read_only_ends_at ON public.chiefos_tenants(read_only_ends_at)
  WHERE lifecycle_state = 'read_only';
-- Phone storage moved to chiefos_tenants.phone_e164 per Amendment 2026-04-29.
-- Migration: 2026_04_29_phase0_p1_phone_e164_on_chiefos_tenants.sql

COMMIT;
```

**Rationale for column choices:**

- `pre_trial` is a new state that did not exist in v1.0. It represents an account that has been created via the landing page form but where the trial clock has not yet started. The clock starts on first WhatsApp message OR first portal login, whichever comes first.
- All timestamps are `TIMESTAMPTZ` per Engineering Constitution's ISO datetime requirement.
- `first_whatsapp_message_at` and `first_portal_login_at` are tracked separately even though either triggers `trial_started_at`, because telemetry-grade attribution matters for understanding which acquisition path users actually take.
- `reminders_sent` is JSONB for flexible per-reminder idempotency keys without schema churn.

### 5.2 Plan key constraint

Per Amendment 2026-04-29 (Phase 1 PR-A), `plan_key` is a per-business attribute and lives on `public.chiefos_tenants` alongside `lifecycle_state`. The pre-Phase-1 `users.plan_key` column (CHECK `users_plan_key_chk` with values `'free','starter','pro','enterprise'`) is dropped. `'free'` is removed from the v1.1 enum; `'trial'` and `'read_only'` are added. The migration is bundled in the same file as §5.1:

```sql
-- File: migrations/2026_04_29_phase1_pra_lifecycle_and_plan_key_on_chiefos_tenants.sql
-- (continues from §5.1 block in the same BEGIN/COMMIT transaction)

-- Add plan_key on chiefos_tenants with v1.1 enum, default 'trial'
ALTER TABLE public.chiefos_tenants
  ADD COLUMN plan_key TEXT NOT NULL DEFAULT 'trial'
    CONSTRAINT chiefos_tenants_plan_key_chk
      CHECK (plan_key IN ('trial', 'starter', 'pro', 'enterprise', 'read_only'));

-- Drop users.plan_key + its CHECK constraint.
-- NOTE: actual production constraint name is users_plan_key_chk
-- (recon during Phase 1 confirmed; the v1.0 migration that created the
-- constraint used the _chk suffix, not _check).
ALTER TABLE public.users DROP CONSTRAINT users_plan_key_chk;
ALTER TABLE public.users DROP COLUMN plan_key;
```

### 5.3 Plan tier feature definitions

| plan_key | jobs_max | employees_max | ocr_monthly | voice_monthly | ask_chief_monthly | exports | approvals | retention |
|---|---|---|---|---|---|---|---|---|
| `trial` | 25 | 10 | 100 | 100 | 50 | yes | no | 14 days |
| `starter` | 25 | 10 | 100 | 100 | 50 | yes | no | 3 years |
| `pro` | unlimited | 150 | 500 | 500 | 200 | yes | yes | 7 years |
| `enterprise` | unlimited | unlimited | unlimited | unlimited | unlimited | yes | yes | unlimited |
| `read_only` | 0 captures | n/a | 0 | 0 | 0 | yes (read-only) | no | 14 days |

**Critical:** `trial` and `starter` have identical feature access. They differ only in lifecycle state. The trial experience must equal the paid Starter experience so contractors evaluate the real product.

### 5.4 Acquisition tracking tables

Per Amendment 2026-04-29 (Phase 1 PR-B), funnel telemetry is split into two tables to handle the pre-signup vs post-signup boundary correctly:

- **`public.landing_events`** — pre-signup anonymous funnel. No `tenant_id` (the tenant does not exist yet at capture time). Service-role only; no RLS policy.
- **`public.acquisition_events`** — post-signup tenant-scoped funnel. `tenant_id UUID NOT NULL REFERENCES public.chiefos_tenants(id) ON DELETE CASCADE`. RLS enabled with SELECT policy scoped to `chiefos_portal_users` membership.

Both tables share `anonymous_session_id TEXT` to enable end-to-end funnel queries (landing_page_viewed → paid_conversion) via `UNION ALL` on the session ID. INSERTs occur via SECURITY DEFINER functions or service-role contexts (event-logging RPCs, cron jobs, webhook handlers); portal users do not insert events directly.

```sql
-- File: migrations/2026_04_29_phase1_prb_acquisition_events_and_landing_events.sql

BEGIN;

-- 1. landing_events: pre-signup funnel (anonymous, no tenant)
CREATE TABLE public.landing_events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type           TEXT NOT NULL
    CONSTRAINT landing_events_event_type_chk
      CHECK (event_type IN (
        'landing_page_viewed',
        'landing_page_form_submitted',
        'whatsapp_deep_link_clicked'
      )),
  event_data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  anonymous_session_id TEXT,
  utm_source           TEXT,
  utm_medium           TEXT,
  utm_campaign         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_landing_events_event_type
  ON public.landing_events(event_type);
CREATE INDEX idx_landing_events_created_at
  ON public.landing_events(created_at);
CREATE INDEX idx_landing_events_anonymous_session_id
  ON public.landing_events(anonymous_session_id)
  WHERE anonymous_session_id IS NOT NULL;
-- landing_events: NO RLS. Service-role only.

-- 2. acquisition_events: post-signup funnel (tenant-scoped)
CREATE TABLE public.acquisition_events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE CASCADE,
  event_type           TEXT NOT NULL
    CONSTRAINT acquisition_events_event_type_chk
      CHECK (event_type IN (
        'first_whatsapp_message_sent',
        'first_portal_login',
        'first_capture',
        'first_job_created',
        'first_ask_chief_question',
        'paid_conversion'
      )),
  event_data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  anonymous_session_id TEXT,  -- bridges to landing_events
  utm_source           TEXT,
  utm_medium           TEXT,
  utm_campaign         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_acquisition_events_tenant_id
  ON public.acquisition_events(tenant_id);
CREATE INDEX idx_acquisition_events_event_type
  ON public.acquisition_events(event_type);
CREATE INDEX idx_acquisition_events_created_at
  ON public.acquisition_events(created_at);
CREATE INDEX idx_acquisition_events_tenant_event
  ON public.acquisition_events(tenant_id, event_type, created_at);

ALTER TABLE public.acquisition_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenants can read own acquisition events"
  ON public.acquisition_events
  FOR SELECT
  USING (
    tenant_id IN (
      SELECT tenant_id FROM public.chiefos_portal_users
      WHERE user_id = auth.uid()
    )
  );
-- No INSERT/UPDATE/DELETE policy. Writes via SECURITY DEFINER only.

COMMIT;
```

These tables track the contractor's journey from ad click to paid conversion. They are not the same as the audit log (Engineering Constitution Section 9); audit log is for security/compliance, acquisition + landing events are for funnel analysis.

---

## 6. Plan Resolution Logic

Per Engineering Constitution Section 5 (safe query patterns) and Monetization & Pricing v4.0 Section 5 (plan authority), the canonical plan resolution must fail closed on any ambiguity.

```typescript
// File: src/services/plan-resolution.ts

import { db } from '../db';
import { logger } from '../logger';

export type PlanKey = 'trial' | 'starter' | 'pro' | 'enterprise' | 'read_only';

export type LifecycleState = 'pre_trial' | 'trial' | 'paid' | 'read_only' | 'archived';

export interface ResolvedPlan {
  ok: true;
  plan_key: PlanKey;
  lifecycle_state: LifecycleState;
  effective_at: Date;
  trace_id: string;
}

export interface PlanResolutionFailure {
  ok: false;
  error: {
    code: 'TENANT_RESOLUTION_FAILED' | 'TENANT_MISSING' | 'PLAN_RESOLUTION_FAILED' | 'LIFECYCLE_AMBIGUOUS';
    message: string;
    hint: string;
    trace_id: string;
  };
}

export type PlanResolutionResult = ResolvedPlan | PlanResolutionFailure;

export async function resolveEffectivePlan(owner_id: string, trace_id: string): Promise<PlanResolutionResult> {
  // Step 1: Validate owner_id format (digits only per dual-boundary identity model)
  if (!owner_id || !/^\d+$/.test(owner_id)) {
    logger.warn({ trace_id, owner_id }, 'Invalid owner_id format in plan resolution');
    return {
      ok: false,
      error: {
        code: 'TENANT_MISSING',
        message: 'owner_id is missing or malformed',
        hint: 'owner_id must be digits only per identity boundary rules',
        trace_id,
      },
    };
  }

  // Per Amendment 2026-04-29 (Phase 1 PR-A): lifecycle_state and plan_key
  // live on chiefos_tenants (per-business), keyed by owner_id. We read the
  // tenant directly rather than going through public.users (multi-actor).
  const tenant = await db.chiefos_tenants.findOne({ owner_id });

  if (!tenant) {
    logger.warn({ trace_id, owner_id }, 'Tenant not found in plan resolution');
    return {
      ok: false,
      error: {
        code: 'TENANT_RESOLUTION_FAILED',
        message: 'No tenant found for owner_id',
        hint: 'Account may have been archived or never existed',
        trace_id,
      },
    };
  }

  // Step 3: Validate lifecycle_state and plan_key are both present
  if (!tenant.lifecycle_state || !tenant.plan_key) {
    logger.error({ trace_id, owner_id, tenant_id: tenant.id }, 'Tenant has null lifecycle_state or plan_key — failing closed');
    return {
      ok: false,
      error: {
        code: 'LIFECYCLE_AMBIGUOUS',
        message: 'Tenant lifecycle state cannot be determined',
        hint: 'Account requires manual review',
        trace_id,
      },
    };
  }

  const now = new Date();

  // Step 4: Drift detection — fail closed if lifecycle has not transitioned correctly
  if (tenant.lifecycle_state === 'trial' && tenant.trial_ends_at && tenant.trial_ends_at < now) {
    logger.error({ trace_id, owner_id, trial_ends_at: tenant.trial_ends_at, now }, 'Trial expired without lifecycle transition');
    return {
      ok: false,
      error: {
        code: 'LIFECYCLE_AMBIGUOUS',
        message: 'Trial period has ended but lifecycle has not transitioned',
        hint: 'Account requires lifecycle reconciliation',
        trace_id,
      },
    };
  }

  if (tenant.lifecycle_state === 'read_only' && tenant.read_only_ends_at && tenant.read_only_ends_at < now) {
    logger.error({ trace_id, owner_id }, 'Read-only expired without archive transition');
    return {
      ok: false,
      error: {
        code: 'LIFECYCLE_AMBIGUOUS',
        message: 'Read-only period has ended but account has not been archived',
        hint: 'Account requires lifecycle reconciliation',
        trace_id,
      },
    };
  }

  return {
    ok: true,
    plan_key: tenant.plan_key as PlanKey,
    lifecycle_state: tenant.lifecycle_state as LifecycleState,
    effective_at: now,
    trace_id,
  };
}
```

**Critical rules:**

- The function is read-only. It observes lifecycle state; it does not mutate. State transitions happen elsewhere (cron, explicit user action, Stripe webhook).
- Never returns `pre_trial` users as having usable access. A pre_trial user is not yet activated; quota enforcement should treat them as `trial` for capability purposes (full Starter access) but only after the clock starts.
- Always logs the trace_id with every decision per Engineering Constitution Section 9.

---

## 7. Lifecycle State Transitions

### 7.1 State machine

```
                  [Landing Page Form Submit]
                            ↓
                       PRE_TRIAL
                       /        \
        [WhatsApp msg]            [Portal login]
                       \        /
                        TRIAL
                      /       \
            [paid conversion]   [trial expires]
                    ↓                ↓
                  PAID           READ_ONLY
                    ↓                ↓
            [cancel/expire]     [paid conversion]
                    ↓                ↓
                READ_ONLY          PAID
                    ↓
                ARCHIVED
                    ↓
            [12mo no recovery]
                    ↓
              [DATA DELETED]
```

### 7.2 Transition: NEW → PRE_TRIAL

**Trigger:** Contractor submits the landing page form.

**Action:**

```typescript
async function createPreTrialAccount(input: {
  business_name: string;
  phone_number: string;  // E.164 normalized
  email: string;
  owner_name: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
}): Promise<{ user_id: string; owner_id: string }> {
  const trace_id = generateTraceId();

  // Generate owner_id from phone (per dual-boundary identity model)
  const owner_id = derivePhoneOwnerId(input.phone_number);  // Existing utility

  // Idempotency: if account already exists for this phone, return it
  const existing = await db.users.findOne({ owner_id });
  if (existing) {
    logger.info({ trace_id, owner_id }, 'Pre-trial account already exists for phone');
    return { user_id: existing.id, owner_id };
  }

  // Per Amendments 2026-04-29: phone_e164 (Phase 0 P1) AND lifecycle_state +
  // plan_key (Phase 1 PR-A) are persisted to chiefos_tenants (1:1 with the
  // business), not public.users. The tenant row is created first; the
  // public.users row links to the tenant via tenant_id and carries no
  // per-business lifecycle/plan attributes.
  //
  // lifecycle_state defaults to 'pre_trial' and plan_key defaults to 'trial'
  // via the column DEFAULT clauses; both can be omitted from INSERT.
  // trial_started_at intentionally NULL — clock has not started yet.
  const tenant = await db.chiefos_tenants.insert({
    owner_id,
    phone_e164: input.phone_number,  // E.164 normalized at form-submit
    name: input.business_name,
    // lifecycle_state, plan_key, reminders_sent receive defaults
    // ... other tenant fields
  });

  const user = await db.users.insert({
    owner_id,
    user_id: owner_id,  // owner-self row
    tenant_id: tenant.id,
    email: input.email,
    name: input.owner_name,
    role: 'owner',
    // No lifecycle_state or plan_key here — those live on chiefos_tenants now.
  });

  await db.acquisition_events.insert({
    user_id: user.id,
    event_type: 'landing_page_form_submitted',
    utm_source: input.utm_source,
    utm_medium: input.utm_medium,
    utm_campaign: input.utm_campaign,
    event_data: { business_name: input.business_name },
  });

  await auditLog({
    event_type: 'lifecycle_transition',
    owner_id,
    from_state: null,
    to_state: 'pre_trial',
    trace_id,
  });

  return { user_id: user.id, owner_id };
}
```

### 7.3 Transition: PRE_TRIAL → TRIAL

**Trigger:** EITHER first WhatsApp message from the registered phone number, OR first portal login (whichever comes first).

**Critical:** Both triggers must check current state and only transition if `lifecycle_state = 'pre_trial'`. If already in `trial` (the other trigger fired first), this is a no-op.

```typescript
async function startTrialClock(
  owner_id: string,
  trigger_source: 'whatsapp' | 'portal',
  trace_id: string
): Promise<void> {
  const now = new Date();
  const trial_ends_at = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days

  // Conditional update: only fires if still in pre_trial.
  // Per Amendment 2026-04-29 (Phase 1 PR-A): lifecycle and activation
  // timestamps live on chiefos_tenants, keyed by owner_id (UNIQUE).
  const result = await db.chiefos_tenants.update(
    { owner_id, lifecycle_state: 'pre_trial' },
    {
      lifecycle_state: 'trial',
      trial_started_at: now,
      trial_ends_at,
      [trigger_source === 'whatsapp' ? 'first_whatsapp_message_at' : 'first_portal_login_at']: now,
    }
  );

  if (result.modifiedCount === 0) {
    // Already in trial state from other trigger — just record the event
    await db.chiefos_tenants.update(
      { owner_id },
      { [trigger_source === 'whatsapp' ? 'first_whatsapp_message_at' : 'first_portal_login_at']: now }
    );
    return;
  }

  await db.acquisition_events.insert({
    user_id: (await db.users.findOne({ owner_id })).id,
    event_type: trigger_source === 'whatsapp' ? 'first_whatsapp_message_sent' : 'first_portal_login',
    event_data: { trial_ends_at },
  });

  await auditLog({
    event_type: 'lifecycle_transition',
    owner_id,
    from_state: 'pre_trial',
    to_state: 'trial',
    metadata: { trigger_source, trial_ends_at },
    trace_id,
  });
}
```

### 7.4 Transition: TRIAL → PAID

**Trigger:** Contractor confirms a paid plan choice and Stripe subscription is successfully created.

```typescript
async function transitionTrialToPaid(
  owner_id: string,
  stripe_subscription_id: string,
  selected_plan_key: 'starter' | 'pro' | 'enterprise',
  trace_id: string
): Promise<void> {
  // Per Amendment 2026-04-29 (Phase 1 PR-A): lifecycle_state and plan_key
  // live on chiefos_tenants. stripe_subscription_id remains on public.users
  // (per-actor billing surface), so this is a two-table write.
  await db.chiefos_tenants.update(
    { owner_id, lifecycle_state: 'trial' },
    {
      lifecycle_state: 'paid',
      plan_key: selected_plan_key,
    }
  );
  await db.users.update(
    { owner_id, role: 'owner' },
    { stripe_subscription_id }
  );

  await db.acquisition_events.insert({
    user_id: (await db.users.findOne({ owner_id })).id,
    event_type: 'paid_conversion',
    event_data: { plan_key: selected_plan_key, stripe_subscription_id },
  });

  await auditLog({
    event_type: 'lifecycle_transition',
    owner_id,
    from_state: 'trial',
    to_state: 'paid',
    metadata: { selected_plan_key, stripe_subscription_id },
    trace_id,
  });
}
```

### 7.5 Transition: TRIAL → READ_ONLY

**Trigger:** `trial_ends_at` passes without paid conversion.

```typescript
async function transitionTrialToReadOnly(owner_id: string, trace_id: string): Promise<void> {
  const now = new Date();
  const read_only_ends_at = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days

  // Per Amendment 2026-04-29 (Phase 1 PR-A): lifecycle/plan/read-only
  // window timestamps all live on chiefos_tenants.
  await db.chiefos_tenants.update(
    { owner_id, lifecycle_state: 'trial' },
    {
      lifecycle_state: 'read_only',
      plan_key: 'read_only',
      read_only_started_at: now,
      read_only_ends_at,
    }
  );

  await auditLog({
    event_type: 'lifecycle_transition',
    owner_id,
    from_state: 'trial',
    to_state: 'read_only',
    metadata: { read_only_ends_at },
    trace_id,
  });
}
```

### 7.6 Transition: READ_ONLY → PAID (recovery)

**Trigger:** Contractor in read-only state purchases a paid plan.

```typescript
async function recoverReadOnlyToPaid(
  owner_id: string,
  stripe_subscription_id: string,
  selected_plan_key: 'starter' | 'pro' | 'enterprise',
  trace_id: string
): Promise<void> {
  // Per Amendment 2026-04-29 (Phase 1 PR-A): lifecycle/plan/read-only
  // window timestamps live on chiefos_tenants. stripe_subscription_id
  // remains on public.users.
  await db.chiefos_tenants.update(
    { owner_id, lifecycle_state: 'read_only' },
    {
      lifecycle_state: 'paid',
      plan_key: selected_plan_key,
      read_only_started_at: null,
      read_only_ends_at: null,
    }
  );
  await db.users.update(
    { owner_id, role: 'owner' },
    { stripe_subscription_id }
  );

  await auditLog({
    event_type: 'lifecycle_transition',
    owner_id,
    from_state: 'read_only',
    to_state: 'paid',
    metadata: { selected_plan_key, recovery: true },
    trace_id,
  });
}
```

### 7.7 Transition: READ_ONLY → ARCHIVED

**Trigger:** `read_only_ends_at` passes without paid conversion.

```typescript
async function transitionReadOnlyToArchived(owner_id: string, trace_id: string): Promise<void> {
  const now = new Date();
  const data_deletion_eligible_at = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 12 months

  // Per Amendment 2026-04-29 (Phase 1 PR-A): archive timestamps live on chiefos_tenants.
  await db.chiefos_tenants.update(
    { owner_id, lifecycle_state: 'read_only' },
    {
      lifecycle_state: 'archived',
      archived_at: now,
      data_deletion_eligible_at,
    }
  );

  await auditLog({
    event_type: 'lifecycle_transition',
    owner_id,
    from_state: 'read_only',
    to_state: 'archived',
    metadata: { data_deletion_eligible_at },
    trace_id,
  });
}
```

### 7.8 Transition: PAID → READ_ONLY (cancellation or payment failure)

**Trigger:** Stripe webhook indicates subscription canceled or payment failed beyond grace period.

```typescript
async function transitionPaidToReadOnly(
  owner_id: string,
  reason: 'canceled' | 'payment_failed',
  trace_id: string
): Promise<void> {
  const now = new Date();
  const read_only_ends_at = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  // Per Amendment 2026-04-29 (Phase 1 PR-A): lifecycle/plan/read-only window
  // timestamps live on chiefos_tenants.
  await db.chiefos_tenants.update(
    { owner_id, lifecycle_state: 'paid' },
    {
      lifecycle_state: 'read_only',
      plan_key: 'read_only',
      read_only_started_at: now,
      read_only_ends_at,
    }
  );

  await auditLog({
    event_type: 'lifecycle_transition',
    owner_id,
    from_state: 'paid',
    to_state: 'read_only',
    metadata: { reason },
    trace_id,
  });
}
```

---

## 8. Lifecycle Reconciliation Cron Job

A scheduled job runs every 15 minutes and performs lifecycle reconciliation. Without it, lifecycle states drift and the fail-closed logic blocks accounts.

```typescript
// File: src/cron/lifecycle-reconciler.ts

export async function reconcileLifecycleStates(): Promise<void> {
  const trace_id = generateTraceId();
  const now = new Date();

  // Per Amendment 2026-04-29 (Phase 1 PR-A): all lifecycle reads/writes
  // target chiefos_tenants. owner_id is the iteration key.

  // 1. Pre-trial tenants that have been dormant for 30+ days without activation.
  // Soft-archive these to keep the database clean.
  const dormantPreTrials = await db.chiefos_tenants.find({
    lifecycle_state: 'pre_trial',
    created_at: { $lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
  });

  for (const tenant of dormantPreTrials) {
    await db.chiefos_tenants.update(
      { id: tenant.id },
      { lifecycle_state: 'archived', archived_at: now }
    );
    await auditLog({
      event_type: 'lifecycle_transition',
      owner_id: tenant.owner_id,
      from_state: 'pre_trial',
      to_state: 'archived',
      metadata: { reason: 'dormant_pre_trial_30d' },
      trace_id,
    });
  }

  // 2. Trial → Read-only (trial expired without paid conversion)
  const expiredTrials = await db.chiefos_tenants.find({
    lifecycle_state: 'trial',
    trial_ends_at: { $lt: now },
  });

  for (const tenant of expiredTrials) {
    try {
      await transitionTrialToReadOnly(tenant.owner_id, trace_id);
      await sendWhatsAppTemplate(tenant.owner_id, 'trial_ended_read_only_starting');
    } catch (err) {
      logger.error({ err, owner_id: tenant.owner_id, trace_id }, 'Failed to transition expired trial');
    }
  }

  // 3. Read-only → Archived
  const expiredReadOnly = await db.chiefos_tenants.find({
    lifecycle_state: 'read_only',
    read_only_ends_at: { $lt: now },
  });

  for (const tenant of expiredReadOnly) {
    try {
      await transitionReadOnlyToArchived(tenant.owner_id, trace_id);
    } catch (err) {
      logger.error({ err, owner_id: tenant.owner_id, trace_id }, 'Failed to archive expired read-only account');
    }
  }

  // 4. Reminder dispatch (see Section 11)
  await dispatchTrialReminders(now, trace_id);
  await dispatchReadOnlyReminders(now, trace_id);
  await dispatchEmailBackups(now, trace_id);

  logger.info({
    trace_id,
    processed: {
      dormantPreTrials: dormantPreTrials.length,
      expiredTrials: expiredTrials.length,
      expiredReadOnly: expiredReadOnly.length,
    },
  }, 'Lifecycle reconciliation complete');
}
```

**Cron schedule:** `*/15 * * * *` (every 15 minutes).

---

## 9. Acquisition-to-Activation Flow

This is the path from ad click to first capture. It is the highest-leverage flow in the entire onboarding architecture.

### 9.1 Landing page

**URL:** `usechiefos.com/start` (the canonical homepage is `usechiefos.com`; the landing page is a focused conversion surface)

**Purpose:** Convert ad-click traffic into account creation in under 90 seconds, with the clearest possible path to Magic Moment 1 (receipt parser).

**Layout:** Single screen, mobile-first, no scroll required.

**Above the fold:**

```
[ChiefOS logo]

Talk to Your Business.

Text receipts. Snap photos. Voice-note hours.
ChiefOS pulls it all together and tells you which jobs make money.

Start your free 14-day trial. No credit card.

[ Your name        ]
[ Phone number     ]
[ Business name    ]
[ Email            ]

[ Start My Trial ]

Built by a contractor. For contractors.
```

**Below the fold (optional, only visible on scroll):**

```
What happens next:

1. We'll create your account.
2. You'll connect to Chief on WhatsApp.
3. Send Chief a photo of any receipt — that's it.
   He'll read it, attach it to a job, and you're using ChiefOS.

Most contractors capture their first receipt in the first 5 minutes.
```

**Form submission behavior:**

1. Validate inputs server-side: phone is E.164 format, email is well-formed, business_name is non-empty.
2. Call `createPreTrialAccount()` (Section 7.2).
3. Render the post-submit screen with WhatsApp connection options.

### 9.2 Post-submit screen

After form submission, the user sees:

**On mobile:**

```
You're set, [name]. One more step.

[ Open WhatsApp to meet Chief ]

(Tap the button. Chief will be ready.)

Already have WhatsApp? Just send "Hi Chief" to [+1-XXX-XXX-XXXX].
```

The button is a `wa.me` deep link with pre-filled message:

```
https://wa.me/[twilio_number]?text=Hi%20Chief
```

**On desktop:**

```
You're set, [name]. One more step.

Scan this QR code with your phone to start the conversation:

[QR CODE]

Or send "Hi Chief" from your phone to [+1-XXX-XXX-XXXX].
```

The QR code encodes the same `wa.me` link.

### 9.3 Inbound WhatsApp matching

When Chief receives an inbound message via Twilio webhook:

```typescript
async function handleInboundWhatsAppMessage(
  from_phone: string,
  message_body: string,
  twilio_metadata: TwilioWebhookData,
  trace_id: string
): Promise<void> {
  const owner_id = derivePhoneOwnerId(from_phone);

  // Per Amendment 2026-04-29 (Phase 1 PR-A): lifecycle_state lives on
  // chiefos_tenants. We resolve the tenant first to read lifecycle, then
  // resolve the user row for downstream message handling.
  const tenant = await db.chiefos_tenants.findOne({ owner_id });

  if (!tenant) {
    // Unknown phone — prompt for signup
    await sendWhatsAppMessage(owner_id,
      "Hey — looks like you haven't signed up for ChiefOS yet. Visit usechiefos.com/start to get started, then come back here. Takes about 30 seconds."
    );
    return;
  }

  // If tenant is in pre_trial state, this message starts the trial clock
  if (tenant.lifecycle_state === 'pre_trial') {
    await startTrialClock(owner_id, 'whatsapp', trace_id);
    await sendWelcomeMessage(owner_id);
    return;
  }

  // Otherwise, route to normal message handling per existing CIL pipeline
  const user = await db.users.findOne({ owner_id });
  await routeToMessageHandler(user, message_body, twilio_metadata, trace_id);
}
```

### 9.4 Email backup flow

If a contractor submits the landing page form but does not message WhatsApp or log into the portal within 24 hours, send one email.

If they still have not engaged by day 7 of read-only (after trial has expired), send one final email.

**Total email outreach across full lifecycle: 2 emails maximum.**

This is the "quiet confidence" cadence. Contractors who don't respond to two emails are not going to respond to ten.

```typescript
async function dispatchEmailBackups(now: Date, trace_id: string): Promise<void> {
  // Per Amendment 2026-04-29 (Phase 1 PR-A): lifecycle_state, reminders_sent,
  // and the trial/read-only window timestamps live on chiefos_tenants.
  // The email field still lives on public.users (per-actor); the recipient
  // is resolved by joining via tenant_id (owner-self row).

  // Email 1: Pre-trial tenant, no engagement after 24 hours
  const dormantPreTrials = await db.chiefos_tenants.find({
    lifecycle_state: 'pre_trial',
    created_at: { $lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    'reminders_sent.email_pre_trial_24h': null,
  });

  for (const tenant of dormantPreTrials) {
    const owner = await db.users.findOne({ tenant_id: tenant.id, role: 'owner' });
    await sendEmailIfNotSent(tenant, owner, 'email_pre_trial_24h', PRE_TRIAL_NUDGE_EMAIL_TEMPLATE);
  }

  // Email 2: Read-only state, day 7 (halfway through window)
  const midReadOnly = await db.chiefos_tenants.find({
    lifecycle_state: 'read_only',
    read_only_started_at: {
      $gte: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      $lt: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000),
    },
    'reminders_sent.email_read_only_day_7': null,
  });

  for (const tenant of midReadOnly) {
    const owner = await db.users.findOne({ tenant_id: tenant.id, role: 'owner' });
    await sendEmailIfNotSent(tenant, owner, 'email_read_only_day_7', READ_ONLY_NUDGE_EMAIL_TEMPLATE);
  }
}
```

**Email 1 template (Pre-trial 24h nudge):**

> Subject: Your ChiefOS trial is waiting
>
> Hey [name],
>
> You started a ChiefOS trial yesterday but haven't connected via WhatsApp yet. Most contractors capture their first receipt in the first 5 minutes — that's the magic moment that makes the rest of ChiefOS click.
>
> Click here to connect: [wa.me deep link]
>
> Or send "Hi Chief" from your phone to [+1-XXX-XXX-XXXX].
>
> Built by a contractor. For contractors.
>
> Scott

**Email 2 template (Read-only day 7 nudge):**

> Subject: 7 days left to come back to ChiefOS
>
> Hey [name],
>
> Your ChiefOS trial ended a week ago. Your data is preserved for another 7 days — after that, the account archives.
>
> If you want to come back, reply UPGRADE to Chief on WhatsApp, or visit [portal link] to choose a plan.
>
> No pressure either way. Just wanted you to know the window is closing.
>
> Scott

---

## 10. Conversational WhatsApp Onboarding

This replaces the broadcast-reminder model from v1.0. The principle: keep the WhatsApp 24-hour window open through engagement, not through outbound messaging.

### 10.1 Day 1 — Welcome and Magic Moment 1

**Triggered by:** First inbound WhatsApp message from a pre_trial account (typically "Hi Chief" from the deep link).

**Sequence:**

1. **Welcome message (immediate):**

> Hey, welcome to ChiefOS. I'm Chief. I do one thing well: I keep track of what's happening on your jobs. Receipts, hours, photos, voice notes — send me whatever you've got and I'll attach it to the right job.

2. **First action prompt (sent 30 seconds later):**

> Easiest place to start: take a photo of your most recent receipt and send it to me. I'll read it and ask you which job it goes to.

3. **Intro video (sent if no receipt arrives within 30 minutes of welcome):**

A 30-second Scott-recorded video: *"Hey, Scott here. The fastest way to see what ChiefOS does is to text Chief a photo of any receipt — Home Depot, gas station, whatever's in your wallet. He'll read it and ask you which job it goes to. That's the whole onboarding. Try it."*

Sent as direct media via Twilio (MP4, under 16MB, vertical orientation).

### 10.2 First receipt → first job creation

When the contractor sends the first receipt:

1. OCR extracts vendor, items, total, tax (existing pipeline).
2. Chief replies with the parsed data and asks for job attachment:

> $47.83 at Home Depot. Which job is this for? Reply with a job name, or send 'new' to create one.

3. If 'new' or unknown name:

> What's this job called?

4. Contractor replies with job name. Chief creates the job, attaches the receipt, and asks the next contextual question:

> Created — [Job Name]. Receipt attached. What's the quoted price for this job? (Skip with 'unknown' if you haven't quoted yet.)

5. After job creation, Chief continues the engagement loop with one question per response.

### 10.3 Days 2-4 — Reactive engagement

The pattern: every action by the contractor produces a Chief response that includes a follow-up question. The questions get richer as more data accumulates.

**After 3rd capture on a job:**

> [Job Name] is at $389 in materials so far. Are you tracking time on this one too? Voice-note your hours when you're done for the day and I'll log them.

**After 5th capture across multiple jobs:**

> You've got [N] receipts logged across [M] jobs now. Want to see how each one is tracking? Open the portal here: [magic link]

This is the moment the contractor is invited to the portal — when there's something worth looking at.

### 10.4 Day 5 — Voice capture introduction

**Triggered:** Day 5 of trial OR first time the contractor's WhatsApp shows them being on a job site (out-of-hours capture pattern).

**Video (sent in active conversation):**

A 30-second Scott video: *"Quick tip — if you're somewhere you can't text, just hold the mic and voice-note Chief. 'I worked 6 hours on Caledonia today, mostly framing.' Chief logs it. No typing. Use it on the truck, on the job, anywhere your hands are dirty."*

Followed by Chief in chat:

> Try it now if you've worked on anything today. Voice-note your hours and I'll log them.

### 10.5 Days 6-9 — Magic Moment 2 surfacing

By now there's enough data for Ask Chief to give meaningful answers. Chief proactively offers it.

**After a routine capture on day 6+:**

> Logged $134.52 to [Job]. That brings materials on this job to $1,847. Want to see how that's tracking against quote?

**If the contractor says yes:**

Chief returns the actual analysis with margin tracking, labour vs estimate, and any anomalies. Magic Moment 2 hits.

**If they don't reply or say no:**

Try again the next day with a different angle:

> [Job] is at $1,847 in materials, 32 labour hours so far. Most jobs at this stage either swing into profit or quietly lose money. Want me to tell you which way it's going?

The framing is curiosity bait. The contractor's natural reaction is to want to know.

### 10.6 Days 10-13 — Conversion conversation

**Day 10:**

> Quick check — your trial ends in 4 days. The way most contractors decide if ChiefOS is worth committing to: ask the question that's been on your mind. Profit on a specific job. Whether this month is up or down vs last. Anything. What do you want to know?

**Day 12:**

> 2 days left. If you want to keep going past day 14, just reply READY and I'll walk you through the plans. Two options most contractors pick: Starter at $149/month (everything you've been using) or Pro at $349/month (for crews with self-logging and approvals).

**Day 13:**

> Last day to commit before your trial ends tomorrow. Reply READY when you're set. Otherwise your data goes into 14-day read-only — you'll keep your exports but new captures pause until you upgrade.

**Day 14 (trial ending):**

> Trial ended. Your data is preserved for 14 days and you can still export everything. Reply UPGRADE when you're ready to come back. Was good having you.

### 10.7 Quiet-detection nudges

If the contractor goes silent for 18+ hours during the trial (no inbound messages), Chief sends one prompt within the 24-hour window:

> Got any receipts from today? Easier to log them as they come in than to track them down later.

Maximum one nudge per 24-hour silent period. If they don't reply, Chief waits for the scheduled trial reminders (above) and any template-based re-engagement after the window closes.

---

## 11. WhatsApp Template Library

Once a user has been silent for over 24 hours, Chief can only send Meta-approved templates. The following templates must be drafted, submitted to Meta, and approved before the trial system goes live.

**Approval timing:** 1-2 days per template. Submit all 7 in parallel; expect 1 week total turnaround assuming no rejections.

### Template 1: `trial_reminder_day_10`

**Category:** Utility

**Body:**

> Your ChiefOS trial ends in {{1}} days. Reply with any question about your jobs to keep going — or reply READY to pick a plan.

### Template 2: `trial_reminder_day_12`

**Category:** Utility

**Body:**

> {{1}} days left in your ChiefOS trial. Reply READY to choose a plan: Starter ($149/mo), Pro ($349/mo), or Enterprise.

### Template 3: `trial_reminder_day_13`

**Category:** Utility

**Body:**

> Your trial ends tomorrow. Reply READY to keep going, or your data goes into 14-day read-only mode after midnight.

### Template 4: `trial_ended_read_only_starting`

**Category:** Utility

**Body:**

> Your ChiefOS trial just ended. Your data is preserved for 14 days and you can still export everything. Reply UPGRADE when you're ready to come back.

### Template 5: `read_only_reminder_day_7`

**Category:** Utility

**Body:**

> 7 days left in your read-only window. After that, your account archives. Reply UPGRADE to restore access.

### Template 6: `read_only_reminder_day_13`

**Category:** Utility

**Body:**

> Last day before your ChiefOS account archives. Once archived, data is recoverable for 12 months on upgrade, then deleted. Reply UPGRADE if you want to come back.

### Template 7: `pre_trial_reengagement`

**Category:** Utility

**Body:**

> Hey {{1}} — you signed up for ChiefOS but haven't connected yet. Reply Hi Chief here to start your 14-day trial. Takes 5 minutes to see your first receipt parsed.

---

## 12. Stripe Integration

### 12.1 Stripe products

Configure in Stripe Dashboard:

| Product | Price ID env var | Amount | Interval |
|---|---|---|---|
| ChiefOS Starter | `STRIPE_PRICE_STARTER_MONTHLY` | $149 USD | month |
| ChiefOS Pro | `STRIPE_PRICE_PRO_MONTHLY` | $349 USD | month |
| ChiefOS Enterprise | (custom invoice) | varies | — |

### 12.2 Webhook handling

Process the following events with signature verification:

- `customer.subscription.created` → trial → paid transition
- `customer.subscription.updated` → plan changes
- `customer.subscription.deleted` → paid → read_only transition
- `invoice.payment_failed` → after grace period, paid → read_only transition

Existing webhook architecture per Engineering Constitution Section 9 is preserved. Plan resolution is always database-canonical, never Stripe-cached.

---

## 13. Auth Architecture

### 13.1 Auth flow

**First portal access:**

1. Contractor visits portal.usechiefos.com or clicks magic link from Chief.
2. If clicking magic link: account is auto-authenticated for the session, no password required.
3. If visiting directly: enter email → receive magic link → click → authenticated.
4. After first login, prompt: "Set a password so you can log in faster next time."
5. Contractor sets password. Stored as bcrypt hash per existing auth standards.

**Subsequent logins:**

1. Email + password works for known devices.
2. New device login triggers SMS verification: "Enter the 6-digit code sent to your phone."
3. Code is single-use, expires in 10 minutes.

**Optional WebAuthn/Passkey support:**

After first login, offer: "Set up faster login with Face ID or fingerprint." Uses browser WebAuthn API. No backend complexity beyond standard WebAuthn challenge/response.

### 13.2 Trusted device tracking

```sql
CREATE TABLE IF NOT EXISTS public.trusted_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, device_fingerprint)
);
```

A device is "trusted" after successful SMS verification. Subsequent logins from the same device skip SMS.

### 13.3 What is not pursued

- **Voice authentication:** Not implemented. Adds complexity, regulatory exposure, and accuracy issues without proportionate value for the customer segment.
- **Hardware security keys (FIDO2 keys):** Not required for contractor segment.

---

## 14. Portal Cooperation Pattern

The portal and WhatsApp share state. Either can onboard a user. The other defers.

### 14.1 When WhatsApp came first

Contractor signs up via landing page → connects to WhatsApp → uses Chief for several days → eventually visits portal.

Portal behavior:

- Detect that `first_whatsapp_message_at` is set.
- Skip the portal setup wizard.
- Show: "Welcome [name]. Here's everything you've captured so far through WhatsApp." Display captured jobs, receipts, time entries.
- Surface unfilled configuration as non-blocking suggestions: "Set your tax region to enable accurate exports. Set your paid breaks policy to track labour correctly."
- Do not block any portal feature on configuration completion.

### 14.2 When portal came first

Contractor signs up via landing page → goes directly to portal (skips WhatsApp deep link) → uses portal first.

Portal behavior:

- Run the existing portal setup wizard (business name, timezone, tax region, paid breaks).
- After setup, prompt: "Connect WhatsApp to capture on the job. Scan this QR code with your phone."
- QR code is the wa.me link with pre-filled "Hi Chief" message.
- Once contractor scans and messages Chief, both surfaces are linked.

WhatsApp behavior on first message after portal-first signup:

- Skip the welcome message variant that explains business state collection (already done in portal).
- Send a streamlined welcome: "Hey [name], you're connected. Send me a photo of any receipt to see ChiefOS work."

### 14.3 Configuration parity

All business state is read from and written to a single canonical source per Section 4. Both surfaces operate on the same fields with no duplication.

---

## 15. Frontend / UX Changes

### 15.1 New surfaces required

- **Landing page:** `usechiefos.com/start` — single-screen acquisition form (Section 9.1)
- **Post-submit screen:** WhatsApp deep link or QR code (Section 9.2)
- **Trial countdown banner** in portal header during trial state
- **Read-only banner** in portal header during read-only state, with prominent UPGRADE button
- **Plan selection UI** for paid conversion (Starter, Pro, Enterprise comparison)

### 15.2 Updates to existing surfaces

- Homepage at `usechiefos.com` — apply Brand Voice v1.2 Section 16 spec
- Portal dashboard — add "captured via WhatsApp" indicators where relevant
- Portal account page — show lifecycle state, days remaining, upgrade options

### 15.3 PWA installation prompt

Once contractor is in `paid` state, prompt: "Install ChiefOS on your home screen for faster access." Uses standard PWA install prompts. The PWA logo (already prepared) is the install icon.

---

## 16. Edge Cases

### 16.1 Phone number mismatch on form

Contractor enters one phone number on the form but messages Chief from a different number. The webhook does not match, and the inbound message is treated as unknown.

**Resolution:** Display a verification step on the post-submit screen — "We're going to send you a 6-digit code via SMS to confirm your number." Code arrives, contractor enters it, phone is verified before the wa.me link is shown. Adds 30 seconds of friction but eliminates this edge case entirely.

### 16.2 Contractor submits form twice

Same phone number, same email, two form submissions.

**Resolution:** Per Section 7.2, idempotent account creation. Second submission returns the existing account, does not create a duplicate.

**Structural anti-abuse enforcement (Amendment 2026-04-29):** The application-layer idempotency above is backed by a database-level partial UNIQUE INDEX on `chiefos_tenants.phone_e164` WHERE `phone_e164 IS NOT NULL`. Even if `createPreTrialAccount`'s idempotency check is bypassed by a bug or race, a second tenant insertion with the same phone raises `unique_violation`, which the signup RPC re-raises as `OWNER_PHONE_ALREADY_CLAIMED`. Defense-in-depth: same phone cannot create two tenants at the database level.

### 16.3 Both triggers fire simultaneously

Contractor messages Chief AND clicks portal magic link within seconds of each other.

**Resolution:** The conditional update in Section 7.3 handles this atomically. First trigger transitions pre_trial → trial. Second trigger sees lifecycle_state is no longer pre_trial and just records the event. No race condition, no duplicate clock starts.

### 16.4 Contractor in trial creates 26 jobs (over Starter limit)

**Resolution:** Quota enforcement at the application layer blocks the 26th job creation with `OVER_QUOTA` error. Existing 25 jobs remain accessible.

### 16.5 Contractor cancels mid-trial

Contractor in trial state explicitly says "I want to cancel" or visits portal cancel button.

**Resolution:** No charge has occurred (no card on file in trial state). Just transition trial → read_only immediately and respect their wish. Cancel mid-trial means they don't want the trial to continue, not that they've experienced a billing problem.

### 16.6 Trial ends while contractor is in active conversation

Cron job runs at midnight, transitions trial → read_only while contractor is mid-message.

**Resolution:** The plan resolution check happens on each inbound message. If the contractor's next message arrives 30 seconds after the transition, plan resolution returns `read_only` state and the message is handled accordingly: capture is blocked, exports work, Chief responds with read-only context.

---

## 17. Testing Requirements

### 17.1 Unit tests

- `resolveEffectivePlan()` returns correct plan for each lifecycle state
- `resolveEffectivePlan()` fails closed for null lifecycle_state, null plan_key, expired trial, expired read-only
- `createPreTrialAccount()` is idempotent (duplicate phone returns existing account)
- `startTrialClock()` only transitions pre_trial accounts
- All reminder dispatch is idempotent (calling twice does not send twice)

### 17.2 Integration tests

- Form submit → pre_trial account created → wa.me link rendered
- WhatsApp inbound from registered phone → pre_trial → trial transition + welcome message
- Portal first login → pre_trial → trial transition
- Both triggers in rapid sequence → exactly one trial clock start
- Stripe subscription creation → trial → paid transition
- Stripe cancellation → paid → read_only transition
- Cron job correctly transitions expired trials and read-only accounts
- Email backups fire at correct cadence and never duplicate

### 17.3 Cross-tenant isolation tests (per Engineering Constitution Section 6)

- Create 2 test accounts with different phone numbers
- Verify no cross-account data visibility in any state
- Verify reminders go to correct phone only
- Verify portal access is correctly scoped via tenant_id + membership

### 17.4 End-to-end manual test

Scott walks through the full flow:

1. Open ad in incognito browser → land on usechiefos.com/start
2. Submit form → see post-submit screen with wa.me link
3. Click wa.me link on phone → land in WhatsApp → send "Hi Chief"
4. Receive welcome message + receipt prompt
5. Send a real Home Depot receipt → see parsing → attach to new job
6. Continue capture for several days (or fast-forward via test fixtures)
7. Receive day 5 voice intro
8. Trigger Magic Moment 2 (Ask Chief) on day 8+
9. Receive day 10, 12, 13 conversion prompts
10. Reply READY → choose Starter → verify Stripe checkout → verify trial → paid transition
11. After several days as paid user, cancel subscription → verify paid → read_only
12. Verify exports still work in read-only
13. Reply UPGRADE → re-subscribe → verify read_only → paid recovery

### 17.5 Template approval verification

Before launch, verify all 7 Meta templates (Section 11) are approved and active in Twilio's WhatsApp configuration.

---

## 18. Deployment Sequence

This is greenfield architecture, not a destructive migration. Phased deployment is for verification, not for protecting existing users.

### Phase 0: Schema audit

1. Audit business state fields per Section 4
2. Consolidate to canonical sources if needed
3. Output: `schema-audit-2026-04-28.md`

### Phase 1: Schema migrations

1. Run migrations 2026_04_28_001, 002, 003
2. Verify schema in production
3. Confirm no errors in queries against new columns

### Phase 2: Backend logic

1. Implement plan resolution (Section 6)
2. Implement lifecycle transitions (Section 7)
3. Implement cron job (Section 8)
4. Deploy to production with no acquisition flow yet — backend ready, frontend not yet exposed

### Phase 3: Acquisition flow

1. Build landing page at usechiefos.com/start
2. Build post-submit screen with wa.me deep link / QR code
3. Implement inbound webhook matching for pre_trial → trial transition
4. Implement email backup dispatch
5. Test end-to-end with Scott's own phone number

### Phase 4: Conversational onboarding

1. Implement reactive welcome and prompt sequences (Section 10)
2. Record intro video (Day 1) and voice video (Day 5)
3. Upload videos to Supabase storage
4. Implement Twilio media delivery for video sends
5. Implement quiet-detection nudge logic

### Phase 5: WhatsApp templates

1. Submit all 7 templates to Meta
2. Wait for approval (1 week)
3. Configure templates in Twilio
4. Test re-engagement flow with closed window scenarios

### Phase 6: Stripe integration

1. Configure Starter and Pro products in Stripe
2. Implement checkout flow with plan selection UI
3. Test subscription create, update, cancel webhooks
4. Test trial → paid, paid → read_only, read_only → paid transitions

### Phase 7: Portal updates

1. Add trial countdown banner
2. Add read-only banner
3. Update portal first-login flow to detect WhatsApp-first vs portal-first
4. Implement magic link login
5. Implement password setup prompt
6. Implement SMS new-device verification
7. Implement WebAuthn/Passkey support (optional, can defer to post-launch)

### Phase 8: Auth hardening

1. Verify magic link flow end-to-end
2. Verify SMS verification on new devices
3. Verify session management
4. Penetration test the auth surface (manual, not formal)

### Phase 9: End-to-end test and launch

1. Manual test (Section 17.4)
2. Fix any issues
3. Deploy landing page
4. Begin Phase 1 of GTM (per Brand Voice v1.2 Section 15)

---

## 19. Decisions Locked in v1.1

These decisions are made and should not be reopened without strong cause:

1. **No Founding Member tier.** Pricing is Starter ($149), Pro ($349), Enterprise (on request).
2. **14-day trial.** Not 7, not 21, not 30.
3. **No extension state.** Trial converts directly to paid or to read_only.
4. **14-day read-only window.** Not 30, not 90.
5. **Trial clock starts on first WhatsApp message OR first portal login**, whichever comes first.
6. **Landing page at usechiefos.com/start** for ad/CTA traffic; homepage at usechiefos.com is for organic/awareness.
7. **Auth: magic link → password → SMS verification on new devices → optional WebAuthn.** No voice authentication.
8. **Email backup cadence: 2 emails maximum.** One at 24 hours pre-trial dormancy, one at day 7 of read-only.
9. **Conversational onboarding, not broadcast reminders.** Engagement keeps the WhatsApp window open.
10. **Schema audit happens first.** No new architecture on inconsistent business state.

---

## 20. Sign-off Requirements

This architecture cannot deploy to production until:

- [ ] Phase 0 schema audit complete and consolidation verified
- [ ] Twilio production WhatsApp number confirmed (not sandbox)
- [ ] All 7 Meta templates submitted and approved
- [ ] Stripe products and webhooks tested in test mode
- [ ] All unit, integration, and cross-tenant isolation tests pass
- [ ] End-to-end manual test (Section 17.4) completed by Scott
- [ ] Backups verified within past 24 hours
- [ ] Both intro videos recorded and uploaded
- [ ] Brand Voice v1.2 homepage spec implemented at usechiefos.com
- [ ] Landing page implemented at usechiefos.com/start

---

*End of document — ChiefOS Trial Architecture Specification v1.1*

*This specification is binding on all development work touching pricing, plan resolution, billing, user lifecycle, acquisition, or onboarding. Subordinate to the Engineering Constitution v4.0, Monetization & Pricing v4.0, and North Star v4.0. If any conflict arises between this document and a higher-authority document, the higher-authority document governs.*
