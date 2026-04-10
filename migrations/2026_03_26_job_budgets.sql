-- Job budget columns for life-bar progress tracking on the Jobs page
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS material_budget_cents bigint,
  ADD COLUMN IF NOT EXISTS labour_hours_budget   numeric(6,2),
  ADD COLUMN IF NOT EXISTS contract_value_cents  bigint;
