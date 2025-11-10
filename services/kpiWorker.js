// services/kpiWorker.js
// ------------------------------------------------------------
// KPI Worker — recompute daily time + (optional) finance KPIs
// Safe to run as a cron/one-shot. BATCH_LIMIT is conservative.
// ------------------------------------------------------------
require('dotenv').config({ path: './config/.env' });

const { query, withClient } = require('./postgres');
const { computeFinanceKpis } = require('./computeFinanceKpis');

const ENABLE_FINANCE = (process.env.FEATURE_FINANCE_KPIS || '1') === '1';
const BATCH_LIMIT = 200;

console.log('[KPI] Worker boot');
console.log('[KPI] Finance enrichment:', ENABLE_FINANCE ? 'ON' : 'OFF');

/* --------------------- Small helpers --------------------- */
function asYMD(dayLike) {
  if (!dayLike) return new Date().toISOString().slice(0,10);
  if (typeof dayLike === 'string') return dayLike.slice(0,10);
  // Date or timestamp
  return new Date(dayLike).toISOString().slice(0,10);
}
function dayWindow(ymd) {
  const dayStart = new Date(`${ymd}T00:00:00.000Z`);
  const dayEnd   = new Date(dayStart.getTime() + 86400000);
  return { dayStart, dayEnd };
}
function minutesBetween(a, b) {
  const ms = Math.max(0, new Date(b).getTime() - new Date(a).getTime());
  return Math.round(ms / 60000);
}
function normName(s='') { return String(s || '').trim(); }
function pairIntervals(events, startType, stopType) {
  const starts = []; const intervals = [];
  for (const e of events) {
    if (e.type === startType) starts.push(e);
    else if (e.type === stopType) { const s = starts.pop(); if (s) intervals.push({ start: s.timestamp, end: e.timestamp }); }
  }
  return intervals;
}
function intersectMinutes(iv, dayStart, dayEnd) {
  const s = Math.max(new Date(iv.start).getTime(), dayStart.getTime());
  const e = Math.min(new Date(iv.end).getTime(),   dayEnd.getTime());
  if (e <= s) return 0;
  return Math.round((e - s) / 60000);
}

/* --------------------- Touches --------------------- */
async function fetchTouches(limit = BATCH_LIMIT) {
  return await withClient(async client => {
    const { rows } = await client.query(
      `DELETE FROM public.kpi_touches
        WHERE ctid IN (
          SELECT ctid
            FROM public.kpi_touches
           ORDER BY created_at ASC
           LIMIT $1
        )
        RETURNING owner_id, job_id, job_no, day`,
      [limit]
    );
    return rows || [];
  }, { useTransaction: true });
}

/* Resolve which job_nos to recompute for this touch */
async function resolveJobsForTouch(ownerId, jobId, jobNo, ymd) {
  const owner = String(ownerId).replace(/\D/g,'');
  // (a) explicit job_no
  if (Number.isFinite(jobNo)) return [Number(jobNo)];

  // (b) resolve uuid -> job_no
  if (jobId) {
    const { rows } = await query(
      `SELECT job_no FROM public.jobs WHERE owner_id=$1 AND id=$2 LIMIT 1`,
      [owner, jobId]
    );
    if (rows[0]?.job_no != null) return [Number(rows[0].job_no)];
  }

  // (c) fallback: all job_nos that touched that day (from time_entries)
  const { rows } = await query(
    `SELECT DISTINCT job_no
       FROM public.time_entries
      WHERE owner_id=$1
        AND timestamp::date=$2
        AND job_no IS NOT NULL`,
    [owner, ymd]
  );
  const list = rows.map(r => Number(r.job_no)).filter(n => Number.isFinite(n));
  return list.length ? list : [null]; // null = no job context; still allow finance upsert if needed
}

/* --------------------- Time KPIs --------------------- */
async function fetchEntries(ownerId, ymd) {
  const { dayStart, dayEnd } = dayWindow(ymd);
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
function computeDay(ownerId, ymd, entriesByEmp, dayStart, dayEnd, rateMap) {
  const timesheetRows = [];
  const jobAgg = new Map();

  for (const [employee, evts] of entriesByEmp.entries()) {
    const shiftIntervals = pairIntervals(evts, 'clock_in', 'clock_out');
    const breakIntervals = pairIntervals(evts, 'break_start', 'break_stop');
    const driveIntervals = pairIntervals(evts, 'drive_start', 'drive_stop');

    const shiftMin = shiftIntervals.reduce((acc, iv) => acc + intersectMinutes(iv, dayStart, dayEnd), 0);
    const breakMin = breakIntervals.reduce((acc, iv) => acc + intersectMinutes(iv, dayStart, dayEnd), 0);
    const driveMin = driveIntervals.reduce((acc, iv) => acc + intersectMinutes(iv, dayStart, dayEnd), 0);
    const paid = Math.max(0, shiftMin - breakMin);

    // attribute to most-frequent job_no today
    const jobCount = new Map();
    for (const e of evts) {
      const j = e.job_no ?? null;
      const k = j == null ? 'null' : String(j);
      jobCount.set(k, (jobCount.get(k) || 0) + 1);
    }
    let chosenKey = 'null'; let best = -1;
    for (const [k, c] of jobCount.entries()) if (c > best) { best = c; chosenKey = k; }
    const chosenJobNo = (chosenKey === 'null') ? null : Number(chosenKey);

    timesheetRows.push({
      owner_id: ownerId, day: ymd, employee_name: employee,
      job_no: chosenJobNo, total_shift_min: shiftMin,
      break_total_min: breakMin, drive_total_min: driveMin, paid_minutes: paid
    });

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
  const values = []; const params = []; let p = 1;
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
async function upsertTimeDaily(ownerId, ymd, jobAgg) {
  if (!jobAgg.size) return 0;
  const values = []; const params = []; let p = 1;
  for (const [key, agg] of jobAgg.entries()) {
    const jobNo = (key === 'null') ? null : Number(key);
    params.push(ownerId, ymd, jobNo, agg.paid_minutes, agg.drive_minutes, agg.labour_cost_cents);
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
  return jobAgg.size;
}
async function upsertDaily(ownerId, jobNo, ymd, fields) {
  const owner = String(ownerId).replace(/\D/g,'');
  const cols = [
    'owner_id','day','job_no',
    'paid_minutes','drive_minutes','labour_cost_cents','ot_minutes',
    'revenue_cents','cogs_cents','gross_profit_cents','gross_margin_pct',
    'change_order_cents','holdback_cents','ar_total_cents','ap_total_cents',
    'estimate_revenue_cents','estimate_cogs_cents','slippage_cents'
  ];
  const vals = [
    owner, ymd, jobNo,
    fields.paid_minutes ?? 0,
    fields.drive_minutes ?? 0,
    fields.labour_cost_cents ?? null,
    fields.ot_minutes ?? 0,
    fields.revenue_cents ?? null,
    fields.cogs_cents ?? null,
    fields.gross_profit_cents ?? null,
    fields.gross_margin_pct ?? null,
    fields.change_order_cents ?? null,
    fields.holdback_cents ?? null,
    fields.ar_total_cents ?? null,
    fields.ap_total_cents ?? null,
    fields.estimate_revenue_cents ?? null,
    fields.estimate_cogs_cents ?? null,
    fields.slippage_cents ?? null
  ];
  const set = cols.slice(3).map((c) => `${c}=excluded.${c}`).join(', ');
  const params = vals.map((_,i)=>`$${i+1}`).join(', ');
  await query(
    `INSERT INTO public.job_kpis_daily (${cols.join(',')})
     VALUES (${params})
     ON CONFLICT (owner_id, day, job_no)
     DO UPDATE SET ${set}, updated_at=NOW()`,
    vals
  );
}

/* --------------------- Per-owner/day recompute --------------------- */
async function processOwnerDay(ownerId, dayLike) {
  const ymd = asYMD(dayLike);
  const { rows, dayStart, dayEnd } = await fetchEntries(ownerId, ymd);

  if (!rows.length) {
    // no time rows today — wipe stale time rollups (keep finance rows untouched)
    await query(`DELETE FROM public.timesheet_rollups WHERE owner_id=$1 AND day=$2`, [ownerId, ymd]);
    // do NOT delete job_kpis_daily; finance may exist independently
    return { ymd, wrote: 0 };
  }

  // group by employee
  const entriesByEmp = new Map();
  for (const r of rows) {
    const k = normName(r.employee_name).toLowerCase();
    if (!entriesByEmp.has(k)) entriesByEmp.set(k, []);
    entriesByEmp.get(k).push({ type: r.type, timestamp: r.timestamp, job_no: r.job_no ?? null });
  }

  const rateMap = await fetchRates(ownerId);
  const { timesheetRows, jobAgg } = computeDay(ownerId, ymd, entriesByEmp, dayStart, dayEnd, rateMap);

  await upsertTimesheetRows(timesheetRows);
  const wrote = await upsertTimeDaily(ownerId, ymd, jobAgg);

  return { ymd, wrote, jobKeys: Array.from(jobAgg.keys()) };
}

/* --------------------- Batch Processor --------------------- */
async function processBatch() {
  const touches = await fetchTouches(BATCH_LIMIT);
  if (!touches.length) { console.log('[KPI] no touches'); return; }

  // group touches by (owner, ymd) to avoid recomputing time multiple times
  const groups = new Map(); // key: owner|ymd -> { owner, ymd, jobs:Set }
  for (const t of touches) {
    const owner = String(t.owner_id).replace(/\D/g,'');
    const ymd = asYMD(t.day);
    const key = `${owner}|${ymd}`;
    if (!groups.has(key)) groups.set(key, { owner, ymd, jobs: new Set() });
    // we’ll resolve job ids later; include what touch has
    if (Number.isFinite(t.job_no)) groups.get(key).jobs.add(Number(t.job_no));
    // keep job_id (uuid) in a symbol key array to resolve later
    if (t.job_id) {
      if (!groups.get(key)._jobIds) groups.get(key)._jobIds = [];
      groups.get(key)._jobIds.push(t.job_id);
    }
  }

  for (const { owner, ymd, jobs, _jobIds } of groups.values()) {
    try {
      // resolve extra job_nos from job_id + from time_entries if needed
      let jobNos = Array.from(jobs);
      if (_jobIds && _jobIds.length) {
        for (const jId of _jobIds) {
          const list = await resolveJobsForTouch(owner, jId, null, ymd);
          list.forEach(n => { if (Number.isFinite(n)) jobNos.push(n); });
        }
      }
      // Always dedupe
      jobNos = Array.from(new Set(jobNos));

      // 1) recompute time once for owner/day
      const { wrote } = await processOwnerDay(owner, ymd);

      // 2) finance enrichment (even if wrote==0)
      if (ENABLE_FINANCE) {
        // If we still have no explicit job list (e.g., touch was owner/day only),
        // try to infer from finance sources — fallback to [null] to still upsert owner/day rows per null job.
        if (!jobNos.length) {
          // Look up any existing rows for that day to determine jobs; if none, we’ll just skip.
          const { rows: exist } = await query(
            `SELECT DISTINCT job_no FROM public.job_kpis_daily WHERE owner_id=$1 AND day=$2`,
            [owner, ymd]
          );
          jobNos = exist.map(r => r.job_no).filter(n => Number.isFinite(n));
          if (!jobNos.length) jobNos = [null];
        }

        for (const jobNo of jobNos) {
          if (jobNo == null) continue; // finance needs a job context
          const fin = await computeFinanceKpis(owner, jobNo, ymd, { query });
          await upsertDaily(owner, jobNo, ymd, fin);
        }
      }

      console.log('[KPI] processed owner/day', { owner, day: ymd, jobs: jobNos.length ? jobNos : [null] });
    } catch (e) {
      console.error('[KPI] owner/day failed', { owner, day: ymd }, e?.message);
    }
  }
}

/* --------------------- Main --------------------- */
async function main() { await processBatch(); process.exit(0); }
if (require.main === module) {
  main().catch(e => { console.error('[KPI] fatal', e?.message); process.exit(1); });
}

module.exports = { processBatch };
