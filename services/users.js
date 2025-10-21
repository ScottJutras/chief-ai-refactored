// services/users.js
const { query } = require('./postgres');

function normalizeId(s = '') {
  return String(s).replace(/[^\d]/g, '');
}

/**
 * Find a teammate by NAME within an owner's team.
 * Returns { user_id, name, phone, is_team_member } or null.
 */
async function getUserByName(ownerId, name) {
  const { rows } = await query(
    `select user_id, name, /* phone, */ is_team_member
       from users
      where owner_id = $1
        and is_team_member = true
        and lower(name) = lower($2)
      limit 1`,
    [ownerId, String(name || '').trim()]
  );
  return rows[0] || null;
}

/**
 * Find a user by their canonical id (digits only).
 * Returns { user_id, name, phone, owner_id, is_team_member } or null.
 */
async function getUserBasic(userIdOrPhone) {
  const id = normalizeId(userIdOrPhone);
  const { rows } = await query(
    `select user_id, name, /* phone, */ owner_id, is_team_member
       from users
      where user_id = $1
      limit 1`,
    [id]
  );
  return rows[0] || null;
}

module.exports = { getUserByName, getUserBasic };
