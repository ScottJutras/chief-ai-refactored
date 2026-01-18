// utils/errorDetector.js
const storeList = require('./storeList');
const { todayInTimeZone } = require('./dateUtils');


function toMoneyNumber(val) {
  if (val == null) return null;
  const n = Number(String(val).replace(/[^0-9.,]/g, '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return n;
}

function normalizeStoreToken(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function looksLikeRealStoreName(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (t.toLowerCase() === 'unknown store') return false;
  // if it's extremely short, don't bother validating
  if (t.length < 3) return false;
  return true;
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

function detectErrors(data, type = 'expense', ctx = {}) {
  const errors = [];
  const d = data || {};

  // tz from ctx OR embedded in data/user profile style objects
  const tz = ctx?.tz || ctx?.timezone || d?.timezone || d?.tz || 'UTC';

  // --- Amount + Date validation for expense/revenue ---
  if (type === 'expense' || type === 'revenue') {
    // Amount validation
    const amountNum = toMoneyNumber(d.amount) ?? 0;

    if (amountNum <= 0) {
      errors.push({
        field: 'amount',
        severity: 'hard',
        message: 'Amount is zero or negative',
        suggested: '$50.00'
      });
    } else if (amountNum > 10000) {
      // ✅ This should NOT block: legitimate for contractors.
      errors.push({
        field: 'amount',
        severity: 'soft',
        message: 'Amount seems unusually high',
        suggested: `$${(amountNum / 10).toFixed(2)}`
      });
    }

    // Date validation
    const todayIso = todayInTimeZone(tz);

    if (!isIsoDate(d.date)) {
      errors.push({
        field: 'date',
        severity: 'hard',
        message: 'Invalid date format',
        suggested: todayIso
      });
    } else {
      // Compare as dates at noon UTC to avoid weird DST edge cases
      try {
        const dataDate = new Date(`${d.date}T12:00:00Z`);
        const todayDate = new Date(`${todayIso}T12:00:00Z`);
        if (dataDate.getTime() > todayDate.getTime()) {
          // ✅ Default safe policy: block future dates (hard)
          errors.push({
            field: 'date',
            severity: 'hard',
            message: 'Date is in the future',
            suggested: todayIso
          });
        }
      } catch {
        errors.push({
          field: 'date',
          severity: 'hard',
          message: 'Invalid date',
          suggested: todayIso
        });
      }
    }
  }

  // --- Expense store validation (SOFT) ---
  if (type === 'expense') {
    const store = String(d.store || '').trim();

    if (looksLikeRealStoreName(store)) {
      const storeLower = normalizeStoreToken(store);

      // If we don't have a store list, do not block ingestion
      const list = Array.isArray(storeList) ? storeList : [];

      const isKnownStore = list.some(
        (st) =>
          normalizeStoreToken(st).includes(storeLower) ||
          storeLower.includes(normalizeStoreToken(st))
      );

      if (!isKnownStore && store !== 'Unknown Store') {
        let suggestedStore = null;

        const hd = list.find((st) => /home\s*depot/i.test(st));
        if (/home|depot|homedepot|homdep|homed/i.test(storeLower) && hd) {
          suggestedStore = hd;
        } else {
          suggestedStore = list[0] || 'Home Depot';
        }

        // ✅ Store recognition should never block logging.
        errors.push({
          field: 'store',
          severity: 'soft',
          message: 'Store not recognized',
          suggested: suggestedStore
        });
      }
    }
  }
  // --- Revenue: client/payer/source should be OPTIONAL (contractor-first) ---
  // Your aiErrorHandler already ignores client/payer missing for revenue.
  // So we DO NOT flag missing client here.
  if (type === 'revenue') {
    // Optional: if you ever want a gentle warning, do it as non-blocking elsewhere.
  }

  return errors.length > 0 ? errors : null;
}

module.exports = { detectErrors };
