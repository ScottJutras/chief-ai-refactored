-- Job photos: site photos linked to jobs, from WhatsApp or portal upload
-- Storage in Supabase Storage bucket 'job-photos' (public read)
-- Shareable gallery tokens for sending to clients

CREATE TABLE IF NOT EXISTS public.job_photos (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL,
  job_id           int         NOT NULL,
  owner_id         text        NOT NULL,
  description      text,
  storage_bucket   text        NOT NULL DEFAULT 'job-photos',
  storage_path     text        NOT NULL,
  public_url       text,
  source           text        NOT NULL DEFAULT 'portal', -- 'portal' | 'whatsapp'
  source_msg_id    text,
  taken_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT job_photos_job_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE,
  CONSTRAINT job_photos_dedup UNIQUE (owner_id, source_msg_id) WHERE source_msg_id IS NOT NULL
);

CREATE INDEX IF NOT EXISTS job_photos_job_idx    ON public.job_photos (job_id);
CREATE INDEX IF NOT EXISTS job_photos_tenant_idx ON public.job_photos (tenant_id, job_id);
CREATE INDEX IF NOT EXISTS job_photos_owner_idx  ON public.job_photos (owner_id, job_id);

ALTER TABLE public.job_photos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "job_photos_tenant_read" ON public.job_photos
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "job_photos_tenant_write" ON public.job_photos
  FOR INSERT WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "job_photos_tenant_delete" ON public.job_photos
  FOR DELETE USING (
    tenant_id IN (
      SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()
    )
  );

-- Gallery share tokens for sending client links
CREATE TABLE IF NOT EXISTS public.job_photo_shares (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL,
  job_id     int         NOT NULL,
  owner_id   text        NOT NULL,
  token      text        NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  label      text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT job_photo_shares_job_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS job_photo_shares_token_idx ON public.job_photo_shares (token);

-- Share lookups don't require auth (public gallery page fetches via token using service role)
ALTER TABLE public.job_photo_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY "job_photo_shares_tenant_read" ON public.job_photo_shares
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "job_photo_shares_tenant_write" ON public.job_photo_shares
  FOR INSERT WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()
    )
  );
