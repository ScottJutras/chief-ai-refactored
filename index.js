// index.js
require("./config/env");
const { URL } = require("url");

function redact(str, keep = 10) {
  const s = String(str || "");
  if (!s) return null;
  if (s.length <= keep) return s;
  return `${s.slice(0, keep)}…`;
}

function summarizeSupabaseHost(rawUrl) {
  try {
    if (!rawUrl) return null;
    return new URL(String(rawUrl)).host || null;
  } catch {
    return "invalid_url";
  }
}

function summarizeStripeMode(secretKey) {
  const sk = String(secretKey || "");
  if (sk.startsWith("sk_live_")) return "live";
  if (sk.startsWith("sk_test_")) return "test";
  return "missing";
}

(function logRuntimeEnvironmentSummary() {
  const appBase = String(process.env.APP_BASE_URL || "").trim();
  const supabaseUrl =
    String(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").trim();

  const anonKey =
    String(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "").trim();

  const serviceRole = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const stripeSecret = String(process.env.STRIPE_SECRET_KEY || "").trim();
  const twilioSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();

  console.log("[RUNTIME_ENV_SUMMARY]", {
    nodeEnv: process.env.NODE_ENV || null,
    vercelEnv: process.env.VERCEL_ENV || null,
    appBaseUrl: appBase || null,
    supabaseHost: summarizeSupabaseHost(supabaseUrl),
    hasSupabaseUrl: !!supabaseUrl,
    anonKeyPrefix: redact(anonKey),
    serviceRolePrefix: redact(serviceRole),
    stripeMode: summarizeStripeMode(stripeSecret),
    twilioSidPrefix: redact(twilioSid),
  });
})();

// (Stripe guard unchanged...)
(function assertStripeModeConsistency() {
  const sk = String(process.env.STRIPE_SECRET_KEY || "");
  const whsec = String(process.env.STRIPE_WEBHOOK_SECRET || "");
  const priceStarter = String(process.env.STRIPE_PRICE_STARTER || "");
  const pricePro = String(process.env.STRIPE_PRICE_PRO || "");
  const appBase = String(process.env.APP_BASE_URL || "");

  const isLiveKey = sk.startsWith("sk_live_");
  const isTestKey = sk.startsWith("sk_test_");

  const stripeEnabled = isLiveKey || isTestKey;
  if (!stripeEnabled) return;

  if (!priceStarter || !pricePro) {
    throw new Error("Stripe enabled but STRIPE_PRICE_STARTER/STRIPE_PRICE_PRO missing in this environment");
  }
  if (!whsec.startsWith("whsec_")) {
    throw new Error("Stripe enabled but STRIPE_WEBHOOK_SECRET missing/invalid in this environment");
  }
  if (!/^https?:\/\//i.test(appBase)) {
    throw new Error("APP_BASE_URL must be an absolute URL (e.g., https://app.usechiefos.com)");
  }

  const declaredMode = String(process.env.STRIPE_MODE || "").toLowerCase().trim();
  if (declaredMode) {
    if (declaredMode !== "test" && declaredMode !== "live") {
      throw new Error('STRIPE_MODE must be either "test" or "live" if set');
    }
    if (declaredMode === "live" && !isLiveKey) {
      throw new Error("Stripe mode mismatch: STRIPE_MODE=live but STRIPE_SECRET_KEY is not sk_live_");
    }
    if (declaredMode === "test" && !isTestKey) {
      throw new Error("Stripe mode mismatch: STRIPE_MODE=test but STRIPE_SECRET_KEY is not sk_test_");
    }
  }
})();

const express = require("express");
const cors = require("cors");

const stripeRouter = require("./routes/stripe");
const webhookRouter = require("./routes/webhook");
const parseRouter = require("./routes/parse");
const dashboardRouter = require("./routes/dashboard");
const askChiefRouter       = require("./routes/askChief");
const askChiefStreamRouter = require("./routes/askChiefStream");
const billingRouter = require("./routes/billing");
const accountRouter = require("./routes/account");
const receiptsRouter = require("./routes/receipts");
const portalRouter = require("./routes/portal");
const crewAdminRouter = require("./routes/crewAdmin");
const jobsPortalRouter = require("./routes/jobsPortal");
const catalogRouter = require("./routes/catalog");
const integrityRouter = require("./routes/integrity");
const supplierPortalRouter = require("./routes/supplierPortal");
const alertsRouter = require("./routes/alerts");
const exportsPortalRouter = require("./routes/exportsPortal");
const emailIngestRouter = require("./routes/emailIngest");

// ✅ Portal auth + tenant/actor context for protected API routes
const { requirePortalUser } = require("./middleware/requirePortalUser");

const app = express();

if (!process.env.VERCEL) {
  const allow = new Set([
    "http://localhost:5174",
    "http://localhost:3000",
    "http://localhost:3001",
    "https://app.usechiefos.com",
    "https://usechiefos.com",
  ]);

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allow.has(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked: ${origin}`));
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );
}

app.disable("x-powered-by");
app.set("query parser", "simple");
app.set("trust proxy", 1);
app.disable("etag");

// ✅ Debug proof: if you can hit this, you’re in THIS express app
app.get("/api/_debug/which-app", (req, res) => {
  res.set("Cache-Control", "no-store").json({
    ok: true,
    app: "chief-backend-express",
    ts: Date.now(),
  });
});

app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store").send("Chief AI Webhook Server is running!");
});

app.get("/api/healthz", (req, res) => {
  res.set("Cache-Control", "no-store").status(200).json({ ok: true, ts: Date.now() });
});

app.get("/billing/success", (req, res) => res.status(200).send("Billing success. You can close this tab."));
app.get("/billing/cancel", (req, res) => res.status(200).send("Billing canceled. You can close this tab."));

// Stripe webhook raw body lives inside routes/stripe
app.use("/api/stripe", stripeRouter);

// Webhook first
app.use("/api/webhook", webhookRouter);
app.use("/webhook", webhookRouter);

// Billing
app.use("/api/billing", billingRouter);

// Receipts (already defines /api/receipts/:id internally)
app.use(receiptsRouter);

// ✅ Portal routes (this provides /api/whoami etc.)
app.use("/api", portalRouter);
app.use(jobsPortalRouter);
// ✅ Crew+Control (Pro-gated) — portal-auth required
app.use("/api/crew", requirePortalUser, require("./routes/crewControl"));
app.use("/api/crew", crewAdminRouter);
app.use("/api/crew", requirePortalUser, require("./routes/crewReview"));
// AskChief defines POST /api/ask-chief internally
app.use(askChiefRouter);
// AskChief SSE stream: POST /api/ask-chief/stream
app.use(askChiefStreamRouter);


// Parse
app.use("/api/parse", parseRouter);


// Account + Dashboard
app.use("/api/account", accountRouter);
app.use("/api/dashboard", dashboardRouter);

// Alerts (portal auth applied inside router)
app.use("/api/alerts", alertsRouter);

// Export pack (portal auth + plan gate applied inside router)
app.use("/api/exports", exportsPortalRouter);

// Supplier catalog (portal auth applied inside router)
app.use("/api/catalog", catalogRouter);

// Record integrity (portal auth applied inside router)
app.use("/api/integrity", integrityRouter);

// Email ingest webhook (Postmark inbound parse — no user auth, POSTMARK_WEBHOOK_TOKEN header)
app.use(emailIngestRouter);

// Supplier self-service portal (public signup + authenticated supplier routes + admin routes)
app.use("/api/supplier", supplierPortalRouter);
app.use("/api/admin", supplierPortalRouter);

if (!process.env.VERCEL && process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Server running on ${PORT}`);

    // Start reminder dispatch loop (polls DB every 60s, sends WhatsApp)
    try {
      const { startReminderDispatch } = require('./workers/reminder_dispatch');
      startReminderDispatch();
    } catch (e) {
      console.warn('[REMINDERS] Failed to start reminder dispatch (ignored):', e?.message);
    }
  });
}

module.exports = app;