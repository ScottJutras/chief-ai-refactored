-- ============================================================
-- 2026-03-23: Expense categories, personal flag, location
-- Apply via Supabase Dashboard → SQL Editor
-- ============================================================

-- Location on pending signups (captured at signup time)
ALTER TABLE chiefos_pending_signups
  ADD COLUMN IF NOT EXISTS country text; -- 'CA' | 'US'

-- Location on tenants (copied from pending signup during workspace setup)
ALTER TABLE chiefos_tenants
  ADD COLUMN IF NOT EXISTS country text, -- 'CA' | 'US'
  ADD COLUMN IF NOT EXISTS region  text; -- province/state code e.g. 'ON', 'TX'

-- Expense classification on drafts
ALTER TABLE intake_item_drafts
  ADD COLUMN IF NOT EXISTS expense_category text,    -- see categories list below
  ADD COLUMN IF NOT EXISTS is_personal       boolean NOT NULL DEFAULT false;

-- Expense classification on final transactions
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS expense_category text,
  ADD COLUMN IF NOT EXISTS is_personal       boolean NOT NULL DEFAULT false;

-- ============================================================
-- Valid expense_category values:
--   materials_supplies   → CRA 8811  / IRS Sch-C Line 22
--   meals_entertainment  → CRA 8523  / IRS Sch-C Line 24b  (50% ITC rule CA)
--   vehicle_fuel         → CRA 9281  / IRS Sch-C Line 9
--   subcontractors       → CRA 8710  / IRS Sch-C Line 11
--   tools_equipment      → CRA 8811  / IRS Sch-C Line 22
--   office_admin         → CRA 8810  / IRS Sch-C Line 18
--   professional_fees    → CRA 8860  / IRS Sch-C Line 17
--   travel               → CRA 9200  / IRS Sch-C Line 24a
--   advertising          → CRA 8520  / IRS Sch-C Line 8
--   other                → unclassified
-- ============================================================
