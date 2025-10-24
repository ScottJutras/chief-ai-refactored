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

  const sendStartTemplate = async (name) => {
    await sendTemplateQuickReply(
      from,
      'HXd14a878175fd4b24cee0c0ca6061da96', // hex_start_job
      { '1': cap(name) }
    );
  };

  // 0) If user typed a brand-new "create job ____" at ANY time, override pending name and re-template
  const newNameFromMsg = parseCreateJob(msg);
  if (newNameFromMsg) {
    state.jobFlow = { action: 'create', name: newNameFromMsg };
    if (state.pendingReminder) delete state.pendingReminder; // avoid reminder intercepts
    await setPendingTransactionState(from, state);
    await sendStartTemplate(newNameFromMsg);
    return ack(res);
  }

  // 0b) If we are in "rename mode" (after pressing Edit), accept a bare name (or "create job X")
  if (state.jobFlow?.action === 'create' && state.jobFlow?.expectRename) {
    const rename = parseCreateJob(msg) || msg; // allow "create job ..." OR just a bare name
    const clean = String(rename || '').trim();
    if (clean) {
      state.jobFlow = { action: 'create', name: clean }; // clear expectRename by replacing obj
      if (state.pendingReminder) delete state.pendingReminder;
      await setPendingTransactionState(from, state);
      await sendStartTemplate(clean);
      return ack(res);
    }
    // If they sent something empty, ask again
    await sendMessage(from, `What should I rename it to? Reply "create job <new name>" or just the name.`);
    return ack(res);
  }

  // 1) Pending "create job" confirmation
  if (state.jobFlow && state.jobFlow.action === 'create' && state.jobFlow.name) {
    const wantsCreate = /^(create|yes|y|confirm|ok|okay|👍)$/i.test(msg);
    const wantsCancel = /^(cancel|no|n|stop|abort|✖️|❌)$/i.test(msg);
    const wantsEdit   = /^(edit|change|rename)$/i.test(msg);

    if (wantsCancel) {
      delete state.jobFlow;
      if (state.pendingReminder) delete state.pendingReminder;
      await setPendingTransactionState(from, state);
      await sendMessage(from, `❌ Got it — I won't create that job.`);
      return ack(res);
    }

    if (wantsEdit) {
      // enter rename mode and prompt
      state.jobFlow.expectRename = true;
      await setPendingTransactionState(from, state);
      await sendMessage(from, `What should I rename it to? Reply "create job <new name>" or just the name.`);
      return ack(res);
    }

    if (wantsCreate) {
      const jobName = state.jobFlow.name;
      delete state.jobFlow;
      if (state.pendingReminder) delete state.pendingReminder;

      try {
        const job = await createJob(ownerId, jobName);
        if (!job || job.job_no == null) throw new Error('Job creation succeeded but job_no is missing');

        await setActiveJob(ownerId, jobName);

        state.lastCreatedJobName = jobName;
        state.lastCreatedJobNo = job.job_no;
        await setPendingTransactionState(from, state);

        await sendQuickReply(
          from,
          `▶️ Job #${job.job_no} (${cap(jobName)}) is now active.\nYou can Clock in, add Expenses, log Hours, Pause/Finish when done.`,
          ['Clock in', 'Add expense', 'Log hours', 'Pause job', 'Finish job']
        );
      } catch (err) {
        console.error('[ERROR] createJob failed:', err?.message);
        await sendMessage(from, `⚠️ I couldn't create "${cap(jobName)}". Try a different name.`);
      }
      return ack(res);
    }

    // Still waiting — repeat template with the CURRENT pending name
    await sendStartTemplate(state.jobFlow.name);
    return ack(res);
  }

  // 2) Verb-based commands: start/pause/resume/finish/summarize (unchanged)
  const parsed = parseVerbJob(msg);
  if (parsed) {
    const { verb } = parsed;
    let name = parsed.name;

    if (!name && verb === 'start') {
      name = state.lastCreatedJobName || null;
      if (!name) {
        await sendMessage(from, `Which job should I start? Try: "start job <name>".`);
        return ack(res);
      }
    }

    if (!name) {
      await sendMessage(from, `Please specify the job name. E.g., "${verb} job Roof Repair".`);
      return ack(res);
    }

    try {
      if (verb === 'start') {
        let jobNo = null;
        try {
          await setActiveJob(ownerId, name);
        } catch {
          const job = await createJob(ownerId, name);
          if (!job || job.job_no == null) throw new Error('Job creation succeeded but job_no is missing');
          await setActiveJob(ownerId, name);
          jobNo = job.job_no;
          state.lastCreatedJobNo = job.job_no;
        }
        state.lastCreatedJobName = name;
        await setPendingTransactionState(from, state);

        if (jobNo != null) {
          await sendMessage(from, `▶️ Job #${jobNo} ("${cap(name)}") is now active. You can Clock in, add Expenses, or Pause/Finish when done.`);
        } else {
          await sendMessage(from, `▶️ "${cap(name)}" is now active. You can Clock in, add Expenses, or Pause/Finish when done.`);
        }
        return ack(res);
      }

      if (verb === 'pause') {
        await pauseJob(ownerId, name);
        await sendQuickReply(from, `⏸️ Paused "${cap(name)}". Resume later?`, [`Resume job ${cap(name)}`, 'Log hours', 'Add expense']);
        return ack(res);
      }

      if (verb === 'resume') {
        await resumeJob(ownerId, name);
        await sendQuickReply(from, `▶️ Resumed "${cap(name)}".`, ['Clock in', 'Add expense', 'Finish job']);
        return ack(res);
      }

      if (verb === 'finish') {
        await finishJob(ownerId, name);
        let s = null;
        try { s = await summarizeJob(ownerId, name); } catch {}
        const summary = summarizeToText(name, s);
        await sendQuickReply(from, `✅ Finished "${cap(name)}".\n${summary}`, ['Create invoice', 'Dashboard', 'New job']);
        return ack(res);
      }

      if (verb === 'summarize') {
        let s = null;
        try { s = await summarizeJob(ownerId, name); } catch {}
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

  // 4) Not handled here → let upstream router try others
  return false;
}

module.exports = handleJob;
