const { saveJob, setActiveJob, finishJob, createJob, pauseJob, resumeJob, summarizeJob } = require('../../services/postgres');
const { acquireLock, releaseLock } = require('../../middleware/lock');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { handleInputWithAI, parseJobMessage, handleError } = require('../../utils/aiErrorHandler');

async function handleJob(from, input, userProfile, ownerId) {
  const lockKey = `lock:${from}`;
  await acquireLock(lockKey);

  try {
    const msg = input?.trim();
    const lower = msg.toLowerCase();
    const state = (await getPendingTransactionState(from)) || {};

    // Two-step CREATE JOB
    if (!state.pendingCreateJob && lower.startsWith('create job')) {
      const { data, reply, confirmed } = await handleInputWithAI(from, input, 'job', parseJobMessage);
      if (!confirmed) return `<Response><Message>${reply}</Message></Response>`;
      const { jobName } = data;
      await createJob(ownerId, jobName);
      await setPendingTransactionState(from, { pendingCreateJob: { jobName } });
      return `<Response><Message>✅ Job "${jobName}" created. Would you like to set it as active now? Reply "yes" or "no".</Message></Response>`;
    }

    if (state.pendingCreateJob) {
      const { jobName } = state.pendingCreateJob;
      const ans = lower;
      await deletePendingTransactionState(from);
      if (ans === 'yes') {
        await setActiveJob(ownerId, jobName);
        return `<Response><Message>▶️ Job "${jobName}" is now active.</Message></Response>`;
      } else if (ans === 'no') {
        return `<Response><Message>✅ Job "${jobName}" remains inactive. Use "start job ${jobName}" when ready.</Message></Response>`;
      } else {
        await setPendingTransactionState(from, state);
        return `<Response><Message>Please reply "yes" or "no" to confirm activation of "${jobName}".</Message></Response>`;
      }
    }

    // Single-shot commands
    if (lower.startsWith('start job') || lower.startsWith('pause job') || lower.startsWith('resume job') || 
        lower.startsWith('finish job') || lower.startsWith('summarize job')) {
      const { data, reply, confirmed } = await handleInputWithAI(from, input, 'job', parseJobMessage);
      if (!confirmed) return `<Response><Message>${reply}</Message></Response>`;
      const { jobName } = data;

      if (lower.startsWith('start job')) {
        await saveJob(ownerId, jobName, new Date());
        return `<Response><Message>▶️ Started job: ${jobName}</Message></Response>`;
      }
      if (lower.startsWith('pause job')) {
        await pauseJob(ownerId, jobName);
        return `<Response><Message>⏸️ Paused job: ${jobName}</Message></Response>`;
      }
      if (lower.startsWith('resume job')) {
        await resumeJob(ownerId, jobName);
        return `<Response><Message>▶️ Resumed job: ${jobName}</Message></Response>`;
      }
      if (lower.startsWith('finish job')) {
        await finishJob(ownerId, jobName);
        const stats = await summarizeJob(ownerId, jobName);
        return `<Response><Message>✅ Finished "${jobName}".\nDuration: ${stats.durationDays} days\nLabour: ${stats.labourHours}h / $${stats.labourCost}\nMaterials: $${stats.materialCost}\nRevenue: $${stats.revenue}\nProfit: $${stats.profit} (${(stats.profitMargin * 100).toFixed(2)}%)</Message></Response>`;
      }
      const summary = await summarizeJob(ownerId, jobName);
      return `<Response><Message>📋 Recap for "${jobName}":\nDuration: ${summary.durationDays} days\nLabour: ${summary.labourHours}h / $${summary.labourCost}\nMaterials: $${summary.materialCost}\nRevenue: $${summary.revenue}\nProfit: $${summary.profit} (${(summary.profitMargin * 100).toFixed(2)}%)</Message></Response>`;
    }

    // Fallback for unknown commands
    const resp = await xaiClient.post('/grok', {
      prompt: `${CODEBASE_CONTEXT}\nUser input: "${input}"\nThey tried a job command but it wasn’t recognized. Infer their intent, suggest a valid job command (e.g., "create job Roof Repair"), and ask a clarifying question if needed. Respond conversationally, considering state: ${JSON.stringify(state)}.`
    });
    const aiMsg = resp.data.choices?.[0]?.text?.trim() || 
      `⚠️ I didn’t recognize that job command. Try "create job Roof Repair", "start job Roof Repair", etc.`;
    return `<Response><Message>${aiMsg}</Message></Response>`;
  } catch (err) {
    console.error('[ERROR] handleJob failed for', from, ':', err.message);
    return await handleError(from, err, 'handleJob', input);
  } finally {
    await releaseLock(lockKey);
  }
}

module.exports = { handleJob };