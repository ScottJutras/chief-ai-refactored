-- Migration: 2026_04_29_phase1_prb_acquisition_events_and_landing_events.sql
--
-- PHASE 1 PR-B: TMTS v1.1 §5.4 funnel telemetry — split into two tables.
--
-- Closes Phase 1 PR-B scope:
--   - landing_events: pre-signup anonymous funnel (no tenant_id)
--   - acquisition_events: post-signup tenant-scoped funnel (tenant_id NOT NULL FK)
--
-- NOT applied to production by this PR — authoring only.
--
-- ============================================================================
-- DECISIONS LOCKED PER PHASE 1 RECON + OWNER SIGN-OFF (2026-04-29):
--
-- 1. TWO TABLES, NOT ONE.
--    Pre-signup events fire before any chiefos_tenants row exists. v1.1 spec
--    literal §5.4 wraps them in the same table as post-signup events with
--    `user_id UUID REFERENCES public.users(id) ON DELETE CASCADE`. Two
--    structural problems:
--      a) public.users has NO `id` column (PK is `user_id` text). The FK
--         literally does not compile.
--      b) Pre-signup events would either need NULL tenant FK (orphan rows
--         with no useful attribution surface) or a tenant must be created
--         before the form is submitted (impossible — the form CREATES the
--         tenant).
--    Solution: pre-signup → landing_events (no tenant_id, no RLS, anonymous
--    funnel). Post-signup → acquisition_events (tenant_id NOT NULL FK to
--    chiefos_tenants(id) ON DELETE CASCADE, RLS enabled).
--
-- 2. EVENT TYPE REDISTRIBUTION (v1.1 §5.4 9-value enum split):
--    landing_events.event_type CHECK:
--      - landing_page_viewed
--      - landing_page_form_submitted
--      - whatsapp_deep_link_clicked
--    acquisition_events.event_type CHECK:
--      - first_whatsapp_message_sent
--      - first_portal_login
--      - first_capture
--      - first_job_created
--      - first_ask_chief_question
--      - paid_conversion
--
-- 3. BRIDGE: anonymous_session_id on BOTH tables.
--    Allows end-to-end funnel queries via UNION ALL on session ID, without
--    requiring tenant lookup for pre-signup steps.
--
-- 4. RLS scope: acquisition_events SELECT scoped to chiefos_portal_users
--    membership (tenant_id IN (SELECT tenant_id WHERE user_id = auth.uid())).
--    No INSERT policy — INSERTs occur via SECURITY DEFINER functions or
--    service-role contexts (future event-logging RPCs / cron / webhook
--    handlers). Portal users do not insert events directly.
--
-- 5. Spec amendment: §5.4 rewritten to reflect the two-table split, FK
--    target correction, NOT NULL discipline, RLS policy. Rides alongside
--    this migration in the same PR (PR #9 / PR #10 / PR #12 precedent).
--
-- ============================================================================
-- WHAT IS NOT CHANGED:
--   - public.users, public.chiefos_tenants, public.chiefos_portal_users
--     untouched
--   - No application code modifications (event-logging RPCs are a
--     subsequent workstream)
--   - No RPC amendments (chiefos_finish_signup unchanged from P1A-14)
--
-- ============================================================================
-- ROLLBACK:
--   migrations/rollbacks/2026_04_29_phase1_prb_acquisition_events_and_landing_events_rollback.sql
--   drops both tables (CASCADE handles indexes, RLS, FK, policies).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Preflight assertions
-- ----------------------------------------------------------------------------
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'public.chiefos_tenants missing — apply prior migrations first';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='chiefos_tenants'
                   AND column_name='id' AND data_type='uuid') THEN
    RAISE EXCEPTION 'chiefos_tenants.id missing or wrong type — FK target invalid';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public'
               AND table_name IN ('landing_events','acquisition_events')) THEN
    RAISE EXCEPTION 'landing_events or acquisition_events already exists — apply rollback first if re-running';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users') THEN
    RAISE EXCEPTION 'chiefos_portal_users missing — RLS policy depends on this table';
  END IF;

  RAISE NOTICE 'Preflight assertions passed.';
END
$preflight$;

-- ----------------------------------------------------------------------------
-- 1. landing_events: pre-signup funnel (anonymous, no tenant)
-- ----------------------------------------------------------------------------
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

-- landing_events: NO RLS. Service-role only access by Supabase default
-- (anon/authenticated have no GRANTs without explicit policy). Anonymous
-- funnel data must not be readable by portal users — they have no tenant
-- attribution at this stage anyway.

COMMENT ON TABLE public.landing_events IS
  'Pre-signup anonymous funnel events: landing page views, form submissions, '
  'WhatsApp deep link clicks. No tenant_id required because tenant does not '
  'exist yet at capture time. Service-role only; no RLS policy. Joined to '
  'acquisition_events post-signup via anonymous_session_id when attribution '
  'is needed (UNION ALL on session ID).';

COMMENT ON COLUMN public.landing_events.anonymous_session_id IS
  'Opaque session identifier from landing page (e.g., cookie-based ID). '
  'Used to correlate pre-signup events to a single anonymous visitor, and '
  'to bridge to acquisition_events post-signup if the visitor converts.';

COMMENT ON COLUMN public.landing_events.event_data IS
  'Event-specific payload (JSONB). Examples: business_name on '
  'landing_page_form_submitted; referrer on landing_page_viewed.';

-- ----------------------------------------------------------------------------
-- 2. acquisition_events: post-signup funnel (tenant-scoped)
-- ----------------------------------------------------------------------------
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
  anonymous_session_id TEXT,
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
-- Composite index supports the most common query: "what events happened
-- for this tenant in chronological order, optionally filtered by event_type"

-- RLS for acquisition_events
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

-- No INSERT/UPDATE/DELETE policy. Writes happen via SECURITY DEFINER
-- functions or service-role contexts (event-logging RPCs, cron jobs,
-- webhook handlers). Portal users cannot insert events directly.

COMMENT ON TABLE public.acquisition_events IS
  'Post-signup tenant-scoped funnel events: from first_whatsapp_message_sent '
  'through paid_conversion. tenant_id NOT NULL because the tenant exists by '
  'the time these fire. RLS scoped to chiefos_portal_users membership. '
  'INSERTs occur via SECURITY DEFINER functions, not direct portal writes. '
  'Pre-signup events live in landing_events (separate table, no tenant).';

COMMENT ON COLUMN public.acquisition_events.tenant_id IS
  'Per-business attribution. ON DELETE CASCADE — when a tenant is hard-deleted, '
  'its acquisition events are removed. (Soft-deletion via lifecycle_state=archived '
  'preserves these rows; hard deletion only happens after data_deletion_eligible_at.)';

COMMENT ON COLUMN public.acquisition_events.anonymous_session_id IS
  'If signup was attributed to a landing_events session, this carries the '
  'same session ID forward, enabling end-to-end funnel queries from '
  'landing_page_viewed → paid_conversion via UNION ALL on this column.';

COMMENT ON COLUMN public.acquisition_events.event_data IS
  'Event-specific payload (JSONB). Examples: stripe_subscription_id and plan_key '
  'on paid_conversion; trial_ends_at on first_whatsapp_message_sent.';

-- ----------------------------------------------------------------------------
-- 3. Sanity assertion
-- ----------------------------------------------------------------------------
DO $assert$
DECLARE
  v_landing_cols     int;
  v_acq_cols         int;
  v_landing_indexes  int;
  v_acq_indexes      int;
  v_acq_rls_enabled  bool;
  v_acq_select_pol   int;
  v_acq_fk_count     int;
BEGIN
  SELECT COUNT(*) INTO v_landing_cols
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='landing_events';

  SELECT COUNT(*) INTO v_acq_cols
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='acquisition_events';

  SELECT COUNT(*) INTO v_landing_indexes
  FROM pg_indexes
  WHERE schemaname='public' AND tablename='landing_events';

  SELECT COUNT(*) INTO v_acq_indexes
  FROM pg_indexes
  WHERE schemaname='public' AND tablename='acquisition_events';

  SELECT relrowsecurity INTO v_acq_rls_enabled
  FROM pg_class
  WHERE oid='public.acquisition_events'::regclass;

  SELECT COUNT(*) INTO v_acq_select_pol
  FROM pg_policies
  WHERE schemaname='public' AND tablename='acquisition_events' AND cmd='SELECT';

  SELECT COUNT(*) INTO v_acq_fk_count
  FROM pg_constraint
  WHERE conrelid='public.acquisition_events'::regclass AND contype='f';

  IF v_landing_cols <> 8 THEN
    RAISE EXCEPTION 'landing_events column count expected 8, found %', v_landing_cols;
  END IF;
  IF v_acq_cols <> 9 THEN
    RAISE EXCEPTION 'acquisition_events column count expected 9, found %', v_acq_cols;
  END IF;
  IF v_landing_indexes <> 4 THEN
    RAISE EXCEPTION 'landing_events index count expected 4 (PK + 3), found %', v_landing_indexes;
  END IF;
  IF v_acq_indexes <> 5 THEN
    RAISE EXCEPTION 'acquisition_events index count expected 5 (PK + 4), found %', v_acq_indexes;
  END IF;
  IF NOT v_acq_rls_enabled THEN
    RAISE EXCEPTION 'acquisition_events RLS not enabled';
  END IF;
  IF v_acq_select_pol <> 1 THEN
    RAISE EXCEPTION 'acquisition_events SELECT policy count expected 1, found %', v_acq_select_pol;
  END IF;
  IF v_acq_fk_count <> 1 THEN
    RAISE EXCEPTION 'acquisition_events FK count expected 1 (tenant_id), found %', v_acq_fk_count;
  END IF;

  RAISE NOTICE 'Phase 1 PR-B: landing_events (% cols, % indexes), acquisition_events (% cols, % indexes, RLS=%, % SELECT policy, % FK).',
    v_landing_cols, v_landing_indexes, v_acq_cols, v_acq_indexes, v_acq_rls_enabled, v_acq_select_pol, v_acq_fk_count;
END
$assert$;

COMMIT;
