const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });


async function upsertTimesheetRollups(owner_id, job_id, day) {
// Aggregate from time_entries for that (owner, job, day)
const { rows } = await db.query(`
WITH r AS (
SELECT
owner_id, user_id, job_id,
date_trunc('day', start_at_utc)::date AS day,
SUM(CASE WHEN kind='shift' THEN EXTRACT(EPOCH FROM (coalesce(end_at_utc, now()) - start_at_utc))/60 ELSE 0 END)::int AS total_shift_minutes,
SUM(CASE WHEN kind='break' THEN EXTRACT(EPOCH FROM (coalesce(end_at_utc, now()) - start_at_utc))/60 ELSE 0 END)::int AS break_total,
SUM(CASE WHEN kind='lunch' THEN EXTRACT(EPOCH FROM (coalesce(end_at_utc, now()) - start_at_utc))/60 ELSE 0 END)::int AS lunch_total,
SUM(CASE WHEN kind='drive' THEN EXTRACT(EPOCH FROM (coalesce(end_at_utc, now()) - start_at_utc))/60 ELSE 0 END)::int AS drive_total
FROM time_entries
WHERE owner_id=$1 AND job_id=$2 AND date_trunc('day', start_at_utc)::date=$3 AND end_at_utc IS NOT NULL
GROUP BY owner_id, user_id, job_id, day
)
SELECT * FROM r;
`, [owner_id, job_id, day]);


for (const row of rows) {
await db.query(`
INSERT INTO timesheet_rollups (owner_id,user_id,job_id,day,total_shift_minutes,break_total,lunch_total,drive_total)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT (owner_id, user_id, job_id, day)
DO UPDATE SET total_shift_minutes=$5, break_total=$6, lunch_total=$7, drive_total=$8
`, [row.owner_id,row.user_id,row.job_id,day,row.total_shift_minutes,row.break_total,row.lunch_total,row.drive_total]);
}
}
async function upsertJobKPIs(owner_id, job_id, day) {
// Join rollups + policy + user rates for costs
await db.query(`
WITH r AS (
SELECT * FROM timesheet_rollups WHERE owner_id=$1 AND job_id=$2 AND day=$3
), p AS (
SELECT * FROM employer_policies WHERE owner_id=$1
), u AS (
SELECT id AS user_id, hourly_rate_cents, coalesce(drive_rate_cents, hourly_rate_cents) AS drive_rate_cents
FROM users WHERE owner_id=$1
), j AS (
SELECT r.owner_id, r.job_id, r.day,
SUM(r.total_shift_minutes - GREATEST(0, r.break_total - p.paid_break_minutes) - (CASE WHEN p.lunch_paid THEN GREATEST(0, r.lunch_total - p.paid_lunch_minutes) ELSE r.lunch_total END))::int AS paid_minutes,
SUM(CASE WHEN p.drive_is_paid THEN r.drive_total ELSE 0 END)::int AS paid_drive_minutes,
SUM(r.break_total)::int AS break_minutes,
SUM(r.lunch_total)::int AS lunch_minutes,
SUM(r.drive_total)::int AS drive_minutes
FROM r CROSS JOIN p
GROUP BY r.owner_id, r.job_id, r.day
)
INSERT INTO job_kpis_daily (owner_id, job_id, day, paid_minutes, ot_minutes, labour_cost_cents, drive_minutes, drive_cost_cents, breakdown)
SELECT j.owner_id, j.job_id, j.day,
j.paid_minutes,
GREATEST(0, j.paid_minutes - (SELECT daily_ot_minutes FROM employer_policies WHERE owner_id=$1 LIMIT 1))::int AS ot_minutes,
COALESCE((SELECT SUM((r.total_shift_minutes - GREATEST(0, r.break_total - p.paid_break_minutes) - (CASE WHEN p.lunch_paid THEN GREATEST(0, r.lunch_total - p.paid_lunch_minutes) ELSE r.lunch_total END)) / 60.0 * u.hourly_rate_cents)
FROM timesheet_rollups r CROSS JOIN employer_policies p JOIN users u ON u.user_id = r.user_id
WHERE r.owner_id=$1 AND r.job_id=$2 AND r.day=$3), 0)::bigint AS labour_cost_cents,
j.drive_minutes,
COALESCE((SELECT SUM(r.drive_total / 60.0 * u.drive_rate_cents)
FROM timesheet_rollups r JOIN users u ON u.user_id = r.user_id
WHERE r.owner_id=$1 AND r.job_id=$2 AND r.day=$3), 0)::bigint AS drive_cost_cents,
jsonb_build_object('work', j.paid_minutes - j.break_minutes - j.lunch_minutes, 'drive', j.drive_minutes, 'break', j.break_minutes, 'lunch', j.lunch_minutes)
ON CONFLICT (owner_id, job_id, day)
DO UPDATE SET paid_minutes=EXCLUDED.paid_minutes, ot_minutes=EXCLUDED.ot_minutes, labour_cost_cents=EXCLUDED.labour_cost_cents,
drive_minutes=EXCLUDED.drive_minutes, drive_cost_cents=EXCLUDED.drive_cost_cents, breakdown=EXCLUDED.breakdown;
`, [owner_id, job_id, day]);
}


async function runKPIRefreshSweep() {
const { rows } = await db.query(`
WITH cte AS (
SELECT owner_id, job_id, day, MIN(inserted_at) AS first_seen
FROM kpi_touches
WHERE inserted_at <= now() - interval '5 seconds' -- debounce a bit
GROUP BY owner_id, job_id, day
)
DELETE FROM kpi_touches kt
USING cte
WHERE kt.owner_id=cte.owner_id AND kt.job_id=cte.job_id AND kt.day=cte.day
RETURNING cte.owner_id, cte.job_id, cte.day;
`);


for (const r of rows) {
await upsertTimesheetRollups(r.owner_id, r.job_id, r.day);
await upsertJobKPIs(r.owner_id, r.job_id, r.day);
}
}


module.exports = { runKPIRefreshSweep };