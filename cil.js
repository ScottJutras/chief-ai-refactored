// LEGACY CIL (PocketCFO). Do not extend. ChiefOS CIL lives in /src/cil
// cil.js
const { z } = require('zod');

// ---- Common building blocks ----
const money = z.number().int().nonnegative()
const moneyCents = z.number().int().nonnegative();

const lineItemSchema = z.object({
  name: z.string().min(1),
  qty: z.number().positive(),
  unit: z.string().optional(),
  unit_price_cents: moneyCents,
});

const jobRefSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
}).refine(v => !!v.id || !!v.name, { message: 'job_ref must have id or name' });

const baseCIL = z.object({
  type: z.string().min(1),
  owner_id: z.string().uuid().optional(),
  job_ref: jobRefSchema.optional(),
  idempotency_key: z.string().optional(),
  source_msg_id: z.string().optional(),
  actor_phone: z.string().optional(),
});

// ---- Lead ----

const createLeadSchema = baseCIL.extend({
  type: z.literal('CreateLead'),
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    address: z.string().optional(),
  }),
  notes: z.string().optional(),
});

// ---- Quote ----

const createQuoteSchema = baseCIL.extend({
  type: z.literal('CreateQuote'),
  job_ref: jobRefSchema,                   // we always want a job here
  line_items: z.array(lineItemSchema).optional(),
  description: z.string().optional(),
  total_cents: moneyCents.optional(),      // if missing, we calculate
});

// ---- Agreement / Contract ----

const paymentMilestoneSchema = z.object({
  label: z.string().min(1),                // 'Deposit', 'Progress #1', 'Holdback'
  amount_cents: moneyCents.optional(),     // optional if pct used
  pct_of_contract: z.number().min(0).max(100).optional(),
  due_event: z.enum([
    'on_acceptance',
    'before_start',
    'on_start',
    'on_milestone',
    'on_substantial_completion',
    'on_completion',
    'on_holdback_release',
  ]).optional(),
  due_days_after_event: z.number().int().optional(), // e.g. 45 days after completion
  notes: z.string().optional(),
});

const createAgreementSchema = baseCIL.extend({
  type: z.literal('CreateAgreement'),
  job_ref: jobRefSchema,
  quote_id: z.string().uuid().optional(),  // link accepted quote if present
  terms: z.string().optional(),            // free-text terms / template id
  contract_price_cents: moneyCents.optional(), // final agreed price
  deposit_cents: moneyCents.optional(),
  retainage_pct: z.number().min(0).max(20).optional(), // e.g. 10%
  retainage_release_days: z.number().int().optional(), // e.g. 45
  payment_schedule: z.array(paymentMilestoneSchema).optional(),
  start_date: z.string().optional(),       // ISO date
  sig_required: z.boolean().default(true),
});

// ---- Invoice ----

const createInvoiceSchema = baseCIL.extend({
  type: z.literal('CreateInvoice'),
  job_ref: jobRefSchema,
  agreement_id: z.string().uuid().optional(),
  line_items: z.array(lineItemSchema).optional(),
  tax_code: z.string().default('HST_ON'),
  due_date: z.string().optional(),         // ISO date
  // For deposit / progress / holdback invoices, we can add:
  invoice_kind: z.enum(['standard', 'deposit', 'progress', 'holdback'])
    .default('standard'),
});

// ---- Change Order ----
const createChangeOrderSchema = baseCIL.extend({
  type: z.literal('CreateChangeOrder'),
  job_ref: jobRefSchema,
  description: z.string().min(1),
  amount_cents: moneyCents,
  line_items: z.array(lineItemSchema).optional(),
});

// ---- Transactions ----
const logExpenseSchema = z.object({
  type: z.literal('LogExpense'),
  job: z.string().optional(),
  item: z.string().min(1),
  amount_cents: moneyCents,
  store: z.string().optional(),
  date: z.string().optional(),    // ISO
  category: z.string().optional(),
  media_url: z.string().url().optional(),
});

const logRevenueSchema = z.object({
  type: z.literal('LogRevenue'),
  job: z.string().optional(),
  description: z.string().min(1),
  amount_cents: moneyCents,
  source: z.string().optional(),
  date: z.string().optional(),    // ISO
  category: z.string().optional(),
  media_url: z.string().url().optional(),
});


// ---- Pricing ----
const pricingAddSchema = z.object({
  type: z.literal('AddPricingItem'),
  item_name: z.string().min(1),
  unit: z.string().default('each'),
  unit_cost_cents: moneyCents,
  kind: z.string().default('material'),
});
const pricingUpdateSchema = z.object({
  type: z.literal('UpdatePricingItem'),
  item_name: z.string().min(1),
  unit_cost_cents: moneyCents,
});
const pricingDeleteSchema = z.object({
  type: z.literal('DeletePricingItem'),
  item_name: z.string().min(1),
});

// (Optional) Payment schedule structure for agreements
const milestoneSchema = z.object({
  label: z.string(),
  amount_cents: money.optional(),
  percent: z.number().min(0).max(100).optional(),
  due_on: z.string().optional(), // ISO
});
const paymentScheduleSchema = z.object({
  deposit_cents: money.optional(),
  retainage_pct: z.number().min(0).max(20).optional(),       // holdback percent
  retainage_release_days: z.number().int().min(0).optional(),// holdback duration
  milestones: z.array(milestoneSchema).default([]),
});


// ---- Export map (no duplicates) ----
const cilSchemas = {
  CreateLead: createLeadSchema,
  CreateQuote: createQuoteSchema,
  CreateAgreement: createAgreementSchema,
  CreateInvoice: createInvoiceSchema,
  CreateChangeOrder: createChangeOrderSchema,

  LogExpense: logExpenseSchema,
  LogRevenue: logRevenueSchema,

  AddPricingItem: pricingAddSchema,
  UpdatePricingItem: pricingUpdateSchema,
  DeletePricingItem: pricingDeleteSchema,
};

module.exports = { cilSchemas, lineItemSchema, jobRefSchema };
