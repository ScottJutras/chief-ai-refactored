// handlers/commands/revenue.js
const { query } = require('../../services/postgres');
const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState
} = require('../../utils/stateManager');
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

const { validateCIL } = require('../../cil');

// ---- column presence caches (safe in serverless) ----
let _hasSourceMsgIdCol = null;
let _hasAmountCol = null;

async function hasColumn(table, col) {
  const r = await query(
    `select 1
       from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
        and column_name = $2
      limit 1`,
    [table, col]
  );
  return (r?.rows?.length || 0) > 0;
}

async function hasSourceMsgIdColumn() {
  if (_hasSourceMsgIdCol !== null) return _hasSourceMsgIdCol;
  try { _hasSourceMsgIdCol = await hasColumn('transactions', 'source_msg_id'); }
  catch { _hasSourceMsgIdCol = false; }
  return _hasSourceMsgIdCol;
}

async function hasAmountColumn() {
  if (_hasAmountCol !== null) return _hasAmountCol;
  try { _hasAmountCol = await hasColumn('transactions', 'amount'); }
  catch { _hasAmountCol = false; }
  return _hasAmountCol;
}

function toCents(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function toDollars(amountStr) {
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

// ---------- contractor-first parsing helpers ----------

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

async function findJobByName(ownerId, name) {
  const ownerParam = String(ownerId || '').trim();
  const n = String(name || '').trim();
  if (!ownerParam || !n) return null;

  try {
    const { rows } = await query(
      `
      select job_no, coalesce(name, job_name) as job_name
        from public.jobs
       where owner_id = $1
         and lower(coalesce(name, job_name)) = lower($2)
       order by created_at desc
       limit 1
      `,
      [ownerParam, n]
    );
    return rows?.[0] || null;
  } catch {
    return null;
  }
}

function withTimeout(promise, ms, fallbackValue = null) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms))
  ]);
}

/**
 * Deterministic parse:
 * - amount: $100 or 100
 * - date: today/yesterday/tomorrow/YYYY-MM-DD
 * - job: "for <job>" OR "on <job>" OR "job <job>" OR address-like token after "from" if it looks like job/address
 * - payer optional: only if it DOESN’T look like address/job
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
    const jobHit = await findJobByName(ownerId, token);
    if (jobHit || looksLikeAddress(token)) {
      jobName = jobName || token; // treat as job
      source = 'Unknown';
    } else {
      source = token; // treat as payer
    }
  }

  // overhead normalization
  if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

  return {
    date,
    description: 'Unknown',
    amount,
    source,
    jobName
  };
}

function buildRevenueCIL({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  const cents = toCents(data.amount);
  return {
    cil_version: '1.0',
    type: 'payment',
    tenant_id: String(ownerId),
    source: 'whatsapp',
    source_msg_id: String(sourceMsgId),
    actor: {
      actor_id: String(userProfile?.user_id || from || 'unknown'),
      role: 'owner'
    },
    occurred_at: new Date().toISOString(),
    job: jobName ? { job_name: String(jobName) } : null,
    needs_job_resolution: !jobName,
    amount_cents: cents,
    currency: 'CAD',
    payer: data.source && data.source !== 'Unknown' ? String(data.source) : undefined,
    memo: data.description && data.description !== 'Unknown' ? String(data.description) : undefined,
    category: category ? String(category) : undefined
  };
}

function assertRevenueCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  try {
    const cil = buildRevenueCIL({ ownerId, from, userProfile, data, jobName, category, sourceMsgId });
    validateCIL(cil);
    return { ok: true, cil };
  } catch {
    return { ok: false, reply: `⚠️ Couldn't log that payment yet. Try: "received 2500 for <job> today".` };
  }
}

async function saveRevenue({ ownerId, date, description, amount, source, jobName, category, user, sourceMsgId, from }) {
  const amountCents = toCents(amount);
  const amountDollars = toDollars(amount);

  if (!amountCents || amountCents <= 0) throw new Error('Invalid amount');
  if (!Number.isFinite(amountDollars) || amountDollars <= 0) throw new Error('Invalid amount');

  const ownerParam = String(ownerId || '').trim();
  const msgParam = String(sourceMsgId || '').trim() || null;

  const canUseMsgId = await hasSourceMsgIdColumn();
  const canUseAmount = await hasAmountColumn();

  const payer = String(source || '').trim() || 'Unknown';
  const job = jobName ? String(jobName).trim() : null;

  // NOTE: we do NOT include created_at in cols/vals.
  // We always set created_at = now() in SQL to avoid mismatched column/value counts.
  const cols = [
    'owner_id',
    'kind',
    'date',
    'description',
    ...(canUseAmount ? ['amount'] : []),
    'amount_cents',
    'source',
    'job',
    'job_name',
    'category',
    'user_name',
    ...(canUseMsgId ? ['source_msg_id'] : [])
  ];

  const vals = [
    ownerParam,
    'revenue',
    date,
    String(description || '').trim() || 'Unknown',
    ...(canUseAmount ? [amountDollars] : []),
    amountCents,
    payer,
    job,
    job, // job_name mirrors job for compatibility
    category ? String(category).trim() : null,
    user ? String(user).trim() : null,
    ...(canUseMsgId ? [msgParam] : [])
  ];

  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  // Use ON CONFLICT only when source_msg_id exists (idempotency).
  // Because your unique index is partial (WHERE source_msg_id IS NOT NULL),
  // match it with a conflict target that includes the WHERE clause.
  const sql = canUseMsgId
    ? `
      insert into public.transactions (${cols.join(', ')}, created_at)
      values (${placeholders}, now())
      on conflict (owner_id, source_msg_id) where source_msg_id is not null
      do nothing
      returning id
    `
    : `
      insert into public.transactions (${cols.join(', ')}, created_at)
      values (${placeholders}, now())
      returning id
    `;

  try {
    const res = await query(sql, vals);
    if (!res?.rows?.length) return { inserted: false };
    return { inserted: true, id: res.rows[0].id };
  } catch (e) {
    console.error('[REVENUE] insert failed', {
      ownerId: ownerParam,
      from,
      code: e?.code,
      detail: e?.detail,
      constraint: e?.constraint,
      message: e?.message
    });
    throw e;
  }
}

async function handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  const lockKey = `lock:${from}`;
  const msgId = String(sourceMsgId || '').trim() || `${from}:${Date.now()}`;
  const safeMsgId = String(sourceMsgId || msgId || '').trim(); // always defined
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

        await setPendingTransactionState(from, {
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

      await setPendingTransactionState(from, {
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
      const stableMsgId = String(pending.revenueSourceMsgId || safeMsgId).trim(); // always defined

      if (lcInput === 'yes') {
        console.info('[REVENUE] confirm YES', { from, ownerId, stableMsgId });

        const data = pending.pendingRevenue || {};

        // job required (or Overhead)
        let jobName = (data.jobName && String(data.jobName).trim()) || null;
        if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

        if (!jobName) {
          await setPendingTransactionState(from, {
            ...pending,
            pendingRevenue: data,
            awaitingRevenueJob: true,
            revenueSourceMsgId: stableMsgId,
            type: 'revenue'
          });
          reply = `Which job is this payment for? Reply with the job name (or "Overhead").`;
          return `<Response><Message>${reply}</Message></Response>`;
        }

        console.info('[REVENUE] pre-category', { stableMsgId });

        const category =
          data.suggestedCategory ||
          (await withTimeout(
            Promise.resolve(categorizeEntry('revenue', data, ownerProfile)),
            1200,
            null
          )) ||
          null;

        console.info('[REVENUE] post-category', { stableMsgId, category });
        console.info('[REVENUE] pre-insert', { stableMsgId, ownerId, date: data.date, amount: data.amount, jobName });

        const gate = assertRevenueCILOrClarify({
          ownerId,
          from,
          userProfile,
          data,
          jobName,
          category,
          sourceMsgId: stableMsgId
        });
        if (!gate.ok) return `<Response><Message>${gate.reply}</Message></Response>`;

        const result = await saveRevenue({
          ownerId,
          date: data.date || todayInTimeZone(tz),
          description: data.description,
          amount: data.amount,
          source: data.source,
          jobName,
          category,
          user: userProfile?.name || 'Unknown User',
          sourceMsgId: stableMsgId,
          from
        });

        console.info('[REVENUE] post-insert', { stableMsgId, inserted: result?.inserted });

        const payerPart =
          data.source && data.source !== 'Unknown' ? ` from ${data.source}` : '';

        reply =
          result.inserted === false
            ? '✅ Already logged that payment (duplicate message).'
            : `✅ Payment logged: ${data.amount}${payerPart} on ${jobName}${category ? ` (Category: ${category})` : ''}`;

        await deletePendingTransactionState(from);
        return `<Response><Message>${reply}</Message></Response>`;
      }

      if (lcInput === 'edit' || lcInput === 'no') {
        await setPendingTransactionState(from, {
          ...pending,
          isEditing: true,
          type: 'revenue',
          pendingCorrection: false,
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
      await setPendingTransactionState(from, {
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
        // support both detectErrors(data, kind) and detectErrors(kind, data)
        errors = await detectErrors(data, 'revenue');
        if (errors == null) {
          // try alternate signature if the implementation expects (kind, data)
          errors = await detectErrors('revenue', data);
        }
      } catch (e) {
        console.warn('[REVENUE] detectErrors threw; ignoring (fail-open):', e?.message);
        errors = null;
      }

      if (errors) {
        const s = String(errors);
        if (/client:\s*missing|source:\s*missing/i.test(s)) errors = null;
      }

      // TIMEOUT categorization here too (prevents hangs on parse-path)
      const category =
        (await withTimeout(
          Promise.resolve(categorizeEntry('revenue', data, ownerProfile)),
          1200,
          null
        )) ||
        null;

      data.suggestedCategory = category;

      // require job (or overhead)
      let jobName = (data.jobName && String(data.jobName).trim()) || null;
      if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

      if (!jobName) {
        await setPendingTransactionState(from, {
          pendingRevenue: data,
          awaitingRevenueJob: true,
          revenueSourceMsgId: safeMsgId,
          type: 'revenue'
        });
        reply = `Which job is this payment for? Reply with the job name (or "Overhead").`;
        return `<Response><Message>${reply}</Message></Response>`;
      }

      // confirmed + clean => write
      if (confirmed && !errors) {
        const gate = assertRevenueCILOrClarify({
          ownerId, from, userProfile, data, jobName, category, sourceMsgId: safeMsgId
        });
        if (!gate.ok) return `<Response><Message>${gate.reply}</Message></Response>`;

        const result = await saveRevenue({
          ownerId,
          date: data.date,
          description: data.description,
          amount: data.amount,
          source: data.source,
          jobName,
          category,
          user: userProfile?.name || 'Unknown User',
          sourceMsgId: safeMsgId,
          from
        });

        const payerPart =
          data.source && data.source !== 'Unknown' ? ` from ${data.source}` : '';

        reply =
          result.inserted === false
            ? '✅ Already logged that payment (duplicate message).'
            : `✅ Payment logged: ${data.amount}${payerPart} on ${jobName}${category ? ` (Category: ${category})` : ''}`;

        return `<Response><Message>${reply}</Message></Response>`;
      }

      // else confirm
      await setPendingTransactionState(from, {
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
