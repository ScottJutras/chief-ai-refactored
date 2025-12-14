// handlers/commands/teamSetup.js
// Onboarding: "yes/no" → add employees → finish stage.
const pg = require('../../services/postgres');
const { sendQuickReply } = require('../../services/twilio');

const RESP = (t) => `<Response><Message>${t}</Message></Response>`;

module.exports = async function handleTeamSetup(
  from, input, userProfile, ownerId, _ownerProfile, isOwner, res
) {
  if (!isOwner) return res.send(RESP(`Only owners can set up the team.`));
  const lc = String(input || '').toLowerCase().trim();

  // YES → start adding employees
  if (lc === 'yes') {
    await pg.query(`UPDATE users SET current_stage='addEmployees' WHERE user_id=$1`, [ownerId]);
    return res.send(RESP(`Great! Add employees: "John, Manager"`));
  }

  // NO → skip to training
  if (lc === 'no') {
    await pg.query(
      `UPDATE users SET current_stage='training', onboarding_in_progress=false WHERE user_id=$1`,
      [ownerId]
    );
    return res.send(RESP(`Skipping team setup. Reply "start training" to learn.`));
  }

  // ADD EMPLOYEE (current_stage = addEmployees)
  if (userProfile.current_stage === 'addEmployees') {
    const [name, role] = input.split(',').map(s => s.trim());
    if (!name || !role) return res.send(RESP(`Format: "John, Manager"`));
    await pg.query(
      `INSERT INTO employees (owner_id, name, role, created_at)
       VALUES ($1,$2,$3,NOW())`,
      [ownerId, name, role]
    );
    await sendQuickReply(
      from,
      `Added **${name}** as ${role}. Add another?`,
      ['Yes', 'No']
    );
    return res.send(`<Response></Response>`);
  }

  return res.send(RESP(`Reply "yes" or "no" to add employees.`));
};