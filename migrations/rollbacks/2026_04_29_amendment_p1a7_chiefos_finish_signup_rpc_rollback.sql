-- Rollback for: 2026_04_29_amendment_p1a7_chiefos_finish_signup_rpc.sql
--
-- DROP the RPC. No data side-effects to undo (function creation only; rows
-- created by callers of the function persist independently).
--
-- After rollback: portal onboarding routes that call this RPC will fail with
-- 'function chiefos_finish_signup does not exist' — re-503-gate the routes
-- before applying this rollback if onboarding is being suspended.

BEGIN;

DROP FUNCTION IF EXISTS public.chiefos_finish_signup(text);

COMMIT;
