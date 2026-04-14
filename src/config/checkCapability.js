// src/config/checkCapability.js
// Backend capability gating (CommonJS).

const { plan_capabilities } = require("./planCapabilities");
const { plan_messages } = require("./planMessages");

/**
 * Decision shape (WhatsApp friendly):
 * - allowed: boolean
 * - reason_code: string|null
 * - message: string|null
 * - upgrade_plan: "free"|"starter"|"pro"|null
 */
function allow() {
  return { allowed: true, reason_code: null, message: null, upgrade_plan: null };
}

function deny(code, fallbackMessage) {
  const m = plan_messages[code];
  return {
    allowed: false,
    reason_code: code,
    message: (m && m.message) || fallbackMessage || "This action isn’t available on your plan.",
    upgrade_plan: (m && m.upgrade_plan) || null,
  };
}

function getPlanOrDefault(plan) {
  const p = String(plan || "").toLowerCase().trim();
  if (p === "free" || p === "starter" || p === "pro") return p;
  return "free";
}

function getCaps(plan) {
  const p = getPlanOrDefault(plan);
  return plan_capabilities[p] || plan_capabilities.free;
}

/**
 * Your clarified semantics:
 * - "crew logging" in Free/Starter means: owner can log time FOR crew members.
 * - Pro unlocks: employees can self-log from their own phone numbers.
 *
 * So we DO NOT gate owner time capture by role=crew unless the actor is truly an employee phone.
 */
function canEmployeeSelfLog(plan) {
  const p = getPlanOrDefault(plan);
  const caps = getCaps(p);

  if (!caps.people || caps.people.employee_self_logging !== true) {
    return deny("EMPLOYEE_SELF_LOGGING_REQUIRES_PRO");
  }
  return allow();
}

/**
 * Ask Chief: owner-only + plan must enable + capacity check
 */
function canAskChief(plan, role, usedQuestionsThisMonth) {
  if (String(role || "").toLowerCase() !== "owner") {
    return deny("ASK_CHIEF_REQUIRES_STARTER");
  }

  const p = getPlanOrDefault(plan);
  const caps = getCaps(p);

  if (!caps.reasoning || !caps.reasoning.ask_chief || caps.reasoning.ask_chief.enabled !== true) {
    return deny("ASK_CHIEF_REQUIRES_STARTER");
  }

  const cap = caps.reasoning.ask_chief.monthly_questions;
  if (typeof cap === "number" && typeof usedQuestionsThisMonth === "number" && usedQuestionsThisMonth >= cap) {
    return deny("ASK_CHIEF_CAPACITY_REACHED");
  }

  return allow();
}

function canExport(plan) {
  const p = getPlanOrDefault(plan);
  const caps = getCaps(p);

  if (!caps.exports || caps.exports.enabled !== true) {
    return deny("EXPORTS_REQUIRES_STARTER");
  }
  return allow();
}

function canUseOCR(plan, usedReceiptsThisMonth) {
  const p = getPlanOrDefault(plan);
  const caps = getCaps(p);

  if (!caps.capture || !caps.capture.ocr_receipts || caps.capture.ocr_receipts.enabled !== true) {
    return deny("OCR_REQUIRES_STARTER");
  }

  const cap = caps.capture.ocr_receipts.monthly_capacity;
  if (typeof cap === "number" && typeof usedReceiptsThisMonth === "number" && usedReceiptsThisMonth >= cap) {
    return deny("OCR_CAPACITY_REACHED");
  }

  return allow();
}

function canUseVoice(plan, usedVoiceMinutesThisMonth) {
  const p = getPlanOrDefault(plan);
  const caps = getCaps(p);

  if (!caps.capture || !caps.capture.voice || caps.capture.voice.enabled !== true) {
    return deny("VOICE_REQUIRES_STARTER");
  }

  const cap = caps.capture.voice.monthly_minutes;
  if (typeof cap === "number" && typeof usedVoiceMinutesThisMonth === "number" && usedVoiceMinutesThisMonth >= cap) {
    return deny("VOICE_CAPACITY_REACHED");
  }

  return allow();
}

function canUseApprovals(plan, role) {
  const p = getPlanOrDefault(plan);
  const caps = getCaps(p);

  if (!caps.approvals || caps.approvals.enabled !== true) {
    return deny("APPROVALS_REQUIRES_PRO");
  }

  const r = String(role || "").toLowerCase();
  if (r !== "owner" && r !== "board") return deny("APPROVALS_REQUIRES_PRO");

  return allow();
}
function canUseTasks(plan) {
  const p = getPlanOrDefault(plan);
  const caps = getCaps(p);

  if (!caps.capture || !caps.capture.text_logging || caps.capture.text_logging.tasks?.enabled !== true) {
    return deny("TASKS_REQUIRES_STARTER");
  }
  return allow();
}

function canCrewSelfLog(plan) {
  const p = getPlanOrDefault(plan);
  if (p === 'pro' || p === 'enterprise') return allow();
  return deny("CREW_SELF_LOGGING_REQUIRES_PRO");
}

/**
 * Time logging:
 * - Always allowed for owner, on all plans
 * - Allowed for employee self-log only if Pro
 *
 * role should reflect who is sending the WhatsApp message:
 * - owner: the owner’s phone
 * - employee: an employee phone (self logging)
 * - board: board phone (pro)
 *
 * If you currently only have "owner|crew|board":
 * - treat "crew" AS employee phone self-logging attempt.
 */
function canLogTime(plan, role) {
  const r = String(role || "").toLowerCase();

  // owner can always log time (for self OR for named crew members)
  if (r === "owner") return allow();

  // board logging is pro-only in your roadmap; allow only if pro (optional)
  if (r === "board") {
    const p = getPlanOrDefault(plan);
    if (p !== "pro") return deny("BOARD_REQUIRES_PRO");
    return allow();
  }

  // treat "crew" as employee self-logging from their phone
  if (r === "crew" || r === "employee") {
    return canEmployeeSelfLog(plan);
  }

  // unknown role => fail safe
  return deny("UNKNOWN_PLAN_DEFAULTED_TO_FREE");
}

module.exports = {
  getPlanOrDefault,
  getCaps,
  canEmployeeSelfLog,
  canAskChief,
  canExport,
  canUseOCR,
  canUseVoice,
  canUseApprovals,
  canLogTime,
  canUseTasks,
};
