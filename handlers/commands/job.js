const { setActiveJob, finishJob, getActiveJob } = require('../../services/postgres.js');
const { sendTemplateMessage } = require('../../services/twilio');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { handleInputWithAI } = require('../../utils/aiErrorHandler');
const { google } = require('googleapis');
const OpenAI = require('openai');
const { getAuthorizedClient } = require('../../utils/googleSheets');
const { db } = require('../../services/firebase');
const { confirmationTemplates } = require('../../config');

async function handleJob(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const lcInput = input.toLowerCase();

    // Handle Start Job
    if (/^(start job|job start)\s+(.+)$/i.test(lcInput)) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can start jobs.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (not owner)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const defaultData = { jobName: "Unknown Job" };
      const { data, reply: aiReply, confirmed } = await handleInputWithAI(
        from,
        input,
        'job',
        (input) => {
          const match = input.match(/^(start job|job start)\s+(.+)/i);
          return match ? { jobName: match[2].trim() } : null;
        },
        defaultData
      );

      if (aiReply) {
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (AI reply)`);
        return res.send(`<Response><Message>${aiReply}</Message></Response>`);
      }

      if (data && data.jobName && confirmed) {
        await setActiveJob(ownerId, data.jobName);
        const sent = await sendTemplateMessage(from, confirmationTemplates.startJob, [{ type: "text", text: data.jobName }]);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (job started)`);
        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>✅ Job '${data.jobName}' started.</Message></Response>`);
      }
    } else if (lcInput.startsWith("finish job ")) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can finish jobs.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (not owner)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const jobName = input.replace(/^finish job\s+/i, '').trim();
      if (!jobName) {
        reply = "⚠️ Please provide a job name. Try: 'finish job Roof Repair'";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (invalid job)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const activeJob = await getActiveJob(ownerId);
      if (activeJob !== jobName) {
        reply = `⚠️ No active job named '${jobName}'.`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (job not active)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      await finishJob(ownerId, jobName);
      const userRef = db.collection('users').doc(ownerId);
      const doc = await userRef.get();
      const job = doc.data().jobHistory.find(j => j.jobName === jobName);
      const durationDays = Math.round((new Date(job.endTime) - new Date(job.startTime)) / (1000 * 60 * 60 * 24));
      const auth = await getAuthorizedClient();
      const sheets = google.sheets({ version: 'v4', auth });
      const expenseData = await sheets.spreadsheets.values.get({
        spreadsheetId: ownerProfile.spreadsheetId,
        range: 'Sheet1!A:I'
      });
      const revenueData = await sheets.spreadsheets.values.get({
        spreadsheetId: ownerProfile.spreadsheetId,
        range: 'Revenue!A:I'
      });
      const expenses = expenseData.data.values.slice(1).filter(row => row[4] === jobName);
      const revenues = revenueData.data.values.slice(1).filter(row => row[4] === jobName);
      const totalExpenses = expenses.reduce((sum, row) => sum + parseFloat(row[2].replace('$', '')), 0);
      const totalRevenue = revenues.reduce((sum, row) => sum + parseFloat(row[2].replace('$', '')), 0);
      const profit = totalRevenue - totalExpenses;
      const profitPerDay = profit / durationDays || 0;
      const revenuePerDay = totalRevenue / durationDays || 0;
      const hoursWorked = durationDays * 8; // Assuming 8 hours/day
      const profitPerHour = profit / hoursWorked || 0;
      reply = `✅ Job '${jobName}' finished after ${durationDays} days.\nRevenue: $${revenuePerDay.toFixed(2)}/day\nProfit: $${profitPerDay.toFixed(2)}/day\nHourly Profit: $${profitPerHour.toFixed(2)}/hour`;
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (job finished)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else if (lcInput.includes("delete") || lcInput.includes("remove")) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can delete entries.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (not owner)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const auth = await getAuthorizedClient();
      const sheets = google.sheets({ version: 'v4', auth });
      const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const gptResponse = await openaiClient.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: `Parse a delete request: "${input}". Return JSON: { type: 'revenue|expense|job|bill', criteria: { item: 'string|null', amount: 'string|null', date: 'string|null', store: 'string|null', source: 'string|null', billName: 'string|null', jobName: 'string|null' } }. Set unmatched fields to null.` },
          { role: "user", content: input }
        ],
        max_tokens: 150,
        temperature: 0.3
      });
      const deleteRequest = JSON.parse(gptResponse.choices[0].message.content);
      console.log("[DEBUG] Delete request parsed:", deleteRequest);

      if (deleteRequest.type === 'job') {
        const jobName = deleteRequest.criteria.jobName;
        if (!jobName) {
          reply = "⚠️ Please specify a job name to delete.";
          await db.collection('locks').doc(lockKey).delete();
          console.log(`[LOCK] Released lock for ${from} (missing job name)`);
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }

        const activeJob = await getActiveJob(ownerId);
        if (activeJob === jobName) {
          await setPendingTransactionState(from, { pendingDelete: { type: 'job', jobName } });
          const sent = await sendTemplateMessage(from, confirmationTemplates.deleteConfirmation, [{ type: "text", text: `Are you sure you want to delete job '${jobName}'? Reply 'yes' or 'no'.` }]);
          await db.collection('locks').doc(lockKey).delete();
          console.log(`[LOCK] Released lock for ${from} (job delete confirmation)`);
          return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>Are you sure you want to delete job '${jobName}'? Reply 'yes' or 'no'.</Message></Response>`);
        } else {
          reply = `⚠️ No active job named '${jobName}'.`;
          await db.collection('locks').doc(lockKey).delete();
          console.log(`[LOCK] Released lock for ${from} (job not active)`);
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
      }
    }
  } catch (err) {
    console.error(`Error in handleJob: ${err.message}`);
    throw err; // Let error middleware handle it
  }
}

module.exports = { handleJob };