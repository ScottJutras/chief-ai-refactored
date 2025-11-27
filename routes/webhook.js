// routes/webhook.js
// Serverless-safe WhatsApp webhook router (Twilio form posts)
// Aligned with North Star: tolerant, lazy deps, quick fallbacks, confirm/undo friendly.

const express = require('express');
const querystring = require('querystring');
const router = express.Router();
const app = express();
const { findClosestTerm } = require('../services/ragTerms');
const { flags } = require('../config/flags');
const { handleClock } = require('../handlers/commands/timeclock');
const { handleForecast } = require('../handlers/commands/forecast');
const { applyCIL } = require('../services/cilRouter');
const { getOwnerUuidForPhone } = require('../services/owners'); // implement: map phone -> uuid
const { getPendingTransactionState } = require('../utils/stateManager');
const { handleMedia } = require('../handlers/media');

// ---------- Small helpers ----------
function xmlEsc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const xml = (s = '') => `<Response><Message>${xmlEsc(s)}</Message></Response>`;
const ok = (res, text = 'OK') => {
  if (res.headersSent) return;
  res.status(200).type('application/xml; charset=utf-8').send(xml(text));
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
  return !!tier && tier !== 'basic' && tier !== 'free';
}

// ---------- Raw urlencoded parser (Twilio signature expects original body) ----------
router.use((req, _res, next) => {
  if (req.method !== 'POST') return next();
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const isForm = ct.includes('application/x-www-form-urlencoded');
  if (!isForm) return next();
  if (req.body && Object.keys(req.body).length && typeof req.rawBody === 'string') return next();

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', chunk => {
    raw += chunk;
    if (raw.length > 1_000_000) req.destroy(); // 1MB guard
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

// ---------- Identity + canonical URL (for Twilio signature verification) ----------
router.use((req, _res, next) => {
  req.from = req.body?.From ? normalizePhone(req.body.From) : null;
  req.ownerId = req.from || 'GLOBAL';

  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const path = req.originalUrl || req.url || '/api/webhook';
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

// ---------- Quick version check ----------
router.post('*', (req, res, next) => {
  const bodyText = String(req.body?.Body || '').trim().toLowerCase();
  if (bodyText === 'version') {
    const v = process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'dev-local';
    return ok(res, `build ${String(v).slice(0, 7)} OK`);
  }
  next();
});

// ---------- Light middlewares (lazy import; never hard-fail) ----------
router.use((req, res, next) => {
  try {
    const token = require('../middleware/token');
    const prof  = require('../middleware/userProfile');
    const lock  = require('../middleware/lock');
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

// ---------- Pending Action interceptor (confirm/undo) ----------
try {
  const { pendingActionMiddleware } = require('../middleware/pendingAction');
  router.post('*', pendingActionMiddleware);
} catch (e) {
  console.warn('[WEBHOOK] pendingActionMiddleware unavailable:', e?.message);
}

// ---------- Media ingestion (audio/image → handleMedia) ----------
router.post('*', async (req, res, next) => {
  const { n, url, type } = pickFirstMedia(req.body || {});
  if (n <= 0) return next();

  try {
    const { handleMedia } = require('../handlers/media');
    const bodyText = String(req.body?.Body || '').trim();

    const result = await handleMedia(
      req.from,             // normalized phone
      bodyText,             // any caption text
      req.userProfile || {},// profile from middleware
      req.ownerId,          // owner id (UUID after mapping)
      url,
      type
    );

    // Case 1: TwiML string
    if (typeof result === 'string' && result && !res.headersSent) {
      return res
        .status(200)
        .type('application/xml; charset=utf-8')
        .send(result);
    }

    // Case 2: object with transcript → push into text pipeline
    if (result && typeof result === 'object' && result.transcript) {
      req.body.Body = result.transcript;  // overwrite with STT text
      return next();                      // continue into text routing
    }

    // If handleMedia chose not to respond, fall through to text routing
    return next();
  } catch (e) {
    console.error('[MEDIA] error:', e?.message);
    if (!res.headersSent) {
      return ok(res, 'Media processed.');
    }
  }
});

// ---------- Main text router (tasks / jobs / timeclock / agent) ----------
router.post('*', async (req, res, next) => {
  // Map phone → UUID owner id as early as possible (for CIL/domain)
  if (!req.ownerId || /^[0-9]+$/.test(String(req.ownerId))) {
    try {
      const mapped = await getOwnerUuidForPhone(req.from);
      if (mapped) req.ownerId = mapped;
    } catch (e) {
      console.warn('[WEBHOOK] owner uuid map failed:', e?.message);
    }
  }

  try {
    // 1) If this user has a pending *media* flow, let handlers/media.js
    // resolve the "yes/no/today/this week…" reply first.
    const pending = await getPendingTransactionState(req.from);
    const hasPendingMedia = pending && pending.pendingMedia;
    const numMedia = parseInt(req.body?.NumMedia || '0', 10) || 0;

    if (hasPendingMedia && numMedia === 0) {
      const bodyText = String(req.body?.Body || '').trim();
      const result = await handleMedia(
        req.from,
        bodyText,
        req.userProfile || {},
        req.ownerId,
        null, // no mediaUrl
        null  // no mediaType
      );

      if (result) {
        // case 1: handleMedia returned a full TwiML response string
        if (typeof result === 'string' && !res.headersSent) {
          return res
            .status(200)
            .type('application/xml; charset=utf-8')
            .send(result);
        }

        // case 2: handleMedia returned transcript only → allow task/job/timeclock/agent to continue
        if (result.transcript && !result.twiml) {
          req.body.Body = result.transcript;
          // Fall through into the existing logic below
        } else {
          // Did something, but didn't return explicit XML, so stop
          return;
        }
      }
    }

    // 2) Normal text pipeline
    const text = String(req.body?.Body || '').trim();
    const lc = text.toLowerCase();

    // --- SPECIAL: "How did the XYZ job do?" → job KPIs ---
    if (/how\b.*\bjob\b/.test(lc)) {
      try {
        const { handleJobInsights } = require('../handlers/commands/job_insights');
        const msg = await handleJobInsights({
          ownerId: req.ownerId,
          text,
        });

        return res
          .status(200)
          .type('application/xml; charset=utf-8')
          .send(`<Response><Message>${msg}</Message></Response>`);
      } catch (e) {
        console.error('[WEBHOOK] job_insights failed:', e?.message);
        // fall through to normal handlers/agent if something blows up
      }
    }

    async function glossaryNudgeFrom(str) {
      const { findClosestTerm } = require('../services/glossary');
      const words = String(str || '').toLowerCase().match(/[a-z0-9_-]+/g) || [];
      for (const w of words) {
        const hit = await findClosestTerm(w);
        if (hit?.nudge) return `\n\nTip: ${hit.nudge}`;
      }
      return '';
    }

    const askingHow = /\b(how (do|to) i|how to|help with|how do i use|how can i use)\b/.test(lc);

    let looksTask =
      /^task\b/.test(lc) ||
      /\btasks?\b/.test(lc);

    let looksJob =
      /\b(?:job|jobs)\b/.test(lc) ||
      /\bactive job\??\b/.test(lc) ||
      /\bwhat'?s\s+my\s+active\s+job\??\b/.test(lc) ||
      /\bset\s+active\b/.test(lc) ||
      /\b(list|create|start|activate|pause|resume|finish)\s+job\b/.test(lc) ||
      /\bmove\s+last\s+log\s+to\b/.test(lc);

    let looksTime =
      /\b(time\s*clock|timeclock|clock|punch|break|drive|timesheet|hours)\b/.test(lc);

    let looksKpi = /^kpis?\s+for\b/.test(lc);

    if (askingHow && /\btasks?\b/.test(lc)) looksTask = true;
    if (askingHow && /\b(time\s*clock|timeclock)\b/.test(lc)) looksTime = true;
    if (askingHow && /\bjobs?\b/.test(lc)) looksJob = true;

    const topicHints = [
      looksTask ? 'tasks' : null,
      looksJob ? 'jobs' : null,
      looksTime ? 'timeclock' : null,
    ].filter(Boolean);

    const SOP = {
      tasks:
        'Tasks — Quick guide:\n' +
        '• Create: task - buy nails\n' +
        '• List mine: my tasks\n' +
        '• Complete: done #4\n' +
        '• Assign: task @PHONE - pickup shingles\n' +
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
        '• Close: finish job Roof Repair\n' +
        '• Move: move last log to Front Porch [for Justin]',
    };

    const cmds = require('../handlers/commands');
    const tasksHandler =
      cmds.tasks || require('../handlers/commands/tasks').tasksHandler;
    const { handleJob } =
      cmds.job || require('../handlers/commands/job');
    const handleTimeclock =
      cmds.timeclock || require('../handlers/commands/timeclock').handleTimeclock;


    // 4) Try explicit handlers first
    if (tasksHandler &&
        await tasksHandler(req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res)) {
      return;
    }

    if (handleTimeclock &&
        await handleTimeclock(req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res)) {
      return;
    }

    if (handleJob &&
        await handleJob(req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res)) {
      return;
    }

    // 5) Agent fallback (pass topicHints so Chief knows what to look up)
    const { ask } = require('../services/agent');
    const answer = await ask({
      from: req.from,
      ownerId: req.ownerId,
      text,
      topicHints,
    });

    
    // --- Forecast (fast path; no ctx object) ---------------------------------
    if (/^forecast\b/i.test(lc)) {
      const handled = await handleForecast({
        text,
        ownerId: req.ownerId,
        jobId: req.userProfile?.active_job_id || null,
        jobName: req.userProfile?.active_job_name || 'All Jobs'
      }, res);
      if (handled) return;
    }

    // --- Timeclock v2 (optional fast path behind flag) -----------------------
    if (flags.timeclock_v2) {
      const cil = (() => {
        if (/^clock in\b/.test(lc)) return { type:'Clock', action:'in' };
        if (/^clock out\b/.test(lc)) return { type:'Clock', action:'out' };
        if (/^break start\b/.test(lc)) return { type:'Clock', action:'break_start' };
        if (/^break stop\b/.test(lc)) return { type:'Clock', action:'break_end' };
        if (/^lunch start\b/.test(lc)) return { type:'Clock', action:'lunch_start' };
        if (/^lunch stop\b/.test(lc)) return { type:'Clock', action:'lunch_end' };
        if (/^drive start\b/.test(lc)) return { type:'Clock', action:'drive_start' };
        if (/^drive stop\b/.test(lc)) return { type:'Clock', action:'drive_end' };
        return null;
      })();

      if (cil) {
        const ctx = {
          owner_id: req.ownerId,
          user_id:  req.userProfile?.id,
          job_id:   req.userProfile?.active_job_id || null,
          job_name: req.userProfile?.active_job_name || 'Active Job',
          created_by: req.userProfile?.id
        };
        const reply = await handleClock(ctx, cil);
        let msg = reply?.text || 'Time logged.';
        msg += await glossaryNudgeFrom(text);
        return ok(res, msg);
      }
    }

    // --- KPI command (unchanged) --------------------------------------------
    const KPI_ENABLED = (process.env.FEATURE_FINANCE_KPIS || '1') === '1';
    const hasSub = canUseAgent(req.userProfile);
    if (looksKpi && KPI_ENABLED && hasSub) {
      try {
        const { handleJobKpis } = require('../handlers/commands/job_kpis');
        if (typeof handleJobKpis === 'function') {
          const out = await handleJobKpis(req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res);
          if (!res.headersSent) {
            let msg = (typeof out === 'string' && out.trim()) ? out.trim() : 'KPI shown.';
            msg += await glossaryNudgeFrom(text);
            return ok(res, msg);
          }
          return;
        }
      } catch (e) {
        console.warn('[KPI] handler missing:', e?.message);
      }
    }

    // --- TASKS ---------------------------------------------------------------
    if (looksTask && typeof tasksHandler === 'function') {
      const out = await tasksHandler(req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res);
      if (!res.headersSent) {
        let msg = (typeof out === 'string' && out.trim())
          ? out.trim()
          : (askingHow ? SOP.tasks : 'Task handled.');
        msg += await glossaryNudgeFrom(text);
        return ok(res, msg);
      }
      return;
    }

    // --- JOBS ----------------------------------------------------------------
    if (looksJob && typeof handleJob === 'function') {
      const out = await handleJob(req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res);
      if (!res.headersSent) {
        let msg = (typeof out === 'string' && out.trim())
          ? out.trim()
          : (askingHow ? SOP.jobs : 'Job handled.');
        msg += await glossaryNudgeFrom(text);
        return ok(res, msg);
      }
      return;
    }

    // --- TIMECLOCK (legacy) --------------------------------------------------
    if (looksTime && typeof handleTimeclock === 'function') {
      const out = await handleTimeclock(req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res);
      if (!res.headersSent) {
        let msg = (typeof out === 'string' && out.trim())
          ? out.trim()
          : (askingHow ? SOP.timeclock : 'Time logged.');
        msg += await glossaryNudgeFrom(text);
        return ok(res, msg);
      }
      return;
    }

    // --- Agent (unchanged) ---------------------------------------------------
    if (canUseAgent(req.userProfile)) {
      try {
        const { ask } = require('../services/agent');
        if (typeof ask === 'function') {
          const answer = await Promise.race([
            ask({ from: req.from, text, topicHints }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
          ]).catch(() => '');
          if (answer?.trim()) {
            let msg = answer.trim();
            msg += await glossaryNudgeFrom(text);
            return ok(res, msg);
          }
        }
      } catch (e) {
        console.warn('[AGENT] failed:', e?.message);
      }
    }

    // --- Default help --------------------------------------------------------
    let msg =
      'PocketCFO — What I can do:\n' +
      '• Jobs: create job Roof Repair, set active job Roof Repair, move last log to Front Porch\n' +
      '• Tasks: task - buy nails, my tasks, done #4\n' +
      '• Time: clock in, clock out, timesheet week';
    msg += await glossaryNudgeFrom(text);
    return ok(res, msg);

  } catch (err) {
    return next(err);
  }
});

// ---------- Final fallback (always 200) ----------
router.use((req, res, next) => {
  if (!res.headersSent) {
    console.warn('[WEBHOOK] fell-through fallback');
    return ok(res, 'OK');
  }
  next();
});

// ---------- Error middleware (lazy) ----------
try {
  const { errorMiddleware } = require('../middleware/error');
  router.use(errorMiddleware);
} catch { /* no-op */ }

// ---------- Export ----------
app.use('/', router);
module.exports = (req, res) => app.handle(req, res);
