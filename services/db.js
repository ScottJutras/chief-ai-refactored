// services/db.js
const { query } = require('./postgres');

async function getOne(sql, params) {
  const { rows } = await query(sql, params);
  return rows[0] || null;
}

async function getMany(sql, params) {
  const { rows } = await query(sql, params);
  return rows;
}

async function insertOneReturning(sql, params) {
  const { rows } = await query(sql, params);
  return rows[0] || null;
}

module.exports = { query, getOne, getMany, insertOneReturning };
