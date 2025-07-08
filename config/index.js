// config/index.js

/**
 * Twilio template snippets used throughout the bot.
 * Feel free to customize messages or add new templates here.
 */
const confirmationTemplates = {
  // Used in expense.js for confirming a pending expense
  expense: [
    { type: "text", text: "⚠️ You entered: {{1}}. Reply 'yes' to save, 'no' to cancel." }
  ],
  // Used in expense.js once an expense is saved
  expenseSaved: ({ date, item, amount }) =>
    `✅ Logged ${amount} for ${item} on ${date}.`,

  // Used to ask before deleting any entry
  deleteConfirmation: [
    { type: "text", text: "⚠️ Are you sure you want to delete this? Reply 'yes' or 'no'." }
  ],

  // Used in job.js to confirm a job start
  startJob: [
    { type: "text", text: "✅ Job started: {{1}}" }
  ],

  // you can add more as needed, for example:
  // finishJob, pauseJob, resumeJob, etc.
};

module.exports = { confirmationTemplates };
