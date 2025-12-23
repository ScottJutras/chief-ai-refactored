// handlers/commands/revenue.js

const {
  insertTransaction,
  normalizeMediaMeta,
  DIGITS
} = require('../../services/postgres');

const state = require('../../utils/stateManager');
const getPendingTransactionState = state.getPendingTransactionState;
const deletePendingTransactionState = state.deletePendingTransactionState;

// Prefer mergePendingTransactionState; fall back to setPendingTransactionState with merge:true
const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

const ai = require('../../utils/aiErrorHandler');

// Optional: log once if detectErrors isn't available (we'll fail-open)
if (typeof ai.detectErrors !== 'function' && typeof ai.detectError !== 'function') {
  console.warn('[REVENUE] aiErrorHandler has no detectErrors; skipping error detection (fail-open).');
}

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

console.info('[REVENUE] cil export keys', {
  keys: Object.keys(cilMod || {}),
  validateCILType: typeof validateCIL
});

if (!validateCIL) {
  console.warn('[REVENUE] validateCIL not found in ../../cil export; CIL gate will be fail-open until fixed.');
}

/* ---------------- helpers ---------------- */

function toCents(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function toNumberAmount(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n;
}

function todayInTimeZone(tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    return dtf.format(new Date()); // YYYY-MM-DD
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

function parseNaturalDate(s, tz) {
  const t = String(s || '').trim().toLowerCase();
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

  const parsed = Date.parse(s);
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
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms))
  ]);
}

function buildRevenueCIL({ from, data, jobName, category, sourceMsgId }) {
  const cents = toCents(data.amount);

  const description =
    String(data.description || '').trim() && data.description !== 'Unknown'
      ? String(data.description).trim()
      : 'Payment received';

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

    // FAIL-OPEN if validator missing (prevents blocking ingestion)
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
    return { ok: false, reply: `⚠️ Couldn't log that payment yet. Try: "received 2500 for <job> today".` };
  }
}

/**
 * Deterministic parse:
 * - amount: $100 or 100
 * - date: today/yesterday/tomorrow/YYYY-MM-DD
 * - job: "for <job>" OR "on <job>" OR "job <job>" OR address-like token after "from" if it looks like job/address
 * - payer optional: only if it DOESN’T look like address/job
 *
 * NOTE: "from <job>" is common; we'll treat address-like from as job.
 */
async function deterministicRevenueParse({ ownerId, input, tz }) {
  const raw = String(input || '').trim();

  // amount
  const amtMatch =
    raw.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/) ||
    raw.match(/\b([0-9]+(?:\.[0-9]{1,2})?)\b/);

  if (!amtMatch) return null;

  const amountNum = amtMatch[1];
  const amount = `$${Number(amountNum).toFixed(2)}`;

  // date
  let date = null;
  if (/\btoday\b/i.test(raw)) date = parseNaturalDate('today', tz);
  else if (/\byesterday\b/i.test(raw)) date = parseNaturalDate('yesterday', tz);
  else if (/\btomorrow\b/i.test(raw)) date = parseNaturalDate('tomorrow', tz);
  else {
    const iso = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (iso) date = iso[1];
  }
  if (!date) date = todayInTimeZone(tz);

  // job patterns
  let jobName = null;

  const forMatch = raw.match(/\bfor\s+(.+?)(?:\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|$)/i);
  if (forMatch?.[1]) jobName = normalizeJobAnswer(forMatch[1]);

  if (!jobName) {
    const onMatch = raw.match(/\bon\s+(.+?)(?:\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|$)/i);
    if (onMatch?.[1]) jobName = normalizeJobAnswer(onMatch[1]);
  }

  if (!jobName) {
    const jobMatch = raw.match(/\bjob\s+(.+?)(?:\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|$)/i);
    if (jobMatch?.[1]) jobName = normalizeJobAnswer(jobMatch[1]);
  }

  // "from X" might be job/address or payer
  let source = 'Unknown';
  const fromMatch = raw.match(/\bfrom\s+(.+?)(?:\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|$)/i);
  if (fromMatch?.[1]) {
    const token = normalizeJobAnswer(fromMatch[1]);
    if (looksLikeAddress(token)) {
      jobName = jobName || token;
      source = 'Unknown';
    } else {
      source = token; // payer
    }
  }

  // overhead normalization
  if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

  return {
    date,
    description: 'Payment received',
    amount,
    source,
    jobName
  };
}

/**
 * Canonical insert: delegates to services/postgres.insertTransaction()
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
  const owner = DIGITS(ownerId || '');
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

  // If you want to suppress "Service" unless user explicitly said it, change this to:
  // if (c.toLowerCase() === 'service') return null;
  const safeCategory = (() => {
    const c = String(category || '').trim();
    if (!c) return null;
    return c;
  })();

  const payload = {
    ownerId: owner,
    kind: 'revenue',
    date: String(data.date || '').trim() || todayInTimeZone(tz),
    description: String(data.description || 'Payment received').trim() || 'Payment received',
    amount_cents: amountCents,
    amount: toNumberAmount(data.amount), // optional numeric (schema-aware in insertTransaction)
    source: (data.source && data.source !== 'Unknown') ? String(data.source).trim() : 'Unknown',
    job: jobName ? String(jobName).trim() : null,
    job_name: jobName ? String(jobName).trim() : null,
    category: safeCategory,
    user_name: String(userProfile?.name || '').trim() || null,
    source_msg_id: String(sourceMsgId || '').trim() || null,
    actor_phone: from ? String(from) : null,
    mediaMeta: mediaMeta ? { ...mediaMeta } : null
  };

  return await insertTransaction(payload, { timeoutMs: 4500 });
}

// Clear ONLY media meta after successful write so it doesn't attach to next txn
async function clearPendingMediaMeta(from, pending) {
  try {
    if (!pending) return;
    if (!pending.pendingMediaMeta && !pending.pendingMedia) return;

    await mergePendingTransactionState(from, {
      ...(pending || {}),
      pendingMediaMeta: null,
      pendingMedia: false
    });
  } catch {}
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

    // Follow-up: revenue clarification (date, etc.)
    if (pending?.awaitingRevenueClarification) {
      const maybeDate = parseNaturalDate(input, tz);

      if (maybeDate) {
        const draft = pending.revenueDraftText || '';
        const parsed = parseRevenueMessage(draft) || {};
        const merged = { ...parsed, date: maybeDate };

        await mergePendingTransactionState(from, {
          ...pending,
          pendingRevenue: merged,
          awaitingRevenueClarification: false
        });

        reply = `Please confirm: Payment ${merged.amount} on ${merged.date}. Reply yes/edit/cancel.`;
        return `<Response><Message>${reply}</Message></Response>`;
      }

      reply = `What date was this payment? (e.g., 2025-12-12 or "today")`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    // Follow-up: ask for job
    if (pending?.awaitingRevenueJob && pending?.pendingRevenue) {
      const jobReply = normalizeJobAnswer(input);
      const finalJob = looksLikeOverhead(jobReply) ? 'Overhead' : jobReply;

      const merged = { ...pending.pendingRevenue, jobName: finalJob };

      await mergePendingTransactionState(from, {
        ...pending,
        pendingRevenue: merged,
        awaitingRevenueJob: false
      });

      const payerPart =
        merged.source && merged.source !== 'Unknown' ? ` from ${merged.source}` : '';

      reply = `Please confirm: Payment ${merged.amount}${payerPart} on ${merged.date} for ${merged.jobName}. Reply yes/edit/cancel.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    // --- CONFIRM FLOW ---
    if (pending?.pendingRevenue) {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = '⚠️ Only the owner can manage revenue.';
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const lcInput = String(input || '').toLowerCase().trim();
      const stableMsgId = String(pending.revenueSourceMsgId || safeMsgId).trim();

      if (lcInput === 'yes') {
        console.info('[REVENUE] confirm YES', { from, ownerId, stableMsgId });

        const data = pending.pendingRevenue || {};
        const pendingMediaMeta = pending?.pendingMediaMeta || null;

        // job required (or Overhead)
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
          reply = `Which job is this payment for? Reply with the job name (or "Overhead").`;
          return `<Response><Message>${reply}</Message></Response>`;
        }

        const category =
          data.suggestedCategory ||
          (await withTimeout(
            Promise.resolve(categorizeEntry('revenue', data, ownerProfile)),
            1200,
            null
          ));

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
          return `<Response><Message>${String(gate.reply || '⚠️ Could not log that payment yet.').slice(0, 1500)}</Message></Response>`;
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
          // keep pending so they can resend "yes"
          await mergePendingTransactionState(from, {
            ...pending,
            pendingRevenue: { ...data, jobName, suggestedCategory: category || data.suggestedCategory },
            revenueSourceMsgId: stableMsgId,
            type: 'revenue'
          });

          reply = `⚠️ Saving is taking longer than expected (database slow). Please reply "yes" again in a few seconds.`;
          return `<Response><Message>${reply}</Message></Response>`;
        }

        const payerPart =
          data.source && data.source !== 'Unknown' ? ` from ${data.source}` : '';

        reply =
          result?.inserted === false
            ? '✅ Already logged that payment (duplicate message).'
            : `✅ Payment logged: ${data.amount}${payerPart} on ${jobName}${category ? ` (Category: ${category})` : ''}`;

        // Clear everything (includes media meta)
        await deletePendingTransactionState(from);
        return `<Response><Message>${reply}</Message></Response>`;
      }

      if (lcInput === 'edit' || lcInput === 'no') {
        await mergePendingTransactionState(from, {
          ...pending,
          isEditing: true,
          type: 'revenue',
          awaitingRevenueClarification: false,
          awaitingRevenueJob: false
        });

        reply = '✏️ Okay — resend the payment in one line (e.g., "received $100 for 1556 Medway Park Dr today").';
        return `<Response><Message>${reply}</Message></Response>`;
      }

      if (lcInput === 'cancel') {
        await deletePendingTransactionState(from);
        reply = '❌ Payment cancelled.';
        return `<Response><Message>${reply}</Message></Response>`;
      }

      reply = `⚠️ Please respond with 'yes', 'edit', or 'cancel'.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    // --- PARSE PATH (Deterministic first, AI fallback) ---
    const deterministic = await deterministicRevenueParse({ ownerId, input, tz });

    let data = deterministic;
    let confirmed = true;
    let aiReply = null;

    if (!data) {
      const aiRes = await handleInputWithAI(from, input, 'revenue', parseRevenueMessage, {
        date: todayInTimeZone(tz),
        description: 'Unknown',
        amount: '$0.00',
        source: 'Unknown'
      });
      data = aiRes?.data || null;
      confirmed = !!aiRes?.confirmed;
      aiReply = aiRes?.reply || null;
    }

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
      return `<Response><Message>${aiReply}</Message></Response>`;
    }

    if (data && data.amount && data.amount !== '$0.00') {
      if (!data.date) data.date = todayInTimeZone(tz);

      // ignore client/source missing errors for contractor revenue
      let errors = null;
      try {
        errors = await detectErrors(data, 'revenue');
        if (errors == null) errors = await detectErrors('revenue', data);
      } catch (e) {
        console.warn('[REVENUE] detectErrors threw; ignoring (fail-open):', e?.message);
        errors = null;
      }

      if (errors) {
        const s = String(errors);
        if (/client:\s*missing|source:\s*missing/i.test(s)) errors = null;
      }

      const category =
        (await withTimeout(
          Promise.resolve(categorizeEntry('revenue', data, ownerProfile)),
          1200,
          null
        )) || null;

      data.suggestedCategory = category;

      // require job (or overhead)
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
        reply = `Which job is this payment for? Reply with the job name (or "Overhead").`;
        return `<Response><Message>${reply}</Message></Response>`;
      }

      // If confirmed and no errors, you could auto-write here.
      // For contractor UX + safety, we keep the confirm step.
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingRevenue: { ...data, jobName },
        revenueSourceMsgId: safeMsgId,
        type: 'revenue'
      });

      const payerPart =
        data.source && data.source !== 'Unknown' ? ` from ${data.source}` : '';

      reply = `Please confirm: Payment ${data.amount}${payerPart} on ${data.date} for ${jobName}. Reply yes/edit/cancel.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    reply = `🤔 Couldn’t parse a payment from "${input}". Try "received $100 for 1556 Medway Park Dr today".`;
    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleRevenue failed for ${from}:`, error?.message, {
      code: error?.code,
      detail: error?.detail,
      constraint: error?.constraint
    });
    reply = '⚠️ Error logging payment. Please try again.';
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    try {
      await require('../../middleware/lock').releaseLock(lockKey);
    } catch {}
  }
}

module.exports = { handleRevenue };
