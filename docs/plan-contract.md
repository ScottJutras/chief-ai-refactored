# ChiefOS Plan Contract (MVP)

## 1 Governing principles (non-negotiable)

These are laws, not suggestions. If a future feature violates one, it’s wrong.

### Law 1 — Plans gate convenience, not truth
- Data is never deleted.
- History is never altered.
- Limits pause premium capture and premium access — not reality.

### Law 2 — Capture ≠ Reasoning
- Crew capture reality (within plan permissions + capacities).
- Owners reason over the business.
- “Ask Chief” is a privilege, not a default.

### Law 3 — Every gate has a human explanation
No silent failures. Ever.

Every gated action must explain:
- what is paused or blocked
- why
- what plan removes the pause

### Law 4 — One object rules all
No scattered `if (plan === 'pro')` checks.
Everything flows through one capability map.

**Source of truth:** `src/config/planCapabilities.ts`

---

## 2 Marketing language (keep it premium)
Do not call them “limits” in marketing.

Use:
- **Monthly capacity**
- **Included usage**

Canonical sentence:
> Each plan includes a generous monthly capacity. If you hit it, you can keep logging — premium capture features pause until your plan resets or you upgrade.

---

## 3 Runtime behavior (how denials feel)

### When capacity is hit
- Logging continues (truth capture continues).
- Premium capture pauses:
  - OCR scanning pauses (text expense logging still works)
  - Voice capture pauses (text still works)
  - Ask Chief pauses (job totals still accessible)
  - Exports may be blocked depending on plan

Tone requirements:
- calm
- factual
- “we’ve got you”
- no urgency tricks

### When plan gates apply
- Free is owner-only (crew blocked cleanly).
- Starter allows crew (up to 10).
- Pro adds approvals, audit control, and board roles.

### Canonical examples (approved copy direction)
- “Receipt scanning is paused for this month. You can keep logging by text.”
- “Ask Chief is available on Starter and Pro. You can still log receipts, time, and jobs.”
- “Approvals require Pro. Crew logs reality. Owners approve truth.”

### Canonical upgrade language
-Pro unlocks crew self-logging — employees can clock in/out from their own phones.

Note: 
-This line must remain consistent across product, onboarding, and marketing.