// utils/transcriptionService.js
require('dotenv').config();
const { SpeechClient } = require('@google-cloud/speech').v1;

let speechClient = null;

function loadSpeechCredentials() {
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
  try {
    speechClient = creds ? new SpeechClient({ credentials: creds }) : new SpeechClient();
  } catch (e) {
    console.error('[ERROR] Could not initialize Google Speech client:', e.message);
    speechClient = null;
  }
  return speechClient;
}

/**
 * Map a media MIME type to Google STT encoding + sample rate.
 * IMPORTANT: For Opus (OGG/WEBM), set sampleRateHertz explicitly (Twilio is typically 48000).
 */
function encodingForMime(mime) {
  const m = String(mime || '').toLowerCase();

  // Twilio voice notes are usually audio/ogg;codecs=opus at 48kHz
  if (m.includes('ogg'))  return { encoding: 'OGG_OPUS',  sampleRateHertz: 48000 };
  if (m.includes('webm')) return { encoding: 'WEBM_OPUS', sampleRateHertz: 48000 };

  if (m.includes('mpeg') || m.includes('mp3')) return { encoding: 'MP3' }; // sample rate auto-detected
  if (m.includes('wav') || m.includes('x-wav')) return { encoding: 'LINEAR16', sampleRateHertz: 16000 };
  return { encoding: 'ENCODING_UNSPECIFIED' }; // last resort
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
      // Only set sampleRateHertz if we have a value; otherwise let Google infer.
      ...(sampleRateHertz ? { sampleRateHertz } : {}),
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
