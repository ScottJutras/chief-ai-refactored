// handlers/commands/job.js
const {
  createJob,
  setActiveJob,
  saveJob,
  pauseJob,
  resumeJob,
  finishJob,
  summarizeJob
} = require('../../services/postgres');
const { acquireLock, releaseLock } = require('../../middleware/lock');
const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState
} = require('../../utils/stateManager');

async function handleJob(from, input, userProfile, ownerId) {
  const lockKey = `lock:${from}`;
  await acquireLock(lockKey);

  try {
    const msg = (input || '').trim().toLowerCase();
    const state = (await getPendingTransactionState(from)) || {};

    // — Step 1: "create job NAME"
    if (!state.step && msg.startsWith('create job ')) {
      const jobName = msg.slice('create job '.length).trim();
      if (!jobName) {
        return `<Response><Message>⚠️ Please specify a job name: e.g. "create job Roof Repair".</Message></Response>`;
      }

      // actually create it (inactive by default)
      await createJob(ownerId, jobName);
      // stash for confirmation
      await setPendingTransactionState(from, { step: 1, jobName });
      return `<Response><Message>✅ Job "${jobName}" created. Would you like to set it as active now? Reply "yes" or "no".</Message></Response>`;
    }

    // — Step 2: waiting on yes/no
    if (state.step === 1) {
      const { jobName } = state;
      const answer = msg;
      // clear the pending state
      await deletePendingTransactionState(from);

      if (answer === 'yes') {
        await setActiveJob(ownerId, jobName);
        return `<Response><Message>▶️ Job "${jobName}" is now active.</Message></Response>`;
      } else if (answer === 'no') {
        return `<Response><Message>✅ Job "${jobName}" remains inactive. You can activate it later with "start job ${jobName}".</Message></Response>`;
      } else {
        // unexpected reply → re-prompt, restore state
        await setPendingTransactionState(from, state);
        return `<Response><Message>Please reply "yes" or "no" to confirm activation of "${jobName}".</Message></Response>`;
      }
    }

    // — Single-shot commands
    if (msg.startsWith('start job ')) {
      const jobName = msg.slice('start job '.length).trim();
      if (!jobName) {
        return `<Response><Message>Please provide a job name: e.g. "start job Roof Repair".</Message></Response>`;
      }
      await saveJob(ownerId, jobName, new Date());
      return `<Response><Message>▶️ Started job: ${jobName}</Message></Response>`;
    }

    if (msg.startsWith('pause job ')) {
      const jobName = msg.slice('pause job '.length).trim();
      await pauseJob(ownerId, jobName);
      return `<Response><Message>⏸️ Paused job: ${jobName}</Message></Response>`;
    }

    if (msg.startsWith('resume job ')) {
      const jobName = msg.slice('resume job '.length).trim();
      await resumeJob(ownerId, jobName);
      return `<Response><Message>▶️ Resumed job: ${jobName}</Message></Response>`;
    }

    if (msg.startsWith('finish job ')) {
      const jobName = msg.slice('finish job '.length).trim();
      await finishJob(ownerId, jobName);
      return `<Response><Message>✅ Finished job: ${jobName}</Message></Response>`;
    }

    if (msg.startsWith('summarize job ')) {
      const jobName = msg.slice('summarize job '.length).trim();
      const stats = await summarizeJob(ownerId, jobName);
      return `<Response><Message>
Job Summary for ${jobName}:
• Duration: ${stats.durationDays} days
• Labour: ${stats.labourHours} h / $${stats.labourCost}
• Materials: $${stats.materialCost}
• Revenue: $${stats.revenue}
• Profit: $${stats.profit} (${(stats.profitMargin*100).toFixed(2)}%)
</Message></Response>`;
    }

    // — fallback
    return `<Response><Message>⚠️ Unknown job command. Try "create job …", "start job …", "pause job …", etc.</Message></Response>`;

  } catch (err) {
    console.error('[ERROR] handleJob failed for', from, err);
    return `<Response><Message>⚠️ Error: ${err.message}</Message></Response>`;
  } finally {
    await releaseLock(lockKey);
  }
}

module.exports = { handleJob };
