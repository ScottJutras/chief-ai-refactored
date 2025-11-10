const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });


async function whosOn(owner_id) {
const { rows } = await db.query(`
SELECT u.display_name AS name, j.name AS job, te.start_at_utc AS since
FROM time_entries te
JOIN users u ON u.id = te.user_id
JOIN jobs j ON j.id = te.job_id
WHERE te.owner_id=$1 AND te.kind='shift' AND te.end_at_utc IS NULL
ORDER BY te.start_at_utc
`,[owner_id]);
if (!rows.length) return 'Nobody is clocked in.';
return rows.map(r => `• ${r.name} @ ${r.job} since ${new Date(r.since).toLocaleTimeString()}`).join('\n');
}


async function labourToday(owner_id, job_id) {
const day = new Date().toISOString().slice(0,10);
const { rows } = await db.query(`SELECT paid_minutes, drive_minutes, ot_minutes, labour_cost_cents, breakdown FROM job_kpis_daily WHERE owner_id=$1 AND job_id=$2 AND day=$3`, [owner_id, job_id, day]);
if (!rows[0]) return 'No labour recorded today.';
const m = rows[0];
const h = Math.floor(m.paid_minutes/60), mm = m.paid_minutes%60;
return `Labour today: ${h}h ${mm}m paid, drive ${m.drive_minutes}m, OT ${m.ot_minutes}m, cost $${(m.labour_cost_cents/100).toFixed(2)}`;
}


module.exports = { whosOn, labourToday };