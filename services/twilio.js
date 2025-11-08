// services/twilio.js
// Twilio wrapper with dev-safe mock, Messaging Service-first, and WhatsApp-first helpers.
const crypto = require('crypto');

const {
  NODE_ENV,
  MOCK_TWILIO,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  TWILIO_SMS_FROM,
  TWILIO_WHATSAPP_NUMBER,          // legacy
  TWILIO_MESSAGING_SERVICE_SID,    // preferred
  HEX_BACKFILL_CLOCKIN,            // Content API template SID for backfill confirm
} = process.env;

const isProd = NODE_ENV === 'production';

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

const resolvedWhatsAppFrom = normalizeWhatsAppFrom(TWILIO_WHATSAPP_FROM || TWILIO_WHATSAPP_NUMBER);
const hasCreds = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && (resolvedWhatsAppFrom || TWILIO_SMS_FROM || TWILIO_MESSAGING_SERVICE_SID));
const useMock = !isProd && (!hasCreds || String(MOCK_TWILIO) === '1');

let twilioClient = null;

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

// ---------- Common payload builder ----------
function applyFromOrService(payload) {
  if (TWILIO_MESSAGING_SERVICE_SID && !useMock) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    // Fallback to explicit FROM numbers
    if (!payload.from) {
      payload.from = useMock
        ? (payload.to?.startsWith('whatsapp:') ? 'whatsapp:+10000000000' : '+10000000000')
        : (payload.to?.startsWith('whatsapp:') ? (resolvedWhatsAppFrom || 'whatsapp:+10000000000') : TWILIO_SMS_FROM);
    }
  }
  return payload;
}

// ---------- Core senders ----------
async function sendWhatsApp(to, body, mediaUrls) {
  const payload = applyFromOrService({
    to: toWhatsApp(to),
    body
  });
  if (mediaUrls && mediaUrls.length) payload.mediaUrl = mediaUrls;
  return twilioClient.messages.create(payload);
}

async function sendSMS(to, body) {
  const payload = applyFromOrService({ to, body });
  if (!payload.messagingServiceSid && !useMock && !payload.from) {
    throw new Error('TWILIO_SMS_FROM is required when Messaging Service SID is not set');
  }
  return twilioClient.messages.create(payload);
}

// Convenience alias
async function sendMessage(to, body) {
  return sendWhatsApp(to, body);
}

// ---------- Quick replies (persistentAction) ----------
async function sendQuickReply(to, body, replies = []) {
  // Twilio supports up to 3 persistent reply actions
  const buttons = (replies || []).slice(0, 3).map(r => `reply?text=${encodeURIComponent(String(r))}`);
  const payload = applyFromOrService({
    to: toWhatsApp(to),
    body,
    persistentAction: buttons
  });
  return twilioClient.messages.create(payload);
}

// ---------- Content API (templates) ----------
async function sendTemplateMessage(to, contentSid, vars = {}) {
  const payload = applyFromOrService({
    to: toWhatsApp(to),
    contentSid,
    contentVariables: JSON.stringify(vars || {})
  });
  return twilioClient.messages.create(payload);
}

// Twilio limitation: templates + buttons are defined on the Content SID; no extra buttons param here.
async function sendTemplateQuickReply(to, contentSid, vars = {}) {
  return sendTemplateMessage(to, contentSid, vars);
}

// ---------- Purpose-built helper: backfill confirm (Confirm / Cancel) ----------
/**
 * Send a confirm/cancel for a backfill summary.
 * Strategy:
 *  - If a Content Template SID (HEX_BACKFILL_CLOCKIN) is configured or preferTemplate=true, use Content API.
 *  - Otherwise, send persistentAction quick replies (<=3) and append "Reply: Confirm | Cancel" for clarity.
 *
 * @param {string} to E.164 or whatsapp:+E164
 * @param {string} summary Human-readable line e.g. "Justin clocked in at 04:00 on 2025-11-08"
 * @param {object} opts { preferTemplate?: boolean, replies?: string[] }
 */
async function sendBackfillConfirm(to, summary, opts = {}) {
  const { preferTemplate = true, replies = ['Confirm', 'Cancel'] } = opts;

  // If template SID is available (or we explicitly prefer it), try Content API first.
  if ((preferTemplate || HEX_BACKFILL_CLOCKIN) && HEX_BACKFILL_CLOCKIN && !useMock) {
    try {
      // Template body example: "Updated clock-in: {{1}}\nPlease confirm the clock-in entry."
      // Buttons are defined on the Content SID (labels: Confirm / Cancel).
      return await sendTemplateQuickReply(to, HEX_BACKFILL_CLOCKIN, { '1': summary });
    } catch (e) {
      console.warn('[TWILIO] Template send failed; falling back to quick reply:', e?.message);
      // fall through to fallback
    }
  }

  // Fallback: persistentAction quick replies
  const body = `Confirm backfill: ${summary}\nReply: ${replies.join(' | ')}`;
  return sendQuickReply(to, body, replies);
}

// ---------- Signature verification middleware ----------
function verifyTwilioSignature(options = {}) {
  if (!useMock && TWILIO_AUTH_TOKEN) {
    const twilio = require('twilio');
    return twilio.webhook({ validate: true, ...options });
  }
  // Dev bypass
  return function devBypass(_req, _res, next) { next(); };
}

module.exports = {
  // Core
  sendWhatsApp,
  sendSMS,
  verifyTwilioSignature,

  // Convenience
  sendMessage,
  sendQuickReply,
  sendTemplateMessage,
  sendTemplateQuickReply,

  // Purpose-built helper
  sendBackfillConfirm,
};
