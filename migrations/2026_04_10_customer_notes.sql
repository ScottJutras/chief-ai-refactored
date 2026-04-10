-- Customer communication log: append-only notes per customer record
-- Used by portal ContactSection to log calls, emails, site visits, etc.

CREATE TABLE IF NOT EXISTS public.customer_notes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL,
  customer_id uuid        NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  note        text        NOT NULL,
  created_by  text,       -- display name of who added it (owner/user name)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_notes_customer_idx ON public.customer_notes (customer_id);
CREATE INDEX IF NOT EXISTS customer_notes_tenant_idx   ON public.customer_notes (tenant_id);

ALTER TABLE public.customer_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_notes_tenant ON public.customer_notes FOR ALL
  USING (tenant_id IN (
    SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()
  ));

GRANT SELECT, INSERT, DELETE ON public.customer_notes TO authenticated;
