// utils/transcriptionService.js
// Drop-in: quieter logs + fail-open to Whisper when Google STT isn't available,
// and now includes ✅ monthly quota gating BEFORE paid STT calls.

let dotenvLoaded = false;
try {
  require('dotenv').config();
  dotenvLoaded = true;
} catch {}

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const { checkMonthlyQuota, consumeMonthlyQuota } = require('./quota');

let speechClient = null;
let openai = null;
let SpeechClientCtor = null;
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
    logOnce(
      'warn',
      'google_creds_parse_failed',
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

function normalizeContentType(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

function encodingForMime(mimeType) {
  const m = normalizeContentType(mimeType);
  if (m.includes('ogg')) return { encoding: 'OGG_OPUS', sampleRateHertz: 48000 };
  if (m.includes('webm')) return { encoding: 'WEBM_OPUS', sampleRateHertz: 48000 };
  if (m.includes('opus')) return { encoding: 'OGG_OPUS', sampleRateHertz: 48000 };
  if (m.includes('mpeg') || m.includes('mp3')) return { encoding: 'MP3' };
  if (m.includes('wav') || m.includes('x-wav') || m.includes('vnd.wave'))
    return { encoding: 'LINEAR16', sampleRateHertz: 16000 };
  if (m.includes('amr-wb')) return { encoding: 'AMR_WB', sampleRateHertz: 16000 };
  if (m.includes('3gpp') || m.includes('amr-nb') || m.includes('amr'))
    return { encoding: 'AMR', sampleRateHertz: 8000 };
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return { encoding: 'ENCODING_UNSPECIFIED' };
  return { encoding: 'ENCODING_UNSPECIFIED' };
}

/* --------- text normalization --------- */
function normalizeTranscript(t) {
  if (!t) return '';
  return String(t).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function alnumLen(s) {
  const t = normalizeTranscript(s).replace(/[^\w]/g, '');
  return t.length;
}

/* --------- Quota gate (NEW) --------- */
async function gateSttOrReturnNull(opts = {}) {
  const ownerId = String(opts.ownerId || '').trim();
  const planKey = String(opts.planKey || '').trim().toLowerCase() || 'free';
  const units = Number(opts.units ?? 1);

  // If no ownerId, fail closed (don’t spend money)
  if (!ownerId) return { ok: false };

  const u = Number.isFinite(units) && units > 0 ? units : 1;
  const q = await checkMonthlyQuota({ ownerId, planKey, kind: 'stt', units: u });
  if (!q.ok) return { ok: false };

  // Consume BEFORE paid call
  await consumeMonthlyQuota({ ownerId, kind: 'stt', units: u });
  return { ok: true };
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
      ...(process.env.GOOGLE_SPEECH_MODEL ? { model: process.env.GOOGLE_SPEECH_MODEL } : {})
    };

    const [response] = await client.recognize({ audio, config });

    const parts = (response.results || [])
      .map((r) => ({
        text: r.alternatives?.[0]?.transcript || '',
        confidence: typeof r.alternatives?.[0]?.confidence === 'number' ? r.alternatives[0].confidence : null
      }))
      .filter((x) => x.text);

    const transcription = normalizeTranscript(parts.map((p) => p.text).join(' '));
    const confidence = parts.length ? (parts[0].confidence ?? null) : null;

    if (!transcription) return null;
    return { transcript: transcription, confidence };
  } catch (err) {
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
        'time clock, timesheet, punch in, punch out, break start, break end, lunch start, lunch end, drive start, drive end, hours, received, payment, deposit, revenue, expense, invoice, job'
    });

    const text = normalizeTranscript((resp && (resp.text || resp?.data?.text)) || '');
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
async function transcribeAudio(audioBuffer, mimeType, engine = 'google', opts = {}) {
  const m = normalizeContentType(mimeType);

  const mimeSuggestsWhisper =
    m.includes('mp4') || m.includes('m4a') || m.includes('aac') ||
    m.includes('3gpp') || m.includes('amr');

  const { encoding } = encodingForMime(mimeType);
  const preferWhisper = mimeSuggestsWhisper || (encoding === 'ENCODING_UNSPECIFIED');

  const wantObj = String(process.env.RETURN_TRANSCRIPTION_OBJECT || '').trim() === '1';

  function finish(t, c, eng) {
    const text = normalizeTranscript(t);
    if (!text) return null;
    if (wantObj) return { transcript: text, confidence: (Number.isFinite(Number(c)) ? Number(c) : null), engine: eng || 'unknown' };
    return text;
  }

  // ✅ Quota gate BEFORE any paid STT call
  try {
    const g = await gateSttOrReturnNull(opts);
    if (!g.ok) return null;
  } catch (e) {
    // fail closed: don’t spend money if gate is uncertain
    logOnce('warn', 'stt_gate_failed', '[WARN] STT quota gate failed; denying STT safely. Details:', e?.message);
    return null;
  }

  // If caller forces whisper
  if (engine === 'whisper') {
    const w = await transcribeWithWhisper(audioBuffer, mimeType);
    return finish(w, null, 'whisper');
  }

  // If caller forces google
  if (engine === 'google') {
    const g = await transcribeWithGoogle(audioBuffer, mimeType);
    if (g && g.transcript) return finish(g.transcript, g.confidence, 'google');
    return null;
  }

  // engine === 'both'
  if (preferWhisper) {
    const w = await transcribeWithWhisper(audioBuffer, mimeType);
    if (w) return finish(w, null, 'whisper');

    const g = await transcribeWithGoogle(audioBuffer, mimeType);
    if (g && g.transcript) return finish(g.transcript, g.confidence, 'google');
    return null;
  }

  const g = await transcribeWithGoogle(audioBuffer, mimeType);
  if (g && g.transcript) {
    const gText = normalizeTranscript(g.transcript);
    const isShort = alnumLen(gText) < 7;
    const isNowOnly = /^\s*now[\s.!?\-–—]*$/i.test(gText || '');

    if (!isShort && !isNowOnly) return finish(gText, g.confidence, 'google');

    const w = await transcribeWithWhisper(audioBuffer, mimeType);
    const wText = normalizeTranscript(w);

    if (wText && alnumLen(wText) > alnumLen(gText)) return finish(wText, null, 'whisper');
    return finish(gText, g.confidence, 'google');
  }

  const w = await transcribeWithWhisper(audioBuffer, mimeType);
  if (w) return finish(w, null, 'whisper');

  return null;
}

async function transcribe(audioBuffer, mimeType, engine = 'google', opts = {}) {
  return transcribeAudio(audioBuffer, mimeType, engine, opts);
}

module.exports = {
  transcribeAudio,
  transcribe,
  _encodingForMime: encodingForMime,
  _normalizeContentType: normalizeContentType,
  _normalizeTranscript: normalizeTranscript
};
