// services/twilio.js
require('dotenv').config();
const twilio = require('twilio');

const requiredEnvVars = ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_MESSAGING_SERVICE_SID'];
for (const k of requiredEnvVars) if (!process.env[k]) throw new Error(`Missing required environment variable: ${k}`);

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// simple per-recipient limiter: 100 msgs / hr
const buckets = new Map();
function checkLimit(id, max = 100, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  const b = buckets.get(id) || { start: now, count: 0 };
  if (now - b.start >= windowMs) { b.start = now; b.count = 0; }
  if (b.count >= max) { const err = new Error('Rate limit exceeded'); err.code = 'RATE_LIMIT'; throw err; }
  b.count++; buckets.set(id, b);
}

async function sendMessage(to, body) {
  try {
    checkLimit(to);
    const message = await client.messages.create({
      body,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
    });
    console.log(`[✅ SUCCESS] Message sent: ${message.sid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send message:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

async function sendQuickReply(to, body, replies = []) {
  try {
    checkLimit(to);
    const message = await client.messages.create({
      body,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
      persistentAction: replies.slice(0, 3).map(r => `reply?text=${encodeURIComponent(r)}`),
    });
    console.log(`[✅ SUCCESS] Quick reply sent: ${message.sid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send quick reply:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

async function sendTemplateMessage(to, contentSid, contentVariables = {}) {
  try {
    checkLimit(to);
    if (!contentSid) throw new Error('Missing ContentSid');
    const formattedVariables = JSON.stringify(
      Array.isArray(contentVariables)
        ? contentVariables.reduce((acc, item, i) => { acc[i + 1] = typeof item === 'string' ? item : (item?.text ?? String(item ?? '')); return acc; }, {})
        : contentVariables
    );
    const message = await client.messages.create({
      contentSid,
      contentVariables: formattedVariables,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
    });
    console.log(`[✅ SUCCESS] Template message sent: ${message.sid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send template message:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

module.exports = { sendMessage, sendQuickReply, sendTemplateMessage };
