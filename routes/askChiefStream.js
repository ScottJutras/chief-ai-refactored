// routes/askChiefStream.js
// SSE streaming endpoint for Ask Chief (portal + dashboard).
//
// Event protocol:
//   {"status":"thinking","tools":["tool_name",...]}   — emitted after each tool round
//   {"token":"..."}                                    — synthesis text tokens
//   {"done":true,"ok":true,"answer":"...","evidence_meta":{...},"traceId":"..."}
//   data: [DONE]                                       — stream terminator
//
// Falls back to regular JSON on SSE unsupported clients (Accept: application/json).
// Auth mirrors askChief.js exactly (dashboard cookie OR portal JWT).

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const { requireDashboardOwner } = require("../middleware/requireDashboardOwner");
const { requirePortalUser }     = require("../middleware/requirePortalUser");
const { runToolPhaseSync }      = require("../services/agent");
const { enforceAskChiefGates_AND_Consume } = require("../services/answerChief");
const { LLMProvider }           = require("../services/llm");
const { looksLikeSupportQuestion } = require("../services/orchestrator");
const { answerSupport }         = require("../services/answerSupport");

const ASK_CHIEF_REQUIRE_PLAN  = String(process.env.ASK_CHIEF_REQUIRE_PLAN || "1") === "1";
const STREAM_TIMEOUT_MS       = Number(process.env.ASK_CHIEF_STREAM_TIMEOUT_MS || 25000);

// ---- Admin Supabase singleton (same pattern as askChief.js) ----
let _admin = null;
function getAdminSupabase() {
  if (_admin) return _admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing Supabase env vars");
  _admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}

function hasDashboardToken(req) {
  const cookie = String(req.headers?.cookie || "");
  return (
    cookie.includes("chiefos_dashboard_token=") ||
    cookie.includes("dashboard_token=") ||
    cookie.includes("dashboardToken=")
  );
}

function makeTraceId() {
  return `asks_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

// ---- SSE helpers ----
function sseWrite(res, data) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseDone(res) {
  if (res.writableEnded) return;
  res.write("data: [DONE]\n\n");
  res.end();
}

// ---- Route ----
router.post("/api/ask-chief/stream", express.json(), async (req, res) => {
  const traceId   = req.headers["x-trace-id"] || makeTraceId();
  const startedAt = Date.now();

  // ---- Auth ----
  let authMode;
  try {
    authMode = await requireOneAuthMode(req, res);
  } catch (e) {
    if (!res.headersSent) {
      return res.status(401).json({ ok: false, code: "UNAUTHORIZED", traceId });
    }
    return;
  }
  if (res.headersSent) return;

  // ---- Input ----
  const ownerId      = String(req.ownerId  || "").trim();
  const tenantId     = String(req.tenantId || "").trim() || null;
  const portalUserId = String(req.portalUserId || "").trim() || null;
  const portalRole   = String(req.portalRole   || "").trim().toLowerCase();
  const tz           = req.tenant?.tz || "America/Toronto";

  const prompt    = String(req.body?.prompt || "").trim();
  const textLegacy = String(req.body?.text  || "").trim();
  const text      = prompt || textLegacy;
  const range     = String(req.body?.range  || "mtd").trim() || "mtd";
  const actorKey  = portalUserId || ownerId || "portal";
  const history   = Array.isArray(req.body?.history) ? req.body.history.slice(0, 20) : [];
  const pageContext = req.body?.page_context && typeof req.body.page_context === "object"
    ? req.body.page_context : null;

  if (!text) {
    return res.status(400).json({ ok: false, code: "BAD_REQUEST", message: "Missing prompt.", traceId });
  }

  // ---- Role gate ----
  if (authMode === "portal" && portalRole) {
    const allowed = new Set(["owner", "admin", "board", "board_member"]);
    if (!allowed.has(portalRole)) {
      return res.status(403).json({ ok: false, code: "PERMISSION_DENIED", message: "You do not have access to Ask Chief.", traceId });
    }
  }

  // ---- Linkage guard ----
  const NOT_LINKED_BODY = {
    ok: false,
    code: "NOT_LINKED",
    message: "Ask Chief reads your transaction ledger. Start logging expenses and revenue — via WhatsApp or the web portal — and Chief can answer questions about cashflow, job profit, overhead, and more.",
    actions: [
      { label: "Log a transaction", href: "https://app.usechiefos.com/app/transactions/new", kind: "primary" },
      { label: "Link WhatsApp", href: "https://app.usechiefos.com/app/link-phone", kind: "secondary" },
      { label: "How it works", href: "https://usechiefos.com/#faq", kind: "secondary" },
    ],
    traceId,
  };

  if (authMode === "portal" && tenantId && !ownerId) {
    return res.status(200).json(NOT_LINKED_BODY);
  }

  // ---- Support gate (BEFORE quota) — product help never consumes a question ----
  if (looksLikeSupportQuestion(text)) {
    const supportAnswer = await answerSupport({ text, ownerId: ownerId || "" });
    const answer = supportAnswer ||
      "I don't have docs for that yet. Try checking usechiefos.com/help or ask in a different way.";

    const wantsSSE = (req.headers.accept || "").includes("text/event-stream");
    if (!wantsSSE) {
      return res.status(200).json({
        ok: true, answer,
        evidence_meta: buildEvidenceMeta({ range, tenantId, tz, actorKey }),
        support: true, traceId,
      });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    sseWrite(res, { token: answer });
    sseWrite(res, {
      done: true, ok: true, answer,
      evidence_meta: buildEvidenceMeta({ range, tenantId, tz, actorKey }),
      support: true, traceId,
    });
    sseDone(res);
    return;
  }

  // ---- Plan gate (mirrors askChief.js exactly) ----
  if (ASK_CHIEF_REQUIRE_PLAN && tenantId) {
    try {
      const ownerDigits = ownerId;
      if (!ownerDigits) return res.status(200).json(NOT_LINKED_BODY);

      const supabase = getAdminSupabase();
      const { data: userRow } = await supabase
        .from("users")
        .select("user_id, owner_id, plan_key, subscription_tier, stripe_subscription_id, stripe_price_id, current_period_end, trial_end, cancel_at_period_end, sub_status")
        .eq("user_id", ownerDigits)
        .maybeSingle();

      if (!userRow?.user_id) return res.status(200).json(NOT_LINKED_BODY);

      const planKey = String(userRow.plan_key || "").toLowerCase().trim();
      const tier    = String(userRow.subscription_tier || "").toLowerCase().trim();
      const subId   = String(userRow.stripe_subscription_id || "").trim();
      const status  = String(userRow.sub_status || "").toLowerCase().trim();
      const now     = Date.now();
      const trialEnd   = userRow.trial_end           ? new Date(userRow.trial_end).getTime()           : 0;
      const periodEnd  = userRow.current_period_end  ? new Date(userRow.current_period_end).getTime()  : 0;
      const onTrial    = !!trialEnd  && trialEnd  > now;
      const inPeriod   = !!periodEnd && periodEnd > now;
      const looksPaid  = onTrial || inPeriod ||
        (!!subId && status !== "canceled" && status !== "cancelled") ||
        ["starter", "pro", "beta", "paid"].includes(planKey) ||
        ["starter", "pro"].includes(tier);

      // All authenticated users (including free tier) reach the quota check.
      // enforceAskChiefGates_AND_Consume handles free (10 questions/month)
      // and paid quota enforcement — no early block needed here.
      req.ownerProfile = userRow;

      const quota = await enforceAskChiefGates_AND_Consume({ ownerId: ownerDigits, ownerProfile: userRow, tz });
      if (quota?.gated) {
        return res.status(200).json({
          ok: true,
          answer: quota.answer || "Ask Chief is currently unavailable.",
          evidence_meta: buildEvidenceMeta({ range, tenantId, tz, actorKey }),
          warnings: Array.isArray(quota?.evidence?.warnings) ? quota.evidence.warnings : [],
          actions: [], gated: true, traceId,
        });
      }
    } catch (e) {
      console.warn("[ASK_CHIEF_STREAM_PLAN_GATE_FAILED]", { traceId, error: e?.message });
      // Fail open after gate error
    }
  }

  // ---- Switch to SSE ----
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable Nginx buffering
  res.flushHeaders();

  // Heartbeat to prevent proxy timeout during tool phase
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, 5000);

  const cleanup = () => clearInterval(heartbeat);

  // Hard wall-clock timeout
  const timeoutTimer = setTimeout(() => {
    cleanup();
    sseWrite(res, {
      done: true, ok: true,
      answer: "That question took longer than my time limit. Try narrowing the question — add a date range (MTD, WTD, today) or a specific job name so I can answer faster.",
      evidence_meta: buildEvidenceMeta({ range, tenantId, tz, actorKey }),
      degraded: true, traceId,
    });
    sseDone(res);
  }, STREAM_TIMEOUT_MS);

  try {
    // ---- Build seed messages (same format as runAgent portal path) ----
    const systemPrompt = [
      "You are Chief, the AI analyst for ChiefOS.",
      "Answer concisely and factually using the provided tool results.",
      "Call tools to fetch data before answering. Do not invent numbers.",
      pageContext ? `Page context: ${JSON.stringify(pageContext)}` : "",
    ].filter(Boolean).join("\n");

    const historyMessages = history.flatMap(h => [
      { role: "user",      content: String(h.question || "") },
      { role: "assistant", content: String(h.answer    || "") },
    ]).filter(m => m.content);

    const seedMessages = [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      { role: "user",   content: text },
    ];

    const llm = new LLMProvider({ ownerId });

    // ---- Tool phase (synchronous chat rounds) ----
    const { messages: toolMessages, earlyAnswer } = await runToolPhaseSync({
      llm,
      seedMessages,
      ownerId,
      onRound({ tools }) {
        sseWrite(res, { status: "thinking", tools });
      },
    });

    if (earlyAnswer !== null && earlyAnswer !== undefined) {
      // LLM answered without needing synthesis (no tools called or early exit)
      clearTimeout(timeoutTimer);
      cleanup();
      sseWrite(res, { token: earlyAnswer });
      sseWrite(res, {
        done: true, ok: true,
        answer: earlyAnswer,
        evidence_meta: buildEvidenceMeta({ range, tenantId, tz, actorKey }),
        traceId,
      });
      sseDone(res);
      return;
    }

    // ---- Synthesis phase (streaming) ----
    // Ask the LLM to synthesize a final answer from the accumulated tool results.
    const synthMessages = [
      ...toolMessages,
      {
        role: "user",
        content: "Based on the tool results above, provide your final answer. Be direct and concise.",
      },
    ];

    let fullAnswer = "";
    for await (const token of llm.chatStream({ messages: synthMessages, max_tokens: 1200 })) {
      fullAnswer += token;
      sseWrite(res, { token });
    }

    clearTimeout(timeoutTimer);
    cleanup();

    if (!fullAnswer.trim()) {
      fullAnswer = "I couldn't retrieve a clear answer. Please try rephrasing your question.";
    }

    sseWrite(res, {
      done: true, ok: true,
      answer: fullAnswer,
      evidence_meta: buildEvidenceMeta({ range, tenantId, tz, actorKey }),
      traceId,
    });
    sseDone(res);

    console.info("[ASK_CHIEF_STREAM_DONE]", {
      traceId, elapsedMs: Date.now() - startedAt,
      answerLen: fullAnswer.length,
    });

  } catch (e) {
    clearTimeout(timeoutTimer);
    cleanup();

    console.error("[ASK_CHIEF_STREAM_FAILED]", { traceId, error: e?.message || String(e) });

    if (!res.writableEnded) {
      sseWrite(res, {
        done: true, ok: false,
        answer: "I ran into an unexpected problem. Your data is safe — please try again in a moment.",
        evidence_meta: buildEvidenceMeta({ range: "mtd", tenantId: null, tz: "America/Toronto", actorKey: null }),
        degraded: true, traceId,
      });
      sseDone(res);
    }
  }
});

module.exports = router;
