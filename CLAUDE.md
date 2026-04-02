# ChiefOS — Claude Code Instructions

## Project Overview

ChiefOS is a business management platform for contractors and tradespeople. It handles job tracking, expense/receipt logging (with AI-powered OCR), overhead management, revenue tracking, labour hours, and an AI assistant called "Ask Chief".

This repo (`chief-ai-refactored`) is the **root repository**. It contains the Node.js AI backend and has `chiefos-site` as a **git submodule**.

---

## Repository Structure

```
Chief/                        ← root repo (chief-ai-refactored on GitHub)
├── chiefos-site/             ← git submodule (chiefos-site on GitHub)
│   ├── app/                  ← Next.js App Router pages and API routes
│   │   ├── app/              ← frontend pages (/app/jobs, /app/uploads, etc.)
│   │   └── api/              ← server-side API routes
│   ├── lib/                  ← shared utilities and server-only helpers
│   └── package.json
├── services/agent/index.js   ← Chief AI agent (OpenAI tool-calling loop)
├── routes/                   ← Express API routes
├── handlers/                 ← Business logic handlers
├── migrations/               ← Supabase SQL migrations
└── vercel.json               ← Vercel config for the AI backend
```

---

## Tech Stack

### chiefos-site (frontend + Next.js API)
- **Framework**: Next.js 16, App Router, React 19
- **Language**: TypeScript (strict-ish — null checks may not always be enforced)
- **Styling**: Tailwind CSS v4
- **Database client**: `@supabase/supabase-js` v2
- **OCR**: Google Document AI (not functional on Vercel — no ADC). Falls back to **OpenAI GPT-4o vision** (`OPENAI_API_KEY`)
- **Deployment**: Vercel (auto-deploys on push to `main`)

### Root backend (chief-ai-refactored)
- **Runtime**: Node.js 22
- **AI**: OpenAI GPT-4o via tool-calling agent loop (`services/agent/index.js`)
- **Deployment**: Vercel serverless (`vercel.json`)

### Database
- **Supabase** — project: `xnmsjdummnnistzcxrtj` (region: us-east-2)
- Auth: Supabase Auth + `chiefos_portal_users` table for tenant membership
- Multi-tenant: every query must be scoped to `tenant_id`

---

## Git Workflow

`chiefos-site` is a submodule. **Always commit in this order:**

```bash
# 1. Commit changes inside the submodule first
cd chiefos-site
git add <files>
git commit -m "..."
git push origin main

# 2. Then update the root repo's submodule pointer
cd ..
git add chiefos-site
git commit -m "Update chiefos-site: ..."
git push origin main
```

Never commit chiefos-site changes directly from the root — the submodule SHA must be updated separately.

---

## Key Patterns

### Auth + Tenant Context
All API routes use a consistent pattern:
```ts
// 1. Extract bearer token from Authorization header
// 2. Verify with admin Supabase client (service role key)
// 3. Look up chiefos_portal_users to get tenant_id and role
// 4. Look up chiefos_tenants to get owner_id
// 5. Scope all DB queries to tenant_id
```
Use `requirePortalUser()` factory (not middleware) where available.

### Admin Supabase Client
Server-side routes use `SUPABASE_SERVICE_ROLE_KEY` — never expose this to the client.
Client-side uses the `supabase` singleton from `@/lib/supabase` (anon key).

### Environment Variables
- `NEXT_PUBLIC_SUPABASE_URL` — public, used client + server
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — public
- `SUPABASE_SERVICE_ROLE_KEY` — server only (never `NEXT_PUBLIC_`)
- `OPENAI_API_KEY` — server only, used for GPT-4o vision OCR and Ask Chief
- `GOOGLE_DOCUMENT_AI_PROJECT_ID` / `GOOGLE_DOCUMENT_AI_RECEIPT_PROCESSOR_ID` — not functional on Vercel (no ADC credentials), vision fallback handles this

### Receipt / Intake Pipeline
1. `POST /api/intake/upload` — uploads file to Supabase storage, creates `intake_items` record
2. `POST /api/intake/process` — downloads file, tries Document AI OCR → falls back to GPT-4o vision, extracts fields, creates `intake_item_drafts`
3. `GET /api/intake/items?batchId=...` — fetches items for review UI
4. `POST /api/intake/items/[id]/confirm` — confirms draft, writes to expenses/revenue tables

Duplicate detection: only items with `status IN ('confirmed', 'persisted')` count as true duplicates. Skipped/deleted items do not block re-upload.

### Navigation
- `/app/uploads` — combined Log & Review page (tab=log | tab=review)
- `/app/pending-review` — redirects to `/app/uploads?tab=review`
- Sidebar + MobileNav show a combined badge: pending intake items + overdue overhead

---

## Coding Conventions

- Prefer editing existing files over creating new ones
- Keep API routes self-contained (auth, validation, business logic all in route file)
- CSS hiding pattern for persistent tab state: `className={tab === "log" ? "" : "hidden"}` (not conditional rendering)
- `export const maxDuration = 45` on any route that calls external AI APIs
- All money stored as **cents** (integer) in the database
- Dates stored as ISO strings; timezone from `chiefos_portal_users.tz` (default `America/Toronto`)

---

## Common Gotchas

- **Google Document AI** does not work on Vercel serverless — no Application Default Credentials. Always ensure GPT-4o vision fallback is in place.
- **`mustEnv()`** throws if an env var is missing — this is caught and triggers the vision fallback, not a crash.
- **Submodule commits**: forgetting to update the root repo pointer after pushing chiefos-site means Vercel deploys the old version.
- **`useSearchParams()`** in Next.js App Router requires a `<Suspense>` boundary around the component.
- **Duplicate `const` declarations** inside the same function scope will crash the Lambda on startup (`SyntaxError`) — caught in `services/agent/index.js` previously.
