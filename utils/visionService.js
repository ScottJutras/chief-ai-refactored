// utils/visionService.js
// COMPLETE DROP-IN (BETA-ready; aligned to media.js expectations)
// Safe, serverless-friendly wrapper for Google Vision OCR.
//
// ✅ Never hard-fails if optional deps are missing (@google-cloud/vision, axios)
// ✅ Capability-gated + cached client (cold-start friendly)
// ✅ Handles Twilio-protected Media URLs by fetching bytes with Basic Auth (when creds exist)
// ✅ Returns { text: "" } on any failure so media flow never crashes
// ✅ Adds timeouts + size guards to avoid hanging lambdas

let cachedClient = undefined; // undefined = not initialized, null = unavailable, object = client

function hasVisionCreds() {
  return !!process.env.GOOGLE_VISION_CREDENTIALS_BASE64;
}

function getVisionClient() {
  if (cachedClient !== undefined) return cachedClient; // cached

  if (!hasVisionCreds()) {
    console.warn('[visionService] GOOGLE_VISION_CREDENTIALS_BASE64 missing. Skipping OCR (dev mode).');
    cachedClient = null;
    return cachedClient;
  }

  try {
    // Optional dependency — must be guarded.
    const { ImageAnnotatorClient } = require('@google-cloud/vision');

    const credsJson = Buffer.from(process.env.GOOGLE_VISION_CREDENTIALS_BASE64, 'base64').toString('utf8');
    const credentials = JSON.parse(credsJson);

    cachedClient = new ImageAnnotatorClient({ credentials });
    return cachedClient;
  } catch (err) {
    // Missing module or bad creds JSON — treat as unavailable, fail-open.
    console.warn('[visionService] Vision unavailable:', err?.message || err);
    cachedClient = null;
    return cachedClient;
  }
}

async function fetchTwilioMediaBytes(imageUrl) {
  // Fetching Twilio media often requires Basic Auth.
  // Must fail-open — caller will fall back.
  const url = String(imageUrl || '').trim();
  if (!url) return null;

  let axios;
  try {
    axios = require('axios');
  } catch (e) {
    console.warn('[visionService] axios missing. Cannot fetch media bytes.');
    return null;
  }

  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;

    // If creds missing, try unauthenticated fetch (works if media URL is public/signed)
    const config = {
      responseType: 'arraybuffer',
      maxContentLength: 12 * 1024 * 1024, // images can be larger than audio
      timeout: 8000,
      headers: { 'User-Agent': 'ChiefOS-VisionService/1.0' },
    };

    if (sid && token) {
      config.auth = { username: sid, password: token };
    }

    const resp = await axios.get(url, config);
    const buf = Buffer.from(resp.data);

    // Small guard: don't try OCR on empty
    if (!buf || !buf.length) return null;
    return buf;
  } catch (err) {
    console.warn('[visionService] Media fetch failed (ignored):', err?.message || err);
    return null;
  }
}

/**
 * Extract text from an image URL (Twilio media URL).
 *
 * ✅ Never throws.
 * ✅ Returns { text: "" } when Vision is unavailable OR OCR fails.
 *
 * @param {string} imageUrl
 * @param {object} [opts]
 * @param {boolean} [opts.fetchBytes=true] - fetch bytes and OCR by content (preferred for Twilio URLs)
 * @returns {Promise<{ text: string }>}
 */
async function extractTextFromImage(imageUrl, opts = {}) {
  const url = String(imageUrl || '').trim();
  if (!url) return { text: '' };

  const client = getVisionClient();
  if (!client) return { text: '' };

  const fetchBytes = opts.fetchBytes !== false;

  try {
    // Prefer OCR-by-bytes because Twilio media URLs often require auth.
    if (fetchBytes) {
      const buf = await fetchTwilioMediaBytes(url);
      if (!buf || !buf.length) return { text: '' };

      // Vision expects base64 content
      const [result] = await client.textDetection({
        image: { content: buf.toString('base64') },
      });

      const detections = result?.textAnnotations || [];
      const fullText = detections[0]?.description || '';
      return { text: fullText || '' };
    }

    // Fallback path: OCR-by-URL (only works if URL is publicly accessible)
    const [result] = await client.textDetection(url);
    const detections = result?.textAnnotations || [];
    const fullText = detections[0]?.description || '';
    return { text: fullText || '' };
  } catch (err) {
    // Fail-open: OCR is enrichment only.
    console.warn('[visionService] Vision OCR failed (ignored):', err?.message || err);
    return { text: '' };
  }
}

module.exports = {
  extractTextFromImage,
};
