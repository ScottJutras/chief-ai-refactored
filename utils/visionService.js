// utils/visionService.js
require('dotenv').config();
const axios = require('axios');
const vision = require('@google-cloud/vision');

// Load & parse your key JSON from env
if (!process.env.GOOGLE_VISION_CREDENTIALS_BASE64) {
  throw new Error(
    "[ERROR] GOOGLE_VISION_CREDENTIALS_BASE64 is missing. Cannot authenticate Google Vision API."
  );
}
const googleVisionCredentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_VISION_CREDENTIALS_BASE64, 'base64').toString('utf-8')
);

// Instantiate a single Vision client with explicit creds
const visionClient = new vision.ImageAnnotatorClient({
  credentials: googleVisionCredentials
});

/**
 * Download an image (using Twilio auth) and extract text with Vision API.
 *
 * @param {string} imageSource - URL of the receipt image.
 * @returns {Promise<{ text: string }>} The full OCR text.
 */
async function extractTextFromImage(imageSource) {
  try {
    // 1) fetch the bytes
    console.log(`[DEBUG] Downloading image from: ${imageSource}`);
    const resp = await axios.get(imageSource, {
      responseType: "arraybuffer",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    });
    const imageBuffer = resp.data;

    // 2) documentTextDetection runs both page‐ and layout‐level OCR
    const [result] = await visionClient.documentTextDetection({
      image: { content: imageBuffer },
    });

    const fullText = result.fullTextAnnotation?.text || "";
    console.log("[DEBUG] Vision OCR extracted text length:", fullText.length);
    return { text: fullText };
  } catch (err) {
    console.error("[ERROR] Vision OCR failed:", err.message);
    return { text: "" };
  }
}

module.exports = { extractTextFromImage };
