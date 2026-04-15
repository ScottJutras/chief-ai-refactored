// routes/askChief.js
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const { requireDashboardOwner } = require("../middleware/requireDashboardOwner");
const { requirePortalUser } = require("../middleware/requirePortalUser");
const { runAgent } = require("../services/agent");
const { enforceAskChiefGates_AND_Consume } = require("../services/answerChief");
const { runEmployeeSupportMode } = require("../handlers/askChief/employeeSupport");

const ASK_CHIEF_REQUIRE_PLAN = String(process.env.ASK_CHIEF_REQUIRE_PLAN || "1") === "1";
const ASK_CHIEF_AGENT_TIMEOUT_MS = Number(process.env.ASK_CHIEF_AGENT_TIMEOUT_MS || 15000);

let _admin = null;
function getAdminSupabase() {
  if (_admin) return _admin;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  _admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return _admin;
}

/**
 * Portal requests use Authorization: Bearer <supabase_jwt>
 * so Authorization header is NOT a valid dashboard signal.
 * Dashboard mode should be cookie-driven only.
 */
function hasDashboardToken(req) {
  const cookie = String(req.headers?.cookie || "");
  return (
    cookie.includes("chiefos_dashboard_token=") ||
    cookie.includes("dashboard_token=") ||
    cookie.includes("dashboardToken=")
  );
}

function makeTraceId() {
  return `ask_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildEvidenceMeta({ range, tenantId, tz, actorKey }) {
  return {
    range: range || "mtd",
    job: null,
    tables: {},
    totals: {},
    meta: {
      channel: tenantId ? "portal" : "dashboard",
      tenantId: tenantId || null,
      tz: tz || "America/Toronto",
      actorKey: actorKey || null,
    },
  };
}

function safeTimeoutAnswer(text) {
  const hint = text && text.length > 0
    ? " Try narrowing the question — add a date range (MTD, WTD, today) or a specific job name so I can answer faster."
    : " Try again in a moment, or rephrase with a specific date range or job name.";
  return "That question took longer than my time limit." + hint;
}

function withTimeout(promise, ms, label = "operation_timeout") {
  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(label);
      err.code = "TIMEOUT";
      reject(err);
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function requireOneAuthMode(req, res) {
  if (hasDashboardToken(req)) {
    await new Promise((resolve, reject) =>
      requireDashboardOwner(req, res, (err) => (err ? reject(err) : resolve()))
    );
    return "dashboard";
  }

  await new Promise((resolve, reject) =>
    requirePortalUser()(req, res, (err) => (err ? reject(err) : resolve()))
  );
  return "portal";
}

router.post("/api/ask-chief", express.json(), async (req, res) => {
  const startedAt = Date.now();
  const traceId = req.headers["x-trace-id"] || makeTraceId();

  try {
    // ---------------- Auth ----------------
    const authMode = await requireOneAuthMode(req, res);
    if (res.headersSent) return;

    // ---------------- Input normalization ----------------
    const ownerId = String(req.ownerId || "").trim();
    const tenantId = String(req.tenantId || "").trim() || null;
    const portalUserId = String(req.portalUserId || "").trim() || null;
    const portalRole = String(req.portalRole || "").trim().toLowerCase();
    const tz = req.tenant?.tz || "America/Toronto";

    const prompt = String(req.body?.prompt || "").trim();
    const textLegacy = String(req.body?.text || "").trim();
    const text = prompt || textLegacy;

    const range = String(req.body?.range || "mtd").trim() || "mtd";
    const actorKey = portalUserId || ownerId || "portal";

    // Page context — where the user is in the portal and which job they're viewing
    const pageContext = req.body?.page_context && typeof req.body.page_context === "object"
      ? req.body.page_context
      : null;

    // Conversation history — last N message pairs from the client UI
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(0, 20) : [];

    console.info("[ASK_CHIEF_START]", {
      traceId,
      authMode,
      tenantId,
      ownerId: ownerId || null,
      portalUserId,
      portalRole: portalRole || null,
      range,
      hasText: !!text,
    });

    if (!text) {
      return res.status(400).json({
        ok: false,
        code: "BAD_REQUEST",
        message: "Missing prompt.",
        traceId,
      });
    }

    // ---------------- Role gate (portal only) ----------------
    // owner/admin/board => full Ask Chief (metered, tenant financial scope).
    // employee (or anything else) => unmetered support mode with restricted
    // prompt and own-data-only access. Skips plan gate + quota consume.
    if (authMode === "portal" && portalRole) {
      const ownerAllowed = new Set(["owner", "admin", "board", "board_member"]);
      if (!ownerAllowed.has(portalRole)) {
        const support = await runEmployeeSupportMode({
          tenantId,
          actorId: req.actorId,
          ownerId: ownerId || null,
          portalRole,
          planKey: req.planKey || "free",
          prompt: text,
          history,
          tz,
          traceId,
        });
        return res.status(200).json({
          ok: true,
          answer: support.answer,
          evidence_meta: buildEvidenceMeta({ range, tenantId, tz, actorKey }),
          warnings: support.warnings,
          actions: support.actions,
          mode: "support",
          traceId,
        });
      }
    }

    // ---------------- Linkage / owner boundary guard ----------------
    // Portal must not continue without owner_id. Fail closed.
    if (authMode === "portal" && tenantId && !ownerId) {
      console.warn("[ASK_CHIEF_NOT_LINKED]", {
        traceId,
        tenantId,
        reason: "missing_owner_id_for_portal_tenant",
      });

      return res.status(200).json({
        ok: false,
        code: "NOT_LINKED",
        message: "Ask Chief reads your transaction ledger, which is built by logging expenses and revenue through WhatsApp. Link your WhatsApp to start — once you have data, Chief can answer questions about cashflow, job profit, and more.",
        actions: [
          { label: "Link WhatsApp", href: "https://app.usechiefos.com/app/link-phone", kind: "primary" },
          { label: "How it works", href: "https://usechiefos.com/#faq", kind: "secondary" },
        ],
        traceId,
      });
    }

    // ---------------- Plan gate ----------------
    if (ASK_CHIEF_REQUIRE_PLAN) {
      try {
        if (!tenantId) {
          console.info("[ASK_CHIEF_PLAN_GATE]", {
            traceId,
            mode: "dashboard",
            decision: "allow",
            reason: "no_tenant_id_dashboard_mode",
          });
        } else {
          const ownerDigits = ownerId;

          console.info("[ASK_CHIEF_OWNER_DIGITS]", {
            traceId,
            tenantId,
            ownerDigits: ownerDigits || null,
          });

          if (!ownerDigits) {
            return res.status(200).json({
              ok: false,
              code: "NOT_LINKED",
              message: "Ask Chief reads your transaction ledger. Start logging expenses and revenue — via WhatsApp or the web portal — and Chief can answer questions about cashflow, job profit, overhead, and more.",
              actions: [
                { label: "Log a transaction", href: "https://app.usechiefos.com/app/transactions/new", kind: "primary" },
                { label: "Link WhatsApp", href: "https://app.usechiefos.com/app/link-phone", kind: "secondary" },
                { label: "How it works", href: "https://usechiefos.com/#faq", kind: "secondary" },
              ],
              traceId,
            });
          }

          const supabase = getAdminSupabase();

          const u = await supabase
            .from("users")
            .select(
              "user_id, owner_id, plan_key, subscription_tier, stripe_subscription_id, stripe_price_id, current_period_end, trial_end, cancel_at_period_end, sub_status"
            )
            .eq("user_id", ownerDigits)
            .maybeSingle();

          const userRow = u?.data || null;

          if (!userRow?.user_id) {
            console.warn("[ASK_CHIEF_NOT_LINKED]", {
              traceId,
              tenantId,
              ownerDigits,
              reason: "missing_users_row_for_owner_digits",
            });

            return res.status(200).json({
              ok: false,
              code: "NOT_LINKED",
              message: "Ask Chief reads your transaction ledger. Start logging expenses and revenue — via WhatsApp or the web portal — and Chief can answer questions about cashflow, job profit, overhead, and more.",
              actions: [
                { label: "Log a transaction", href: "https://app.usechiefos.com/app/transactions/new", kind: "primary" },
                { label: "Link WhatsApp", href: "https://app.usechiefos.com/app/link-phone", kind: "secondary" },
                { label: "How it works", href: "https://usechiefos.com/#faq", kind: "secondary" },
              ],
              traceId,
            });
          }

          const planKey = String(userRow.plan_key || "").toLowerCase().trim();
          const tier = String(userRow.subscription_tier || "").toLowerCase().trim();
          const subId = String(userRow.stripe_subscription_id || "").trim();
          const status = String(userRow.sub_status || "").toLowerCase().trim();

          const now = Date.now();
          const trialEnd = userRow.trial_end ? new Date(userRow.trial_end).getTime() : 0;
          const onTrial = !!trialEnd && trialEnd > now;

          const periodEnd = userRow.current_period_end ? new Date(userRow.current_period_end).getTime() : 0;
          const inPeriod = !!periodEnd && periodEnd > now;

          const looksPaid =
            onTrial ||
            inPeriod ||
            (!!subId && status !== "canceled" && status !== "cancelled") ||
            ["starter", "pro", "beta", "paid"].includes(planKey) ||
            ["starter", "pro"].includes(tier);

          if (!looksPaid) {
            console.info("[ASK_CHIEF_PLAN_GATE]", {
              traceId,
              tenantId,
              ownerDigits,
              decision: "deny",
              planKey: planKey || null,
              tier: tier || null,
              hasSub: !!subId,
              status: status || null,
              onTrial,
              inPeriod,
            });

            return res.status(200).json({
              ok: false,
              code: "PLAN_REQUIRED",
              message: "Ask Chief unlocks on Starter.",
              required_plan: "starter",
              upgrade_url: "https://app.usechiefos.com/app/settings/billing",
              traceId,
            });
          }

          req.ownerProfile = userRow;

          const quota = await enforceAskChiefGates_AND_Consume({
            ownerId: ownerDigits,
            ownerProfile: userRow,
            tz,
          });

          if (quota?.gated) {
            console.info("[ASK_CHIEF_QUOTA_GATE]", {
              traceId,
              tenantId,
              ownerDigits,
              decision: "gated",
            });

            return res.status(200).json({
              ok: true,
              answer: quota.answer || "Ask Chief is currently unavailable.",
              evidence_meta: buildEvidenceMeta({ range, tenantId, tz, actorKey }),
              warnings: Array.isArray(quota?.evidence?.warnings) ? quota.evidence.warnings : [],
              actions: [],
              gated: true,
              traceId,
            });
          }

          console.info("[ASK_CHIEF_PLAN_GATE]", {
            traceId,
            tenantId,
            ownerDigits,
            decision: "allow",
            planKey: planKey || null,
            tier: tier || null,
            hasSub: !!subId,
            status: status || null,
            onTrial,
            inPeriod,
          });
        }
      } catch (e) {
        console.warn("[ASK_CHIEF_PLAN_GATE_FAILED]", {
          traceId,
          error: e?.message || String(e),
        });

        // Fail open with a warning rather than a hard error — user already authenticated
        console.warn("[ASK_CHIEF_PLAN_GATE_FAILOPEN]", { traceId, reason: "proceeding_after_gate_error" });
      }
    }

    // ---------------- Agent execution with hard timeout ----------------
    let agentReply = "";
    try {
      console.info("[ASK_CHIEF_AGENT_START]", {
        traceId,
        tenantId,
        ownerId: ownerId || null,
        actorKey,
        timeoutMs: ASK_CHIEF_AGENT_TIMEOUT_MS,
      });

      agentReply = await withTimeout(
        runAgent({
          fromPhone: null,
          ownerId: ownerId || null,
          text,
          topicHints: ["portal", "askchief"],
          ownerProfile: req.ownerProfile || null,
          pageContext: pageContext || null,
          history: history.length > 0 ? history : [],
          tz,
        }),
        ASK_CHIEF_AGENT_TIMEOUT_MS,
        "ask_chief_agent_timeout"
      );

      console.info("[ASK_CHIEF_AGENT_END]", {
        traceId,
        elapsedMs: Date.now() - startedAt,
        hasReply: !!String(agentReply || "").trim(),
      });

      return res.status(200).json({
        ok: true,
        answer: String(agentReply || "").trim() || "Done.",
        evidence_meta: buildEvidenceMeta({ range, tenantId, tz, actorKey }),
        warnings: [],
        actions: [],
        traceId,
      });
    } catch (e) {
      const isTimeout =
        e?.code === "TIMEOUT" ||
        e?.message === "ask_chief_agent_timeout";

      if (isTimeout) {
        console.warn("[ASK_CHIEF_AGENT_TIMEOUT]", {
          traceId,
          tenantId,
          ownerId: ownerId || null,
          elapsedMs: Date.now() - startedAt,
          timeoutMs: ASK_CHIEF_AGENT_TIMEOUT_MS,
        });

        return res.status(200).json({
          ok: true,
          answer: safeTimeoutAnswer(text),
          evidence_meta: buildEvidenceMeta({ range, tenantId, tz, actorKey }),
          warnings: ["Chief timed out before a full reasoning pass completed."],
          actions: [],
          degraded: true,
          traceId,
        });
      }

      throw e;
    }
  } catch (e) {
    console.error("[ASK_CHIEF_FAILED]", {
      traceId,
      error: e?.message || String(e),
    });

    return res.status(200).json({
      ok: true,
      answer: "I ran into an unexpected problem. Your data is safe — please try again in a moment.",
      evidence_meta: buildEvidenceMeta({ range: "mtd", tenantId: null, tz: "America/Toronto", actorKey: null }),
      warnings: ["Unexpected error — the question was not answered."],
      actions: [],
      degraded: true,
      traceId,
    });
  }
});

module.exports = router;