// utils/transcriptionService.js
require('dotenv').config();
const { SpeechClient } = require('@google-cloud/speech').v1;

const speechClient = new SpeechClient();

/**
 * Map a media MIME type to Google STT encoding + sample rate.
 * We lean on Google's automatic rate detection unless we know better.
 */
function encodingForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('ogg')) return { encoding: 'OGG_OPUS' };      // Twilio voice notes: audio/ogg; codecs=opus
  if (m.includes('webm')) return { encoding: 'WEBM_OPUS' };    // if you ever get webm/opus
  if (m.includes('mpeg') || m.includes('mp3')) return { encoding: 'MP3' };
  if (m.includes('wav') || m.includes('x-wav')) return { encoding: 'LINEAR16', sampleRateHertz: 16000 };
  // Worst-case let Google auto-detect; works for many formats but less reliable.
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
    const [response] = await speechClient.recognize({ audio, config });
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
