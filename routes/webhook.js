// routes/webhook.js (top-level snippet)
const express = require('express');
const app = express();
const router = express.Router();
  res.status(200).type('application/xml').send(`<Response><Message>${txt}</Message></Response>`);

/* =========================
 * Small helpers
 * =======================*/
const querystring = require('querystring');
const xml = (s = '') => `<Response><Message>${String(s)}</Message></Response>`;
const ok = (res, text = 'OK') => res.status(200).type('application/xml').send(xml(text));
const normalizePhone = (raw = '') => String(raw || '').replace(/^whatsapp:/i, '').replace(/\D/g, '') || null;
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

/* =========================
 * Tolerant urlencoded parser for POST form bodies
 * - preserves req.rawBody for Twilio signature
 * =======================*/
router.use((req, _res, next) => {
  if (req.method !== 'POST') return next();
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/x-www-form-urlencoded')) return next();
  if (req.body && Object.keys(req.body).length && typeof req.rawBody === 'string') return next();

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 1_000_000) { try { req.destroy(); } catch {} } // 1MB safety
  });
  req.on('end', () => {
    req.rawBody = raw; // <— important for HMAC signature verification
    try { req.body = raw ? querystring.parse(raw) : {}; }
    catch { req.body = {}; }
    next();
  });
  req.on('error', () => { req.rawBody = raw || ''; req.body = {}; next(); });
});

/* =========================
 * Non-POST guard (Twilio GET/HEAD probes)
 * =======================*/
router.all('/', (req, res, next) => {
  if (req.method === 'POST') return next();
  return ok(res, 'OK');
});

/* =========================
 * Identity shim & canonical URL for Twilio signature
 * =======================*/
router.use((req, _res, next) => {
  req.from = req.body?.From ? normalizePhone(req.body.From) : null;
  req.ownerId = req.from || 'GLOBAL';

  // Canonical URL Twilio used to POST (for signature verification behind Vercel)
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  req.twilioUrl = `${proto}://${host}/api/webhook`;

  next();
});

/* =========================
 * 8s safety (prevents Twilio 11200)
 * =======================*/
router.use((req, res, next) => {
  if (!res.locals._safety) {
    res.locals._safety = setTimeout(() => {
      if (!res.headersSent) {
        console.warn('[WEBHOOK] 8s safety reply');
        ok(res, 'OK');
      }
    }, 8000);
    const clear = () => { try { clearTimeout(res.locals._safety); } catch {} };
    res.on('finish', clear); res.on('close', clear);
  }
  next();
});

/* =========================
 * Fast-path: version
 * =======================*/
router.post('*', (req, res, next) => {
  const bodyText = String(req.body?.Body || '').trim().toLowerCase();

  if (bodyText === 'version') {
    const v = process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'dev-local';
    return ok(res, `build ${String(v).slice(0, 7)} OK`);
  }

  return next();
});

/* =========================
 * 8-second safety timer (prevents Twilio 11200)
 * =======================*/
router.use((req, res, next) => {
  if (!res.locals._safety) {
    res.locals._safety = setTimeout(() => {
      if (!res.headersSent) {
        console.warn('[WEBHOOK] 8s safety reply');
        ok(res, 'OK');
      }
    }, 8000);

    const clear = () => {
      try { clearTimeout(res.locals._safety); } catch {}
    };
    res.on('finish', clear);
    res.on('close', clear);
  }
  next();
});

/* =========================
 * Lightweight signature + profile + lock (lazy requires)
 * Order: token (signature/tenant) -> profile -> lock
 * =======================*/
router.use((req, res, next) => {
  try {
    const token = require('../middleware/token');
    const prof  = require('../middleware/userProfile');
    const lock  = require('../middleware/lock');
    return token.tokenMiddleware(req, res, () =>
      prof.userProfileMiddleware(req, res, () =>
        lock.lockMiddleware(req, res, next)
      )
    );
  } catch (e) {
    console.warn('[WEBHOOK] light middlewares skipped:', e?.message);
    next();
  }
});

/* =========================
 * Media guard (voice + receipts/images)
 * =======================*/
router.post('/', async (req, res, next) => {
  const { n, url, type } = pickFirstMedia(req.body || {});
  if (n <= 0) return next();

  try {
    const media = require('../handlers/media'); // your existing handler(s)
    const contentType = (type || '').split(';')[0];

    // AUDIO → transcribe and feed into text path
    if (contentType.startsWith('audio/')) {
      let transcript = '';
      if (typeof media.transcribe === 'function') {
        transcript = await media.transcribe(url, { from: req.from, ownerId: req.ownerId });
      } else if (typeof media.transcriber === 'function') {
        transcript = await media.transcriber(url, { from: req.from, ownerId: req.ownerId });
      } else if (typeof media.transcribeAudio === 'function') {
        transcript = await media.transcribeAudio(url, { from: req.from, ownerId: req.ownerId });
      } else if (typeof media.handleMedia === 'function') {
        // Back-compat: (from, input, userProfile, ownerId, mediaUrl, contentType)
        const out = await media.handleMedia(req.from, req.body?.Body || '', req.userProfile, req.ownerId, url, contentType);
        transcript = (out && typeof out === 'object' && out.transcript) ? out.transcript
                  : (typeof out === 'string' ? out : '');
      }
      if (transcript && transcript.trim()) {
        req.body.Body = transcript.trim(); // feed to text routes
        console.log('[MEDIA] audio → text len', req.body.Body.length);
        return next();
      }
      return ok(res, `I couldn't understand that audio. Try again, or text me like: "task - buy tape".`);
    }

    // IMAGE (receipt) → try parse, optionally persist (commented write)
    if (contentType.startsWith('image/')) {
      let parsed = null;
      if (typeof media.parseReceipt === 'function') {
        parsed = await media.parseReceipt(url, { from: req.from, ownerId: req.ownerId });
      } else {
        try {
          const deep = require('../services/deepDive');
          if (typeof deep.parseUpload === 'function') {
            parsed = await deep.parseUpload(url, { from: req.from, ownerId: req.ownerId });
          }
        } catch {}
      }

      if (parsed && typeof parsed === 'object') {
        const { date, item, amount, store } = parsed;
        // OPTIONAL persistence — enable when ready
        /*
        try {
          const pg = require('../services/postgres');
          const saveExpense = pg.saveExpense || pg.insertExpense || pg.logExpense;
          if (typeof saveExpense === 'function') {
            await saveExpense({
              ownerId: req.ownerId,
              date, item, amount, store,
              jobName: null,
              category: 'material',
              user: req.from,
              mediaUrl: url,
            });
          }
        } catch (e) {
          console.warn('[MEDIA] saveExpense failed:', e?.message);
        }
        */
        const summary = [
          '🧾 Receipt captured:',
          date ? `• Date: ${date}` : null,
          store ? `• Store: ${store}` : null,
          item ? `• Item: ${item}` : null,
          (amount != null) ? `• Amount: ${amount}` : null
        ].filter(Boolean).join('\n');
        return ok(res, summary || 'Receipt captured.');
      }

      return ok(res, 'Got the image — thanks!');
    }

    // Other file types — acknowledge
    return ok(res, 'Got your file — thanks!');
  } catch (e) {
    console.error('[MEDIA] error:', e?.message);
    return ok(res, 'Media processed (partial). Reply with text if you need help.');
  }
});

/* =========================
 * TEXT routing (tasks → job → timeclock → agent fallback)
 * =======================*/
router.post('/', async (req, res, next) => {
  try {
    const text = String(req.body?.Body || '').trim();
    const lc = text.toLowerCase();

    // Cheap intent hints
    const looksTask = /^task\b/.test(lc) || /\btasks?\b/.test(lc);
    const looksJob  = /\b(job|jobs|active job|set active|close job|list jobs|move last log)\b/.test(lc);
    const looksTime = /\b(clock|punch|break|drive|timesheet|hours)\b/.test(lc);

    // topic hints for the agent
    const topicHints = [
      looksTask ? 'tasks' : null,
      looksJob  ? 'jobs' : null,
      looksTime ? 'timeclock' : null
    ].filter(Boolean);

    // Lazy load handlers/services just-in-time
    const cmds = require('../handlers/commands');
    const tasksHandler =
      (typeof cmds.tasks === 'function') ? cmds.tasks
      : (require('../handlers/commands/tasks').tasksHandler);
    const handleJob =
      (typeof cmds.job === 'function') ? cmds.job
      : require('../handlers/commands/job');
    const handleTimeclock =
      (typeof cmds.timeclock === 'function') ? cmds.timeclock
      : require('../handlers/commands/timeclock').handleTimeclock;

    /* ===== TASKS with CONTROL FAST-PATHS ===== */
    if (looksTask && typeof tasksHandler === 'function') {
      // DONE #N
      {
        const m = text.match(/\bdone\s*#\s*(\d+)\b/i);
        if (m) {
          const taskNo = parseInt(m[1], 10);
          try {
            const pg = require('../services/postgres');
            const markTaskDone = pg.markTaskDone || pg.mark_task_done;
            if (typeof markTaskDone === 'function') {
              const updated = await markTaskDone({
                ownerId: req.ownerId,
                taskNo,
                actorId: req.from,
                isOwner: req.isOwner,
              });
              if (updated) return ok(res, `Task #${updated.task_no} marked done: ${updated.title}`);
            }
          } catch (e) {
            console.warn('[TASK done] DB fast-path failed:', e?.message);
          }
          const out = await tasksHandler(
            req.from, `__done__ #${taskNo}`, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res
          );
          if (!res.headersSent) return ok(res, '👍');
          return;
        }
      }

      // ASSIGN #N to NAME
      {
        const m = text.match(/\bassign\s*#\s*(\d+)\s*(?:to|for|@)\s*(.+)$/i);
        if (m) {
          const taskNo = parseInt(m[1], 10);
          const assigneeName = m[2].trim();
          try {
            const pg = require('../services/postgres');
            const getUserByName = pg.getUserByName || pg.get_user_by_name;
            const getTaskByNo   = pg.getTaskByNo   || pg.get_task_by_no;
            if (typeof getUserByName === 'function' && typeof getTaskByNo === 'function') {
              const assignee = await getUserByName(req.ownerId, assigneeName);
              if (!assignee || !assignee.user_id) return ok(res, `User "${assigneeName}" not found.`);
              const task = await getTaskByNo(req.ownerId, taskNo);
              if (!task) return ok(res, `Task #${taskNo} not found.`);
              const canEdit = req.isOwner || (task.created_by === req.from) || (task.assigned_to === req.from);
              if (!canEdit) return ok(res, `Permission denied for task #${taskNo}.`);
              await pg.query(
                `UPDATE public.tasks SET assigned_to = $1, updated_at = NOW() WHERE owner_id = $2 AND task_no = $3`,
                [assignee.user_id, req.ownerId, taskNo]
              );
              return ok(res, `Task #${taskNo} assigned to ${assignee.name || assignee.user_id}.`);
            }
          } catch (e) {
            console.warn('[TASK assign] DB fast-path failed:', e?.message);
          }
          const out = await tasksHandler(
            req.from, `__assign__ #${taskNo} to ${assigneeName}`, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res
          );
          if (!res.headersSent) return ok(res, '👍');
          return;
        }
      }

      // DELETE #N (soft delete)
      {
        const m = text.match(/\bdelete\s*#\s*(\d+)\b/i);
        if (m) {
          const taskNo = parseInt(m[1], 10);
          try {
            const pg = require('../services/postgres');
            const getTaskByNo = pg.getTaskByNo || pg.get_task_by_no;
            if (typeof getTaskByNo === 'function') {
              const task = await getTaskByNo(req.ownerId, taskNo);
              if (!task) return ok(res, `Task #${taskNo} not found.`);
              const canDelete = req.isOwner || (task.created_by === req.from);
              if (!canDelete) return ok(res, `Permission denied for task #${taskNo}.`);
              await pg.query(
                `UPDATE public.tasks SET status = 'deleted', updated_at = NOW() WHERE owner_id = $1 AND task_no = $2`,
                [req.ownerId, taskNo]
              );
              return ok(res, `Task #${taskNo} deleted: ${task.title}`);
            }
          } catch (e) {
            console.warn('[TASK delete] DB fast-path failed:', e?.message);
          }
          const out = await tasksHandler(
            req.from, `__delete__ #${taskNo}`, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res
          );
          if (!res.headersSent) return ok(res, '👍');
          return;
        }
      }

      // Everything else → full tasks handler
      const out = await tasksHandler(
        req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res
      );
      if (!res.headersSent) {
        if (typeof out === 'string' && out.trim().startsWith('<Response>')) {
          return res.status(200).type('application/xml').send(out);
        }
        return ok(res, '👍');
      }
      return;
    }

    /* ===== JOBS ===== */
    if (looksJob && typeof handleJob === 'function') {
      const out = await handleJob(
        req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res
      );
      if (!res.headersSent) {
        if (typeof out === 'string' && out.trim().startsWith('<Response>')) {
          return res.status(200).type('application/xml').send(out);
        }
        return ok(res, '👍');
      }
      return;
    }

    /* ===== TIMECLOCK ===== */
    if (looksTime && typeof handleTimeclock === 'function') {
      const out = await handleTimeclock(
        req.from, text, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res
      );
      if (!res.headersSent) {
        if (typeof out === 'string' && out.trim().startsWith('<Response>')) {
          return res.status(200).type('application/xml').send(out);
        }
        return ok(res, '👍');
      }
      return;
    }

    /* ===== AGENT / RAG fallback (lazy, 2s timeout, tier gate) ===== */
    if (canUseAgent(req.userProfile)) {
      try {
        const { ask } = require('../services/agent');
        if (typeof ask === 'function') {
          const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000));
          const answer = await Promise.race([ timeout, ask({ from: req.from, text, topicHints }) ]);
          if (answer && answer.trim()) return ok(res, answer);
        }
      } catch (e) {
        console.warn('[AGENT] failed:', e?.message);
        return ok(res, 'Short help: try "tasks" or "clock in". Try again?');
      }
    }

    /* ===== Help menu default ===== */
    return ok(res,
      'PocketCFO — What I can do:\n' +
      '• Jobs: create job, create job <name>, set active job <name>, list jobs, close job <name>\n' +
      '• Tasks: task - buy nails, my tasks, done #4, assign #3 to John, delete #2, due #3 Friday\n' +
      '• Timeclock: clock in, clock out, start break, timesheet'
    );
  } catch (err) {
    return next(err);
  }
});

/* =========================
 * Final Twilio safety
 * =======================*/
router.use((req, res, next) => {
  if (!res.headersSent) {
    console.warn('[WEBHOOK] fell-through fallback');
    return ok(res, 'OK');
  }
  next();
});

/* =========================
 * Error middleware (lazy, tolerant)
 * =======================*/
try {
  const { errorMiddleware } = require('../middleware/error');
  router.use(errorMiddleware);
} catch { /* no-op */ }

/* =========================
 * Export as plain Node handler (delegator consumes)
 * =======================*/
app.use('/', router);
module.exports = (req, res) => app.handle(req, res);
