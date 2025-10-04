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

/* --------- MIME → encoding map --------- */
/** For Opus (OGG/WEBM), set sampleRateHertz explicitly (Twilio is typically 48k). */
function encodingForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('ogg'))  return { encoding: 'OGG_OPUS',  sampleRateHertz: 48000 };
  if (m.includes('webm')) return { encoding: 'WEBM_OPUS', sampleRateHertz: 48000 };
  if (m.includes('mpeg') || m.includes('mp3')) return { encoding: 'MP3' };                       // let Google infer rate
  if (m.includes('wav') || m.includes('x-wav')) return { encoding: 'LINEAR16', sampleRateHertz: 16000 };
  return { encoding: 'ENCODING_UNSPECIFIED' }; // last resort
}

/* --------- First pass: Google STT --------- */
async function transcribeWithGoogle(audioBuffer, mimeType) {
  try {
    const client = getSpeechClient();
    if (!client) return null;

    const { encoding, sampleRateHertz } = encodingForMime(mimeType);
    const audio = { content: audioBuffer.toString('base64') };
    const config = {
      encoding,
      ...(sampleRateHertz ? { sampleRateHertz } : {}),
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: false,
      speechContexts: [{
        phrases: [
          'punch in','punch out','clock in','clock out',
          'break start','break end','lunch start','lunch end',
          'drive start','drive end','hours','timesheet','time sheet','timeclock',
          'Justin','Scott','Jutras' // a couple common names to bias
        ],
        boost: 20
      }]
    };

    const [response] = await client.recognize({ audio, config });
    const transcription = (response.results || [])
      .map(r => r.alternatives?.[0]?.transcript || '')
      .filter(Boolean)
      .join(' ');
    console.log('[DEBUG] Google STT transcription length:', transcription.length);
    return transcription || null;
  } catch (err) {
    console.error('[ERROR] Google STT failed:', err.message || err);
    return null;
  }
}

/* --------- Second pass: Whisper fallback --------- */
async function transcribeWithWhisper(audioBuffer, mimeType) {
  const ai = getOpenAI();
  if (!ai) return null;
  try {
    const tmpName = path.join('/tmp', `audio_${Date.now()}` + (mimeType?.includes('ogg') ? '.ogg' : '.bin'));
    fs.writeFileSync(tmpName, audioBuffer);
    const fileStream = fs.createReadStream(tmpName);

    // Prefer the lightweight transcription model name if available; fallback to whisper-1
    const model = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
    const resp = await ai.audio.transcriptions.create({
      file: fileStream,
      model,
      // language hints help a lot
      language: 'en',
      // prompt can bias decoder too (optional)
      prompt: 'time clock, timesheet, punch in, punch out, break start, break end, lunch start, lunch end, drive start, drive end, hours, Justin, Scott, Jutras'
    });

    // SDK returns { text: '...' }
    const text = (resp && (resp.text || resp?.data?.text)) || '';
    console.log('[DEBUG] Whisper transcription length:', text.length);
    try { fs.unlinkSync(tmpName); } catch {}
    return text || null;
  } catch (err) {
    console.error('[ERROR] Whisper fallback failed:', err.message || err);
    return null;
  }
}

/* --------- Unified API --------- */
async function transcribeAudio(audioBuffer, mimeType) {
  // 1) Google first
  const g = await transcribeWithGoogle(audioBuffer, mimeType);
  if (g && g.trim()) {
    console.log('[DEBUG] Transcription (Google) OK');
    return g.trim();
  }

  // 2) Whisper fallback
  const w = await transcribeWithWhisper(audioBuffer, mimeType);
  if (w && w.trim()) {
    console.log('[DEBUG] Transcription (Whisper) OK');
    return w.trim();
  }

  console.log('[DEBUG] No transcription from Google or Whisper.');
  return null;
}

module.exports = { transcribeAudio };
