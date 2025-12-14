// handlers/commands/team.js
// Owner‑only: list / add / remove teammates.
const pg = require('../../services/postgres');
const { releaseLock } = require('../../middleware/lock');

function mask(p = '') {
  const d = String(p).replace(/\D/g, '');
  return d.length < 6 ? d : `${d.slice(0,4)}…${d.slice(-2)}`;
}
function cleanPhone(p = '') {
  const s = String(p).replace(/[\u200E\u200F\u202A-\u202E]/g, '').trim();
  const plus = s.startsWith('+') ? '+' : '';
  return plus + s.replace(/[^\d]/g, '');
}
function looksLikeAdd(s = '') { return /^(add\s+(?:team(?:mate| member)|member))/i.test(s); }
function looksLikeRemove(s = '') { return /^(remove\s+(?:team(?:mate| member)|member))/i.test(s); }
function parseAdd(s = '') {
  const m = s.match(/^(?:add\s+(?:team(?:mate| member)|member))\s+(.+?)\s+([+()\-\.\s\d]+)$/i);
  return m ? { name: m[1].trim(), raw: m[2].trim() } : null;
}
function parseRemove(s = '') {
  const byPhone = s.match(/^(?:remove\s+(?:team(?:mate| member)|member))\s+([+()\-\.\s\d]{7,})$/i);
  if (byPhone) return { token: byPhone[1].trim() };
  const byName = s.match(/^(?:remove\s+(?:team(?:mate| member)|member))\s+([A-Za-z][\w .'\-]{1,50})$/i);
  return byName ? { token: byName[1].trim() } : null;
}
const RESP = (t) => `<Response><Message>${t}</Message></Response>`;

module.exports = async function handleTeam(
  from, input, _userProfile, ownerId, _ownerProfile, isOwner, res
) {
  try {
    if (!isOwner) return res.send(RESP(`Only the Owner can manage the team.`));
    const body = String(input || '').trim();

    // LIST
    if (/^\s*team\s*$/i.test(body)) {
      const { rows } = await pg.query(
        `SELECT user_id, name, role FROM users
          WHERE owner_id=$1 AND is_team_member=true
          ORDER BY (CASE WHEN role='owner' THEN 0 ELSE 1 END), name`,
        [ownerId]
      );
      if (!rows.length) return res.send(RESP(`No teammates yet. Try "add teammate Jaclyn +15195551234"`));
      const lines = rows.map(r => `${r.name ? r.name : `+${mask(r.user_id)}`}${r.role === 'owner' ? ' (owner)' : ''}`);
      return res.send(RESP(`Team:\n${lines.map((l,i) => `${i+1}. ${l}`).join('\n')}`));
    }

    // ADD
    if (looksLikeAdd(body)) {
      const p = parseAdd(body);
      if (!p) return res.send(RESP(`Try: "add teammate <Name> <+1XXXXXXXXXX>"`));
      const phone = cleanPhone(p.raw);
      if (!/^\+?\d{10,15}$/.test(phone)) return res.send(RESP(`Invalid phone.`));
      const userId = phone.replace(/[^\d]/g, '');
      await pg.query(
        `INSERT INTO users (user_id, owner_id, name, is_team_member, role, created_at)
         VALUES ($1,$2,$3,true,'member',NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET owner_id=excluded.owner_id, name=COALESCE(excluded.name,users.name),
               is_team_member=true, updated_at=NOW()`,
        [userId, ownerId, p.name || null]
      );
      return res.send(RESP(`Added **${p.name || ''}** ${phone}.`));
    }

    // REMOVE
    if (looksLikeRemove(body)) {
      const p = parseRemove(body);
      if (!p) return res.send(RESP(`Try: "remove teammate <Name>" or "<+1XXXXXXXXXX>"`));
      let result;
      if (/^\+?[\d()\-.\s]{7,}$/.test(p.token)) {
        const phone = cleanPhone(p.token);
        const userId = phone.replace(/[^\d]/g, '');
        result = await pg.query(
          `UPDATE users SET is_team_member=false, updated_at=NOW()
            WHERE owner_id=$1 AND user_id=$2 AND is_team_member=true`,
          [ownerId, userId]
        );
      } else {
        result = await pg.query(
          `UPDATE users SET is_team_member=false, updated_at=NOW()
            WHERE owner_id=$1 AND LOWER(name)=LOWER($2) AND is_team_member=true`,
          [ownerId, p.token]
        );
      }
      return result.rowCount
        ? res.send(RESP(`Removed **${p.token}**.`))
        : res.send(RESP(`Teammate not found.`));
    }

    return res.send(RESP(`Try "team", "add teammate …", or "remove teammate …".`));
  } catch (e) {
    console.error('[team] error:', e?.message);
    return res.send(RESP(`Team error.`));
  } finally {
    await releaseLock(`lock:${ownerId || from}`);
  }
};