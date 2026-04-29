# ChiefOS — Trial Migration Technical Specification

**Document version:** 1.0
**Status:** Implementation-ready
**Owner:** Scott Jutras
**Last Updated:** April 28, 2026
**Audience:** Development team (current and future)
**Authority:** Subordinate to Engineering Constitution v4.0, Monetization & Pricing v4.0, North Star v4.0
**Stage gate:** Beta-bound (must not regress MVP-critical systems per Beta Pause Rule)

---

## 1. Purpose

This document specifies the complete elimination of the permanent Free tier and its replacement with a trial-based access model. It is binding on all development work touching plan resolution, quota enforcement, billing, user lifecycle, and onboarding. Any deviation requires explicit owner approval.

This is a destructive migration of customer-facing pricing semantics. It must be executed with the same rigor as any identity or financial spine migration. **No silent mutation. Fail-closed throughout. Preserve all customer data.**

---

## 2. Scope of Change

### What is being removed

The permanent Free tier as currently defined in Monetization & Pricing v4.0:
- 3 active jobs maximum
- 3 employee records
- Text logging only (no OCR, voice, Ask Chief, exports)
- 90-day rolling history
- No upgrade pressure beyond feature denial

### What is replacing it

A four-state lifecycle for every new account:

1. **TRIAL** — 30 days of full Starter access, no credit card required
2. **EXTENSION** — Optional 14-day extension, credit card required (not charged), full Starter access
3. **PAID** — Active paying subscription (Founding Member, Starter, Pro, or Enterprise)
4. **READ_ONLY** — 90 days of data preservation post-trial/extension expiration; no captures or reasoning, exports preserved

### What is unchanged

- Starter ($149/month), Pro ($349/month), Enterprise (on request) plan definitions
- All existing identity boundaries (tenant_id / owner_id / user_id)
- Canonical financial spine (public.transactions)
- CIL enforcement, idempotency rules, RLS policies
- Plan-gating fail-closed behavior (the *mechanism* stays; the *plan_keys* change)

### What is added

- New plan_key: `founding_member` ($99/month, lifetime locked, first 50 customers only)
- New lifecycle state column on the users table
- New trial_started_at, trial_ends_at, extension_started_at, extension_ends_at, read_only_started_at, read_only_ends_at timestamps
- New reminder sequence (day 21, 25, 28, 30 of trial; day 7, 12, 14 of extension; day 30, 60, 80 of read-only)
- New founding_member_slot_number column (integer, nullable, unique, 1-50)

---

## 3. Stage Gate Requirements

Before this migration begins, the following must be true:

1. **MVP regression harness must run clean** (expense, revenue, timeclock, exports). Per Beta Pause Rule, if any MVP-critical system regresses during this work, the migration pauses until restored.
2. **Twilio transport must be stable** (no 11200s in the past 7 days).
3. **Plan resolution must be confirmed fail-closed** in current production (test with a corrupted plan_key field; verify Free behavior is enforced and access is blocked, not allowed).
4. **Stripe webhook signature verification must be confirmed working** (test with a deliberately malformed signature; verify rejection).
5. **Backups must be verified within the past 24 hours** before migration begins. This is a destructive change to user lifecycle semantics; rollback requires backup integrity.

If any of these are not true, this work pauses until they are.

---

## 4. Database Schema Changes

### 4.1 Users table modifications

The canonical user/owner record is `public.users` (or whatever your current name is — adjust accordingly). Add the following columns:

```sql
-- File: migrations/2026_04_28_001_add_trial_lifecycle_columns.sql
-- Purpose: Add lifecycle columns to support trial-based access model
-- Reversible: Yes (see rollback section at bottom)

BEGIN;

-- Add lifecycle state column
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'trial'
    CHECK (lifecycle_state IN ('trial', 'extension', 'paid', 'read_only', 'archived'));

-- Add trial timestamps
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- Add extension timestamps
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS extension_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extension_ends_at TIMESTAMPTZ;

-- Add read-only timestamps
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS read_only_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_only_ends_at TIMESTAMPTZ;

-- Add archive timestamp (for 12-month post-read-only window)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS data_deletion_eligible_at TIMESTAMPTZ;

-- Add Founding Member tracking
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS founding_member_slot_number INTEGER UNIQUE
    CHECK (founding_member_slot_number IS NULL OR (founding_member_slot_number >= 1 AND founding_member_slot_number <= 50));

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS founding_member_committed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS founding_member_commitment_ends_at TIMESTAMPTZ;

-- Indexes for lifecycle state queries
CREATE INDEX IF NOT EXISTS idx_users_lifecycle_state ON public.users(lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_users_trial_ends_at ON public.users(trial_ends_at)
  WHERE lifecycle_state = 'trial';
CREATE INDEX IF NOT EXISTS idx_users_extension_ends_at ON public.users(extension_ends_at)
  WHERE lifecycle_state = 'extension';
CREATE INDEX IF NOT EXISTS idx_users_read_only_ends_at ON public.users(read_only_ends_at)
  WHERE lifecycle_state = 'read_only';
CREATE INDEX IF NOT EXISTS idx_users_founding_member_slot ON public.users(founding_member_slot_number)
  WHERE founding_member_slot_number IS NOT NULL;

COMMIT;
```

**Rationale for column choices:**
- `lifecycle_state` is a CHECK-constrained enum, not a foreign key, because the states are fixed and version-controlled in code. Using an enum table would create unnecessary join overhead on every plan resolution.
- All timestamps are `TIMESTAMPTZ` (with timezone) per the Engineering Constitution's ISO datetime requirement.
- The `archived_at` and `data_deletion_eligible_at` columns enable the post-read-only data lifecycle without requiring future schema changes.
- The `founding_member_slot_number` is `UNIQUE` to enforce the 50-slot cap structurally; a duplicate slot number is a hard database error, not an application logic check.

### 4.2 Plan key changes

The current `users.plan_key` field needs to support the new `founding_member` value. If you currently have a CHECK constraint or enum:

```sql
-- File: migrations/2026_04_28_002_update_plan_keys.sql

BEGIN;

-- If plan_key has an existing CHECK constraint, drop and recreate
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_plan_key_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_plan_key_check
  CHECK (plan_key IN ('free', 'founding_member', 'starter', 'pro', 'enterprise', 'trial', 'extension', 'read_only'));

-- Note: 'free' is preserved in the constraint for backward compatibility during migration
-- but new accounts will not be created with plan_key = 'free'
-- Existing 'free' accounts are migrated in step 4.4

COMMIT;
```

**Important:** `plan_key` and `lifecycle_state` are now two separate fields with different responsibilities:
- `plan_key` answers: "What tier of features should this user have access to right now?" (used by quota enforcement)
- `lifecycle_state` answers: "Where is this user in the trial → paid → read_only journey?" (used by reminder sequences, billing transitions, archive logic)

A user in `lifecycle_state = 'trial'` will have `plan_key = 'starter'` (full Starter feature access during trial).
A user in `lifecycle_state = 'paid'` will have `plan_key` of `founding_member`, `starter`, `pro`, or `enterprise`.
A user in `lifecycle_state = 'read_only'` will have `plan_key = 'read_only'` (a special restricted tier — see section 6.4).

### 4.3 Plan tier definitions table (if not already present)

If you have a `plan_tiers` configuration table, update it. If you don't, plan tier rules live in code; either way, the canonical definitions are:

| plan_key | jobs_max | employees_max | ocr_monthly | voice_monthly | ask_chief_monthly | exports | approvals | retention |
|---|---|---|---|---|---|---|---|---|
| `trial` | 25 | 10 | 100 | 100 | 50 | yes | no | 30 days |
| `extension` | 25 | 10 | 100 | 100 | 50 | yes | no | 44 days |
| `founding_member` | 25 | 10 | 100 | 100 | 50 | yes | no | 3 years |
| `starter` | 25 | 10 | 100 | 100 | 50 | yes | no | 3 years |
| `pro` | unlimited | 150 | 500 | 500 | 200 | yes | yes | 7 years |
| `enterprise` | unlimited | unlimited | unlimited | unlimited | unlimited | yes | yes | unlimited |
| `read_only` | 0 (no captures) | n/a | 0 | 0 | 0 | yes (read-only) | no | 90 days |

**Note:** `trial`, `extension`, and `founding_member` have identical feature access to `starter`. They differ only in lifecycle state and pricing. This is deliberate — the trial experience must equal the paid Starter experience so contractors evaluate the real product.

### 4.4 Existing user migration

Any account currently on the Free tier needs to be migrated. Decision point: **do existing Free users get the 30-day trial as a courtesy, or do they remain on Free indefinitely as grandfathered users, or do they immediately enter the new lifecycle?**

**Recommended approach: grandfather existing Free users for 90 days, then transition them.**

Existing Free users have already been using the product. Forcing them into a 30-day trial countdown would be customer-hostile. Eliminating Free entirely would be customer-hostile. The middle path:

1. Existing Free users keep their current access for 90 days from the migration date.
2. At day 60, send a personal communication from Scott (not a system email) explaining the change and offering the Founding Member rate as a thank-you.
3. At day 90, transition any non-converted Free users to `read_only` state.
4. They then get the full 90-day read-only window before archive.

```sql
-- File: migrations/2026_04_28_003_migrate_existing_free_users.sql
-- Purpose: Grandfather existing Free users with 90-day notice before lifecycle transition

BEGIN;

UPDATE public.users
SET
  lifecycle_state = 'trial',
  plan_key = 'starter',  -- Upgrade their access for the grandfather period
  trial_started_at = NOW(),
  trial_ends_at = NOW() + INTERVAL '90 days',  -- 90-day grandfather, not 30
  -- Mark them as grandfathered for reminder targeting
  metadata = COALESCE(metadata, '{}'::jsonb) || '{"grandfathered_from_free": true}'::jsonb
WHERE plan_key = 'free'
  AND lifecycle_state IS DISTINCT FROM 'paid';

-- Audit log
INSERT INTO public.audit_events (event_type, event_data, created_at)
SELECT
  'lifecycle_migration_grandfather',
  jsonb_build_object('user_id', id, 'previous_plan', 'free', 'new_state', 'trial', 'extended_until', NOW() + INTERVAL '90 days'),
  NOW()
FROM public.users
WHERE plan_key = 'starter'
  AND metadata->>'grandfathered_from_free' = 'true';

COMMIT;
```

**Communication to grandfathered users (separate, not part of the migration script):**

Scott sends a personal WhatsApp message and email to each grandfathered user, ideally manually for the first 50 and templated thereafter. The message should be honest:

> *"Hey [name] — quick note. ChiefOS used to have a permanent free plan. I'm changing that. If you want to keep using ChiefOS, the new pricing is $149/month, but I'm offering you Founding Member status at $99/month locked for life as a thank-you for being an early user. You have until [date] to decide — your data is preserved either way. Want to talk it through?"*

This is the kind of message that converts loyal early users and gets honest feedback from those who decline.

---

## 5. Plan Resolution Logic Changes

### 5.1 The plan resolution function

Per Engineering Constitution Section 5 (safe query patterns) and Monetization & Pricing v4.0 Section 5 (plan authority), the canonical plan resolution must:

1. Resolve `owner_id` from the request context (WhatsApp ingestion or portal).
2. Look up the user record by owner_id.
3. Compute effective `plan_key` based on `lifecycle_state` and `plan_key` columns.
4. Fail closed if any field is null, ambiguous, or expired without transition.

```typescript
// File: src/services/plan-resolution.ts (or whatever your current location is)

import { db } from '../db';
import { logger } from '../logger';

export type PlanKey = 'trial' | 'extension' | 'founding_member' | 'starter' | 'pro' | 'enterprise' | 'read_only';

export type LifecycleState = 'trial' | 'extension' | 'paid' | 'read_only' | 'archived';

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

/**
 * Resolves the effective plan for a given owner_id.
 * Per Engineering Constitution: fails closed on any ambiguity.
 * Per Monetization Doctrine: never trusts client-side plan_key.
 */
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

  // Step 2: Fetch user record
  const user = await db.users.findOne({ owner_id });

  if (!user) {
    logger.warn({ trace_id, owner_id }, 'User not found in plan resolution');
    return {
      ok: false,
      error: {
        code: 'TENANT_RESOLUTION_FAILED',
        message: 'No user found for owner_id',
        hint: 'Account may have been archived or never existed',
        trace_id,
      },
    };
  }

  // Step 3: Validate lifecycle_state and plan_key are both present
  if (!user.lifecycle_state || !user.plan_key) {
    logger.error({ trace_id, owner_id, user_id: user.id }, 'User has null lifecycle_state or plan_key — failing closed');
    return {
      ok: false,
      error: {
        code: 'LIFECYCLE_AMBIGUOUS',
        message: 'User lifecycle state cannot be determined',
        hint: 'Account requires manual review',
        trace_id,
      },
    };
  }

  // Step 4: Check for expired trial without transition (drift detection)
  const now = new Date();

  if (user.lifecycle_state === 'trial' && user.trial_ends_at && user.trial_ends_at < now) {
    logger.error({
      trace_id,
      owner_id,
      trial_ends_at: user.trial_ends_at,
      now,
    }, 'User in trial state past trial_ends_at — lifecycle drift detected, failing closed');

    return {
      ok: false,
      error: {
        code: 'LIFECYCLE_AMBIGUOUS',
        message: 'Trial period has ended but lifecycle has not transitioned',
        hint: 'Account requires lifecycle reconciliation; check transition cron job',
        trace_id,
      },
    };
  }

  // Same drift check for extension and read_only states
  if (user.lifecycle_state === 'extension' && user.extension_ends_at && user.extension_ends_at < now) {
    logger.error({ trace_id, owner_id }, 'User in extension state past extension_ends_at — lifecycle drift detected, failing closed');
    return {
      ok: false,
      error: {
        code: 'LIFECYCLE_AMBIGUOUS',
        message: 'Extension period has ended but lifecycle has not transitioned',
        hint: 'Account requires lifecycle reconciliation; check transition cron job',
        trace_id,
      },
    };
  }

  if (user.lifecycle_state === 'read_only' && user.read_only_ends_at && user.read_only_ends_at < now) {
    logger.error({ trace_id, owner_id }, 'User in read_only state past read_only_ends_at — lifecycle drift detected, failing closed');
    return {
      ok: false,
      error: {
        code: 'LIFECYCLE_AMBIGUOUS',
        message: 'Read-only period has ended but account has not been archived',
        hint: 'Account requires lifecycle reconciliation; check transition cron job',
        trace_id,
      },
    };
  }

  // Step 5: Return resolved plan
  return {
    ok: true,
    plan_key: user.plan_key as PlanKey,
    lifecycle_state: user.lifecycle_state as LifecycleState,
    effective_at: now,
    trace_id,
  };
}
```

**Critical rules for this function:**

- **Never return `'free'` as a plan_key.** Free is removed. If the function is called for an account with `plan_key = 'free'`, this is a migration error and must fail closed.
- **Always log the trace_id** with every decision. Per Engineering Constitution Section 9, all error responses include trace_id.
- **Drift detection is mandatory.** A user in `lifecycle_state = 'trial'` with `trial_ends_at` in the past should never happen if the cron job is healthy. If it does, fail closed; do not silently extend the trial or assume any other behavior.
- **The function is read-only.** It does not transition lifecycle states. State transitions happen in the cron job (Section 7) or in explicit user actions (credit card add, payment, cancellation). Plan resolution observes; it does not mutate.

### 5.2 Quota enforcement integration

The existing `checkMonthlyQuota()` and `consumeMonthlyQuota()` functions per Monetization & Pricing v4.0 Section 5 must integrate with the new plan resolution:

```typescript
// File: src/services/quota-enforcement.ts (extension to existing logic)

import { resolveEffectivePlan } from './plan-resolution';
import { getPlanLimits } from './plan-limits';

export async function checkMonthlyQuota(
  owner_id: string,
  feature_kind: 'ocr' | 'voice' | 'ask_chief' | 'export',
  trace_id: string
): Promise<QuotaCheckResult> {
  // Step 1: Resolve plan
  const planResult = await resolveEffectivePlan(owner_id, trace_id);

  if (!planResult.ok) {
    // Per Engineering Constitution: fail closed
    return {
      ok: false,
      reason: 'PLAN_RESOLUTION_FAILED',
      message: 'Cannot determine plan; access blocked',
      trace_id,
    };
  }

  // Step 2: Read-only state blocks all captures and reasoning
  if (planResult.lifecycle_state === 'read_only') {
    if (feature_kind !== 'export') {
      return {
        ok: false,
        reason: 'READ_ONLY_MODE',
        message: 'Account is in read-only mode. Exports remain available; new captures and questions are paused.',
        upgrade_path: true,
        trace_id,
      };
    }
  }

  // Step 3: Get feature limits for this plan_key
  const limits = getPlanLimits(planResult.plan_key);

  if (limits[feature_kind] === 0) {
    return {
      ok: false,
      reason: 'NOT_INCLUDED',
      message: `${feature_kind} is not included in your current plan`,
      upgrade_path: true,
      trace_id,
    };
  }

  // Step 4: Check current month usage (existing logic)
  const currentUsage = await getCurrentMonthUsage(owner_id, feature_kind);

  if (currentUsage >= limits[feature_kind]) {
    return {
      ok: false,
      reason: 'OVER_QUOTA',
      message: `Monthly limit reached for ${feature_kind}`,
      upgrade_path: true,
      remaining: 0,
      trace_id,
    };
  }

  return {
    ok: true,
    plan_key: planResult.plan_key,
    feature_kind,
    remaining: limits[feature_kind] - currentUsage,
    trace_id,
  };
}
```

---

## 6. Lifecycle State Transitions

### 6.1 Transition: NEW → TRIAL

**Trigger:** User completes account creation (whatsapp onboarding or portal signup).

**Action:**
```typescript
async function initializeNewUser(owner_id: string, source: 'whatsapp' | 'portal'): Promise<void> {
  const now = new Date();
  const trial_ends_at = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await db.users.update(
    { owner_id },
    {
      lifecycle_state: 'trial',
      plan_key: 'starter', // Trial = full Starter access
      trial_started_at: now,
      trial_ends_at,
    }
  );

  await auditLog({
    event_type: 'lifecycle_transition',
    owner_id,
    from_state: 'new',
    to_state: 'trial',
    metadata: { source, trial_ends_at },
  });
}
```

**Welcome message (sent immediately via WhatsApp):**

> *"Welcome to ChiefOS. You have full access for the next 30 days — text receipts, snap photos, voice-note hours, ask anything. No credit card needed yet. Try sending me a photo of your most recent receipt to start."*

This message is intentional: it triggers Magic Moment 1 (the receipt parser) on day 1.

### 6.2 Transition: TRIAL → EXTENSION

**Trigger:** User adds a credit card before `trial_ends_at`.

**Preconditions:**
- User is in `lifecycle_state = 'trial'`
- Stripe has confirmed a valid payment method attached to the customer
- `trial_ends_at` has not yet passed

**Action:**
```typescript
async function transitionTrialToExtension(owner_id: string, stripe_customer_id: string): Promise<void> {
  const now = new Date();
  const extension_ends_at = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days

  await db.users.update(
    { owner_id, lifecycle_state: 'trial' }, // Conditional: only update if still in trial
    {
      lifecycle_state: 'extension',
      // plan_key stays 'starter' — feature access is the same
      extension_started_at: now,
      extension_ends_at,
      stripe_customer_id,
    }
  );

  await auditLog({
    event_type: 'lifecycle_transition',
    owner_id,
    from_state: 'trial',
    to_state: 'extension',
    metadata: { extension_ends_at, stripe_customer_id },
  });
}
```

**WhatsApp confirmation:**

> *"Card added. You're good for another 14 days, no charge until you decide what plan to commit to. Keep capturing — I'll have more answers to give you the more data we have."*

### 6.3 Transition: TRIAL/EXTENSION → PAID

**Trigger:** User confirms a paid plan choice (Founding Member, Starter, Pro, or Enterprise).

**Preconditions:**
- User is in `lifecycle_state IN ('trial', 'extension')`
- Stripe subscription has been successfully created
- Stripe webhook has been received and signature-verified

**Action:**
```typescript
async function transitionToPaid(
  owner_id: string,
  stripe_subscription_id: string,
  selected_plan_key: 'founding_member' | 'starter' | 'pro' | 'enterprise',
  trace_id: string
): Promise<void> {
  // Founding Member requires slot allocation
  let founding_member_slot_number: number | null = null;
  let founding_member_committed_at: Date | null = null;
  let founding_member_commitment_ends_at: Date | null = null;

  if (selected_plan_key === 'founding_member') {
    founding_member_slot_number = await allocateFoundingMemberSlot(owner_id, trace_id);

    if (founding_member_slot_number === null) {
      throw new Error('FOUNDING_MEMBER_SLOTS_EXHAUSTED');
    }

    const now = new Date();
    founding_member_committed_at = now;
    founding_member_commitment_ends_at = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 12 months
  }

  await db.users.update(
    { owner_id, lifecycle_state: { $in: ['trial', 'extension'] } },
    {
      lifecycle_state: 'paid',
      plan_key: selected_plan_key,
      stripe_subscription_id,
      founding_member_slot_number,
      founding_member_committed_at,
      founding_member_commitment_ends_at,
    }
  );

  await auditLog({
    event_type: 'lifecycle_transition',
    owner_id,
    from_state: 'trial_or_extension',
    to_state: 'paid',
    metadata: {
      selected_plan_key,
      stripe_subscription_id,
      founding_member_slot_number,
    },
    trace_id,
  });
}

async function allocateFoundingMemberSlot(owner_id: string, trace_id: string): Promise<number | null> {
  // Atomic slot allocation — first available number 1-50
  const result = await db.transaction(async (tx) => {
    const taken = await tx.users.find(
      { founding_member_slot_number: { $not: null } },
      { fields: ['founding_member_slot_number'] }
    );

    const takenNumbers = new Set(taken.map(u => u.founding_member_slot_number));

    for (let slot = 1; slot <= 50; slot++) {
      if (!takenNumbers.has(slot)) {
        // Atomic check-and-claim
        const claimed = await tx.users.update(
          { owner_id, founding_member_slot_number: null },
          { founding_member_slot_number: slot }
        );

        if (claimed.modifiedCount === 1) {
          return slot;
        }
      }
    }

    return null;
  });

  if (result === null) {
    logger.warn({ trace_id, owner_id }, 'Founding Member slots exhausted');
  } else {
    logger.info({ trace_id, owner_id, slot: result }, 'Founding Member slot allocated');
  }

  return result;
}
```

**Critical:** The slot allocation must be atomic and idempotent. Two simultaneous Founding Member signups must never get the same slot number. The unique constraint at the database level enforces this structurally; the application logic just gracefully handles the conflict.

### 6.4 Transition: TRIAL/EXTENSION → READ_ONLY

**Trigger:** Trial or extension expires without paid conversion. Also: user explicitly cancels during extension before charge.

**Preconditions:**
- User is in `lifecycle_state IN ('trial', 'extension')`
- `trial_ends_at` (if trial) or `extension_ends_at` (if extension) has passed
- No active Stripe subscription

**Action:**
```typescript
async function transitionToReadOnly(owner_id: string, trace_id: string): Promise<void> {
  const now = new Date();
  const read_only_ends_at = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days

  await db.users.update(
    { owner_id, lifecycle_state: { $in: ['trial', 'extension'] } },
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
    from_state: 'trial_or_extension',
    to_state: 'read_only',
    metadata: { read_only_ends_at },
    trace_id,
  });
}
```

**WhatsApp message at transition:**

> *"Your ChiefOS trial period has ended. Your data is preserved and you can still export everything for the next 90 days. New captures and Ask Chief are paused until you upgrade. When you're ready, just reply UPGRADE and I'll walk you through the options."*

### 6.5 Transition: READ_ONLY → ARCHIVED

**Trigger:** `read_only_ends_at` passes without paid conversion.

**Action:**
```typescript
async function transitionToArchived(owner_id: string, trace_id: string): Promise<void> {
  const now = new Date();
  const data_deletion_eligible_at = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 12 months

  await db.users.update(
    { owner_id, lifecycle_state: 'read_only' },
    {
      lifecycle_state: 'archived',
      // plan_key stays 'read_only' for record-keeping
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

In the archived state, all WhatsApp messages from the user receive a single response:

> *"Your ChiefOS account is archived. Your data is recoverable for the next 12 months — reply UPGRADE to restore access. After that, data will be deleted per our retention policy."*

### 6.6 Transition: PAID → READ_ONLY (downgrade or cancellation)

**Trigger:** Stripe webhook indicates subscription canceled or payment failed beyond grace period.

**Special case for Founding Members:** If a Founding Member cancels before `founding_member_commitment_ends_at`, they have violated their 12-month commitment. The Founding Member slot is **not** preserved. They forfeit founding pricing and the slot returns to the available pool. Document this clearly in the Founding Member terms.

```typescript
async function transitionPaidToReadOnly(owner_id: string, reason: 'canceled' | 'payment_failed', trace_id: string): Promise<void> {
  const now = new Date();
  const read_only_ends_at = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const user = await db.users.findOne({ owner_id });

  // Founding Member commitment violation handling
  let founding_member_forfeited = false;
  if (user.plan_key === 'founding_member' && user.founding_member_commitment_ends_at && user.founding_member_commitment_ends_at > now) {
    founding_member_forfeited = true;
  }

  await db.users.update(
    { owner_id, lifecycle_state: 'paid' },
    {
      lifecycle_state: 'read_only',
      plan_key: 'read_only',
      read_only_started_at: now,
      read_only_ends_at,
      // If forfeited, clear the slot to return it to the pool
      founding_member_slot_number: founding_member_forfeited ? null : user.founding_member_slot_number,
    }
  );

  await auditLog({
    event_type: 'lifecycle_transition',
    owner_id,
    from_state: 'paid',
    to_state: 'read_only',
    metadata: {
      reason,
      founding_member_forfeited,
      previous_plan_key: user.plan_key,
    },
    trace_id,
  });
}
```

---

## 7. Lifecycle Transition Cron Job

A scheduled job runs every 15 minutes and performs lifecycle reconciliation. This is the mechanism that drives state transitions based on time. Without it, the drift detection in `resolveEffectivePlan()` will trip and accounts will fail closed.

```typescript
// File: src/cron/lifecycle-reconciler.ts

export async function reconcileLifecycleStates(): Promise<void> {
  const trace_id = generateTraceId();
  const now = new Date();

  // 1. Trial → Read-only (trial expired without extension or payment)
  const expiredTrials = await db.users.find({
    lifecycle_state: 'trial',
    trial_ends_at: { $lt: now },
  });

  for (const user of expiredTrials) {
    try {
      await transitionToReadOnly(user.owner_id, trace_id);
      await sendWhatsAppMessage(user.owner_id, READ_ONLY_TRANSITION_MESSAGE);
    } catch (err) {
      logger.error({ err, owner_id: user.owner_id, trace_id }, 'Failed to transition expired trial to read-only');
      // Do not throw — continue processing other users
    }
  }

  // 2. Extension → Paid (Stripe should have already charged; if active subscription exists, transition)
  // OR Extension → Read-only (if no active subscription after extension expires)
  const expiredExtensions = await db.users.find({
    lifecycle_state: 'extension',
    extension_ends_at: { $lt: now },
  });

  for (const user of expiredExtensions) {
    try {
      const stripeSubscription = await stripe.subscriptions.retrieve(user.stripe_subscription_id);

      if (stripeSubscription && stripeSubscription.status === 'active') {
        // Subscription was successfully created — transition to paid
        // (This is a defensive check; the Stripe webhook should have already done this)
        const planKey = mapStripePriceIdToPlanKey(stripeSubscription.items.data[0].price.id);
        await transitionToPaid(user.owner_id, stripeSubscription.id, planKey, trace_id);
      } else {
        // Extension expired without active subscription
        await transitionToReadOnly(user.owner_id, trace_id);
      }
    } catch (err) {
      logger.error({ err, owner_id: user.owner_id, trace_id }, 'Failed to transition expired extension');
    }
  }

  // 3. Read-only → Archived
  const expiredReadOnly = await db.users.find({
    lifecycle_state: 'read_only',
    read_only_ends_at: { $lt: now },
  });

  for (const user of expiredReadOnly) {
    try {
      await transitionToArchived(user.owner_id, trace_id);
    } catch (err) {
      logger.error({ err, owner_id: user.owner_id, trace_id }, 'Failed to archive expired read-only account');
    }
  }

  // 4. Reminder dispatch (see Section 8)
  await dispatchTrialReminders(now, trace_id);
  await dispatchExtensionReminders(now, trace_id);
  await dispatchReadOnlyReminders(now, trace_id);

  logger.info({ trace_id, processed: { expiredTrials: expiredTrials.length, expiredExtensions: expiredExtensions.length, expiredReadOnly: expiredReadOnly.length } }, 'Lifecycle reconciliation complete');
}
```

**Cron schedule:** `*/15 * * * *` (every 15 minutes).

**Operational notes:**
- The cron job is idempotent. Running it twice in close succession will not create duplicate transitions because each transition has a state precondition.
- Failures on individual users do not halt the run. Each user is processed independently with its own try/catch.
- All transitions are audit-logged with trace_id for traceability.
- If the cron job is down for an extended period, drift will accumulate. The fail-closed behavior in `resolveEffectivePlan()` will block access for affected users until the cron catches up. This is the correct behavior — better to block than to silently allow.

---

## 8. Reminder Sequence

This is the conversion mechanism. Without these messages, trial-to-paid conversion will be measurably worse. Each message is sent via WhatsApp from the same number as ChiefOS itself.

### 8.1 Trial reminders

| Day | Trigger condition | Message |
|---|---|---|
| 21 | trial_ends_at - now ≤ 9 days, never sent | *"You're 9 days from the end of your ChiefOS trial. Want to see what answers your data has so far? Just ask: 'Did April make money?' or 'Which job had the best margin?' I'll show you what I've learned."* |
| 25 | trial_ends_at - now ≤ 5 days, never sent | *"5 days left on your trial. The best way to know if ChiefOS is worth committing to is to ask the questions you actually care about. Try one now."* |
| 28 | trial_ends_at - now ≤ 2 days, never sent | *"Your trial ends in 2 days. If you want to keep going, add a credit card and I'll extend you 14 more days — no charge until you decide what plan fits. Reply EXTEND when you're ready."* |
| 30 | trial_ends_at - now ≤ 0 hours, transitioning to read-only | *"Your trial just ended. Your data is preserved for 90 days and you can still export everything. To keep capturing and asking questions, reply UPGRADE."* |

### 8.2 Extension reminders

| Day of extension | Message |
|---|---|
| 7 | *"Halfway through your extension. Have you asked Chief the question that's been on your mind? Now's the time."* |
| 12 | *"Your extension ends in 2 days. The card on file won't be charged until you pick a plan. Reply PLANS to see your options."* |
| 14 | *"Extension ended. Pick a plan to continue: Founding Member ($99/mo lifetime, first 50 only — slots remaining: [N]), Starter ($149/mo), or Pro ($349/mo). Reply with your choice or PLANS for details."* |

### 8.3 Read-only reminders

| Day of read-only | Message |
|---|---|
| 30 | *"You've been in read-only mode for 30 days. Your data is still here. Want to come back? Reply UPGRADE."* |
| 60 | *"60 days into read-only. Data preservation continues for another 30 days. After that, account archives. Reply UPGRADE to restore access."* |
| 80 | *"10 days until your account archives. Once archived, your data is recoverable for 12 months on upgrade, then deleted. Reply UPGRADE if you want to come back."* |

### 8.4 Reminder idempotency

Reminders must be idempotent. The reminder dispatch logic uses a `reminders_sent` table or a JSONB column on the user record:

```sql
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS reminders_sent JSONB NOT NULL DEFAULT '{}'::jsonb;
```

Before sending a reminder, check the JSONB:

```typescript
async function sendTrialReminderIfNotSent(user: User, day: number, message: string, trace_id: string): Promise<void> {
  const reminderKey = `trial_day_${day}`;

  if (user.reminders_sent[reminderKey]) {
    return; // Already sent
  }

  await sendWhatsAppMessage(user.owner_id, message);

  await db.users.update(
    { owner_id: user.owner_id },
    {
      $set: {
        [`reminders_sent.${reminderKey}`]: new Date().toISOString(),
      },
    }
  );

  await auditLog({
    event_type: 'reminder_sent',
    owner_id: user.owner_id,
    metadata: { reminder_key: reminderKey, message_preview: message.substring(0, 100) },
    trace_id,
  });
}
```

This guarantees each reminder fires exactly once per user per lifecycle stage, even if the cron job runs multiple times within the trigger window.

---

## 9. Stripe Integration Updates

### 9.1 New products and prices in Stripe

Configure the following in Stripe Dashboard (or via API):

| Product | Price ID env var | Amount | Interval | Notes |
|---|---|---|---|---|
| ChiefOS Founding Member | `STRIPE_PRICE_FOUNDING_MEMBER_MONTHLY` | $99 USD | month | First 50 customers only — enforce in app, not Stripe |
| ChiefOS Founding Member Annual | `STRIPE_PRICE_FOUNDING_MEMBER_ANNUAL` | $1,188 USD | year | Annual prepay option |
| ChiefOS Starter | `STRIPE_PRICE_STARTER_MONTHLY` | $149 USD | month | |
| ChiefOS Pro | `STRIPE_PRICE_PRO_MONTHLY` | $349 USD | month | |
| ChiefOS Enterprise | (custom invoice) | varies | — | Manual billing, no recurring price |

**Remove or archive in Stripe:**
- Any existing "Free" product (it shouldn't exist in Stripe but verify)
- Any old pricing not matching the above

### 9.2 Webhook handling

The Stripe webhook handler must process these events:

```typescript
// File: src/webhooks/stripe.ts

export async function handleStripeWebhook(event: Stripe.Event): Promise<void> {
  const trace_id = generateTraceId();

  // Verify signature first (per Engineering Constitution)
  // ... existing signature verification ...

  switch (event.type) {
    case 'customer.subscription.created':
      await handleSubscriptionCreated(event.data.object as Stripe.Subscription, trace_id);
      break;

    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription, trace_id);
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription, trace_id);
      break;

    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data.object as Stripe.Invoice, trace_id);
      break;

    case 'payment_method.attached':
      // This is what triggers Trial → Extension transition
      await handlePaymentMethodAttached(event.data.object as Stripe.PaymentMethod, trace_id);
      break;

    default:
      logger.info({ event_type: event.type, trace_id }, 'Unhandled Stripe webhook event');
  }
}

async function handlePaymentMethodAttached(pm: Stripe.PaymentMethod, trace_id: string): Promise<void> {
  const stripe_customer_id = pm.customer as string;

  // Find user by stripe_customer_id
  const user = await db.users.findOne({ stripe_customer_id });

  if (!user) {
    logger.warn({ stripe_customer_id, trace_id }, 'Payment method attached for unknown customer');
    return;
  }

  // Only trigger trial → extension if currently in trial
  if (user.lifecycle_state === 'trial') {
    await transitionTrialToExtension(user.owner_id, stripe_customer_id);
    await sendWhatsAppMessage(user.owner_id, EXTENSION_CONFIRMATION_MESSAGE);
  }
}
```

### 9.3 Founding Member Stripe metadata

When creating a Founding Member subscription in Stripe, attach metadata:

```typescript
const subscription = await stripe.subscriptions.create({
  customer: stripe_customer_id,
  items: [{ price: process.env.STRIPE_PRICE_FOUNDING_MEMBER_MONTHLY }],
  metadata: {
    chiefos_plan_key: 'founding_member',
    chiefos_founding_member_slot: founding_member_slot_number.toString(),
    chiefos_committed_at: founding_member_committed_at.toISOString(),
    chiefos_commitment_ends_at: founding_member_commitment_ends_at.toISOString(),
  },
});
```

This metadata is for audit and reconciliation purposes. Plan resolution must still use the database as canonical truth (per Monetization & Pricing v4.0 Section 5: "Never rely on cached client state").

---

## 10. Edge Cases

### 10.1 User adds card on day 30 of trial (extension overlap)

**Scenario:** User adds a credit card at hour 23:55 of day 30 of their trial. The trial expires at midnight. The cron job runs at 23:59 and sees `trial_ends_at < now` and tries to transition to read-only. But the card was already added.

**Resolution:** The Stripe webhook for `payment_method.attached` should fire and transition trial → extension *before* the cron job runs. But race conditions are possible.

**Defensive logic in cron:**
```typescript
// In the trial expiry processing:
for (const user of expiredTrials) {
  // Defensive: re-check Stripe customer for attached payment method
  if (user.stripe_customer_id) {
    const customer = await stripe.customers.retrieve(user.stripe_customer_id);
    if (customer.invoice_settings?.default_payment_method) {
      // User has a payment method but never transitioned — fix it
      await transitionTrialToExtension(user.owner_id, user.stripe_customer_id);
      continue; // Skip the read-only transition
    }
  }
  await transitionToReadOnly(user.owner_id, trace_id);
}
```

### 10.2 User pays for plan during read-only state

**Scenario:** User in read-only state replies UPGRADE and pays for Starter. They should immediately re-enter paid state with all their data intact.

**Resolution:** The transition logic needs to support read-only → paid:

```typescript
async function transitionReadOnlyToPaid(
  owner_id: string,
  stripe_subscription_id: string,
  selected_plan_key: PlanKey,
  trace_id: string
): Promise<void> {
  await db.users.update(
    { owner_id, lifecycle_state: 'read_only' },
    {
      lifecycle_state: 'paid',
      plan_key: selected_plan_key,
      stripe_subscription_id,
      // Clear read-only timestamps
      read_only_started_at: null,
      read_only_ends_at: null,
    }
  );

  await auditLog({
    event_type: 'lifecycle_transition',
    owner_id,
    from_state: 'read_only',
    to_state: 'paid',
    metadata: { selected_plan_key, stripe_subscription_id, recovery: true },
    trace_id,
  });

  await sendWhatsAppMessage(owner_id, RECOVERED_FROM_READ_ONLY_MESSAGE);
}
```

**Recovery message:**
> *"Welcome back. Your data is restored and ChiefOS is fully active again. Pick up wherever you left off."*

### 10.3 Founding Member tries to pay after slots are exhausted

**Scenario:** User is in trial, slots 1-50 are taken, user tries to select Founding Member.

**Resolution:** The signup UI must check `getRemainingFoundingMemberSlots()` before showing the option. If slots are exhausted, the option is hidden or shown as "All founding member slots filled — Starter pricing available." The slot allocation function (Section 6.3) returns null and the application gracefully presents Starter as the alternative.

### 10.4 User deletes WhatsApp number / changes phone

**Scenario:** A user changes phone numbers. Their owner_id is now invalid for ingestion.

**Resolution:** This is an existing dual-boundary identity issue, not specific to trial migration. Handle via portal-side phone number update flow. Out of scope for this migration; flag for future work.

### 10.5 Failed Stripe payment during paid state

**Scenario:** User is on Starter ($149/mo). Stripe attempts to charge and fails (expired card, insufficient funds). Stripe enters dunning.

**Resolution:** Standard Stripe dunning flow (3 retries over ~21 days). On final failure, webhook fires `customer.subscription.deleted` and the user transitions paid → read_only with reason `payment_failed`. This is handled by the existing webhook logic in Section 9.2.

### 10.6 User in trial creates more than 25 jobs (impossible per plan_key='starter' limits, but just in case)

**Resolution:** Quota enforcement blocks this at the application layer. If somehow a user exceeded 25 jobs (data corruption, bug), the system continues to function but blocks new job creation. This is fail-closed behavior.

### 10.7 Trial user attempts an export

**Scenario:** Trial users have full Starter access. They can export. Good.

**Edge case:** A user exports on day 30 of trial (last day), then trial expires. They retain the exported file (already downloaded). They lose ability to generate new exports until upgrade.

**Resolution:** This is intended behavior. Exports already in the user's possession (downloaded) are theirs forever. The system controls future export *generation*, not retention of past exports.

---

## 11. Frontend / UX Changes

### 11.1 Onboarding flow

The current onboarding flow likely starts users on Free. Update to start on Trial:

1. User completes signup (WhatsApp QR code or portal email/password).
2. User record is created with `lifecycle_state = 'trial'` and `plan_key = 'starter'`.
3. WhatsApp welcome message is sent (Section 6.1).
4. Portal dashboard, if visited, shows a trial countdown banner: *"Trial ends in 23 days — [Add Credit Card] for an additional 14 days"*

### 11.2 Pricing page

Update the public pricing page at `chiefos.io/pricing` (or wherever it currently lives) to reflect the new tiers:

```
30-Day Trial — Free
Try every Starter feature for 30 days. No credit card.
[ Start Trial ]

Founding Member — $99/month (lifetime price lock)
First 50 contractors only. 12-month commitment.
Slots remaining: [N]/50
[ Become a Founding Member ]

Starter — $149/month
After trial. 25 jobs, full Ask Chief, exports.
[ Choose Starter ]

Pro — $349/month
Crews up to 150. Approvals. Full audit.
[ Choose Pro ]

Enterprise — On request
For multi-location operators or supplier-channel deployments.
[ Contact Us ]
```

The "Slots remaining" counter is dynamic. Pull from the database via a public endpoint:

```typescript
// File: src/api/founding-member-slots.ts
export async function getRemainingFoundingMemberSlots(): Promise<number> {
  const taken = await db.users.count({ founding_member_slot_number: { $not: null } });
  return Math.max(0, 50 - taken);
}
```

This endpoint is public (no auth required) and cached for 60 seconds to reduce database load.

### 11.3 Account / billing page

The portal account page must show:

- Current lifecycle state (Trial / Extension / Paid / Read-only)
- Days remaining (if applicable)
- Current plan_key
- Founding Member slot number (if applicable)
- Upgrade / change plan options
- Cancel option (with appropriate warnings for Founding Members within commitment period)

### 11.4 In-product upgrade prompts

Per Monetization & Pricing v4.0 Section 6, upgrade prompts must be shown once per owner per feature, owner_id-scoped, not spammy. The new lifecycle states add new prompt opportunities:

- Trial day 21: prompt to add card for extension
- Trial day 28: prompt to choose paid plan
- Read-only state: prompt to upgrade on every interaction (this is acceptable because the user has explicitly entered a degraded state)

---

## 12. Testing Requirements

Before deploying this migration, the following tests must pass:

### 12.1 Unit tests

- `resolveEffectivePlan()` returns correct plan for each lifecycle state
- `resolveEffectivePlan()` fails closed for null lifecycle_state, null plan_key, expired trial, expired extension, expired read-only
- `transitionTrialToExtension()` only transitions users currently in trial state
- `allocateFoundingMemberSlot()` returns sequential slots and returns null when 50 are exhausted
- `allocateFoundingMemberSlot()` is atomic under concurrent calls (test with simulated race)
- All reminder functions are idempotent (calling twice does not send twice)

### 12.2 Integration tests

- New user signup creates user in trial state with correct timestamps
- Adding a Stripe payment method transitions trial → extension via webhook
- Stripe subscription creation transitions extension → paid via webhook
- Subscription cancellation transitions paid → read_only via webhook
- Cron job correctly transitions expired trials to read-only
- Cron job correctly transitions expired read-only accounts to archived
- Founding Member slot allocation under concurrent load (10 simultaneous signups, all attempting Founding Member) — exactly 10 slots allocated, no duplicates

### 12.3 Cross-tenant isolation tests (per Engineering Constitution Section 6)

- Create 2 test tenants in trial state
- Verify no cross-tenant data visibility in any state (trial, extension, paid, read_only)
- Verify Founding Member slot numbers do not leak between tenants
- Verify reminders are sent to correct owner_id only

### 12.4 Migration test

- Backup production database
- Run migrations 2026_04_28_001, 002, 003 against a copy
- Verify all existing Free users transition to grandfathered trial state
- Verify all existing Starter and Pro users are unchanged
- Verify quota enforcement still works for grandfathered users
- Run regression harness against migrated copy

### 12.5 End-to-end manual test

A human (Scott) walks through:

1. Create new account → verify trial state, welcome message, day 1 receipt parser works
2. Send 5 receipts, 3 voice notes, ask Chief 3 questions over 30 days (or fast-forward via test fixtures)
3. Day 21: verify reminder sent
4. Day 28: add credit card → verify extension transition, confirmation message
5. Day 38 (extension day 8): verify extension reminder
6. Day 42 (extension day 12): select Founding Member → verify paid transition, slot allocation
7. Confirm full Starter feature access throughout
8. Cancel subscription → verify paid → read-only transition
9. Verify exports still work in read-only
10. Verify new captures blocked in read-only
11. Reply UPGRADE → verify Starter selection works → verify read_only → paid transition

---

## 13. Rollback Plan

If this migration must be rolled back, the following procedure applies:

### 13.1 Database rollback

```sql
-- File: rollback/2026_04_28_rollback.sql
-- WARNING: This rollback preserves data but reverts all users to a uniform state

BEGIN;

-- Step 1: Revert all users to their pre-migration plan_key
-- (Requires backup of plan_key values from pre-migration state)
UPDATE public.users u
SET plan_key = b.plan_key_pre_migration
FROM backup_users_pre_trial_migration b
WHERE u.id = b.id;

-- Step 2: Drop new columns
ALTER TABLE public.users
  DROP COLUMN IF EXISTS lifecycle_state,
  DROP COLUMN IF EXISTS trial_started_at,
  DROP COLUMN IF EXISTS trial_ends_at,
  DROP COLUMN IF EXISTS extension_started_at,
  DROP COLUMN IF EXISTS extension_ends_at,
  DROP COLUMN IF EXISTS read_only_started_at,
  DROP COLUMN IF EXISTS read_only_ends_at,
  DROP COLUMN IF EXISTS archived_at,
  DROP COLUMN IF EXISTS data_deletion_eligible_at,
  DROP COLUMN IF EXISTS founding_member_slot_number,
  DROP COLUMN IF EXISTS founding_member_committed_at,
  DROP COLUMN IF EXISTS founding_member_commitment_ends_at,
  DROP COLUMN IF EXISTS reminders_sent;

-- Step 3: Restore the original CHECK constraint on plan_key
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_plan_key_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_plan_key_check
  CHECK (plan_key IN ('free', 'starter', 'pro'));

COMMIT;
```

### 13.2 Code rollback

- Revert deployment to previous version
- Disable the lifecycle reconciliation cron job
- Restore the previous Stripe webhook handler

### 13.3 Customer communication on rollback

If rollback is required, send a transparent communication:

> *"We pushed a change to our pricing model that introduced issues. We've reverted to the previous model while we fix it. Your access and data are unchanged. Sorry for any confusion."*

### 13.4 Conditions that warrant rollback

Per Engineering Constitution Section 5 (migration rules) and the Beta Pause Rule:

- Identity boundary regression (cross-tenant data visibility detected)
- Plan resolution failing in production (multiple users blocked from access incorrectly)
- Stripe integration broken (charges failing or duplicating)
- More than 5% of users in error state for over 1 hour
- Founding Member slot allocation showing duplicates or gaps

If any of these occur, roll back immediately and diagnose offline.

---

## 14. Deployment Sequence

The recommended deployment sequence is:

**Phase 1: Schema migration (no behavior change yet)**
1. Run migration 2026_04_28_001 (add columns)
2. Run migration 2026_04_28_002 (update plan_key constraint)
3. Verify schema is correct in production
4. Deploy code that *reads* new columns but does not yet rely on them
5. Verify no errors in production for 24 hours

**Phase 2: New user lifecycle (existing users unchanged)**
1. Deploy lifecycle transition code
2. Deploy lifecycle reconciliation cron job
3. Deploy Stripe webhook updates
4. New signups now follow trial-based flow
5. Existing users still on Free/Starter/Pro unchanged
6. Verify new signups work correctly for 48 hours

**Phase 3: Existing user migration**
1. Run migration 2026_04_28_003 (grandfather existing Free users)
2. Send personal communication to grandfathered users (Scott manual)
3. Existing Starter and Pro users unchanged

**Phase 4: Reminder activation**
1. Activate trial reminder dispatch
2. Activate extension reminder dispatch
3. Activate read-only reminder dispatch
4. Monitor reminder delivery for 7 days

**Phase 5: Founding Member tier activation**
1. Configure Stripe Founding Member product
2. Enable Founding Member option in signup UI
3. Promote Founding Member tier in marketing channels (per Brand Voice v1.2 GTM Phase 3)

Each phase can pause indefinitely if issues arise. There is no required deadline.

---

## 15. Documentation Updates Required

After this migration is complete, update the following project documents:

- **04_CHIEFOS_MONETIZATION_AND_PRICING.md** — replace Free tier with trial model; add Founding Member tier; update Section 6 (upsell behavior) for new lifecycle
- **05_CHIEFOS_CREATIVE_AND_GTM_BRIEF.md** — replace Free messaging with Trial messaging (already partially done in Brand Voice v1.2)
- **06_CHIEFOS_PROJECT_INSTRUCTIONS.md** — update plan-aware decision-making notes
- **CLAUDE.md** (Claude Code session file) — update lifecycle state references
- **Customer-facing terms of service** — add Founding Member commitment terms, trial terms, read-only terms

---

## 16. Open Questions for Owner Decision

Before this migration begins, owner must decide:

1. **Grandfather period for existing Free users:** 90 days as proposed, or different? Decision impacts Section 4.4.
2. **Founding Member commitment penalty:** Forfeit slot only (proposed) or also charge a cancellation fee? Decision impacts Section 6.6.
3. **Read-only export limits:** Unlimited (proposed) or quota-restricted? Decision impacts Section 5.2.
4. **Annual prepay discount for non-Founding Member tiers:** Currently no annual discount on Starter/Pro. Add later?
5. **Enterprise tier minimum commitment:** Annual contract required, or month-to-month allowed?

These are not blockers for the spec but should be answered before implementation begins.

---

## 17. Sign-off Requirements

This migration cannot deploy to production until:

- [ ] All migrations have been tested against a copy of production
- [ ] All unit tests, integration tests, and cross-tenant isolation tests pass
- [ ] Manual end-to-end test (Section 12.5) completed by Scott
- [ ] Stripe products configured and tested in Stripe test mode
- [ ] Backup verified within past 24 hours
- [ ] Rollback procedure tested against staging
- [ ] Customer communication for grandfathered users drafted and approved
- [ ] Project documents (Section 15) updated
- [ ] Open questions (Section 16) answered

---

*End of document — Trial Migration Technical Specification v1.0*

*This document is binding on all development work touching pricing, plan resolution, billing, or user lifecycle. Subordinate to the Engineering Constitution and Monetization & Pricing doctrines. If any conflict arises, the higher-authority document governs.*
