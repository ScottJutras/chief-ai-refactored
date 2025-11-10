const { query } = require('./postgres');

async function findClosestTerm(q) {
  const s = String(q || '').toLowerCase().trim();
  if (!s) return null;
  const { rows } = await query(
    `SELECT term, meaning, cfo_map, nudge
       FROM public.rag_terms
      WHERE lower(term) = $1
      LIMIT 1`,
    [s]
  );
  return rows[0] || null;
}

module.exports = { findClosestTerm };
