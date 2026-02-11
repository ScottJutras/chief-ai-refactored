// utils/visionService.js
// ------------------------------------------------------------
// Document AI OCR wrapper (drop-in replacement for prior Vision OCR)
// ✅ Never hard-fails if optional deps are missing (@google-cloud/documentai, axios)
// ✅ Capability-gated + cached client (cold-start friendly)
// ✅ Handles Twilio-protected Media URLs by fetching bytes with Basic Auth
// ✅ Returns { text: "" } on any failure so media flow never crashes
//
// NEW (MVP money safety):
// ✅ Monthly quota gate BEFORE paid OCR calls (DocAI / Vision)
// ✅ "Consume" happens BEFORE paid call (prevents abuse via forced failures)
//
// Env (recommended):
//   GOOGLE_CREDENTIALS_BASE64  (service account json base64)
//   DOCUMENTAI_PROCESSOR_NAME  (projects/.../locations/.../processors/...)
//
// Or:
//   DOCUMENTAI_PROJECT_ID
//   DOCUMENTAI_LOCATION   (us|eu)
//   DOCUMENTAI_PROCESSOR_ID
//
// Optional:
//   DOCUMENTAI_API_ENDPOINT  (eu-documentai.googleapis.com / us-documentai.googleapis.com)
// ------------------------------------------------------------

const { checkMonthlyQuota, consumeMonthlyQuota } = require('./quota');

let cachedClient = undefined; // undefined = not initialized, null = unavailable, object = client
let cachedCaps = undefined;

let DocAI = null;
let Vision = null;

try {
  // eslint-disable-next-line global-require
  DocAI = require('@google-cloud/documentai').v1;
} catch (e) {
  console.warn('[visionService] Document AI unavailable:', e?.message || e);
  DocAI = null;
}

try {
  // eslint-disable-next-line global-require
  Vision = require('@google-cloud/vision');
} catch (e) {
  console.warn('[visionService] Vision OCR unavailable:', e?.message || e);
  Vision = null;
}

function hasDocAiCreds() {
  return !!(
    process.env.GOOGLE_CREDENTIALS_BASE64 ||
    process.env.GOOGLE_DOCUMENTAI_CREDENTIALS_BASE64 ||
    process.env.GOOGLE_VISION_CREDENTIALS_BASE64 ||
    process.env.GOOGLE_CLOUD_CREDENTIALS_BASE64 ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64
  );
}

function getDocAiProcessorName() {
  const explicit = String(process.env.DOCUMENTAI_PROCESSOR_NAME || '').trim();
  if (explicit) return explicit;

  const projectId = String(process.env.DOCUMENTAI_PROJECT_ID || '').trim();
  const location = String(process.env.DOCUMENTAI_LOCATION || '').trim();
  const processorId = String(process.env.DOCUMENTAI_PROCESSOR_ID || '').trim();

  if (!projectId || !location || !processorId) return null;
  return `projects/${projectId}/locations/${location}/processors/${processorId}`;
}

function getDocAiEndpoint() {
  const explicit = String(process.env.DOCUMENTAI_API_ENDPOINT || '').trim();
  if (explicit) return explicit;

  const location = String(process.env.DOCUMENTAI_LOCATION || '').trim().toLowerCase();
  if (location === 'eu') return 'eu-documentai.googleapis.com';
  if (location === 'us') return 'us-documentai.googleapis.com';
  return null;
}

function getCredentialsFromBase64() {
  const b64 =
    process.env.GOOGLE_DOCUMENTAI_CREDENTIALS_BASE64 ||
    process.env.GOOGLE_CREDENTIALS_BASE64 ||
    process.env.GOOGLE_VISION_CREDENTIALS_BASE64 ||
    process.env.GOOGLE_CLOUD_CREDENTIALS_BASE64 ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64 ||
    '';

  const raw = String(b64).trim();
  if (!raw) return null;

  try {
    const jsonStr = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (e) {
    console.warn('[visionService] Credential JSON decode failed:', e?.message || e);
    return null;
  }
}

function getDocAiClient() {
  if (cachedClient !== undefined) return cachedClient;

  if (!hasDocAiCreds()) {
    console.warn('[visionService] Credentials missing. Skipping OCR (dev mode).');
    cachedClient = null;
    return cachedClient;
  }

  const processorName = getDocAiProcessorName();
  if (!processorName) {
    console.warn(
      '[visionService] Processor name missing. Set DOCUMENTAI_PROCESSOR_NAME (or PROJECT/LOCATION/PROCESSOR_ID).'
    );
    cachedClient = null;
    return cachedClient;
  }

  if (!DocAI?.DocumentProcessorServiceClient) {
    console.warn('[visionService] @google-cloud/documentai not present in runtime bundle.');
    cachedClient = null;
    return cachedClient;
  }

  const credentials = getCredentialsFromBase64();
  if (!credentials) {
    console.warn('[visionService] Credentials invalid/unreadable.');
    cachedClient = null;
    return cachedClient;
  }

  try {
    const { DocumentProcessorServiceClient } = DocAI;

    const apiEndpoint = getDocAiEndpoint();
    const opts = apiEndpoint ? { apiEndpoint, credentials } : { credentials };

    cachedClient = new DocumentProcessorServiceClient(opts);
    cachedCaps = { processorName };
    return cachedClient;
  } catch (err) {
    console.warn('[visionService] Document AI client init failed:', err?.message || err);
    cachedClient = null;
    return cachedClient;
  }
}

async function fetchTwilioMediaBytes(url) {
  try {
    // eslint-disable-next-line global-require
    const axios = require('axios');

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;

    const config = {
      responseType: 'arraybuffer',
      maxContentLength: 12 * 1024 * 1024,
      timeout: 8000
    };

    if (sid && token) config.auth = { username: sid, password: token };

    const resp = await axios.get(url, config);
    return Buffer.from(resp.data);
  } catch (err) {
    console.warn('[visionService] Media fetch failed (ignored):', err?.message || err);
    return null;
  }
}

function normalizeMimeType(mediaType) {
  const mt = String(mediaType || '').split(';')[0].trim().toLowerCase();
  if (mt) return mt;
  return 'application/octet-stream';
}

async function processBytesWithDocAi({ bytes, mimeType }) {
  const client = getDocAiClient();
  if (!client) return { text: '' };

  const processorName = cachedCaps?.processorName || getDocAiProcessorName();
  if (!processorName) return { text: '' };

  try {
    const encoded = Buffer.from(bytes).toString('base64');

    const request = {
      name: processorName,
      rawDocument: {
        content: encoded,
        mimeType: mimeType || 'application/octet-stream'
      }
    };

    const [result] = await client.processDocument(request);
    const doc = result?.document || null;

    const text = String(doc?.text || '').trim();
    return { text: text || '' };
  } catch (err) {
    console.warn('[visionService] processDocument failed (ignored):', err?.message || err);
    return { text: '' };
  }
}

async function processBytesWithVision({ bytes }) {
  try {
    if (!Vision?.ImageAnnotatorClient) return { text: '' };

    const credentials = getCredentialsFromBase64();
    if (!credentials) return { text: '' };

    const client = new Vision.ImageAnnotatorClient({ credentials });

    const [result] = await client.textDetection({ image: { content: bytes } });
    const text = String(result?.fullTextAnnotation?.text || '').trim();
    return { text: text || '' };
  } catch (err) {
    console.warn('[visionService] Vision OCR unavailable/failed (ignored):', err?.message || err);
    return { text: '' };
  }
}

/**
 * Extract text from an image URL (Twilio media URL).
 *
 * ✅ Never throws.
 * ✅ Returns { text: "" } when OCR is unavailable OR blocked by quota.
 *
 * opts additions (MVP gating):
 * - opts.ownerId (REQUIRED for paid OCR)
 * - opts.planKey (REQUIRED for paid OCR)
 */
async function extractTextFromImage(imageUrl, opts = {}) {
  const url = String(imageUrl || '').trim();
  if (!url) return { text: '' };

  const mimeType = normalizeMimeType(opts.mediaType);

  // ✅ Money-surface gate inputs
  const ownerId = String(opts.ownerId || '').trim();
  const planKey = String(opts.planKey || '').trim().toLowerCase() || 'free';

  try {
    const buf = await fetchTwilioMediaBytes(url);
    if (!buf || !buf.length) return { text: '' };

    // ✅ Hard safety: if we don’t know who/plan, don’t spend money.
    if (!ownerId) {
      console.warn('[visionService] Missing opts.ownerId → skipping paid OCR (safe).');
      return { text: '' };
    }

    // ✅ Quota gate once per OCR attempt (DocAI/Vision are both paid surfaces)
    const kind = 'ocr';
    const gate = await checkMonthlyQuota({ ownerId, planKey, kind, units: 1 });

    if (!gate.ok) {
      // For OCR we fail-closed (no paid call).
      return { text: '' };
    }

    // ✅ Consume BEFORE paid call (prevents abuse)
    try {
      await consumeMonthlyQuota({ ownerId, kind, units: 1 });
    } catch (e) {
      console.warn('[visionService] consumeMonthlyQuota failed (safe deny):', e?.message);
      return { text: '' };
    }

    // 1) Try DocAI if available
    const client = getDocAiClient();
    if (client) {
      const r1 = await processBytesWithDocAi({ bytes: buf, mimeType });
      const t1 = String(r1?.text || '').trim();
      if (t1) return { text: t1 };
    }

    // 2) Fallback: Vision OCR
    const r2 = await processBytesWithVision({ bytes: buf });
    const t2 = String(r2?.text || '').trim();
    return { text: t2 || '' };
  } catch (err) {
    console.warn('[visionService] extractTextFromImage failed (ignored):', err?.message || err);
    return { text: '' };
  }
}

module.exports = { extractTextFromImage };
