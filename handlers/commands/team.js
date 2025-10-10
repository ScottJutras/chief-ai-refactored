const { query } = require('../../services/postgres');
const { releaseLock } = require('../../middleware/lock');

async function handleTeam(from, input, userProfile, ownerId, ownerProfile, isOwner) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    if (!isOwner) {
      reply = "⚠️ Only the owner can manage team members.";
      return `<Response><Message>${reply}</Message></Response>`;
    }

    const lcInput = input.toLowerCase().trim();
    if (lcInput.startsWith('add member')) {
      const phoneNumber = input.match(/add member\s+(\+\d{10,})/i)?.[1];
      if (!phoneNumber) {
        reply = "⚠️ Please provide a valid phone number. Try: 'add member +1234567890'";
        return `<Response><Message>${reply}</Message></Response>`;
      }

      await query(
        `UPDATE users
         SET team_members = COALESCE(team_members, '[]'::jsonb) || $1::jsonb
         WHERE user_id = $2`,
        [JSON.stringify([phoneNumber]), ownerId]
      );
      await query(
        `INSERT INTO users (user_id, owner_id, is_team_member, created_at)
         VALUES ($1, $2, true, NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET owner_id = $2, is_team_member = true, updated_at = NOW()`,
        [phoneNumber.replace(/\D/g, ''), ownerId]
      );
      reply = `✅ Added team member ${phoneNumber}.`;
      return `<Response><Message>${reply}</Message></Response>`;
    } else if (lcInput.startsWith('remove member')) {
      const phoneNumber = input.match(/remove member\s+(\+\d{10,})/i)?.[1];
      if (!phoneNumber) {
        reply = "⚠️ Please provide a valid phone number. Try: 'remove member +1234567890'";
        return `<Response><Message>${reply}</Message></Response>`;
      }

      await query(
        `UPDATE users
         SET team_members = team_members - $1
         WHERE user_id = $2`,
        [phoneNumber, ownerId]
      );
      await query(
        `DELETE FROM users WHERE user_id = $1`,
        [phoneNumber.replace(/\D/g, '')]
      );
      reply = `✅ Removed team member ${phoneNumber}.`;
      return `<Response><Message>${reply}</Message></Response>`;
    } else if (lcInput === 'team') {
      const res = await query(
        `SELECT team_members FROM users WHERE user_id = $1`,
        [ownerId]
      );
      const teamMembers = res.rows[0]?.team_members || [];
      reply = teamMembers.length
        ? `📋 Team Members:\n${teamMembers.map((member, i) => `${i + 1}. ${member}`).join('\n')}`
        : "No team members added yet. Use 'add member +1234567890' to add one.";
      return `<Response><Message>${reply}</Message></Response>`;
    }

    reply = "⚠️ Invalid team command. Try: 'team', 'add member +1234567890', 'remove member +1234567890'";
    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleTeam failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process team command: ${error.message}`;
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    await releaseLock(lockKey);
  }
}

module.exports = { handleTeam };