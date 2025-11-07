// services/ai_confirm.js
// Ask–Confirm–Execute (ACE): generate a short confirmation, persist pending, resolve on yes/no
const crypto = require('crypto');
const pg = require('./postgres');

async function createPendingAction({ ownerId, from, cil, summary }) {
  const id = crypto.randomBytes(12).toString('hex');
  await pg.query(
    `INSERT INTO public.pending_actions (id, owner_id, user_id, summary, cil_json, status, created_at)
     VALUES ($1,$2,$3,$4,$5,'pending',NOW())`,
    [id, String(ownerId), String(from), summary, JSON.stringify(cil)]
  );
  return id;
}

async function resolvePendingAction(id, accepted) {
  const { rows } = await pg.query(
    `UPDATE public.pending_actions SET status=$2, resolved_at=NOW() WHERE id=$1 RETURNING owner_id, user_id, cil_json`,
    [id, accepted ? 'accepted' : 'rejected']
  );
  return rows[0] || null;
}

function shortConfirmForCIL(cil) {
  switch (cil.type) {
    case 'Clock': return `Clock ${cil.action.replace('_',' ')} ${cil.name ? cil.name+' ' : ''}${cil.job ? ' @ '+cil.job : ''} now?`;
    case 'CreateTask': return `Add task “${cil.title}”${cil.job ? ' @ '+cil.job : ''}${cil.assignee ? ' → '+cil.assignee : ''}?`;
    case 'Expense': return `Log expense $${(cil.amount_cents/100).toFixed(2)}${cil.vendor ? ' at '+cil.vendor : ''}${cil.job ? ' @ '+cil.job : ''}?`;
    case 'Quote': return `Create quote for ${cil.job} with ${cil.lines.length} line(s)?`;
    default: return 'Proceed?';
  }
}

module.exports = { createPendingAction, resolvePendingAction, shortConfirmForCIL };