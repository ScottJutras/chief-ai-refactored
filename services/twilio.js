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
// Keys are Twilio Content SIDs. Values are the numbered placeholders the template expects.
const TEMPLATE_VAR_SHAPES = {
  // Location confirm example you already had:
  'HX0280df498999848aaff04cc079e16c31': ['1', '2'],

  // Start Job template (hex_start_job)
  // Body:
  //   Starting job '{{1}}'. All entries will be assigned to this job until you say 'go to job (Name) or 'New job'. Confirm?
  // Buttons: Yes, Edit, No
  'HXd14a878175fd4b24cee0c0ca6061da96': ['1'],
};

// Normalize to WhatsApp E.164 every time
function wa(to) {
  const raw = String(to || '').replace(/^whatsapp:/i, '').trim();
  const e164 = raw.startsWith('+') ? raw : `+${raw}`;
  return `whatsapp:${e164}`;
}

// -------- helper to coerce/shape variables --------
function shapeTemplateVars(contentSid, inputVars = {}) {
  const allowed = TEMPLATE_VAR_SHAPES[contentSid];

  // Convert array form → object {"1": "...","2":"..."} while preserving order
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

  // Unknown template shape → coerce all values to strings
  for (const k of Object.keys(vars)) {
    vars[k] = (vars[k] == null) ? '' : String(vars[k]);
  }
  return vars;
}

// ---------------- base senders ----------------
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

// -------- template sender (kept as-is, with shaping) --------
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

// -------- NEW: high-level helper for template quick replies --------
// Uses a real Content Template if provided (buttons come from the template).
// If anything is missing/fails, falls back to a standard quick-reply (text + buttons).
async function sendTemplateQuickReply(
  to,
  {
    templateId,            // Content SID (e.g., HXd14a... for hex_start_job)
    text = '',             // optional fallback text (also used to infer vars when needed)
    buttons = [],          // optional fallback quick-reply buttons
    variables = {},        // optional map or array for template placeholders
    forceFallback = false, // set true to skip template usage and send a plain quick reply
  } = {}
) {
  try {
    if (!forceFallback && templateId) {
      let vars = variables;

      // If no variables provided but we know the template needs {{1}},
      // try to infer from the text "Starting job 'XYZ'..."
      if ((!vars || (Array.isArray(vars) && vars.length === 0) || (typeof vars === 'object' && Object.keys(vars).length === 0))
          && templateId === 'HXd14a878175fd4b24cee0c0ca6061da96'
          && typeof text === 'string' && text) {
        const m = text.match(/Starting job\s+['"]([^'"]+)['"]/i);
        if (m && m[1]) {
          // We’ll pass as object {"1": "<job name>"} so shapeTemplateVars can validate
          vars = { '1': m[1] };
          console.log('[DEBUG] Inferred template var {1} from text for hex_start_job:', m[1]);
        }
      }

      // Shape & send as a true template
      const shaped = shapeTemplateVars(templateId, vars || {});
      return await sendTemplateMessage(to, templateId, shaped);
    }

    // Fallback – normal quick reply (non-template)
    return await sendQuickReply(to, text, buttons);
  } catch (err) {
    console.warn('[WARN] sendTemplateQuickReply fell back to quick reply:', err?.message);
    // Last-resort fallback
    return await sendQuickReply(to, text, buttons);
  }
}

module.exports = {
  sendMessage,
  sendQuickReply,
  sendTemplateMessage,
  sendTemplateQuickReply, // <— new export
};
