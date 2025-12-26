// routes/webhook.js
// Serverless-safe WhatsApp webhook router (Twilio form posts)
// Aligned with North Star: tolerant, lazy deps, quick fallbacks, confirm/undo friendly.

const express = require('express');
const querystring = require('querystring');
const router = express.Router();
const app = express();

const { flags } = require('../config/flags');
const { handleClock } = require('../handlers/commands/timeclock');
const { handleForecast } = require('../handlers/commands/forecast');

const { getOwnerUuidForPhone } = require('../services/owners'); // map phone -> uuid
const stateManager = require('../utils/stateManager');
const { getPendingTransactionState } = stateManager;

// Prefer mergePendingTransactionState; fall back to setPendingTransactionState (older builds)
const mergePendingTransactionState =
  stateManager.mergePendingTransactionState ||
  (async (userId, patch) => stateManager.setPendingTransactionState(userId, patch, { merge: true }));

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

function looksHardCommand(lc) {
  return (
    /^(create|new)\s+job\b/.test(lc) ||
    /^(jobs|list jobs|show jobs)\b/.test(lc) ||
    /^active\s+job\b/.test(lc) ||
    /^set\s+active\b/.test(lc) ||
    /^switch\s+job\b/.test(lc) ||
    /^task\b/.test(lc) ||
    /^my\s+tasks\b/.test(lc) ||
    /^team\s+tasks\b/.test(lc) ||
    /^done\s*#?\d+/.test(lc) ||
    /^clock\b/.test(lc) ||
    /^break\b/.test(lc) ||
    /^drive\b/.test(lc) ||
    /^expense\b/.test(lc) ||
    /^revenue\b/.test(lc)
  );
}

function isYesEditCancelOrSkip(lc) {
  return /^(yes|y|confirm|edit|cancel|no|skip|stop)\b/.test(lc);
}

function pendingTxnNudgeMessage(pending) {
  const type = pending?.type || pending?.kind || 'entry';
  return `It looks like you still have a pending ${type}.

Reply:
- "yes" to submit
- "edit" to change it
- "cancel" (or "stop") to discard

Or reply "skip" to leave it pending and continue.`;
}

// Try to clear pending txn state if your stateManager exports any of these.
// We keep this tolerant because your file names / exports may differ.
async function tryClearPendingTxn(from) {
  try {
    const sm = require('../utils/stateManager');
    if (typeof sm.clearPendingTransactionState === 'function') {
      await sm.clearPendingTransactionState(from);
      return true;
    }
    if (typeof sm.clearPendingState === 'function') {
      await sm.clearPendingState(from);
      return true;
    }
    if (typeof sm.clearPending === 'function') {
      await sm.clearPending(from);
      return true;
    }
  } catch {}
  return false;
}

/**
 * ✅ NEW: Twilio WhatsApp template buttons / quick replies.
 * For content templates with buttons, Twilio commonly includes:
 * - ButtonPayload (best: often your ID like "yes"/"edit"/"cancel")
 * - ButtonText (fallback: "Yes"/"Edit"/"Cancel")
 * - Body (sometimes empty, sometimes repeats text)
 */
function getInboundText(body = {}) {
  const payload = String(body.ButtonPayload || body.buttonPayload || '').trim();
  if (payload) return payload;

  const btnText = String(body.ButtonText || body.buttonText || '').trim();
  if (btnText) return btnText;

  // Some variants (rare): Interactive payload keys. Keep fail-open.
  const interactiveId = String(body.ListId || body.listId || '').trim();
  if (interactiveId) return interactiveId;

  const interactiveTitle = String(body.ListTitle || body.listTitle || '').trim();
  if (interactiveTitle) return interactiveTitle;

  return String(body.Body || '').trim();
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

// ---------- Phase tracker (debug) ----------
router.use((req, res, next) => {
  if (!res.locals.phase) res.locals.phase = 'start';
  res.locals.phaseAt = Date.now();
  next();
});

// ---------- 8s Safety Timer ----------
router.use((req, res, next) => {
  if (res.locals._safety) return next();
  res.locals._safety = setTimeout(() => {
    if (!res.headersSent) {
      console.warn('[WEBHOOK] 8s safety reply', {
        phase: res.locals.phase,
        msInPhase: Date.now() - (res.locals.phaseAt || Date.now()),
        from: req.from,
        messageSid: req.body?.MessageSid || req.body?.SmsMessageSid
      });
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
  const bodyText = getInboundText(req.body || {}).toLowerCase();
  if (bodyText === 'version') {
    const v = process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'dev-local';
    return ok(res, `build ${String(v).slice(0, 7)} OK`);
  }
  next();
});

// ---------- Lightweight middlewares (tolerant) ----------
router.use((req, res, next) => {
  try {
    const token = require('../middleware/token');
    const prof  = require('../middleware/userProfile');
    const lock  = require('../middleware/lock');

    res.locals.phase = 'token'; res.locals.phaseAt = Date.now();
    token.tokenMiddleware(req, res, () => {
      res.locals.phase = 'userProfile'; res.locals.phaseAt = Date.now();
      prof.userProfileMiddleware(req, res, () => {
        res.locals.phase = 'lock'; res.locals.phaseAt = Date.now();
        lock.lockMiddleware(req, res, () => {
          res.locals.phase = 'router'; res.locals.phaseAt = Date.now();
          next();
        });
      });
    });
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

    // IMPORTANT: Body is usually empty on media; still pass it along.
    const bodyText = getInboundText(req.body || {});

    const result = await handleMedia(
      req.from,
      bodyText,
      req.userProfile || {},
      req.ownerId,
      url,
      type
    );

    // If handler returns TwiML directly, send it.
    if (typeof result === 'string' && result && !res.headersSent) {
      return res.status(200).type('application/xml; charset=utf-8').send(result);
    }

    // If handler returns transcript, convert to text message and continue routing.
    if (result && typeof result === 'object' && result.transcript) {
      req.body.Body = result.transcript;

      // Persist media meta for later save (revenue/expense confirmation)
      try {
        const rawSid = String(req.body?.MessageSid || req.body?.SmsMessageSid || '').trim();
        const pending = await getPendingTransactionState(req.from);

        const mediaMeta = {
          url,
          type,
          messageSid: rawSid || null, // media message SID
          confidence: result.confidence ?? null,
          transcript: result.transcript
        };

        await mergePendingTransactionState(req.from, {
          ...(pending || {}),
          pendingMediaMeta: mediaMeta,
          // Keep a consistent shape (object), but never break older code that expects boolean.
          pendingMedia: typeof pending?.pendingMedia === 'object'
            ? { ...(pending.pendingMedia || {}), hasMedia: true }
            : pending?.pendingMedia || null
        });
      } catch (e) {
        console.warn('[MEDIA] could not persist pendingMediaMeta:', e?.message);
      }

      return next();
    }

    return next();
  } catch (e) {
    console.error('[MEDIA] error:', e?.message);
    if (!res.headersSent) return ok(res, 'Media processed.');
  }
});

// ---------- Main text router (tasks / jobs / timeclock / agent) ----------
router.post('*', async (req, res, next) => {
  // Owner mapping: phone -> owner uuid (or text owner_id in DB)
  if (!req.ownerId || /^[0-9]+$/.test(String(req.ownerId))) {
    try {
      const mapped = await getOwnerUuidForPhone(req.from);
      if (mapped) req.ownerId = mapped;
    } catch (e) {
      console.warn('[WEBHOOK] owner uuid map failed:', e?.message);
    }
  }

  try {
    const pending = await getPendingTransactionState(req.from);
    const numMedia = parseInt(req.body?.NumMedia || '0', 10) || 0;

    // ✅ DEFINE TEXT EARLY (now respects button payloads)
    const text = String(getInboundText(req.body || {}) || '');
    const lc = text.toLowerCase();


    // ------------------------------------------------------------
    // PENDING TXN NUDGE (revenue/expense flows)
    // Prevent "create job ..." from being treated as a job-name answer.
    // ------------------------------------------------------------
    const pendingRevenueFlow =
      !!pending?.pendingRevenue ||
      !!pending?.awaitingRevenueJob ||
      !!pending?.awaitingRevenueClarification;

    const pendingExpenseFlow =
      !!pending?.pendingExpense ||
      !!pending?.awaitingExpenseJob ||
      !!pending?.awaitingExpenseClarification;

    if (pendingRevenueFlow) {
      if (/^(cancel|stop|no)\b/.test(lc)) {
        try { await require('../utils/stateManager').deletePendingTransactionState?.(req.from); } catch {}
        return ok(res, `❌ Revenue cancelled.`);
      }
      if (lc === 'skip') return ok(res, `Okay — leaving that revenue pending. What do you want to do next?`);
      if (!isYesEditCancelOrSkip(lc) && looksHardCommand(lc)) return ok(res, pendingTxnNudgeMessage({ type: 'revenue' }));
    }

    if (pendingExpenseFlow) {
      if (/^(cancel|stop|no)\b/.test(lc)) {
        try { await require('../utils/stateManager').deletePendingTransactionState?.(req.from); } catch {}
        return ok(res, `❌ Expense cancelled.`);
      }
      if (lc === 'skip') return ok(res, `Okay — leaving that expense pending. What do you want to do next?`);
      if (!isYesEditCancelOrSkip(lc) && looksHardCommand(lc)) return ok(res, pendingTxnNudgeMessage({ type: 'expense' }));
    }

    // -----------------------------------------------------------------------
    // If prior step set pendingMedia (waiting for user follow-up) and this is text-only,
    // let media.js interpret the follow-up and/or pass it through.
    // -----------------------------------------------------------------------
    const hasPendingMedia = !!pending?.pendingMedia || !!pending?.pendingMediaMeta;
    if (hasPendingMedia && numMedia === 0) {
      const { handleMedia } = require('../handlers/media');
      const result = await handleMedia(
        req.from,
        text,
        req.userProfile || {},
        req.ownerId,
        null,
        null
      );

      // If media handler returns TwiML, send it.
      if (typeof result === 'string' && result && !res.headersSent) {
        return res.status(200).type('application/xml; charset=utf-8').send(result);
      }

      // If it returns a transcript pass-through, rewrite Body and continue.
      if (result && typeof result === 'object' && result.transcript && !result.twiml) {
        req.body.Body = result.transcript;
      } else if (result && typeof result === 'object' && result.twiml) {
        // media.js sometimes returns { transcript, twiml } — if it provides twiml, honor it
        return res.status(200).type('application/xml; charset=utf-8').send(result.twiml);
      }
      // refresh text/lc after rewrite
    }

    // refresh after any rewrite (button-aware)
const text2 = String(getInboundText(req.body || {}) || '').trim();
const lc2 = text2.toLowerCase();



    // Canonical idempotency key for ingestion (Twilio)
    const crypto = require('crypto');
    const rawSid = String(req.body?.MessageSid || req.body?.SmsMessageSid || '').trim();
    const messageSid = rawSid || crypto
      .createHash('sha256')
      .update(`${req.from}|${text2}`)
      .digest('hex')
      .slice(0, 32);

    // -----------------------------------------------------------------------
    // (A) PENDING FLOW ROUTER — MUST RUN BEFORE ANY FAST PATH OR AGENT
    // -----------------------------------------------------------------------
    const isNewRevenueCmd = /^(?:revenue|rev|received)\b/.test(lc2);
    const isNewExpenseCmd = /^(?:expense|exp)\b/.test(lc2);

    const pendingRevenueLike =
      !!pending?.awaitingRevenueClarification ||
      !!pending?.awaitingRevenueJob ||
      (pending?.pendingCorrection && pending?.type === 'revenue') ||
      (!!pending?.pendingRevenue && !isNewRevenueCmd);

    const pendingExpenseLike =
      !!pending?.awaitingExpenseClarification ||
      !!pending?.awaitingExpenseJob ||
      pending?.pendingDelete?.type === 'expense' ||
      (pending?.pendingCorrection && pending?.type === 'expense') ||
      (!!pending?.pendingExpense && !isNewExpenseCmd);

    if (pendingRevenueLike) {
      try {
        const { handleRevenue } = require('../handlers/commands/revenue');
        const twiml = await handleRevenue(
          req.from,
          text2,
          req.userProfile,
          req.ownerId,
          req.ownerProfile,
          req.isOwner,
          messageSid
        );
        return res.status(200).type('application/xml; charset=utf-8').send(twiml);
      } catch (e) {
        console.warn('[WEBHOOK] revenue pending/clarification handler failed:', e?.message);
      }
    }

    if (pendingExpenseLike) {
      try {
        const { handleExpense } = require('../handlers/commands/expense');
        const twiml = await handleExpense(
          req.from,
          text2,
          req.userProfile,
          req.ownerId,
          req.ownerProfile,
          req.isOwner,
          messageSid
        );
        return res.status(200).type('application/xml; charset=utf-8').send(twiml);
      } catch (e) {
        console.warn('[WEBHOOK] expense pending/clarification handler failed:', e?.message);
      }
    }
function hasMoneyAmount(str) {
  const s = String(str || '');

  // $489, $489.78, $8,436, $8,436.10
  const hasDollar = /\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/.test(s);

  // 8436 dollars, 8,436 bucks, 8436 cad
  const hasWordAmount =
    /\b\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s*(?:dollars|bucks|cad|usd)\b/i.test(s);

  // plain-ish numbers (avoid matching years / addresses):
  // requires a hint word nearby: "for", "paid", "spent", "received", "cost"
  const hasBareNumberWithHint =
    /\b(?:for|paid|spent|received|cost|total)\s+\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\b/i.test(s) ||
    /\b\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s+\b(?:for|paid|spent|received|cost|total)\b/i.test(s);

  return hasDollar || hasWordAmount || hasBareNumberWithHint;
}

function looksExpenseNl(str) {
  const s = String(str || '').trim().toLowerCase();

  // must have a money amount
  if (!hasMoneyAmount(s)) return false;

  // expense-ish verbs / phrases
  const verb =
    /\b(bought|buy|purchased|purchase|spent|spend|paid|pay|picked\s*up|cost|ordered|charge|charged)\b/.test(s) ||
    /\b(on|for)\b/.test(s); // often "spent $X on Y" or "paid $X for Y"

  if (!verb) return false;

  // avoid common revenue phrasing
  if (/\b(received|got paid|payment|deposit)\b/.test(s)) return false;

  // avoid job/time/task hard commands (extra safety)
  if (
    /^(create|new)\s+job\b/.test(s) ||
    /^active\s+job\b/.test(s) ||
    /^set\s+active\b/.test(s) ||
    /^switch\s+job\b/.test(s) ||
    /^clock\b/.test(s) ||
    /^break\b/.test(s) ||
    /^drive\b/.test(s) ||
    /^task\b/.test(s) ||
    /^my\s+tasks\b/.test(s)
  ) return false;

  return true;
}

function looksRevenueNl(str) {
  const s = String(str || '').trim().toLowerCase();

  if (!hasMoneyAmount(s)) return false;

  // revenue-ish verbs / phrases
  if (/\b(received|revenue|rev|got paid|payment|deposit)\b/.test(s)) return true;

  // also catch "client paid me $X" patterns
  if (/\b(paid)\b/.test(s) && /\b(from|client|customer)\b/.test(s)) return true;

  return false;
}

    // -----------------------------------------------------------------------
// (B) FAST PATHS — REVENUE/EXPENSE
// -----------------------------------------------------------------------

const revenuePrefix = /^(?:revenue|rev|received)\b/.test(lc2);
const revenueNl = !revenuePrefix && looksRevenueNl(text2);
const looksRevenue = revenuePrefix || revenueNl;

if (looksRevenue) {
  if (revenueNl) {
    console.info('[WEBHOOK] NL revenue detected', { from: req.from, text2: text2.slice(0, 120) });
  }

  try {
    const { handleRevenue } = require('../handlers/commands/revenue');

    const timeoutMs = 8000;
    const timeoutTwiml =
      `<Response><Message>⚠️ I’m having trouble saving that right now (database busy). Please tap Yes again in a few seconds.</Message></Response>`;

    let timeoutId = null;
    const timeoutPromise = new Promise(resolve => {
      timeoutId = setTimeout(() => {
        console.warn('[WEBHOOK] revenue handler timeout', { from: req.from, messageSid, timeoutMs });
        resolve(timeoutTwiml);
      }, timeoutMs);
    });

    const twiml = await Promise.race([
      handleRevenue(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, messageSid),
      timeoutPromise
    ]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });

    return res.status(200).type('application/xml; charset=utf-8').send(twiml);
  } catch (e) {
    console.warn('[WEBHOOK] revenue handler failed:', e?.message);
  }
}

const expensePrefix = /^(?:expense|exp)\b/.test(lc2);
const expenseNl = !expensePrefix && looksExpenseNl(text2);
const looksExpense = expensePrefix || expenseNl;

if (looksExpense) {
  if (expenseNl) {
    console.info('[WEBHOOK] NL expense detected', { from: req.from, text2: text2.slice(0, 120) });
  }

  try {
    const { handleExpense } = require('../handlers/commands/expense');

    const timeoutMs = 8000;
    const timeoutTwiml =
      `<Response><Message>⚠️ I’m having trouble saving that right now (database busy). Please tap Yes again in a few seconds.</Message></Response>`;

    let timeoutId = null;
    const timeoutPromise = new Promise(resolve => {
      timeoutId = setTimeout(() => {
        console.warn('[WEBHOOK] expense handler timeout', { from: req.from, messageSid, timeoutMs });
        resolve(timeoutTwiml);
      }, timeoutMs);
    });

    const twiml = await Promise.race([
      handleExpense(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, messageSid),
      timeoutPromise
    ]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });

    return res.status(200).type('application/xml; charset=utf-8').send(twiml);
  } catch (e) {
    console.warn('[WEBHOOK] expense handler failed:', e?.message);
  }
}


    // --- SPECIAL: "How did the XYZ job do?" → job KPIs ---
    if (/how\b.*\bjob\b/.test(lc2)) {
      try {
        const { handleJobInsights } = require('../handlers/commands/job_insights');
        const msg = await handleJobInsights({ ownerId: req.ownerId, text: text2 });

        return res
          .status(200)
          .type('application/xml; charset=utf-8')
          .send(`<Response><Message>${xmlEsc(msg)}</Message></Response>`);
      } catch (e) {
        console.error('[WEBHOOK] job_insights failed:', e?.message);
      }
    }

    async function glossaryNudgeFrom(str) {
      try {
        const glossary = require('../services/glossary'); // optional
        const findClosestTerm = glossary?.findClosestTerm;
        if (typeof findClosestTerm !== 'function') return '';

        const words = String(str || '').toLowerCase().match(/[a-z0-9_-]+/g) || [];
        for (const w of words) {
          const hit = await findClosestTerm(w);
          if (hit?.nudge) return `\n\nTip: ${hit.nudge}`;
        }
        return '';
      } catch {
        return '';
      }
    }

    const askingHow = /\b(how (do|to) i|how to|help with|how do i use|how can i use)\b/.test(lc2);

    let looksTask = /^task\b/.test(lc2) || /\btasks?\b/.test(lc2);

    let looksJob =
      /\b(?:job|jobs)\b/.test(lc2) ||
      /\bactive job\??\b/.test(lc2) ||
      /\bwhat'?s\s+my\s+active\s+job\??\b/.test(lc2) ||
      /\bset\s+active\b/.test(lc2) ||
      /\b(list|create|start|activate|pause|resume|finish)\s+job\b/.test(lc2) ||
      /\bmove\s+last\s+log\s+to\b/.test(lc2);

    let looksTime = /\b(time\s*clock|timeclock|clock|punch|break|drive|timesheet|hours)\b/.test(lc2);

    let looksKpi = /^kpis?\s+for\b/.test(lc2);

    if (askingHow && /\btasks?\b/.test(lc2)) looksTask = true;
    if (askingHow && /\b(time\s*clock|timeclock)\b/.test(lc2)) looksTime = true;
    if (askingHow && /\bjobs?\b/.test(lc2)) looksJob = true;

    const topicHints = [looksTask ? 'tasks' : null, looksJob ? 'jobs' : null, looksTime ? 'timeclock' : null].filter(Boolean);

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
    const tasksHandler = cmds.tasks || require('../handlers/commands/tasks').tasksHandler;
    const { handleJob } = cmds.job || require('../handlers/commands/job');
    const handleTimeclock = cmds.timeclock || require('../handlers/commands/timeclock').handleTimeclock;

    // Try explicit handlers first (BOOLEAN-handled style)
    if (tasksHandler && await tasksHandler(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res)) return;
    if (handleTimeclock && await handleTimeclock(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res)) return;
    if (handleJob && await handleJob(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid)) return;

    // Forecast (fast path; no ctx object)
    if (/^forecast\b/i.test(lc2)) {
      const handled = await handleForecast({
        text: text2,
        ownerId: req.ownerId,
        jobId: req.userProfile?.active_job_id || null,
        jobName: req.userProfile?.active_job_name || 'All Jobs'
      }, res);
      if (handled) return;
    }

    // Timeclock v2 (optional fast path behind flag)
    if (flags.timeclock_v2) {
      const cil = (() => {
        if (/^clock in\b/.test(lc2)) return { type:'Clock', action:'in' };
        if (/^clock out\b/.test(lc2)) return { type:'Clock', action:'out' };
        if (/^break start\b/.test(lc2)) return { type:'Clock', action:'break_start' };
        if (/^break stop\b/.test(lc2)) return { type:'Clock', action:'break_end' };
        if (/^lunch start\b/.test(lc2)) return { type:'Clock', action:'lunch_start' };
        if (/^lunch stop\b/.test(lc2)) return { type:'Clock', action:'lunch_end' };
        if (/^drive start\b/.test(lc2)) return { type:'Clock', action:'drive_start' };
        if (/^drive stop\b/.test(lc2)) return { type:'Clock', action:'drive_end' };
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
        msg += await glossaryNudgeFrom(text2);
        return ok(res, msg);
      }
    }

    // KPI command (unchanged)
    const KPI_ENABLED = (process.env.FEATURE_FINANCE_KPIS || '1') === '1';
    const hasSub = canUseAgent(req.userProfile);
    if (looksKpi && KPI_ENABLED && hasSub) {
      try {
        const { handleJobKpis } = require('../handlers/commands/job_kpis');
        if (typeof handleJobKpis === 'function') {
          const out = await handleJobKpis(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res);
          if (!res.headersSent) {
            let msg = (typeof out === 'string' && out.trim()) ? out.trim() : 'KPI shown.';
            msg += await glossaryNudgeFrom(text2);
            return ok(res, msg);
          }
          return;
        }
      } catch (e) {
        console.warn('[KPI] handler missing:', e?.message);
      }
    }

    // TASKS
    if (looksTask && typeof tasksHandler === 'function') {
      const out = await tasksHandler(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
      if (!res.headersSent) {
        let msg = (typeof out === 'string' && out.trim()) ? out.trim() : (askingHow ? SOP.tasks : 'Task handled.');
        msg += await glossaryNudgeFrom(text2);
        return ok(res, msg);
      }
      return;
    }

    // JOBS
    if (looksJob && typeof handleJob === 'function') {
      const out = await handleJob(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
      if (!res.headersSent) {
        let msg = (typeof out === 'string' && out.trim()) ? out.trim() : (askingHow ? SOP.jobs : 'Job handled.');
        msg += await glossaryNudgeFrom(text2);
        return ok(res, msg);
      }
      return;
    }

    // TIMECLOCK (legacy)
    if (looksTime && typeof handleTimeclock === 'function') {
      const out = await handleTimeclock(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res);
      if (!res.headersSent) {
        let msg = (typeof out === 'string' && out.trim()) ? out.trim() : (askingHow ? SOP.timeclock : 'Time logged.');
        msg += await glossaryNudgeFrom(text2);
        return ok(res, msg);
      }
      return;
    }

    // Agent (unchanged)
    if (canUseAgent(req.userProfile)) {
      try {
        const { ask } = require('../services/agent');
        if (typeof ask === 'function') {
          const answer = await Promise.race([
            ask({ from: req.from, text: text2, topicHints }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
          ]).catch(() => '');
          if (answer?.trim()) {
            let msg = answer.trim();
            msg += await glossaryNudgeFrom(text2);
            return ok(res, msg);
          }
        }
      } catch (e) {
        console.warn('[AGENT] failed:', e?.message);
      }
    }

    // Default help
    let msg =
      'PocketCFO — What I can do:\n' +
      '• Jobs: create job Roof Repair, set active job Roof Repair, move last log to Front Porch\n' +
      '• Tasks: task - buy nails, my tasks, done #4\n' +
      '• Time: clock in, clock out, timesheet week';
    msg += await glossaryNudgeFrom(text2);
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
