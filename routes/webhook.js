// routes/webhook.js
// Single Express router that owns raw-body parsing, Twilio-friendly responses,
// lightweight middlewares, and tolerant fallbacks.

const express = require('express');
const app = express();
const router = express.Router();
const querystring = require('querystring');

// ---------- Helpers ----------
const xml = (s = '') => `<Response><Message>${String(s)}</Message></Response>`;
const ok = (res, text = 'OK') => {
  if (res.headersSent) return;
  res.status(200).type('application/xml').send(xml(text));
};
const normalizePhone = (raw = '') =>
  String(raw || '').replace(/^whatsapp:/i, '').replace(/\D/g, '') || null;

function pickFirstMedia(body = {}) {
  const n = parseInt(body.NumMedia || '0', 10) || 0;
  if (n <= 0) return { n: 0, url: null, type: null };
  const url = body.MediaUrl0 || body.MediaUrl || null;
  const typ = body.MediaContentType0 || body.MediaContentType || null;
  return { n, url, type: typ ? String(typ).toLowerCase() : null };
}

function canUseAgent(profile) {
  const tier = (profile?.subscription_tier || profile?.plan || '').toLowerCase();
  return tier && tier !== 'basic' && tier !== 'free';
}

// ---------- Raw body parser (Twilio signature needs original payload) ----------
router.use((req, _res, next) => {
  if (req.method !== 'POST') return next();

  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const isForm = ct.includes('application/x-www-form-urlencoded');
  if (!isForm) return next();

  // If something upstream already set rawBody + body, don't re-parse.
  if (req.body && Object.keys(req.body).length && typeof req.rawBody === 'string') return next();

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', chunk => {
    raw += chunk;
    // Hard cap ~1MB
    if (raw.length > 1_000_000) req.destroy();
  });
  req.on('end', () => {
    req.rawBody = raw;
    try { req.body = raw ? querystring.parse(raw) : {}; }
    catch { req.body = {}; }
    next();
  });
  req.on('error', () => { req.rawBody = raw || ''; req.body = {}; next(); });
});

// ---------- Non-POST guard ----------
router.all('*', (req, res, next) => {
  if (req.method === 'POST') return next();
  return ok(res, 'OK');
});

// ---------- Identity & canonical URL ----------
router.use((req, _res, next) => {
  req.from = req.body?.From ? normalizePhone(req.body.From) : null;
  req.ownerId = req.from || 'GLOBAL';
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host  = (req.headers['x-forwarded-host']  || req.headers.host || '').split(',')[0].trim();
  // Use the *actual* path+query Twilio called (what it signs)
  const path  = req.originalUrl || req.url || '/api/webhook';
  req.twilioUrl = `${proto}://${host}${path}`;
   next();
 });

// ---------- 8s Safety Timer ----------
router.use((req, res, next) => {
  if (res.locals._safety) return next();
  res.locals._safety = setTimeout(() => {
    if (!res.headersSent) {
      console.warn('[WEBHOOK] 8s safety reply');
      ok(res, 'OK');
    }
  }, 8000);
  const clear = () => clearTimeout(res.locals._safety);
  res.on('finish', clear);
  res.on('close', clear);
  next();
});

// ---------- Fast-path: version ----------
router.post('*', (req, res, next) => {
  console.log('[ROUTER] version');   // 👈 add here
  const bodyText = String(req.body?.Body || '').trim().toLowerCase();
  if (bodyText === 'version') {
    const v = process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'dev-local';
    return ok(res, `build ${String(v).slice(0, 7)} OK`);
  }
  next();
});

// ---------- Light middlewares (lazy) ----------
router.use((req, res, next) => {
  try {
    const token = require('../middleware/token');
    const prof = require('../middleware/userProfile');
    const lock = require('../middleware/lock');
    token.tokenMiddleware(req, res, () =>
      prof.userProfileMiddleware(req, res, () =>
        lock.lockMiddleware(req, res, next)
      )
    );
  } catch (e) {
    console.warn('[WEBHOOK] light middlewares skipped:', e?.message);
    next();
  }
});

// ---------- Media Handler ----------
router.post('*', async (req, res, next) => {
  console.log('[ROUTER] media');
  const { n, url, type } = pickFirstMedia(req.body || {});
  if (n <= 0) return next();

  try {
    const media = require('../handlers/media');
    const contentType = (type || '').split(';')[0];

    // AUDIO → transcribe
    if (contentType.startsWith('audio/')) {
      let transcript = '';
      const transcribe =
        media.transcribe || media.transcriber || media.transcribeAudio || media.handleMedia;
      if (typeof transcribe === 'function') {
        transcript = await transcribe(url, { from: req.from, ownerId: req.ownerId });
      }
      if (transcript?.trim()) {
        req.body.Body = transcript.trim();
        return next();
      }
      return ok(res, `I couldn't understand that audio. Try texting.`);
    }

    // IMAGE → parse receipt
    if (contentType.startsWith('image/')) {
      let parsed = null;
      if (typeof media.parseReceipt === 'function') {
        parsed = await media.parseReceipt(url, { from: req.from, ownerId: req.ownerId });
      } else {
        const deep = require('../services/deepDive');
        if (typeof deep.parseUpload === 'function') {
          parsed = await deep.parseUpload(url, { from: req.from, ownerId: req.ownerId });
        }
      }
      if (parsed && typeof parsed === 'object') {
        const lines = [
          'Receipt captured:',
          parsed.date ? `• ${parsed.date}` : null,
          parsed.store ? `• ${parsed.store}` : null,
          parsed.item ? `• ${parsed.item}` : null,
          parsed.amount ? `• ${parsed.amount}` : null,
        ].filter(Boolean).join('\n');
        return ok(res, lines || 'Receipt captured.');
      }
      return ok(res, 'Got your image — thanks!');
    }

    return ok(res, 'File received.');
  } catch (e) {
    console.error('[MEDIA] error:', e?.message);
    return ok(res, 'Media processed.');
  }
});

// ---------- TEXT ROUTING ----------
router.post('*', async (req, res, next) => {
  console.log('[ROUTER] text');
  try {
    const text = String(req.body?.Body || '').trim();
    const lc = text.toLowerCase();

    // Heuristic: user is asking for help/how-to
    const askingHow = /\b(how (do|to) i|how to|help with|how do i use|how can i use)\b/.test(lc);

    // Intent detectors
    let looksTask = /^task\b/.test(lc) || /\btasks?\b/.test(lc);
    let looksJob  = /\b(job|jobs|active job|set active|close job|list jobs|move last log)\b/.test(lc);
    let looksTime = /\b(time\s*clock|timeclock|clock|punch|break|drive|timesheet|hours)\b/.test(lc);

    // Nudge intents when user literally asks how to use a module
    if (askingHow && /\btasks?\b/.test(lc)) looksTask = true;
    if (askingHow && /\b(time\s*clock|timeclock)\b/.test(lc)) looksTime = true;
    if (askingHow && /\bjobs?\b/.test(lc)) looksJob = true;

    const topicHints = [
      looksTask ? 'tasks' : null,
      looksJob  ? 'jobs' : null,
      looksTime ? 'timeclock' : null,
    ].filter(Boolean);

    // Quick SOP fallbacks for "how do I use …" when a handler doesn't write a response
    const SOP = {
      tasks:
        'Tasks — Quick guide:\n' +
        '• Create: task - buy nails\n' +
        '• List mine: my tasks\n' +
        '• Complete: done #4\n' +
        '• Assign: task @<phone> - pickup shingles\n' +
        '• Due date: task - call client | due tomorrow 4pm',
      timeclock:
        'Timeclock — Quick guide:\n' +
        '• Clock in: clock in (uses active job) or clock in @ Roof Job\n' +
        '• Break/Drive: break start/stop; drive start/stop\n' +
        '• Clock out: clock out\n' +
        '• Timesheet: timesheet week',
      jobs:
        'Jobs — Quick guide:\n' +
        '• Create: create job Roof Repair\n' +
        '• Set active: set active job Roof Repair\n' +
        '• List: list jobs\n' +
        '• Close: close job Roof Repair',
    };

    const cmds = require('../handlers/commands');
    const tasksHandler    = cmds.tasks     || require('../handlers/commands/tasks').tasksHandler;
    const handleJob       = cmds.job       || require('../handlers/commands/job');
    const handleTimeclock = cmds.timeclock || require('../handlers/commands/timeclock').handleTimeclock;

    // TASKS
    if (looksTask && typeof tasksHandler === 'function') {
      const out = await tasksHandler(req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res);
      if (!res.headersSent) {
        // Prefer handler text; else SOP if askingHow; else generic
        const msg = (typeof out === 'string' && out.trim())
          ? out.trim()
          : (askingHow ? SOP.tasks : 'Task handled.');
        return ok(res, msg);
      }
      return;
    }

    // JOBS
    if (looksJob && typeof handleJob === 'function') {
      const out = await handleJob(req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res);
      if (!res.headersSent) {
        const msg = (typeof out === 'string' && out.trim())
          ? out.trim()
          : (askingHow ? SOP.jobs : 'Job handled.');
        return ok(res, msg);
      }
      return;
    }

    // TIMECLOCK
    if (looksTime && typeof handleTimeclock === 'function') {
      const out = await handleTimeclock(req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res);
      if (!res.headersSent) {
        const msg = (typeof out === 'string' && out.trim())
          ? out.trim()
          : (askingHow ? SOP.timeclock : 'Time logged.');
        return ok(res, msg);
      }
      return;
    }

    // AGENT (subscription-gated)
    if (canUseAgent(req.userProfile)) {
      try {
        const { ask } = require('../services/agent');
        if (typeof ask === 'function') {
          const answer = await Promise.race([
            ask({ from: req.from, text, topicHints }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
          ]).catch(() => '');
          if (answer?.trim()) return ok(res, answer);
        }
      } catch (e) {
        console.warn('[AGENT] failed:', e?.message);
      }
    }

    // DEFAULT HELP
    return ok(res,
      'PocketCFO — What I can do:\n' +
      '• Jobs: create job Roof Repair, set active job Roof Repair\n' +
      '• Tasks: task - buy nails, my tasks, done #4\n' +
      '• Time: clock in, clock out, timesheet week'
    );
  } catch (err) {
    return next(err);
  }
});

// ---------- Final fallback – always 200 TwiML ----------
router.use((req, res, next) => {
  if (!res.headersSent) {
    console.warn('[WEBHOOK] fell-through fallback');
    return ok(res, 'OK');
  }
  next();
});

// ---------- Error middleware – tolerant (lazy load) ----------
try {
  const { errorMiddleware } = require('../middleware/error');
  router.use(errorMiddleware);
} catch {
  // no-op – keep the webhook alive
}

// ---------- Export as plain Node handler (Vercel default export consumes this) ----------
app.use('/', router);
module.exports = (req, res) => app.handle(req, res);
