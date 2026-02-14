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

  // ✅ IMPORTANT: Do NOT use Messaging Service for WhatsApp templates unless you 100% confirmed
  // the service has a WhatsApp sender attached. Prevents 21703.
  messagingServiceSid: null
};

}

/**
 * ✅ WhatsApp Content API requires `contentVariables` as a JSON STRING
 * ✅ Keep body non-empty
 * ✅ HARDENED: normalize to/from, normalize numeric keys, and (optionally) enforce count
 */
async function sendTemplateMessage(to, sid, vars = {}, fallbackBody = ' ') {
  const safeFallback = String(fallbackBody || '').trim() || ' ';

  // ✅ Normalize TO for WhatsApp templates (always safe)
  const toNorm = toWhatsApp(to);

  // ✅ Normalize variable keys to pure integer strings "1".."N"
  // and values to strings. Drops anything not a positive integer key.
  const normalized = {};
  try {
    for (const [k, v] of Object.entries(vars || {})) {
      if (v == null) continue;
      const n = parseInt(String(k).trim(), 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      normalized[String(n)] = String(v);
    }
  } catch {}

  // ✅ OPTIONAL strict enforcement:
  // If you set TWILIO_TEMPLATE_PARAM_COUNT, we will send EXACTLY 1..N keys (no more, no less).
  // For job picker, set this to 18.
  const envCount = parseInt(String(process.env.TWILIO_TEMPLATE_PARAM_COUNT || '').trim(), 10) || null;

  let finalVars = normalized;

  if (envCount && Number.isFinite(envCount) && envCount > 0) {
    const strict = {};
    for (let i = 1; i <= envCount; i++) {
      const key = String(i);
      strict[key] = finalVars[key] != null ? String(finalVars[key]) : '—';
    }
    finalVars = strict;
  }

  // ✅ Key audit + missing keys (this is the most useful log for 63028)
  const keys = Object.keys(finalVars).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const maxKey = keys.reduce((m, k) => Math.max(m, parseInt(k, 10) || 0), 0);

  const missing = [];
  for (let i = 1; i <= maxKey; i++) {
    if (!finalVars[String(i)]) missing.push(String(i));
  }

  console.info('[TWILIO] contentVariables key audit', {
    keyCount: keys.length,
    maxKey,
    missingCount: missing.length,
    missingFirst: missing.slice(0, 10),
    firstKeys: keys.slice(0, 10),
    lastKeys: keys.slice(-10),
    envCount: envCount || null
  });

  let contentVariables = '{}';
  try {
    contentVariables = JSON.stringify(finalVars);
  } catch {
    contentVariables = '{}';
  }

  const { waFrom, messagingServiceSid } = resolveSendFromConfig();

  // ✅ Normalize FROM if using WhatsApp sender
  const fromNorm = waFrom ? normalizeWhatsAppFrom(waFrom) : null;

  const statusCallback = String(process.env.TWILIO_STATUS_CALLBACK_URL || '').trim() || null;

  const payload = {
    to: toNorm,
    ...(messagingServiceSid ? { messagingServiceSid } : { from: fromNorm }),
    contentSid: String(sid || '').trim(),
    contentVariables,
    body: safeFallback,
    ...(statusCallback ? { statusCallback } : {})
  };

  console.info('[TWILIO] sendTemplateMessage messages.create payload', {
    to: payload.to,
    from: payload.from ? String(payload.from).slice(0, 20) : null,
    hasMessagingServiceSid: !!payload.messagingServiceSid,
    hasContentSid: !!payload.contentSid,
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
  const toWa = toWhatsApp(to);

  const sid =
    (contentSid && String(contentSid).trim()) ||
    (TWILIO_WA_JOB_PICKER_CONTENT_SID && String(TWILIO_WA_JOB_PICKER_CONTENT_SID).trim()) ||
    (TWILIO_ACTIVE_JOBS_LIST_TEMPLATE_SID && String(TWILIO_ACTIVE_JOBS_LIST_TEMPLATE_SID).trim()) ||
    null;

  const hasRows =
    Array.isArray(sections) &&
    sections.some((s) => Array.isArray(s?.rows) && s.rows.length > 0);

  console.info('[TWILIO] sendWhatsAppInteractiveList', {
    to: String(toWa || '').slice(0, 18),
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
      toWa,
      safeBody + '\n\n(No jobs found for this account — try creating a job or check tenant mapping.)'
    );
  }

  if (!sid) {
    console.warn('[TWILIO] Interactive list requested but no Content SID configured. Sending plain text.');
    return sendWhatsApp(toWa, safeBody);
  }

  // Flatten rows across sections
  const flatRows = [];
  for (const s of (sections || [])) {
    for (const r of (s?.rows || [])) flatRows.push(r);
  }

  // ✅ Row count configurable (1..8)
  const rowCount =
    Math.max(1, Math.min(8, parseInt(String(process.env.TWILIO_WA_JOB_PICKER_ROW_COUNT || '8'), 10) || 8));

  const rows = flatRows.slice(0, rowCount);

  while (rows.length < rowCount) {
    rows.push({ title: '—', id: `pad_${rows.length + 1}` });
  }

  let vars = {
    1: String(safeBody || '—'),
    2: String(buttonText || 'Pick job')
  };

  for (let i = 0; i < rowCount; i++) {
    const r = rows[i];
    const base = 3 + i * 2;
    vars[String(base)] = String(r?.title || '—');
    vars[String(base + 1)] = String(r?.id || `pad_${i + 1}`);
  }

  console.info('[TWILIO] list vars preview', {
    rowCount,
    v1: vars[1],
    v2: vars[2],
    row1: { name: vars[3], id: vars[4] },
    row2: rowCount >= 2 ? { name: vars[5], id: vars[6] } : null
  });

  // ✅ Determine final param count
  const envExpected =
    parseInt(String(process.env.TWILIO_WA_JOB_PICKER_PARAM_COUNT || '').trim(), 10) || null;

  // Optional “pad higher” override (use ONLY if Content API shows more than 18 expected)
  const envPadTo =
    parseInt(String(process.env.TWILIO_WA_JOB_PICKER_PAD_TO || '').trim(), 10) || null;

  const keysNow = Object.keys(vars).map((k) => parseInt(k, 10)).filter((n) => Number.isFinite(n));
  const maxKeyNow = keysNow.length ? Math.max(...keysNow) : 0;

  const expectedParamCount =
    (envExpected && envExpected > 0 ? envExpected : null) ||
    (envPadTo && envPadTo > 0 ? envPadTo : null) ||
    maxKeyNow;

  // ✅ Pad/trim to expectedParamCount
  const finalVars = {};
  for (let i = 1; i <= expectedParamCount; i++) {
    const k = String(i);
    finalVars[k] = (vars[k] != null ? String(vars[k]) : '—');
  }

  console.info('[TWILIO] list vars finalized', {
    expectedParamCount,
    maxKeyNow,
    keysSent: Object.keys(finalVars).length
  });

  try {
    const result = await sendTemplateMessage(toWa, sid, finalVars, safeBody);

    if (DOUBLE_SEND_LIST_FALLBACK) {
      try {
        await sendWhatsApp(toWa, safeBody);
      } catch (e2) {
        console.warn('[TWILIO] double-send fallback failed (ignored):', e2?.message);
      }
    }

    return result;
  } catch (e) {
    console.warn('[TWILIO] interactive list template failed; falling back to plain text:', e?.message);
    const lines = flatRows.slice(0, 12).map((r, i) => `${i + 1}) ${r.title}`);
    return sendWhatsApp(toWa, `${safeBody}\n\nReply with a job number:\n${lines.join('\n')}`);
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
