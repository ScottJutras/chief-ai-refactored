// services/users.js
const { query } = require('./postgres');

function normalizeId(s = '') {
  return String(s).replace(/[^\d]/g, '');
}

// Find teammate by exact name (case-insensitive)
async function getUserByName(ownerId, name) {
  const { rows } = await query(
    `SELECT user_id, name, is_team_member
       FROM public.users
      WHERE owner_id=$1
        AND is_team_member=true
        AND lower(name)=lower($2)
      LIMIT 1`,
    [ownerId, String(name || '').trim()]
  );
  return rows[0] || null;
}

// Find any user by canonical id (digits only)
async function getUserBasic(userIdOrPhone) {
  const id = normalizeId(userIdOrPhone);
  const { rows } = await query(
    `SELECT user_id, name, owner_id, is_team_member
       FROM public.users
      WHERE user_id=$1
      LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

module.exports = { getUserByName, getUserBasic };