// handlers/commands/owner_approval.js
// Owner-only: "approve Justin as team" / "approve Jane Doe as board"
// Enforces tier seat limits (board/team fixed; accountant depends on tier).
// Closes any open "Role approval needed" tasks for that person.

const { pool } = require('../../services/postgres');

// ----- roles & limits -----
const VALID_ROLES = new Set(['board', 'team', 'accountant']);
const ROLE_ALIASES = {
  board: 'board',
  'boardmember': 'board',
  'board-member': 'board',
  'board_members': 'board',
  'board_member': 'board',
  team: 'team',
  'teammember': 'team',
  'team-member': 'team',
  'team_members': 'team',
  'team_member': 'team',
  accountant: 'accountant',
  acct: 'accountant',
  accounting: 'accountant',
};

/**
 * Seat limits per subscription tier
 * - Board: 3 seats
 * - Team: 7 seats
 * - Accountant: 0 for starter, 1 for pro, 3 for enterprise
 */
const SEAT_LIMITS = {
  starter:     { board: 3, team: 7, accountant: 0 },
  pro:         { board: 3, team: 7, accountant: 1 },
  enterprise:  { board: 3, team: 7, accountant: 3 },
};

// ----- utils -----
const titleCase = (s='') => String(s).trim().split(/\s+/).map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
const normSpace = (s='') => String(s).normalize('NFKC').replace(/\s{2,}/g,' ').trim();
const twiml = (msg) => `<Response><Message>${msg}</Message></Response>`;

/**
 * Parse: "approve Justin as team"
 * Also handles minor variants: "approve  Justin   as   board", "approve Jane-Doe as accountant"
 * Returns { name, role } or null if not parseable.
 */
function parseApproveCommand(input) {
  const s = normSpace(input).toLowerCase();
  // pattern: approve <name> as <role>
  const m = s.match(/^approve\s+(.+?)\s+as\s+([a-z _-]+)$/i);
  if (!m) return null;

  const rawName = titleCase(m[1]);
  const roleKey = m[2].replace(/\s|_/g, '-').toLowerCase();
  const canonical = ROLE_ALIASES[roleKey] || ROLE_ALIASES[roleKey.replace(/-+/g,'')];
  if (!canonical || !VALID_ROLES.has(canonical)) return { name: rawName, role: null };

  return { name: rawName, role: canonical };
}

/**
 * Find users by name (ILIKE) under the owner (tenant).
 * NOTE: your schema assumption:
 * users(user_id, owner_id, name, role, approved_at, created_at, subscription_tier for owner row)
 */
async function findPeopleByName(ownerId, name) {
  const q = `%${name.replace(/\s+/g,' ').trim()}%`;
  const { rows } = await pool.query(
    `SELECT user_id AS id, name, role, approved_at
       FROM users
      WHERE owner_id = $1
        AND name ILIKE $2
      ORDER BY created_at DESC
      LIMIT 5`,
    [ownerId, q]
  );
  return rows || [];
}

/**
 * Enforce seat limits by tier.
 */
async function enforceSeatLimitOrThrow(ownerId, role) {
  const { rows: tierRows } = await pool.query(
    `SELECT subscription_tier FROM users WHERE user_id = $1 LIMIT 1`,
    [ownerId]
  );
  const tier = (tierRows?.[0]?.subscription_tier || 'starter').toLowerCase();
  const limits = SEAT_LIMITS[tier] || SEAT_LIMITS.starter;

  // Count current approved users by role
  const { rows: counts } = await pool.query(
    `SELECT role, COUNT(*)::int AS count
       FROM users
      WHERE owner_id = $1
        AND approved_at IS NOT NULL
      GROUP BY role`,
    [ownerId]
  );
  const current = counts.reduce((acc, r) => {
    acc[(r.role || '').toLowerCase()] = r.count || 0;
    return acc;
  }, {});

  if ((current[role] || 0) >= (limits[role] || 0)) {
    throw new Error(`Role limit reached for ${role} (tier: ${tier}).`);
  }
}

/**
 * Approve/assign role for a given personId under ownerId.
 * Returns the updated person row.
 */
async function approvePerson(ownerId, personId, role) {
  // Enforce tier limits
  await enforceSeatLimitOrThrow(ownerId, role);

  const { rows } = await pool.query(
    `UPDATE users
        SET role = $1,
            approved_at = NOW()
      WHERE user_id = $2
        AND owner_id = $3
      RETURNING user_id AS id, name, role, approved_at`,
    [role, personId, ownerId]
  );
  return rows?.[0] || null;
}

/**
 * Best-effort close any open "Role approval" tasks for the person.
 * If your tasks schema differs, adjust or remove this function.
 */
async function closeApprovalTasks(ownerId, personName) {
  try {
    await pool.query(
      `UPDATE tasks
          SET status = 'closed',
              closed_at = NOW()
        WHERE owner_id = $1
          AND status IN ('open','todo','pending')
          AND title ILIKE $2`,
      [ownerId, `%${personName}%`]
    );
  } catch (e) {
    console.warn('[owner_approval] closeApprovalTasks skipped:', e?.message);
  }
}

// ----- main handler -----
async function handleOwnerApproval(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  try {
    // Owner gate
    if (!isOwner) {
      return res
        .status(200)
        .type('text/xml')
        .send(twiml('⛔ Only the Owner can approve and assign roles.'));
    }

    const parsed = parseApproveCommand(input);
    if (!parsed) {
      const help =
        'Try: "approve Justin as team", "approve Jane Doe as board", or "approve Chris Smith as accountant".';
      return res.status(200).type('text/xml').send(twiml(help));
    }
    if (!parsed.role) {
      return res
        .status(200)
        .type('text/xml')
        .send(twiml('⛔ Invalid role. Use "team", "board", or "accountant".'));
    }

    const requestedName = parsed.name;
    const role = parsed.role;

    // Never allow granting "owner" via chat
    if (role === 'owner') {
      return res
        .status(200)
        .type('text/xml')
        .send(twiml('⛔ You cannot assign the Owner role via chat.'));
    }

    // Look up candidates
    const candidates = await findPeopleByName(ownerId, requestedName);

    if (!candidates.length) {
      return res
        .status(200)
        .type('text/xml')
        .send(twiml(`⚠️ No user found matching "${requestedName}". Check the name and try again.`));
    }

    // If multiple candidates, prefer exact name match (case-insensitive), else first
    let person = candidates.find(c => (c.name || '').toLowerCase() === requestedName.toLowerCase());
    if (!person) person = candidates[0];

    // Block approving the actual Owner record (safety)
    const ownerName = titleCase(ownerProfile?.name || '');
    if ((person.name || '').toLowerCase() === (ownerName || '').toLowerCase()) {
      return res
        .status(200)
        .type('text/xml')
        .send(twiml('⛔ You cannot reassign the Owner via chat.'));
    }

    // Approve + assign role
    const updated = await approvePerson(ownerId, person.id, role);
    if (!updated) {
      return res
        .status(200)
        .type('text/xml')
        .send(twiml('⚠️ Could not update that user. Please try again.'));
    }

    // Close any open approval tasks
    await closeApprovalTasks(ownerId, updated.name);

    const msg = `✅ Approved ${titleCase(updated.name)} as ${updated.role}. They can now log time.`;
    return res.status(200).type('text/xml').send(twiml(msg));
  } catch (err) {
    // Surface friendly seat-limit errors; generic for others
    const friendly = /Role limit reached/i.test(err?.message)
      ? `⚠️ ${err.message}`
      : '⚠️ Error approving user. Please try again.';
    console.error('[owner_approval] error:', err?.message);
    return res.status(200).type('text/xml').send(twiml(friendly));
  }
}

module.exports = { handleOwnerApproval };
