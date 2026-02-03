/**
 * Compute paid time for a closed shift using employer policy.
 * entries:
 *   - legacy: array of { kind, minutes }
 *   - v2:     array of { kind, start_at_utc, end_at_utc } (or Date-compatible strings)
 * policy: { paid_break_minutes, lunch_paid, paid_lunch_minutes, drive_is_paid, daily_ot_minutes?, weekly_ot_minutes? }
 */
function computeShiftCalc(entries, policy) {
  let totalShift = 0, breakTotal = 0, lunchTotal = 0, driveTotal = 0;

  const toMinutes = (e) => {
    if (!e) return null;

    // preferred: explicit minutes
    if (typeof e.minutes === 'number' && Number.isFinite(e.minutes)) return e.minutes;

    // fallback: compute from timestamps
    const a = e.start_at_utc || e.start_at || e.start;
    const b = e.end_at_utc || e.end_at || e.end;
    if (!a || !b) return null;

    const ms = Date.parse(String(b)) - Date.parse(String(a));
    if (!Number.isFinite(ms)) return null;

    return ms / 60000;
  };

  for (const e of entries || []) {
    const mins = toMinutes(e);
    if (typeof mins !== 'number' || !Number.isFinite(mins)) continue;

    switch (e.kind) {
      case 'shift': totalShift += mins; break;
      case 'break': breakTotal += mins; break;
      case 'lunch': lunchTotal += mins; break;
      case 'drive': driveTotal += mins; break;
      default: break;
    }
  }

  const paidBreakAllowance = Math.max(0, policy?.paid_break_minutes || 0);
  const paidLunchAllowance = Math.max(0, policy?.paid_lunch_minutes || 0);

  const unpaidBreak = Math.max(0, breakTotal - paidBreakAllowance);
  const unpaidLunch = policy?.lunch_paid === true
    ? Math.max(0, lunchTotal - paidLunchAllowance)
    : lunchTotal;

  const paidMinutes = Math.max(0, Math.round(totalShift - unpaidBreak - unpaidLunch));
  const paidDrive = policy?.drive_is_paid === false ? 0 : Math.round(driveTotal);

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
