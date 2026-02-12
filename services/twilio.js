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

function safeBodyOrDash(body) {
  const b = String(body || '').trim();
  return b || '—';
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

  // Content Template SID for WhatsApp list UI (your “Pick job” list)
  TWILIO_WA_JOB_PICKER_CONTENT_SID,

  // Your older env var name (keep supporting it)
  TWILIO_ACTIVE_JOBS_LIST_TEMPLATE_SID,

  // optional toggle
  DOUBLE_SEND_LIST_FALLBACK: _DOUBLE_SEND_LIST_FALLBACK
} = process.env;

console.info(
  '[TWILIO] job picker content sid present?',
  !!(TWILIO_WA_JOB_PICKER_CONTENT_SID || TWILIO_ACTIVE_JOBS_LIST_TEMPLATE_SID)
);

const DOUBLE_SEND_LIST_FALLBACK = String(_DOUBLE_SEND_LIST_FALLBACK || '') === '1';
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

/**
 * Apply either Messaging Service SID OR From address.
 * `channel` controls which "from" value is valid.
 */
function applyFromOrService(payload, channel = 'whatsapp') {
  // ✅ Prefer explicit WhatsApp from for WA + templates
  if (channel === 'whatsapp' && resolvedWhatsAppFrom) {
    payload.from = useMock ? 'whatsapp:+10000000000' : resolvedWhatsAppFrom;
    return payload;
  }

  // ✅ If we have a Messaging Service SID, use it (real client only)
  if (TWILIO_MESSAGING_SERVICE_SID && !useMock) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
    return payload;
  }

  // ✅ Otherwise set a valid From per channel
  if (channel === 'sms') {
    payload.from = useMock ? '+10000000000' : (TWILIO_SMS_FROM || '+10000000000');
    return payload;
  }

  // whatsapp fallback
  payload.from = useMock ? 'whatsapp:+10000000000' : (resolvedWhatsAppFrom || 'whatsapp:+10000000000');
  return payload;
}

/**
 * ✅ HARDENED: Never send Twilio a message with no Body and no Media.
 * If body is empty and no mediaUrls, we set body = '—' to prevent 21619.
 * ✅ Returns Twilio Message object (sid/status).
 */
async function sendWhatsApp(to, body, mediaUrls) {
  const hasMedia = Array.isArray(mediaUrls) && mediaUrls.length > 0;
  const safeBody = hasMedia ? String(body || '').trim() : safeBodyOrDash(body);

  const payload = applyFromOrService(
    {
      to: toWhatsApp(to),
      body: safeBody
    },
    'whatsapp'
  );

  if (hasMedia) payload.mediaUrl = mediaUrls;

  const msg = await twilioClient.messages.create(payload);
  console.info('[TWILIO] sendWhatsApp messages.create result', {
    to: payload.to,
    sid: msg?.sid,
    status: msg?.status,
    hasMedia
  });
  return msg;
}

async function sendSMS(to, body) {
  const payload = applyFromOrService(
    {
      to: String(to || ''),
      body: safeBodyOrDash(body)
    },
    'sms'
  );

  const msg = await twilioClient.messages.create(payload);
  console.info('[TWILIO] sendSMS messages.create result', {
    to: payload.to,
    sid: msg?.sid,
    status: msg?.status
  });
  return msg;
}

/**
 * Generic send helper (keeps legacy callers safe).
 * Uses WhatsApp if `to` looks like whatsapp:... otherwise SMS.
 */
async function sendMessage(to, body, mediaUrls) {
  const s = String(to || '').trim().toLowerCase();
  if (s.startsWith('whatsapp:')) return sendWhatsApp(to, body, mediaUrls);
  // If you want stricter routing, change this heuristic.
  return sendSMS(to, body);
}

/**
 * Best-effort “quick replies” using persistentAction.
 * ✅ Returns Twilio Message object (sid/status).
 */
async function sendQuickReply(to, body, replies = []) {
  const actions = (replies || []).slice(0, 3).map((r) => `reply?text=${encodeURIComponent(String(r))}`);

  const payload = applyFromOrService(
    {
      to: toWhatsApp(to),
      body: safeBodyOrDash(body),
      persistentAction: actions
    },
    'whatsapp'
  );

  const msg = await twilioClient.messages.create(payload);
  console.info('[TWILIO] sendQuickReply messages.create result', {
    to: payload.to,
    sid: msg?.sid,
    status: msg?.status,
    replies: (replies || []).slice(0, 3)
  });
  return msg;
}
// ✅ Local send-from resolver (self-contained; avoids getSendFromConfig dependency)
function resolveSendFromConfig() {
  // Prefer any existing module-scope variables if your file already defines them
  // (These checks are safe even if the vars don't exist.)
  let waFromLocal = null;
  let mssLocal = null;

  try { waFromLocal = typeof waFrom !== 'undefined' ? waFrom : null; } catch {}
  try { mssLocal = typeof messagingServiceSid !== 'undefined' ? messagingServiceSid : null; } catch {}

  const waFromEnv =
    String(process.env.TWILIO_WA_FROM || process.env.TWILIO_WHATSAPP_FROM || '').trim() || null;

  const messagingServiceSidEnv =
    String(process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim() || null;

  return {
    waFrom: String(waFromLocal || waFromEnv || '').trim() || null,
    messagingServiceSid: String(mssLocal || messagingServiceSidEnv || '').trim() || null
  };
}

/**
 * ✅ WhatsApp Content API still wants a body field present; keep it non-empty
 * ✅ Twilio requires `contentVariables` as a JSON STRING
 * ✅ Returns Twilio Message object (sid/status)
 */
async function sendTemplateMessage(to, sid, vars = {}, fallbackBody = ' ') {
  const safeFallback = String(fallbackBody || '').trim() || ' ';

  const cleanVars = {};
  try {
    for (const [k, v] of Object.entries(vars || {})) {
      if (v == null) continue;
      cleanVars[String(k)] = String(v);
    }
  } catch {}

  let contentVariables = '{}';
  try {
    contentVariables = JSON.stringify(cleanVars);
  } catch {
    contentVariables = '{}';
  }

  const { waFrom, messagingServiceSid } = resolveSendFromConfig();

  const statusCallback = String(process.env.TWILIO_STATUS_CALLBACK_URL || '').trim() || null;

  const payload = {
    to,
    ...(messagingServiceSid ? { messagingServiceSid } : { from: waFrom }),
    contentSid: String(sid || '').trim(),
    contentVariables,
    body: safeFallback,
    ...(statusCallback ? { statusCallback } : {})
  };

  console.info('[TWILIO] sendTemplateMessage messages.create payload', {
    to: payload.to,
    hasFrom: !!payload.from,
    hasMessagingServiceSid: !!payload.messagingServiceSid,
    hasContentSid: !!payload.contentSid,
    hasContentVariables: !!payload.contentVariables,
    contentVariablesLen: String(payload.contentVariables || '').length,
    hasBody: !!payload.body,
    hasStatusCallback: !!payload.statusCallback
  });

  try {
    const msg = await twilioClient.messages.create(payload);
    console.info('[TWILIO] sendTemplateMessage messages.create result', { sid: msg?.sid, status: msg?.status });
    return msg;
  } catch (e) {
    console.warn('[TWILIO] sendTemplateMessage messages.create failed', {
      message: e?.message,
      code: e?.code,
      status: e?.status
    });
    throw e;
  }
}



/**
 * Legacy/compat alias: some callsites want “template quick reply”.
 * For Content Templates, the buttons live in the template itself.
 * So this is just sendTemplateMessage().
 */
async function sendTemplateQuickReply(to, templateSid, vars = {}, fallbackBody = ' ') {
  return sendTemplateMessage(to, templateSid, vars, fallbackBody);
}

/**
 * Wrapper: returns Twilio message object (sid/status).
 */
async function sendWhatsAppTemplate({ to, templateSid, summaryLine } = {}) {
  const safe = String(summaryLine || '').replace(/\s+/g, ' ').trim().slice(0, 600) || '—';
  return sendTemplateMessage(to, templateSid, { 1: toTemplateVar(safe) }, safe);
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
 * Interactive list sender (via Content Templates).
 * Uses a List Picker template with 8 fixed rows:
 * 1 = body, 2 = button
 * rows: (name,id) repeated starting at var 3
 *
 * If no Content SID is configured, falls back to a plain text message.
 */
async function sendWhatsAppInteractiveList({ to, bodyText, buttonText, sections, contentSid } = {}) {
  const safeBody = safeBodyOrDash(bodyText);

  const sid =
    (contentSid && String(contentSid).trim()) ||
    (TWILIO_WA_JOB_PICKER_CONTENT_SID && String(TWILIO_WA_JOB_PICKER_CONTENT_SID).trim()) ||
    (TWILIO_ACTIVE_JOBS_LIST_TEMPLATE_SID && String(TWILIO_ACTIVE_JOBS_LIST_TEMPLATE_SID).trim()) ||
    null;

  const hasRows =
    Array.isArray(sections) &&
    sections.some((s) => Array.isArray(s?.rows) && s.rows.length > 0);

  console.info('[TWILIO] sendWhatsAppInteractiveList', {
    to: String(to || '').slice(0, 12),
    hasSid: !!sid,
    sid: sid ? `${sid.slice(0, 6)}…` : null,
    hasBody: !!safeBody,
    hasRows,
    sectionsLen: Array.isArray(sections) ? sections.length : 0,
    doubleSend: DOUBLE_SEND_LIST_FALLBACK
  });

  if (!hasRows) {
    console.warn('[TWILIO] interactive list requested but sections had no rows; sending plain text fallback');
    return sendWhatsApp(
      to,
      safeBody + '\n\n(No jobs found for this account — try creating a job or check tenant mapping.)'
    );
  }

  if (!sid) {
    console.warn('[TWILIO] Interactive list requested but no Content SID configured. Sending plain text.');
    return sendWhatsApp(to, safeBody);
  }

  // Flatten rows across sections and take first 8
  const flatRows = [];
  for (const s of (sections || [])) {
    for (const r of (s?.rows || [])) flatRows.push(r);
  }

  const rows8 = flatRows.slice(0, 8);

  // Pad to exactly 8 rows (template requires 8 items)
  while (rows8.length < 8) {
    rows8.push({ title: '—', id: `pad_${rows8.length + 1}` });
  }

  // Template vars:
  // 1=body, 2=button
  // row1: 3=name, 4=id
  // row2: 5=name, 6=id
  // ...
  // row8: 17=name, 18=id
  const vars = {
    1: String(safeBody || '—'),
    2: String(buttonText || 'Pick job')
  };

  for (let i = 0; i < 8; i++) {
    const r = rows8[i];
    const base = 3 + i * 2;
    vars[String(base)] = String(r?.title || '—');
    vars[String(base + 1)] = String(r?.id || `pad_${i + 1}`);
  }

  console.info('[TWILIO] list vars preview', {
    v1: vars[1],
    v2: vars[2],
    row1: { name: vars[3], id: vars[4] },
    row2: { name: vars[5], id: vars[6] }
  });

  try {
    const result = await sendTemplateMessage(to, sid, vars, safeBody);

    if (DOUBLE_SEND_LIST_FALLBACK) {
      try {
        await sendWhatsApp(to, safeBody);
      } catch (e2) {
        console.warn('[TWILIO] double-send fallback failed (ignored):', e2?.message);
      }
    }

    return result; // ✅ includes sid/status
  } catch (e) {
    console.warn('[TWILIO] interactive list template failed; falling back to plain text:', e?.message);

    const lines = flatRows.slice(0, 12).map((r, i) => `${i + 1}) ${r.title}`);
    return sendWhatsApp(to, `${safeBody}\n\nReply with a job number:\n${lines.join('\n')}`);
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
  sendMessage, // ✅ now defined
  sendQuickReply,
  sendTemplateMessage,
  sendTemplateQuickReply, // ✅ now defined (alias)
  sendBackfillConfirm,
  sendWhatsAppInteractiveList,
  toWhatsApp,
  toTemplateVar,
  sendWhatsAppTemplate
};
