const { db } = require('../services/firebase');
const { logTimeEntry, getTimeEntries, generateTimesheet, getActiveJob } = require('../services/postgres');
const { callOpenAI } = require('../services/openAI');
const { releaseLock } = require('../middleware/lock');
const { sendTemplateMessage, sendMessage } = require('../services/twilio');
const { confirmationTemplates } = require('../config');

async function handleTimeclock(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const state = await require('../utils/stateManager').getPendingTransactionState(from);
    const lcInput = input.toLowerCase();

    if (state?.pendingTimeEntry && (lcInput === 'yes' || lcInput === 'no' || lcInput === 'edit' || lcInput === 'cancel')) {
      if (lcInput === 'yes') {
        const { employeeName, type, timestamp, job } = state.pendingTimeEntry;
        await logTimeEntry(ownerId, employeeName, type, timestamp, job);
        reply = `✅ ${type.replace('_', ' ')} logged for ${employeeName} at ${new Date(timestamp).toLocaleString()}${job ? ` on ${job}` : ''}`;
        await db.collection('users').doc(ownerId).collection('time_entries').add({
          employee_name: employeeName,
          type,
          timestamp,
          job,
          created_at: new Date().toISOString()
        });
        await require('../utils/stateManager').deletePendingTransactionState(from);
        await releaseLock(lockKey);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (lcInput === 'no' || lcInput === 'cancel') {
        reply = 'Time entry cancelled.';
        await require('../utils/stateManager').deletePendingTransactionState(from);
        await releaseLock(lockKey);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (lcInput === 'edit') {
        reply = 'Please resend the time entry (e.g., "Alex punched in at 9am").';
        await require('../utils/stateManager').deletePendingTransactionState(from);
        await releaseLock(lockKey);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    if (lcInput.includes('hours') && (lcInput.includes('week') || lcInput.includes('day') || lcInput.includes('month'))) {
      const prompt = `Parse time query: "${input}". Return JSON: { employeeName: "string", period: "day|week|month" }`;
      const { employeeName, period } = JSON.parse(await callOpenAI(prompt, input, 'gpt-3.5-turbo', 50, 0.3));
      const timesheet = await generateTimesheet(ownerId, employeeName, period, new Date());
      reply = `${employeeName}'s ${period}ly hours (starting ${timesheet.startDate}):\n` +
              `Total Hours: ${timesheet.totalHours}\n` +
              `Drive Hours: ${timesheet.driveHours}\n` +
              `Would you like to download a timesheet PDF? Reply 'yes' or 'no'.`;
      await require('../utils/stateManager').setPendingTransactionState(from, {
        pendingTimesheet: { employeeName, period }
      });
      await releaseLock(lockKey);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else if (state?.pendingTimesheet && (lcInput === 'yes' || lcInput === 'no')) {
      if (lcInput === 'yes') {
        const { employeeName, period } = state.pendingTimesheet;
        const timesheet = await generateTimesheet(ownerId, employeeName, period, new Date());
        const pdfUrl = await generateTimesheetPDF(ownerId, timesheet);
        reply = `Timesheet generated for ${employeeName}: ${pdfUrl}`;
        await require('../utils/stateManager').deletePendingTransactionState(from);
        await releaseLock(lockKey);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else {
        reply = 'Timesheet request cancelled.';
        await require('../utils/stateManager').deletePendingTransactionState(from);
        await releaseLock(lockKey);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    const prompt = `Parse time entry: "${input}". Return JSON: { employeeName: "string", type: "punch_in|punch_out|break_start|break_end|lunch_start|lunch_end|drive_start|drive_end", timestamp: "ISO string" }`;
    const { employeeName, type, timestamp } = JSON.parse(await callOpenAI(prompt, input, 'gpt-3.5-turbo', 100, 0.3));
    if (!employeeName || !type || !timestamp) {
      throw new Error('Invalid time entry format');
    }

    const activeJob = await getActiveJob(ownerId);
    reply = `Please confirm: Log ${type.replace('_', ' ')} for ${employeeName} at ${new Date(timestamp).toLocaleString()}${activeJob !== 'Uncategorized' ? ` on ${activeJob}` : ''}? Reply 'yes', 'no', or 'edit'.`;
    await require('../utils/stateManager').setPendingTransactionState(from, {
      pendingTimeEntry: { employeeName, type, timestamp, job: activeJob !== 'Uncategorized' ? activeJob : null }
    });
    await releaseLock(lockKey);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (error) {
    console.error(`Error in handleTimeclock: ${error.message}`);
    await releaseLock(lockKey);
    throw error;
  }
}

async function generateTimesheetPDF(ownerId, timesheet) {
  const PDFDocument = require('pdfkit');
  const fs = require('fs').promises;
  const { uploadFile, setFilePermissions } = require('../services/drive');

  const doc = new PDFDocument();
  const outputPath = `/tmp/timesheet_${ownerId}_${Date.now()}.pdf`;
  doc.pipe(fs.createWriteStream(outputPath));

  doc.fontSize(16).text(`Timesheet for ${timesheet.employeeName}`, { align: 'center' });
  doc.fontSize(12).text(`Company: ${timesheet.company.name}, ${timesheet.company.province}, ${timesheet.company.country}`);
  doc.moveDown();
  doc.text(`Period: ${timesheet.period} starting ${timesheet.startDate}`);
  doc.text(`Total Hours: ${timesheet.totalHours}`);
  doc.text(`Drive Hours: ${timesheet.driveHours}`);
  doc.moveDown();

  Object.keys(timesheet.entriesByDay).forEach(date => {
    doc.text(`Date: ${date}`);
    timesheet.entriesByDay[date].forEach(entry => {
      doc.text(`${entry.type.replace('_', ' ')}: ${new Date(entry.timestamp).toLocaleString()}${entry.job ? ` (Job: ${entry.job})` : ''}`);
    });
    doc.moveDown();
  });

  doc.end();

  const fileName = `Timesheet_${ownerId}_${Date.now()}.pdf`;
  const driveResponse = await uploadFile(fileName, 'application/pdf', fs.createReadStream(outputPath));
  await setFilePermissions(driveResponse.id, 'reader', 'anyone');
  return driveResponse.webViewLink;
}

module.exports = { handleTimeclock };