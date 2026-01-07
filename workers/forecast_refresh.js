const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});



async function refreshForecastViews(){
// Use CONCURRENTLY if your Postgres supports it; fallback otherwise
await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY job_kpis_weekly');
await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY job_kpis_monthly');
await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY company_kpis_weekly');
await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY company_kpis_monthly');
}


module.exports = { refreshForecastViews };