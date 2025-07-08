// utils/transcriptionService.js
require('dotenv').config();
const { SpeechClient } = require('@google-cloud/speech').v1;
const OpenAI = require('openai');

let ffmpeg;           // will hold the loaded FFmpeg instance
let ffmpegLoaded = false;

/**
 * Lazily load the ESM‐only @ffmpeg/ffmpeg module via dynamic import()
 */
async function initFFmpeg() {
  if (ffmpegLoaded) return ffmpeg;
  const { createFFmpeg, fetchFile } = await import('@ffmpeg/ffmpeg');
  ffmpeg = createFFmpeg({ log: true });
  // writeFile/readFile helpers need fetchFile
  ffmpeg.fetchFile = fetchFile;
  await ffmpeg.load();
  ffmpegLoaded = true;
  return ffmpeg;
}

const speechClient = new SpeechClient();
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Transcode an OGG_OPUS buffer to WAV and run Google Speech-to-Text on it.
 */
async function transcribeAudio(audioBuffer) {
  try {
    const ff = await initFFmpeg();
    console.log('[DEBUG] Converting OGG_OPUS to WAV…');
    // write the incoming buffer into FFmpeg FS
    ff.FS('writeFile', 'input.ogg', audioBuffer);
    // convert to 16k WAV
    await ff.run(
      '-i', 'input.ogg',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      'output.wav'
    );
    const output = ff.FS('readFile', 'output.wav');
    console.log('[DEBUG] Audio conversion complete.');

    // call Google STT
    const audio = { content: output.toString('base64') };
    const config = {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
      speechContexts: [{
        phrases: [
          'punch in','punch out','break start','break end',
          'lunch start','lunch end','drive start','drive end',
          'hours','timeclock','timesheet'
        ],
        boost: 20
      }]
    };
    const [response] = await speechClient.recognize({ audio, config });
    const transcription = response.results
      .map(r => r.alternatives[0]?.transcript)
      .filter(Boolean)
      .join('\n');
    console.log(`[DEBUG] Transcription: ${transcription}`);
    return transcription || null;
  } catch (err) {
    console.error('[ERROR] Audio transcription failed:', err);
    return null;
  }
}

/**
 * Ask GPT to extract employee/timeclock semantics from the text.
 */
async function inferMissingData(text) {
  try {
    console.log('[DEBUG] Using GPT to infer missing data…');
    const res = await openaiClient.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'Extract employee names, timeclock actions (punch in/out, break start/end, lunch start/end, drive start/end), and timestamps from this text. Return JSON: { employeeName: string|null, type: string|null, timestamp: string|null }.'
        },
        { role: 'user', content: `Transcription: "${text}"` }
      ],
      max_tokens: 50,
      temperature: 0
    });
    return JSON.parse(res.choices[0].message.content.trim());
  } catch (err) {
    console.error('[ERROR] GPT inference failed:', err);
    return null;
  }
}

module.exports = { transcribeAudio, inferMissingData };
