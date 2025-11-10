// schemas/cil.clock.js
const z = require('zod');

const ClockCIL = z.object({
  type: z.literal('Clock'),
  action: z.enum([
    'in','out',
    'break_start','break_stop',
    'lunch_start','lunch_stop',
    'drive_start','drive_stop'
  ]),
  at: z.string().datetime().optional(),
  job: z.string().optional(),
  target_user: z.string().optional(),
});

module.exports = { ClockCIL };
