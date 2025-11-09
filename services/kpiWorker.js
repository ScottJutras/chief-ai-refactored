/* services/kpiWorker.js
   KPI Worker — batch recompute daily rollups from kpi_touches
   Safe to run as a cron every 1–5 minutes.
*/
require('dotenv').config({ path: './config/.env' }); // <-- ensure DB vars are loaded locally

const { query } = require('./postgres');

const BATCH_LIMIT = 200;   // max touches to process at once
const SLEEP_MS    = 0;     // no loop; one-shot worker (use cron)

function minutesBetween(a, b) {
  const ms = Math.max(0, new Date(b).getTime() - new Date(a).getTime());
  return Math.round(ms / 60000);
}

function normName(s='') { return String(s || '').trim(); }

// reconstruct intervals from start/stop pairs
function pairIntervals(events, startType, stopType) {
  const starts = [];
  const intervals = [];
  for (const e of events) {
    if (e.type === startType) {
      starts.push(e);
    } else if (e.type === stopType) {
      const s = starts.pop();
      if (s) intervals.push({ start: s.timestamp, end: e.timestamp });
    }
  }
  return intervals;
}

function intersectMinutes(iv, dayStart, dayEnd) {
  // clip interval to [dayStart, dayEnd)
  const s = Math.max(new Date(iv.start).getTime(), dayStart.getTime());
  const e = Math.min(new Date(iv.end).getTime(),   dayEnd.getTime());
  if (e <= s) return 0;
  return Math.round((e - s) / 60000);
}

function sumMinutes(intervals) {
  return intervals.reduce((acc, iv) => acc + minutesBetween(iv.start, iv.end), 0);
}

async function fetchTouches() {
  const { rows } = await query(
    `SELECT owner_id, day, MIN(created_at) AS first_at, COUNT(*) AS n
       FROM public.kpi_touches
      GROUP BY owner_id, day
      ORDER BY MIN(created_at)
      LIMIT $1`,
    [BATCH_LIMIT]
  );
  return rows;
}

async function deleteTouches(ownerId, day) {
  await query(`DELETE FROM public.kpi_touches WHERE owner_id=$1 AND day=$2`, [ownerId, day]);
}

async function fetchEntries(ownerId, day) {
  // Pull all events that could affect that calendar day (clip in JS).
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const dayEnd   = new Date(new Date(dayStart).getTime() + 86400000);
  const { rows } = await query(
    `SELECT owner_id, employee_name, type, timestamp, job_no
       FROM public.time_entries
      WHERE owner_id = $1
        AND timestamp >= $2::timestamptz - interval '12 hours'
        AND timestamp <  $3::timestamptz + interval '12 hours'
      ORDER BY employee_name, timestamp ASC`,
    [ownerId, dayStart.toISOString(), dayEnd.toISOString()]
  );
  return { rows, dayStart, dayEnd };
}

async function fetchRates(ownerId) {
  // Optional: pick hourly_rate_cents from users table if you have it
  try {
    const { rows } = await query(
      `SELECT lower(name) AS key, COALESCE(hourly_rate_cents,0)::bigint AS rate
         FROM public.users
        WHERE owner_id=$1`,
      [ownerId]
    );
    const map = new Map();
    for (const r of rows) map.set(r.key, Number(r.rate || 0));
    return map;
  } catch {
    return new Map();
  }
}

function computeDay(ownerId, day, entriesByEmp, dayStart, dayEnd, rateMap) {
  // returns:
  //  - timesheetRows: [{ owner_id, day, employee_name, job_no, total_shift_min, break_total_min, drive_total_min, paid_minutes }]
  //  - jobAgg: Map(job_no => { paid_minutes, drive_minutes, labour_cents })

  const timesheetRows = [];
  const jobAgg = new Map();

  for (const [employee, evts] of entriesByEmp.entries()) {
    // Bucket by job_no for rollups; if events lack job_no on clock_in/out,
    // we’ll still roll breaks/drives by their job_no; paid time we associate to the last known job_no on that day.
    // Conservative beta behavior: attach shift minutes to the most frequent job_no seen for that employee that day.
    const byType = evts; // already sorted

    // Build shift intervals from clock_in/out
    const shiftIntervals = pairIntervals(byType, 'clock_in', 'clock_out');
    // Build break/drive intervals
    const breakIntervals = pairIntervals(byType, 'break_start', 'break_stop');
    const driveIntervals = pairIntervals(byType, 'drive_start', 'drive_stop');

    // Clip everything to the day window
    const shiftMin = shiftIntervals.reduce((acc, iv) => acc + intersectMinutes(iv, dayStart, dayEnd), 0);
    const breakMin = breakIntervals.reduce((acc, iv) => acc + intersectMinutes(iv, dayStart, dayEnd), 0);
    const driveMin = driveIntervals.reduce((acc, iv) => acc + intersectMinutes(iv, dayStart, dayEnd), 0);

    // Beta policy: paid = shift - break (you’ll refine when lunch/policy lands)
    const paid = Math.max(0, shiftMin - breakMin);

    // Determine a job_no to attribute paid minutes: pick the most frequent job_no among that user’s events today
    const jobCount = new Map();
    for (const e of byType) {
      const j = e.job_no ?? null;
      const k = j == null ? 'null' : String(j);
      jobCount.set(k, (jobCount.get(k) || 0) + 1);
    }
    let chosenKey = 'null';
    let best = -1;
    for (const [k, c] of jobCount.entries()) if (c > best) { best = c; chosenKey = k; }
    const chosenJobNo = (chosenKey === 'null') ? null : Number(chosenKey);

    // Upsert timesheet row (employee + chosen job_no)
    timesheetRows.push({
      owner_id: ownerId,
      day,
      employee_name: employee,
      job_no: chosenJobNo,
      total_shift_min: shiftMin,
      break_total_min: breakMin,
      drive_total_min: driveMin,
      paid_minutes: paid
    });

    // Aggregate for job KPIs
    const empRate = Number(rateMap.get(employee.toLowerCase()) || 0);
    const labourCents = Math.round((paid / 60) * empRate);

    const aggKey = chosenJobNo == null ? 'null' : String(chosenJobNo);
    const agg = jobAgg.get(aggKey) || { paid_minutes: 0, drive_minutes: 0, labour_cost_cents: 0 };
    agg.paid_minutes      += paid;
    agg.drive_minutes     += driveMin;
    agg.labour_cost_cents += labourCents;
    jobAgg.set(aggKey, agg);
  }

  return { timesheetRows, jobAgg };
}

async function upsertTimesheetRows(rows) {
  if (!rows.length) return;
  const values = [];
  const params = [];
  let p = 1;
  for (const r of rows) {
    params.push(r.owner_id, r.day, r.employee_name, r.job_no, r.total_shift_min, r.break_total_min, r.drive_total_min, r.paid_minutes);
    values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
  }
  await query(
    `INSERT INTO public.timesheet_rollups
      (owner_id, day, employee_name, job_no, total_shift_min, break_total_min, drive_total_min, paid_minutes)
     VALUES ${values.join(',')}
     ON CONFLICT (owner_id, day, employee_name, job_no)
     DO UPDATE SET
       total_shift_min = EXCLUDED.total_shift_min,
       break_total_min = EXCLUDED.break_total_min,
       drive_total_min = EXCLUDED.drive_total_min,
       paid_minutes    = EXCLUDED.paid_minutes,
       updated_at      = NOW()`,
    params
  );
}

async function upsertJobDaily(ownerId, day, jobAgg) {
  if (!jobAgg.size) return;
  const values = [];
  const params = [];
  let p = 1;
  for (const [key, agg] of jobAgg.entries()) {
    const jobNo = (key === 'null') ? null : Number(key);
    params.push(ownerId, day, jobNo, agg.paid_minutes, agg.drive_minutes, agg.labour_cost_cents);
    values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
  }
  await query(
    `INSERT INTO public.job_kpis_daily
      (owner_id, day, job_no, paid_minutes, drive_minutes, labour_cost_cents)
     VALUES ${values.join(',')}
     ON CONFLICT (owner_id, day, job_no)
     DO UPDATE SET
       paid_minutes       = EXCLUDED.paid_minutes,
       drive_minutes      = EXCLUDED.drive_minutes,
       labour_cost_cents  = EXCLUDED.labour_cost_cents,
       updated_at         = NOW()`,
    params
  );
}

async function processOwnerDay(ownerId, day) {
  const { rows, dayStart, dayEnd } = await fetchEntries(ownerId, day);
  if (!rows.length) {
    // clear any old aggregates for this day to avoid stale data
    await query(`DELETE FROM public.timesheet_rollups WHERE owner_id=$1 AND day=$2`, [ownerId, day]);
    await query(`DELETE FROM public.job_kpis_daily   WHERE owner_id=$1 AND day=$2`, [ownerId, day]);
    return;
  }

  // group by employee
  const entriesByEmp = new Map();
  for (const r of rows) {
    const k = normName(r.employee_name).toLowerCase();
    if (!entriesByEmp.has(k)) entriesByEmp.set(k, []);
    entriesByEmp.get(k).push({
      type: r.type,
      timestamp: r.timestamp,
      job_no: r.job_no ?? null
    });
  }

  // fetch hourly rates (optional)
  const rateMap = await fetchRates(ownerId);

  const { timesheetRows, jobAgg } = computeDay(ownerId, day, entriesByEmp, dayStart, dayEnd, rateMap);
  await upsertTimesheetRows(timesheetRows);
  await upsertJobDaily(ownerId, day, jobAgg);
}

async function main() {
  const touches = await fetchTouches();
  if (!touches.length) {
    console.log('[KPI] no touches');
    return;
  }
  for (const t of touches) {
    const ownerId = t.owner_id;
    const day = t.day; // 'YYYY-MM-DD'
    console.log('[KPI] rebuilding', ownerId, day);
    try {
      await processOwnerDay(ownerId, day);
      await deleteTouches(ownerId, day);
    } catch (e) {
      console.error('[KPI] failed', ownerId, day, e?.message);
      // keep touches; retry on next run
    }
  }
}

main().then(() => {
  setTimeout(() => process.exit(0), SLEEP_MS);
});
