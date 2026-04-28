-- Pre-seed cleanliness check: c6c6 namespace must be empty before VoidQuote ceremony seed.
-- Halt if any row count > 0 — surface for cleanup decision.

SELECT 'chiefos_quotes'                   AS tbl, COUNT(*) AS rowcount FROM public.chiefos_quotes               WHERE id = '00000000-c6c6-c6c6-c6c6-000000000002'
UNION ALL
SELECT 'chiefos_quote_versions'           AS tbl, COUNT(*) AS rowcount FROM public.chiefos_quote_versions       WHERE id = '00000000-c6c6-c6c6-c6c6-000000000003'
UNION ALL
SELECT 'chiefos_quote_share_tokens'       AS tbl, COUNT(*) AS rowcount FROM public.chiefos_quote_share_tokens   WHERE id = '00000000-c6c6-c6c6-c6c6-000000000005'
UNION ALL
SELECT 'chiefos_quote_events_sent'        AS tbl, COUNT(*) AS rowcount FROM public.chiefos_quote_events         WHERE id = '00000000-c6c6-c6c6-c6c6-000000000007'
UNION ALL
SELECT 'chiefos_tenants'                  AS tbl, COUNT(*) AS rowcount FROM public.chiefos_tenants              WHERE id = '00000000-c6c6-c6c6-c6c6-000000000001'
UNION ALL
SELECT 'users_owner_004'                  AS tbl, COUNT(*) AS rowcount FROM public.users                        WHERE user_id = '00000000004'
ORDER BY tbl;
