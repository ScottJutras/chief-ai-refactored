// services/db.js
// Lightweight query helpers.
// Alignment: postgres module exports vary; normalize to a callable query().

const pg = require('./postgres');
const query =
  pg.query ||
  pg.pool?.query ||
  pg.db?.query ||
  (typeof pg === 'function' ? pg : null);

if (typeof query !== 'function') {
  throw new Error('[services/db] postgres.query is not available');
}

async function getOne(sql, params) {
  const { rows } = await query(sql, params);
  return rows[0] || null;
}

async function getMany(sql, params) {
  const { rows } = await query(sql, params);
  return rows || [];
}

async function insertOneReturning(sql, params) {
  const { rows } = await query(sql, params);
  return rows[0] || null;
}

module.exports = { query, getOne, getMany, insertOneReturning };
