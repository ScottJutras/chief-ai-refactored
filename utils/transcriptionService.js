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

// --- MIME → encoding map (force 48k for Opus) ---
function encodingForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('ogg'))  return { encoding: 'OGG_OPUS',  sampleRateHertz: 48000 };
  if (m.includes('webm')) return { encoding: 'WEBM_OPUS', sampleRateHertz: 48000 };
  if (m.includes('mpeg') || m.includes('mp3')) return { encoding: 'MP3' };
  if (m.includes('wav') || m.includes('x-wav')) return { encoding: 'LINEAR16', sampleRateHertz: 16000 };
  return { encoding: 'ENCODING_UNSPECIFIED' };
}

// --- Google STT ---
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
    const transcription = (response.results || []).map(r => r.alternatives?.[0]?.transcript || '').filter(Boolean).join(' ');
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
    tmpName = path.join(process.env.TMPDIR || '/tmp', `audio_${Date.now()}` + (mimeType?.includes('ogg') ? '.ogg' : '.bin'));
    fs.writeFileSync(tmpName, audioBuffer);
    fileStream = fs.createReadStream(tmpName);
    const model = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
    const resp = await ai.audio.transcriptions.create({
      file: fileStream,
      model,
      language: 'en',
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
  let transcript = null;
  if (engine === 'google' || engine === 'both') {
    transcript = await transcribeWithGoogle(audioBuffer, mimeType);
    const normalized = transcript ? transcript.toLowerCase().replace(/\s+/g, ' ').replace(/\u00A0/g, ' ').trim() : '';
    const isShort = !transcript || normalized.replace(/[^\w]/g, '').length < 7;
    const isNowOnly = normalized ? /^\s*now[\s.!?\-–—]*$/i.test(normalized) : false;
    console.log('[DEBUG] Google STT evaluation: isShort=', isShort, 'isNowOnly=', isNowOnly, 'normalized=', normalized);
    if (engine === 'both' && (isShort || isNowOnly)) {
      console.log('[DEBUG] Retrying with Whisper due to short/ambiguous Google result');
      const whisper = await transcribeWithWhisper(audioBuffer, mimeType);
      const whisperNormalized = whisper ? whisper.toLowerCase().replace(/\s+/g, ' ').replace(/\u00A0/g, ' ').trim() : '';
      console.log('[DEBUG] Whisper normalized:', whisperNormalized);
      if (whisper && (!transcript || whisperNormalized.replace(/[^\w]/g, '').length > normalized.replace(/[^\w]/g, '').length)) {
        transcript = whisper;
      }
    }
  } else if (engine === 'whisper') {
    transcript = await transcribeWithWhisper(audioBuffer, mimeType);
  } else {
    console.error('[ERROR] Unsupported STT engine:', engine);
    throw new Error('Unsupported STT engine');
  }

  if (transcript && transcript.trim()) {
    // Normalize spaces and odd punctuation
    transcript = transcript.replace(/\s+/g, ' ').replace(/\u00A0/g, ' ').trim();
    console.log(`[DEBUG] Final transcription (${engine === 'both' ? 'final' : engine}) OK:`, transcript);
    return transcript;
  }
  console.log('[DEBUG] No transcription from', engine);
  return null;
}

module.exports = { transcribeAudio };