// src/cil/schema.js
const { z } = require("zod");

/**
 * Shared primitives
 */
const ISODateTimeZ = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "occurred_at must be ISO datetime");

const UUIDZ = z.string().uuid();

const CurrencyZ = z
  .string()
  .length(3)
  .transform((s) => s.toUpperCase())
  .refine((s) => /^[A-Z]{3}$/.test(s), "currency must be ISO 4217 code (e.g., USD, CAD)");

const PhoneE164Z = z
  .string()
  .refine((s) => /^\+[1-9]\d{7,14}$/.test(s), "phone_e164 must be E.164 (e.g., +14165551234)");

/**
 * Money
 */
const MoneyZ = z.object({
  amount_cents: z.number().int().nonnegative(),
  currency: CurrencyZ,
});

/**
 * Actor
 */
const ActorRoleZ = z.enum(["owner", "board_member", "employee", "contractor", "system"]);

const ActorZ = z.object({
  actor_id: z.string().min(1),
  role: ActorRoleZ,
  phone_e164: PhoneE164Z.optional(),
});

/**
 * JobRef
 */
const JobRefZ = z
  .object({
    job_id: UUIDZ.optional(),
    job_name: z.string().min(1).optional(),
    create_if_missing: z.boolean().optional(),
  })
  .refine((j) => !!j.job_id || !!j.job_name, "JobRef must include job_id or job_name")
  .refine((j) => (j.create_if_missing ? !!j.job_name : true), "create_if_missing requires job_name");

/**
 * Base CIL
 */
const SourceZ = z.enum(["whatsapp", "upload", "web"]);

const BaseCILZ = z.object({
  cil_version: z.literal("1.0"),
  type: z.string().min(1),

  tenant_id: z.string().min(1),
  source: SourceZ,
  source_msg_id: z.string().min(1),
  actor: ActorZ,

  occurred_at: ISODateTimeZ,
  job: JobRefZ.nullable(),

  needs_job_resolution: z.boolean().default(false),
  trace_id: z.string().optional(),
});

/**
 * Expense CIL
 */
const ExpenseCILZ = BaseCILZ.extend({
  type: z.literal("expense"),

  total_cents: z.number().int().positive(),
  currency: CurrencyZ,

  vendor: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  tax_cents: z.number().int().nonnegative().optional(),

  memo: z.string().optional(),
  receipt_media_id: z.string().optional(),
}).refine(
  (e) => (e.tax_cents != null ? e.tax_cents <= e.total_cents : true),
  "tax_cents cannot exceed total_cents"
);

/**
 * Payment CIL (revenue / money received)
 */
const PaymentCILZ = BaseCILZ.extend({
  type: z.literal("payment"),

  amount_cents: z.number().int().positive(),
  currency: CurrencyZ,

  payer: z.string().min(1).optional(),      // e.g., client name
  method: z.enum(["cash", "cheque", "card", "etransfer", "bank", "other"]).optional(),
  category: z.string().min(1).optional(),
  memo: z.string().optional(),

  // optional linkage later
  invoice_id: UUIDZ.optional(),
});

/**
 * Note CIL
 */
const NoteCILZ = BaseCILZ.extend({
  type: z.literal("note"),
  text: z.string().min(1),
});

/**
 * Union (Zod v3-safe)
 * We intentionally avoid discriminatedUnion here to prevent Zod internals errors
 * when schemas have refinements/extends.
 */
const CILUnionZ = z.union([ExpenseCILZ, PaymentCILZ, NoteCILZ]);

function validateCIL(input) {
  const parsed = CILUnionZ.parse(input);
  if (!parsed || !parsed.type) throw new Error("CIL missing type");
  return parsed;
}

module.exports = {
  ISODateTimeZ,
  UUIDZ,
  CurrencyZ,
  PhoneE164Z,

  MoneyZ,
  ActorRoleZ,
  ActorZ,

  JobRefZ,
  SourceZ,
  BaseCILZ,

  ExpenseCILZ,
  PaymentCILZ,
  NoteCILZ,
  CILUnionZ,

  validateCIL,
};
