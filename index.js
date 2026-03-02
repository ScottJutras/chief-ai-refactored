// index.js
require("./config/env");

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
const askChiefRouter = require("./routes/askChief");
const billingRouter = require("./routes/billing");
const accountRouter = require("./routes/account");
const receiptsRouter = require("./routes/receipts");
const portalRouter = require("./routes/portal");
const crewAdminRouter = require("./routes/crewAdmin");


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
// ✅ Crew+Control (Pro-gated) — portal-auth required
app.use("/api/crew", requirePortalUser, require("./routes/crewControl"));
app.use("/api/crew", crewAdminRouter);
app.use("/api/crew", require("./routes/crewReview"));
// AskChief defines POST /api/ask-chief internally
app.use(askChiefRouter);


// Parse
app.use("/api/parse", parseRouter);


// Account + Dashboard
app.use("/api/account", accountRouter);
app.use("/api/dashboard", dashboardRouter);

if (!process.env.VERCEL && process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
}

module.exports = app;