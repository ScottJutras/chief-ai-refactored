const { logTimeEntry, getTimeEntries, generateTimesheet, getActiveJob } = require('../services/postgres');

async function handleTimeclock(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const lcInput = input.toLowerCase().trim();

    if (lcInput.includes('hours') && (lcInput.includes('week') || lcInput.includes('day') || lcInput.includes('month'))) {
      const parts = lcInput.split(' ');
      const employeeName = parts[0];
      const period = parts.find(p => ['day', 'week', 'month'].includes(p)) || 'week';
      const timesheet = await generateTimesheet(ownerId, employeeName, period, new Date());
      reply = `${employeeName}'s ${period}ly hours (starting ${timesheet.startDate}):\n` +
              `Total Hours: ${timesheet.totalHours}\n` +
              `Drive Hours: ${timesheet.driveHours}`;
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    const parts = lcInput.split(' ');
    const employeeName = parts[0];
    const type = parts.slice(1).join(' ').match(/(punch in|punch out|break start|break end|lunch start|lunch end|drive start|drive end)/i)?.[1].replace(' ', '_').toLowerCase();
    if (!employeeName || !type) {
      reply = '⚠️ Invalid time entry. Use format: "[Name] punched in at 9am" or "[Name] hours week".';
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    const timestamp = new Date().toISOString();
    const activeJob = await getActiveJob(ownerId);
    await logTimeEntry(ownerId, employeeName, type, timestamp, activeJob !== 'Uncategorized' ? activeJob : null);
    reply = `✅ ${type.replace('_', ' ')} logged for ${employeeName} at ${new Date(timestamp).toLocaleString()}${activeJob !== 'Uncategorized' ? ` on ${activeJob}` : ''}`;
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (error) {
    console.error(`[ERROR] handleTimeclock failed for ${from}:`, error.message);
    reply = '⚠️ Error logging time entry. Please try again.';
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } finally {
    await require('../middleware/lock').releaseLock(lockKey);
  }
}

module.exports = { handleTimeclock };