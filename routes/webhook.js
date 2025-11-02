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
const handleJob = require('../handlers/commands/job');
const { ask: agentAsk } = require('../services/agent');
const { timeclockTool } = require('../services/tools/timeclock');
const { tasksTool } = require('../services/tools/tasks');
const { jobTool } = require('../services/tools/job');
const { ragTool } = require('../services/tools/rag');


// Middleware
const { lockMiddleware, releaseLock } = require('../middleware/lock');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { tokenMiddleware } = require('../middleware/token');
const { errorMiddleware } = require('../middleware/error');

// Services — keep only what this file actually uses
const {
  query,
  listMyTasks,        // used in "My tasks" block
  getPendingPrompt,   // used for pending prompt checks
  logTimeEntry,       // used for timeclock logs
  getActiveJob,       // used in job-aware flows
  appendToUserSpreadsheet, // used for sheet append actions
  generateTimesheet,  // used in export flows
} = require('../services/postgres');

const { sendMessage, sendTemplateMessage } = require('../services/twilio');
const { parseUpload } = require('../services/deepDive');
const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState
} = require('../utils/stateManager');



// AI routers
const { routeWithAI } = require('../nlp/intentRouter'); // tool-calls (strict)
const { converseAndRoute } = require('../nlp/conversation');

// NLP task helpers
const { looksLikeTask, parseTaskUtterance } = require('../nlp/task_intents');

// Memory
const { logEvent, getConvoState, saveConvoState, getMemory, upsertMemory } = require('../services/memory');

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

function shouldSkipRouters(res) {
  if (res.headersSent) return true;
  const ia = (res.locals && res.locals.intentArgs) || {};
  return (
    ia.doneTaskNo != null ||
    ia.deleteTaskNo != null ||
    ia.assignTaskNo != null ||
    ia.title
  );
}

function twiml(text) { return `<Response><Message>${text}</Message></Response>`; }
function sendTwiml(res, body) {
  return res
    .status(200)
    .set('Content-Type', 'application/xml')
    .send(`<Response><Message>${body}</Message></Response>`);
}

function getUserTz(userProfile) {
  return userProfile?.timezone || userProfile?.tz || userProfile?.time_zone || 'America/Toronto';
}

// Used by reminder parsing; safe and fast (no 3rd-party tz DB)
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
  return (asLocal - asUtc) / 60000;
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

async function createReminder({ ownerId, userId, taskNo, remindAt, taskTitle }) {
  // Ordered fallbacks: full schema → no created_at → no title → minimal
  const attempts = [
    {
      sql: `INSERT INTO reminders (owner_id, user_id, task_no, title, remind_at, status, created_at)
            VALUES ($1, $2, $3, $4, $5::timestamptz, 'pending', NOW())`,
      params: [ownerId, userId, taskNo, taskTitle || null, remindAt],
      tolerate: [/column\s+"?title"?\s+of\s+relation/i, /column\s+"?created_at"?\s+of\s+relation/i, /column\s+"?status"?\s+of\s+relation/i],
    },
    {
      sql: `INSERT INTO reminders (owner_id, user_id, task_no, title, remind_at, status)
            VALUES ($1, $2, $3, $4, $5::timestamptz, 'pending')`,
      params: [ownerId, userId, taskNo, taskTitle || null, remindAt],
      tolerate: [/column\s+"?title"?\s+of\s+relation/i, /column\s+"?status"?\s+of\s+relation/i],
    },
    {
      sql: `INSERT INTO reminders (owner_id, user_id, task_no, remind_at, status)
            VALUES ($1, $2, $3, $4::timestamptz, 'pending')`,
      params: [ownerId, userId, taskNo, remindAt],
      tolerate: [/column\s+"?status"?\s+of\s+relation/i],
    },
    {
      sql: `INSERT INTO reminders (owner_id, user_id, task_no, remind_at)
            VALUES ($1, $2, $3, $4::timestamptz)`,
      params: [ownerId, userId, taskNo, remindAt],
      tolerate: [],
    },
  ];

  let lastErr = null;
  for (const step of attempts) {
    try {
      await query(step.sql, step.params);
      // success
      return;
    } catch (e) {
      const msg = e?.message || '';
      const tolerated =
        step.tolerate && step.tolerate.some((re) => re.test(msg));
      if (tolerated) {
        // try next shape
        lastErr = e;
        continue;
      }
      // not a tolerated schema error → surface it
      throw e;
    }
  }
  // All attempts failed; surface the last one
  if (lastErr) throw lastErr;
}
/* ---------- Normalization helpers (top-level!) ---------- */

// Text/voice “ask/do” detector used to decide when to send a message to the agent
function looksLikeAskOrDo(txt='') {
  return /^(who|what|where|when|why|how|does|do|can|should|is|are|will|quote|task|clock|job|expense|revenue)\b/i
    .test(String(txt || '').trim());
}

// Strips hidden bidi/formatting chars that often sneak in before '+'
function stripInvisible(s = '') {
  return String(s).replace(/[\u200E\u200F\u202A-\u202E]/g, '');
}

// Clean up typical speech transcription quirks so your existing handlers parse better
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

// Voice “remind me in 2m” → “remind me in 2 minutes” style normalizer
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

// Lightweight “question” detector (used by some of your fast-paths)
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

/* ==== CONTROL INTENT HELPERS (MODULE SCOPE — single source of truth) ==== */
function _sanitize(s) { return String(s || ''); }
function _trimLower(s) { return _sanitize(s).trim().toLowerCase(); }

// STT quirk: "id complete" → "is complete"
function normalizeForControl(s = '') {
  let t = String(s || '');
  t = t.replace(/(\btask\s*#?\s*\d+\s+)\bid\b(?=\s+(complete|completed|done|finished|closed)\b)/gi, '$1is');
  t = t.replace(/(\b#\s*\d+\s+)\bid\b(?=\s+(complete|completed|done|finished|closed)\b)/gi, '$1is');
  return t;
}

/* ---------- ASSIGN ---------- */
// Canonical names
function looksLikeAssign(s = '') { return /^\s*assign\b/i.test(_sanitize(s)); }
function parseAssignUtterance(s = '', opts = {}) {
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

  // Compatibility with the older helper that accepted opts to resolve "last"
  if (!m && opts && (opts.lastTaskNo || opts.pendingTaskNo)) {
    // handle forms like "assign to Jaclyn" (no number)
    m = t.match(/^\s*(?:please\s+)?assign\s+(?:to|for|@)\s+(.+?)\s*$/i);
    if (m) return { taskNo: opts.lastTaskNo || opts.pendingTaskNo, assignee: m[1].trim() };
  }

  return null;
}

// Back-compat aliases (so old calls keep working without edits)
function looksLikeAssignment(s = '') { return looksLikeAssign(s); }
function parseAssignmentUtteranceCompat(s = '', opts = {}) { return parseAssignUtterance(s, opts); }
// If your code elsewhere imports/calls parseAssignmentUtterance by name, keep this exact name:
const parseAssignmentUtteranceExport = parseAssignmentUtteranceCompat;

/* ---------- COMPLETE ---------- */
function looksLikeComplete(s=''){ 
  const t = String(s).toLowerCase();
  return /(?:^|\s)#?\d+/.test(t) && /\b(done|complete|completed|finished|fin)\b/.test(t);
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

/* ---------- DELETE ---------- */
function looksLikeDelete(s = '') {
  const t = _trimLower(s);
  if (/^(?:delete|remove|cancel|trash)\s+(?:task\s*)?#?\d+\b/.test(t)) return true;
  if (/^task\s*#?\s*\d+\s+(?:delete|remove|cancel|trash)\b/.test(t)) return true;
  if (/^(delete|remove|cancel|trash)\s+this\s+task\b/.test(t)) return true;
  return false;
}
function parseDeleteUtterance(s = '') {
  const t = _sanitize(s).trim();

  let m = t.match(/^(?:delete|remove|cancel|trash)\s+(?:task\s*)?#?(\d+)\b/i);
  if (m) return { taskNo: parseInt(m[1], 10) };

  m = t.match(/^task\s*#?\s*(\d+)\s+(?:delete|remove|cancel|trash)\b/i);
  if (m) return { taskNo: parseInt(m[1], 10) };

  m = t.match(/^(?:delete|remove|cancel|trash)\s+this\s+task\b/i);
  if (m) return { taskNo: 'last' };

  return null;
}

/* ---------- CONTROL GATE ---------- */
function looksLikeAnyControl(s = '') {
  const probe = normalizeForControl(s);
  return looksLikeAssign(probe) || looksLikeComplete(probe) || looksLikeDelete(probe);
}
/* ==== END CONTROL INTENT HELPERS ==== */



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

            // ---- REMIND SHORT-CIRCUIT (explicit command) ----
try {
  // defensively normalize
  const _strip = (typeof stripInvisible === 'function') ? stripInvisible : (x) => x;
  const raw = _strip(String(input || '')).trim();
  const lc  = raw.toLowerCase();

  // e.g., "remind me about task #28 in 10 minutes", "set a reminder #5 at 7pm"
  if (/^(remind\b|set\s+(a\s+)?reminder\b)/i.test(lc)) {
    const tz = getUserTz(userProfile);
    const offsetMinutes = getTzOffsetMinutes(tz);

    // Normalize time-y glitches: "in2min" -> "in 2 minutes", strip fillers, etc.
    const maybeNormalized =
      (typeof normalizeTimePhrase === 'function') ? normalizeTimePhrase(raw) : raw;
    const cleaned =
      (typeof cleanSpokenCommand === 'function') ? cleanSpokenCommand(maybeNormalized) : maybeNormalized;

    // Try to find an explicit task number like "#28"
    let m = cleaned.match(/(?:task\s*)?#\s*(\d+)/i);
    let taskNo = m ? parseInt(m[1], 10) : null;

    // If no explicit #, fall back to last known task if available
    if (!taskNo) {
      try {
        const ps = await getPendingTransactionState(from);
        if (ps?.lastTaskNo != null) taskNo = ps.lastTaskNo;
      } catch (_) {}
    }

    // Parse a time using chrono in the user's TZ
    const chrono = require('chrono-node');
    const results = chrono.parse(cleaned, new Date(), { timezone: offsetMinutes, forwardDate: true });

    if (!taskNo || !results[0]) {
      return res.status(200).type('text/xml')
        .send(twiml(
          `Tell me which task and when. For example:\n` +
          `• "remind me about task #28 in 10 minutes"\n` +
          `• "set a reminder #12 at 7pm"`
        ));
    }

    const remindAtIso = results[0].date().toISOString();

    await createReminder({
      ownerId,
      userId: from,
      taskNo,
      taskTitle: `Task #${taskNo}`,
      remindAt: remindAtIso
    });

    const whenStr = new Date(remindAtIso).toLocaleString('en-CA', { timeZone: tz });

    // Log after successful insert
    console.log('[REMINDER] created', {
      ownerId,
      userId: from,
      taskNo,
      remindAtIso,
      whenLocal: whenStr
    });

    return res.status(200).type('text/xml')
      .send(twiml(`⏰ Reminder set for task #${taskNo} at ${whenStr}.`));
  }
} catch (e) {
  console.warn('[REMIND SHORT-CIRCUIT] skipped:', e?.message);
}
// ---- END REMIND SHORT-CIRCUIT ----



            // 🚀 IMMEDIATE TASK FAST-PATH for audio transcripts (not a question)
            try {
              const tasksFn = getHandler && getHandler('tasks');
              if (
  typeof tasksFn === 'function' &&
  ( /^task\b/i.test(cleaned) || (typeof looksLikeTask === 'function' && looksLikeTask(cleaned) && !looksLikeQuestion(cleaned)) )
) {
  const cleanedControlProbe = (typeof normalizeForControl === 'function')
    ? normalizeForControl(cleaned)
    : cleaned;

  // ⛔ Guard: do NOT treat control intents as new tasks
  if (looksLikeAnyControl(cleanedControlProbe)) {

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
// ================= MY / TEAM TASKS — DROP-IN (place before routers) =================

// --- small utils
function _digits(x) { return String(x || '').replace(/\D/g, ''); }
function _cap(s = '') { return s.charAt(0).toUpperCase() + s.slice(1); }
function _chunk(arr, n) { const out = []; for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i, i+n)); return out; }
function _dueHuman(d, tz) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString('en-CA', {
      timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  } catch { return ''; }
}
function _createdHuman(d, tz) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-CA', { timeZone: tz, month: 'short', day: 'numeric' });
  } catch { return ''; }
}

// If you already have getUserBasic(), we’ll cache to avoid repeated lookups.
const __nameCache = {};
async function _displayName(userId) {
  if (!userId) return 'Unassigned';
  const k = _digits(userId);
  if (__nameCache[k]) return __nameCache[k];
  try {
    const row = await getUserBasic(userId).catch(() => null);
    __nameCache[k] = row?.name || k;
  } catch {
    __nameCache[k] = k;
  }
  return __nameCache[k];
}


// ---------- formatters ----------
function formatMyLine(t, tz) {
  const due = _dueHuman(t.due_at, tz);
  return due
    ? `• #${t.task_no} ${_cap((t.title || '').trim())} (due ${due})`
    : `• #${t.task_no} ${_cap((t.title || '').trim())}`;
}

function formatTeamLine(t, tz) {
  const created = _createdHuman(t.created_at, tz);
  const due = _dueHuman(t.due_at, tz);
  const parts = [];
  if (created) parts.push(`created ${created}`);
  if (due) parts.push(`due ${due}`);
  const suffix = parts.length ? ` (${parts.join(', ')})` : '';
  return `• #${t.task_no} ${_cap((t.title || '').trim())}${suffix}`;
}

// Send long lists safely (first chunk via ensureReply, the rest as follow-ups)
async function sendLongListFirstReply({ to, res, header, lines, perChunk = 25 }) {
  const groups = _chunk(lines, perChunk);
  if (groups.length === 0) {
    await ensureReply(res, `${header}\n(none)`);
    return;
  }
  await ensureReply(res, `${header}\n${groups[0].join('\n')}`);
  for (let i = 1; i < groups.length; i++) {
    await sendMessage(to, groups[i].join('\n'));
  }
}

// ---------- handlers ----------
async function handleMyTasksCommand({ ownerId, from, userProfile, res }) {
  const tz = getUserTz(userProfile);
  const rows = await listMyTasks({ ownerId, userId: from, status: 'open' });

  if (!rows.length) {
    await ensureReply(res, `✅ You have no open tasks.`);
    return true;
  }

  const header = `✅ Here's your full task list (${rows.length}):`;
  const lines = rows.map((t) => formatMyLine(t, tz));
  const to = from.startsWith('+') ? `whatsapp:${from}` : from;
  await sendLongListFirstReply({ to, res, header, lines, perChunk: 25 });
  return true;
}

async function handleTeamTasksCommand({ ownerId, from, userProfile, res }) {
  const tz = getUserTz(userProfile);
  const rows = await dbSelectTeamOpenTasks(ownerId);

  if (!rows.length) {
    await ensureReply(res, `✅ Your team has no open tasks.`);
    return true;
  }

  // group by assignee label
  const buckets = new Map();
  for (const t of rows) {
    const label = await _displayName(t.assigned_to);
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(t);
  }
  // sort each bucket by created_at DESC (newest first)
  for (const [label, arr] of buckets) {
    arr.sort((a, b) => {
      const da = a.created_at ? new Date(a.created_at).getTime() : 0;
      const db = b.created_at ? new Date(b.created_at).getTime() : 0;
      return db - da;
    });
  }

  // build lines with sub-headers
  const lines = [];
  for (const [label, arr] of buckets) {
    lines.push(`\n👤 ${label} — ${arr.length} task${arr.length === 1 ? '' : 's'}`);
    for (const t of arr) lines.push(formatTeamLine(t, tz));
  }

  const header = `📋 Team Tasks (grouped by person):`;
  const to = from.startsWith('+') ? `whatsapp:${from}` : from;
  await sendLongListFirstReply({ to, res, header, lines, perChunk: 20 });
  return true;
}

// ---------- command triggers (SHORT-CIRCUIT before routers) ----------
try {
  if (/^\s*my\s+tasks\s*$/i.test(String(input || ''))) {
    const ok = await handleMyTasksCommand({ ownerId, from, userProfile, res });
    if (ok) return; // handled
  }
} catch (e) {
  console.warn('[MY TASKS] failed:', e?.message);
}

try {
  if (/^\s*team\s+tasks\s*$/i.test(String(input || ''))) {
    const ok = await handleTeamTasksCommand({ ownerId, from, userProfile, res });
    if (ok) return; // handled
  }
} catch (e) {
  console.warn('[TEAM TASKS] failed:', e?.message);
}

// ================= END MY / TEAM TASKS — DROP-IN =================

    // ================= TEXT PATH BEGINS =================

// Make sure these exist BEFORE any router blocks reference them
// (prevents "Cannot access 'tenantId' before initialization" / 'state' errors)
const tenantId = ownerId;            // normalized name used by routers
const userId = from;                 // normalized user id (WhatsApp phone)

// Pull current convo state once; reuse it everywhere
const convo = await getConvoState(tenantId, userId).catch(() => ({}));

// Build the light "state" object routers expect
const state = {
  user_id: userId,
  tenant_id: tenantId,
  active_job: convo.active_job || null,
  active_job_id: convo.active_job_id || null,
  aliases: convo.aliases || {},
  history: Array.isArray(convo.history) ? convo.history.slice(-5) : []
};

// tiny helpers (safe to keep here)
function shouldSkipRouters(res) {
  if (!res || res.headersSent) return true;
  const args = (res.locals && res.locals.intentArgs) || {};
  return args.doneTaskNo != null || args.deleteTaskNo != null || args.assignTaskNo != null || !!args.title;
}
function ensureReply(res, text) {
  if (!res.headersSent) res.status(200).type('text/xml').send(`<Response><Message>${text}</Message></Response>`);
}
function twiml(text) { return `<Response><Message>${text}</Message></Response>`; }
function getUserTz(userProfile) {
  return userProfile?.timezone || userProfile?.tz || userProfile?.time_zone || 'America/Toronto';
}

// ========== EARLY MICRO-FLOWS ==========

// Early YES/NO handler for task offers
try {
  const lc = String(input || '').trim().toLowerCase();
  if (lc === 'yes' || lc === 'no') {
    const ps = await getPendingTransactionState(from);
    if (ps?.pendingTaskOffer?.taskNo && ps?.pendingTaskOffer?.ownerId) {
      const { taskNo, ownerId: offerOwnerId, title } = ps.pendingTaskOffer;
      const accepted = (lc === 'yes');
      const assigneeId = String(from).replace(/\D/g, '');
      const ownerDigits = String(offerOwnerId).replace(/\D/g, '');

      await query(
        `UPDATE public.tasks
            SET acceptance_status = $4, updated_at = NOW()
          WHERE owner_id = $1 AND task_no = $2 AND assigned_to = $3`,
        [offerOwnerId, taskNo, assigneeId, accepted ? 'accepted' : 'declined']
      );
      try {
        await sendMessage(ownerDigits, `📣 ${assigneeId} ${accepted ? 'accepted' : 'declined'} task #${taskNo}${title ? `: ${title}` : ''}`);
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

// ========== CONTROL FAST-PATHS (ORDER MATTERS) ==========

// 1) ASSIGN — must run before any create
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

      const handled = await tasksHandler(from, `__assign__ #${taskNo} to ${assignee}`, userProfile, ownerId, ownerProfile, isOwner, res);
      if (!res.headersSent && handled !== false) ensureReply(res, `Assigning task #${taskNo} to ${assignee}…`);
      return;
    }
  }
} catch (e) {
  console.warn('[ASSIGN FAST-PATH] skipped:', e?.message);
}

// 2) COMPLETE — must run before any create
try {
  if (typeof input === 'string' && looksLikeComplete(normalizeForControl(input))) {
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

      const handled = await tasksHandler(from, `__done__ #${taskNo}`, userProfile, ownerId, ownerProfile, isOwner, res);
      if (!res.headersSent && handled !== false) ensureReply(res, `Completing task #${taskNo}…`);
      console.log('[CONTROL] completing via fast-path for', from, '→', input);
      return;
    }
  }
} catch (e) {
  console.warn('[COMPLETE FAST-PATH] skipped:', e?.message);
}

// 3) DELETE — must run before any create
try {
  if (typeof input === 'string' && looksLikeDelete(normalizeForControl(input))) {
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

      const handled = await tasksHandler(from, `__delete__ #${taskNo}`, userProfile, ownerId, ownerProfile, isOwner, res);
      if (!res.headersSent && handled !== false) ensureReply(res, `Deleting task #${taskNo}…`);
      return;
    }
  }
} catch (e) {
  console.warn('[DELETE FAST-PATH] skipped:', e?.message);
}

// 4) CREATE — last, and only if NOT a control phrase
try {
  const bodyTxt = String(input || '');
  const controlProbe = normalizeForControl(bodyTxt);

  if (
    !mediaUrl &&
    !looksLikeAnyControl(controlProbe) &&
    (/^task\b/i.test(bodyTxt) || (typeof looksLikeTask === 'function' && looksLikeTask(bodyTxt)))
  ) {
    try { await deletePendingTransactionState(from); } catch (_) {}

    const parsed = parseTaskUtterance(bodyTxt, { tz: getUserTz(userProfile), now: new Date() });
    console.log('[TASK FAST-PATH] parsed', parsed); // ← keep this while debugging

    if (!parsed) throw new Error('Could not parse task intent');

    res.locals = res.locals || {};
    res.locals.intentArgs = {
      title: parsed.title,
      dueAt: parsed.dueAt,
      assigneeName: parsed.assignee
    };
    console.log('[CREATE] fast-path create for', from, '→', bodyTxt);
    return tasksHandler(from, bodyTxt, userProfile, ownerId, ownerProfile, isOwner, res);
  }
} catch (e) {
  console.warn('[WEBHOOK] fast-path tasks failed:', e?.message);
}

// === JOB CONFIRM SHORT-CIRCUIT (must be early) ===
try {
  const pending = await getPendingTransactionState(from).catch(() => null);
  const isTextOnly = !mediaUrl && !!input;
  if (
    isTextOnly &&
    pending?.jobFlow &&
    pending.jobFlow.action === 'create' &&
    pending.jobFlow.name
  ) {
    const lc = String(input || '').trim().toLowerCase();
    const yes  = /^(yes|y|create|ok|okay|👍)$/i.test(lc);
    const no   = /^(no|n|cancel|stop|abort|✖️|❌)$/i.test(lc);
    const edit = /^(edit|change|rename)$/i.test(lc);

    if (yes || no || edit) {
      await handleJob(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
      return; // do not let any other intercept/router process this
    }
  }
} catch (e) {
  console.warn('[JOB CONFIRM INTERCEPT] failed:', e?.message);
}

 // === REMINDERS-FIRST & PENDING SHORT-CIRCUITS ===
try {
  const pendingState = await getPendingTransactionState(from);
  const isTextOnly = !mediaUrl && !!input;

  // 🚫 NEW: if a job create/confirm flow is in progress, do NOT let reminders intercept
  if (
    isTextOnly &&
    pendingState?.jobFlow &&
    pendingState.jobFlow.action === 'create' &&
    pendingState.jobFlow.name
  ) {
    console.log('[REMINDER] skip: jobFlow active → letting job handler process:', input);
    // Just fall through and let downstream routers/handlers take this message.
  } else if (pendingState?.pendingReminder && isTextOnly) {
    // (existing logic) Only run the reminder intercept when no jobFlow is active
    const { pendingReminder } = pendingState;
    console.log('[REMINDER] intercept for', from, 'input =', input);

    // 1) Normalize common voice-typo patterns like "in2min" → "in 2 minutes"
    const maybeNormalized = (typeof normalizeTimePhrase === 'function')
      ? normalizeTimePhrase(String(input || ''))
      : String(input || '');
    const cleanedInput = (typeof cleanSpokenCommand === 'function')
      ? cleanSpokenCommand(maybeNormalized)
      : maybeNormalized;

    const lc = cleanedInput.trim().toLowerCase();

    // 2) Decide if this looks like a reply in the reminder flow
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
      const offsetMinutes = getTzOffsetMinutes(tz);

      const results = chrono.parse(cleanedInput, new Date(), {
        timezone: offsetMinutes,
        forwardDate: true
      });

      if (!results || !results[0]) {
        // One more leniency pass for "in2min", "in2 minutes", etc.
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
// === "MY TASKS" / "TEAM TASKS" SHORT-CIRCUITS (before routers) ===
try {
  if (!mediaUrl && typeof input === 'string') {
    const raw = input.trim();
    const lc  = raw.toLowerCase();

    // Helper: chunk long lists into multiple messages
    async function _sendChunked(to, header, lines, chunkSize = 18) {
      // 18 lines per message is a safe compromise for WhatsApp/SMS
      for (let i = 0; i < lines.length; i += chunkSize) {
        const part = lines.slice(i, i + chunkSize);
        const prefix = (i === 0) ? header : '…continued';
        await sendMessage(to, `${prefix}\n${part.join('\n')}`);
      }
    }

    // Helper: pretty due
    function _fmtDue(d, tz) {
      if (!d) return '';
      try {
        return new Date(d).toLocaleString('en-CA', {
          timeZone: tz, month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit'
        });
      } catch { return ''; }
    }

    // --- MY TASKS ---
if (/^\s*(my\s+tasks|tasks\s+mine|show\s+my\s+tasks)\s*$/i.test(lc)) {
  const tz = getUserTz(userProfile);
  const me = from;

  let rows = [];
  try {
    rows = await listMyTasks({ ownerId, userId: me, status: 'open' });
  } catch (e) {
    console.warn('[MY TASKS] failed:', e?.message);
  }

  if (!rows || rows.length === 0) {
    return res.status(200).type('text/xml')
      .send(twiml(`✅ You're all caught up! (no open tasks)`));
  }

  const lines = rows.map(t => {
    const due = _fmtDue(t.due_at, tz);              // keep your existing formatter
    const dueTxt = due ? ` (due ${due})` : '';
    return `• #${t.task_no} ${t.title}${dueTxt}`;
  });

  await _sendChunked(from, `✅ Here's what's on your plate:`, lines, 18);
  return res.status(200).type('text/xml').send('<Response></Response>');
}


    // --- TEAM TASKS ---
    if (/^\s*(team\s+tasks|tasks\s+team|show\s+team\s+tasks)\s*$/i.test(lc)) {
      const { listAllOpenTasksByAssignee } = require('../services/postgres'); // path as in your project
      const tz = getUserTz(userProfile);

      let rows = [];
      try {
        rows = await listAllOpenTasksByAssignee({ ownerId });
      } catch (e) {
        console.warn('[TEAM TASKS] failed:', e?.message);
      }

      if (!rows || rows.length === 0) {
        return res.status(200).type('text/xml')
          .send(twiml(`✅ No open team tasks — nice!`));
      }

      // Group by assignee_name (null/empty => "Unassigned")
      const groups = new Map();
      for (const t of rows) {
        const key = (t.assignee_name && String(t.assignee_name).trim()) || 'Unassigned';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
      }

      // Build lines by group; one big list we will chunk
      const allLines = [];
      for (const [who, list] of groups.entries()) {
        allLines.push(`— ${who} —`);
        for (const t of list) {
          const due = _fmtDue(t.due_at, tz);
          const dueTxt = due ? ` (due ${due})` : '';
          allLines.push(`• #${t.task_no} ${t.title}${dueTxt}`);
        }
        allLines.push(''); // blank line between groups
      }
      // remove trailing blank
      if (allLines[allLines.length - 1] === '') allLines.pop();

      await _sendChunked(from, `👥 Team tasks (open):`, allLines, 20);
      return res.status(200).type('text/xml').send('<Response></Response>');
    }
  }
} catch (e) {
  console.warn('[TASKS LIST SHORT-CIRCUIT] skipped:', e?.message);
}


// === CONTEXTUAL HELP (FAQ intercept) — must run BEFORE generic helpers/NLP ===
try {
  const pending = await getPendingTransactionState(from).catch(() => null);

  // 👇 Guard: do not intercept while job confirmation is active
  if (pending?.jobFlow && pending.jobFlow.action === 'create' && pending.jobFlow.name) {
    // fall through to normal router
  } else if (pending?.helpTopic?.key && looksLikeHelpFollowup(input)) {
    const { key, context } = pending.helpTopic;
    const article = HELP_ARTICLES[key];
    if (typeof article === 'function') {
      try { await setPendingTransactionState(from, { ...pending, helpTopic: null }); } catch {}
      return res.status(200).type('text/xml').send(twiml(article(context)));
    }
    try { await setPendingTransactionState(from, { ...pending, helpTopic: null }); } catch {}
  }
} catch (e) {
  console.warn('[HELP ROUTER] failed:', e?.message);
}

// === TEAM SHORT-CIRCUIT (text-only, before NLP & task fast-paths) ===
try {
  if (!mediaUrl && typeof input === 'string') {
    const raw = input.trim();
    const _strip = (typeof stripInvisible === 'function') ? stripInvisible : (x) => x;
    const cleaned = _strip(raw);
    const lc = cleaned.toLowerCase();

    const looksTeamList   = /^\s*team\s*$/.test(lc);
    const looksTeamAdd    = /^\s*add\s+(?:team(?:mate|(?:\s*member))|member)\b/.test(lc);
    const looksTeamRemove = /^\s*remove\s+(?:team(?:mate|(?:\s*member))|member)\b/.test(lc);

    if (looksTeamList || looksTeamAdd || looksTeamRemove) {
      console.log('[TEAM SHORT-CIRCUIT] hit', { cleaned });
      const teamFn = getHandler && getHandler('team');
      if (typeof teamFn === 'function') {
        const out = await teamFn(from, cleaned, userProfile, ownerId, ownerProfile, isOwner, res);
        if (res.headersSent) return;
        if (typeof out === 'string' && out.trim().startsWith('<Response>')) {
          return res.status(200).type('text/xml').send(out);
        }
        if (out && typeof out === 'object' && typeof out.twiml === 'string') {
          return res.status(200).type('text/xml').send(out.twiml);
        }
        if (out) return res.status(200).type('text/xml').send('<Response><Message></Message></Response>');
        return;
      } else {
        console.warn('[TEAM SHORT-CIRCUIT] team handler not found or not a function');
      }
    }
  }
} catch (e) {
  console.warn('[TEAM SHORT-CIRCUIT] skipped:', e?.message);
}
// === END TEAM SHORT-CIRCUIT ===

// ---------- INTENT-GUARD: skip system flows/routers if a fast-path already decided ----------
if (shouldSkipRouters(res)) {
  // A fast-path handled (or decided) this turn. Stop here.
  return;
}

/* ================= SYSTEM FLOWS (run BEFORE routers) ================= */

// 0) Onboarding
try {
  const lc0 = String(input || '').toLowerCase();
  if ((userProfile && userProfile.onboarding_in_progress) || lc0.includes('start onboarding')) {
    const response = await handleOnboarding(from, input, userProfile, ownerId, res);
    await logEvent(tenantId, userId, 'onboarding', { input, response });
    await saveConvoState(tenantId, userId, {
      history: [...(convo.history || []).slice(-4), { input, response, intent: 'onboarding' }]
    });
    ensureReply(res, `Welcome to Chief AI! Quick question — what's your name?`);
    return;
  }
} catch (e) {
  console.warn('[ONBOARDING] skipped:', e?.message);
}

// 0.5) Owner approval
try {
  if (/^approve\s+/i.test(input || '')) {
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
} catch (e) {
  console.warn('[OWNER APPROVAL] skipped:', e?.message);
}

// 1) Upgrade flow (Stripe)
try {
  const lc1 = String(input || '').toLowerCase();
  const wantsUpgrade = lc1.includes('upgrade to pro') || lc1.includes('upgrade to enterprise');
  if (wantsUpgrade) {
    try {
      if (userProfile?.stripe_subscription_id) {
        await sendMessage(from, `⚠️ You already have an active ${userProfile.subscription_tier} subscription. Contact support to change plans.`);
        ensureReply(res, 'Already subscribed!');
        return;
      }
      const tier = lc1.includes('pro') ? 'pro' : 'enterprise';
      const priceId   = tier === 'pro' ? process.env.PRO_PRICE_ID : process.env.ENTERPRISE_PRICE_ID;
      const priceText = tier === 'pro' ? '$29' : '$99';

      const customer = await stripe.customers.create({ phone: from, metadata: { user_id: userProfile.user_id } });
      const paymentLink = await stripe.paymentLinks.create({
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { user_id: userProfile.user_id }
      });

      await query(
        `UPDATE users SET stripe_customer_id=$1, subscription_tier=$2 WHERE user_id=$3`,
        [customer.id, tier, userProfile.user_id]
      );

      await sendTemplateMessage(from, process.env.HEX_UPGRADE_NOW, [
        `Upgrade to ${tier} for ${priceText}/month CAD: ${paymentLink.url}`
      ]);
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
} catch (e) {
  console.warn('[UPGRADE] skipped:', e?.message);
}

// 2) DeepDive / historical upload
try {
  const lc2 = String(input || '').toLowerCase();
  const triggersDeepDive = lc2.includes('upload history') || lc2.includes('historical data') ||
                           lc2.includes('deepdive') || lc2.includes('deep dive');

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
} catch (e) {
  console.warn('[DEEPDIVE] skipped:', e?.message);
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
  console.warn('[TIMECLOCK PROMPT] skipped:', e?.message);
}

// 3.6) PRIORITY: Direct timeclock route on explicit timeclock language
try {
  if (isTimeclockMessage(input)) {
    const normalized = normalizeTimeclockInput(input, userProfile);
    await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
    await logEvent(tenantId, userId, 'timeclock_direct', { normalized });
    if (!res.headersSent) ensureReply(res, '✅ Timeclock request received.');
    return;
  }
} catch (e) {
  console.warn('[TIMECLOCK DIRECT] skipped:', e?.message);
}

/* ================= END SYSTEM FLOWS ================= */

// ---------- INTENT-GUARD again, just before routers ----------
if (shouldSkipRouters(res)) return;
// ========= AGENT “ASK/DO” GATE (before Conversational router) =========
try {
  const hasMedia = !!(mediaUrl && mediaType);
  const isAsk = (str) => {
    const s = String(str || '');
    const qLike = /[?]$|\b(how|what|when|why|where|explain|help|what can i do( here)?|what now)\b/i;
    return qLike.test(s);
  };

  if (!hasMedia && typeof input === 'string' && looksLikeAskOrDo(input) && isAsk(input)) {
    const defaultMenu =
      'Here’s what I can help with:\n\n' +
      '• Jobs — create job, list jobs, set active job <name>, active job?, close job <name>, move last log to <name>\n' +
      '• Tasks — task – buy nails, task Roof Repair – order shingles, task @Justin – pick up materials, tasks / my tasks, done #4, add due date Friday to task 3\n' +
      '• Timeclock — clock in/out, start/end break, start/end drive, timesheet week, clock in Justin @ Roof Repair 5pm';

    const reply = await agentAsk({
      from: from,
      text: input,
      topicHints: ['timeclock', 'jobs', 'tasks', 'shared_contracts'],
    });

    const out = (reply && typeof reply === 'string') ? reply.trim() : '';
    return sendTwiml(res, out || defaultMenu); // <-- ALWAYS reply here
  }
} catch (e) {
  console.warn('[AGENT GATE] error:', e?.message);
  const fallback =
    'Quick help:\n' +
    '• Jobs — create job <name>\n' +
    '• Tasks — task – buy nails\n' +
    '• Timeclock — clock in / out';
  return sendTwiml(res, fallback); // <-- ALWAYS reply on error too
}
// ========= END AGENT GATE =========





/* ---------- Conversational router ---------- */
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
      const normalizedTC = normalizeTimeclockInput(conv.normalized, userProfile);
      handled = await handleTimeclock(from, normalizedTC, userProfile, ownerId, ownerProfile, isOwner, res, extras);
      responseText = responseText || '✅ Timeclock request received.';
      await logEvent(tenantId, userId, 'timeclock', { normalized: normalizedTC, args: conv.args || {} });
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

/* ---------- AI intent router (tool-calls) ---------- */
try {
  if (!shouldSkipRouters(res)) {
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
  }
} catch (e) {
  console.warn('[AI Router] skipped due to error:', e?.message);
}

/* ---------- Legacy NLP routing (conversation.js) ---------- */
try {
  if (!shouldSkipRouters(res)) {
    const routed = await converseAndRoute(input, {
      userProfile,
      ownerId: tenantId,
      convoState: state,
      memory
    });

    if (routed) {
      // If a downstream handler already produced TwiML:
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
          if (!res.headersSent) {
            return res.status(200).type('text/xml').send(`<Response><Message>${responseText}</Message></Response>`);
          }
          return;
        }
      }
    }
  }

  // ----- Last-resort fallback (no one replied) -----
  if (!res.headersSent) {
    console.warn('[WEBHOOK] No handler replied; sending default menu.');
    return sendTwiml(res,
      'Here’s what I can help with:\n\n' +
      '• Jobs — create job, list jobs, set active job <name>, active job?, close job <name>, move last log to <name>\n' +
      '• Tasks — task – buy nails, task Roof Repair – order shingles, task @Justin – pick up materials, tasks / my tasks, done #4, add due date Friday to task 3\n' +
      '• Timeclock — clock in/out, start/end break, start/end drive, timesheet week, clock in Justin @ Roof Repair 5pm'
    );
  }

} catch (error) {
  console.error(`[ERROR] Webhook processing failed for ${maskPhone(from)}:`, error.message);
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
