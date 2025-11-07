// services/twilio.js
// Twilio wrapper with dev-safe mock and back-compat for old env names & helpers.
//
// Exports:
//   - sendWhatsApp(to, body, mediaUrls?)
//   - sendSMS(to, body)
//   - sendMessage(to, body)                  // alias for WA text
//   - sendQuickReply(to, body, replies[])    // WA buttons (<=3)
//   - sendTemplateMessage(to, contentSid, vars?)
//   - sendTemplateQuickReply(to, contentSid, vars?) // alias to template (Twilio limitation)
//   - verifyTwilioSignature(options?)        // express middleware
//
// Env (any of these work):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   TWILIO_WHATSAPP_FROM (e.g. "whatsapp:+1XXXXXXXXXX")
//   TWILIO_SMS_FROM      (e.g. "+1XXXXXXXXXX")
//   TWILIO_WHATSAPP_NUMBER (legacy; e.g. "whatsapp:+1XXXXXXXXXX" or "+1XXXXXXXXXX")
//   TWILIO_MESSAGING_SERVICE_SID (optional; used instead of from=)
//   MOCK_TWILIO=1 for local mock

const crypto = require('crypto');

const {
  NODE_ENV,
  MOCK_TWILIO,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  TWILIO_SMS_FROM,
  TWILIO_WHATSAPP_NUMBER,          // legacy
  TWILIO_MESSAGING_SERVICE_SID     // optional
} = process.env;

const isProd = NODE_ENV === 'production';
const resolvedWhatsAppFrom = normalizeWhatsAppFrom(TWILIO_WHATSAPP_FROM || TWILIO_WHATSAPP_NUMBER);
const hasCreds = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && (resolvedWhatsAppFrom || TWILIO_SMS_FROM || TWILIO_MESSAGING_SERVICE_SID));
const useMock = !isProd && (!hasCreds || String(MOCK_TWILIO) === '1');

let twilioClient = null;

// --------- helpers ----------
function normalizeWhatsAppFrom(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (s.toLowerCase().startsWith('whatsapp:')) return s;
  // assume number
  const e164 = s.startsWith('+') ? s : `+${s}`;
  return `whatsapp:${e164}`;
}
function toWhatsApp(to) {
  const clean = String(to || '').replace(/^whatsapp:/i, '').trim();
  const e164 = clean.startsWith('+') ? clean : `+${clean}`;
  return `whatsapp:${e164}`;
}

// ---------- Mock client (dev) ----------
function makeMockClient() {
  const log = (...args) => console.log('[TWILIO:MOCK]', ...args);
  return {
    messages: {
      create: async (opts) => {
        const sid = 'SM' + crypto.randomBytes(16).toString('hex');
        log('messages.create', { ...opts, sid });
        return { sid, status: 'queued', mock: true };
      }
    }
  };
}

// ---------- Real client ----------
function makeRealClient() {
  const real = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  return real;
}

if (useMock) {
  console.warn('[TWILIO] Using MOCK client (local dev). Set env to use real Twilio.');
  twilioClient = makeMockClient();
} else {
  if (!hasCreds) throw new Error('Missing required Twilio env vars');
  twilioClient = makeRealClient();
}

// ---------- Core senders ----------
async function sendWhatsApp(to, body, mediaUrls) {
  const payload = {
    to: toWhatsApp(to),
    body
  };

  // Prefer Messaging Service if provided
  if (TWILIO_MESSAGING_SERVICE_SID && !useMock) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    payload.from = useMock ? 'whatsapp:+10000000000' : (resolvedWhatsAppFrom || 'whatsapp:+10000000000');
  }

  if (mediaUrls && mediaUrls.length) payload.mediaUrl = mediaUrls;
  return twilioClient.messages.create(payload);
}

async function sendSMS(to, body) {
  const payload = { to, body };
  if (TWILIO_MESSAGING_SERVICE_SID && !useMock) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    payload.from = useMock ? '+10000000000' : TWILIO_SMS_FROM;
    if (!payload.from && !useMock) {
      throw new Error('TWILIO_SMS_FROM is required when Messaging Service SID is not set');
    }
  }
  return twilioClient.messages.create(payload);
}

// ---------- Convenience (back-compat) ----------
async function sendMessage(to, body) {
  return sendWhatsApp(to, body);
}

async function sendQuickReply(to, body, replies = []) {
  // Up to 3 quick-reply buttons via persistentAction
  const buttons = (replies || []).slice(0, 3).map(r => `reply?text=${encodeURIComponent(String(r))}`);
  const payload = {
    to: toWhatsApp(to),
    persistentAction: buttons,
    body
  };

  if (TWILIO_MESSAGING_SERVICE_SID && !useMock) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    payload.from = useMock ? 'whatsapp:+10000000000' : (resolvedWhatsAppFrom || 'whatsapp:+10000000000');
  }

  return twilioClient.messages.create(payload);
}

async function sendTemplateMessage(to, contentSid, vars = {}) {
  // Vars must be string-keyed object
  const payload = {
    to: toWhatsApp(to),
    contentSid,
    contentVariables: JSON.stringify(vars || {})
  };

  if (TWILIO_MESSAGING_SERVICE_SID && !useMock) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    payload.from = useMock ? 'whatsapp:+10000000000' : (resolvedWhatsAppFrom || 'whatsapp:+10000000000');
  }

  return twilioClient.messages.create(payload);
}

// Twilio limitation: templates + QR need Content API; no extra buttons param.
async function sendTemplateQuickReply(to, contentSid, vars = {}) {
  return sendTemplateMessage(to, contentSid, vars);
}

// ---------- Signature verification middleware ----------
function verifyTwilioSignature(options = {}) {
  if (!useMock && TWILIO_AUTH_TOKEN) {
    const twilio = require('twilio');
    return twilio.webhook({ validate: true, ...options });
  }
  return function devBypass(_req, _res, next) { next(); };
}

module.exports = {
  // Core
  sendWhatsApp,
  sendSMS,
  verifyTwilioSignature,
  // Back-compat convenience
  sendMessage,
  sendQuickReply,
  sendTemplateMessage,
  sendTemplateQuickReply
};
