// index.js
// Main Express app for Chief AI (webhook + parse + deep-dive + dashboard)

require("./config/env");

// 🔒 Stripe mode separation guard (fail fast on mixed env)
(function assertStripeModeConsistency() {
  const sk = String(process.env.STRIPE_SECRET_KEY || "");
  const whsec = String(process.env.STRIPE_WEBHOOK_SECRET || "");
  const priceStarter = String(process.env.STRIPE_PRICE_STARTER || "");
  const pricePro = String(process.env.STRIPE_PRICE_PRO || "");
  const appBase = String(process.env.APP_BASE_URL || "");

  const isLiveKey = sk.startsWith("sk_live_");
  const isTestKey = sk.startsWith("sk_test_");
  const stripeEnabled = isLiveKey || isTestKey;

  if (!stripeEnabled) return; // Stripe not configured in this env

  // Require prices when Stripe is enabled (prevents partial/misconfigured deploys)
  if (!priceStarter || !pricePro) {
    throw new Error(
      "Stripe enabled but STRIPE_PRICE_STARTER/STRIPE_PRICE_PRO missing in this environment"
    );
  }

  // Require webhook secret when Stripe is enabled (webhook route exists)
  if (!whsec.startsWith("whsec_")) {
    throw new Error("Stripe enabled but STRIPE_WEBHOOK_SECRET missing/invalid in this environment");
  }

  // Optional sanity: prevent obviously wrong APP_BASE_URL
  // (success/cancel redirects use this; keeps checkout from pointing at the wrong host)
  if (!/^https?:\/\//i.test(appBase)) {
    throw new Error("APP_BASE_URL must be an absolute URL (e.g., https://app.usechiefos.com)");
  }

  // Best-effort mismatch detection.
  // Stripe secrets don't expose mode directly for whsec, so we enforce a manual mode flag if present.
  // If you set STRIPE_MODE=test|live, we will strictly enforce it.
  const declaredMode = String(process.env.STRIPE_MODE || "").toLowerCase().trim(); // "test" | "live" | ""
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
const dashboardRouter = require("./routes/dashboard"); // KPI dashboard API
const askChiefRouter = require("./routes/askChief");
const billingRouter = require("./routes/billing");

// ✅ NEW: receipts streaming route
const receiptsRouter = require("./routes/receipts");

const app = express();

// Allow local/dev frontends to call this API when NOT on Vercel.
// (Portal normally proxies server-to-server, but this helps debugging.)
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
        if (!origin) return cb(null, true); // curl/postman
        if (allow.has(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked: ${origin}`));
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );
}

/* ---------------- Hardening / perf (no global parsers) ---------------- */
app.disable("x-powered-by");
app.set("query parser", "simple"); // predictable query parsing
app.set("trust proxy", 1); // Vercel/Proxies (IP rate limits etc.)
app.disable("etag"); // avoid 304 complexity on serverless

/* ---------------- Health checks ---------------- */
app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store").send("Chief AI Webhook Server is running!");
});

app.get("/api/healthz", (req, res) => {
  res.set("Cache-Control", "no-store").status(200).json({ ok: true, ts: Date.now() });
});

/* ---------------- Optional: Stripe redirect placeholders ---------------- */
/**
 * These are only to prevent "Cannot GET /billing/success" noise during checkout redirects.
 * They do NOT affect Stripe webhooks.
 */
app.get("/billing/success", (req, res) => {
  res.status(200).send("Billing success. You can close this tab.");
});

app.get("/billing/cancel", (req, res) => {
  res.status(200).send("Billing canceled. You can close this tab.");
});

/* ---------------- Stripe (webhook MUST be raw body) ---------------- */
/**
 * Stripe requires raw body for signature verification.
 * Do NOT put express.json() globally.
 * routes/stripe should define:
 *   POST /webhook  with express.raw({ type: "application/json" })
 */
app.use("/api/stripe", stripeRouter);

/* ---------------- Mount order (NO global body parsers) ---------------- */
// Webhook first; it does its own tolerant urlencoded/body handling.
app.use("/api/webhook", webhookRouter);
app.use("/webhook", webhookRouter); // temporary alias

// Billing (router adds its own JSON parser internally)
app.use("/api/billing", billingRouter);

// ✅ Receipts route (router defines /api/receipts/:transactionId internally)
// IMPORTANT: mount at "/" (NOT "/api") so it doesn't become /api/api/receipts
app.use(receiptsRouter);

// Other routers can attach their own parsers internally as needed.
app.use("/api/parse", parseRouter);
app.use(askChiefRouter); // routes/askChief.js defines POST /api/ask-chief

// JSON dashboard API used by the React frontend (Vite app)
app.use("/api/dashboard", dashboardRouter);

/* ---------------- Local dev only ---------------- */
if (!process.env.VERCEL && process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
}

module.exports = app;