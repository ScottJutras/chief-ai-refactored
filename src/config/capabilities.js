// src/config/capabilities.js
const { plan_capabilities } = require('./planCapabilities');

function getEffectivePlanKey(owner) {
  const key = String(owner?.plan_key || 'free');
  const status = String(owner?.sub_status || '');
  const paidOk = status === 'active' || status === 'trialing';
  return paidOk ? key : 'free';
}

function capForOwner(owner) {
  const k = getEffectivePlanKey(owner);
  return plan_capabilities[k] || plan_capabilities.free;
}

module.exports = { capForOwner, getEffectivePlanKey };
