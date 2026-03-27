-- Documents feature: customers, job lifecycle, quotes, PDFs, change orders

-- Customers (shared across jobs for a tenant)
CREATE TABLE IF NOT EXISTS customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES chiefos_tenants(id),
  name          text NOT NULL,
  phone         text,
  email         text,
  address       text,
  notes         text,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_tenant_idx ON customers (tenant_id);

-- Document lifecycle stage per job (1:1 with jobs)
CREATE TABLE IF NOT EXISTS job_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES chiefos_tenants(id),
  job_id        bigint NOT NULL REFERENCES jobs(id),
  customer_id   uuid REFERENCES customers(id),
  stage         text NOT NULL DEFAULT 'lead',
  -- stages: lead | quote | contract | active | invoiced | paid | closed
  lead_notes    text,
  lead_source   text,   -- whatsapp | portal | referral | ad | other
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (job_id)
);
CREATE INDEX IF NOT EXISTS job_documents_tenant_idx ON job_documents (tenant_id);
CREATE INDEX IF NOT EXISTS job_documents_job_idx ON job_documents (job_id);

-- Quote line items
CREATE TABLE IF NOT EXISTS quote_line_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           bigint NOT NULL REFERENCES jobs(id),
  tenant_id        uuid NOT NULL REFERENCES chiefos_tenants(id),
  description      text NOT NULL,
  qty              numeric(8,2) NOT NULL DEFAULT 1,
  unit_price_cents bigint NOT NULL,
  category         text,   -- labour | materials | other
  sort_order       int NOT NULL DEFAULT 0,
  created_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quote_line_items_job_idx ON quote_line_items (job_id);

-- Stored PDFs and photos (references Supabase Storage)
CREATE TABLE IF NOT EXISTS job_document_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          bigint NOT NULL REFERENCES jobs(id),
  tenant_id       uuid NOT NULL REFERENCES chiefos_tenants(id),
  kind            text NOT NULL,
  -- kind: quote | contract | change_order | invoice | receipt | photo
  label           text,
  storage_bucket  text NOT NULL,
  storage_path    text NOT NULL,
  signature_token uuid UNIQUE DEFAULT NULL,  -- set when sent for e-sign, cleared after signing
  signed_at       timestamptz,
  signature_data  text,   -- base64 canvas PNG
  sent_at         timestamptz,
  sent_via        text,   -- email | sms
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_document_files_job_idx ON job_document_files (job_id);
CREATE INDEX IF NOT EXISTS job_document_files_token_idx ON job_document_files (signature_token) WHERE signature_token IS NOT NULL;

-- Change orders
CREATE TABLE IF NOT EXISTS change_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       bigint NOT NULL REFERENCES jobs(id),
  tenant_id    uuid NOT NULL REFERENCES chiefos_tenants(id),
  number       int NOT NULL,
  description  text NOT NULL,
  amount_cents bigint NOT NULL,
  approved_at  timestamptz,
  file_id      uuid REFERENCES job_document_files(id),
  created_at   timestamptz DEFAULT now(),
  UNIQUE (job_id, number)
);
CREATE INDEX IF NOT EXISTS change_orders_job_idx ON change_orders (job_id);
