// utils/transcriptionService.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { SpeechClient } = require('@google-cloud/speech').v1;
const OpenAI = require('openai');

let speechClient = null;
let openai = null;

/* --------- Credentials helpers --------- */
function loadGoogleCreds() {
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
    console.error('[ERROR] Failed to parse Google credentials BASE64:', e.message);
    return null;
  }
}

function getSpeechClient() {
  if (speechClient) return speechClient;
  const creds = loadGoogleCreds();
  try {
    speechClient = creds ? new SpeechClient({ credentials: creds }) : new SpeechClient();
  } catch (e) {
    console.error('[ERROR] Could not init Google Speech client:', e.message);
    speechClient = null;
  }
  return speechClient;
}

function getOpenAI() {
  if (openai) return openai;
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[WARN] OPENAI_API_KEY not set; Whisper fallback disabled.');
    return null;
  }
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

/* --------- MIME helpers --------- */
function pickTempExtension(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('webm')) return '.webm';
  if (m.includes('mp3') || m.includes('mpeg')) return '.mp3';
  if (m.includes('wav') || m.includes('x-wav') || m.includes('vnd.wave')) return '.wav';
  if (m.includes('m4a')) return '.m4a';
  if (m.includes('mp4')) return '.mp4';
  if (m.includes('aac')) return '.aac';
  if (m.includes('3gpp')) return '.3gp';
  if (m.includes('3gpp2')) return '.3g2';
  if (m.includes('amr')) return '.amr';
  if (m.includes('opus')) return '.opus';
  return '.bin';
}

// --- MIME → encoding map (force 48k for Opus) ---
function encodingForMime(mime) {
  const m = String(mime || '').toLowerCase();

  // Opus in container (WhatsApp voice notes)
  if (m.includes('ogg'))  return { encoding: 'OGG_OPUS',  sampleRateHertz: 48000 };
  if (m.includes('webm')) return { encoding: 'WEBM_OPUS', sampleRateHertz: 48000 };
  // Raw/unknown opus (rare)
  if (m.includes('opus')) return { encoding: 'OGG_OPUS',  sampleRateHertz: 48000 };

  // MP3 / WAV
  if (m.includes('mpeg') || m.includes('mp3')) return { encoding: 'MP3' };
  if (m.includes('wav') || m.includes('x-wav') || m.includes('vnd.wave')) {
    return { encoding: 'LINEAR16', sampleRateHertz: 16000 };
  }

  // AMR / 3GPP (Android voice)
  if (m.includes('amr-wb')) return { encoding: 'AMR_WB', sampleRateHertz: 16000 };
  if (m.includes('3gpp') || m.includes('amr-nb') || m.includes('amr')) {
    return { encoding: 'AMR', sampleRateHertz: 8000 };
  }

  // AAC in MP4/M4A containers – Google often struggles with raw AAC here.
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) {
    return { encoding: 'ENCODING_UNSPECIFIED' };
  }

  return { encoding: 'ENCODING_UNSPECIFIED' };
}

/* --------- Google STT --------- */
async function transcribeWithGoogle(audioBuffer, mimeType) {
  try {
    const client = getSpeechClient();
    if (!client) { console.error('[ERROR] Google STT client unavailable'); return null; }

    const { encoding, sampleRateHertz } = encodingForMime(mimeType);
    const audio = { content: audioBuffer.toString('base64') };
    const config = {
      encoding,
      ...(sampleRateHertz ? { sampleRateHertz } : {}),
      languageCode: 'en-US',
      alternativeLanguageCodes: ['en-CA','en-GB'],
      enableAutomaticPunctuation: true,
      ...(process.env.GOOGLE_SPEECH_USE_ENHANCED === '1' ? { useEnhanced: true } : {}),
      ...(process.env.GOOGLE_SPEECH_MODEL ? { model: process.env.GOOGLE_SPEECH_MODEL } : {}),
      speechContexts: [{
        phrases: [
          'punch in','punch out','clock in','clock out',
          'break start','break end','lunch start','lunch end',
          'drive start','drive end','hours','timesheet','time sheet','timeclock',
          'clock Justin in','clock in Justin','punch Justin in',
          'clock-in','clock-out','clock in now','clock out now','punch in now','punch out now',
          'start break','end break','Justin','Scott','Jutras'
        ],
        boost: 20
      }],
    };

    // DEFENSIVE: ensure Opus sample rate is set
    if ((config.encoding === 'OGG_OPUS' || config.encoding === 'WEBM_OPUS') && !config.sampleRateHertz) {
      config.sampleRateHertz = 48000;
    }

    console.log('[DEBUG] Google STT config:', JSON.stringify({ encoding: config.encoding, sampleRateHertz: config.sampleRateHertz }));
    const [response] = await client.recognize({ audio, config });
    const transcription = (response.results || [])
      .map(r => r.alternatives?.[0]?.transcript || '')
      .filter(Boolean)
      .join(' ');
    console.log('[DEBUG] Google STT transcription length:', transcription.length, 'text:', transcription || '(none)');
    return transcription || null;
  } catch (err) {
    console.error('[ERROR] Google STT failed:', err.message || err);
    return null;
  }
}

/* --------- Whisper STT --------- */
async function transcribeWithWhisper(audioBuffer, mimeType) {
  const ai = getOpenAI();
  if (!ai) {
    console.error('[ERROR] OpenAI client unavailable; Whisper disabled');
    return null;
  }
  let tmpName;
  let fileStream;
  try {
    const ext = pickTempExtension(mimeType);
    tmpName = path.join(process.env.TMPDIR || '/tmp', `audio_${Date.now()}${ext}`);
    fs.writeFileSync(tmpName, audioBuffer);
    fileStream = fs.createReadStream(tmpName);

    const model = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
    const resp = await ai.audio.transcriptions.create({
      file: fileStream,
      model,
      language: 'en',
      // lightweight biasing
      prompt: 'time clock, timesheet, punch in, punch out, break start, break end, lunch start, lunch end, drive start, drive end, hours, Justin, Scott, Jutras'
    });
    const text = (resp && (resp.text || resp?.data?.text)) || '';
    console.log('[DEBUG] Whisper transcription length:', text.length, 'text:', text || '(none)');
    return text || null;
  } catch (err) {
    console.error('[ERROR] Whisper fallback failed:', err.message || err);
    return null;
  } finally {
    try { if (fileStream) fileStream.close(); } catch {}
    try { if (tmpName) fs.unlinkSync(tmpName); } catch {}
  }
}

/* --------- Unified API --------- */
async function transcribeAudio(audioBuffer, mimeType, engine = 'google') {
  const m = String(mimeType || '').toLowerCase();

  // Prefer Whisper for these containers/codecs
  const mimeSuggestsWhisper = (
    m.includes('mp4') || m.includes('m4a') || m.includes('aac') ||
    m.includes('3gpp') || m.includes('amr')
  );

  // Also prefer Whisper when Google’s encoding would be unspecified
  const { encoding } = encodingForMime(mimeType);
  const encodingSuggestsWhisper = (encoding === 'ENCODING_UNSPECIFIED');

  const preferWhisper = mimeSuggestsWhisper || encodingSuggestsWhisper;

  let transcript = null;

  if (engine === 'whisper' || preferWhisper) {
    // Try Whisper first; if it fails and engine was 'both', try Google
    transcript = await transcribeWithWhisper(audioBuffer, mimeType);
    if (!transcript && engine === 'both') {
      transcript = await transcribeWithGoogle(audioBuffer, mimeType);
    }
  } else if (engine === 'google' || engine === 'both') {
    transcript = await transcribeWithGoogle(audioBuffer, mimeType);

    // If short/ambiguous, try Whisper (when engine === 'both')
    const normalized = transcript ? transcript.toLowerCase().replace(/\s+/g, ' ').replace(/\u00A0/g, ' ').trim() : '';
    const isShort = !transcript || normalized.replace(/[^\w]/g, '').length < 7;
    const isNowOnly = normalized ? /^\s*now[\s.!?\-–—]*$/i.test(normalized) : false;

    if ((engine === 'both') && (isShort || isNowOnly)) {
      console.log('[DEBUG] Retrying with Whisper due to short/ambiguous Google result');
      const whisper = await transcribeWithWhisper(audioBuffer, mimeType);
      const wn = whisper ? whisper.toLowerCase().replace(/\s+/g, ' ').replace(/\u00A0/g, ' ').trim() : '';
      if (whisper && wn.replace(/[^\w]/g, '').length > normalized.replace(/[^\w]/g, '').length) {
        transcript = whisper;
      }
    }
  } else {
    throw new Error('Unsupported STT engine');
  }

  if (transcript && transcript.trim()) {
    transcript = transcript.replace(/\s+/g, ' ').replace(/\u00A0/g, ' ').trim();
    console.log('[DEBUG] Final transcription OK:', transcript);
    return transcript;
  }
  console.log('[DEBUG] No transcription produced');
  return null;
}

module.exports = { transcribeAudio };
