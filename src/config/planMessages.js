// src/config/planMessages.js
// Central denial messages (CommonJS).
// WhatsApp-friendly: each message is a single string.

const { PRO_CREW_UPGRADE_LINE } = require('./upgradeCopy');

const plan_messages = {
  // ---- plan-required gates ----
  ASK_CHIEF_REQUIRES_STARTER: {
    title: "Ask Chief is part of Owner Mode",
    message: "Ask Chief is available on Starter and Pro. You can still log receipts, time, and jobs.",
    upgrade_plan: "starter",
  },

  EXPORTS_REQUIRES_STARTER: {
    title: "Exports are part of Owner Mode",
    message: "Exports are available on Starter and Pro. Upgrade to export clean job history anytime.",
    upgrade_plan: "starter",
  },

  OCR_REQUIRES_STARTER: {
    title: "Receipt scanning is part of Owner Mode",
    message: "Receipt scanning (OCR) is available on Starter and Pro. You can still log expenses by text.",
    upgrade_plan: "starter",
  },

  VOICE_REQUIRES_STARTER: {
    title: "Voice capture is part of Owner Mode",
    message: "Voice capture is available on Starter and Pro. You can still log by text anytime.",
    upgrade_plan: "starter",
  },

  // ✅ Semantics: employees cannot self-log from their own phones unless Pro
  EMPLOYEE_SELF_LOGGING_REQUIRES_PRO: {
    title: "Crew self-logging is part of Pro",
    message: PRO_CREW_UPGRADE_LINE,
    upgrade_plan: "pro",
  },
  CREW_SELF_LOGGING_REQUIRES_PRO: {
  message: "Pro unlocks crew self-logging — employees can clock in/out from their own phones.",
  upgrade_plan: "pro"
  },

  // If you want “crew requires pro” to map to the same copy:
  CREW_REQUIRES_PRO: {
    title: "Crew access is part of Pro",
    message: PRO_CREW_UPGRADE_LINE,
    upgrade_plan: "pro",
  },

  BOARD_REQUIRES_PRO: {
    title: "Board roles are part of Pro",
    message: "Board Members are available on Pro (up to 10). They can log/edit/approve, but cannot use Ask Chief.",
    upgrade_plan: "pro",
  },

  APPROVALS_REQUIRES_PRO: {
    title: "Approvals are part of Pro",
    message: "Approvals + audit control require Pro. Crew logs reality, owners (or board) approve truth.",
    upgrade_plan: "pro",
  },

  // ---- monthly capacity pauses ----
  OCR_CAPACITY_REACHED: {
    title: "Receipt scanning is paused for this month",
    message: "You can keep logging expenses by text. Upgrade to keep scanning receipts instantly.",
    upgrade_plan: "starter",
  },

  VOICE_CAPACITY_REACHED: {
    title: "Voice capture is paused for this month",
    message: "You can keep logging by text anytime. Upgrade to keep capturing hands-free on site.",
    upgrade_plan: "starter",
  },

  ASK_CHIEF_CAPACITY_REACHED: {
    title: "Ask Chief is paused for this month",
    message: "Your logs are still safe and still updating. Upgrade to keep getting answers grounded in your data.",
    upgrade_plan: "starter",
  },

  // ---- safety/defaulting ----
  UNKNOWN_PLAN_DEFAULTED_TO_FREE: {
    title: "Plan could not be determined",
    message: "Your plan could not be determined. Defaulting to Free limits for safety.",
    upgrade_plan: "starter",
  },

  // ---- retention ----
  RETENTION_WARNING_FREE_90D: {
    title: "Your oldest logs will expire soon",
    message: "Free plans keep 90 days of history. Upgrade to keep years of job history and receipts.",
    upgrade_plan: "starter",
  },
};

module.exports = { plan_messages };
