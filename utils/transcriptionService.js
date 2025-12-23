// utils/transcriptionService.js
// Drop-in: quieter logs + fail-open to Whisper when Google STT isn't available,
// and (optionally) returns { transcript, confidence, engine } when requested.
//
// Key changes vs your version:
// - Missing @google-cloud/speech is now a WARN (logged once), not an ERROR spam.
// - If Google STT client/module isn't available, we silently fall back to Whisper (when engine='both').
// - Google confidence is captured when available (alternatives[0].confidence).
// - More defensive normalization + less noisy logging in production.

let dotenvLoaded = false;
try {
  // In serverless, dotenv is usually unnecessary; keep it but don't hard-fail.
  require('dotenv').config();
  dotenvLoaded = true;
} catch {
  // ignore
}

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

let speechClient = null;
let openai = null;
let SpeechClientCtor = null; // Lazy-loaded constructor
let GOOGLE_SPEECH_IMPORT_FAILED = false;
let GOOGLE_SPEECH_INIT_FAILED = false;

// log-once helpers (avoid Vercel spam)
const __logged = new Set();
function logOnce(level, key, ...args) {
  if (__logged.has(key)) return;
  __logged.add(key);
  // eslint-disable-next-line no-console
  console[level](...args);
}

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
    logOnce('warn', 'google_creds_parse_failed',
      '[WARN] Failed to parse Google credentials BASE64 (voice will fallback to Whisper):',
      e?.message
    );
    return null;
  }
}

function getSpeechClient() {
  if (speechClient) return speechClient;
  if (GOOGLE_SPEECH_IMPORT_FAILED || GOOGLE_SPEECH_INIT_FAILED) return null;

  if (!SpeechClientCtor) {
    try {
      // Lazy import (important for serverless bundles)
      const speech = require('@google-cloud/speech');
      SpeechClientCtor = (speech.v1 && speech.v1.SpeechClient) || speech.SpeechClient || null;
      if (!SpeechClientCtor) {
        GOOGLE_SPEECH_IMPORT_FAILED = true;
        logOnce(
          'warn',
          'google_speech_ctor_missing',
          '[WARN] @google-cloud/speech loaded but SpeechClient constructor not found; falling back to Whisper.'
        );
        return null;
      }
    } catch (e) {
      GOOGLE_SPEECH_IMPORT_FAILED = true;
      logOnce(
        'warn',
        'google_speech_module_missing',
        '[WARN] @google-cloud/speech not available; falling back to Whisper. Details:',
        e?.message
      );
      return null;
    }
  }

  const creds = loadGoogleCreds();
  try {
    speechClient = creds ? new SpeechClientCtor({ credentials: creds }) : new SpeechClientCtor();
    return speechClient;
  } catch (e) {
    GOOGLE_SPEECH_INIT_FAILED = true;
    logOnce(
      'warn',
      'google_speech_init_failed',
      '[WARN] Could not init Google Speech client; falling back to Whisper. Details:',
      e?.message
    );
    speechClient = null;
    return null;
  }
}

function getOpenAI() {
  if (openai) return openai;
  if (!process.env.OPENAI_API_KEY) {
    logOnce('warn', 'openai_key_missing', '[WARN] OPENAI_API_KEY not set; Whisper disabled.');
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

// Normalize media content-type (strip params like "; codecs=opus")
function normalizeContentType(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

// --- MIME → encoding map (force 48k for Opus) ---
function encodingForMime(mimeType) {
  const m = normalizeContentType(mimeType);

  // Opus in container (WhatsApp voice notes)
  if (m.includes('ogg')) return { encoding: 'OGG_OPUS', sampleRateHertz: 48000 };
  if (m.includes('webm')) return { encoding: 'WEBM_OPUS', sampleRateHertz: 48000 };
  if (m.includes('opus')) return { encoding: 'OGG_OPUS', sampleRateHertz: 48000 };

  // MP3 / WAV
  if (m.includes('mpeg') || m.includes('mp3')) return { encoding: 'MP3' };
  if (m.includes('wav') || m.includes('x-wav') || m.includes('vnd.wave')) {
    return { encoding: 'LINEAR16', sampleRateHertz: 16000 };
  }

  // AMR / 3GPP
  if (m.includes('amr-wb')) return { encoding: 'AMR_WB', sampleRateHertz: 16000 };
  if (m.includes('3gpp') || m.includes('amr-nb') || m.includes('amr')) {
    return { encoding: 'AMR', sampleRateHertz: 8000 };
  }

  // AAC in MP4/M4A containers – Google often struggles here.
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) {
    return { encoding: 'ENCODING_UNSPECIFIED' };
  }

  return { encoding: 'ENCODING_UNSPECIFIED' };
}

/* --------- text normalization --------- */
function normalizeTranscript(t) {
  if (!t) return '';
  return String(t)
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function alnumLen(s) {
  const t = normalizeTranscript(s).replace(/[^\w]/g, '');
  return t.length;
}

/* --------- Google STT --------- */
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
      alternativeLanguageCodes: ['en-CA', 'en-GB'],
      enableAutomaticPunctuation: true,
      ...(process.env.GOOGLE_SPEECH_USE_ENHANCED === '1' ? { useEnhanced: true } : {}),
      ...(process.env.GOOGLE_SPEECH_MODEL ? { model: process.env.GOOGLE_SPEECH_MODEL } : {}),
      speechContexts: [{
        phrases: [
          'punch in', 'punch out', 'clock in', 'clock out',
          'break start', 'break end', 'lunch start', 'lunch end',
          'drive start', 'drive end', 'hours', 'timesheet', 'time sheet', 'timeclock',
          'clock Justin in', 'clock in Justin', 'punch Justin in',
          'clock-in', 'clock-out', 'clock in now', 'clock out now', 'punch in now', 'punch out now',
          'start break', 'end break', 'Justin', 'Scott', 'Jutras',
          // contractor finance words help too:
          'received', 'payment', 'deposit', 'revenue', 'expense', 'invoice', 'job'
        ],
        boost: 20
      }],
    };

    if ((config.encoding === 'OGG_OPUS' || config.encoding === 'WEBM_OPUS') && !config.sampleRateHertz) {
      config.sampleRateHertz = 48000;
    }

    if (process.env.LOG_STT_DEBUG === '1') {
      console.log('[DEBUG] Google STT config:', JSON.stringify({
        encoding: config.encoding,
        sampleRateHertz: config.sampleRateHertz
      }));
    }

    const [response] = await client.recognize({ audio, config });

    const parts = (response.results || [])
      .map(r => ({
        text: r.alternatives?.[0]?.transcript || '',
        confidence: typeof r.alternatives?.[0]?.confidence === 'number' ? r.alternatives[0].confidence : null
      }))
      .filter(x => x.text);

    const transcription = normalizeTranscript(parts.map(p => p.text).join(' '));
    const confidence = parts.length ? (parts[0].confidence ?? null) : null;

    if (process.env.LOG_STT_DEBUG === '1') {
      console.log('[DEBUG] Google STT transcription length:', transcription.length, 'text:', transcription || '(none)');
    }

    if (!transcription) return null;
    return { transcript: transcription, confidence };
  } catch (err) {
    // Don’t scream ERROR here; google may be optional and we have Whisper.
    logOnce('warn', 'google_stt_failed_once', '[WARN] Google STT failed; will fallback when possible. Details:', err?.message || err);
    return null;
  }
}

/* --------- Whisper STT --------- */
async function transcribeWithWhisper(audioBuffer, mimeType) {
  const ai = getOpenAI();
  if (!ai) return null;

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
      prompt:
        'time clock, timesheet, punch in, punch out, break start, break end, lunch start, lunch end, drive start, drive end, hours, received, payment, deposit, revenue, expense, invoice, job, Justin, Scott, Jutras'
    });

    const text = normalizeTranscript((resp && (resp.text || resp?.data?.text)) || '');

    if (process.env.LOG_STT_DEBUG === '1') {
      console.log('[DEBUG] Whisper transcription length:', text.length, 'text:', text || '(none)');
    }

    return text || null;
  } catch (err) {
    logOnce('warn', 'whisper_failed_once', '[WARN] Whisper transcription failed. Details:', err?.message || err);
    return null;
  } finally {
    try { if (fileStream) fileStream.close(); } catch {}
    try { if (tmpName) fs.unlinkSync(tmpName); } catch {}
  }
}

/* --------- Unified API --------- */
/**
 * Transcribe audio.
 *
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @param {'google'|'whisper'|'both'} engine
 * @returns {Promise<string|{transcript:string,confidence:number|null,engine:string}|null>}
 *
 * NOTE: Backward compatibility:
 * - Default returns a STRING transcript.
 * - If RETURN_TRANSCRIPTION_OBJECT=1, returns object with transcript/confidence/engine.
 */
async function transcribeAudio(audioBuffer, mimeType, engine = 'google') {
  const m = normalizeContentType(mimeType);

  // Prefer Whisper for these containers/codecs (Google often struggles)
  const mimeSuggestsWhisper =
    m.includes('mp4') || m.includes('m4a') || m.includes('aac') ||
    m.includes('3gpp') || m.includes('amr');

  // Also prefer Whisper when Google’s encoding would be unspecified
  const { encoding } = encodingForMime(mimeType);
  const encodingSuggestsWhisper = (encoding === 'ENCODING_UNSPECIFIED');

  const preferWhisper = mimeSuggestsWhisper || encodingSuggestsWhisper;

  let transcript = null;
  let confidence = null;
  let usedEngine = null;

  const wantObj = String(process.env.RETURN_TRANSCRIPTION_OBJECT || '').trim() === '1';

  // Helper to format return consistently
  function finish(t, c, eng) {
    const text = normalizeTranscript(t);
    if (!text) return null;
    if (wantObj) return { transcript: text, confidence: (Number.isFinite(Number(c)) ? Number(c) : null), engine: eng || 'unknown' };
    return text;
  }

  // If caller forces whisper
  if (engine === 'whisper') {
    usedEngine = 'whisper';
    transcript = await transcribeWithWhisper(audioBuffer, mimeType);
    return finish(transcript, null, usedEngine);
  }

  // If caller forces google
  if (engine === 'google') {
    usedEngine = 'google';
    const g = await transcribeWithGoogle(audioBuffer, mimeType);
    if (g && g.transcript) return finish(g.transcript, g.confidence, usedEngine);
    return null;
  }

  // engine === 'both'
  if (preferWhisper) {
    // Try Whisper first (better for tricky formats)
    const w = await transcribeWithWhisper(audioBuffer, mimeType);
    if (w) return finish(w, null, 'whisper');

    // Whisper failed, try Google (if available)
    const g = await transcribeWithGoogle(audioBuffer, mimeType);
    if (g && g.transcript) return finish(g.transcript, g.confidence, 'google');
    return null;
  }

  // Default: try Google first, then Whisper if Google is unavailable or short/ambiguous
  const g = await transcribeWithGoogle(audioBuffer, mimeType);
  if (g && g.transcript) {
    const gText = normalizeTranscript(g.transcript);
    const isShort = alnumLen(gText) < 7;
    const isNowOnly = /^\s*now[\s.!?\-–—]*$/i.test(gText || '');

    if (process.env.LOG_STT_DEBUG === '1') {
      console.log('[DEBUG] Google result check', { len: gText.length, alnumLen: alnumLen(gText), isShort, isNowOnly });
    }

    if (!isShort && !isNowOnly) {
      return finish(gText, g.confidence, 'google');
    }

    // short/ambiguous => try Whisper and pick better
    const w = await transcribeWithWhisper(audioBuffer, mimeType);
    const wText = normalizeTranscript(w);

    if (wText && alnumLen(wText) > alnumLen(gText)) {
      if (process.env.LOG_STT_DEBUG === '1') {
        console.log('[DEBUG] Retrying with Whisper due to short/ambiguous Google result');
      }
      return finish(wText, null, 'whisper');
    }

    return finish(gText, g.confidence, 'google');
  }

  // Google unavailable/failed => try Whisper
  const w = await transcribeWithWhisper(audioBuffer, mimeType);
  if (w) return finish(w, null, 'whisper');

  return null;
}

/**
 * Back-compat alias. Some files might import { transcribe } instead of { transcribeAudio }.
 */
async function transcribe(audioBuffer, mimeType, engine = 'google') {
  return transcribeAudio(audioBuffer, mimeType, engine);
}

module.exports = {
  transcribeAudio,
  transcribe, // alias
  // exported for tests/debugging
  _encodingForMime: encodingForMime,
  _normalizeContentType: normalizeContentType,
  _normalizeTranscript: normalizeTranscript,
};
