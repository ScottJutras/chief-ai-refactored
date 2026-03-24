-- Migration: reminders table
-- Run in Supabase SQL Editor (or direct postgres)

CREATE TABLE IF NOT EXISTS public.reminders (
  id             bigserial   PRIMARY KEY,
  owner_id       text        NOT NULL,
  user_id        text        NOT NULL,
  remind_at      timestamptz NOT NULL,
  kind           text        NOT NULL DEFAULT 'task',      -- 'task' | 'lunch_reminder'
  status         text        NOT NULL DEFAULT 'pending',   -- 'pending' | 'sent' | 'canceled'
  sent           boolean     NOT NULL DEFAULT false,
  sent_at        timestamptz,
  canceled       boolean     NOT NULL DEFAULT false,
  canceled_at    timestamptz,
  task_no        bigint,
  task_title     text,
  shift_id       text,
  source_msg_id  text,
  created_at     timestamptz DEFAULT now()
);

-- Idempotent insert guard (NULL != NULL in SQL, so rows without source_msg_id never conflict)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reminders_owner_source_msg_id_key'
      AND conrelid = 'public.reminders'::regclass
  ) THEN
    ALTER TABLE public.reminders
      ADD CONSTRAINT reminders_owner_source_msg_id_key
      UNIQUE (owner_id, source_msg_id);
  END IF;
END$$;

-- Polling index: only unsent, uncanceled, pending rows
CREATE INDEX IF NOT EXISTS reminders_due_idx
  ON public.reminders (remind_at)
  WHERE sent = false AND canceled = false AND status = 'pending';
