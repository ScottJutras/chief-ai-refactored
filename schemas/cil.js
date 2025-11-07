// schemas/cil.js
// Canonical Intermediate Language (CIL) schemas
const z = require('zod');

const iso = z.string().refine(v => !Number.isNaN(new Date(v).getTime()), 'Invalid ISO time');

const ClockCIL = z.object({
  type: z.literal('Clock'),
  action: z.enum(['in', 'out', 'break_start', 'break_stop', 'drive_start', 'drive_stop']),
  at: z.union([z.literal('now'), iso]).default('now'),
  job: z.string().nullable().optional(),
  name: z.string().nullable().optional()
});

const CreateTaskCIL = z.object({
  type: z.literal('CreateTask'),
  title: z.string().min(1),
  due_at: iso.nullable().optional(),
  assignee: z.string().nullable().optional(),
  job: z.string().nullable().optional()
});

const ExpenseCIL = z.object({
  type: z.literal('Expense'),
  amount_cents: z.number().int().nonnegative(),
  vendor: z.string().nullable().optional(),
  job: z.string().nullable().optional()
});

const QuoteCIL = z.object({
  type: z.literal('Quote'),
  job: z.string().min(1),
  customer: z.object({ name: z.string().optional(), phone: z.string().optional() }).optional(),
  lines: z.array(z.object({ name: z.string(), qty: z.number(), unit_price_cents: z.number().int() })).min(1),
  labor_hours: z.number().optional()
});

const AnyCIL = z.discriminatedUnion('type', [ClockCIL, CreateTaskCIL, ExpenseCIL, QuoteCIL]);

module.exports = { AnyCIL, ClockCIL, CreateTaskCIL, ExpenseCIL, QuoteCIL };