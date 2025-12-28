// services/twilio.js
// Twilio wrapper with dev-safe mock, Messaging Service-first, and WhatsApp-first helpers.
// Alignments:
// - Harden env validation + safe fallbacks (never crash local dev)
// - Keep your sendBackfillConfirm behavior
// - Provide a stable toWhatsApp() transformer
// - verifyTwilioSignature remains dev-bypass when mock/no auth token

const crypto = require('crypto');

function normalizeWhatsAppFrom(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (s.toLowerCase().startsWith('whatsapp:')) return s;
  const e164 = s.startsWith('+') ? s : `+${s}`;
  return `whatsapp:${e164}`;
}

function toWhatsApp(to) {
  const clean = String(to || '').replace(/^whatsapp:/i, '').trim();
  const e164 = clean.startsWith('+') ? clean : `+${clean}`;
  return `whatsapp:${e164}`;
}

const {
  NODE_ENV,
  MOCK_TWILIO,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  TWILIO_SMS_FROM,
  TWILIO_WHATSAPP_NUMBER, // legacy
  TWILIO_MESSAGING_SERVICE_SID, // optional
  HEX_BACKFILL_GENERIC, // template SID
} = process.env;

const isProd = NODE_ENV === 'production';
const resolvedWhatsAppFrom = normalizeWhatsAppFrom(TWILIO_WHATSAPP_FROM || TWILIO_WHATSAPP_NUMBER);

const hasCreds = !!(
  TWILIO_ACCOUNT_SID &&
  TWILIO_AUTH_TOKEN &&
  (resolvedWhatsAppFrom || TWILIO_SMS_FROM || TWILIO_MESSAGING_SERVICE_SID)
);

const useMock = !isProd && (!hasCreds || String(MOCK_TWILIO) === '1');

let twilioClient = null;

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

function makeRealClient() {
  return require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

if (useMock) {
  console.warn('[TWILIO] Using MOCK client (local dev). Set env to use real Twilio.');
  twilioClient = makeMockClient();
} else {
  if (!hasCreds) throw new Error('Missing required Twilio env vars');
  twilioClient = makeRealClient();
}

async function sendWhatsApp(to, body, mediaUrls) {
  const payload = {
    to: toWhatsApp(to),
    body: String(body || ''),
  };

  if (TWILIO_MESSAGING_SERVICE_SID && !useMock) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    payload.from = useMock ? 'whatsapp:+10000000000' : (resolvedWhatsAppFrom || 'whatsapp:+10000000000');
  }

  if (mediaUrls && mediaUrls.length) payload.mediaUrl = mediaUrls;
  return twilioClient.messages.create(payload);
}

async function sendSMS(to, body) {
  const payload = { to: String(to || ''), body: String(body || '') };

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

// Back-compat convenience
async function sendMessage(to, body) {
  return sendWhatsApp(to, body);
}

/**
 * "Quick replies" on WhatsApp via Twilio Content API is the real way.
 * This helper keeps your existing persistentAction approach (best-effort).
 */
async function sendQuickReply(to, body, replies = []) {
  const actions = (replies || []).slice(0, 3).map(r => `reply?text=${encodeURIComponent(String(r))}`);

  const payload = {
    to: toWhatsApp(to),
    body: String(body || ''),
    persistentAction: actions,
  };

  if (TWILIO_MESSAGING_SERVICE_SID && !useMock) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    payload.from = useMock ? 'whatsapp:+10000000000' : (resolvedWhatsAppFrom || 'whatsapp:+10000000000');
  }

  return twilioClient.messages.create(payload);
}

async function sendTemplateMessage(to, contentSid, vars = {}) {
  const payload = {
    to: toWhatsApp(to),
    contentSid,
    contentVariables: JSON.stringify(vars || {}),
  };

  if (TWILIO_MESSAGING_SERVICE_SID && !useMock) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    payload.from = useMock ? 'whatsapp:+10000000000' : (resolvedWhatsAppFrom || 'whatsapp:+10000000000');
  }

  return twilioClient.messages.create(payload);
}

async function sendTemplateQuickReply(to, contentSid, vars = {}) {
  return sendTemplateMessage(to, contentSid, vars);
}

async function sendBackfillConfirm(to, humanLine, opts = {}) {
  const preferTemplate = !!opts.preferTemplate;
  const canTemplate = !!HEX_BACKFILL_GENERIC && !useMock;

  if (preferTemplate && canTemplate) {
    try {
      return await sendTemplateQuickReply(to, HEX_BACKFILL_GENERIC, { 1: String(humanLine || '') });
    } catch (e) {
      console.warn('[TWILIO] Template send failed, falling back:', e?.message);
    }
  }

  try {
    return await sendQuickReply(
      to,
      `Confirm backfill: ${String(humanLine || '')}\nReply: "Confirm" or "Cancel"`,
      ['Confirm', 'Cancel']
    );
  } catch (e2) {
    console.warn('[TWILIO] Quick-replies failed, final fallback to plain text:', e2?.message);
    return sendWhatsApp(to, `Confirm backfill: ${String(humanLine || '')}\nReply: "Confirm" or "Cancel"`);
  }
}

function verifyTwilioSignature(options = {}) {
  if (!useMock && TWILIO_AUTH_TOKEN) {
    const twilio = require('twilio');
    return twilio.webhook({ validate: true, ...options });
  }
  return function devBypass(_req, _res, next) { next(); };
}

module.exports = {
  sendWhatsApp,
  sendSMS,
  verifyTwilioSignature,
  sendMessage,
  sendQuickReply,
  sendTemplateMessage,
  sendTemplateQuickReply,
  sendBackfillConfirm,
};
