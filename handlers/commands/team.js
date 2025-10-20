// handlers/commands/team.js
// Supports:
//   • "team" → list teammates
//   • "add teammate <Name> <Phone>"  or  "add member <Name> <Phone>"
//   • "remove teammate <Name|Phone>" or  "remove member <Name|Phone>"
//
// Notes:
//  - Writes real teammate rows into public.users so tasks.js can resolve assignees by name.
//  - Does NOT call releaseLock here (router handles it in finally).

const { query, normalizePhoneNumber } = require('../../services/postgres');

const RESP = (t) => `<Response><Message>${t}</Message></Response>`;

async function handleTeam(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  try {
    if (!isOwner) {
      return res.send(RESP('⚠️ Only the owner can manage team members.'));
    }

    const body = String(input || '').trim();

    // ---- LIST ----
    if (/^teams?$/i.test(body)) {
      const { rows } = await query(
        `
        SELECT COALESCE(NULLIF(TRIM(name), ''), phone) AS label,
               name, phone, role
          FROM public.users
         WHERE owner_id = $1
           AND user_id <> $1               -- exclude the owner "self" row if present
           AND (is_team_member = TRUE OR role IS NOT NULL)
         ORDER BY (CASE WHEN role='owner' THEN 0 ELSE 1 END), LOWER(label)
        `,
        [ownerId]
      );

      if (!rows.length) {
        return res.send(
          RESP(`No teammates yet. Add one:\nadd teammate Justin +19055551234`)
        );
      }

      const lines = rows.map(r => {
        const who = r.name || r.phone;
        const role = r.role || 'employee';
        return `• ${who} (${role})`;
      });

      return res.send(RESP(`👥 Team:\n${lines.join('\n')}`));
    }

    // ---- ADD ----
    // "add teammate <Name> <Phone>" OR "add member <Name> <Phone>"
    {
      const m = body.match(/^add\s+(?:teammate|member)\s+([a-z][\w\s.'-]{1,50})\s+(\+?\d{10,15})$/i);
      if (m) {
        const nameRaw = m[1].trim();
        const phoneRaw = m[2].trim();
        const phone = normalizePhoneNumber ? normalizePhoneNumber(phoneRaw) : phoneRaw.replace(/\D/g, '').replace(/^1?/, '+1'); // simple fallback

        // Upsert a concrete teammate row your other logic can find
        // user_id is commonly the phone; adjust if your schema differs.
        await query(
          `
          INSERT INTO public.users (user_id, owner_id, name, phone, role, is_team_member, created_at)
          VALUES ($1, $2, $3, $4, 'employee', TRUE, NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            owner_id       = EXCLUDED.owner_id,
            name           = EXCLUDED.name,
            phone          = EXCLUDED.phone,
            role           = EXCLUDED.role,
            is_team_member = TRUE,
            updated_at     = NOW()
          `,
          [phone.replace(/\D/g, ''), ownerId, nameRaw, phone]
        );

        return res.send(RESP(`✅ Added teammate ${nameRaw} (${phone}). You can now “assign task #12 to ${nameRaw}”.`));
      }
    }

    // ---- REMOVE ----
    // "remove teammate <Name|Phone>" OR "remove member <Name|Phone>"
    {
      const m = body.match(/^remove\s+(?:teammate|member)\s+(.+)$/i);
      if (m) {
        const token = m[1].trim();
        let byPhone = null;
        let byName = null;

        if (/^\+?\d{10,15}$/.test(token)) {
          byPhone = normalizePhoneNumber ? normalizePhoneNumber(token) : token.replace(/\D/g, '');
        } else {
          byName = token;
        }

        // Don’t delete the owner row.
        const { rowCount } = await query(
          `
          DELETE FROM public.users
           WHERE owner_id = $1
             AND role <> 'owner'
             AND (
               ($2::text IS NOT NULL AND (phone = $2 OR user_id = REGEXP_REPLACE($2, '\\D', '', 'g')))
               OR
               ($3::text IS NOT NULL AND LOWER(name) = LOWER($3))
             )
          `,
          [ownerId, byPhone, byName]
        );

        if (!rowCount) {
          return res.send(RESP(`⚠️ I couldn’t find that teammate. Try a full phone (“+1905…”) or exact name.`));
        }

        return res.send(RESP(`🗑 Removed teammate ${token}.`));
      }
    }

    // ---- HELP / DEFAULT ----
    return res.send(
      RESP(
        `Try:
• team
• add teammate Justin +19055551234
• remove teammate Justin`
      )
    );
  } catch (error) {
    console.error('[team] error:', error.message);
    return res.send(RESP('⚠️ Team error: ' + error.message));
  }
}

module.exports = handleTeam;
