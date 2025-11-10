const z = require('zod');


const ClockAction = z.enum([
'in','out',
'break_start','break_end',
'lunch_start','lunch_end',
'drive_start','drive_end',
'undo'
]);


const ClockCIL = z.object({
type: z.literal('Clock'),
action: ClockAction,
at: z.string().datetime().optional(), // ISO; default now in handler
job: z.string().optional(), // name; resolver will map to job_id
target_user: z.string().optional() // phone/name; resolver maps to user_id
});


module.exports = { ClockCIL };