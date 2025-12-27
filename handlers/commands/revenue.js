// handlers/commands/revenue.js
// COMPLETE DROP-IN (aligned with latest postgres.js + expense.js + job.js patterns)
//
// Alignments included:
// - Uses pg.insertTransaction canonical path with idempotency via source_msg_id (if supported in postgres.js)
// - Uses pg.normalizeMediaMeta (already imported) for consistent media payloads
// - Stable confirm template send (Twilio Content Template) with TwiML fallback
// - Deterministic parse first (money/date/job) then AI fallback
// - Confirm flow mirrors expense.js: "db timeout" -> keep pending and ask user to tap Yes again
// - "edit" clears pending immediately (prevents confusing stuck state)
// - Addresses/job number heuristics to avoid treating addresses as money
// - "source" can represent payer; if it looks like an address/job we shift it into jobName
//
// Signature expected by router:
//   handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId)

const pg = require('../../services/postgres');
const { insertTransaction, normalizeMediaMeta, DIGITS } = pg;

const state = require('../../utils/stateManager');
const getPendingTransactionState = state.getPendingTransactionState;
const deletePendingTransactionState = state.deletePendingTransactionState;

// Prefer mergePendingTransactionState; fall back to setPendingTransactionState with merge:true
const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

const ai = require('../../utils/aiErrorHandler');

// Serverless-safe / backwards-compatible imports
const handleInputWithAI = ai.handleInputWithAI;
const parseRevenueMessage = ai.parseRevenueMessage;

// detectErrors has been named differently in some versions
const detectErrors =
  (typeof ai.detectErrors === 'function' && ai.detectErrors) ||
  (typeof ai.detectError === 'function' && ai.detectError) ||
  (async () => null); // fail-open: don't block logging

const categorizeEntry =
  (typeof ai.categorizeEntry === 'function' && ai.categorizeEntry) ||
  (async () => null); // fail-open

// ---- CIL validator (fail-open) ----
const cilMod = require('../../cil');
const validateCIL =
  (cilMod && typeof cilMod.validateCIL === 'function' && cilMod.validateCIL) ||
  (cilMod && typeof cilMod.validateCil === 'function' && cilMod.validateCil) ||
  (cilMod && typeof cilMod.validate === 'function' && cilMod.validate) ||
  (typeof cilMod === 'function' && cilMod) ||
  null;

/* ---------------- Twilio Content Template (WhatsApp Quick Reply Buttons) ---------------- */

function xmlEsc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlText(msg) {
  return `<Response><Message>${xmlEsc(msg)}</Message></Response>`;
}

function twimlEmpty() {
  return `<Response></Response>`;
}

function getRevenueConfirmTemplateSid() {
  return (
    process.env.TWILIO_REVENUE_CONFIRM_TEMPLATE_SID ||
    process.env.REVENUE_CONFIRM_TEMPLATE_SID ||
    process.env.TWILIO_TEMPLATE_REVENUE_CONFIRM_SID ||
    null
  );
}

function waTo(from) {
  const d = String(from || '').replace(/\D/g, '');
  return d ? `whatsapp:+${d}` : null;
}

/**
 * Sends WhatsApp Content Template via Twilio REST API (outbound REST send).
 */
async function sendWhatsAppTemplate({ to, templateSid, summaryLine }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || null;
  const waFrom = process.env.TWILIO_WHATSAPP_FROM || null;

  if (!accountSid || !authToken) throw new Error('Missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN');
  if (!to) throw new Error('Missing "to"');
  if (!templateSid) throw new Error('Missing templateSid');

  const toClean = String(to).startsWith('whatsapp:') ? String(to) : `whatsapp:${String(to).replace(/^whatsapp:/, '')}`;

  const payload = {
    to: toClean,
    contentSid: templateSid,
    contentVariables: JSON.stringify({ '1': String(summaryLine || '').slice(0, 900) })
  };

  if (waFrom) payload.from = waFrom;
  else if (messagingServiceSid) payload.messagingServiceSid = messagingServiceSid;
  else throw new Error('Missing TWILIO_WHATSAPP_FROM or TWILIO_MESSAGING_SERVICE_SID');

  const twilio = require('twilio');
  const client = twilio(accountSid, authToken);

  const TIMEOUT_MS = 2500;
  const msg = await Promise.race([
    client.messages.create(payload),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Twilio send timeout')), TIMEOUT_MS))
  ]);

  console.info('[TEMPLATE] sent', {
    to: payload.to,
    from: payload.from || null,
    messagingServiceSid: payload.messagingServiceSid || null,
    contentSid: payload.contentSid,
    sid: msg?.sid || null,
    status: msg?.status || null
  });

  return msg;
}

async function sendConfirmRevenueOrFallback(from, summaryLine) {
  const sid = getRevenueConfirmTemplateSid();
  const to = waTo(from);

  console.info('[REVENUE] confirm template attempt', {
    from,
    to,
    hasSid: !!sid,
    sid: sid || null
  });

  if (sid && to) {
    try {
      await sendWhatsAppTemplate({ to, templateSid: sid, summaryLine });
      console.info('[REVENUE] confirm template sent OK', { to, sid });
      return twimlEmpty(); // do NOT also send TwiML text
    } catch (e) {
      console.warn('[REVENUE] template send failed; falling back to TwiML:', e?.message);
    }
  }

  return twimlText(`Please confirm this Revenue:\n${summaryLine}\n\nReply yes/edit/cancel.`);
}

function normalizeDecisionToken(input) {
  const s = String(input || '').trim().toLowerCase();

  if (s === 'yes' || s === 'y' || s === 'confirm') return 'yes';
  if (s === 'edit') return 'edit';
  if (s === 'cancel' || s === 'stop' || s === 'no') return 'cancel';

  if (/\byes\b/.test(s) && s.length <= 20) return 'yes';
  if (/\bedit\b/.test(s) && s.length <= 20) return 'edit';
  if (/\bcancel\b/.test(s) && s.length <= 20) return 'cancel';

  return s;
}

/* ---------------- helpers ---------------- */

function toCents(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.,]/g, '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function toNumberAmount(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.,]/g, '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return n;
}

function formatMoneyDisplay(n) {
  try {
    const fmt = new Intl.NumberFormat('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `$${fmt.format(n)}`;
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function todayInTimeZone(tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return dtf.format(new Date()); // YYYY-MM-DD in en-CA
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

/**
 * Parse:
 * - today/yesterday/tomorrow
 * - YYYY-MM-DD
 * - "December 22, 2025" / "Dec 22 2025"
 */
function parseNaturalDate(s, tz) {
  const raw = String(s || '').trim();
  const t = raw.toLowerCase();
  const today = todayInTimeZone(tz);

  if (!t || t === 'today') return today;
  if (t === 'yesterday') {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }
  if (t === 'tomorrow') {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso?.[1]) return iso[1];

  const mNat = raw.match(/\b(?:on\s+)?([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/);
  if (mNat?.[1]) {
    const parsed = Date.parse(mNat[1]);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().split('T')[0];
  }

  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().split('T')[0];

  return null;
}

function normalizeJobAnswer(text) {
  let s = String(text || '').trim();
  s = s.replace(/^(job\s*name|job)\s*[:\-]?\s*/i, '');
  s = s.replace(/^(create|new)\s+job\s+/i, '');
  s = s.replace(/[?]+$/g, '').trim();
  return s;
}

function looksLikeOverhead(s) {
  const t = String(s || '').trim().toLowerCase();
  return t === 'overhead' || t === 'oh';
}

function looksLikeAddress(s) {
  const t = String(s || '').trim();
  if (!/\d/.test(t)) return false;
  return /\b(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|cir|circle|way|trail|trl|pkwy|park)\b/i.test(t);
}

async function withTimeout(promise, ms, fallbackValue = null) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))]);
}

function normalizeRevenueData(data, tz) {
  const d = { ...(data || {}) };

  if (d.amount != null) {
    const n = toNumberAmount(d.amount);
    if (Number.isFinite(n) && n > 0) d.amount = formatMoneyDisplay(n);
  }

  d.date = String(d.date || '').trim() || todayInTimeZone(tz);
  d.description = String(d.description || '').trim() || 'Revenue received';

  const src = String(d.source || '').trim();
  d.source = src || 'Unknown';

  if (d.jobName != null) {
    const j = String(d.jobName).trim();
    d.jobName = j || null;
  }

  if (d.suggestedCategory != null) {
    const c = String(d.suggestedCategory).trim();
    d.suggestedCategory = c || null;
  }

  return d;
}

/* ---------------- CIL (fail-open) ---------------- */

function buildRevenueCIL({ from, data, jobName, category, sourceMsgId }) {
  const cents = toCents(data.amount);

  const description =
    String(data.description || '').trim() && data.description !== 'Unknown'
      ? String(data.description).trim()
      : 'Revenue Logged';

  return {
    type: 'LogRevenue',
    job: jobName ? String(jobName) : undefined,
    description,
    amount_cents: cents,
    source: data.source && data.source !== 'Unknown' ? String(data.source) : undefined,
    date: data.date ? String(data.date) : undefined,
    category: category ? String(category) : undefined,
    source_msg_id: sourceMsgId ? String(sourceMsgId) : undefined,
    actor_phone: from ? String(from) : undefined
  };
}

function assertRevenueCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  try {
    const cil = buildRevenueCIL({ ownerId, from, userProfile, data, jobName, category, sourceMsgId });

    if (typeof validateCIL !== 'function') {
      console.warn('[REVENUE] validateCIL missing; skipping CIL validation (fail-open).');
      return { ok: true, cil, skipped: true };
    }

    validateCIL(cil);
    return { ok: true, cil };
  } catch (e) {
    console.warn('[REVENUE] CIL validate failed', {
      message: e?.message,
      name: e?.name,
      details: e?.errors || e?.issues || e?.cause || null
    });
    return { ok: false, reply: `⚠️ Couldn't log that Revenue yet. Try: "received $2500 for <job> today".` };
  }
}

/* --------- Deterministic parse (aligned with expense.js) --------- */

function extractMoneyToken(raw) {
  const s = String(raw || '');

  let m = s.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/);
  if (m?.[1]) return m[1];

  m = s.match(/\b([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)\b/);
  if (m?.[1]) return m[1];

  m = s.match(/\b([0-9]{4,}(?:\.[0-9]{1,2})?)\b/);
  if (m?.[1]) return m[1];

  m = s.match(/\b([0-9]{1,3}\.[0-9]{1,2})\b/);
  if (m?.[1]) return m[1];

  return null;
}

function moneyToFixed(token) {
  const cleaned = String(token || '').trim().replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return formatMoneyDisplay(n);
}

/**
 * Deterministic parse:
 * - supports $8,436.10 / 8,436.10 / 8436.10
 * - avoids grabbing address numbers as amount by not accepting bare integers like "1556" unless clearly money
 * - supports "on December 22, 2025"
 */
async function deterministicRevenueParse({ input, tz }) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const token = extractMoneyToken(raw);

  // If token is a big bare integer, could be job # or address — require $ form to accept.
  if (token && /^\d{4,}$/.test(String(token).replace(/,/g, ''))) {
    const hasDollar = /\$\s*\d/.test(raw);
    if (!hasDollar) return null;
  }

  const amount = moneyToFixed(token);
  if (!amount) return null;

  // Date
  let date = null;
  if (/\btoday\b/i.test(raw)) date = parseNaturalDate('today', tz);
  else if (/\byesterday\b/i.test(raw)) date = parseNaturalDate('yesterday', tz);
  else if (/\btomorrow\b/i.test(raw)) date = parseNaturalDate('tomorrow', tz);
  else {
    const iso = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (iso?.[1]) date = iso[1];
    if (!date) {
      const nat = raw.match(/\b(?:on\s+)?([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/);
      if (nat?.[1]) date = parseNaturalDate(nat[1], tz);
    }
  }
  if (!date) date = todayInTimeZone(tz);

  // Job patterns
  let jobName = null;

  const forMatch = raw.match(
    /\bfor\s+(.+?)(?:\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
  );
  if (forMatch?.[1]) {
    const candidate = normalizeJobAnswer(forMatch[1]);
    if (!/^\$?\s*\d[\d,]*(?:\.\d{1,2})?$/.test(candidate)) jobName = candidate;
  }

  if (!jobName) {
    const jobMatch = raw.match(
      /\bjob\s+(.+?)(?:\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
    );
    if (jobMatch?.[1]) jobName = normalizeJobAnswer(jobMatch[1]);
  }

  // Payer "from X"
  let source = 'Unknown';
  const fromMatch = raw.match(
    /\bfrom\s+(.+?)(?:\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
  );
  if (fromMatch?.[1]) {
    const token2 = normalizeJobAnswer(fromMatch[1]);
    if (looksLikeAddress(token2) || looksLikeAddress(fromMatch[1])) {
      jobName = jobName || token2;
      source = 'Unknown';
    } else {
      source = token2;
    }
  }

  if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

  return normalizeRevenueData(
    {
      date,
      description: 'Revenue received',
      amount,
      source,
      jobName
    },
    tz
  );
}

/**
 * Canonical insert wrapper aligned to postgres.js insertTransaction signature.
 */
async function writeRevenueViaCanonicalInsert({
  ownerId,
  from,
  userProfile,
  data,
  jobName,
  category,
  sourceMsgId,
  pendingMediaMeta
}) {
  const ownerStr = String(ownerId || '').trim();
  const owner = /^\d+$/.test(ownerStr) ? DIGITS(ownerStr) : ownerStr;
  if (!owner) throw new Error('Missing ownerId');

  const amountCents = toCents(data.amount);
  if (!amountCents || amountCents <= 0) throw new Error('Invalid amount');

  const mediaMeta = normalizeMediaMeta(
    pendingMediaMeta
      ? {
          url: pendingMediaMeta.url || pendingMediaMeta.media_url || null,
          type: pendingMediaMeta.type || pendingMediaMeta.media_type || null,
          transcript: pendingMediaMeta.transcript || pendingMediaMeta.media_transcript || null,
          confidence: pendingMediaMeta.confidence ?? pendingMediaMeta.media_confidence ?? null
        }
      : null
  );

  const tz = userProfile?.timezone || userProfile?.tz || 'UTC';
  const safeCategory = (() => {
    const c = String(category || '').trim();
    return c ? c : null;
  })();

  // NOTE: keep payload keys consistent with your postgres.js insertTransaction.
  const payload = {
    ownerId: owner,
    kind: 'revenue',
    date: String(data.date || '').trim() || todayInTimeZone(tz),
    description: String(data.description || 'Revenue received').trim() || 'Revenue received',
    amount_cents: amountCents,
    amount: toNumberAmount(data.amount),
    source: data.source && data.source !== 'Unknown' ? String(data.source).trim() : 'Unknown',
    job: jobName ? String(jobName).trim() : null,
    job_name: jobName ? String(jobName).trim() : null,
    category: safeCategory,
    user_name: String(userProfile?.name || '').trim() || null,
    source_msg_id: String(sourceMsgId || '').trim() || null,
    actor_phone: from ? String(from) : null,
    mediaMeta: mediaMeta ? { ...mediaMeta } : null
  };

  // Some versions accept (payload) only; others accept (payload, opts)
  try {
    return await insertTransaction(payload, { timeoutMs: 4500 });
  } catch (e) {
    // fallback to legacy signature if needed
    if (/too many arguments|expected 1 argument/i.test(String(e?.message || ''))) {
      return await insertTransaction(payload);
    }
    throw e;
  }
}

/* ---------------- main handler ---------------- */

async function handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  const lockKey = `lock:${from}`;

  const msgId = String(sourceMsgId || '').trim() || `${from}:${Date.now()}`;
  const safeMsgId = String(sourceMsgId || msgId || '').trim();

  let reply;

  try {
    const tz = userProfile?.timezone || userProfile?.tz || 'UTC';
    let pending = await getPendingTransactionState(from);

    // If user previously hit "edit", treat this message as brand new revenue command.
    if (pending?.isEditing && pending?.type === 'revenue') {
      await deletePendingTransactionState(from);
      pending = null;
    }

    // Follow-up: revenue clarification
    if (pending?.awaitingRevenueClarification) {
      const maybeDate = parseNaturalDate(input, tz);

      if (maybeDate) {
        const draft = pending.revenueDraftText || '';
        const parsed = parseRevenueMessage(draft) || {};
        const backstop = (await deterministicRevenueParse({ input: draft, tz })) || {};
        const merged = normalizeRevenueData({ ...backstop, ...parsed, date: maybeDate }, tz);

        await mergePendingTransactionState(from, {
          ...pending,
          pendingRevenue: merged,
          awaitingRevenueClarification: false
        });

        const payerPart = merged.source && merged.source !== 'Unknown' ? ` from ${merged.source}` : '';
        const summaryLine = `You received ${merged.amount}${payerPart} on ${merged.date}${
          merged.jobName ? ` for ${merged.jobName}` : ''
        }.`;
        return await sendConfirmRevenueOrFallback(from, summaryLine);
      }

      reply = `What date was this Revenue received? (e.g., 2025-12-12 or "today")`;
      return twimlText(reply);
    }

    // Follow-up: ask for job
    if (pending?.awaitingRevenueJob && pending?.pendingRevenue) {
      const jobReply = normalizeJobAnswer(input);
      const finalJob = looksLikeOverhead(jobReply) ? 'Overhead' : jobReply || null;

      const merged = normalizeRevenueData({ ...pending.pendingRevenue, jobName: finalJob }, tz);

      await mergePendingTransactionState(from, {
        ...pending,
        pendingRevenue: merged,
        awaitingRevenueJob: false
      });

      const payerPart = merged.source && merged.source !== 'Unknown' ? ` from ${merged.source}` : '';
      const summaryLine = `You received ${merged.amount}${payerPart} on ${merged.date}${
        merged.jobName ? ` for ${merged.jobName}` : ''
      }.`;
      return await sendConfirmRevenueOrFallback(from, summaryLine);
    }

    // --- CONFIRM FLOW ---
    if (pending?.pendingRevenue) {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = '⚠️ Only the owner can manage revenue.';
        return twimlText(reply);
      }

      const token = normalizeDecisionToken(input);

      // ✅ stable id across retries (idempotency)
      const stableMsgId = String(pending.revenueSourceMsgId || safeMsgId).trim();

      if (token === 'yes') {
        console.info('[REVENUE] confirm YES', { from, ownerId, stableMsgId });

        const pendingMediaMeta = pending?.pendingMediaMeta || null;
        const data = normalizeRevenueData(pending.pendingRevenue || {}, tz);

        let jobName = (data.jobName && String(data.jobName).trim()) || null;
        if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

        if (!jobName) {
          await mergePendingTransactionState(from, {
            ...pending,
            pendingRevenue: data,
            awaitingRevenueJob: true,
            revenueSourceMsgId: stableMsgId,
            type: 'revenue'
          });
          reply = `Which job is this Revenue for? Reply with the job name (or "Overhead").`;
          return twimlText(reply);
        }

        const category =
          data.suggestedCategory ||
          (await withTimeout(Promise.resolve(categorizeEntry('revenue', data, ownerProfile)), 1200, null)) ||
          null;

        const gate = assertRevenueCILOrClarify({
          ownerId,
          from,
          userProfile,
          data,
          jobName,
          category,
          sourceMsgId: stableMsgId
        });

        if (!gate.ok) {
          return twimlText(String(gate.reply || '⚠️ Could not log that Revenue yet.').slice(0, 1500));
        }

        const result = await withTimeout(
          writeRevenueViaCanonicalInsert({
            ownerId,
            from,
            userProfile,
            data,
            jobName,
            category,
            sourceMsgId: stableMsgId,
            pendingMediaMeta
          }),
          5000,
          '__DB_TIMEOUT__'
        );

        if (result === '__DB_TIMEOUT__') {
          await mergePendingTransactionState(from, {
            ...pending,
            pendingRevenue: { ...data, jobName, suggestedCategory: category || data.suggestedCategory },
            revenueSourceMsgId: stableMsgId,
            type: 'revenue'
          });

          reply = `⚠️ Saving is taking longer than expected (database slow). Please tap Yes again in a few seconds.`;
          return twimlText(reply);
        }

        const payerPart = data.source && data.source !== 'Unknown' ? ` from ${data.source}` : '';

        reply =
          result?.inserted === false
            ? '✅ Already logged that Revenue (duplicate message).'
            : `✅ Revenue logged: ${data.amount}${payerPart} for ${jobName}${category ? ` (Category: ${category})` : ''}`;

        await deletePendingTransactionState(from);
        return twimlText(reply);
      }

      if (token === 'edit') {
        await deletePendingTransactionState(from);
        reply = '✏️ Okay — resend the Revenue details in one line (e.g., "received $100 for 1556 Medway Park Dr today").';
        return twimlText(reply);
      }

      if (token === 'cancel') {
        await deletePendingTransactionState(from);
        reply = '❌ Revenue entry cancelled.';
        return twimlText(reply);
      }

      reply = `⚠️ Please choose Yes, Edit, or Cancel.`;
      return twimlText(reply);
    }

    // --- PARSE PATH (Deterministic first, AI fallback) ---
    const deterministic = await deterministicRevenueParse({ input, tz });
    let data = deterministic;
    let aiReply = null;

    if (!data) {
      const aiRes = await handleInputWithAI(from, input, 'revenue', parseRevenueMessage, {
        date: todayInTimeZone(tz),
        description: 'Unknown',
        amount: '$0.00',
        source: 'Unknown'
      });
      data = aiRes?.data || null;
      aiReply = aiRes?.reply || null;
      if (data) data = normalizeRevenueData(data, tz);
    }

    // If AI asked a clarification question, store it as "awaitingRevenueClarification"
    if (aiReply) {
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingRevenue: null,
        awaitingRevenueClarification: true,
        revenueClarificationPrompt: aiReply,
        revenueDraftText: input,
        revenueSourceMsgId: safeMsgId,
        type: 'revenue'
      });
      return twimlText(aiReply);
    }

    // normalize "source" that actually contains a job/address
    if (data) {
      const existingJob = String(data.jobName || '').trim();
      const srcRaw = String(data.source || '').trim();

      if (!existingJob && srcRaw) {
        const srcClean = normalizeJobAnswer(srcRaw);
        const srcLooksJob = /^\s*job\b/i.test(srcRaw) || looksLikeAddress(srcClean) || looksLikeAddress(srcRaw);

        if (srcLooksJob) {
          data.jobName = looksLikeOverhead(srcClean) ? 'Overhead' : srcClean;
          data.source = 'Unknown';
        }
      }
    }

    if (data && data.amount && data.amount !== '$0.00') {
      if (!data.date) data.date = todayInTimeZone(tz);

      let errors = null;
      try {
        errors = await detectErrors(data, 'revenue');
        if (errors == null) errors = await detectErrors('revenue', data);
      } catch (e) {
        console.warn('[REVENUE] detectErrors threw; ignoring (fail-open):', e?.message);
        errors = null;
      }

      // ignore "missing source/client" if we consider it optional
      if (errors) {
        const s = String(errors);
        if (/client:\s*missing|source:\s*missing/i.test(s)) errors = null;
      }

      const category =
        (await withTimeout(Promise.resolve(categorizeEntry('revenue', data, ownerProfile)), 1200, null)) || null;

      data.suggestedCategory = category;

      let jobName = (data.jobName && String(data.jobName).trim()) || null;
      if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

      if (!jobName) {
        await mergePendingTransactionState(from, {
          ...(pending || {}),
          pendingRevenue: data,
          awaitingRevenueJob: true,
          revenueSourceMsgId: safeMsgId,
          type: 'revenue'
        });
        reply = `Which job is this Revenue for? Reply with the job name (or "Overhead").`;
        return twimlText(reply);
      }

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingRevenue: { ...data, jobName },
        revenueSourceMsgId: safeMsgId,
        type: 'revenue'
      });

      const payerPart = data.source && data.source !== 'Unknown' ? ` from ${data.source}` : '';
      const summaryLine = `You received ${data.amount}${payerPart} on ${data.date} for ${jobName}.`;
      return await sendConfirmRevenueOrFallback(from, summaryLine);
    }

    reply = `🤔 Couldn’t parse Revenue from "${input}". Try "received $100 for 1556 Medway Park Dr today".`;
    return twimlText(reply);
  } catch (error) {
    console.error(`[ERROR] handleRevenue failed for ${from}:`, error?.message, {
      code: error?.code,
      detail: error?.detail,
      constraint: error?.constraint
    });
    reply = '⚠️ Error logging Revenue. Please try again.';
    return twimlText(reply);
  } finally {
    try {
      await require('../../middleware/lock').releaseLock(lockKey);
    } catch {}
  }
}

module.exports = { handleRevenue };
