// services/twilio.js
require('dotenv').config();
const twilio = require('twilio');

const requiredEnvVars = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_NUMBER',  // Ensure this is set to 'whatsapp:+14155238886' for sandbox
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

// Force proper WhatsApp E.164 every time
function wa(to) {
  const raw = String(to || '').replace(/^whatsapp:/i, '').trim();
  const e164 = raw.startsWith('+') ? raw : `+${raw}`;
  return `whatsapp:${e164}`;
}

async function sendMessage(to, body) {
  try {
    const message = await client.messages.create({
      body,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: wa(to),
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
    const message = await client.messages.create({
      body,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: wa(to),
      persistentAction: replies.slice(0, 3).map(r => `reply?text=${encodeURIComponent(r)}`),
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
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: wa(to),
    });
    console.log(`[✅ SUCCESS] Template message sent: ${message.sid} -> ${wa(to)} contentSid=${contentSid}`);
    return message.sid;
  } catch (error) {
    console.error('[ERROR] Failed to send template message:', error.message, error.code, error.moreInfo);
    throw error;
  }
}

module.exports = { sendMessage, sendQuickReply, sendTemplateMessage };