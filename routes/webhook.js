// routes/webhook.js
// COMPLETE DROP-IN (aligned with:
// - expense.js Option A pending_actions (pick_job_for_expense + confirm_expense)
// - pendingActionMiddleware (confirm/cancel/edit/skip)
// - handlers/media.js (trade-term correction + stableMediaMsgId + returns { transcript, twiml })
//
// Fixes vs your current file:
// ✅ Correctly passes sourceMsgId into handleMedia (media + text follow-ups) so idempotency is stable.
// ✅ Correctly handles media.js returning { twiml } (your current file only handled string).
// ✅ Fixes pending_actions lookup: DO NOT call pg.getPendingAction for "by kind" (your pg.getPendingAction is NOT kind-aware).
//    We now use pg.getPendingActionByKind when present; otherwise SQL fallback.
// ✅ Tightens job-picker stealing: numeric/job_* tokens will not be routed to job.js if expense pending_actions exist.
// ✅ Keeps ownerId numeric (phone digits). ownerUuid can be stored separately if you map it.
// ✅ Avoids double-send TwiML and keeps the 8s safety timer.
// ✅ NEW: Global "cancel/stop" hard clears pending_actions + legacy state so Cancel never falls through to menu.
// ✅ NEW: "ok(...)" is now SAFE by default (empty TwiML). Pass text only when you want a visible message bubble.
// ✅ Fix: Revenue fast path now calls handleRevenue (your pasted file accidentally called handleExpense).
// ✅ Future-proof: revenue handler path supports object return { twiml }.

const express = require('express');
const querystring = require('querystring');

const router = express.Router();
const app = express();

const { flags } = require('../config/flags');
const { handleClock } = require('../handlers/commands/timeclock'); // v2 handler (optional)
const { handleForecast } = require('../handlers/commands/forecast');

const { getOwnerUuidForPhone } = require('../services/owners'); // optional map phone -> uuid (store separately)
const stateManager = require('../utils/stateManager');
const { getPendingTransactionState } = stateManager;

const pg = require('../services/postgres');
const { query } = pg;

// Prefer mergePendingTransactionState; fall back to setPendingTransactionState (older builds)
const mergePendingTransactionState =
  stateManager.mergePendingTransactionState ||
  (async (userId, patch) => stateManager.setPendingTransactionState(userId, patch, { merge: true }));

/* ---------------- Small helpers ---------------- */

function xmlEsc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const xml = (s = '') => `<Response><Message>${xmlEsc(s)}</Message></Response>`;
const emptyTwiml = () => `<Response></Response>`;

const sendTwiml = (res, twiml) => {
  if (res.headersSent) return;
  return res.status(200).type('application/xml; charset=utf-8').send(twiml || emptyTwiml());
};

// Safer: if you pass null/empty, it returns empty TwiML (no visible Message bubble)
const ok2 = (res, text) => {
  if (res.headersSent) return;
  if (!text) return sendTwiml(res, emptyTwiml());
  return sendTwiml(res, xml(text));
};

// ✅ IMPORTANT: redefine ok to be safe by default.
// - ok(res) -> empty TwiML
// - ok(res, "text") -> visible bubble
const ok = (res, text = null) => ok2(res, text);

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
  return !!tier && tier !== 'basic' && tier !== 'free';
}

function looksHardCommand(lc) {
  return (
    /^(create|new)\s+job\b/.test(lc) ||
    /^(jobs|list jobs|show jobs)\b/.test(lc) ||
    /^active\s+job\b/.test(lc) ||
    /^set\s+active\b/.test(lc) ||
    /^switch\s+job\b/.test(lc) ||
    /^change\s+job\b/.test(lc) ||
    /^(show\s+active\s+jobs|active\s+jobs|list\s+active\s+jobs|pick\s+job)\b/.test(lc) ||
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

// Allowed while a pending expense/revenue exists (so we don't nudge-block them)
function isAllowedWhilePending(lc) {
  return /^(yes|y|confirm|edit|cancel|no|skip|stop|more|overhead|oh)\b/.test(lc);
}

// "global job picker intents" (typed commands)
function isJobPickerIntent(lc) {
  return /^(change\s+job|switch\s+job|pick\s+job|show\s+active\s+jobs|active\s+jobs|list\s+active\s+jobs)\b/.test(lc);
}

function looksLikeJobPickerReplyToken(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (/^(more|overhead|oh)$/i.test(s)) return true;
  if (/^\d+$/.test(s)) return true;

  // ✅ expense.js / job picker uses "jobno_<job_no>"
  if (/^jobno_\d+$/i.test(s)) return true;

  // Keep legacy format if anything still emits it
  if (/^job_\d+_[0-9a-f]+$/i.test(s)) return true;

  return false;
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

/**
 * ✅ Inbound text normalization (button-aware + interactive list-aware)
 */
function getInboundText(body = {}) {
  const payload = String(body.ButtonPayload || body.buttonPayload || '').trim();
  if (payload) return payload;

  const btnText = String(body.ButtonText || body.buttonText || '').trim();
  if (btnText) return btnText;

  const irj = body.InteractiveResponseJson || body.interactiveResponseJson || null;
  if (irj) {
    try {
      const json = typeof irj === 'string' ? JSON.parse(irj) : irj;
      const id = json?.list_reply?.id || json?.listReply?.id || json?.interactive?.list_reply?.id || '';
      const title = json?.list_reply?.title || json?.listReply?.title || json?.interactive?.list_reply?.title || '';
      const picked = String(id || title || '').trim();
      if (picked) return picked;
    } catch {}
  }

  const listId = String(
    body.ListId ||
      body.listId ||
      body.ListItemId ||
      body.listItemId ||
      body.ListReplyId ||
      body.listReplyId ||
      ''
  ).trim();
  if (listId) return listId;

  const listTitle = String(
    body.ListTitle ||
      body.listTitle ||
      body.ListItemTitle ||
      body.listItemTitle ||
      body.ListReplyTitle ||
      body.listReplyTitle ||
      ''
  ).trim();
  if (listTitle) return listTitle;

  return String(body.Body || '').trim();
}

/* ---------------- NL heuristics for expense/revenue ---------------- */

function hasMoneyAmount(str) {
  const s = String(str || '');

  const hasDollar = /\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/.test(s);
  const hasWordAmount = /\b\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s*(?:dollars|bucks|cad|usd)\b/i.test(s);

  const hasBareNumberWithHint =
    /\b(?:for|paid|spent|received|cost|total)\s+\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\b/i.test(s) ||
    /\\b\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?\\s+\\b(?:for|paid|spent|received|cost|total)\\b/i.test(s);

  return hasDollar || hasWordAmount || hasBareNumberWithHint;
}

function looksExpenseNl(str) {
  const s = String(str || '').trim().toLowerCase();
  if (!hasMoneyAmount(s)) return false;

  const verb =
    /\b(bought|buy|purchased|purchase|spent|spend|paid|pay|picked\s*up|cost|ordered|charge|charged)\b/.test(s) ||
    /\b(on|for)\b/.test(s);

  if (!verb) return false;
  if (/\b(received|got paid|payment|deposit)\b/.test(s)) return false;

  if (
    /^(create|new)\s+job\b/.test(s) ||
    /^active\s+job\b/.test(s) ||
    /^set\s+active\b/.test(s) ||
    /^switch\s+job\b/.test(s) ||
    /^change\s+job\b/.test(s) ||
    /^(show\s+active\s+jobs|active\s+jobs|list\s+active\s+jobs|pick\s+job)\b/.test(s) ||
    /^clock\b/.test(s) ||
    /^break\b/.test(s) ||
    /^drive\b/.test(s) ||
    /^task\b/.test(s) ||
    /^my\s+tasks\b/.test(s)
  ) {
    return false;
  }

  return true;
}

function looksRevenueNl(str) {
  const s = String(str || '').trim().toLowerCase();
  if (!hasMoneyAmount(s)) return false;

  if (/\b(received|revenue|rev|got paid|payment|deposit)\b/.test(s)) return true;
  if (/\b(paid)\b/.test(s) && /\b(from|client|customer)\b/.test(s)) return true;

  return false;
}

/* ---------------- Pending Actions (Option A) ---------------- */

const PA_KIND_PICK_JOB_EXPENSE = 'pick_job_for_expense';
const PA_KIND_CONFIRM_EXPENSE = 'confirm_expense';

// optional (if you add revenue Option A later)
const PA_KIND_PICK_JOB_REVENUE = 'pick_job_for_revenue';
const PA_KIND_CONFIRM_REVENUE = 'confirm_revenue';

// ✅ IMPORTANT: Only use getPendingActionByKind if it exists.
const pgGetPendingActionByKind =
  (typeof pg.getPendingActionByKind === 'function' && pg.getPendingActionByKind) || null;

const pgDeletePendingActionByKind =
  (typeof pg.deletePendingActionByKind === 'function' && pg.deletePendingActionByKind) || null;

// TTL minutes for SQL fallback. Should match services/postgres.js PENDING_TTL_MIN.
const PA_TTL_MIN = Number(process.env.PENDING_TTL_MIN || 10);

async function getPA({ ownerId, userId, kind }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  const k = String(kind || '').trim();
  if (!owner || !user || !k) return null;

  if (pgGetPendingActionByKind) {
    try {
      const r = await pgGetPendingActionByKind({ ownerId: owner, userId: user, kind: k });
      if (!r) return null;
      if (r.payload != null) return r;
      if (typeof r === 'object') return { payload: r };
      return null;
    } catch {
      // fall through
    }
  }

  try {
    const r = await query(
      `
      SELECT id, kind, payload, created_at
        FROM public.pending_actions
       WHERE owner_id = $1
         AND user_id = $2
         AND kind = $3
         AND created_at > now() - (($4::text || ' minutes')::interval)
       ORDER BY created_at DESC
       LIMIT 1
      `,
      [owner, user, k, String(PA_TTL_MIN)]
    );
    return r?.rows?.[0] || null;
  } catch {
    return null;
  }
}

async function deletePA({ ownerId, userId, kind }) {
  const owner = String(ownerId || '').trim();
  const user = String(userId || '').trim();
  const k = String(kind || '').trim();
  if (!owner || !user || !k) return;

  if (pgDeletePendingActionByKind) {
    try {
      await pgDeletePendingActionByKind({ ownerId: owner, userId: user, kind: k });
      return;
    } catch {
      // fall through
    }
  }

  try {
    await query(`DELETE FROM public.pending_actions WHERE owner_id=$1 AND user_id=$2 AND kind=$3`, [owner, user, k]);
  } catch {
    // ignore
  }
}

async function clearAllPendingForUser({ ownerId, from }) {
  const kinds = [
    PA_KIND_CONFIRM_EXPENSE,
    PA_KIND_PICK_JOB_EXPENSE,
    PA_KIND_CONFIRM_REVENUE,
    PA_KIND_PICK_JOB_REVENUE,
    'timeclock.confirm'
  ];

  await Promise.all(kinds.map((k) => deletePA({ ownerId, userId: from, kind: k }).catch(() => null)));

  // legacy state cleanup (safe)
  try {
    if (typeof stateManager.clearFinanceFlow === 'function') {
      await stateManager.clearFinanceFlow(from).catch(() => null);
    }
  } catch {}

  try {
    if (typeof stateManager.deletePendingTransactionState === 'function') {
      await stateManager.deletePendingTransactionState(from).catch(() => null);
    }
  } catch {}
}

async function hasExpensePA(ownerId, from) {
  try {
    const [pick, conf] = await Promise.all([
      getPA({ ownerId, userId: from, kind: PA_KIND_PICK_JOB_EXPENSE }),
      getPA({ ownerId, userId: from, kind: PA_KIND_CONFIRM_EXPENSE })
    ]);
    const hasAny = !!(pick?.payload || conf?.payload);
    return { pick, conf, hasAny };
  } catch {
    return { pick: null, conf: null, hasAny: false };
  }
}

/* ---------------- Raw urlencoded parser (Twilio signature expects original body) ---------------- */

router.use((req, _res, next) => {
  if (req.method !== 'POST') return next();
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const isForm = ct.includes('application/x-www-form-urlencoded');
  if (!isForm) return next();

  if (req.body && Object.keys(req.body).length && typeof req.rawBody === 'string') return next();

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 1_000_000) req.destroy();
  });
  req.on('end', () => {
    req.rawBody = raw;
    try {
      req.body = raw ? querystring.parse(raw) : {};
    } catch {
      req.body = {};
    }
    next();
  });
  req.on('error', () => {
    req.rawBody = raw || '';
    req.body = {};
    next();
  });
});

/* ---------------- Non-POST guard ---------------- */

router.all('*', (req, res, next) => {
  if (req.method === 'POST') return next();
  return ok(res); // empty TwiML
});

/* ---------------- Identity + canonical URL ---------------- */

router.use((req, _res, next) => {
  req.from = req.body?.From ? normalizePhone(req.body.From) : null;
  req.ownerId = req.from || null;

  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const path = req.originalUrl || req.url || '/api/webhook';
  req.twilioUrl = `${proto}://${host}${path}`;
  next();
});

/* ---------------- Phase tracker (debug) ---------------- */

router.use((req, res, next) => {
  if (!res.locals.phase) res.locals.phase = 'start';
  res.locals.phaseAt = Date.now();
  next();
});

/* ---------------- 8s Safety Timer ---------------- */

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
      ok(res); // empty TwiML (no bubble)
    }
  }, 8000);

  const clear = () => clearTimeout(res.locals._safety);
  res.on('finish', clear);
  res.on('close', clear);
  next();
});

/* ---------------- Quick version check ---------------- */

router.post('*', (req, res, next) => {
  const bodyText = String(getInboundText(req.body || {}) || '').toLowerCase();
  if (bodyText === 'version') {
    const v = process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'dev-local';
    return ok(res, `build ${String(v).slice(0, 7)} OK`);
  }
  next();
});

/* ---------------- Lightweight middlewares (tolerant) ---------------- */

router.use((req, res, next) => {
  try {
    const token = require('../middleware/token');
    const prof = require('../middleware/userProfile');
    const lock = require('../middleware/lock');

    res.locals.phase = 'token';
    res.locals.phaseAt = Date.now();
    token.tokenMiddleware(req, res, () => {
      res.locals.phase = 'userProfile';
      res.locals.phaseAt = Date.now();
      prof.userProfileMiddleware(req, res, () => {
        res.locals.phase = 'lock';
        res.locals.phaseAt = Date.now();
        lock.lockMiddleware(req, res, () => {
          res.locals.phase = 'router';
          res.locals.phaseAt = Date.now();
          next();
        });
      });
    });
  } catch (e) {
    console.warn('[WEBHOOK] light middlewares skipped:', e?.message);
    next();
  }
});

/* ---------------- Pending Action interceptor (confirm/cancel/edit/skip) ---------------- */

try {
  const { pendingActionMiddleware } = require('../middleware/pendingAction');
  router.post('*', pendingActionMiddleware);
} catch (e) {
  console.warn('[WEBHOOK] pendingActionMiddleware unavailable:', e?.message);
}

/* ---------------- Media ingestion (audio/image → handleMedia) ---------------- */

router.post('*', async (req, res, next) => {
  const { n, url, type } = pickFirstMedia(req.body || {});
  if (n <= 0) return next();

  try {
    const { handleMedia } = require('../handlers/media');

    const bodyText = getInboundText(req.body || {});
    const sourceMsgId = String(req.body?.MessageSid || req.body?.SmsMessageSid || '').trim() || null;

    const result = await handleMedia(req.from, bodyText, req.userProfile || {}, req.ownerId, url, type, sourceMsgId);

    if (result && typeof result === 'object') {
      if (result.twiml && !res.headersSent) {
        return sendTwiml(res, result.twiml);
      }
      if (result.transcript) {
        req.body.Body = result.transcript;
        return next();
      }
    }

    if (typeof result === 'string' && result && !res.headersSent) {
      return sendTwiml(res, result);
    }

    return next();
  } catch (e) {
    console.error('[MEDIA] error:', e?.message);
    if (!res.headersSent) return ok(res, 'Media processed.');
  }
});

/* ---------------- Main text router ---------------- */

router.post('*', async (req, res, next) => {
  try {
    if (req.from) {
      try {
        const mapped = await getOwnerUuidForPhone(req.from);
        if (mapped) req.ownerUuid = mapped;
      } catch (e) {
        console.warn('[WEBHOOK] owner uuid map failed:', e?.message);
      }
    }

    let pending = await getPendingTransactionState(req.from);
    const numMedia = parseInt(req.body?.NumMedia || '0', 10) || 0;

    let text = String(getInboundText(req.body || {}) || '').trim();
    let lc = text.toLowerCase();

    const crypto = require('crypto');
    const rawSid = String(req.body?.MessageSid || req.body?.SmsMessageSid || '').trim();
    const messageSid =
      rawSid || crypto.createHash('sha256').update(`${req.from || ''}|${text}`).digest('hex').slice(0, 32);

    /* -----------------------------------------------------------------------
     * ✅ GLOBAL HARD CANCEL (NEW)
     * ----------------------------------------------------------------------- */
    if (/^(cancel|stop|no)\b/.test(lc)) {
      await clearAllPendingForUser({ ownerId: req.ownerId, from: req.from }).catch(() => null);
      return ok(res, '❌ Cancelled. You’re cleared.');
    }

    // ✅ Option A: check pending_actions FIRST (so "1"/"jobno_123"/"yes" go to expense.js, not job.js)
    const expensePA = await hasExpensePA(req.ownerId, req.from);
    const hasExpensePendingActions = !!expensePA.hasAny;

    /* ------------------------------------------------------------
     * PENDING TXN NUDGE (legacy revenue/expense flows via stateManager)
     * ------------------------------------------------------------ */

    const pendingRevenueFlow =
      !!pending?.pendingRevenue || !!pending?.awaitingRevenueJob || !!pending?.awaitingRevenueClarification;

    const pendingExpenseFlowLegacy =
      !!pending?.pendingExpense || !!pending?.awaitingExpenseJob || !!pending?.awaitingExpenseClarification;

    const pendingExpenseFlow = pendingExpenseFlowLegacy || hasExpensePendingActions;

    const allowJobPickerThrough =
      (isJobPickerIntent(lc) || !!pending?.awaitingActiveJobPick) && !hasExpensePendingActions;

    if (pendingRevenueFlow) {
      if (lc === 'skip') return ok(res, `Okay — leaving that revenue pending. What do you want to do next?`);
      if (!allowJobPickerThrough && !isAllowedWhilePending(lc) && looksHardCommand(lc)) {
        return ok(res, pendingTxnNudgeMessage({ type: 'revenue' }));
      }
    }

    if (pendingExpenseFlow) {
      if (lc === 'skip') return ok(res, `Okay — leaving that expense pending. What do you want to do next?`);
      if (!allowJobPickerThrough && !isAllowedWhilePending(lc) && looksHardCommand(lc)) {
        return ok(res, pendingTxnNudgeMessage({ type: 'expense' }));
      }
    }

    /* -----------------------------------------------------------------------
     * If prior step set pendingMedia and this is text-only, let media.js interpret follow-up.
     * ----------------------------------------------------------------------- */
    const hasPendingMedia = !!pending?.pendingMedia || !!pending?.pendingMediaMeta;
    if (hasPendingMedia && numMedia === 0) {
      try {
        const { handleMedia } = require('../handlers/media');
        const result = await handleMedia(req.from, text, req.userProfile || {}, req.ownerId, null, null, messageSid);

        if (result && typeof result === 'object') {
          if (result.twiml) return sendTwiml(res, result.twiml);
          if (result.transcript && !result.twiml) req.body.Body = result.transcript;
        } else if (typeof result === 'string' && result) {
          return sendTwiml(res, result);
        }

        text = String(getInboundText(req.body || {}) || '').trim();
        lc = text.toLowerCase();
        pending = await getPendingTransactionState(req.from);
      } catch (e) {
        console.warn('[WEBHOOK] pending media follow-up failed (ignored):', e?.message);
      }
    }

    const text2 = String(getInboundText(req.body || {}) || '').trim();
    const lc2 = text2.toLowerCase();
    const isPickerToken = looksLikeJobPickerReplyToken(text2);

    /* -----------------------------------------------------------------------
     * (A0) ACTIVE JOB PICKER FLOW — Only if awaitingActiveJobPick OR explicit intent
     * AND NOT blocked by expense pending_actions.
     * ----------------------------------------------------------------------- */
    if (!hasExpensePendingActions && (isJobPickerIntent(lc2) || pending?.awaitingActiveJobPick)) {
      if (isPickerToken && !pending?.awaitingActiveJobPick) {
        // fall through
      } else {
        try {
          const cmds = require('../handlers/commands');
          const handleJob =
            (cmds?.job && cmds.job.handleJob) || cmds?.handleJob || require('../handlers/commands/job').handleJob;

          if (typeof handleJob === 'function') {
            await handleJob(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
            if (res.headersSent) return;
            return ok(res); // empty TwiML
          }
        } catch (e) {
          console.warn('[WEBHOOK] job picker handler failed:', e?.message);
        }
      }
    }

    /* -----------------------------------------------------------------------
     * (A) PENDING FLOW ROUTER — MUST RUN BEFORE ANY FAST PATH OR AGENT
     * ----------------------------------------------------------------------- */

    const isNewRevenueCmd = /^(?:revenue|rev|received)\b/.test(lc2);
    const isNewExpenseCmd = /^(?:expense|exp)\b/.test(lc2);

    const pendingRevenueLike =
      !!pending?.awaitingRevenueClarification ||
      !!pending?.awaitingRevenueJob ||
      (pending?.pendingCorrection && pending?.type === 'revenue') ||
      (!!pending?.pendingRevenue && !isNewRevenueCmd);

    const expensePendingActionsLike =
      hasExpensePendingActions && (isPickerToken || isAllowedWhilePending(lc2) || /^(expense|exp)\b/.test(lc2));

    const pendingExpenseLike =
      expensePendingActionsLike ||
      !!pending?.awaitingExpenseClarification ||
      !!pending?.awaitingExpenseJob ||
      pending?.pendingDelete?.type === 'expense' ||
      (pending?.pendingCorrection && pending?.type === 'expense') ||
      (!!pending?.pendingExpense && !isNewExpenseCmd);

    if (pendingRevenueLike) {
      try {
        const { handleRevenue } = require('../handlers/commands/revenue');
        const tw = await handleRevenue(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, messageSid);

        if (!res.headersSent) {
          if (tw && typeof tw === 'object' && tw.twiml) return sendTwiml(res, tw.twiml);
          if (typeof tw === 'string' && tw) return sendTwiml(res, tw);
          return ok(res); // empty
        }
        return;
      } catch (e) {
        console.warn('[WEBHOOK] revenue pending/clarification handler failed:', e?.message);
      }
    }

    if (pendingExpenseLike) {
      try {
        const { handleExpense } = require('../handlers/commands/expense');
        const tw = await handleExpense(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, messageSid);

        if (!res.headersSent) {
          if (tw && typeof tw === 'object' && tw.twiml) return sendTwiml(res, tw.twiml);
          if (typeof tw === 'string' && tw) return sendTwiml(res, tw);
          return ok(res); // empty
        }
        return;
      } catch (e) {
        console.warn('[WEBHOOK] expense pending/clarification handler failed:', e?.message);
      }
    }

    /* -----------------------------------------------------------------------
     * (B) FAST PATHS — REVENUE/EXPENSE (prefix OR NL)
     * ----------------------------------------------------------------------- */

    const revenuePrefix = /^(?:revenue|rev|received)\b/.test(lc2);
    const revenueNl = !revenuePrefix && looksRevenueNl(text2);
    const looksRevenue = revenuePrefix || revenueNl;

    if (looksRevenue) {
      if (revenueNl) console.info('[WEBHOOK] NL revenue detected', { from: req.from, text: text2.slice(0, 120) });

      try {
        const { handleRevenue } = require('../handlers/commands/revenue');

        const timeoutMs = 8000;
        const timeoutTwiml =
          `<Response><Message>⚠️ I’m having trouble saving that right now (database busy). Please tap Yes again in a few seconds.</Message></Response>`;

        let timeoutId = null;
        const timeoutPromise = new Promise((resolve) => {
          timeoutId = setTimeout(() => {
            console.warn('[WEBHOOK] revenue handler timeout', { from: req.from, messageSid, timeoutMs });
            resolve(timeoutTwiml);
          }, timeoutMs);
        });

        const tw = await Promise.race([
          handleRevenue(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, messageSid),
          timeoutPromise
        ]).finally(() => timeoutId && clearTimeout(timeoutId));

        if (!res.headersSent) {
          if (tw && typeof tw === 'object' && tw.twiml) return sendTwiml(res, tw.twiml);
          if (typeof tw === 'string' && tw) return sendTwiml(res, tw);
          return ok(res); // empty
        }
        return;
      } catch (e) {
        console.warn('[WEBHOOK] revenue handler failed:', e?.message);
      }
    }

    const expensePrefix = /^(?:expense|exp)\b/.test(lc2);
    const expenseNl = !expensePrefix && looksExpenseNl(text2);
    const looksExpense = expensePrefix || expenseNl;

    if (looksExpense) {
      if (expenseNl) console.info('[WEBHOOK] NL expense detected', { from: req.from, text: text2.slice(0, 120) });

      try {
        const { handleExpense } = require('../handlers/commands/expense');

        const timeoutMs = 8000;
        const timeoutTwiml =
          `<Response><Message>⚠️ I’m having trouble saving that right now (database busy). Please tap Yes again in a few seconds.</Message></Response>`;

        let timeoutId = null;
        const timeoutPromise = new Promise((resolve) => {
          timeoutId = setTimeout(() => {
            console.warn('[WEBHOOK] expense handler timeout', { from: req.from, messageSid, timeoutMs });
            resolve(timeoutTwiml);
          }, timeoutMs);
        });

        const tw = await Promise.race([
          handleExpense(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, messageSid),
          timeoutPromise
        ]).finally(() => timeoutId && clearTimeout(timeoutId));

        if (!res.headersSent) {
          if (tw && typeof tw === 'object' && tw.twiml) return sendTwiml(res, tw.twiml);
          if (typeof tw === 'string' && tw) return sendTwiml(res, tw);
          return ok(res); // empty
        }
        return;
      } catch (e) {
        console.warn('[WEBHOOK] expense handler failed:', e?.message);
      }
    }

    /* -----------------------------------------------------------------------
     * (C) Other command routing (tasks / jobs / timeclock / forecast / KPIs / agent)
     * ----------------------------------------------------------------------- */

    async function glossaryNudgeFrom(str) {
      try {
        const glossary = require('../services/glossary');
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
      isJobPickerIntent(lc2) ||
      /\bactive job\??\b/.test(lc2) ||
      /\bwhat'?s\s+my\s+active\s+job\??\b/.test(lc2) ||
      /\bset\s+active\b/.test(lc2) ||
      /\b(list|create|start|activate|pause|resume|finish)\s+job\b/.test(lc2) ||
      /\bmove\s+last\s+log\s+to\b/.test(lc2);

    let looksTime = /\b(time\s*clock|timeclock|clock|punch|break|drive|timesheet|hours)\b/.test(lc2);

    if (askingHow && /\btasks?\b/.test(lc2)) looksTask = true;
    if (askingHow && /\b(time\s*clock|timeclock)\b/.test(lc2)) looksTime = true;
    if (askingHow && /\bjobs?\b/.test(lc2)) looksJob = true;

    const topicHints = [looksTask ? 'tasks' : null, looksJob ? 'jobs' : null, looksTime ? 'timeclock' : null].filter(Boolean);

    let tasksHandler = null;
    let handleJob = null;
    let handleTimeclock = null;

    try {
      const cmds = require('../handlers/commands');

      tasksHandler =
        (cmds?.tasks && (cmds.tasks.tasksHandler || cmds.tasks)) ||
        require('../handlers/commands/tasks').tasksHandler ||
        null;

      handleJob = (cmds?.job && cmds.job.handleJob) || require('../handlers/commands/job').handleJob || null;

      handleTimeclock =
        (cmds?.timeclock && (cmds.timeclock.handleTimeclock || cmds.timeclock)) ||
        require('../handlers/commands/timeclock').handleTimeclock ||
        null;
    } catch (e) {
      console.warn('[WEBHOOK] commands bundle load failed (ignored):', e?.message);
    }

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
        '• Set active: change job (or active job Roof Repair)\n' +
        '• List: list jobs\n' +
        '• Close: finish job Roof Repair\n' +
        '• Move: move last log to Front Porch [for Justin]'
    };

    if (looksTask && typeof tasksHandler === 'function') {
      const out = await tasksHandler(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
      if (res.headersSent) return;

      let msg = '';
      if (typeof out === 'string' && out.trim()) msg = out.trim();
      else if (askingHow) msg = SOP.tasks;
      else if (out === true) return ok(res); // empty
      else msg = 'Task handled.';

      msg += await glossaryNudgeFrom(text2);
      return ok(res, msg);
    }

    if (looksJob && typeof handleJob === 'function') {
      if (looksLikeJobPickerReplyToken(text2) && !isJobPickerIntent(lc2) && !pending?.awaitingActiveJobPick) {
        // fall through to agent/help
      } else {
        await handleJob(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
        if (res.headersSent) return;
        let msg = askingHow ? SOP.jobs : 'Job handled.';
        msg += await glossaryNudgeFrom(text2);
        return ok(res, msg);
      }
    }

    if (/^forecast\b/i.test(lc2)) {
      try {
        const handled = await handleForecast(
          {
            text: text2,
            ownerId: req.ownerId,
            jobId: req.userProfile?.active_job_id || null,
            jobName: req.userProfile?.active_job_name || 'All Jobs'
          },
          res
        );
        if (res.headersSent) return;
        if (handled) return ok(res); // empty
      } catch (e) {
        console.warn('[WEBHOOK] forecast failed:', e?.message);
      }
    }

    if (flags.timeclock_v2) {
      const cil = (() => {
        if (/^clock in\b/.test(lc2)) return { type: 'Clock', action: 'in' };
        if (/^clock out\b/.test(lc2)) return { type: 'Clock', action: 'out' };
        if (/^break start\b/.test(lc2)) return { type: 'Clock', action: 'break_start' };
        if (/^break stop\b/.test(lc2)) return { type: 'Clock', action: 'break_end' };
        if (/^lunch start\b/.test(lc2)) return { type: 'Clock', action: 'lunch_start' };
        if (/^lunch stop\b/.test(lc2)) return { type: 'Clock', action: 'lunch_end' };
        if (/^drive start\b/.test(lc2)) return { type: 'Clock', action: 'drive_start' };
        if (/^drive stop\b/.test(lc2)) return { type: 'Clock', action: 'drive_end' };
        return null;
      })();

      if (cil) {
        const ctx = {
          owner_id: req.ownerId,
          user_id: req.userProfile?.id || req.userProfile?.user_id || null,
          job_id: req.userProfile?.active_job_id || null,
          job_name: req.userProfile?.active_job_name || 'Active Job',
          created_by: req.userProfile?.id || req.userProfile?.user_id || null
        };
        const reply = await handleClock(ctx, cil);
        let msg = reply?.text || 'Time logged.';
        msg += await glossaryNudgeFrom(text2);
        return ok(res, msg);
      }
    }

    if (looksTime && typeof handleTimeclock === 'function') {
      const out = await handleTimeclock(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
      if (res.headersSent) return;

      let msg = '';
      if (typeof out === 'string' && out.trim()) msg = out.trim();
      else if (askingHow) msg = SOP.timeclock;
      else if (out === true) return ok(res); // empty
      else msg = 'Time logged.';

      msg += await glossaryNudgeFrom(text2);
      return ok(res, msg);
    }

    const looksKpi = /^kpis?\s+for\b/.test(lc2);
    const KPI_ENABLED = (process.env.FEATURE_FINANCE_KPIS || '1') === '1';
    const hasSub = canUseAgent(req.userProfile);
    if (looksKpi && KPI_ENABLED && hasSub) {
      try {
        const { handleJobKpis } = require('../handlers/commands/job_kpis');
        if (typeof handleJobKpis === 'function') {
          const out = await handleJobKpis(req.from, text2, req.userProfile, req.ownerId, req.ownerProfile, req.isOwner, res, messageSid);
          if (res.headersSent) return;

          let msg = typeof out === 'string' && out.trim() ? out.trim() : 'KPI shown.';
          msg += await glossaryNudgeFrom(text2);
          return ok(res, msg);
        }
      } catch (e) {
        console.warn('[KPI] handler missing:', e?.message);
      }
    }

    if (canUseAgent(req.userProfile)) {
      try {
        const { ask } = require('../services/agent');
        if (typeof ask === 'function') {
          const answer = await Promise.race([
            ask({ from: req.from, text: text2, topicHints }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))
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

    let msg =
      'PocketCFO — What I can do:\n' +
      '• Jobs: create job Roof Repair, change job, active job Roof Repair\n' +
      '• Tasks: task - buy nails, my tasks, done #4\n' +
      '• Time: clock in, clock out, timesheet week';
    msg += await glossaryNudgeFrom(text2);
    return ok(res, msg);
  } catch (err) {
    return next(err);
  }
});

/* ---------------- Final fallback (always 200) ---------------- */

router.use((req, res, next) => {
  if (!res.headersSent) {
    console.warn('[WEBHOOK] fell-through fallback');
    return ok(res); // empty
  }
  next();
});

/* ---------------- Error middleware (lazy) ---------------- */

try {
  const { errorMiddleware } = require('../middleware/error');
  router.use(errorMiddleware);
} catch {
  /* no-op */
}

/* ---------------- Export ---------------- */

app.use('/', router);
module.exports = (req, res) => app.handle(req, res);
