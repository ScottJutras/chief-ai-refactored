-- ============================================================================
-- Foundation Rebuild — Session P3-4a, Part 1: Functions
--
-- Section 5.1 of FOUNDATION_P1_SCHEMA_DESIGN.md.
--
-- Target met: exactly 10 functions, all SECURITY INVOKER, zero SECURITY DEFINER.
-- Every function has explicit SET search_path = '' as a safety measure
-- (search-path hardening — prevents search_path shadowing attacks).
--
-- Function inventory (in dependency order for trigger-binding reasons):
--   1. chiefos_touch_updated_at()
--   2. chiefos_quotes_guard_header_immutable()
--   3. chiefos_quote_versions_guard_immutable()
--   4. chiefos_quote_line_items_guard_parent_lock()
--   5. chiefos_quote_share_tokens_guard_immutable()
--   6. chiefos_quote_signatures_guard_immutable()
--   7. chiefos_quote_events_guard_immutable()
--   8. chiefos_activity_logs_guard_immutable()
--   9. chiefos_integrity_chain_stamp()  — parameterized via TG_TABLE_NAME
--  10. chiefos_next_tenant_counter(uuid, text)
--
-- Functions 2-7 are re-authored byte-identically from the source Quotes spine
-- migrations (2026_04_18_chiefos_quotes_spine.sql / quote_events.sql /
-- quote_share_tokens.sql / quote_signatures.sql). The one deviation vs.
-- production: each now carries SET search_path = '' which was not present in
-- production. Safe addition because none of the 6 guards reference any
-- unqualified schema object — either they touch OLD/NEW only, or they fully
-- qualify references with public.<table>.
--
-- Function 9 uses core sha256() (no pgcrypto dependency). pg_catalog is
-- implicitly on search_path even when SET search_path = '' — built-in
-- functions (sha256, encode, jsonb_build_object, now, hashtextextended,
-- pg_advisory_xact_lock) resolve without qualification.
--
-- Dependencies: none at CREATE-FUNCTION time. Triggers binding these
-- functions to tables land in rebuild_triggers.sql (next file in apply order).
--
-- Idempotent: CREATE OR REPLACE FUNCTION — safe to re-run.
-- ============================================================================

BEGIN;

-- ============================================================================
-- Function 1: chiefos_touch_updated_at
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.chiefos_touch_updated_at() IS
'Sets NEW.updated_at := now() on BEFORE UPDATE. Single function, many bindings per §5.3 trigger 10.';

-- ============================================================================
-- Function 2: chiefos_quotes_guard_header_immutable
-- Re-authored byte-identically from 2026_04_18_chiefos_quotes_spine.sql (§5c)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_quotes_guard_header_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.id             IS DISTINCT FROM OLD.id             THEN RAISE EXCEPTION 'chiefos_quotes.id is immutable'; END IF;
  IF NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id      THEN RAISE EXCEPTION 'chiefos_quotes.tenant_id is immutable'; END IF;
  IF NEW.owner_id       IS DISTINCT FROM OLD.owner_id       THEN RAISE EXCEPTION 'chiefos_quotes.owner_id is immutable'; END IF;
  IF NEW.job_id         IS DISTINCT FROM OLD.job_id         THEN RAISE EXCEPTION 'chiefos_quotes.job_id is immutable'; END IF;
  IF NEW.customer_id    IS DISTINCT FROM OLD.customer_id    THEN RAISE EXCEPTION 'chiefos_quotes.customer_id is immutable'; END IF;
  IF NEW.human_id       IS DISTINCT FROM OLD.human_id       THEN RAISE EXCEPTION 'chiefos_quotes.human_id is immutable'; END IF;
  IF NEW.source         IS DISTINCT FROM OLD.source         THEN RAISE EXCEPTION 'chiefos_quotes.source is immutable'; END IF;
  IF NEW.source_msg_id  IS DISTINCT FROM OLD.source_msg_id  THEN RAISE EXCEPTION 'chiefos_quotes.source_msg_id is immutable'; END IF;
  IF NEW.created_at     IS DISTINCT FROM OLD.created_at     THEN RAISE EXCEPTION 'chiefos_quotes.created_at is immutable'; END IF;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- Function 3: chiefos_quote_versions_guard_immutable
-- Re-authored byte-identically from 2026_04_18_chiefos_quotes_spine.sql (§5a)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_quote_versions_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION
        'chiefos_quote_versions: row % is locked at %; updates are forbidden (constitutional immutability)',
        OLD.id, OLD.locked_at
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.locked_at IS NULL AND OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'chiefos_quote_versions: locked_at cannot be cleared once set'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION
        'chiefos_quote_versions: row % is locked at %; deletes are forbidden',
        OLD.id, OLD.locked_at
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$function$;

-- ============================================================================
-- Function 4: chiefos_quote_line_items_guard_parent_lock
-- Re-authored byte-identically from 2026_04_18_chiefos_quotes_spine.sql (§5b)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_quote_line_items_guard_parent_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  parent_locked_at timestamptz;
  parent_version_id uuid;
BEGIN
  parent_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_version_id ELSE NEW.quote_version_id END;

  SELECT locked_at INTO parent_locked_at
  FROM public.chiefos_quote_versions
  WHERE id = parent_version_id;

  IF parent_locked_at IS NOT NULL THEN
    RAISE EXCEPTION
      'chiefos_quote_line_items: parent version % is locked at %; % is forbidden',
      parent_version_id, parent_locked_at, TG_OP
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- Function 5: chiefos_quote_share_tokens_guard_immutable
-- Re-authored byte-identically from 2026_04_18_chiefos_quote_share_tokens.sql (§4)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_quote_share_tokens_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chiefos_quote_share_tokens: rows are append-only post-insert; DELETE forbidden (id %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Strictly immutable columns.
  IF NEW.id                         IS DISTINCT FROM OLD.id                         THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.id is immutable'; END IF;
  IF NEW.tenant_id                  IS DISTINCT FROM OLD.tenant_id                  THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.tenant_id is immutable'; END IF;
  IF NEW.owner_id                   IS DISTINCT FROM OLD.owner_id                   THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.owner_id is immutable'; END IF;
  IF NEW.quote_version_id           IS DISTINCT FROM OLD.quote_version_id           THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.quote_version_id is immutable'; END IF;
  IF NEW.token                      IS DISTINCT FROM OLD.token                      THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.token is immutable'; END IF;
  IF NEW.recipient_name             IS DISTINCT FROM OLD.recipient_name             THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.recipient_name is immutable'; END IF;
  IF NEW.recipient_channel          IS DISTINCT FROM OLD.recipient_channel          THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.recipient_channel is immutable'; END IF;
  IF NEW.recipient_address          IS DISTINCT FROM OLD.recipient_address          THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.recipient_address is immutable'; END IF;
  IF NEW.recipient_metadata         IS DISTINCT FROM OLD.recipient_metadata         THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.recipient_metadata is immutable'; END IF;
  IF NEW.issued_at                  IS DISTINCT FROM OLD.issued_at                  THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.issued_at is immutable'; END IF;
  IF NEW.absolute_expires_at        IS DISTINCT FROM OLD.absolute_expires_at        THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.absolute_expires_at is immutable'; END IF;
  IF NEW.source_msg_id              IS DISTINCT FROM OLD.source_msg_id              THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.source_msg_id is immutable'; END IF;
  IF NEW.created_at                 IS DISTINCT FROM OLD.created_at                 THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.created_at is immutable'; END IF;

  -- Fill-once columns: NULL → value permitted; value → anything else forbidden.
  IF OLD.revoked_at IS NOT NULL
     AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'chiefos_quote_share_tokens.revoked_at can be set once (NULL->value); further changes forbidden';
  END IF;
  IF OLD.revoked_reason IS NOT NULL
     AND NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason THEN
    RAISE EXCEPTION 'chiefos_quote_share_tokens.revoked_reason can be set once (NULL->value); further changes forbidden';
  END IF;
  IF OLD.superseded_at IS NOT NULL
     AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'chiefos_quote_share_tokens.superseded_at can be set once (NULL->value); further changes forbidden';
  END IF;
  IF OLD.superseded_by_version_id IS NOT NULL
     AND NEW.superseded_by_version_id IS DISTINCT FROM OLD.superseded_by_version_id THEN
    RAISE EXCEPTION 'chiefos_quote_share_tokens.superseded_by_version_id can be set once (NULL->value); further changes forbidden';
  END IF;

  RETURN NEW;
END;
$function$;

-- ============================================================================
-- Function 6: chiefos_quote_signatures_guard_immutable
-- Re-authored byte-identically from 2026_04_18_chiefos_quote_signatures.sql (§5)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_quote_signatures_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chiefos_quote_signatures: rows are append-only post-insert; DELETE forbidden (id %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every column is immutable. No fill-once exemptions.
  IF NEW.id                          IS DISTINCT FROM OLD.id                          THEN RAISE EXCEPTION 'chiefos_quote_signatures.id is immutable'; END IF;
  IF NEW.quote_version_id            IS DISTINCT FROM OLD.quote_version_id            THEN RAISE EXCEPTION 'chiefos_quote_signatures.quote_version_id is immutable'; END IF;
  IF NEW.tenant_id                   IS DISTINCT FROM OLD.tenant_id                   THEN RAISE EXCEPTION 'chiefos_quote_signatures.tenant_id is immutable'; END IF;
  IF NEW.owner_id                    IS DISTINCT FROM OLD.owner_id                    THEN RAISE EXCEPTION 'chiefos_quote_signatures.owner_id is immutable'; END IF;
  IF NEW.signed_event_id             IS DISTINCT FROM OLD.signed_event_id             THEN RAISE EXCEPTION 'chiefos_quote_signatures.signed_event_id is immutable'; END IF;
  IF NEW.share_token_id              IS DISTINCT FROM OLD.share_token_id              THEN RAISE EXCEPTION 'chiefos_quote_signatures.share_token_id is immutable'; END IF;
  IF NEW.signer_name                 IS DISTINCT FROM OLD.signer_name                 THEN RAISE EXCEPTION 'chiefos_quote_signatures.signer_name is immutable'; END IF;
  IF NEW.signer_email                IS DISTINCT FROM OLD.signer_email                THEN RAISE EXCEPTION 'chiefos_quote_signatures.signer_email is immutable'; END IF;
  IF NEW.signer_ip                   IS DISTINCT FROM OLD.signer_ip                   THEN RAISE EXCEPTION 'chiefos_quote_signatures.signer_ip is immutable'; END IF;
  IF NEW.signer_user_agent           IS DISTINCT FROM OLD.signer_user_agent           THEN RAISE EXCEPTION 'chiefos_quote_signatures.signer_user_agent is immutable'; END IF;
  IF NEW.signed_at                   IS DISTINCT FROM OLD.signed_at                   THEN RAISE EXCEPTION 'chiefos_quote_signatures.signed_at is immutable'; END IF;
  IF NEW.signature_png_storage_key   IS DISTINCT FROM OLD.signature_png_storage_key   THEN RAISE EXCEPTION 'chiefos_quote_signatures.signature_png_storage_key is immutable'; END IF;
  IF NEW.signature_png_sha256        IS DISTINCT FROM OLD.signature_png_sha256        THEN RAISE EXCEPTION 'chiefos_quote_signatures.signature_png_sha256 is immutable'; END IF;
  IF NEW.version_hash_at_sign        IS DISTINCT FROM OLD.version_hash_at_sign        THEN RAISE EXCEPTION 'chiefos_quote_signatures.version_hash_at_sign is immutable'; END IF;
  IF NEW.name_match_at_sign          IS DISTINCT FROM OLD.name_match_at_sign          THEN RAISE EXCEPTION 'chiefos_quote_signatures.name_match_at_sign is immutable'; END IF;
  IF NEW.recipient_name_at_sign      IS DISTINCT FROM OLD.recipient_name_at_sign      THEN RAISE EXCEPTION 'chiefos_quote_signatures.recipient_name_at_sign is immutable'; END IF;
  IF NEW.source_msg_id               IS DISTINCT FROM OLD.source_msg_id               THEN RAISE EXCEPTION 'chiefos_quote_signatures.source_msg_id is immutable'; END IF;
  IF NEW.created_at                  IS DISTINCT FROM OLD.created_at                  THEN RAISE EXCEPTION 'chiefos_quote_signatures.created_at is immutable'; END IF;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- Function 7: chiefos_quote_events_guard_immutable
-- Re-authored byte-identically from 2026_04_18_chiefos_quote_events.sql (§5)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_quote_events_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chiefos_quote_events: rows are append-only; DELETE forbidden (row id %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- UPDATE: every column immutable EXCEPT prev_event_hash and
  -- triggered_by_event_id, and those may only transition NULL → value once.
  IF NEW.id                    IS DISTINCT FROM OLD.id                    THEN RAISE EXCEPTION 'chiefos_quote_events.id is immutable'; END IF;
  IF NEW.global_seq            IS DISTINCT FROM OLD.global_seq            THEN RAISE EXCEPTION 'chiefos_quote_events.global_seq is immutable'; END IF;
  IF NEW.tenant_id             IS DISTINCT FROM OLD.tenant_id             THEN RAISE EXCEPTION 'chiefos_quote_events.tenant_id is immutable'; END IF;
  IF NEW.owner_id              IS DISTINCT FROM OLD.owner_id              THEN RAISE EXCEPTION 'chiefos_quote_events.owner_id is immutable'; END IF;
  IF NEW.quote_id              IS DISTINCT FROM OLD.quote_id              THEN RAISE EXCEPTION 'chiefos_quote_events.quote_id is immutable'; END IF;
  IF NEW.quote_version_id      IS DISTINCT FROM OLD.quote_version_id      THEN RAISE EXCEPTION 'chiefos_quote_events.quote_version_id is immutable'; END IF;
  IF NEW.kind                  IS DISTINCT FROM OLD.kind                  THEN RAISE EXCEPTION 'chiefos_quote_events.kind is immutable'; END IF;
  IF NEW.signature_id          IS DISTINCT FROM OLD.signature_id          THEN RAISE EXCEPTION 'chiefos_quote_events.signature_id is immutable'; END IF;
  IF NEW.share_token_id        IS DISTINCT FROM OLD.share_token_id        THEN RAISE EXCEPTION 'chiefos_quote_events.share_token_id is immutable'; END IF;
  IF NEW.customer_id           IS DISTINCT FROM OLD.customer_id           THEN RAISE EXCEPTION 'chiefos_quote_events.customer_id is immutable'; END IF;
  IF NEW.payload               IS DISTINCT FROM OLD.payload               THEN RAISE EXCEPTION 'chiefos_quote_events.payload is immutable'; END IF;
  IF NEW.actor_user_id         IS DISTINCT FROM OLD.actor_user_id         THEN RAISE EXCEPTION 'chiefos_quote_events.actor_user_id is immutable'; END IF;
  IF NEW.actor_source          IS DISTINCT FROM OLD.actor_source          THEN RAISE EXCEPTION 'chiefos_quote_events.actor_source is immutable'; END IF;
  IF NEW.correlation_id        IS DISTINCT FROM OLD.correlation_id        THEN RAISE EXCEPTION 'chiefos_quote_events.correlation_id is immutable'; END IF;
  IF NEW.external_event_id     IS DISTINCT FROM OLD.external_event_id     THEN RAISE EXCEPTION 'chiefos_quote_events.external_event_id is immutable'; END IF;
  IF NEW.emitted_at            IS DISTINCT FROM OLD.emitted_at            THEN RAISE EXCEPTION 'chiefos_quote_events.emitted_at is immutable'; END IF;
  IF NEW.created_at            IS DISTINCT FROM OLD.created_at            THEN RAISE EXCEPTION 'chiefos_quote_events.created_at is immutable'; END IF;

  -- prev_event_hash: NULL → value once; any other transition forbidden.
  IF OLD.prev_event_hash IS NOT NULL
     AND NEW.prev_event_hash IS DISTINCT FROM OLD.prev_event_hash THEN
    RAISE EXCEPTION 'chiefos_quote_events.prev_event_hash can be set once (NULL→value); further changes forbidden';
  END IF;

  -- triggered_by_event_id: NULL → value once; any other transition forbidden.
  IF OLD.triggered_by_event_id IS NOT NULL
     AND NEW.triggered_by_event_id IS DISTINCT FROM OLD.triggered_by_event_id THEN
    RAISE EXCEPTION 'chiefos_quote_events.triggered_by_event_id can be set once (NULL→value); further changes forbidden';
  END IF;

  RETURN NEW;
END;
$function$;

-- ============================================================================
-- Function 8: chiefos_activity_logs_guard_immutable
-- Append-only enforcement on chiefos_activity_logs (§3.11 design page).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_activity_logs_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'chiefos_activity_logs is append-only; % is not permitted', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- Function 9: chiefos_integrity_chain_stamp
-- Decision 10 integrity chain for public.transactions and public.time_entries_v2.
-- Parameterized via TG_TABLE_NAME. SECURITY INVOKER. Per-tenant advisory lock.
-- Uses core sha256() — no pgcrypto dependency.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_integrity_chain_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_previous_hash    text;
  v_canonical_input  jsonb;
  v_table_name       text;
  v_lock_key         bigint;
BEGIN
  v_table_name := TG_TABLE_NAME;

  -- Per-tenant advisory lock (transaction-scoped). Hash the (table, tenant)
  -- pair to a bigint so pg_advisory_xact_lock can key on it.
  v_lock_key := hashtextextended(v_table_name || '::' || NEW.tenant_id::text, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Fetch previous_hash = most-recent committed record_hash for this tenant
  -- in this table. Dynamic table name requires a branch (we avoid EXECUTE
  -- to preserve the SECURITY INVOKER + SET search_path hardening stance).
  IF v_table_name = 'transactions' THEN
    SELECT record_hash INTO v_previous_hash
    FROM public.transactions
    WHERE tenant_id = NEW.tenant_id
      AND record_hash IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
  ELSIF v_table_name = 'time_entries_v2' THEN
    SELECT record_hash INTO v_previous_hash
    FROM public.time_entries_v2
    WHERE tenant_id = NEW.tenant_id
      AND record_hash IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
  ELSE
    RAISE EXCEPTION 'chiefos_integrity_chain_stamp bound to unsupported table: %', v_table_name
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- Build canonical input: deterministic jsonb. Include only fields stable
  -- across the row's lifetime. COALESCE previous_hash to '' so chain-root
  -- rows (first row per tenant) produce a well-defined hash input.
  IF v_table_name = 'transactions' THEN
    v_canonical_input := jsonb_build_object(
      'id', NEW.id,
      'tenant_id', NEW.tenant_id,
      'owner_id', NEW.owner_id,
      'kind', NEW.kind,
      'amount_cents', NEW.amount_cents,
      'currency', NEW.currency,
      'date', NEW.date,
      'source', NEW.source,
      'source_msg_id', NEW.source_msg_id,
      'created_at', NEW.created_at,
      'previous_hash', COALESCE(v_previous_hash, '')
    );
  ELSIF v_table_name = 'time_entries_v2' THEN
    v_canonical_input := jsonb_build_object(
      'id', NEW.id,
      'tenant_id', NEW.tenant_id,
      'owner_id', NEW.owner_id,
      'user_id', NEW.user_id,
      'kind', NEW.kind,
      'start_at_utc', NEW.start_at_utc,
      'end_at_utc', NEW.end_at_utc,
      'source_msg_id', NEW.source_msg_id,
      'created_at', NEW.created_at,
      'previous_hash', COALESCE(v_previous_hash, '')
    );
  END IF;

  -- Stamp chain columns on NEW. sha256() is in pg_catalog (always on
  -- search_path even when SET search_path = '').
  NEW.previous_hash       := v_previous_hash;
  NEW.hash_input_snapshot := v_canonical_input;
  NEW.record_hash         := encode(sha256(v_canonical_input::text::bytea), 'hex');
  NEW.hash_version        := 1;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.chiefos_integrity_chain_stamp() IS
'Per-tenant integrity hash chain (Decision 10). Advisory-lock-serialized per (table, tenant). Bound to BEFORE INSERT on transactions and time_entries_v2. If production load testing reveals contention, the alternative approach is a chain-head table with FOR UPDATE locking — see FOUNDATION_P1_SCHEMA_DESIGN.md §5.1 function 9 for the escape-hatch design.';

-- ============================================================================
-- Function 10: chiefos_next_tenant_counter
-- Atomic per-(tenant, kind) counter allocation. UPSERT with RETURNING.
-- Used by: jobs.job_no, tasks.task_no, chiefos_quotes.human_id (via 'quote'),
-- and any future numbered surface.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_next_tenant_counter(
  p_tenant_id      uuid,
  p_counter_kind   text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_next_no integer;
BEGIN
  INSERT INTO public.chiefos_tenant_counters (tenant_id, counter_kind, next_no)
  VALUES (p_tenant_id, p_counter_kind, 1)
  ON CONFLICT (tenant_id, counter_kind)
  DO UPDATE SET next_no = public.chiefos_tenant_counters.next_no + 1,
                updated_at = now()
  RETURNING next_no INTO v_next_no;

  RETURN v_next_no;
END;
$function$;

COMMENT ON FUNCTION public.chiefos_next_tenant_counter(uuid, text) IS
'Atomic increment of chiefos_tenant_counters.next_no for (tenant_id, counter_kind). UPSERT pattern. SECURITY INVOKER. Caller must have INSERT+UPDATE on chiefos_tenant_counters (service_role typically); no privilege escalation.';

-- ============================================================================
-- GRANT EXECUTE posture
-- SECURITY INVOKER + public-schema functions. Grant EXECUTE to roles that
-- need to call them. Trigger functions (1-9) don't need EXECUTE grants
-- because triggers run with the invoking session's privileges regardless.
-- Only the callable helper function (10) needs an explicit grant.
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.chiefos_next_tenant_counter(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chiefos_next_tenant_counter(uuid, text) TO service_role;

COMMIT;
