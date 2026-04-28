-- Rollback for drop_users_dashboard_token. Restores column as text NULL.
-- Pre-drop production values are lost; rollback only restores column shape.

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS dashboard_token text NULL;

COMMIT;
