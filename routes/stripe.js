// routes/stripe.js
const express = require("express");
const { stripeWebhookHandler } = require("../handlers/stripeWebhook");

const router = express.Router();

// IMPORTANT: raw body ONLY for stripe webhook
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler
);

module.exports = router;