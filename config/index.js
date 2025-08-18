/**
 * Twilio template snippets used throughout the bot.
 * Templates map to Twilio Content SIDs (HEX_* in .env) for quick replies.
 * If a SID is missing, handlers will gracefully fall back to plain text.
 */
const confirmationTemplates = {
  // Onboarding: “Is this your personal location?” (expects 2 text params: province, country)
  locationConfirmation: process.env.LOCATION_CONFIRMATION,

  // Onboarding: “Is your business location the same?” (no params)
  businessLocationConfirmation: process.env.BUSINESS_LOCATION_CONFIRMATION,

  // Common confirmations
  expense: process.env.HEX_EXPENSE_CONFIRMATION,
  expenseSaved: ({ date, item, amount }) => `✅ Logged ${amount} for ${item} on ${date}.`,
  revenue: process.env.HEX_REVENUE_CONFIRMATION,
  bill: process.env.HEX_BILL_CONFIRMATION,
  startJob: process.env.HEX_START_JOB,
  deleteConfirmation: process.env.HEX_YES_NO,

  // Onboarding choices and prompts (leave here for future steps if/when you use them)
  industryOptions: process.env.HEX_INDUSTRY_OPTIONS,
  goalOptions: process.env.HEX_GOAL_OPTIONS,
  financialGoal: process.env.HEX_ONBOARDING_GOAL,
  billTracking: process.env.HEX_BILL_TRACKING,
  addEmployees: process.env.HEX_ADD_EMPLOYEES,
  reminder: process.env.HEX_REMINDER,
  upgradeNow: process.env.HEX_UPGRADE_NOW,
  pricingConfirmation: process.env.HEX_PRICING_CONFIRMATION,

  // Optional: if you have a “send link” template for the dashboard
  spreadsheetLink: process.env.HEX_SPREADSHEET_LINK // (add to .env if you have it)
};

module.exports = { confirmationTemplates };
