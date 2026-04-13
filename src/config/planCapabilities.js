// src/config/planCapabilities.js
// Backend canonical plan capabilities (CommonJS).

/**
 * Plan keys:
 * - free
 * - starter
 * - pro
 *
 * Monthly capacity:
 * - number = included monthly capacity
 * - null   = effectively unbounded / included
 * Monthly Pricing:
 * - free
 * - starter = $59 USD
 * - pro = $149 USD
 * 
 * NOTE: Your clarified semantics:
 * - Free: owner can log for self AND can log "crew" by naming them (owner-mediated). No separate crew accounts.
 * - Starter: owner can add up to 10 employees and log "clock-in John..." (still owner-mediated).
 * - Pro: employees can log for themselves via WhatsApp (role-based permissions).
 */

const plan_capabilities = {
  free: {
    label: "Field Capture",

    jobs: { enabled: true, max_jobs_total: 3 },

    people: {
      owner_seats: 1,

      // ✅ employees exist as records even in Free (owner can name them),
      // but they cannot self-log from their own phone until Pro.
      max_employee_records: 3,

      // ✅ self-logging via WhatsApp (employees sending commands) is Pro.
      employee_self_logging: false,

      // board is Pro only
      max_board: 0,
    },

    capture: {
      text_logging: {
        expenses: { enabled: true },
        revenue: { enabled: true },
        time: { enabled: true },
        tasks: { enabled: true },
      },

      // premium capture surfaces
      ocr_receipts: { enabled: false, monthly_capacity: 0, behavior: "pause" },
      voice: { enabled: false, monthly_minutes: 0, behavior: "pause" },
    },

    reasoning: {
      ask_chief: { enabled: true, owner_only: true, monthly_questions: 10, behavior: "pause" },
    },

    exports: { enabled: true, watermark: true },

    approvals: { enabled: false },

    audit: { trail: true, depth: "basic" },

    retention: { history_days: 90, while_subscribed: false },

    bulk_import: { enabled: true, monthly_rows: 500, behavior: "pause" },
    email_capture: { enabled: false, monthly_capacity: 0, behavior: "pause" },

    supplier_catalog: { enabled: false },

    integrity: { hash_generation: true, on_demand_verify: false, export_badge: false, history: false },

    onboarding: { priority_onboarding: false },
  },

  starter: {
    label: "Owner Mode",

    jobs: { enabled: true, max_jobs_total: 25 },

    people: {
      owner_seats: 1,

      // ✅ Starter: owner can add up to 10 employees (records) and log for them
      max_employee_records: 10,

      // ✅ still NOT self-logging from their own phones
      employee_self_logging: false,

      max_board: 0,
    },

    capture: {
      text_logging: {
        expenses: { enabled: true },
        revenue: { enabled: true },
        time: { enabled: true },
        tasks: { enabled: true },
      },

      ocr_receipts: { enabled: true, monthly_capacity: 30, behavior: "pause" },
      voice: { enabled: true, monthly_minutes: 50, behavior: "pause" },
    },

    reasoning: {
      ask_chief: { enabled: true, owner_only: true, monthly_questions: 250, behavior: "pause" },
    },

    exports: { enabled: true, watermark: false },

    approvals: { enabled: false },

    audit: { trail: true, depth: "standard" },

    retention: { history_days: 365 * 3, while_subscribed: true },

    bulk_import: { enabled: true, monthly_rows: null, behavior: "pause" },
    email_capture: { enabled: true, monthly_capacity: 30, behavior: "pause" },

    // Starter: browse catalogs, search products, catalog-assisted quoting, expense itemization
    supplier_catalog: {
      enabled: true,
      preferred_suppliers: false,       // Pro only
      cross_supplier_compare: false,    // Pro only
    },

    integrity: { hash_generation: true, on_demand_verify: true, export_badge: true, history: false },

    onboarding: { priority_onboarding: false },
  },

  pro: {
    label: "Crew + Control",

    jobs: { enabled: true, max_jobs_total: null },

    people: {
      owner_seats: 1,

      // ✅ Pro: up to 25 employees records
      max_employee_records: 25,

      // ✅ Pro: employees can self-log from their own phones (WhatsApp)
      employee_self_logging: true,

      // ✅ Pro: board members
      max_board: 10,
    },

    capture: {
      text_logging: {
        expenses: { enabled: true },
        revenue: { enabled: true },
        time: { enabled: true },
        tasks: { enabled: true },
      },

      ocr_receipts: { enabled: true, monthly_capacity: 500, behavior: "pause" },
      voice: { enabled: true, monthly_minutes: 500, behavior: "pause" },
    },

    reasoning: {
      ask_chief: { enabled: true, owner_only: true, monthly_questions: 1000, behavior: "pause" },
    },

    exports: { enabled: true, watermark: false },

    approvals: { enabled: true },

    audit: { trail: true, depth: "full" },

    retention: { history_days: 365 * 7, while_subscribed: true },

    bulk_import: { enabled: true, monthly_rows: null, behavior: "pause" },
    email_capture: { enabled: true, monthly_capacity: null, behavior: "pause" },

    // Pro: full catalog access — preferred suppliers, cross-supplier comparison, purchasing analytics
    supplier_catalog: {
      enabled: true,
      preferred_suppliers: true,
      cross_supplier_compare: true,
    },

    integrity: { hash_generation: true, on_demand_verify: true, export_badge: true, history: true },

    onboarding: { priority_onboarding: true },
  },
};

module.exports = { plan_capabilities }; // source of truth for gating

