// src/config/capabilities.js
const { plan_capabilities } = require("./planCapabilities");
const { getEffectivePlanKey } = require("./getEffectivePlanKey");

function capForOwner(owner) {
  const k = getEffectivePlanKey(owner);
  return plan_capabilities[k] || plan_capabilities.free;
}

module.exports = { capForOwner, getEffectivePlanKey };
