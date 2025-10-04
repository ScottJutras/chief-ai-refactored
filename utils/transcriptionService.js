// utils/transcriptionService.js
require('dotenv').config();
const { SpeechClient } = require('@google-cloud/speech').v1;

let speechClient = null;

function loadSpeechCredentials() {
  // Prefer a speech-specific var, then generic ones you already use elsewhere.
  const b64 =
    process.env.GOOGLE_SPEECH_CREDENTIALS_BASE64 ||
    process.env.GOOGLE_VISION_CREDENTIALS_BASE64 ||
    process.env.GOOGLE_CREDENTIALS_BASE64 ||
    null;

  if (!b64) return null;

  try {
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch (e) {
    console.error('[ERROR] Failed to parse Google speech credentials from BASE64:', e.message);
    return null;
  }
}

function getSpeechClient() {
  if (speechClient) return speechClient;

  const creds = loadSpeechCredentials();
  if (creds) {
    speechClient = new SpeechClient({ credentials: creds });
    return speechClient;
  }

  // Fallback to ADC if credentials weren’t provided (useful in local dev with GOOGLE_APPLICATION_CREDENTIALS).
  try {
    speechClient = new SpeechClient();
  } catch (e) {
    console.error('[ERROR] Could not initialize Google Speech client:', e.message);
    speechClient = null;
  }
  return speechClient;
}

/**
 * Map a media MIME type to Google STT encoding + sample rate.
 */
function encodingForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('ogg')) return { encoding: 'OGG_OPUS' };          // Twilio voice notes
  if (m.includes('webm')) return { encoding: 'WEBM_OPUS' };
  if (m.includes('mpeg') || m.includes('mp3')) return { encoding: 'MP3' };
  if (m.includes('wav') || m.includes('x-wav')) return { encoding: 'LINEAR16', sampleRateHertz: 16000 };
  return { encoding: 'ENCODING_UNSPECIFIED' };
}

/**
 * Transcribe raw audio bytes directly (no transcoding).
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @returns {Promise<string|null>}
 */
async function transcribeAudio(audioBuffer, mimeType) {
  try {
    const client = getSpeechClient();
    if (!client) {
      console.error('[ERROR] Google Speech client not initialized (missing/invalid credentials).');
      return null;
    }

    const { encoding, sampleRateHertz } = encodingForMime(mimeType);
    const audio = { content: audioBuffer.toString('base64') };
    const config = {
      encoding,
      sampleRateHertz,
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: false,
      speechContexts: [{
        phrases: [
          'punch in','punch out','clock in','clock out',
          'break start','break end','lunch start','lunch end',
          'drive start','drive end','hours','timesheet','time sheet','timeclock'
        ],
        boost: 20
      }]
    };

    const [response] = await client.recognize({ audio, config });
    const transcription = (response.results || [])
      .map(r => r.alternatives?.[0]?.transcript || '')
      .filter(Boolean)
      .join(' ');
    console.log('[DEBUG] Transcription:', transcription);
    return transcription || null;
  } catch (err) {
    console.error('[ERROR] Audio transcription failed:', err);
    return null;
  }
}

module.exports = { transcribeAudio };
