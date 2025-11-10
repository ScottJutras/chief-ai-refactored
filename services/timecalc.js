/**
* Compute paid time for a closed shift using employer policy.
* entries: array of { kind, minutes }
* policy: { paid_break_minutes, lunch_paid, paid_lunch_minutes, drive_is_paid, daily_ot_minutes?, weekly_ot_minutes? }
*/
function computeShiftCalc(entries, policy) {
let totalShift = 0, breakTotal = 0, lunchTotal = 0, driveTotal = 0;
for (const e of entries) {
if (!e || typeof e.minutes !== 'number') continue;
switch (e.kind) {
case 'shift': totalShift += e.minutes; break;
case 'break': breakTotal += e.minutes; break;
case 'lunch': lunchTotal += e.minutes; break;
case 'drive': driveTotal += e.minutes; break;
}
}


const paidBreakAllowance = Math.max(0, policy.paid_break_minutes || 0);
const paidLunchAllowance = Math.max(0, policy.paid_lunch_minutes || 0);


const unpaidBreak = Math.max(0, breakTotal - paidBreakAllowance);
const unpaidLunch = policy.lunch_paid === true
? Math.max(0, lunchTotal - paidLunchAllowance)
: lunchTotal;


const paidMinutes = Math.max(0, Math.round(totalShift - unpaidBreak - unpaidLunch));
const paidDrive = policy.drive_is_paid === false ? 0 : Math.round(driveTotal);


return {
totalShift: Math.round(totalShift),
breakTotal: Math.round(breakTotal),
lunchTotal: Math.round(lunchTotal),
driveTotal: Math.round(driveTotal),
unpaidBreak: Math.round(unpaidBreak),
unpaidLunch: Math.round(unpaidLunch),
paidMinutes,
paidDrive
};
}


module.exports = { computeShiftCalc };