const { computeShiftCalc } = require('../services/timecalc');


describe('computeShiftCalc', () => {
const policyPaid30 = { paid_break_minutes: 30, lunch_paid: true, paid_lunch_minutes: 30, drive_is_paid: true };


test('8h shift, 30m lunch paid, 15m break → full paid', () => {
const r = computeShiftCalc([
{ kind:'shift', minutes:480 },
{ kind:'lunch', minutes:30 },
{ kind:'break', minutes:15 }
], policyPaid30);
expect(r.paidMinutes).toBe(480); // all within allowances
});


test('8h shift, 45m lunch paid 30 → 15 unpaid', () => {
const r = computeShiftCalc([
{ kind:'shift', minutes:480 },
{ kind:'lunch', minutes:45 }
], policyPaid30);
expect(r.unpaidLunch).toBe(15);
expect(r.paidMinutes).toBe(465);
});


test('8h shift, lunch unpaid 45 → 45 unpaid', () => {
const r = computeShiftCalc([
{ kind:'shift', minutes:480 },
{ kind:'lunch', minutes:45 }
], { paid_break_minutes:30, lunch_paid:false, paid_lunch_minutes:0, drive_is_paid:true });
expect(r.unpaidLunch).toBe(45);
expect(r.paidMinutes).toBe(435);
});
});