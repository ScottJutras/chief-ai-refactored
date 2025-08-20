// services/twilio.js
require('dotenv').config();
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

const requiredEnvVars = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_MESSAGING_SERVICE_SID',
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) throw new Error(`Missing required environment variable: ${envVar}`);
}

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- helper: always return whatsapp:+E164 ---
function wa(to) {
  const raw = String(to || '').replace(/^whatsapp:/i, '').trim();
  const e164 = raw.startsWith('+') ? raw : `+${raw}`;
  return `whatsapp:${e164}`;
}

const messageLimiter = rateLimit({
  store: new (require('express-rate-limit').MemoryStore)(),
  windowMs: 60 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.body.From || 'unknown',
});

async function sendMessage(to, body) {
  try {
    await messageLimiter({ body: { From: wa(to) } });
    const message = await client.messages.create({
      body,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: wa(to),
      // optional: get delivery diagnostics
      // statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL,
    });
    console.log(`[✅ SUCCESS] Message sent: ${message.sid} -> ${wa(to)} | len=${(body||'').length}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send message:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

async function sendQuickReply(to, body, replies = []) {
  try {
    await messageLimiter({ body: { From: wa(to) } });
    const message = await client.messages.create({
      body,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      to: wa(to),
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
    await messageLimiter({ body: { From: wa(to) } });
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
