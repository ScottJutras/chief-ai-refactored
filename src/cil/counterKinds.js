// src/cil/counterKinds.js
// Canonical set of counter_kind values used by allocateNextDocCounter.
// See docs/QUOTES_SPINE_DECISIONS.md §17.13 (strategy) and §18 (Migration 5).
//
// To add a new counter kind: add an entry here AND ensure the new kind's
// allocation site passes COUNTER_KINDS.<NAME>. DB-side format CHECK
// (^[a-z][a-z_]*$, 1-64 chars) will accept any well-formed value, so the
// source of truth for the product-concept set lives here — not in the DB.

const COUNTER_KINDS = Object.freeze({
  ACTIVITY_LOG: 'activity_log',
  QUOTE: 'quote',
  INVOICE: 'invoice',
  CHANGE_ORDER: 'change_order',
  RECEIPT: 'receipt',
});

module.exports = { COUNTER_KINDS };
