// services/twilio.js
require('dotenv').config();
const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_NUMBER) {
  throw new Error('Missing required Twilio env vars');
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Template variable whitelist
const TEMPLATE_VARS = {
  'HX0280df498999848aaff04cc079e16c31': ['1', '2'], // location confirm
  'HXd14a878175fd4b24cee0c0ca6061da96': ['1'],      // start job
};

function wa(to) {
  const clean = String(to || '').replace(/^whatsapp:/i, '').trim();
  const e164 = clean.startsWith('+') ? clean : `+${clean}`;
  return `whatsapp:${e164}`;
}
function shapeVars(sid, input = {}) {
  const allowed = TEMPLATE_VARS[sid] || [];
  const shaped = {};
  for (const k of allowed) shaped[k] = String(input[k] ?? '');
  const extra = Object.keys(input).filter(k => !allowed.includes(k));
  if (extra.length) console.warn('[twilio] dropping extra vars', { sid, extra });
  return shaped;
}

// Plain message
async function sendMessage(to, body) {
  const msg = await client.messages.create({
    body,
    from: TWILIO_WHATSAPP_NUMBER,
    to: wa(to),
  });
  console.log(`[twilio] sent ${msg.sid} → ${wa(to)}`);
  return msg.sid;
}

// Quick-reply (up to 3 buttons)
async function sendQuickReply(to, body, replies = []) {
  const buttons = replies.slice(0, 3).map(r => `reply?text=${encodeURIComponent(r)}`);
  const msg = await client.messages.create({
    body,
    from: TWILIO_WHATSAPP_NUMBER,
    to: wa(to),
    persistentAction: buttons,
  });
  console.log(`[twilio] quick-reply ${msg.sid} → ${wa(to)}`);
  return msg.sid;
}

// Template message
async function sendTemplateMessage(to, contentSid, vars = {}) {
  const shaped = shapeVars(contentSid, vars);
  const msg = await client.messages.create({
    contentSid,
    contentVariables: JSON.stringify(shaped),
    from: TWILIO_WHATSAPP_NUMBER,
    to: wa(to),
  });
  console.log(`[twilio] template ${msg.sid} → ${wa(to)} sid=${contentSid}`);
  return msg.sid;
}

// Template + quick-reply (no persistentAction – Twilio limitation)
async function sendTemplateQuickReply(to, contentSid, vars = {}) {
  return sendTemplateMessage(to, contentSid, vars);
}

module.exports = {
  sendMessage,
  sendQuickReply,
  sendTemplateMessage,
  sendTemplateQuickReply,
};