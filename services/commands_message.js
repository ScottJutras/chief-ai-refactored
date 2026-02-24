// services/commands_message.js
// Plain-text WhatsApp response (no markdown). Keep under ~4096 chars.

function buildCommandsMessage() {
  return [
    "📘 Chief Command Reference",
    "",
    "JOBS",
    "• create job <name>",
    "• close job <name>",
    "• what job is active?",
    "",
    "REVENUE",
    "• revenue 1250 deposit",
    "• revenue 1250 deposit job <job name>",
    "",
    "EXPENSE",
    "• expense 68.38 petro canada",
    "• expense 68.38 petro canada job <job name>",
    "",
    "TIMECLOCK",
    "• clock in",
    "• clock out",
    "• break start",
    "• break stop",
    "",
    "TASKS",
    "• create task get materials",
    "• my tasks",
    "",
    "INSIGHTS",
    "• How much did I spend this month?",
    "• Profit month to date",
    "",
    "You can also send voice notes or receipt photos."
  ].join("\n");
}

module.exports = { buildCommandsMessage };