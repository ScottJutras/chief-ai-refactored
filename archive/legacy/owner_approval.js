// handlers/commands/owner_approval.js
// Owner‑only: "approve Justin as team" / "approve Jane as board"
// Enforces seat limits + closes open approval tasks.
const pg = require('../../services/postgres');
const { releaseLock } = require('../../middleware/lock');

const VALID_ROLES = new Set(['board', 'team', 'accountant']);
const ROLE_ALIASES = {
  board: 'board', 'boardmember': 'board', 'board-member': 'board',
  team: 'team', 'teammember': 'team', 'team-member': 'team',
  accountant: 'accountant', acct: 'accountant', accounting: 'accountant',
};
const SEAT_LIMITS = {
  starter:    { board: 3, team: 7, accountant: 0 },
  pro:        { board: 3, team: 7, accountant: 1 },
  enterprise: { board: 3, team: 7, accountant: 3 },
};

const RESP = (t) => `<Response><Message>${t}</Message></Response>`;

function titleCase(s = '') {
  return String(s).trim().split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}
function norm(s = '') {
  return String(s).normalize('NFKC').replace(/\s{2,}/g, ' ').trim();
}
function parseApprove(input) {
  const m = norm(input).match(/^approve\s+(.+?)\s+as\s+([a-z _-]+)$/i);
  if (!m) return null;
  const name = titleCase(m[1]);
  const roleKey = m[2].replace(/\s|_/g, '-').toLowerCase();
  const role = ROLE_ALIASES[roleKey] || null;
  return role && VALID_ROLES.has(role) ? { name, role } : null;
}
async function findCandidates(ownerId, name) {
  const like = `%${name}%`;
  const { rows } = await pg.query(
    `SELECT user_id, name, role FROM users
      WHERE owner_id=$1 AND name ILIKE $2
      ORDER BY created_at DESC LIMIT 5`,
    [ownerId, like]
  );
  return rows;
}
async function enforceLimit(ownerId, role) {
  const { rows } = await pg.query(
    `SELECT subscription_tier FROM users WHERE user_id=$1 LIMIT 1`,
    [ownerId]
  );
  const tier = (rows[0]?.subscription_tier || 'starter').toLowerCase();
  const limits = SEAT_LIMITS[tier] || SEAT_LIMITS.starter;
  const { rows: cnt } = await pg.query(
    `SELECT COUNT(*) AS c FROM users
      WHERE owner_id=$1 AND approved_at IS NOT NULL AND role=$2`,
    [ownerId, role]
  );
  if ((cnt[0]?.c || 0) >= (limits[role] || 0)) {
    throw new Error(`Seat limit reached for ${role} (tier: ${tier}).`);
  }
}
async function closeApprovalTasks(ownerId, personName) {
  try {
    await pg.query(
      `UPDATE tasks SET status='closed', closed_at=NOW()
        WHERE owner_id=$1 AND status='open' AND title ILIKE $2`,
      [ownerId, `%${personName}%`]
    );
  } catch {}
}
module.exports = async function handleOwnerApproval(
  from, input, userProfile, ownerId, ownerProfile, isOwner, res
) {
  try {
    if (!isOwner) return res.send(RESP(`Only the Owner can approve roles.`));
    const parsed = parseApprove(input);
    if (!parsed) return res.send(RESP(`Try: "approve Justin as team"`));
    const { name, role } = parsed;
    const candidates = await findCandidates(ownerId, name);
    if (!candidates.length) return res.send(RESP(`No user found matching "${name}".`));
    const person = candidates.find(c => c.name.toLowerCase() === name.toLowerCase()) || candidates[0];
    if (person.name.toLowerCase() === (ownerProfile?.name || '').toLowerCase()) {
      return res.send(RESP(`Cannot re‑assign the Owner.`));
    }
    await enforceLimit(ownerId, role);
    const upd = await pg.query(
      `UPDATE users SET role=$1, approved_at=NOW()
        WHERE user_id=$2 AND owner_id=$3
        RETURNING name, role`,
      [role, person.user_id, ownerId]
    );
    if (!upd.rowCount) return res.send(RESP(`Could not update ${name}.`));
    await closeApprovalTasks(ownerId, name);
    return res.send(RESP(`${titleCase(name)} approved as **${role}**.`));
  } catch (e) {
    const msg = /limit/i.test(e.message) ? e.message : `Approval error.`;
    console.warn('[owner_approval] error:', e?.message);
    return res.send(RESP(msg));
  } finally {
    await releaseLock(`lock:${ownerId || from}`);
  }
};