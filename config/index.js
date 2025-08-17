// config/index.js
require('dotenv').config();

/**
 * Twilio template snippets used throughout the bot.
 * Templates map to Twilio Content SIDs (HX_*) for quick replies.
 *
 * IMPORTANT:
 * - Keys here MUST match what your feature code uses.
 * - Environment variable names MUST match what you actually have in .env.
 */
const confirmationTemplates = {
  // Onboarding location confirmations (used in onboarding.js)
  locationConfirmation: process.env.LOCATION_CONFIRMATION,                 // HX0280df498999848aaff04cc079e16c31
  businessLocationConfirmation: process.env.BUSINESS_LOCATION_CONFIRMATION, // HXa885f78d...

  // Onboarding: industry & goal choices
  // Your .env uses TWILIO_TEMPLATE_INDUSTRY (not HEX_INDUSTRY_OPTIONS)
  industryOptions: process.env.TWILIO_TEMPLATE_INDUSTRY,                   // HX1d4c5b90...
  // Your .env has HEX_ONBOARDING_GOAL (not HEX_GOAL_OPTIONS)
  goalOptions: process.env.HEX_ONBOARDING_GOAL,                            // HX20b1be54...

  // Link template used after email (onboarding.js expects this key)
  // If you have a Content Template for sending a link, set it here.
  // Otherwise, onboarding.js will fallback to a plain message send.
  spreadsheetLink: process.env.HEX_SPREADSHEET_LINK || '',

  // Other templates you already had:
  expense: process.env.HEX_EXPENSE_CONFIRMATION,
  expenseSaved: ({ date, item, amount }) => `✅ Logged ${amount} for ${item} on ${date}.`,
  revenue: process.env.HEX_REVENUE_CONFIRMATION,
  bill: process.env.HEX_BILL_CONFIRMATION,
  startJob: process.env.HEX_START_JOB,
  deleteConfirmation: process.env.HEX_YES_NO,
  billTracking: process.env.HEX_BILL_TRACKING || process.env.HEX_BUSINESS_BILL_TRACKING || process.env.HEX_PERSONAL_BILL_TRACKING,
  addEmployees: process.env.HEX_ADD_EMPLOYEES,
  reminder: process.env.HEX_REMINDER,
  upgradeNow: process.env.HEX_UPGRADE_NOW,
  pricingConfirmation: process.env.HEX_PRICING_CONFIRMATION,
};

module.exports = { confirmationTemplates };
