// index.js
// Main Express app for Chief AI (webhook + parse + deep-dive + dashboard)

require("./config/env");

const express = require("express");
const cors = require("cors");

const webhookRouter = require("./routes/webhook");
const parseRouter = require("./routes/parse");
const deepDiveRouter = require("./routes/deepDive");
const dashboardRouter = require("./routes/dashboard"); // KPI dashboard API
const debugRouter = require("./routes/debug"); // ✅ debug endpoints (dev-only recommended)
const askChiefRouter = require("./routes/askChief");
const billingRouter = require("./routes/billing");

const { stripeWebhookHandler } = require("./handlers/stripeWebhook");

const app = express();

// Allow the Vite dashboard (localhost:5174) to call this API in dev.
if (!process.env.VERCEL) {
  app.use(
    cors({
      origin: "http://localhost:5174",
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

/* ---------------- Stripe webhook (MUST be raw body) ---------------- */
/**
 * Stripe requires raw body for signature verification.
 * Do NOT put express.json() globally.
 */
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler
);

// ✅ canonical API route
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler
);

// ⚠️ optional legacy alias (only keep if Stripe dashboard is still pointed here)
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler
);

/* ---------------- Mount order (NO global body parsers) ---------------- */
// Webhook first; it does its own tolerant urlencoded/body handling.
app.use("/api/webhook", webhookRouter);
app.use("/webhook", webhookRouter); // temporary alias

// Billing (router adds its own JSON parser internally)
app.use("/api/billing", billingRouter);

// Other routers can attach their own parsers internally as needed.
app.use("/parse", parseRouter);
app.use("/deep-dive", deepDiveRouter);
app.use(askChiefRouter); // routes/askChief.js defines POST /api/ask-chief

// ✅ Debug tools (returns Answer Contract JSON) — strongly recommend dev-only
if (!process.env.VERCEL) {
  app.use("/api", debugRouter);
}

// JSON dashboard API used by the React frontend (Vite app)
app.use("/api/dashboard", dashboardRouter);

/* ---------------- Local dev only ---------------- */
if (!process.env.VERCEL && process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
}

module.exports = app;
