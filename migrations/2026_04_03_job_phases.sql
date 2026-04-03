-- Job phases: optional phase tracking per job
-- Phases are timeline events on a job. Phase assignment for entries is derived
-- at query time (entry.created_at falls between phase.started_at and phase.ended_at).
-- No columns added to transactions or time_entries — zero footprint for non-users.

CREATE TABLE IF NOT EXISTS public.job_phases (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL,
  job_id     int         NOT NULL,
  owner_id   text        NOT NULL,
  phase_name text        NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,             -- NULL = still active
  expires_at timestamptz,             -- auto-close time (end of day when set via WhatsApp)
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT job_phases_job_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS job_phases_job_idx      ON public.job_phases (job_id);
CREATE INDEX IF NOT EXISTS job_phases_owner_idx    ON public.job_phases (owner_id, job_id);
CREATE INDEX IF NOT EXISTS job_phases_tenant_idx   ON public.job_phases (tenant_id, job_id);

-- RLS: portal users can read/delete their own tenant's phase rows
ALTER TABLE public.job_phases ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "job_phases_tenant_read" ON public.job_phases
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY IF NOT EXISTS "job_phases_tenant_delete" ON public.job_phases
  FOR DELETE USING (
    tenant_id IN (
      SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()
    )
  );

-- Backend (service role) can do all operations; service_role bypasses RLS by default.
