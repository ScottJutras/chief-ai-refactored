-- overhead_payments: confirmed payment records per item per month
CREATE TABLE IF NOT EXISTS overhead_payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  item_id          uuid NOT NULL REFERENCES overhead_items(id) ON DELETE CASCADE,
  period_year      int  NOT NULL,
  period_month     int  NOT NULL,
  paid_date        date,
  amount_cents     bigint NOT NULL,
  tax_amount_cents bigint,
  source           text NOT NULL DEFAULT 'manual',
  confirmed_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(item_id, period_year, period_month)
);

-- overhead_reminders: pending confirmation requests (created by daily cron)
CREATE TABLE IF NOT EXISTS overhead_reminders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  item_id          uuid NOT NULL REFERENCES overhead_items(id) ON DELETE CASCADE,
  item_name        text NOT NULL,
  period_year      int  NOT NULL,
  period_month     int  NOT NULL,
  amount_cents     bigint NOT NULL,
  tax_amount_cents bigint,
  status           text NOT NULL DEFAULT 'pending',
  whatsapp_sent_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(item_id, period_year, period_month)
);

ALTER TABLE overhead_payments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE overhead_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_scoped_payments ON overhead_payments FOR ALL
  USING (tenant_id = (SELECT tenant_id FROM chiefos_portal_users WHERE user_id = auth.uid() LIMIT 1));

CREATE POLICY tenant_scoped_reminders ON overhead_reminders FOR ALL
  USING (tenant_id = (SELECT tenant_id FROM chiefos_portal_users WHERE user_id = auth.uid() LIMIT 1));

GRANT SELECT, INSERT, UPDATE, DELETE ON overhead_payments  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON overhead_reminders TO authenticated;
