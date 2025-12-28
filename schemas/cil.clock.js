// schemas/cil.clock.js
const z = require('zod');

const iso = z.string().datetime();
const nowOrIso = z.union([z.literal('now'), iso]).default('now');

const ClockCIL = z.object({
  type: z.literal('Clock'),
  action: z.enum([
    'in', 'out',
    'break_start', 'break_stop',
    'lunch_start', 'lunch_stop',
    'drive_start', 'drive_stop'
  ]),
  at: nowOrIso,
  job: z.string().nullable().optional(),
  target_user: z.string().nullable().optional(),
});

module.exports = { ClockCIL };
