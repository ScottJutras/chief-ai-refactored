module.exports.copy = {
alreadyIn: s => `You’re already clocked in since ${s}.`,
clockedIn: (job, t) => `✅ Clocked in for ${job} at ${t}.`,
needOpenShift: `You need an open shift. Try: clock in.`,
started: kind => `▶️ ${kind} started.`,
stopped: kind => `⏸️ ${kind} stopped.`,
lunchStopped: (mins, over) => over>0 ? `⏸️ lunch stopped. Took ${mins}m (policy will deduct ${over}m).` : `⏸️ lunch stopped. Took ${mins}m.`,
clockedOut: (paidMinutes, unpaidLunch, unpaidBreak) => {
const h = Math.floor(paidMinutes/60), m = paidMinutes%60;
const parts = [];
if (unpaidLunch>0) parts.push(`lunch ${unpaidLunch}m`);
if (unpaidBreak>0) parts.push(`breaks ${unpaidBreak}m`);
const tail = parts.length? ` (policy deducted ${parts.join(', ')})` : '';
return `✅ Clocked out. ⏱️ Paid ${h}h ${m}m${tail}.`;
},
lunchReminder: `⏰ Time to wrap up your lunch and get back at 'er.`
};