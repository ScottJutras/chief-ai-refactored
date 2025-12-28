// services/ai_confirm.js
// Ask → Confirm → Execute (ACE) layer for natural-language commands

const OpenAI = require('openai');
const pg = require('./postgres');

const hasOpenAI = !!process.env.OPENAI_API_KEY;
const openai = hasOpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function safeStr(x) {
  const s = String(x ?? '').trim();
  return s || null;
}

function local(ts, tz) {
  try {
    return new Date(ts).toLocaleString('en-CA', { timeZone: tz, hour12: false });
  } catch {
    return new Date(ts).toISOString();
  }
}

const SYS = `
You are Chief's PocketCFO command router.
Output strict JSON with fields:
{
  "intent": "punch_in|punch_out|break_start|break_end|drive_start|drive_end|timesheet_week|undo_last|none",
  "employee_name": string|null,
  "job_name": string|null,
  "when": "now" | ISO8601 | null,
  "needs_confirmation": boolean,
  "confirm_text": string
}
Rules:
- If the user asks to perform a time action, set needs_confirmation=true and write a short confirm_text like:
  "Confirm: punch IN Scott at 2025-11-05 08:11 @ Roofing Job?"
- If ambiguous, set intent="none" and confirm_text asking a clarifying question with options.
- NEVER invent times in the past unless the user specified; use "now" otherwise.
`.trim();

async function parseIntent({ text, employeeNameDefault }) {
  if (!openai) {
    return {
      intent: 'none',
      employee_name: employeeNameDefault || null,
      job_name: null,
      when: 'now',
      needs_confirmation: false,
      confirm_text: '',
    };
  }

  const user = (text?.slice(0, 600) || '').trim();

  const res = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: `Employee default: ${employeeNameDefault}\nUser said: ${user}` },
    ],
  });

  let data = {};
  try { data = JSON.parse(res.choices[0].message.content); } catch { data = {}; }

  data.intent = String(data.intent || 'none').toLowerCase();
  data.employee_name = data.employee_name || employeeNameDefault || null;
  data.job_name = data.job_name || null;
  data.when = data.when || 'now';
  data.needs_confirmation = !!data.needs_confirmation;
  data.confirm_text = data.confirm_text || '';
  return data;
}

async function hasOpenShift(ownerId, employeeName) {
  const owner = safeStr(ownerId);
  const name = safeStr(employeeName);
  if (!owner || !name) return false;

  const { rows } = await pg.query(
    `SELECT type
       FROM public.time_entries
      WHERE owner_id=$1 AND employee_name=$2
      ORDER BY timestamp DESC
      LIMIT 50`,
    [owner, name]
  );

  // Interpret state based on most recent relevant events
  let open = false;
  for (const r of rows || []) {
    if (r.type === 'punch_in' && !open) open = true;
    if (r.type === 'punch_out' && open) open = false;
  }
  return open;
}

async function executeIntent({ ownerId, userId, tz, data }) {
  const owner = safeStr(ownerId);
  const requester = safeStr(userId);
  if (!owner || !requester) throw new Error('Missing ownerId/userId');

  const when = data.when === 'now' ? new Date() : new Date(data.when);
  if (Number.isNaN(when.getTime())) throw new Error('Invalid time');

  const name = safeStr(data.employee_name) || requester;
  const job = safeStr(data.job_name);

  // Canonical types in your system:
  // punch_in/punch_out, break_start/break_end, drive_start/drive_end
  switch (data.intent) {
    case 'punch_in':
      if (typeof pg.logTimeEntryWithJob === 'function') {
        await pg.logTimeEntryWithJob(owner, name, 'punch_in', when, job, tz, { requester_id: requester });
      } else {
        await pg.logTimeEntry(owner, name, 'punch_in', when, job, tz, { requester_id: requester });
      }
      return `✅ ${name} punched in at ${local(when, tz)}${job ? ` (${job})` : ''}`;

    case 'punch_out':
      if (!(await hasOpenShift(owner, name))) return `Not punched in. Use "punch in" first.`;
      if (typeof pg.logTimeEntryWithJob === 'function') {
        await pg.logTimeEntryWithJob(owner, name, 'punch_out', when, job, tz, { requester_id: requester });
      } else {
        await pg.logTimeEntry(owner, name, 'punch_out', when, job, tz, { requester_id: requester });
      }
      return `✅ ${name} punched out at ${local(when, tz)}${job ? ` (${job})` : ''}`;

    case 'break_start':
      if (!(await hasOpenShift(owner, name))) return `Cannot start break — not punched in.`;
      await pg.logTimeEntry(owner, name, 'break_start', when, null, tz, { requester_id: requester });
      return `✅ ${name} started break at ${local(when, tz)}`;

    case 'break_end':
      await pg.logTimeEntry(owner, name, 'break_end', when, null, tz, { requester_id: requester });
      return `✅ ${name} ended break at ${local(when, tz)}`;

    case 'drive_start':
      if (!(await hasOpenShift(owner, name))) return `Cannot start drive — not punched in.`;
      await pg.logTimeEntry(owner, name, 'drive_start', when, null, tz, { requester_id: requester });
      return `✅ ${name} started drive at ${local(when, tz)}`;

    case 'drive_end':
      await pg.logTimeEntry(owner, name, 'drive_end', when, null, tz, { requester_id: requester });
      return `✅ ${name} ended drive at ${local(when, tz)}`;

    case 'timesheet_week':
      return `Type "timesheet week" to generate your XLSX link.`;

    case 'undo_last':
      return `Type "undo last" to confirm which entry to undo.`;

    default:
      return `I didn’t fully get that. Try "punch in", "break start", "drive end", "timesheet week".`;
  }
}

async function confirmAndExecute({ from, text, userProfile, ownerId }) {
  const tz = userProfile?.tz || 'America/Toronto';
  const employeeNameDefault = userProfile?.name || from;
  const userId = from;

  // Pending confirm path (only if functions exist)
  const lc = String(text || '').trim().toLowerCase();
  const canPending =
    typeof pg.getPendingAction === 'function' &&
    typeof pg.deletePendingAction === 'function' &&
    typeof pg.savePendingAction === 'function';

  if (canPending) {
    const pending = await pg.getPendingAction({ ownerId, userId });

    if (pending && (lc === 'yes' || lc === 'y' || lc === 'confirm')) {
      await pg.deletePendingAction(pending.id);
      const msg = await executeIntent({ ownerId, userId, tz, data: pending.payload });
      return { handled: true, reply: msg };
    }

    if (pending && (lc === 'no' || lc === 'n' || lc === 'cancel')) {
      await pg.deletePendingAction(pending.id);
      return { handled: true, reply: 'Okay, cancelled.' };
    }
  }

  // Parse fresh intent
  const data = await parseIntent({ text, employeeNameDefault });

  if (data.intent === 'none') {
    const ask = data.confirm_text || 'I need more details. Which time action? (punch in/out, break start/end, drive start/end)';
    return { handled: true, reply: ask };
  }

  // Confirm all time actions
  if (data.needs_confirmation && canPending) {
    await pg.savePendingAction({
      ownerId,
      userId,
      kind: 'time_action',
      payload: data,
    });

    const ask = data.confirm_text || 'Confirm this action?';
    return { handled: true, reply: `${ask} (yes/no)` };
  }

  // If no pending system available, execute directly (still “fail-safe”)
  const msg = await executeIntent({ ownerId, userId, tz, data });
  return { handled: true, reply: msg };
}

module.exports = { confirmAndExecute };
