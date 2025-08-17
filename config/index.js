/**
 * Twilio template snippets used throughout the bot.
 * Templates map to Twilio Content SIDs (HEX_* in .env) for quick replies.
 */
const confirmationTemplates = {
  expense: process.env.HEX_EXPENSE_CONFIRMATION, // SID for expense confirmation
  expenseSaved: ({ date, item, amount }) =>
    `✅ Logged ${amount} for ${item} on ${date}.`,
  revenue: process.env.HEX_REVENUE_CONFIRMATION, // SID for revenue confirmation
  bill: process.env.HEX_BILL_CONFIRMATION, // SID for bill confirmation
  startJob: process.env.HEX_START_JOB, // SID for job start confirmation
  deleteConfirmation: process.env.HEX_YES_NO, // SID for delete confirmation
  locationConfirmation: process.env.LOCATION_CONFIRMATION, // SID for location
  businessLocationConfirmation: process.env.BUSINESS_LOCATION_CONFIRMATION, // SID for business location
  industryOptions: process.env.HEX_INDUSTRY_OPTIONS, // SID for industry selection
  goalOptions: process.env.HEX_GOAL_OPTIONS, // SID for historical data
  financialGoal: process.env.HEX_ONBOARDING_GOAL, // SID for financial goal
  billTracking: process.env.HEX_BILL_TRACKING, // SID for bill tracking
  addEmployees: process.env.HEX_ADD_EMPLOYEES, // SID for team setup
  reminder: process.env.HEX_REMINDER, // SID for reminder scheduling
  upgradeNow: process.env.HEX_UPGRADE_NOW, // SID for upgrade prompts
  pricingConfirmation: process.env.HEX_PRICING_CONFIRMATION // SID for pricing item confirmation
};

module.exports = { confirmationTemplates };