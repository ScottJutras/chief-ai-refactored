// services/twilio.js
require('dotenv').config();
const twilio = require('twilio');

const requiredEnvVars = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_NUMBER',
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

// -------- Template shapes (whitelist) --------
const TEMPLATE_VAR_SHAPES = {
  'HX0280df498999848aaff04cc079e16c31': ['1', '2'], // location confirm
  'HXd14a878175fd4b24cee0c0ca6061da96': ['1'],      // hex_start_job: {{1}} = job name
};

function wa(to) {
  const raw = String(to || '').replace(/^whatsapp:/i, '').trim();
  const e164 = raw.startsWith('+') ? raw : `+${raw}`;
  return `whatsapp:${e164}`;
}

function shapeTemplateVars(contentSid, inputVars = {}) {
  const allowed = TEMPLATE_VAR_SHAPES[contentSid];
  let vars = {};
  if (Array.isArray(inputVars)) {
    inputVars.forEach((v, i) => { vars[String(i + 1)] = v; });
  } else if (inputVars && typeof inputVars === 'object') {
    vars = { ...inputVars };
  }

  if (Array.isArray(allowed)) {
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

  for (const k of Object.keys(vars)) {
    vars[k] = (vars[k] == null) ? '' : String(vars[k]);
  }
  return vars;
}

// ---- base senders
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

// ---- template senders
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

// ✅ Simple template quick-reply: (to, contentSid, { '1': value, ... })
async function sendTemplateQuickReply(to, contentSid, contentVariablesObj) {
  if (!contentSid) throw new Error('Missing ContentSid for template');
  if (!contentVariablesObj || typeof contentVariablesObj !== 'object') {
    throw new Error('contentVariables must be an object map like {"1":"..."}');
  }
  const shaped = shapeTemplateVars(contentSid, contentVariablesObj);
  console.log('[DEBUG] sendTemplateQuickReply', { contentSid, shaped });

  const message = await client.messages.create({
    contentSid,
    contentVariables: JSON.stringify(shaped),
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: wa(to),
  });
  console.log(`[✅ SUCCESS] Template quick-reply sent: ${message.sid} -> ${wa(to)} contentSid=${contentSid}`);
  return message.sid;
}

module.exports = {
  sendMessage,
  sendQuickReply,
  sendTemplateMessage,
  sendTemplateQuickReply,
};
