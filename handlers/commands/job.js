const {
  setActiveJob,
  finishJob,
  getActiveJob,
  createJob,
  pauseJob,
  resumeJob,
  summarizeJob
} = require('../../services/postgres.js');
const { sendTemplateMessage } = require('../../services/twilio');
const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState
} = require('../../utils/stateManager');
const { handleInputWithAI } = require('../../utils/aiErrorHandler');
const { db } = require('../../services/firebase');
const { confirmationTemplates } = require('../../config');

async function handleJob(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const lcInput = input.toLowerCase();
    const pendingState = await getPendingTransactionState(from);

    // 0️⃣ Handle pending “Create Job” confirmation
    if (pendingState?.pendingCreateJob) {
      const jobName = pendingState.pendingCreateJob.jobName;
      if (lcInput === 'yes') {
        await setActiveJob(ownerId, jobName);
        reply = `✅ Job '${jobName}' is now active.`;
      } else {
        reply = `✅ Job '${jobName}' created (not active).`;
      }
      await deletePendingTransactionState(from);
      await db.collection('locks').doc(lockKey).delete();
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 1️⃣ Create Job (without activating)
    if (/^(?:create job|job create)\s+(.+)$/i.test(lcInput)) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can create jobs.";
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      const match = lcInput.match(/^(?:create job|job create)\s+(.+)$/i);
      const jobName = match[1].trim();
      await createJob(ownerId, jobName);
      await setPendingTransactionState(from, { pendingCreateJob: { jobName } });
      reply = `✅ Job '${jobName}' created. Would you like to set it as active? Reply 'yes' or 'no'.`;
      await db.collection('locks').doc(lockKey).delete();
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 2️⃣ Start Job
    if (/^(start job|job start)\s+(.+)$/i.test(lcInput)) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can start jobs.";
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      const defaultData = { jobName: 'Unknown Job' };
      const { data, reply: aiReply, confirmed } = await handleInputWithAI(
        from, input, 'job',
        (input) => {
          const m = input.match(/^(start job|job start)\s+(.+)$/i);
          return m ? { jobName: m[2].trim() } : null;
        }, defaultData
      );
      if (aiReply) {
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${aiReply}</Message></Response>`);
      }
      if (data && data.jobName && confirmed) {
        await setActiveJob(ownerId, data.jobName);
        const sent = await sendTemplateMessage(
          from, confirmationTemplates.startJob,
          [{ type: 'text', text: data.jobName }]
        );
        await db.collection('locks').doc(lockKey).delete();
        return sent
          ? res.send('<Response></Response>')
          : res.send(`<Response><Message>✅ Job '${data.jobName}' started.</Message></Response>`);
      }
    }

    // 3️⃣ Pause Job
    if (/^pause job\s+(.+)$/i.test(lcInput)) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can pause jobs.";
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      const name = lcInput.replace(/^pause job\s+/i, '').trim();
      await pauseJob(ownerId, name);
      reply = `⏸️ Job '${name}' paused.`;
      await db.collection('locks').doc(lockKey).delete();
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 4️⃣ Resume Job
    if (/^resume job\s+(.+)$/i.test(lcInput)) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can resume jobs.";
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      const name = lcInput.replace(/^resume job\s+/i, '').trim();
      await resumeJob(ownerId, name);
      reply = `▶️ Job '${name}' resumed.`;
      await db.collection('locks').doc(lockKey).delete();
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 5️⃣ Finish Job
    if (lcInput.startsWith('finish job ')) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can finish jobs.";
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      const name = input.replace(/^finish job\s+/i, '').trim();
      const active = await getActiveJob(ownerId);
      if (active !== name) {
        reply = `⚠️ No active job named '${name}'.`;
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      await finishJob(ownerId, name);
      // gather recap stats
      const stats = await summarizeJob(ownerId, name);
      reply = 
        `✅ Job '${name}' finished after ${stats.durationDays} days.\n` +
        `Labour: ${stats.labourHours}h / $${stats.labourCost}\n` +
        `Materials: $${stats.materialCost}\n` +
        `Revenue: $${stats.revenue}\n` +
        `Profit: $${stats.profit} (${(stats.profitMargin*100).toFixed(2)}%)`;
      await db.collection('locks').doc(lockKey).delete();
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 6️⃣ Job Recap (overview without finishing)
    if (/^job recap\s+(.+)$/i.test(lcInput)) {
      const name = lcInput.replace(/^job recap\s+/i, '').trim();
      const stats = await summarizeJob(ownerId, name);
      reply = 
        `📋 Recap for '${name}':\n` +
        `Duration: ${stats.durationDays} days\n` +
        `Labour: ${stats.labourHours}h / $${stats.labourCost}\n` +
        `Materials: $${stats.materialCost}\n` +
        `Revenue: $${stats.revenue}\n` +
        `Profit: $${stats.profit} (${(stats.profitMargin*100).toFixed(2)}%)`;
      await db.collection('locks').doc(lockKey).delete();
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 7️⃣ Delete Job logic unchanged
    if (lcInput.includes('delete') || lcInput.includes('remove')) {
      // existing delete logic...
    }
  } catch (err) {
    console.error(`Error in handleJob: ${err.message}`);
    throw err;
  }
}

module.exports = { handleJob };
