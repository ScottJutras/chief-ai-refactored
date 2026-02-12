// services/timecalc.js
// Computes paid minutes for a v2 shift using policy + segments.
// Expected entries: array of rows from public.time_entries_v2 for ONE shift:
//  - one row kind='shift' (parent)
//  - zero+ child rows kind in ('break','lunch','drive') with parent_id = shift.id

function toMin(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function clampMin(x) {
  const n = toMin(x);
  return n < 0 ? 0 : n;
}

function diffMinutes(startIso, endIso) {
  const a = startIso ? new Date(startIso).getTime() : NaN;
  const b = endIso ? new Date(endIso).getTime() : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.round((b - a) / 60000);
}

function normalizePolicy(p = {}) {
  // Defaults chosen to be “safe”:
  // - Assume short breaks are paid unless told otherwise
  // - Assume lunch is unpaid unless told otherwise
  const breaks_paid =
    typeof p.breaks_paid === 'boolean' ? p.breaks_paid : true;

  const lunch_paid =
    typeof p.lunch_paid === 'boolean' ? p.lunch_paid : false;

  const auto_lunch_deduct_minutes = (() => {
    const v = Number(p.auto_lunch_deduct_minutes ?? 0);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  })();

  // Optional: treat drive as paid later; for now don’t subtract it from paidMinutes
  const drive_paid =
    typeof p.drive_paid === 'boolean' ? p.drive_paid : true;

  return { breaks_paid, lunch_paid, auto_lunch_deduct_minutes, drive_paid };
}

function segmentMinutes(row) {
  // Prefer explicit minutes from meta.calc when present, else compute from timestamps
  const m = row?.meta?.calc;
  const explicit =
    m && (m.minutes != null || m.totalMinutes != null)
      ? Number(m.minutes ?? m.totalMinutes)
      : null;

  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);

  return diffMinutes(row.start_at_utc, row.end_at_utc);
}

function computeShiftCalc(entries = [], policyRaw = {}) {
  const policy = normalizePolicy(policyRaw);

  const shift = (entries || []).find((e) => String(e.kind) === 'shift') || null;
  if (!shift) {
    return {
      shiftMinutes: 0,
      breakTotal: 0,
      lunchTotal: 0,
      driveTotal: 0,
      unpaidLunch: 0,
      unpaidBreak: 0,
      paidMinutes: 0,
      policy
    };
  }

  const shiftMinutes = diffMinutes(shift.start_at_utc, shift.end_at_utc);

  const children = (entries || [])
    .filter((e) => e && e.id !== shift.id && e.parent_id === shift.id)
    .filter((e) => ['break', 'lunch', 'drive'].includes(String(e.kind)));

  let breakTotal = 0;
  let lunchTotal = 0;
  let driveTotal = 0;

  for (const c of children) {
    const k = String(c.kind);
    const mins = segmentMinutes(c);
    if (k === 'break') breakTotal += mins;
    if (k === 'lunch') lunchTotal += mins;
    if (k === 'drive') driveTotal += mins;
  }

  // Deductions:
  let unpaidLunch = 0;
  let unpaidBreak = 0;

  // If lunch is unpaid:
  if (!policy.lunch_paid) {
    if (lunchTotal > 0) {
      // explicit lunch segments exist → deduct them
      unpaidLunch = lunchTotal;
    } else if (policy.auto_lunch_deduct_minutes > 0) {
      // no lunch segments → optional auto-deduct (only if configured)
      // (You can later gate this behind shiftMinutes >= X)
      unpaidLunch = policy.auto_lunch_deduct_minutes;
    }
  }

  // If breaks are unpaid (rare):
  if (!policy.breaks_paid) {
    unpaidBreak = breakTotal;
  }

  // Paid minutes = shift minutes - unpaid deductions
  // NOTE: drive handling can evolve; for now drive is not deducted.
  const paidMinutes = clampMin(shiftMinutes - unpaidLunch - unpaidBreak);

  return {
    shiftMinutes,
    breakTotal,
    lunchTotal,
    driveTotal,
    unpaidLunch,
    unpaidBreak,
    paidMinutes,
    policy
  };
}

module.exports = { computeShiftCalc };
