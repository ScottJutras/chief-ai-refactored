// utils/visionService.js
// Safe, dev-friendly wrapper for Google Vision OCR.
// In production, you can wire this to @google-cloud/vision.
// For now, if credentials are missing, we just return empty text so media
// handling never crashes the server.

const hasVisionCreds = !!process.env.GOOGLE_VISION_CREDENTIALS_BASE64;

/**
 * Extract text from an image URL (Twilio media URL).
 *
 * For now this is a stub in local/dev: if Vision credentials are not present,
 * it logs a warning and returns { text: "" } so the caller can fall back.
 *
 * @param {string} imageUrl
 * @returns {Promise<{ text: string }>}
 */
async function extractTextFromImage(imageUrl) {
  if (!hasVisionCreds) {
    console.warn(
      '[visionService] GOOGLE_VISION_CREDENTIALS_BASE64 missing. ' +
        'Skipping OCR and returning empty text (dev mode).'
    );
    return { text: '' };
  }

  // ─── Production path (optional, when you’re ready to wire real OCR) ───
  // NOTE: You can uncomment and complete this when you have Vision creds
  // and want real OCR. For now, this function will never hit this block
  // because hasVisionCreds is false locally.

  
  try {
    const { ImageAnnotatorClient } = require('@google-cloud/vision');

    // Decode base64 credentials JSON
    const credsJson = Buffer.from(
      process.env.GOOGLE_VISION_CREDENTIALS_BASE64,
      'base64'
    ).toString('utf8');
    const credentials = JSON.parse(credsJson);

    const client = new ImageAnnotatorClient({ credentials });

    const [result] = await client.textDetection(imageUrl);
    const detections = result.textAnnotations || [];
    const fullText = detections[0]?.description || '';

    return { text: fullText };
  } catch (err) {
    console.error('[visionService] Vision OCR failed:', err?.message);
    return { text: '' };
  }
  
}

module.exports = {
  extractTextFromImage,
};
