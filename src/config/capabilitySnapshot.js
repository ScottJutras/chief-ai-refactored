// src/config/capabilitySnapshot.js
// Canonical capability snapshot for UI + messaging (CommonJS).
// Uses the same gate functions as runtime enforcement.

const { getPlanOrDefault, canLogTime, canAskChief, canUseOCR, canUseVoice, canExport, canUseApprovals } =
  require("./checkCapability");

const { plan_capabilities } = require("./planCapabilities");

function snapshotFor(plan, role, usage = {}) {
  const p = getPlanOrDefault(plan);
  const caps = plan_capabilities[p] || plan_capabilities.free;

  // NOTE: usage values are optional; if omitted, capacity-based gates will be treated as "unknown usage"
  // and will usually allow (because we only deny on a known cap hit).
  const used = {
    receipts_this_month: usage.receipts_this_month ?? null,
    voice_minutes_this_month: usage.voice_minutes_this_month ?? null,
    ask_chief_questions_this_month: usage.ask_chief_questions_this_month ?? null,
  };

  return {
    plan: p,
    role: String(role || "owner").toLowerCase().trim(),
    label: caps.label,

    // People limits (for UI)
    people: {
      max_employee_records: caps.people?.max_employee_records ?? 0,
      employee_self_logging: caps.people?.employee_self_logging === true,
      max_board: caps.people?.max_board ?? 0,
    },

    // Core gates (WhatsApp-safe decision objects)
    gates: {
      timeclock: canLogTime(p, role),
      exports: canExport(p),
      ocr_receipts: canUseOCR(p, used.receipts_this_month),
      voice: canUseVoice(p, used.voice_minutes_this_month),
      approvals: canUseApprovals(p, role),

      // Ask Chief exists in map, even if you aren’t wired yet
      ask_chief: canAskChief(p, role, used.ask_chief_questions_this_month),
    },

    // Raw capabilities (for UI/marketing display)
    raw: caps,
  };
}

module.exports = { snapshotFor };
