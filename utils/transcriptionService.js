const { createFFmpeg } = require('@ffmpeg/ffmpeg');
     const { SpeechClient } = require('@google-cloud/speech').v1;
     const OpenAI = require('openai');

     const ffmpeg = createFFmpeg({ log: true });
     const client = new SpeechClient();
     const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

     async function transcribeAudio(audioBuffer) {
       try {
         if (!ffmpeg.isLoaded()) await ffmpeg.load();
         console.log("[DEBUG] Converting OGG_OPUS to WAV...");
         const inputPath = '/tmp/input.ogg';
         const outputPath = '/tmp/output.wav';
         await ffmpeg.FS('writeFile', inputPath, audioBuffer);
         await ffmpeg.run('-i', inputPath, '-acodec', 'pcm_s16le', '-ar', '16000', outputPath);
         const output = await ffmpeg.FS('readFile', outputPath);
         console.log("[DEBUG] Audio conversion complete.");

         const audio = { content: output.toString('base64') };
         const config = {
           encoding: 'LINEAR16',
           sampleRateHertz: 16000,
           languageCode: 'en-US',
           enableAutomaticPunctuation: true,
           enableWordTimeOffsets: true,
           speechContexts: [{
             phrases: [
               'punch in', 'punch out', 'break start', 'break end', 'lunch start', 'lunch end',
               'drive start', 'drive end', 'hours', 'timeclock', 'timesheet',
               'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
               'am', 'pm'
             ],
             boost: 20
           }]
         };
         const request = { audio, config };
         const [response] = await client.recognize(request);
         const transcription = response.results.map(result => result.alternatives[0].transcript).join('\n');
         console.log(`[DEBUG] Transcription: ${transcription}`);
         return transcription || null;
       } catch (error) {
         console.error("[ERROR] Audio transcription failed:", error.message);
         return null;
       }
     }

     async function inferMissingData(text) {
       try {
         console.log("[DEBUG] Using GPT to infer missing data...");
         const response = await openaiClient.chat.completions.create({
           model: "gpt-3.5-turbo",
           messages: [
             { role: "system", content: "Extract employee names, timeclock actions (punch in/out, break start/end, lunch start/end, drive start/end), and timestamps from this transcribed text. Return JSON: { employeeName: string|null, type: string|null, timestamp: string|null }." },
             { role: "user", content: `Transcription: "${text}"` }
           ],
           max_tokens: 50
         });
         return JSON.parse(response.choices[0].message.content.trim());
       } catch (error) {
         console.error("[ERROR] GPT inference failed:", error.message);
         return null;
       }
     }

     module.exports = { transcribeAudio, inferMissingData };