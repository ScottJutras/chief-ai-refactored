-- Rollback for 2026_04_21_rebuild_quotes_spine.sql
-- Drops views, policies, tables in reverse dependency order.
-- Safe to re-run (IF EXISTS everywhere).
--
-- Ordering rationale:
--   - Views (chiefos_all_signatures_v, chiefos_all_events_v) depend on
--     chiefos_quote_signatures and chiefos_quote_events; drop first.
--   - chiefos_quote_events has composite FKs to chiefos_quote_signatures +
--     chiefos_quote_share_tokens (via inline FKs in the re-author). Drop
--     events BEFORE signatures or share_tokens so FK drops cascade cleanly.
--   - Actually events FKs to signatures; but signatures also FKs to events
--     (chiefos_qs_signed_event_identity_fk). That's a cycle in this re-author.
--     Resolve by dropping the signatures→events FK explicitly first, then
--     dropping tables in forward order is safe.
--   - chiefos_quote_signatures FKs to chiefos_quote_versions +
--     chiefos_quote_share_tokens. Drop signatures before those.
--   - chiefos_quote_share_tokens FKs to chiefos_quote_versions. Drop before.
--   - chiefos_quote_line_items FKs to chiefos_quote_versions. Drop before.
--   - chiefos_quote_versions FKs to chiefos_quotes. Drop before.
--   - chiefos_quotes has a deferred FK to chiefos_quote_versions
--     (current_version_id). Drop that FK explicitly first.
--   - chiefos_events_global_seq sequence is referenced by events.global_seq
--     DEFAULT; drop after events.
--
-- Views and sequences do not need REVOKE because their privileges drop with them.
-- GRANTs on tables don't need explicit REVOKE either (DROP TABLE cascades);
-- kept as explicit steps only where the grant would outlive the table.

BEGIN;

-- Drop views first
DROP VIEW IF EXISTS public.chiefos_all_signatures_v;
DROP VIEW IF EXISTS public.chiefos_all_events_v;

-- Break the chiefos_quote_signatures ↔ chiefos_quote_events cycle:
-- drop the signatures → events FK so events can be dropped.
ALTER TABLE IF EXISTS public.chiefos_quote_signatures
  DROP CONSTRAINT IF EXISTS chiefos_qs_signed_event_identity_fk;

-- Drop the header's deferred FK to versions (break the
-- chiefos_quotes ↔ chiefos_quote_versions cycle).
ALTER TABLE IF EXISTS public.chiefos_quotes
  DROP CONSTRAINT IF EXISTS chiefos_quotes_current_version_fk;

-- Drop policies (auditable explicit DROPs; DROP TABLE would cascade)
DROP POLICY IF EXISTS chiefos_qs_tenant_read  ON public.chiefos_quote_signatures;
DROP POLICY IF EXISTS chiefos_qst_tenant_read ON public.chiefos_quote_share_tokens;
DROP POLICY IF EXISTS chiefos_qe_tenant_read  ON public.chiefos_quote_events;
DROP POLICY IF EXISTS chiefos_qli_tenant_read ON public.chiefos_quote_line_items;
DROP POLICY IF EXISTS chiefos_qv_tenant_read  ON public.chiefos_quote_versions;
DROP POLICY IF EXISTS chiefos_quotes_tenant_update ON public.chiefos_quotes;
DROP POLICY IF EXISTS chiefos_quotes_tenant_write  ON public.chiefos_quotes;
DROP POLICY IF EXISTS chiefos_quotes_tenant_read   ON public.chiefos_quotes;

-- Drop indexes (explicit; DROP TABLE cascades but this is auditable)
DROP INDEX IF EXISTS public.chiefos_qs_share_token_idx;
DROP INDEX IF EXISTS public.chiefos_qs_event_idx;
DROP INDEX IF EXISTS public.chiefos_qs_version_idx;
DROP INDEX IF EXISTS public.chiefos_qs_owner_signed_idx;
DROP INDEX IF EXISTS public.chiefos_qs_tenant_signed_idx;
DROP INDEX IF EXISTS public.chiefos_qs_source_msg_unique;

DROP INDEX IF EXISTS public.chiefos_qe_payload_gin;
DROP INDEX IF EXISTS public.chiefos_qe_correlation_idx;
DROP INDEX IF EXISTS public.chiefos_qe_triggered_by_idx;
DROP INDEX IF EXISTS public.chiefos_qe_customer_idx;
DROP INDEX IF EXISTS public.chiefos_qe_share_token_idx;
DROP INDEX IF EXISTS public.chiefos_qe_signature_idx;
DROP INDEX IF EXISTS public.chiefos_qe_emitted_at_idx;
DROP INDEX IF EXISTS public.chiefos_qe_tenant_kind_idx;
DROP INDEX IF EXISTS public.chiefos_qe_tenant_category_idx;
DROP INDEX IF EXISTS public.chiefos_qe_version_seq_idx;
DROP INDEX IF EXISTS public.chiefos_qe_quote_seq_idx;
DROP INDEX IF EXISTS public.chiefos_qe_owner_seq_idx;
DROP INDEX IF EXISTS public.chiefos_qe_tenant_seq_idx;
DROP INDEX IF EXISTS public.chiefos_qe_external_event_unique;

DROP INDEX IF EXISTS public.chiefos_qst_expiry_cron_idx;
DROP INDEX IF EXISTS public.chiefos_qst_version_idx;
DROP INDEX IF EXISTS public.chiefos_qst_owner_issued_idx;
DROP INDEX IF EXISTS public.chiefos_qst_tenant_issued_idx;
DROP INDEX IF EXISTS public.chiefos_qst_source_msg_unique;

DROP INDEX IF EXISTS public.chiefos_qli_catalog_idx;
DROP INDEX IF EXISTS public.chiefos_qli_owner_version_idx;
DROP INDEX IF EXISTS public.chiefos_qli_tenant_version_idx;
DROP INDEX IF EXISTS public.chiefos_qli_version_order_idx;

DROP INDEX IF EXISTS public.chiefos_qv_status_idx;
DROP INDEX IF EXISTS public.chiefos_qv_locked_idx;
DROP INDEX IF EXISTS public.chiefos_qv_owner_idx;
DROP INDEX IF EXISTS public.chiefos_qv_tenant_idx;
DROP INDEX IF EXISTS public.chiefos_qv_quote_vno_idx;

DROP INDEX IF EXISTS public.chiefos_quotes_customer_idx;
DROP INDEX IF EXISTS public.chiefos_quotes_job_idx;
DROP INDEX IF EXISTS public.chiefos_quotes_owner_status_idx;
DROP INDEX IF EXISTS public.chiefos_quotes_tenant_status_idx;

-- Drop tables in reverse dependency order
DROP TABLE IF EXISTS public.chiefos_quote_signatures;
DROP TABLE IF EXISTS public.chiefos_quote_share_tokens;
DROP TABLE IF EXISTS public.chiefos_quote_events;
DROP TABLE IF EXISTS public.chiefos_quote_line_items;
DROP TABLE IF EXISTS public.chiefos_quote_versions;
DROP TABLE IF EXISTS public.chiefos_quotes;

-- Drop the global event sequence last (was referenced by events.global_seq default)
DROP SEQUENCE IF EXISTS public.chiefos_events_global_seq;

COMMIT;
