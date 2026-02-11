// utils/quota.js
// Centralized money-surface gating (MVP-safe)
// Rule: check quota BEFORE any paid API call, then increment only when allowed.

const db = require('../services/postgres');

// IMPORTANT: keep this minimal and deterministic.
// If limits are unknown, make them conservative.
// You can tune numbers later without code changes elsewhere.
const PLAN_LIMITS = {
  free: {
    ocr: 0,              // paid feature off
    stt: 0,              // paid feature off
    export_pdf: 0,
    export_xlsx: 0
  },
  starter: {
    ocr: 100,            // receipts per month
    stt: 600,            // seconds per month (10 min)
    export_pdf: 10,
    export_xlsx: 5
  },
  pro: {
    ocr: 1000,
    stt: 7200,           // 2 hours
    export_pdf: 200,
    export_xlsx: 100
  }
};

// Returns { ok: true } or { ok:false, reason, limit, used, planKey }
async function checkMonthlyQuota({ ownerId, planKey, kind, units = 1, monthKey = null }) {
  const pk = String(planKey || 'free').toLowerCase().trim() || 'free';
  const limits = PLAN_LIMITS[pk] || PLAN_LIMITS.free;
  const limit = Number(limits[kind] ?? 0);

  const used = await db.getMonthlyUsage({ ownerId, kind, monthKey });

  // if limit is 0 => denied (feature not included)
  if (!Number.isFinite(limit) || limit <= 0) {
    return { ok: false, reason: 'NOT_INCLUDED', limit: 0, used, planKey: pk };
  }

  const needed = Math.max(1, Number(units || 1));
  if (used + needed > limit) {
    return { ok: false, reason: 'OVER_QUOTA', limit, used, planKey: pk };
  }

  return { ok: true, limit, used, planKey: pk };
}

// Call this only AFTER checkMonthlyQuota returned ok:true
async function consumeMonthlyQuota({ ownerId, kind, units = 1, monthKey = null }) {
  const add = Math.max(1, Number(units || 1));
  return db.incrementMonthlyUsage({ ownerId, kind, monthKey, amount: add });
}

module.exports = {
  PLAN_LIMITS,
  checkMonthlyQuota,
  consumeMonthlyQuota
};
