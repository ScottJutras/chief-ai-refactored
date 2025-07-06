const { db, admin } = require('../../services/firebase');
const { releaseLock } = require('../../middleware/lock');
const { sendTemplateMessage } = require('../../services/twilio');
const { confirmationTemplates } = require('../../config');

async function handleTeam(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    if (!isOwner) {
      reply = "⚠️ Only the owner can manage team members.";
      await releaseLock(lockKey);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    const lcInput = input.toLowerCase();
    if (lcInput.startsWith('add member')) {
      const phoneNumber = input.match(/add member\s+(\+\d{10,})/i)?.[1];
      if (!phoneNumber) {
        reply = "⚠️ Please provide a valid phone number. Try: 'add member +1234567890'";
        await releaseLock(lockKey);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      await db.collection('users').doc(ownerId).update({
        teamMembers: admin.firestore.FieldValue.arrayUnion(phoneNumber)
      });
      await db.collection('users').doc(phoneNumber.replace(/\D/g, '')).set({
        user_id: phoneNumber,
        ownerId,
        isTeamMember: true,
        created_at: new Date().toISOString()
      }, { merge: true });
      reply = `✅ Added team member ${phoneNumber}.`;
      await sendTemplateMessage(from, confirmationTemplates.teamAdd, [
        { type: 'text', text: phoneNumber }
      ]);
      await releaseLock(lockKey);
      return res.send(`<Response></Response>`);
    } else if (lcInput.startsWith('remove member')) {
      const phoneNumber = input.match(/remove member\s+(\+\d{10,})/i)?.[1];
      if (!phoneNumber) {
        reply = "⚠️ Please provide a valid phone number. Try: 'remove member +1234567890'";
        await releaseLock(lockKey);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      await db.collection('users').doc(ownerId).update({
        teamMembers: admin.firestore.FieldValue.arrayRemove(phoneNumber)
      });
      await db.collection('users').doc(phoneNumber.replace(/\D/g, '')).delete();
      reply = `✅ Removed team member ${phoneNumber}.`;
      await releaseLock(lockKey);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else if (lcInput === 'team') {
      const teamMembers = ownerProfile.teamMembers || [];
      reply = teamMembers.length
        ? `📋 Team Members:\n${teamMembers.map((member, i) => `${i + 1}. ${member}`).join('\n')}`
        : "No team members added yet. Use 'add member +1234567890' to add one.";
      await releaseLock(lockKey);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    reply = "⚠️ Invalid team command. Try: 'team', 'add member +1234567890', 'remove member +1234567890'";
    await releaseLock(lockKey);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (error) {
    console.error(`Error in handleTeam: ${error.message}`);
    await releaseLock(lockKey);
    throw error;
  }
}

module.exports = { handleTeam };