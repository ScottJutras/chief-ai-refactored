const { sendMessage, sendTemplateMessage } = require('../services/twilio');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function handleTeamSetup(from, body, userProfile, ownerId, ownerProfile, isOwner) {
  if (!isOwner) {
    return `<Response><Message>⚠️ Only owners can manage team setup. Contact your owner.</Message></Response>`;
  }
  const lowerBody = body.toLowerCase();
  if (lowerBody === 'yes') {
    await pool.query(`UPDATE users SET current_stage = $1 WHERE phone = $2`, ['addEmployees', from]);
    return `<Response><Message>Great! Add employees by replying with their name and role (e.g., "John, Manager").</Message></Response>`;
  } else if (lowerBody === 'no') {
    await pool.query(`UPDATE users SET current_stage = $1, onboarding_in_progress = $2 WHERE phone = $3`, ['training', false, from]);
    return `<Response><Message>Skipping employee setup. Reply ‘start training’ to learn how to use PocketCFO.</Message></Response>`;
  } else if (userProfile.current_stage === 'addEmployees') {
    const [name, role] = body.split(',').map(s => s.trim());
    if (!name || !role) {
      return `<Response><Message>Please provide employee name and role (e.g., "John, Manager").</Message></Response>`;
    }
    await pool.query(
      `INSERT INTO employees (owner_id, name, role, created_at) VALUES ($1, $2, $3, $4)`,
      [ownerId, name, role, new Date().toISOString()]
    );
    await sendTemplateMessage(from, [{
      type: 'text',
      text: `Added ${name} as ${role}. Add another employee?`
    }], process.env.HEX_ADD_EMPLOYEES);
    return `<Response></Response>`;
  }
  return `<Response><Message>Invalid input. Reply ‘yes’ or ‘no’ to add employees, or try ‘help’.</Message></Response>`;
}
module.exports = { handleTeamSetup };