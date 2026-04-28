-- Rollback for 2026_04_21_rebuild_time_spine.sql
-- Drops tables in reverse dependency order. Safe to re-run (IF EXISTS everywhere).

BEGIN;

-- employer_policies
DROP POLICY IF EXISTS employer_policies_owner_update ON public.employer_policies;
DROP POLICY IF EXISTS employer_policies_owner_upsert ON public.employer_policies;
DROP POLICY IF EXISTS employer_policies_tenant_select ON public.employer_policies;

DROP INDEX IF EXISTS public.employer_policies_tenant_idx;

DROP TABLE IF EXISTS public.employer_policies;

-- employees
DROP POLICY IF EXISTS employees_owner_update ON public.employees;
DROP POLICY IF EXISTS employees_owner_insert ON public.employees;
DROP POLICY IF EXISTS employees_tenant_select ON public.employees;

DROP INDEX IF EXISTS public.employees_owner_name_unique_idx;
DROP INDEX IF EXISTS public.employees_owner_active_idx;
DROP INDEX IF EXISTS public.employees_tenant_active_idx;

DROP TABLE IF EXISTS public.employees;

-- locks
DROP INDEX IF EXISTS public.locks_expires_idx;

DROP TABLE IF EXISTS public.locks;

-- states
DROP INDEX IF EXISTS public.states_tenant_idx;
DROP INDEX IF EXISTS public.states_owner_idx;

DROP TABLE IF EXISTS public.states;

-- timesheet_locks
DROP POLICY IF EXISTS timesheet_locks_tenant_select ON public.timesheet_locks;

DROP INDEX IF EXISTS public.timesheet_locks_owner_idx;
DROP INDEX IF EXISTS public.timesheet_locks_employee_period_unique_idx;

DROP TABLE IF EXISTS public.timesheet_locks;

-- timeclock_repair_prompts
DROP INDEX IF EXISTS public.timeclock_repair_prompts_expires_idx;
DROP INDEX IF EXISTS public.timeclock_repair_prompts_owner_user_idx;

DROP TABLE IF EXISTS public.timeclock_repair_prompts;

-- timeclock_prompts
DROP INDEX IF EXISTS public.timeclock_prompts_expires_idx;
DROP INDEX IF EXISTS public.timeclock_prompts_owner_employee_idx;

DROP TABLE IF EXISTS public.timeclock_prompts;

-- time_entries_v2
DROP POLICY IF EXISTS time_entries_v2_owner_board_delete ON public.time_entries_v2;
DROP POLICY IF EXISTS time_entries_v2_tenant_update ON public.time_entries_v2;
DROP POLICY IF EXISTS time_entries_v2_tenant_insert ON public.time_entries_v2;
DROP POLICY IF EXISTS time_entries_v2_tenant_select ON public.time_entries_v2;

DROP INDEX IF EXISTS public.time_entries_v2_deleted_idx;
DROP INDEX IF EXISTS public.time_entries_v2_job_idx;
DROP INDEX IF EXISTS public.time_entries_v2_shift_children_idx;
DROP INDEX IF EXISTS public.time_entries_v2_owner_user_idx;
DROP INDEX IF EXISTS public.time_entries_v2_tenant_start_idx;
DROP INDEX IF EXISTS public.time_entries_v2_record_hash_unique_idx;
DROP INDEX IF EXISTS public.time_entries_v2_owner_source_msg_unique_idx;

DROP TABLE IF EXISTS public.time_entries_v2;

COMMIT;
