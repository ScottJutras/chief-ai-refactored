// services/qa_insights.js
// CFO answers backed by DB — fast, factual, no hallucinations
const pg = require('./postgres');


function startEndOfWindow(window = 'MTD', tz = 'America/Toronto') {
const now = new Date();
const local = new Date(now.toLocaleString('en-CA', { timeZone: tz }));
let start = new Date(local), end = new Date(local);
if (window === 'MTD') { start.setDate(1); start.setHours(0,0,0,0); end.setHours(23,59,59,999); }
// add more windows as needed (WTD, QTD, YTD)
return { startIso: start.toISOString(), endIso: end.toISOString() };
}


async function getCompanySnapshot({ ownerId, window = 'MTD', tz }) {
const { startIso, endIso } = startEndOfWindow(window, tz);
const o = String(ownerId).replace(/\D/g,'');


// Examples: adapt to your actual tables
const [{ rows: rev }] = await Promise.all([
pg.query(`SELECT COALESCE(sum(amount_cents),0)::bigint AS cents FROM revenues WHERE owner_id=$1 AND ts BETWEEN $2 AND $3`, [o, startIso, endIso]),
]);


// Derive simple metrics (expand as needed)
const revenue_cents = Number(rev?.[0]?.cents || 0);
// TODO: expenses, labor_hours, margin, effective_rate, AR, etc.


return { startIso, endIso, metrics: { revenue_cents } };
}


function formatSnapshotReply(s, tz) {
const revenue = `$${(s.metrics.revenue_cents/100).toLocaleString('en-CA')}`;
return `Here’s your MTD snapshot:\n• Revenue: ${revenue}\n• (Add: expenses, labour, margin, AR)\nWant a per-job breakdown?`;
}


module.exports = { getCompanySnapshot, formatSnapshotReply };