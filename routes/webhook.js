// routes/webhook.js
// Serverless-safe WhatsApp webhook router for Vercel + Express (conversational + memory)
const express = require('express');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Handlers / services
const commands = require('../handlers/commands');
const { tasksHandler } = require('../handlers/commands/tasks');
const { handleMedia } = require('../handlers/media');
const { handleOnboarding } = require('../handlers/onboarding');
const { handleTimeclock } = require('../handlers/commands/timeclock');
const { handleOwnerApproval } = require('../handlers/commands/owner_approval');

// Middleware
const { lockMiddleware, releaseLock } = require('../middleware/lock');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { tokenMiddleware } = require('../middleware/token');
const { errorMiddleware } = require('../middleware/error');

// Services
const { query } = require('../services/postgres');
const { sendMessage, sendTemplateMessage } = require('../services/twilio');
const { parseUpload } = require('../services/deepDive');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../utils/stateManager');

// AI routers
const { routeWithAI } = require('../nlp/intentRouter'); // tool-calls (strict)
const { converseAndRoute } = require('../nlp/conversation');

// NLP task helpers
const { looksLikeTask, parseTaskUtterance } = require('../nlp/task_intents');

// Memory
const { logEvent, getConvoState, saveConvoState, getMemory, upsertMemory } = require('../services/memory');

// DB helpers
const { getPendingPrompt, logTimeEntry, getActiveJob, appendToUserSpreadsheet, generateTimesheet } = require('../services/postgres');

const router = express.Router();

// ----------------- helpers -----------------
function maskPhone(p) {
  return p ? String(p).replace(/^(\d{4})\d+(\d{2})$/, '$1…$2') : '';
}

function ensureReply(res, text) {
  if (!res.headersSent) {
    res.status(200).type('text/xml').send(`<Response><Message>${text}</Message></Response>`);
  }
}

function twiml(text) { return `<Response><Message>${text}</Message></Response>`; }

function getUserTz(userProfile) {
  return userProfile?.timezone || userProfile?.tz || userProfile?.time_zone || 'America/Toronto';
}

function friendlyTypeLabel(type) {
  if (!type) return 'entry';
  if (type === 'time_entry') return 'time entry';
  if (type === 'hours_inquiry') return 'hours inquiry';
  return String(type).replace('_', ' ');
}

function isTimeclockMessage(s = '') {
  const lc = String(s).toLowerCase();
  if (/\b(?:clock|punch)(?:ed)?\s*(?:in|out)\b/.test(lc)) return true;
  if (/\bclock-?in\b/.test(lc)) return true;
  if (/\bclock-?out\b/.test(lc)) return true;
  if (/\bclockin\b/.test(lc)) return true;
  if (/\bclockout\b/.test(lc)) return true;
  if (/\bstart\s+(?:shift|work)\b/.test(lc)) return true;
  if (/\bend\s+(?:shift|work)\b/.test(lc)) return true;
  if (/\b(break|lunch|drive|hours?)\b/.test(lc)) return true;
  return false;
}

function normalizeTimeclockInput(input, userProfile) {
  const original = String(input || '');
  let s = original.trim();

  const findTime = (text) => {
    let m = text.match(/\b(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\b/i);
    if (m) return { t: `${parseInt(m[1],10)}:${m[2]} ${m[3].toLowerCase()==='a'?'am':'pm'}`, rest: text.replace(m[0],'').trim() };
    m = text.match(/\b(\d{1,2})(\d{2})\s*([ap])\.?m\.?\b/i);
    if (m) return { t: `${parseInt(m[1],10)}:${m[2]} ${m[3].toLowerCase()==='a'?'am':'pm'}`, rest: text.replace(m[0],'').trim() };
    m = text.match(/\b(\d{1,2})\s*([ap])\.?m\.?\b/i);
    if (m) return { t: `${parseInt(m[1],10)}:00 ${m[2].toLowerCase()==='a'?'am':'pm'}`, rest: text.replace(m[0],'').trim() };
    return { t: null, rest: text };
  };

  s = s.replace(/\bclock(?:ed)?\s*in\b/gi, 'punched in')
       .replace(/\bclock(?:ed)?\s*out\b/gi, 'punched out')
       .replace(/\b(punch\s*in)\b/gi, 'punched in')
       .replace(/\b(punch\s*out)\b/gi, 'punched out');

  const timeHit = findTime(s);
  const timeStr = timeHit.t;
  s = timeHit.rest;

  let m = s.match(/^\s*([a-z][\w\s.'-]{1,50}?)\s+punched\s+(in|out)\b/i);
  if (m) return `${m[1].trim()} punched ${m[2].toLowerCase()}${timeStr ? ` at ${timeStr}` : ''}`.trim();

  m = s.match(/\bpunched\s+(in|out)\s+([a-z][\w\s.'-]{1,50}?)(?=\s|$|[,.!?]|(?:\s+at\b))/i);
  if (m) return `${m[2].trim()} punched ${m[1].toLowerCase()}${timeStr ? ` at ${timeStr}` : ''}`.trim();

  m = s.match(/\bpunched\s+(in|out)\b/i);
  if (m) {
    const who = (userProfile && userProfile.name) ? userProfile.name : '';
    return `${who ? who + ' ' : ''}punched ${m[1].toLowerCase()}${timeStr ? ` at ${timeStr}` : ''}`.trim();
  }
  return timeStr ? `${s} at ${timeStr}`.trim() : original;
}

function getHandler(key) {
  if (key === 'tasks') {
    return (typeof commands.tasks === 'function') ? commands.tasks
         : (typeof tasksHandler === 'function') ? tasksHandler
         : null;
  }
  return (typeof commands[key] === 'function') ? commands[key] : null;
}

async function dispatchCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const order = ['tasks', 'job', 'timeclock', 'expense', 'revenue', 'bill', 'quote', 'metrics', 'tax', 'receipt', 'team'];
  for (const key of order) {
    if (key === 'timeclock' && !isTimeclockMessage(input)) continue;

    const fn = getHandler(key);
    if (typeof fn !== 'function') continue;

    const out = await fn(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    if (res.headersSent) return true;

    if (typeof out === 'string' && out.trim().startsWith('<Response>')) {
      res.status(200).type('text/xml').send(out); return true;
    }
    if (out && typeof out === 'object' && typeof out.twiml === 'string') {
      res.status(200).type('text/xml').send(out.twiml); return true;
    }
    if (out === true) { ensureReply(res, ''); return true; }
  }
  return false;
}

async function createReminder({ ownerId, userId, taskNo, taskTitle, remindAt }) {
  await query(
    `insert into reminders (owner_id, user_id, task_no, title, remind_at, status, created_at)
     values ($1, $2, $3, $4, $5::timestamptz, 'pending', now())`,
    [ownerId, userId, taskNo, taskTitle || null, remindAt]
  );
}
/* ---------- Normalization helpers (top-level!) ---------- */

// Strips hidden bidi/formatting chars that often sneak in before '+'
function stripInvisible(s = '') {
  return String(s).replace(/[\u200E\u200F\u202A-\u202E]/g, '');
}

function cleanSpokenCommand(s = '') {
  let t = stripInvisible(String(s || ''));

  // Normalize exotic commas (，、) to ','
  t = t.replace(/[，、]/g, ',');

  // Strip common speech fillers
  t = t.replace(/\b(?:uh|um|erm|like|you know)\b/gi, '');

  // Normalize the "task" cue: "task,|:|-—  foo" → "task foo"
  t = t.replace(/(^|\s)task\s*[,:-–—]?\s*/i, '$1task ');

  // Remove stray punctuation except a safe set we allow inside titles
  t = t
    .replace(/[^\w@#:/&'’\-\s,\.]/g, '')   // drop odd symbols
    .replace(/\s*\.\s*$/g, '')             // strip final period
    .replace(/\s*,\s*/g, ' ')              // commas → spaces
    .replace(/\s{2,}/g, ' ')               // collapse spaces
    .trim();

  return t;
}

function normalizeTimePhrase(s = '') {
  let t = String(s);

  // Insert space after "in" when it's glued to a number: "in2" → "in 2"
  t = t.replace(/\bin\s*(\d+)/gi, 'in $1');

  // Ensure a space between number and unit: "2mins" → "2 mins", "2m" → "2 m"
  t = t.replace(/\b(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/gi, (m, n, u) => {
    const map = { m:'minutes', min:'minutes', mins:'minutes', minute:'minutes', minutes:'minutes',
                  h:'hours', hr:'hours', hrs:'hours', hour:'hours', hours:'hours',
                  d:'days', day:'days', days:'days' };
    return `${n} ${map[u.toLowerCase()] || u}`;
  });

  // Collapse multi-spaces
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}

function looksLikeQuestion(s = '') {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return false;
  if (t.includes('?')) return true;
  if (/^(can|could|may|might|should|would|is|are|was|were|do|does|did|how|what|when|where|why|which)\b/.test(t)) return true;
  if (/\b(is it (ok|okay|possible)|can i|could i|should i|do you|does it)\b/.test(t)) return true;
  return false;
}




// ==== CONTEXTUAL HELP (module-scope helpers) ====

function looksLikeHelpFollowup(s = '') {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return false;

  // direct asks
  if (/^(help|how|what)\b/.test(t)) return true;

  // natural follow-ups after an error
  if (/^(how do i|how to|how do i do that|what do i do|what now|show me)\b/.test(t)) return true;

  // super-short follow-ups
  if (/^\s*(how|what)\s*$/i.test(t)) return true;

  return false;
}

// Minimal, inline FAQ for PocketCFO actions — expand as needed
const HELP_ARTICLES = {
  team_add_member: ({ name } = {}) =>
`Here’s how to add ${name ? `"${name}"` : 'a teammate'}:
1) Text:  "add teammate <Name> <Phone>"
   e.g.   "add teammate Justin +19055551234"
2) I’ll store them on your team so you can assign tasks and send DMs.

Then you can say: "assign task #24 to ${name || '<Name>'}".`,
};


// -------- Assignment helpers --------
function parseAssignmentUtterance(s = '', opts = {}) {
  const t = String(s || '').trim();

  // 1) Explicit number: "assign task #21 to Justin", "assign #21 Justin"
  const m1 = t.match(/\bassign(?:\s+task)?\s*#?\s*(\d+)\s*(?:to|@)?\s+([a-z][\w .'\-]{1,50})\b/i);
  if (m1) {
    return { taskNo: parseInt(m1[1], 10), assigneeName: m1[2].trim() };
  }

  // 2) "assign this to Justin" → fall back to last known created task if available
  const m2 = t.match(/\bassign\s+(?:this|it)\s+(?:to|@)\s+([a-z][\w .'\-]{1,50})\b/i);
  if (m2 && (opts.lastTaskNo || opts.pendingTaskNo)) {
    return { taskNo: opts.lastTaskNo || opts.pendingTaskNo, assigneeName: m2[1].trim() };
  }

  // 3) "can you assign … to Justin" (optional number)
  const m3 = t.match(/\bassign(?:\s+task)?\s*#?\s*(\d+)?\s*(?:to|@)\s+([a-z][\w .'\-]{1,50})\b/i);
  if (m3 && (m3[1] || opts.lastTaskNo || opts.pendingTaskNo)) {
    return { taskNo: m3[1] ? parseInt(m3[1], 10) : (opts.lastTaskNo || opts.pendingTaskNo), assigneeName: m3[2].trim() };
  }

  return null;
}

function looksLikeAssignment(s = '') {
  const t = String(s || '').toLowerCase();
  return /\bassign\b/.test(t) && /\b(to|@)\b/.test(t);
}

// ----------------- routes -----------------
router.get('/', (_req, res) => res.status(200).send('Webhook OK'));

// IMPORTANT: keep everything in ONE router.post(...) call in order.
router.post(
  '/',
  // 0) Basic guards (with trace + correct content-length parse)
  (req, res, next) => {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const len = parseInt(req.headers['content-length'] || '0', 10);
if (len > 5 * 1024 * 1024) return res.status(413).send('Payload too large');


    console.log('[WEBHOOK] hit', {
      url: req.originalUrl,
      method: req.method,
      contentType: req.headers['content-type'],
      contentLength: len,
      vercelId: req.headers['x-vercel-id'] || null,
    });
    next();
  },

  // 0.1) Version ping BEFORE heavy middlewares
  (req, res, next) => {
    const body = (req.body?.Body || '').trim().toLowerCase();
    if (body === 'version') {
      const v = process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'dev-local';
      return res
        .status(200)
        .type('text/xml')
        .send(`<Response><Message>build ${String(v).slice(0,7)} OK</Message></Response>`);
    }
    next();
  },

  // 1) Your existing middlewares
  userProfileMiddleware,
  lockMiddleware,
  tokenMiddleware,

  // 2) Main handler
  async (req, res, next) => {
    // NOTE: from/tenantId/userId are defined outside the big try so they're visible to catch/finally
    const { From, Body, MediaUrl0, MediaContentType0 } = req.body || {};
    const from = req.from || String(From || '').replace(/^whatsapp:/, '').replace(/\D/g, '');
    let input = (Body || '').trim();         // let: we may replace with transcript
    let mediaUrl = MediaUrl0 || null;        // let: we may override via pickFirstMedia()
    let mediaType = MediaContentType0 || null;

    // WhatsApp location payload (optional extras)
    const isLocation = (!!req.body.Latitude && !!req.body.Longitude) ||
      (req.body.MessageType && String(req.body.MessageType).toLowerCase() === 'location');
    const extras = {};
    if (isLocation) {
      const lat = parseFloat(req.body.Latitude);
      const lng = parseFloat(req.body.Longitude);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) { extras.lat = lat; extras.lng = lng; }
      if (req.body.Address) extras.address = String(req.body.Address).trim() || undefined;
      console.log('[WEBHOOK] location payload:', { lat: extras.lat, lng: extras.lng, address: extras.address || null });
    }

    const { userProfile, ownerId, ownerProfile, isOwner } = req;

    // ---- Twilio media extraction (robust) ----
function pickFirstMedia(reqBody = {}) {
  const n = parseInt(reqBody.NumMedia || '0', 10) || 0;
  if (n <= 0) return { mediaUrl: null, mediaType: null, num: 0 };
  const url = reqBody.MediaUrl0 || reqBody.MediaUrl || null;
  const typ = reqBody.MediaContentType0 || reqBody.MediaContentType || null;
  return { mediaUrl: url, mediaType: typ, num: n };
}

const picked = pickFirstMedia(req.body);
if (!mediaUrl && picked.mediaUrl)   mediaUrl  = picked.mediaUrl;
if (!mediaType && picked.mediaType) mediaType = picked.mediaType;

console.log('[WEBHOOK][MEDIA-IN]', {
  NumMedia: req.body.NumMedia,
  MediaUrl0: req.body.MediaUrl0,
  MediaContentType0: req.body.MediaContentType0,
  MediaUrl: req.body.MediaUrl,
  MediaContentType: req.body.MediaContentType,
  decidedMediaUrl: mediaUrl,
  decidedMediaType: mediaType,
  bodyLen: (req.body.Body || '').length,
});

// Track if this request included audio so we can guard fallbacks later
const ctInit = String(mediaType || '').split(';')[0].trim().toLowerCase();
const hadIncomingAudio = !!(mediaUrl && /^audio\//.test(ctInit));

// ---------- MEDIA FIRST (AUDIO ONLY): transcribe audio and handle simple commands ----------
if (mediaUrl && mediaType) {
  const ct = String(mediaType).split(';')[0].trim().toLowerCase();
  const isAudio = /^audio\//.test(ct);

  if (isAudio) {
    try {
      // Always pass normalized ct to handleMedia
      const out = await handleMedia(from, input, userProfile, ownerId, mediaUrl, ct);

      // handleMedia may return { transcript?, twiml? } or a string twiml
      const transcript = out && typeof out === 'object' ? out.transcript : null;
      const tw = typeof out === 'string' ? out : (out && out.twiml) ? out.twiml : null;

      console.log('[MEDIA] audio handled', {
        ct,
        hasTranscript: !!transcript,
        transcriptLen: transcript ? transcript.length : 0,
        hasTwiml: !!tw
      });

      if (transcript && transcript.trim()) {
        // 🔹 Clean the transcript first (handles things like "task, get, groceries.")
        let cleaned = cleanSpokenCommand(transcript);

        // Normalize "remind me …" → "task …"
        if (/^\s*remind me(\s+to)?\b/i.test(cleaned)) {
          cleaned = 'task ' + cleaned.replace(/^\s*remind me(\s+to)?\s*/i, '');
        }

        // Make cleaned transcript the new input for the rest of the pipeline
        input = cleaned;

        // ---------- ASSIGNMENT SHORT-CIRCUIT (AUDIO) ----------
        try {
          // Pull a recent task number if available (e.g., from pendingReminder)
          const pendingState = await getPendingTransactionState(from);
          const ctx = {
            pendingTaskNo: pendingState?.pendingReminder?.taskNo || null,
            lastTaskNo: pendingState?.lastTaskNo || null, // optional if you track it
          };

          const assignHit = looksLikeAssignment(input) ? parseAssignmentUtterance(input, ctx) : null;
          if (assignHit && assignHit.taskNo && assignHit.assigneeName) {
            // Hand off to tasks handler in "assign" mode
            res.locals = res.locals || {};
            res.locals.intentArgs = {
              action: 'assign',
              taskNo: assignHit.taskNo,
              assigneeName: assignHit.assigneeName
            };

            const tasksFn = getHandler && getHandler('tasks');
            if (typeof tasksFn === 'function') {
              const normalized = `task assign #${assignHit.taskNo} @${assignHit.assigneeName}`;
              const handled = await tasksFn(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              if (!res.headersSent && handled !== false) {
                ensureReply(res, `✅ Assigned task #${assignHit.taskNo} to ${assignHit.assigneeName}.`);
              }
              return; // ✅ handled
            }
          }
        } catch (e) {
          console.warn('[AUDIO→ASSIGN] skipped:', e?.message);
          // fall through
        }
        // ---------- END ASSIGNMENT SHORT-CIRCUIT (AUDIO) ----------
        
// ---------- REMIND SHORT-CIRCUIT (TEXT) ----------
try {
  const s = stripInvisible(String(input || '')).trim();
  const lc = s.toLowerCase();

  if (/^(remind\b|set\s+(a\s+)?reminder\b)/i.test(lc)) {
    const tz = getUserTz(userProfile);
    const offsetMinutes = getTzOffsetMinutes(tz);
    const m = s.match(/(?:task\s*)?#\s*(\d+)/i);
    const taskNo = m ? parseInt(m[1], 10) : null;

    const chrono = require('chrono-node');
    const results = chrono.parse(s, new Date(), { timezone: offsetMinutes, forwardDate: true });
    if (!taskNo || !results[0]) {
      return res.status(200).type('text/xml')
        .send(twiml(`Tell me which task and when. e.g.\n"remind me about task #28 in 10 minutes"`));
    }

    const remindAtIso = results[0].date().toISOString();
    await createReminder({ ownerId, userId: from, taskNo, taskTitle: `Task #${taskNo}`, remindAt: remindAtIso });

    const whenStr = new Date(remindAtIso).toLocaleString('en-CA', { timeZone: tz });
    return res.status(200).type('text/xml')
      .send(twiml(`⏰ Reminder set for task #${taskNo} at ${whenStr}.`));
  }
} catch (e) {
  console.warn('[REMIND SHORT-CIRCUIT] skipped:', e?.message);
}
// ---------- END REMIND SHORT-CIRCUIT ----------

// ==== CONTROL INTENT HELPERS (define once, used by audio + text) ====
function _sanitize(s) { return String(s || ''); }
function _trimLower(s) { return _sanitize(s).trim().toLowerCase(); }

// Treat STT quirks like "id complete" → "is complete"
function normalizeForControl(s = '') {
  let t = String(s || '');
  // "task #42 id complete" → "task #42 is complete"
  t = t.replace(/(\btask\s*#?\s*\d+\s+)\bid\b(?=\s+(complete|completed|done|finished|closed)\b)/gi, '$1is');
  // "#42 id complete" → "#42 is complete"
  t = t.replace(/(\b#\s*\d+\s+)\bid\b(?=\s+(complete|completed|done|finished|closed)\b)/gi, '$1is');
  return t;
}

// ----- ASSIGN helpers -----
function looksLikeAssign(s = '') {
  return /^\s*assign\b/i.test(_sanitize(s));
}
function parseAssignUtterance(s = '') {
  const t = _sanitize(s).trim();

  // "assign task #24 to Jaclyn" | "assign #24 to Jaclyn"
  let m = t.match(/^\s*assign\s+(?:task\s*)?#?(\d+)\s+(?:to|for|@)\s+(.+?)\s*$/i);
  if (m) return { taskNo: parseInt(m[1], 10), assignee: m[2].trim() };

  // "assign last task to Jaclyn" | "assign last to Jaclyn"
  m = t.match(/^\s*assign\s+(?:last\s+task|last)\s+(?:to|for|@)\s+(.+?)\s*$/i);
  if (m) return { taskNo: 'last', assignee: m[1].trim() };

  // "assign this (task) to Jaclyn"
  m = t.match(/^\s*assign\s+this(?:\s+task)?\s+(?:to|for|@)\s+(.+?)\s*$/i);
  if (m) return { taskNo: 'last', assignee: m[1].trim() };

  // "(please) assign to Jaclyn" → last
  m = t.match(/^\s*(?:please\s+)?assign\s+(?:to|for|@)\s+(.+?)\s*$/i);
  if (m) return { taskNo: 'last', assignee: m[1].trim() };

  return null;
}

// ----- COMPLETE helpers -----
function looksLikeComplete(s = '') {
  const t = _trimLower(normalizeForControl(s));
  if (/^(done|complete|completed|finish|finished|close|closed)\b/.test(t)) return true;
  if (/^this\s+task\s+(?:has\s+)?(?:been\s+)?(?:completed|done|finished|closed)\b/.test(t)) return true;
  if (/^task\s*#?\s*\d+\s+(?:has\s+)?(?:been\s+)?(?:completed|done|finished|closed)\b/.test(t)) return true;
  // "#37 is/’s/id complete"
  if (/^#?\s*\d+\s+(?:is|id|\'s|’s)\s+(?:complete|completed|done|finished|closed)\b/.test(t)) return true;
  // "task #37 is complete"
  if (/^task\s*#?\s*\d+\s+(?:is|id|\'s|’s)\s+(?:complete|completed|done|finished|closed)\b/.test(t)) return true;
  return false;
}
function parseCompleteUtterance(s = '') {
  const t = normalizeForControl(_sanitize(s).trim());

  let m = t.match(/^task\s*#?\s*(\d+)\s+(?:has\s+)?(?:been\s+)?(?:completed|done|finished|closed)\b/i);
  if (m) return { taskNo: parseInt(m[1], 10) };

  m = t.match(/^#?\s*(\d+)\s+(?:is|id|\'s|’s)\s+(?:complete|completed|done|finished|closed)\b/i);
  if (m) return { taskNo: parseInt(m[1], 10) };

  m = t.match(/^(?:done|complete|completed|finish|finished|close|closed)\s+#?(\d+)\b/i);
  if (m) return { taskNo: parseInt(m[1], 10) };

  m = t.match(/^this\s+task\s+(?:has\s+)?(?:been\s+)?(?:completed|done|finished|closed)\b/i);
  if (m) return { taskNo: 'last' };

  if (/^(?:done|complete|completed|finish|finished|close|closed)\b/i.test(t)) {
    return { taskNo: 'last' };
  }
  return null;
}

// looksLikeDelete
function looksLikeDelete(s = '') {
  const t = _trimLower(s);
  if (/^(?:delete|remove|cancel|trash)\s+(?:task\s*)?#?\d+\b/.test(t)) return true;  // <— updated
  if (/^task\s*#?\s*\d+\s+(?:delete|remove|cancel|trash)\b/.test(t)) return true;
  if (/^(delete|remove|cancel|trash)\s+this\s+task\b/.test(t)) return true;
  return false;
}

// parseDeleteUtterance
function parseDeleteUtterance(s = '') {
  const t = _sanitize(s).trim();

  // <— updated to allow "task" and no space before '#'
  let m = t.match(/^(?:delete|remove|cancel|trash)\s+(?:task\s*)?#?(\d+)\b/i);
  if (m) return { taskNo: parseInt(m[1], 10) };

  m = t.match(/^task\s*#?\s*(\d+)\s+(?:delete|remove|cancel|trash)\b/i);
  if (m) return { taskNo: parseInt(m[1], 10) };

  m = t.match(/^(?:delete|remove|cancel|trash)\s+this\s+task\b/i);
  if (m) return { taskNo: 'last' };

  return null;
}

// One guard to keep control phrases out of task-create fast-path
function looksLikeAnyControl(s = '') {
  return looksLikeAssign(s) || looksLikeComplete(s) || looksLikeDelete(s);
}
// ==== END CONTROL INTENT HELPERS ====

// ================= TEXT PATH BEGINS =================

// Early YES/NO handler for task offers (unchanged)
try {
  const lc = String(input || '').trim().toLowerCase();
  if (lc === 'yes' || lc === 'no') {
    const ps = await getPendingTransactionState(from); // "from" is the replier
    if (ps?.pendingTaskOffer?.taskNo && ps?.pendingTaskOffer?.ownerId) {
      const { taskNo, ownerId, title } = ps.pendingTaskOffer;
      const accepted = (lc === 'yes');

      const assigneeId = String(from).replace(/\D/g, ''); // normalize assignee
      const ownerDigits = String(ownerId).replace(/\D/g, ''); // normalize owner

      await query(
        `UPDATE public.tasks
            SET acceptance_status = $4, updated_at = NOW()
          WHERE owner_id = $1 AND task_no = $2 AND assigned_to = $3`,
        [ownerId, taskNo, assigneeId, accepted ? 'accepted' : 'declined']
      );

      try {
        await sendMessage(
          ownerDigits,
          `📣 ${assigneeId} ${accepted ? 'accepted' : 'declined'} task #${taskNo}${title ? `: ${title}` : ''}`
        );
      } catch {}

      await sendMessage(from, accepted ? '👍 Accepted — thanks!' : '👌 Declined — got it.');
      const { pendingTaskOffer, ...rest } = ps;
      await setPendingTransactionState(from, rest);

      return res.status(200).type('text/xml').send('<Response></Response>');
    }
  }
} catch (e) {
  console.warn('[task-offer yes/no] skipped:', e?.message);
}

// ---- ASSIGN FAST-PATH (must run BEFORE any task-creation fast-path) ----
try {
  if (typeof input === 'string' && looksLikeAssign(input)) {
    const parsed = parseAssignUtterance(input);
    if (parsed) {
      let { taskNo, assignee } = parsed;

      if (taskNo === 'last') {
        try {
          const ps = await getPendingTransactionState(from);
          if (ps?.lastTaskNo != null) taskNo = ps.lastTaskNo;
        } catch (_) {}
      }

      if (!taskNo || Number.isNaN(Number(taskNo))) {
        return res.status(200).type('text/xml')
          .send(twiml(`I couldn’t tell which task to assign. Try “assign task #12 to Justin”.`));
      }

      res.locals = res.locals || {};
      res.locals.intentArgs = { assignTaskNo: Number(taskNo), assigneeName: assignee };

      const handled = await tasksHandler(
        from,
        `__assign__ #${taskNo} to ${assignee}`,
        userProfile,
        ownerId,
        ownerProfile,
        isOwner,
        res
      );
      if (!res.headersSent && handled !== false) ensureReply(res, `Assigning task #${taskNo} to ${assignee}…`);
      return;
    }
  }
} catch (e) {
  console.warn('[ASSIGN FAST-PATH] skipped:', e?.message);
}
// ---- END ASSIGN FAST-PATH ----


// ---- COMPLETE FAST-PATH (must run BEFORE any task-creation fast-path) ----
try {
  if (typeof input === 'string' && looksLikeComplete(input)) {
    const hit = parseCompleteUtterance(input);
    if (hit) {
      let { taskNo } = hit;

      if (taskNo === 'last') {
        try {
          const ps = await getPendingTransactionState(from);
          if (ps?.lastTaskNo != null) taskNo = ps.lastTaskNo;
        } catch (_) {}
      }

      if (!taskNo || Number.isNaN(Number(taskNo))) {
        return res.status(200).type('text/xml')
          .send(twiml(`I couldn’t tell which task to complete. Try “done #12”.`));
      }

      res.locals = res.locals || {};
      res.locals.intentArgs = { doneTaskNo: Number(taskNo) };

      const handled = await tasksHandler(
        from,
        `__done__ #${taskNo}`,
        userProfile,
        ownerId,
        ownerProfile,
        isOwner,
        res
      );

      if (!res.headersSent && handled !== false) ensureReply(res, `Completing task #${taskNo}…`);
      return;
    }
  }
} catch (e) {
  console.warn('[COMPLETE FAST-PATH] skipped:', e?.message);
}
// ---- END COMPLETE FAST-PATH ----


// ---- DELETE FAST-PATH (must run BEFORE task-creation fast-path) ----
try {
  if (typeof input === 'string' && looksLikeDelete(input)) {
    const hit = parseDeleteUtterance(input);
    if (hit) {
      let { taskNo } = hit;

      if (taskNo === 'last') {
        try {
          const ps = await getPendingTransactionState(from);
          if (ps?.lastTaskNo != null) taskNo = ps.lastTaskNo;
        } catch (_) {}
      }

      if (!taskNo || Number.isNaN(Number(taskNo))) {
        return res.status(200).type('text/xml')
          .send(twiml(`I couldn’t tell which task to delete. Try “delete #12”.`));
      }

      res.locals = res.locals || {};
      res.locals.intentArgs = { deleteTaskNo: Number(taskNo) };

      const handled = await tasksHandler(
        from,
        `__delete__ #${taskNo}`,
        userProfile,
        ownerId,
        ownerProfile,
        isOwner,
        res
      );
      if (!res.headersSent && handled !== false) ensureReply(res, `Deleting task #${taskNo}…`);
      return;
    }
  }
} catch (e) {
  console.warn('[DELETE FAST-PATH] skipped:', e?.message);
}
// ---- END DELETE FAST-PATH ----


// ---------- FAST-PATH TASKS (text-only) ----------
try {
  const bodyTxt = String(input || '');

  // IMPORTANT: Never treat control phrases as new tasks
  if (
    !mediaUrl &&
    !looksLikeAnyControl(bodyTxt) &&
    (/^task\b/i.test(bodyTxt) ||
      (typeof looksLikeTask === 'function' && looksLikeTask(bodyTxt)))
  ) {
    try { await deletePendingTransactionState(from); } catch (_) {}

    const parsed = parseTaskUtterance(bodyTxt, { tz: getUserTz(userProfile), now: new Date() });
    if (!parsed) throw new Error('Could not parse task intent');

    res.locals = res.locals || {};
    res.locals.intentArgs = {
      title: parsed.title,
      dueAt: parsed.dueAt,
      assigneeName: parsed.assignee
    };

    return tasksHandler(from, bodyTxt, userProfile, ownerId, ownerProfile, isOwner, res);
  }
} catch (e) {
  console.warn('[WEBHOOK] fast-path tasks failed:', e?.message);
}
// ---------- END FAST-PATH TASKS ----------


// 🚀 IMMEDIATE TASK FAST-PATH for audio transcripts (not a question)
try {
  const tasksFn = getHandler && getHandler('tasks');
  if (
    typeof tasksFn === 'function' &&
    ( /^task\b/i.test(cleaned) || (typeof looksLikeTask === 'function' && looksLikeTask(cleaned) && !looksLikeQuestion(cleaned)) )
  ) {
    // ⛔ Guard: do NOT treat control intents as new tasks
    if (looksLikeAnyControl(cleaned)) {
      // Let the text-path control fast-paths handle it below
      throw new Error('control-intent-on-audio'); // bounce to catch -> fall through
    }

    const args = parseTaskUtterance(cleaned, { tz: getUserTz(userProfile), now: new Date() });

    console.log('[AUDIO→TASK] parsed', {
      title: args.title,
      dueAt: args.dueAt,
      assignee: args.assignee
    });

    res.locals = res.locals || {};
    res.locals.intentArgs = { title: args.title, dueAt: args.dueAt, assigneeName: args.assignee };

    const handled = await tasksFn(
      from,
      `task - ${args.title}`,
      userProfile,
      ownerId,
      ownerProfile,
      isOwner,
      res
    );

    if (!res.headersSent && handled !== false) {
      ensureReply(res, `Task created: ${args.title}`);
    }
    return; // ✅ handled
  }
} catch (te) {
  if (te && te.message !== 'control-intent-on-audio') {
    console.warn('[AUDIO→TASK] fast-path failed:', te?.message);
  }
  // fall through to text path
}

// Treat the rest of the pipeline as text-only now
mediaUrl = null;
mediaType = null;

} else {
  // No usable transcript
  if (typeof tw === 'string') {
    return res.status(200).type('text/xml').send(tw);
  }
  ensureReply(res, `⚠️ I couldn’t understand the audio. Try again, or text me: "task - buy tape".`);
  return; // ❌ stop, avoids helper
}
} catch (err) {
  console.error('[MEDIA] audio handling error:', err?.message);
  // Fall through; guard below will prevent helper on empty text
}
}
}

    // === REMINDERS-FIRST & PENDING SHORT-CIRCUITS ===
try {
  const pendingState = await getPendingTransactionState(from);
  const isTextOnly = !mediaUrl && !!input;

  if (pendingState?.pendingReminder && isTextOnly) {
    console.log('[WEBHOOK] pendingReminder present for', from, 'input=', input);
    const { pendingReminder } = pendingState;

    // 1) Normalize common voice-typo patterns like "in2min" → "in 2 minutes"
    //    and optionally run your cleanSpokenCommand helper if available.
    const maybeNormalized = (typeof normalizeTimePhrase === 'function')
      ? normalizeTimePhrase(String(input || ''))
      : String(input || '');
    const cleanedInput = (typeof cleanSpokenCommand === 'function')
      ? cleanSpokenCommand(maybeNormalized)
      : maybeNormalized;

    const lc = cleanedInput.trim().toLowerCase();

    // 2) Decide if this looks like a reply in the reminder flow
    //    - yes/no/cancel
    //    - anything with "remind"
    //    - "in <num> <unit>" with/without missing spaces (handled by normalizeTimePhrase)
    const looksLikeReminderReply =
      lc === 'yes' || lc === 'yes.' || lc === 'yep' || lc === 'yeah' ||
      lc === 'no'  || lc === 'no.'  || lc === 'cancel' ||
      /\bremind\b/i.test(cleanedInput) ||
      /\bin\s*\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i.test(lc) ||
      // Also catch "tomorrow", "tonight", "later", "this evening" etc.
      /\b(today|tonight|tomorrow|this\s+(morning|afternoon|evening|night))\b/i.test(lc) ||
      // Simple absolute time phrases: "at 7", "7pm", "7:30 pm"
      /\b(?:at\s*)?\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(lc);

    if (looksLikeReminderReply) {
      const chrono = require('chrono-node');
      const { createReminder } = require('../services/reminders');

      // 2a) “no / cancel” → stop and clear
      if (lc === 'no' || lc === 'cancel') {
        await deletePendingTransactionState(from);
        return res
          .status(200)
          .type('text/xml')
          .send(twiml(`No problem — no reminder set.`));
      }

      // 2b) “yes” alone → ask for a time
      const saidYesOnly = /^(yes\.?|yep|yeah)\s*$/i.test(cleanedInput.trim());
      if (saidYesOnly) {
        return res
          .status(200)
          .type('text/xml')
          .send(twiml(`Great — what time should I remind you? (e.g., "7pm tonight" or "tomorrow 8am")`));
      }

      // 3) Parse time from the (normalized) reply in the user's timezone
      const tz = getUserTz(userProfile);

      function getTzOffsetMinutes(tzName) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tzName, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const localIso = `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;
  const asLocal = Date.parse(localIso);
  const asUtc   = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return (asLocal - asUtc) / 60000;  // ✅ negative for N. America, positive for e.g. Europe/Asia
}


      const offsetMinutes = getTzOffsetMinutes(tz);

      // Use the cleaned/normalized text for parsing
      const results = chrono.parse(cleanedInput, new Date(), {
        timezone: offsetMinutes,
        forwardDate: true
      });

      if (!results || !results[0]) {
        // One more leniency pass: if user said only "in2min" or "in2 minutes" and we missed it,
        // try explicitly expanding units again (defensive).
        const fallback = cleanedInput
          .replace(/\bin\s*(\d+)\s*(m|min|mins)\b/gi, 'in $1 minutes')
          .replace(/\bin\s*(\d+)\s*(h|hr|hrs)\b/gi, 'in $1 hours')
          .replace(/\bin\s*(\d+)\s*(d)\b/gi, 'in $1 days');

        const retry = chrono.parse(fallback, new Date(), {
          timezone: offsetMinutes,
          forwardDate: true
        });

        if (!retry || !retry[0]) {
          return res.status(200).type('text/xml')
            .send(twiml(`I couldn't find a time in that. Try "in 2 minutes", "7pm tonight", or "tomorrow 8am".`));
        }

        const dt = retry[0].date();
        const remindAtIso = dt.toISOString();

        await createReminder({
          ownerId: pendingReminder.ownerId,
          userId: pendingReminder.userId,
          taskNo: pendingReminder.taskNo,
          taskTitle: pendingReminder.taskTitle,
          remindAt: remindAtIso
        });
        await deletePendingTransactionState(from);

        const whenStr = new Date(remindAtIso).toLocaleString('en-CA', { timeZone: tz });
        return res.status(200).type('text/xml')
          .send(twiml(`Got it. Reminder set for ${whenStr}.`));
      }

      // Success path
      const dt = results[0].date();
      const remindAtIso = dt.toISOString();

      await createReminder({
        ownerId: pendingReminder.ownerId,
        userId: pendingReminder.userId,
        taskNo: pendingReminder.taskNo,
        taskTitle: pendingReminder.taskTitle,
        remindAt: remindAtIso
      });
      await deletePendingTransactionState(from);

      const whenStr = new Date(remindAtIso).toLocaleString('en-CA', { timeZone: tz });
      return res.status(200).type('text/xml')
        .send(twiml(`Got it. Reminder set for ${whenStr}.`));
    }
  }

      // ---- A) Pending media-driven flows (text replies only, not "tasky")
      const tasky = /^task\b/i.test(input) || (function () {
        try { return require('../nlp/task_intents').looksLikeTask(input || ''); } catch { return false; }
      })();

      if (!tasky && !mediaUrl) {
        const pendingState2 = await getPendingTransactionState(from);
        if (pendingState2?.pendingMedia) {
          const type = pendingState2.pendingMedia.type; // may be null
          const lcInput = String(input || '').toLowerCase().trim();

          if (type === 'hours_inquiry') {
            const m = lcInput.match(/\b(today|day|this day|week|this week|month|this month)\b/i);
            if (m) {
              const raw = m[1].toLowerCase();
              const period = raw.includes('week') ? 'week' : raw.includes('month') ? 'month' : 'day';
              const tz = getUserTz(userProfile);
              const name = pendingState2.pendingHours?.employeeName || userProfile?.name || '';
              const { message } = await generateTimesheet({
                ownerId,
                person: name,
                period,
                tz,
                now: new Date()
              });
              await deletePendingTransactionState(from);
              return res.status(200).type('text/xml').send(twiml(message));
            }
            return res.status(200).type('text/xml')
              .send(twiml(`Got it. Do you want **today**, **this week**, or **this month** for ${pendingState2.pendingHours?.employeeName || 'them'}?`));
          }

          if (type === 'expense' || type === 'revenue' || type === 'time_entry') {
            if (lcInput === 'yes') {
              if (type === 'expense') {
                const data = pendingState2.pendingExpense;
                await appendToUserSpreadsheet(ownerId, [
                  data.date, data.item, data.amount, data.store,
                  (await getActiveJob(ownerId)) || 'Uncategorized',
                  'expense', data.category, data.mediaUrl || null,
                  userProfile.name || 'Unknown',
                ]);
                await deletePendingTransactionState(from);
                return res.status(200).type('text/xml')
                  .send(twiml(`✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} (Category: ${data.category})`));
              }
              if (type === 'revenue') {
                const data = pendingState2.pendingRevenue;
                await appendToUserSpreadsheet(ownerId, [
                  data.date, data.description, data.amount, data.source,
                  (await getActiveJob(ownerId)) || 'Uncategorized',
                  'revenue', data.category, data.mediaUrl || null,
                  userProfile.name || 'Unknown',
                ]);
                await deletePendingTransactionState(from);
                return res.status(200).type('text/xml')
                  .send(twiml(`✅ Revenue logged: ${data.amount} from ${data.source} (Category: ${data.category})`));
              }
              if (type === 'time_entry') {
                const { employeeName, type: entryType, timestamp, job } = pendingState2.pendingTimeEntry;
                await logTimeEntry(ownerId, employeeName, entryType, timestamp, job);
                const tz = getUserTz(userProfile);
                await deletePendingTransactionState(from);
                return res.status(200).type('text/xml')
                  .send(twiml(`✅ ${entryType.replace('_', ' ')} logged for ${employeeName} at ${new Date(timestamp).toLocaleString('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit' })}${job ? ` on ${job}` : ''}`));
              }
            }

            if (lcInput === 'no' || lcInput === 'cancel') {
              await deletePendingTransactionState(from);
              return res.status(200).type('text/xml')
                .send(twiml(`❌ ${friendlyTypeLabel(type)} cancelled.`));
            }

            if (lcInput === 'edit') {
              await deletePendingTransactionState(from);
              return res.status(200).type('text/xml')
                .send(twiml(`Please resend the ${friendlyTypeLabel(type)} details.`));
            }

            return res.status(200).type('text/xml')
              .send(twiml(`⚠️ Please reply with 'yes', 'no', or 'edit' to confirm or cancel the ${friendlyTypeLabel(type)}.`));
          }

          if (type == null) {
            return res.status(200).type('text/xml')
              .send(twiml(`Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`));
          }
        }
      }
    } catch (e) {
      console.warn('[WEBHOOK] pending text-reply handler skipped:', e?.message);
    }
    // === END REMINDERS/PENDING SHORT-CIRCUITS ===

// === CONTEXTUAL HELP (FAQ intercept) — must run BEFORE generic helpers/NLP ===
try {
  // If a previous handler (e.g., tasks.js) stored a help topic (like team_add_member),
  // and the user now asks “how do I do that?”, provide a targeted answer.
  const pending = await getPendingTransactionState(from).catch(() => null);

  if (pending?.helpTopic?.key && looksLikeHelpFollowup(input)) {
    const { key, context } = pending.helpTopic;
    const article = HELP_ARTICLES[key];

    if (typeof article === 'function') {
      // One-shot: consume the help topic so we don’t loop on every message
      try {
        await setPendingTransactionState(from, { ...pending, helpTopic: null });
      } catch {}

      return res
        .status(200)
        .type('text/xml')
        .send(twiml(article(context)));
    }

    // Unknown key (defensive): clear and soft fallback
    try {
      await setPendingTransactionState(from, { ...pending, helpTopic: null });
    } catch {}
  }
} catch (e) {
  console.warn('[HELP ROUTER] failed:', e?.message);
}

// === TEAM SHORT-CIRCUIT (text-only, before NLP & task fast-paths) ===
try {
  if (!mediaUrl && typeof input === 'string') {
    const raw = input.trim();

    // Use helper if present, otherwise identity (defensive)
    const _strip = (typeof stripInvisible === 'function') ? stripInvisible : (x) => x;
    const cleaned = _strip(raw); // remove hidden chars around '+'
    const lc = cleaned.toLowerCase();

    const looksTeamList   = /^\s*team\s*$/.test(lc);
    const looksTeamAdd    = /^\s*add\s+(?:team(?:mate|(?:\s*member))|member)\b/.test(lc);
    const looksTeamRemove = /^\s*remove\s+(?:team(?:mate|(?:\s*member))|member)\b/.test(lc);

    if (looksTeamList || looksTeamAdd || looksTeamRemove) {
      console.log('[TEAM SHORT-CIRCUIT] hit', { cleaned });

      const teamFn = getHandler && getHandler('team');
      if (typeof teamFn === 'function') {
        const out = await teamFn(from, cleaned, userProfile, ownerId, ownerProfile, isOwner, res);

        if (res.headersSent) return; // already replied by handler
        if (typeof out === 'string' && out.trim().startsWith('<Response>')) {
          return res.status(200).type('text/xml').send(out);
        }
        if (out && typeof out === 'object' && typeof out.twiml === 'string') {
          return res.status(200).type('text/xml').send(out.twiml);
        }
        // If handler returned truthy without twiml, send an empty 200 TwiML to appease Twilio
        if (out) return res.status(200).type('text/xml').send('<Response><Message></Message></Response>');
        return; // handled
      } else {
        console.warn('[TEAM SHORT-CIRCUIT] team handler not found or not a function');
      }
    }
  }
} catch (e) {
  console.warn('[TEAM SHORT-CIRCUIT] skipped:', e?.message);
}
// === END TEAM SHORT-CIRCUIT ===



    // ---------- memory bootstrapping ----------
    const tenantId = ownerId;
    const userId = from;
    let convo = await getConvoState(tenantId, userId);
    const state = {
      user_id: userId,
      tenant_id: tenantId,
      active_job: convo.active_job || null,
      active_job_id: convo.active_job_id || null,
      aliases: convo.aliases || {},
      history: Array.isArray(convo.history) ? convo.history.slice(-5) : []
    };

    // Optional fetch of defaults you may use in your nlp/router
    const memory = await getMemory(tenantId, userId, [
      'default.expense.bucket',
      'labor_rate',
      'default.markup',
      'client.default_terms'
    ]);

    try {
      // 0.25) NLP routing (conversation.js)
      try {
        const routed = await converseAndRoute(input, {
          userProfile,
          ownerId,
          convoState: state,
          memory
        });

        if (routed) {
          if (routed.handled && routed.twiml) {
            return res.status(200).type('text/xml').send(routed.twiml);
          }

          const route = routed.route;
          if (!routed.handled && route) {
            let handled = false;
            let responseText = '';

            res.locals = res.locals || {};
            res.locals.intentArgs = routed.args || null;

            if (route === 'tasks') {
              handled = await tasksHandler(from, routed.normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              responseText = 'Task created!';
              if (handled !== false) {
                await logEvent(tenantId, userId, 'tasks.create', { normalized: routed.normalized, args: routed.args || {} });
              }
            } else if (route === 'expense') {
              const expenseFn = getHandler('expense');
              if (typeof expenseFn === 'function') {
                handled = await expenseFn(from, routed.normalized, userProfile, ownerId, ownerProfile, isOwner, res);
                responseText = 'Expense logged!';
                if (handled !== false) {
                  await logEvent(tenantId, userId, 'expense.add', { normalized: routed.normalized, args: routed.args || {} });
                  if (routed.args?.alias && (routed.args.vendor || routed.args.job)) {
                    await upsertMemory(tenantId, userId, `alias.vendor.${routed.args.alias.toLowerCase()}`, { name: routed.args.vendor || routed.args.job });
                  }
                  if (routed.args?.bucket === 'Overhead') {
                    await upsertMemory(tenantId, userId, 'default.expense.bucket', { bucket: 'Overhead' });
                  }
                }
              }
            } else if (route === 'timeclock') {
              const normalized = normalizeTimeclockInput(routed.normalized, userProfile);
              handled = await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
              responseText = '✅ Timeclock request received.';
              if (handled !== false) {
                await logEvent(tenantId, userId, 'timeclock', { normalized, args: routed.args || {} });
                if (routed.args?.job || routed.args?.job_id) {
                  await saveConvoState(tenantId, userId, {
                    active_job: routed.args.job || convo.active_job || null,
                    active_job_id: routed.args.job_id || convo.active_job_id || null
                  });
                }
              }
            } else if (route === 'job') {
              const jobFn = getHandler('job');
              if (typeof jobFn === 'function') {
                handled = await jobFn(from, routed.normalized, userProfile, ownerId, ownerProfile, isOwner, res);
                responseText = 'Job created!';
                if (handled !== false) {
                  await logEvent(tenantId, userId, 'job.create', { normalized: routed.normalized, args: routed.args || {} });
                }
              }
            }

            if (handled) {
              await saveConvoState(tenantId, userId, {
                last_intent: routed.intent || convo.last_intent || null,
                last_args: routed.args || convo.last_args || {},
                history: [...(convo.history || []).slice(-4), { input, response: responseText, intent: routed.intent || route || null }]
              });
              if (!res.headersSent) ensureReply(res, responseText);
              return;
            }
          }
        }
      } catch (e) {
        console.warn('[WEBHOOK] NLP route skip:', e?.message);
      }

      // 0) Onboarding
      if ((userProfile && userProfile.onboarding_in_progress) || input.toLowerCase().includes('start onboarding')) {
        const response = await handleOnboarding(from, input, userProfile, ownerId, res);
        await logEvent(tenantId, userId, 'onboarding', { input, response });
        await saveConvoState(tenantId, userId, {
          history: [...(convo.history || []).slice(-4), { input, response, intent: 'onboarding' }]
        });
        ensureReply(res, `Welcome to Chief AI! Quick question — what's your name?`);
        return;
      }

      // 0.5) Owner approval
      if (/^approve\s+/i.test(input)) {
        const handled = await handleOwnerApproval(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
        if (handled !== false) {
          await logEvent(tenantId, userId, 'owner_approval', { input });
          await saveConvoState(tenantId, userId, {
            history: [...(convo.history || []).slice(-4), { input, response: 'Approval processed.', intent: 'owner_approval' }]
          });
          if (!res.headersSent) ensureReply(res, 'Approval processed.');
          return;
        }
      }

      // 1) Upgrade flow (Stripe)
      {
        const lc = input.toLowerCase();
        const wantsUpgrade = lc.includes('upgrade to pro') || lc.includes('upgrade to enterprise');
        if (wantsUpgrade) {
          try {
            if (userProfile?.stripe_subscription_id) {
              await sendMessage(from, `⚠️ You already have an active ${userProfile.subscription_tier} subscription. Contact support to change plans.`);
              ensureReply(res, 'Already subscribed!');
              return;
            }
            const tier = lc.includes('pro') ? 'pro' : 'enterprise';
            const priceId = tier === 'pro' ? process.env.PRO_PRICE_ID : process.env.ENTERPRISE_PRICE_ID;
            const priceText = tier === 'pro' ? '$29' : '$99'
            const customer = await stripe.customers.create({ phone: from, metadata: { user_id: userProfile.user_id } });
            const paymentLink = await stripe.paymentLinks.create({
              line_items: [{ price: priceId, quantity: 1 }],
              metadata: { user_id: userProfile.user_id }
            });

            await query(`UPDATE users SET stripe_customer_id=$1, subscription_tier=$2 WHERE user_id=$3`,
              [customer.id, tier, userProfile.user_id]
            );

            await sendTemplateMessage(from, process.env.HEX_UPGRADE_NOW, [`Upgrade to ${tier} for ${priceText}/month CAD: ${paymentLink.url}`]);
            await logEvent(tenantId, userId, 'upgrade', { tier, link: paymentLink.url });
            await saveConvoState(tenantId, userId, {
              history: [...(convo.history || []).slice(-4), { input, response: 'Upgrade link sent!', intent: 'upgrade' }]
            });
            ensureReply(res, 'Upgrade link sent!');
            return;
          } catch (err) {
            console.error('[UPGRADE] error:', err?.message);
            return next(err);
          }
        }
      }

      // 2) DeepDive / historical upload
      {
        const lc = input.toLowerCase();
        const triggersDeepDive = lc.includes('upload history') || lc.includes('historical data') || lc.includes('deepdive') || lc.includes('deep dive');

        const tierLimits = {
          starter:     { years: 7, transactions:  5000, parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_STARTER,     parsingPriceText: '$19' },
          pro:         { years: 7, transactions: 20000, parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_PRO,         parsingPriceText: '$49' },
          enterprise:  { years: 7, transactions: 50000, parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_ENTERPRISE,  parsingPriceText: '$99' }
        };
        const tier = (userProfile?.subscription_tier || 'starter').toLowerCase();
        const limit = tierLimits[tier] || tierLimits.starter;

        if (triggersDeepDive) {
          await setPendingTransactionState(from, {
            historicalDataUpload: true,
            deepDiveUpload: true,
            maxTransactions: limit.transactions,
            uploadType: 'csv'
          });

          if (mediaUrl && mediaType && ['application/pdf', 'image/jpeg', 'image/png', 'audio/mpeg'].includes(mediaType)) {
            try {
              if (!userProfile?.historical_parsing_purchased) {
                const paymentLink = await stripe.paymentLinks.create({
                  line_items: [{ price: limit.parsingPriceId, quantity: 1 }],
                  metadata: { user_id: userProfile.user_id, type: 'historical_parsing' }
                });
                await sendTemplateMessage(from, process.env.HEX_DEEPDIVE_CONFIRMATION, [
                  `Upload up to 7 years of historical data via CSV/Excel for free (${limit.transactions} transactions). For historical image/audio parsing, unlock Chief AI’s DeepDive for ${limit.parsingPriceText}: ${paymentLink.url}`
                ]);
                await logEvent(tenantId, userId, 'deepdive_paylink', { link: paymentLink.url, tier });
                ensureReply(res, 'DeepDive payment link sent!');
                return;
              }
            } catch (err) {
              console.error('[DEEPDIVE] payment init error:', err?.message);
              return next(err);
            }
          }

          const dashUrl = `/dashboard/${from}?token=${userProfile?.dashboard_token || ''}`;
          await logEvent(tenantId, userId, 'deepdive_init', { tier, maxTransactions: limit.transactions });
          await saveConvoState(tenantId, userId, {
            history: [...(convo.history || []).slice(-4), { input, response: `Ready to upload historical data…`, intent: 'deepdive' }]
          });
          ensureReply(res, `Ready to upload historical data (up to ${limit.years} years, ${limit.transactions} transactions). Send CSV/Excel for free or PDFs/images/audio for ${limit.parsingPriceText} via DeepDive. Track progress on your dashboard: ${dashUrl}`);
          return;
        }

        const deepDiveState = await getPendingTransactionState(from);
        const isInDeepDiveUpload = deepDiveState?.deepDiveUpload === true || deepDiveState?.historicalDataUpload === true;

        if (isInDeepDiveUpload && mediaUrl && mediaType) {
          try {
            const allowed = [
              'application/pdf', 'image/jpeg', 'image/png', 'audio/mpeg',
              'text/csv', 'application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            ];
            if (!allowed.includes(mediaType)) {
              ensureReply(res, 'Unsupported file type. Please upload a PDF, image, audio, CSV, or Excel.');
              return;
            }

            if (['application/pdf', 'image/jpeg', 'image/png', 'audio/mpeg'].includes(mediaType) && !userProfile?.historical_parsing_purchased) {
              const paymentLink = await stripe.paymentLinks.create({
                line_items: [{ price: limit.parsingPriceId, quantity: 1 }],
                metadata: { user_id: userProfile.user_id, type: 'historical_parsing' }
              });
              await sendTemplateMessage(from, process.env.HEX_DEEPDIVE_CONFIRMATION, [
                `To parse PDFs/images/audio, unlock DeepDive for ${limit.parsingPriceText}: ${paymentLink.url}. CSV/Excel uploads remain free (${limit.transactions} transactions).`
              ]);
              await logEvent(tenantId, userId, 'deepdive_blocked_payment_required', { link: paymentLink.url });
              ensureReply(res, 'DeepDive payment link sent!');
              return;
            }

            const fileResp = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(fileResp.data);
            const filename = mediaUrl.split('/').pop() || 'upload';

            const summary = await parseUpload(
              buffer,
              filename,
              from,
              mediaType,
              deepDiveState.uploadType || 'csv',
              userProfile?.fiscal_year_start
            );

            if (deepDiveState.historicalDataUpload) {
              const transactionCount = summary?.transactions?.length || 0;
              if (transactionCount > (deepDiveState.maxTransactions || limit.transactions)) {
                ensureReply(res, `Upload exceeds ${deepDiveState.maxTransactions || limit.transactions} transactions. Contact support for larger datasets.`);
                return;
              }
              const dashUrl = `/dashboard/${from}?token=${userProfile?.dashboard_token || ''}`;
              await logEvent(tenantId, userId, 'deepdive_upload', { transactionCount, mediaType });
              await saveConvoState(tenantId, userId, {
                history: [...(convo.history || []).slice(-4), { input: `file:${mediaType}`, response: `✅ ${transactionCount} new transactions processed.`, intent: 'deepdive_upload' }]
              });
              ensureReply(res, `✅ ${transactionCount} new transactions processed. Track progress on your dashboard: ${dashUrl}`);
              deepDiveState.historicalDataUpload = false;
              deepDiveState.deepDiveUpload = false;
              await setPendingTransactionState(from, deepDiveState);
              return;
            }

            await logEvent(tenantId, userId, 'deepdive_file_processed', { mediaType, filename });
            ensureReply(res, `File received and processed. ${summary ? 'Summary: ' + JSON.stringify(summary) : 'OK'}.`);
            deepDiveState.deepDiveUpload = false;
            await setPendingTransactionState(from, deepDiveState);
            return;
          } catch (err) {
            console.error('[DEEPDIVE] parse error:', err?.message);
            return next(err);
          }
        }
      }
// 3.05) ASSIGNMENT SHORT-CIRCUIT (TEXT)
try {
  if (typeof input === 'string' && looksLikeAssignment(input)) {
    const pendingState = await getPendingTransactionState(from);
    const ctx = {
      pendingTaskNo: pendingState?.pendingReminder?.taskNo || null,
      lastTaskNo: pendingState?.lastTaskNo || null, // if you track this
    };

    const assignHit = parseAssignmentUtterance(input, ctx);
    if (assignHit && assignHit.taskNo && assignHit.assigneeName) {
      res.locals = res.locals || {};
      res.locals.intentArgs = {
        action: 'assign',
        taskNo: assignHit.taskNo,
        assigneeName: assignHit.assigneeName
      };

      const tasksFn = getHandler && getHandler('tasks');
      if (typeof tasksFn === 'function') {
        const normalized = `task assign #${assignHit.taskNo} @${assignHit.assigneeName}`;
        const handled = await tasksFn(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res);
        if (!res.headersSent && handled !== false) {
          ensureReply(res, `✅ Assigned task #${assignHit.taskNo} to ${assignHit.assigneeName}.`);
        }
        return; // ✅ handled
      }
    }
  }
} catch (e) {
  console.warn('[ASSIGN] skipped:', e?.message);
}


   // 3.1) Fast-path tasks AFTER transcript feed-in
try {
  const tasksFn = getHandler && getHandler('tasks');
  if (typeof input === 'string' && typeof tasksFn === 'function') {
    const cleaned = cleanSpokenCommand(input);

    if (
      /^task\b/i.test(cleaned) ||                    // explicit
      (looksLikeTask(cleaned) && !looksLikeQuestion(cleaned)) // implicit but not a question
    ) {
      const tz = getUserTz(userProfile);
      const args = parseTaskUtterance(cleaned, { tz, now: new Date() });

      console.log('[TASK FAST-PATH] parsed', { title: args.title, dueAt: args.dueAt, assignee: args.assignee });

      res.locals = res.locals || {};
      res.locals.intentArgs = args;

      const handled = await tasksFn(
        from,
        `task - ${args.title}`,
        userProfile,
        ownerId,
        ownerProfile,
        isOwner,
        res
      );
      if (!res.headersSent && handled !== false) ensureReply(res, 'Task created!');
      return;
    }
  }
} catch (e) {
  console.warn('[TASK FAST-PATH] skipped:', e?.message);
}

      // 3.5) Fast-path for pending timeclock prompts
      try {
        const pending = await getPendingPrompt(ownerId);
        if (pending) {
          const normalized = normalizeTimeclockInput(input, userProfile);
          const handled = await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
          await logEvent(tenantId, userId, 'timeclock_prompt_reply', { input, normalized, pending_kind: pending.kind });
          if (!res.headersSent) ensureReply(res, handled ? '' : '');
          return;
        }
      } catch (e) {
        console.warn('[WEBHOOK] pending prompt check failed:', e?.message);
      }

      // 3.6) PRIORITY: Direct timeclock route on explicit timeclock language
      if (isTimeclockMessage(input)) {
        const normalized = normalizeTimeclockInput(input, userProfile);
        await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
        await logEvent(tenantId, userId, 'timeclock_direct', { normalized });
        if (!res.headersSent) ensureReply(res, '✅ Timeclock request received.');
        return;
      }
// If we had an incoming audio but still have no input by here, never fall into helpers
if (hadIncomingAudio && (!input || !input.trim())) {
  console.log('[GUARD] had incoming audio, but no transcript → sending cannot-understand message');
  ensureReply(res, `⚠️ I couldn’t understand the audio. Try again, or text me: "task - buy tape".`);
  return;
}

// 3.7) Follow-up modifier: "assign this/it to <name>"
try {
  // only if it's a question / follow-up, not a command
  if (looksLikeQuestion(input)) {
    const m = /\bassign\s+(?:this|it)?\s*(?:to|@)\s*([a-z][\w\s.'-]{1,50})\??$/i.exec(input.trim());
    if (m) {
      const assignee = m[1].trim();

      // Hand off to tasks handler in "assign" mode targeting the last created task
      const tasksFn = getHandler && getHandler('tasks');
      if (typeof tasksFn === 'function') {
        res.locals = res.locals || {};
        res.locals.intentArgs = {
          action: 'assign',
          taskRef: 'last',            // let your tasks handler interpret 'last' → last created/active task
          assigneeName: assignee
        };

        // Use a normalized command string your tasks handler understands for assignment
        const normalized = `task assign @${assignee}`;

        const handled = await tasksFn(
          from,
          normalized,
          userProfile,
          ownerId,
          ownerProfile,
          isOwner,
          res
        );

        if (!res.headersSent && handled !== false) {
          ensureReply(res, `Assigned to ${assignee}.`);
        }
        return; // ✅ handled as a follow-up modification
      }
    }
  }
} catch (e) {
  console.warn('[TASK ASSIGN FOLLOW-UP] failed:', e?.message);
}


      // 4) Conversational router first
      try {
        const conv = await converseAndRoute(input, { userProfile, ownerId: tenantId, convoState: state });

        const extractMsg = (twimlStr) => {
          if (!twimlStr) return '';
          const m = twimlStr.match(/<Message>([\s\S]*?)<\/Message>/);
          return m ? m[1] : '';
        };

        if (conv?.handled && conv.twiml) {
          const responseText = extractMsg(conv.twiml);
          await logEvent(tenantId, userId, 'clarify', { input, response: responseText, intent: conv.intent || null });
          await saveConvoState(tenantId, userId, {
            last_intent: conv.intent || convo.last_intent || null,
            last_args: conv.args || convo.last_args || {},
            history: [...(convo.history || []).slice(-4), { input, response: responseText, intent: conv.intent || null }]
          });
          res.status(200).type('text/xml').send(conv.twiml);
          return;
        }

        if (conv && conv.route && conv.normalized) {
          let responseText = extractMsg(conv.twiml);
          let handled = false;

          if (conv.route === 'tasks') {
            const tasksFn = getHandler('tasks');
            if (typeof tasksFn === 'function') {
              handled = await tasksFn(from, conv.normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              responseText = responseText || 'Task created!';
              await logEvent(tenantId, userId, 'tasks.create', { normalized: conv.normalized, args: conv.args || {} });
            }
          } else if (conv.route === 'expense') {
            const expenseFn = getHandler('expense');
            if (typeof expenseFn === 'function') {
              handled = await expenseFn(from, conv.normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              responseText = responseText || 'Expense logged!';
              await logEvent(tenantId, userId, 'expense.add', { normalized: conv.normalized, args: conv.args || {} });
              if (conv.args?.alias && (conv.args.vendor || conv.args.job)) {
                await upsertMemory(tenantId, userId, `alias.vendor.${conv.args.alias.toLowerCase()}`, { name: conv.args.vendor || conv.args.job });
              }
              if (conv.args?.bucket === 'Overhead') {
                await upsertMemory(tenantId, userId, 'default.expense.bucket', { bucket: 'Overhead' });
              }
            }
          } else if (conv.route === 'timeclock') {
            const normalized = normalizeTimeclockInput(conv.normalized, userProfile);
            handled = await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
            responseText = responseText || '✅ Timeclock request received.';
            await logEvent(tenantId, userId, 'timeclock', { normalized, args: conv.args || {} });
            if (conv.args?.job || conv.args?.job_id) {
              await saveConvoState(tenantId, userId, {
                active_job: conv.args.job || convo.active_job || null,
                active_job_id: conv.args.job_id || convo.active_job_id || null
              });
            }
          } else if (conv.route === 'job') {
            const jobFn = getHandler('job');
            if (typeof jobFn === 'function') {
              handled = await jobFn(from, conv.normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              responseText = responseText || 'Job created!';
              await logEvent(tenantId, userId, 'job.create', { normalized: conv.normalized, args: conv.args || {} });
            }
          }

          if (handled) {
            await saveConvoState(tenantId, userId, {
              last_intent: conv.intent || convo.last_intent || null,
              last_args: conv.args || convo.last_args || {},
              history: [...(convo.history || []).slice(-4), { input, response: responseText, intent: conv.intent || null }]
            });
            if (!res.headersSent && conv.twiml) res.status(200).type('text/xml').send(conv.twiml);
            return;
          }
        }
      } catch (e) {
        console.warn('[Conversational Router] error:', e?.message);
      }

      // 5) Timeclock (direct keywords) — backup path
      if (isTimeclockMessage(input)) {
        const normalized = normalizeTimeclockInput(input, userProfile);
        await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
        await logEvent(tenantId, userId, 'timeclock', { normalized });
        if (!res.headersSent) ensureReply(res, '✅ Timeclock request received.');
        return;
      }

      // 6) AI intent router (tool-calls)
      try {
        const ai = await routeWithAI(input, { userProfile });
        if (ai) {
          let handled = false;
          let responseText = 'Action completed!';
          let normalizedForLog = null;

          if (ai.intent === 'timeclock.clock_in') {
            const who = ai.args.person || userProfile?.name || 'Unknown';
            const jobHint = ai.args.job ? ` @ ${ai.args.job}` : '';
            const t = ai.args.time ? ` at ${ai.args.time}` : '';
            const normalized = `${who} punched in${jobHint}${t}`;
            normalizedForLog = normalized;
            handled = await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
            responseText = `Punched in${jobHint}! What’s next?`;
          } else if (ai.intent === 'timeclock.clock_out') {
            const who = ai.args.person || userProfile?.name || 'Unknown';
            const t = ai.args.time ? ` at ${ai.args.time}` : '';
            const normalized = `${who} punched out${t}`;
            normalizedForLog = normalized;
            handled = await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
            responseText = `Clocked out${t}! Anything else?`;
          } else if (ai.intent === 'job.create') {
            const name = ai.args.name?.trim();
            if (name && typeof commands.job === 'function') {
              const normalized = `create job ${name}`;
              normalizedForLog = normalized;
              handled = await commands.job(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              responseText = `Created job: ${name}. Need tasks for it?`;
            }
          } else if (ai.intent === 'expense.add') {
            const amt = ai.args.amount;
            const cat = ai.args.category ? ` ${ai.args.category}` : '';
            const fromWho = ai.args.merchant ? ` from ${ai.args.merchant}` : '';
            const normalized = `expense $${amt}${cat}${fromWho}`.trim();
            normalizedForLog = normalized;
            const expenseFn = getHandler('expense');
            if (typeof expenseFn === 'function') {
              handled = await expenseFn(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              responseText = `Logged $${amt}${fromWho}! Got more expenses?`;
              if (ai.args.merchant) {
                await upsertMemory(tenantId, userId, `alias.vendor.${ai.args.merchant.toLowerCase()}`, { name: ai.args.merchant });
              }
            }
          }

          if (handled) {
            await logEvent(tenantId, userId, ai.intent, { normalized: normalizedForLog, args: ai.args });
            await saveConvoState(tenantId, userId, {
              last_intent: ai.intent,
              last_args: ai.args,
              history: [...(convo.history || []).slice(-4), { input, response: responseText, intent: ai.intent }]
            });
            if (!res.headersSent) ensureReply(res, responseText);
            return;
          }
        }
      } catch (e) {
        console.warn('[AI Router] skipped due to error:', e?.message);
      }

      // 7) Fast intent router for jobs
      if (/^\s*(create|new|add)\s+job\b/i.test(input) || /^\s*(start|pause|resume|finish|summarize)\s+job\b/i.test(input)) {
        if (typeof commands.job === 'function') {
          try {
            const handled = await commands.job(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
            if (handled !== false) {
              await logEvent(tenantId, userId, 'job', { input });
              await saveConvoState(tenantId, userId, {
                history: [...(convo.history || []).slice(-4), { input, response: 'Job action completed.', intent: 'job' }]
              });
              if (!res.headersSent) ensureReply(res, '');
              return;
            }
          } catch (e) {
            console.error('[ERROR] job handler threw:', e?.message);
          }
        } else {
          console.warn('[WARN] commands.job not callable; exports:', Object.keys(commands || {}));
        }
      }

      // 8) General dispatch (with internal timeclock guard)
      {
        const handled = await dispatchCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
        if (handled) {
          await logEvent(tenantId, userId, 'dispatch', { input });
          await saveConvoState(tenantId, userId, {
            history: [...(convo.history || []).slice(-4), { input, response: 'Action completed.', intent: 'dispatch' }]
          });
          return;
        }
      }

      // 9) Legacy combined handler
      if (typeof commands.handleCommands === 'function') {
        try {
          const handled = await commands.handleCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
          if (handled !== false) {
            await logEvent(tenantId, userId, 'legacy', { input });
            await saveConvoState(tenantId, userId, {
              history: [...(convo.history || []).slice(-4), { input, response: 'Action completed.', intent: 'legacy' }]
            });
            return;
          }
        } catch (e) {
          console.error('[ERROR] handleCommands threw:', e?.message);
        }
      }

      // Fallback
      const response = "I'm here to help! Try 'expense $100 tools', 'create job Roof Repair', 'task - buy tape', or 'help'.";
      await logEvent(tenantId, userId, 'fallback', { input, response });
      await saveConvoState(tenantId, userId, {
        last_intent: null,
        last_args: {},
        history: [...(convo.history || []).slice(-4), { input, response, intent: null }]
      });
      if (!res.headersSent) ensureReply(res, response);
      return;

    } catch (error) {
      console.error(`[ERROR] Webhook processing failed for ${maskPhone(from)}:`, error.message);
      const tenantId = ownerId;
      const userId = from;
      try { await logEvent(tenantId, userId, 'error', { input, error: error.message }); } catch {}
      return next(error);
    } finally {
      try {
        await releaseLock(req.lockKey, req.lockToken);
        console.log('[LOCK] released for', req.lockKey);
      } catch (e) {
        console.error('[WARN] Failed to release lock for', req.lockKey, ':', e.message);
      }
    }
  },
  errorMiddleware
);

// ---- Reminders Cron (simple polling) ----
router.get(['/reminders/cron', '/reminders/cron/:slug'], async (req, res, next) => {
  try {
    console.log('[reminders/cron] incoming', {
      url: req.originalUrl,
      headers: req.headers,
      time: new Date().toISOString(),
    });

    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const slugOk = !!req.params.slug && (!process.env.CRON_SECRET || req.params.slug === process.env.CRON_SECRET);

    if (!isVercelCron && !slugOk) {
      return res.status(403).send('Forbidden');
    }

    const { getDueReminders, markReminderSent } = require('../services/reminders');

    const due = await getDueReminders({ now: new Date() });
    let sent = 0;

    for (const r of due) {
      try {
        const line = r.task_no ? `Task #${r.task_no}: ${r.task_title}` : r.task_title;
        await sendMessage(r.user_id, `⏰ Reminder: ${line}`);
        await markReminderSent(r.id);
        console.log('[reminders/cron] sent', { id: r.id, user: r.user_id, when: r.remind_at });
        sent++;
      } catch (e) {
        console.warn('[reminders/cron] send failed:', r.id, e?.message);
      }
    }

    return res.status(200).json({ ok: true, sent, checked: due.length });
  } catch (e) {
    console.error('[reminders/cron] error:', e?.message);
    return next(e);
  }
});

module.exports = router;
