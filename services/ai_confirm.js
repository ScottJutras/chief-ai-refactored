// services/ai_confirm.js
// Ask → Confirm → Execute (ACE) layer for natural-language commands
const OpenAI = require('openai');
const pg = require('./postgres');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// System prompt aligned to your North Star guardrails
const SYS = `
You are Chief's PocketCFO command router.
Output strict JSON with fields:
{
  "intent": "clock_in|clock_out|break_start|break_stop|drive_start|drive_stop|timesheet_week|undo_last|none",
  "employee_name": string|null,
  "job_name": string|null,
  "when": "now" | ISO8601 | null,
  "needs_confirmation": boolean,
  "confirm_text": string
}
Rules:
- If the user asks to perform a time action, set needs_confirmation=true and write a short human message in confirm_text like:
  "Confirm: clock IN Scott at 2025-11-05 08:11 @ Roofing Job?"
- Infer employee name from profile mention if not said. Default to the author.
- If ambiguous, set intent="none" and confirm_text asking a clarifying question with options.
- NEVER invent times in the past unless the user specified; use "now" otherwise.
`;
async function parseIntent({ text, employeeNameDefault }) {
  const user = text?.slice(0, 600) || '';
  const res = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: `Employee default: ${employeeNameDefault}\nUser said: ${user}` }
    ],
  });
  let data = {};
  try { data = JSON.parse(res.choices[0].message.content); } catch {}
  // Normalize
  data.intent = String(data.intent || 'none').toLowerCase();
  data.employee_name = data.employee_name || employeeNameDefault || null;
  data.job_name = data.job_name || null;
  data.when = data.when || 'now';
  data.needs_confirmation = !!data.needs_confirmation;
  data.confirm_text = data.confirm_text || '';
  return data;
}
// Convert parsed intent to execution
async function executeIntent({ ownerId, userId, tz, data }) {
  const now = new Date();
  const when = data.when === 'now' ? now : new Date(data.when);
  const name = data.employee_name;
  const job = data.job_name;
  // Enforce state machine using your existing validator (pulls from DB)
  // We reuse the same logic paths used by the command handler to avoid drift.
  switch (data.intent) {
    case 'clock_in':
      await pg.logTimeEntryWithJob(ownerId, name, 'clock_in', when, job, tz, { requester_id: userId });
      return `✅ ${name} is clocked in at ${local(when, tz)}`;
    case 'clock_out':
      // Optional: run a quick state check
      // If not open shift, return message instead of writing
      if (!(await hasOpenShift(ownerId, name))) return `Not clocked in. Use "clock in" first.`;
      await pg.logTimeEntryWithJob(ownerId, name, 'clock_out', when, job, tz, { requester_id: userId });
      // Auto-close open drive/break if you want: do it in DB trigger or here
      return `✅ ${name} is clocked out at ${local(when, tz)}`;
    case 'break_start':
      if (!(await hasOpenShift(ownerId, name))) return `Cannot start break — not clocked in.`;
      await pg.logTimeEntry(ownerId, name, 'break_start', when, null, tz, { requester_id: userId });
      return `✅ ${name} started break at ${local(when, tz)}`;
    case 'break_stop':
      await pg.logTimeEntry(ownerId, name, 'break_stop', when, null, tz, { requester_id: userId });
      return `✅ ${name} ended break at ${local(when, tz)}`;
    case 'drive_start':
      if (!(await hasOpenShift(ownerId, name))) return `Cannot start drive — not clocked in.`;
      await pg.logTimeEntry(ownerId, name, 'drive_start', when, null, tz, { requester_id: userId });
      return `✅ ${name} started drive at ${local(when, tz)}`;
    case 'drive_stop':
      await pg.logTimeEntry(ownerId, name, 'drive_stop', when, null, tz, { requester_id: userId });
      return `✅ ${name} ended drive at ${local(when, tz)}`;
    case 'timesheet_week':
      // Let your existing export path handle it via text command (or implement direct)
      return `Type "timesheet week" to generate your XLSX link.`;
    case 'undo_last':
      // Let the text command handle nuanced undo with reply; or do direct delete here if desired
      return `Type "undo last" to confirm which entry to undo.`;
    default:
      return `I didn’t fully get that. Try "clock in", "break start", "drive stop", "timesheet week".`;
  }
}
// Lightweight helpers
function local(ts, tz) { return new Date(ts).toLocaleString('en-CA', { timeZone: tz, hour12: false }); }
async function hasOpenShift(ownerId, employeeName) {
  const { rows } = await pg.query(
    `SELECT type
       FROM public.time_entries
      WHERE owner_id=$1 AND employee_name=$2
      ORDER BY timestamp DESC
      LIMIT 10`,
    [String(ownerId).replace(/\D/g, ''), employeeName]
  );
  let open = false;
  for (const r of rows) {
    if (r.type === 'clock_in' && !open) open = true;
    else if (r.type === 'clock_out' && open) open = false;
  }
  return open;
}
// The main ACE flow
async function confirmAndExecute({ from, text, userProfile, ownerId }) {
  const tz = userProfile?.tz || 'America/Toronto';
  const employeeNameDefault = userProfile?.name || from;
  const userId = from;
  // 1) If user answered yes/no to a pending confirmation, resolve it
  const lc = String(text || '').trim().toLowerCase();
  const pending = await pg.getPendingAction({ ownerId, userId });
  if (pending && (lc === 'yes' || lc === 'y')) {
    await pg.deletePendingAction(pending.id);
    const data = pending.payload;
    const msg = await executeIntent({ ownerId, userId, tz, data });
    return { handled: true, reply: msg };
  }
  if (pending && (lc === 'no' || lc === 'n')) {
    await pg.deletePendingAction(pending.id);
    return { handled: true, reply: 'Okay, cancelled.' };
  }
  // 2) No pending → parse fresh intent
  const data = await parseIntent({ text, employeeNameDefault });
  if (data.intent === 'none') {
    const ask = data.confirm_text || 'I need more details. Who and which action?';
    return { handled: true, reply: ask };
  }
  // 3) Ask for confirmation (always for time actions)
  if (data.needs_confirmation) {
    const id = await pg.savePendingAction({
      ownerId,
      userId,
      kind: 'time_action',
      payload: data,
    });
    const ask = data.confirm_text || 'Confirm this action?';
    // You can append a “yes/no” hint
    return { handled: true, reply: `${ask} (yes/no)` };
  }
  // 4) Rare: execute immediately if not requiring confirmation
  const msg = await executeIntent({ ownerId, userId, tz, data });
  return { handled: true, reply: msg };
}
module.exports = { confirmAndExecute };