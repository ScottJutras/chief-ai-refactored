const { Pool } = require('pg');
const {
  setActiveJob,
  finishJob,
  getActiveJob,
  createJob,
  pauseJob,
  resumeJob,
  summarizeJob
} = require('../../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { handleInputWithAI, parseJobMessage } = require('../utils/aiErrorHandler');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function handleJob(from, input, userProfile, ownerId, ownerProfile, isOwner) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const lcInput = input.toLowerCase().trim();
    const pendingState = await getPendingTransactionState(from);

    if (pendingState?.pendingCreateJob) {
      const jobName = pendingState.pendingCreateJob.jobName;
      if (lcInput === 'yes') {
        await setActiveJob(ownerId, jobName);
        reply = `✅ Job '${jobName}' is now active.`;
      } else {
        reply = `✅ Job '${jobName}' created (not active).`;
      }
      await deletePendingTransactionState(from);
      return `<Response><Message>${reply}</Message></Response>`;
    }

    if (/^(?:create job|job create)\s+(.+)$/i.test(lcInput)) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can create jobs.";
        return `<Response><Message>${reply}</Message></Response>`;
      }
      const match = lcInput.match(/^(?:create job|job create)\s+(.+)$/i);
      const jobName = match[1].trim();
      await createJob(ownerId, jobName);
      await setPendingTransactionState(from, { pendingCreateJob: { jobName } });
      reply = `✅ Job '${jobName}' created. Would you like to set it as active? Reply 'yes' or 'no'.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    if (/^(start job|job start)\s+(.+)$/i.test(lcInput)) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can start jobs.";
        return `<Response><Message>${reply}</Message></Response>`;
      }
      const defaultData = { jobName: 'Unknown Job' };
      const { data, reply: aiReply, confirmed } = await handleInputWithAI(
        from, input, 'job',
        parseJobMessage, defaultData
      );
      if (aiReply) {
        return `<Response><Message>${aiReply}</Message></Response>`;
      }
      if (data && data.jobName && confirmed) {
        await setActiveJob(ownerId, data.jobName);
        reply = `✅ Job '${data.jobName}' started.`;
        return `<Response><Message>${reply}</Message></Response>`;
      }
    }

    if (/^pause job\s+(.+)$/i.test(lcInput)) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can pause jobs.";
        return `<Response><Message>${reply}</Message></Response>`;
      }
      const name = lcInput.replace(/^pause job\s+/i, '').trim();
      await pauseJob(ownerId, name);
      reply = `⏸️ Job '${name}' paused.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    if (/^resume job\s+(.+)$/i.test(lcInput)) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can resume jobs.";
        return `<Response><Message>${reply}</Message></Response>`;
      }
      const name = lcInput.replace(/^resume job\s+/i, '').trim();
      await resumeJob(ownerId, name);
      reply = `▶️ Job '${name}' resumed.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    if (lcInput.startsWith('finish job ')) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can finish jobs.";
        return `<Response><Message>${reply}</Message></Response>`;
      }
      const name = input.replace(/^finish job\s+/i, '').trim();
      const active = await getActiveJob(ownerId);
      if (active !== name) {
        reply = `⚠️ No active job named '${name}'.`;
        return `<Response><Message>${reply}</Message></Response>`;
      }
      await finishJob(ownerId, name);
      const stats = await summarizeJob(ownerId, name);
      reply = 
        `✅ Job '${name}' finished after ${stats.durationDays} days.\n` +
        `Labour: ${stats.labourHours}h / $${stats.labourCost}\n` +
        `Materials: $${stats.materialCost}\n` +
        `Revenue: $${stats.revenue}\n` +
        `Profit: $${stats.profit} (${(stats.profitMargin * 100).toFixed(2)}%)`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    if (/^job recap\s+(.+)$/i.test(lcInput)) {
      const name = lcInput.replace(/^job recap\s+/i, '').trim();
      const stats = await summarizeJob(ownerId, name);
      reply = 
        `📋 Recap for '${name}':\n` +
        `Duration: ${stats.durationDays} days\n` +
        `Labour: ${stats.labourHours}h / $${stats.labourCost}\n` +
        `Materials: $${stats.materialCost}\n` +
        `Revenue: $${stats.revenue}\n` +
        `Profit: $${stats.profit} (${(stats.profitMargin * 100).toFixed(2)}%)`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    if (lcInput.includes('delete') || lcInput.includes('remove')) {
      // Existing delete logic unchanged
      reply = "⚠️ Job deletion not implemented. Please specify a valid job command.";
      return `<Response><Message>${reply}</Message></Response>`;
    }

    reply = "⚠️ Invalid job command. Try: 'create job [name]', 'start job [name]', 'pause job [name]', 'resume job [name]', 'finish job [name]', or 'job recap [name]'.";
    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleJob failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process job command: ${error.message}`;
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    await require('../middleware/lock').releaseLock(lockKey);
  }
}

module.exports = { handleJob };