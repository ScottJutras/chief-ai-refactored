// handlers/commands/team.js
const { query, normalizePhoneNumber } = require('../../services/postgres');
const { releaseLock } = require('../../middleware/lock');

function cleanPhone(p = '') {
  // Strip unicode LRM/LRE/RLM etc + whitespace, keep leading +
  const stripped = String(p).replace(/[\u200E\u200F\u202A-\u202E]/g, '').trim();
  // Keep "+" and digits only
  const plus = stripped.startsWith('+') ? '+' : '';
  const digits = stripped.replace(/[^\d]/g, '');
  return digits ? plus + digits : '';
}

function looksLikeAdd(s='') {
  const t = s.toLowerCase();
  return t.startsWith('add teammate') || t.startsWith('add team member') || t.startsWith('add member');
}
function looksLikeRemove(s='') {
  const t = s.toLowerCase();
  return t.startsWith('remove teammate') || t.startsWith('remove team member') || t.startsWith('remove member');
}

function parseAdd(input='') {
  // Supports:
  // "add teammate Jaclyn +15199652188"
  // "add team member Jaclyn +1 519 965 2188"
  // "add member Jaclyn 15199652188"
  const m = input.match(/^(?:add\s+(?:team(?:\s*mate|\s+member)?|member))\s+(.+?)\s+([+()\-.\s\d]+)\s*$/i);
  if (!m) return null;
  return { name: m[1].trim(), rawPhone: m[2].trim() };
}
function parseRemove(input='') {
  // "remove teammate +15199652188" OR "remove teammate Jaclyn"
  const byPhone = input.match(/^(?:remove\s+(?:team(?:\s*mate|\s+member)?|member))\s+([+()\-.\s\d]{7,})\s*$/i);
  if (byPhone) return { phoneOrName: byPhone[1].trim() };
  const byName = input.match(/^(?:remove\s+(?:team(?:\s*mate|\s+member)?|member))\s+([A-Za-z][\w .'\-]{1,50})\s*$/i);
  if (byName) return { phoneOrName: byName[1].trim() };
  return null;
}

module.exports = async function handleTeam(from, input, userProfile, ownerId, ownerProfile, isOwner) {
  const lockKey = `lock:${from}`;
  try {
    if (!isOwner) {
      return `<Response><Message>⚠️ Only the owner can manage team members.</Message></Response>`;
    }

    const body = String(input || '').trim();

    // LIST
    if (/^\s*team\s*$/i.test(body)) {
      const { rows } = await query(
        `select user_id, name, phone, role
           from users
          where owner_id = $1 and is_team_member = true
          order by (case when role='owner' then 0 else 1 end), coalesce(name, phone)`,
        [ownerId]
      );
      if (!rows.length) {
        return `<Response><Message>No team members yet. Try: "add teammate Jaclyn +15195551234"</Message></Response>`;
      }
      const lines = rows.map((r,i) => `${i+1}. ${r.name ? r.name : r.phone || r.user_id}`);
      return `<Response><Message>📋 Team Members:\n${lines.join('\n')}</Message></Response>`;
    }

    // ADD
    if (looksLikeAdd(body)) {
      const parsed = parseAdd(body);
      if (!parsed) {
        return `<Response><Message>⚠️ Try: "add teammate &lt;Name&gt; &lt;+1XXXXXXXXXX&gt;"</Message></Response>`;
      }
      const name = parsed.name;
      const phoneClean = cleanPhone(parsed.rawPhone);
      if (!/^\+?\d{10,15}$/.test(phoneClean)) {
        return `<Response><Message>⚠️ Please provide a valid phone number, e.g., +15195551234</Message></Response>`;
      }
      const userId = normalizePhoneNumber ? normalizePhoneNumber(phoneClean) : phoneClean.replace(/[^\d]/g,'');
      await query(
        `insert into users (user_id, owner_id, name, phone, is_team_member, role, created_at)
         values ($1,$2,$3,$4,true,'member', now())
         on conflict (user_id) do update
           set owner_id = excluded.owner_id,
               name = coalesce(excluded.name, users.name),
               phone = coalesce(excluded.phone, users.phone),
               is_team_member = true,
               updated_at = now()`,
        [userId, ownerId, name || null, phoneClean]
      );
      return `<Response><Message>✅ Added teammate ${name ? name+' ' : ''}${phoneClean}.</Message></Response>`;
    }

    // REMOVE
    if (looksLikeRemove(body)) {
      const parsed = parseRemove(body);
      if (!parsed) {
        return `<Response><Message>⚠️ Try: "remove teammate +15195551234" or "remove teammate Jaclyn"</Message></Response>`;
      }
      const token = parsed.phoneOrName;
      let result;
      if (/^\+?[\d()\-.\s]{7,}$/.test(token)) {
        const phoneClean = cleanPhone(token);
        const userId = phoneClean.replace(/[^\d]/g,'');
        result = await query(
          `update users set is_team_member=false, updated_at=now()
             where owner_id=$1 and (user_id=$2 or phone=$3) and is_team_member=true`,
          [ownerId, userId, phoneClean]
        );
      } else {
        result = await query(
          `update users set is_team_member=false, updated_at=now()
             where owner_id=$1 and lower(name)=lower($2) and is_team_member=true`,
          [ownerId, token]
        );
      }
      if (result.rowCount === 0) {
        return `<Response><Message>⚠️ I couldn’t find that teammate.</Message></Response>`;
      }
      return `<Response><Message>✅ Removed teammate ${token}.</Message></Response>`;
    }

    // Help
    return `<Response><Message>Try:
- "team"
- "add teammate Jaclyn +15195551234"
- "remove teammate Jaclyn"</Message></Response>`;
  } catch (err) {
    console.error('[team] error:', err.message);
    return `<Response><Message>⚠️ Team error: ${err.message}</Message></Response>`;
  } finally {
    try { await releaseLock(lockKey); } catch {}
  }
};
