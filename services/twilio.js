// services/twilio.js
// Twilio wrapper with dev-safe mock, Messaging Service-first, and WhatsApp-first helpers.

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

function toTemplateVar(str) {
  return (
    String(str || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 900) || '—'
  );
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
  // Optional: if you ever implement list-picker via content templates:
  TWILIO_WA_JOB_PICKER_CONTENT_SID, // optional template sid for list picker
} = process.env;
console.info(
  '[TWILIO] job picker content sid present?',
  !!process.env.TWILIO_WA_JOB_PICKER_CONTENT_SID
);
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

function applyFromOrService(payload) {
  if (TWILIO_MESSAGING_SERVICE_SID && !useMock) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    payload.from = useMock ? 'whatsapp:+10000000000' : (resolvedWhatsAppFrom || 'whatsapp:+10000000000');
  }
  return payload;
}

async function sendWhatsApp(to, body, mediaUrls) {
  const payload = applyFromOrService({
    to: toWhatsApp(to),
    body: String(body || '')
  });

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
  const actions = (replies || []).slice(0, 3).map((r) => `reply?text=${encodeURIComponent(String(r))}`);

  const payload = applyFromOrService({
    to: toWhatsApp(to),
    body: String(body || ''),
    persistentAction: actions
  });

  return twilioClient.messages.create(payload);
}

/**
 * Template sender (Twilio Content API).
 * ✅ HARDENED: always includes a body fallback, and if contentSid is missing, sends plain WhatsApp.
 */
async function sendTemplateMessage(to, contentSid, vars = {}, fallbackBody = '') {
  const toW = toWhatsApp(to);

  // If no contentSid (or blank), fail-open to a normal message (prevents 21619)
  if (!contentSid || !String(contentSid).trim()) {
    const body = String(fallbackBody || '').trim() || Object.values(vars || {}).map(String).join(' ').trim() || '—';
    return sendWhatsApp(toW, body);
  }

  const payload = applyFromOrService({
    to: toW,
    contentSid: String(contentSid).trim(),
    contentVariables: JSON.stringify(vars || {}),
    // ✅ safety net: Twilio accepts body alongside templates; prevents 21619 in weird edge cases
    body: String(fallbackBody || '').trim() || ' '
  });

  return twilioClient.messages.create(payload);
}

async function sendTemplateQuickReply(to, contentSid, vars = {}, fallbackBody = '') {
  return sendTemplateMessage(to, contentSid, vars, fallbackBody);
}

async function sendBackfillConfirm(to, humanLine, opts = {}) {
  const preferTemplate = !!opts.preferTemplate;
  const canTemplate = !!HEX_BACKFILL_GENERIC && !useMock;

  if (preferTemplate && canTemplate) {
    try {
      return await sendTemplateQuickReply(
        to,
        HEX_BACKFILL_GENERIC,
        { 1: toTemplateVar(humanLine) },
        `Confirm backfill: ${String(humanLine || '')}\nReply: "Confirm" or "Cancel"`
      );
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

/**
 * ✅ NEW: Interactive list sender (best-effort).
 *
 * IMPORTANT:
 * - Twilio's basic Messages API does NOT support WhatsApp "List" objects directly.
 * - So this function:
 *   (1) tries a Content Template SID if you provide one (TWILIO_WA_JOB_PICKER_CONTENT_SID),
 *   (2) otherwise sends a normal text body (which your expense.js already builds).
 *
 * This still fixes your 21619 by guaranteeing body/contentSid exists.
 */
async function sendWhatsAppInteractiveList({ to, bodyText, buttonText, sections, contentSid } = {}) {
  const safeBody = String(bodyText || '').trim() || '—';

  const sid =
    (contentSid && String(contentSid).trim()) ||
    (process.env.TWILIO_WA_JOB_PICKER_CONTENT_SID && String(process.env.TWILIO_WA_JOB_PICKER_CONTENT_SID).trim()) ||
    (process.env.TWILIO_ACTIVE_JOBS_LIST_TEMPLATE_SID && String(process.env.TWILIO_ACTIVE_JOBS_LIST_TEMPLATE_SID).trim()) ||
    null;

  console.info('[TWILIO] sendWhatsAppInteractiveList', {
    hasSid: !!sid,
    sid: sid ? `${sid.slice(0, 6)}…` : null,
    hasBody: !!safeBody
  });

  if (!sid) {
    console.warn('[TWILIO] Interactive list requested but no Content SID configured. Sending plain text.', {
      to: String(to || '').slice(0, 8) + '…',
      hasSections: Array.isArray(sections) && sections.length > 0
    });
    return sendWhatsApp(to, safeBody);
  }

  const vars = {
    1: toTemplateVar(safeBody),
    2: toTemplateVar(buttonText || 'Pick'),
    3: toTemplateVar(JSON.stringify(sections || []).slice(0, 900))
  };

  try {
    return await sendTemplateMessage(to, sid, vars, safeBody);
  } catch (e) {
    console.warn('[TWILIO] interactive list template failed; falling back to plain text:', e?.message);
    return sendWhatsApp(to, safeBody);
  }
}


function verifyTwilioSignature(options = {}) {
  if (!useMock && TWILIO_AUTH_TOKEN) {
    const twilio = require('twilio');
    return twilio.webhook({ validate: true, ...options });
  }
  return function devBypass(_req, _res, next) {
    next();
  };
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
  sendWhatsAppInteractiveList,
  toWhatsApp,
  toTemplateVar
};
