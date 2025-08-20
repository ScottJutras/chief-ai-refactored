// services/twilio.js
require('dotenv').config();
const twilio = require('twilio');

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

// --- helper: always produce whatsapp:+E164 ---
function wa(to) {
  const raw = String(to || '').replace(/^whatsapp:/i, '').trim();
  const e164 = raw.startsWith('+') ? raw : `+${raw}`;
  return `whatsapp:${e164}`;
}

// --- super light in-memory rate limiter (100 msgs / hour / recipient) ---
const sendWindowMs = 60 * 60 * 1000;
const sendLimit = 100;
const buckets = new Map(); // key: wa(to) -> { start, count }

function checkSendRate(to) {
  const key = wa(to);
  const now = Date.now();
  let entry = buckets.get(key);
  if (!entry || (now - entry.start) >= sendWindowMs) {
    entry = { start: now, count: 0 };
  }
  entry.count += 1;
  buckets.set(key, entry);
  if (entry.count > sendLimit) {
    const err = new Error('Rate limit exceeded for outbound messages');
    err.status = 429;
    err.retryAfterMs = sendWindowMs - (now - entry.start);
    throw err;
  }
}

async function sendMessage(to, body) {
  try {
    checkSendRate(to);
    const message = await client.messages.create({
      body,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: wa(to),
      // statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL, // optional
    });
    console.log(`[✅ SUCCESS] Message sent: ${message.sid} -> ${wa(to)} | len=${(body || '').length}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send message:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

async function sendQuickReply(to, body, replies = []) {
  try {
    checkSendRate(to);
    const message = await client.messages.create({
      body,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: wa(to),
      // WhatsApp "tap to reply" suggestions
      persistentAction: replies.slice(0, 3).map(r => `reply?text=${encodeURIComponent(r)}`),
      // statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL,
    });
    console.log(`[✅ SUCCESS] Quick reply sent: ${message.sid} -> ${wa(to)} | options=${replies.join(', ')}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send quick reply:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

async function sendTemplateMessage(to, contentSid, contentVariables = {}) {
  try {
    checkSendRate(to);
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
      to: wa(to),
      // statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL,
    });
    console.log(`[✅ SUCCESS] Template message sent: ${message.sid} -> ${wa(to)} contentSid=${contentSid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send template message:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

module.exports = { sendMessage, sendQuickReply, sendTemplateMessage };
