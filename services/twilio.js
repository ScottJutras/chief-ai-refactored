// services/twilio.js
require('dotenv').config();
const twilio = require('twilio');
const { RateLimiter } = require('express-rate-limit');

const requiredEnvVars = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_MESSAGING_SERVICE_SID',
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Rate limiter (best-effort in serverless)
const messageLimiter = new RateLimiter({
  store: new (require('express-rate-limit').MemoryStore)(),
  windowMs: 60 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.body.From || 'unknown',
});

// Normalize to whatsapp:+E164
function toWhatsApp(to) {
  return to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
}

async function sendMessage(to, body) {
  try {
    await messageLimiter({ body: { From: to } });
    const message = await client.messages.create({
      body,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: toWhatsApp(to),
    });
    console.log(`[✅ SUCCESS] Message sent: ${message.sid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send message:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

// Session quick replies (no contentSid)
async function sendQuickReply(to, body, replies = []) {
  try {
    await messageLimiter({ body: { From: to } });
    const message = await client.messages.create({
      body,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: toWhatsApp(to),
      persistentAction: replies.slice(0, 3).map(r => `reply?text=${encodeURIComponent(r)}`),
    });
    console.log(`[✅ SUCCESS] Quick reply sent: ${message.sid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send quick reply:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

// Content template (buttons must be defined in the template itself)
async function sendTemplateMessage(to, contentSid, contentVariables = {}) {
  try {
    await messageLimiter({ body: { From: to } });
    if (!contentSid) throw new Error('Missing ContentSid');

    const formattedVariables = JSON.stringify(
      Array.isArray(contentVariables)
        ? contentVariables.reduce((acc, item, idx) => {
            acc[idx + 1] = typeof item === 'string' ? item : (item?.text ?? String(item ?? ''));
            return acc;
          }, {})
        : contentVariables
    );

    const message = await client.messages.create({
      contentSid,
      contentVariables: formattedVariables,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: toWhatsApp(to),
    });
    console.log(`[✅ SUCCESS] Template message sent: ${message.sid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send template message:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

module.exports = { sendMessage, sendQuickReply, sendTemplateMessage };
