const { sendQuickReply, sendMessage, sendTemplateQuickReply } = require('../../services/twilio');
const {
  getPendingTransactionState,
  setPendingTransactionState,
} = require('../../utils/stateManager');
const {
  createJob,
  setActiveJob,
  pauseJob,
  resumeJob,
  finishJob,
  summarizeJob,
} = require('../../services/postgres');
const { confirmationTemplates } = require('../../config');
const { ack } = require('../../utils/http');

// -----------------------------
// Helpers
// -----------------------------
function cap(s = '') {
  return String(s)
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function startJobTemplateText(name) {
  const n = cap(name);
  return `Starting job '${n}'. All entries will be assigned to this job until you say 'go to job (Name) or 'New job'. Confirm?`;
}


function toMoney(n) {
  const num = Number(n || 0);
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function toHours(n) {
  const num = Number(n || 0);
  return Number.isFinite(num) ? num.toFixed(2).replace(/\.00$/, '') : '0';
}

function pct(n) {
  const num = Number(n || 0) * 100;
  return Number.isFinite(num) ? num.toFixed(1).replace(/\.0$/, '') + '%' : '0%';
}

// Accepts: "create job X", "new job 'X'", "add job \"X\""
function parseCreateJob(text = '') {
  const m = /^\s*(create|new|add)\s+job\s+(.+?)\s*$/i.exec(text);
  if (!m) return null;
  let name = m[2].trim();
  // strip surrounding quotes if present
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
    name = name.slice(1, -1).trim();
  }
  return name.length >= 2 ? name : null;
}

// Accepts: "start/pause/resume/finish/summarize job X" and synonyms like "end/close"
function parseVerbJob(text = '') {
  const alias = { end: 'finish', close: 'finish', complete: 'finish', stop: 'pause' };
  const m = /^\s*(start|pause|resume|finish|summarize|end|close|complete|stop)\s+(?:job\s*)?(.*)$/i.exec(text);
  if (!m) return null;
  const verb0 = m[1].toLowerCase();
  const verb = alias[verb0] || verb0;
  const name = (m[2] || '').trim() || null;
  return { verb, name };
}

function summarizeToText(name, s) {
  if (!s || typeof s !== 'object') {
    return `\u26a0\ufe0f I couldn't fetch a summary for "${cap(name)}".`;
  }
  const lines = [
    `Duration: ${s.durationDays ?? '—'} days`,
    `Labour: ${toHours(s.labourHours)}h / $${toMoney(s.labourCost)}`,
    `Materials: $${toMoney(s.materialCost)}`,
    `Revenue: $${toMoney(s.revenue)}`,
    `Profit: $${toMoney(s.profit)} (${pct(s.profitMargin)})`,
  ];
  return lines.join('\n');
}

// -----------------------------
// Main handler
// -----------------------------
async function handleJob(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const msg = String(input || '').trim();
  const state = (await getPendingTransactionState(from)) || {};

  if (state.jobFlow && state.jobFlow.action === 'create' && state.jobFlow.name) {
  const wantsCreate = /^(create|yes|y|confirm|ok|👍)$/i.test(msg);
  const wantsCancel = /^(cancel|no|n|stop|abort|✖️)$/i.test(msg);
  const wantsEdit   = /^(edit|change|rename)$/i.test(msg);

  if (wantsCancel) {
    delete state.jobFlow;
    await setPendingTransactionState(from, state);
    await sendMessage(from, `❌ Got it — I won't create that job.`);
    return ack(res);
  }

  if (wantsEdit) {
    // Ask for the new name; stay in the flow
    await sendMessage(from, `What should I rename it to? Reply "create job <new name>" or just the name.`);
    return ack(res);
  }

  if (wantsCreate) {
  const jobName = state.jobFlow.name;
  delete state.jobFlow;
  try {
    const job = await createJob(ownerId, jobName);
    if (!job || job.job_no == null) throw new Error('Job creation succeeded but job_no is missing');

    // Immediately set active (template says "Starting job …")
    await setActiveJob(ownerId, jobName);

    // Save context + clean any stale reminder
    state.lastCreatedJobName = jobName;
    state.lastCreatedJobNo = job.job_no;
    if (state.pendingReminder) delete state.pendingReminder;
    await setPendingTransactionState(from, state);

    await sendQuickReply(
      from,
      `▶️ Job #${job.job_no} (${cap(jobName)}) is now active.\nYou can Clock in, add Expenses, log Hours, Pause/Finish when done.`,
      ['Clock in', 'Add expense', 'Log hours', 'Pause job', 'Finish job', 'Dashboard']
    );
  } catch (err) {
    console.error('[ERROR] createJob failed:', err?.message);
    await sendMessage(from, `⚠️ I couldn't create "${cap(jobName)}". Try a different name.`);
  }
  return ack(res);
}

  // Still waiting — send your Twilio template quick reply
  await sendTemplateQuickReply(from, {
    templateId: 'HXd14a878175fd4b24cee0c0ca6061da96', // hex_start_job
    text: startJobTemplateText(state.jobFlow.name),
    buttons: ['Yes', 'Edit', 'No'],
  });
  return ack(res);
}
  // 2) New "create job ..." request
const createdName = parseCreateJob(msg);
if (createdName) {
  state.jobFlow = { action: 'create', name: createdName };

  // 🔧 Optional hygiene: clear any old reminder prompt now
  if (state.pendingReminder) delete state.pendingReminder;

  await setPendingTransactionState(from, state);

  await sendTemplateQuickReply(from, {
    templateId: 'HXd14a878175fd4b24cee0c0ca6061da96', // hex_start_job
    text: startJobTemplateText(createdName),
    buttons: ['Yes', 'Edit', 'No'],
  });
  return ack(res);
}

  // 3) Verb-based commands: start/pause/resume/finish/summarize
  const parsed = parseVerbJob(msg);
  if (parsed) {
    const { verb } = parsed;
    let name = parsed.name;

    // Allow "Start job" (no name) to use last created job
    if (!name && verb === 'start') {
      name = state.lastCreatedJobName || null;
      if (!name) {
        await sendMessage(from, `Which job should I start? Try: "start job <name>".`);
        return ack(res);
      }
    }

    // If a name is still missing for other verbs, ask
    if (!name) {
      await sendMessage(from, `Please specify the job name. E.g., "${verb} job Roof Repair".`);
      return ack(res);
    }

    try {
      if (verb === 'start') {
        let jobNo = null;
        try {
          await setActiveJob(ownerId, name);
          // We may not know the job number for existing jobs, keep null
        } catch (e) {
          // If activating failed (likely missing), create then activate
          const job = await createJob(ownerId, name);
          if (!job || job.job_no == null) throw new Error('Job creation succeeded but job_no is missing');
          await setActiveJob(ownerId, name);
          jobNo = job.job_no;
          state.lastCreatedJobNo = job.job_no;
        }

        state.lastCreatedJobName = name;
        await setPendingTransactionState(from, state);

        if (jobNo != null && confirmationTemplates?.startJob) {
          await sendMessage(from, confirmationTemplates.startJob({ job_no: jobNo, job_name: cap(name) }));
        } else if (jobNo != null) {
          await sendMessage(from, `▶️ Job #${jobNo} ("${cap(name)}") is now active. You can Clock in, add Expenses, or Pause/Finish when done.`);
        } else {
          await sendMessage(from, `▶️ "${cap(name)}" is now active. You can Clock in, add Expenses, or Pause/Finish when done.`);
        }
        return ack(res);
      }

      if (verb === 'pause') {
        await pauseJob(ownerId, name);
        const text = confirmationTemplates?.pauseJob
          ? confirmationTemplates.pauseJob({ job_name: cap(name) })
          : `⏸️ Paused "${cap(name)}".`;
        await sendQuickReply(from, `${text} Resume later?`, [`Resume job ${cap(name)}`, 'Log hours', 'Add expense']);
        return ack(res);
      }

      if (verb === 'resume') {
        await resumeJob(ownerId, name);
        const text = confirmationTemplates?.resumeJob
          ? confirmationTemplates.resumeJob({ job_name: cap(name) })
          : `▶️ Resumed "${cap(name)}".`;
        await sendQuickReply(from, `${text}`, ['Clock in', 'Add expense', 'Finish job']);
        return ack(res);
      }

      if (verb === 'finish') {
        await finishJob(ownerId, name);
        let s = null;
        try { s = await summarizeJob(ownerId, name); } catch (_) {}
        const summary = summarizeToText(name, s);
        const text = confirmationTemplates?.finishJob
          ? confirmationTemplates.finishJob({ job_name: cap(name), summary })
          : `✅ Finished "${cap(name)}".\n${summary}`;
        await sendQuickReply(from, text, ['Create invoice', 'Dashboard', 'New job']);
        return ack(res);
      }

      if (verb === 'summarize') {
        let s = null;
        try { s = await summarizeJob(ownerId, name); } catch (_) {}
        const summary = summarizeToText(name, s);
        await sendQuickReply(from, `📋 Recap for "${cap(name)}":\n${summary}`, ['Add expense', 'Log hours', `Finish job ${cap(name)}`]);
        return ack(res);
      }
    } catch (err) {
      console.error(`[ERROR] ${verb} job failed:`, err?.message);
      await sendMessage(from, `⚠️ I couldn't ${verb} "${cap(name)}". Please try again.`);
      return ack(res);
    }
  }

  // 4) Not handled by this handler → let the router try others
  return false;
}

module.exports = handleJob;
