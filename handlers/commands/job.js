// handlers/commands/job.js
const { sendQuickReply, sendMessage } = require('../../services/twilio');
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
const { ack } = require('../../utils/http');

function cap(s = '') {
  return String(s)
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// "create job X" / "new job X" / "add job X"
function parseCreateJob(text = '') {
  const m = /^\s*(create|new|add)\s+job\s+(.+?)\s*$/i.exec(text);
  if (!m) return null;
  const name = m[2].trim();
  return name.length >= 2 ? name : null;
}

// "start/pause/resume/finish/summarize job X"
function parseVerbJob(text = '') {
  const m = /^\s*(start|pause|resume|finish|summarize)\s+job(?:\s+(.+?))?\s*$/i.exec(text);
  if (!m) return null;
  return { verb: m[1].toLowerCase(), name: (m[2] || '').trim() || null };
}

async function handleJob(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const msg = String(input || '').trim();
  const lc = msg.toLowerCase();
  const state = (await getPendingTransactionState(from)) || {};

  // 1) Confirmation for pending "create job"
  if (state.jobFlow && state.jobFlow.action === 'create' && state.jobFlow.name) {
    const wantsCreate = /^(create|yes|y|confirm|ok|👍)$/i.test(msg);
    const wantsCancel = /^(cancel|no|n|stop|abort|✖️)$/i.test(msg);

    if (wantsCancel) {
      delete state.jobFlow;
      await setPendingTransactionState(from, state);
      await sendMessage(from, `❌ Got it — I won't create that job.`);
      return ack(res);
    }

    if (wantsCreate) {
      const jobName = state.jobFlow.name;
      delete state.jobFlow;

      try {
        await createJob(ownerId, jobName);
        state.lastCreatedJobName = jobName; // remember for quick "Start job"
        await setPendingTransactionState(from, state);

        await sendQuickReply(
          from,
          `✅ Created job: ${cap(jobName)}.\nWhat would you like to do next?`,
          ['Start job', 'Add expense', 'Log hours', 'Finish job', 'Dashboard']
        );
      } catch (err) {
        console.error('[ERROR] createJob failed:', err?.message);
        await sendMessage(
          from,
          `⚠️ I couldn't create "${cap(jobName)}". Please try again or choose a different name.`
        );
      }
      return ack(res);
    }

    // still waiting for a clear response
    await sendQuickReply(from, `Create job "${cap(state.jobFlow.name)}"?`, ['Create', 'Cancel']);
    return ack(res);
  }

  // 2) New "create job ..." request
  const createdName = parseCreateJob(msg);
  if (createdName) {
    state.jobFlow = { action: 'create', name: createdName };
    await setPendingTransactionState(from, state);

    await sendQuickReply(
      from,
      `Just to confirm — create job "${cap(createdName)}"?`,
      ['Create', 'Cancel']
    );
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
        // Try to activate; if it fails (job may not exist), create then activate.
        try {
          await setActiveJob(ownerId, name);
        } catch {
          await createJob(ownerId, name);
          await setActiveJob(ownerId, name);
        }
        state.lastCreatedJobName = name;
        await setPendingTransactionState(from, state);
        await sendMessage(
          from,
          `▶️ "${cap(name)}" is now active. You can Clock in, add Expenses, or Pause/Finish when done.`
        );
        return ack(res);
      }

      if (verb === 'pause') {
        await pauseJob(ownerId, name);
        await sendMessage(from, `⏸️ Paused "${cap(name)}". Say "resume job ${cap(name)}" to continue.`);
        return ack(res);
      }

      if (verb === 'resume') {
        await resumeJob(ownerId, name);
        await sendMessage(from, `▶️ Resumed "${cap(name)}".`);
        return ack(res);
      }

      if (verb === 'finish') {
        await finishJob(ownerId, name);
        const s = await summarizeJob(ownerId, name);
        await sendMessage(
          from,
          `✅ Finished "${cap(name)}".\n` +
            `Duration: ${s.durationDays} days\n` +
            `Labour: ${s.labourHours}h / $${s.labourCost}\n` +
            `Materials: $${s.materialCost}\n` +
            `Revenue: $${s.revenue}\n` +
            `Profit: $${s.profit} (${(s.profitMargin * 100).toFixed(2)}%)`
        );
        return ack(res);
      }

      if (verb === 'summarize') {
        const s = await summarizeJob(ownerId, name);
        await sendMessage(
          from,
          `📋 Recap for "${cap(name)}":\n` +
            `Duration: ${s.durationDays} days\n` +
            `Labour: ${s.labourHours}h / $${s.labourCost}\n` +
            `Materials: $${s.materialCost}\n` +
            `Revenue: $${s.revenue}\n` +
            `Profit: $${s.profit} (${(s.profitMargin * 100).toFixed(2)}%)`
        );
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
