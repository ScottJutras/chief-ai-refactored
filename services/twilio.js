// services/twilio.js
require('dotenv').config();
const twilio = require('twilio');

const requiredEnvVars = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_NUMBER', // NOTE: this may be your real WA number, not the sandbox. The comment below can be removed if you're not using sandbox.
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

// -------- NEW: expected var shapes per template (whitelist) --------
// For your location confirm template: "We detected your location as {{1}}, {{2}}."
// Convention: {1} = province, {2} = country  (match your Step-1 code)
const TEMPLATE_VAR_SHAPES = {
  'HX0280df498999848aaff04cc079e16c31': ['1', '2'], // location confirm
  // Add other templates here as you create them, e.g.:
  // 'HXa885f78d7654642672bfccfae98d57cb': [], // no vars
};

// Normalize to WhatsApp E.164 every time
function wa(to) {
  const raw = String(to || '').replace(/^whatsapp:/i, '').trim();
  const e164 = raw.startsWith('+') ? raw : `+${raw}`;
  return `whatsapp:${e164}`;
}

// -------- NEW: helper to coerce/shape variables --------
function shapeTemplateVars(contentSid, inputVars = {}) {
  const allowed = TEMPLATE_VAR_SHAPES[contentSid];

  // Convert array form → object {"1": "...","2":"..."} while preserving order
  let vars = {};
  if (Array.isArray(inputVars)) {
    inputVars.forEach((v, i) => { vars[String(i + 1)] = v; });
  } else if (inputVars && typeof inputVars === 'object') {
    vars = { ...inputVars };
  }

  // If we know the shape, enforce:
  if (Array.isArray(allowed)) {
    // Drop extras, keep only allowed keys, coerce to string, fill missing with ""
    const shaped = {};
    for (const k of allowed) {
      const val = vars[k];
      shaped[k] = (val == null) ? '' : String(val);
    }

    const extras = Object.keys(vars).filter(k => !allowed.includes(k));
    if (extras.length) {
      console.warn('[WARN] sendTemplateMessage dropping extra vars', { contentSid, extras });
    }
    return shaped;
  }

  // Unknown template shape → best effort: coerce all values to strings
  for (const k of Object.keys(vars)) {
    vars[k] = (vars[k] == null) ? '' : String(vars[k]);
  }
  return vars;
}

// ---------------- existing senders ----------------
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

// -------- UPDATED: enforce template shapes + log shaped vars --------
async function sendTemplateMessage(to, contentSid, contentVariables = {}) {
  try {
    if (!contentSid) throw new Error('Missing ContentSid');

    const shaped = shapeTemplateVars(contentSid, contentVariables);
    console.log('[DEBUG] sendTemplateMessage', { contentSid, shaped });

    const message = await client.messages.create({
      contentSid,
      contentVariables: JSON.stringify(shaped),
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
