// handlers/commands/revenue.js
const { query } = require('../../services/postgres');
const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState
} = require('../../utils/stateManager');
const {
  handleInputWithAI,
  parseRevenueMessage,
  detectErrors,
  categorizeEntry
} = require('../../utils/aiErrorHandler');
const { validateCIL } = require('../../cil');

// ---- column presence caches (safe in serverless) ----
let _hasSourceMsgIdCol = null;
// NOTE: your schema shows "amount" exists and is NOT NULL, but keep cache for safety
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
  try {
    _hasSourceMsgIdCol = await hasColumn('transactions', 'source_msg_id');
  } catch {
    _hasSourceMsgIdCol = false;
  }
  return _hasSourceMsgIdCol;
}

async function hasAmountColumn() {
  if (_hasAmountCol !== null) return _hasAmountCol;
  try {
    _hasAmountCol = await hasColumn('transactions', 'amount');
  } catch {
    _hasAmountCol = false;
  }
  return _hasAmountCol;
}

// ------------------ money + date helpers ------------------

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

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(str || '')
  );
}

function todayInTimeZone(tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
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

// ------------------ contractor-first job helpers ------------------

function normalizeJobAnswer(text) {
  let s = String(text || '').trim();

  // Strip common prefixes
  s = s.replace(/^(job\s*name|job)\s*[:\-]?\s*/i, '');

  // If user accidentally types a command while answering the job question,
  // do NOT create anything here; just use the remainder as the job name.
  s = s.replace(/^(create|new)\s+job\s+/i, '');

  // Trim trailing punctuation like '?'
  s = s.replace(/[?]+$/g, '').trim();

  return s;
}

function looksLikeOverhead(s) {
  const t = String(s || '').trim().toLowerCase();
  return t === 'overhead' || t === 'oh';
}

// very light "address-like" heuristic (helps for "from 1556 Medway Park Dr")
function looksLikeAddress(s) {
  const t = String(s || '').trim();
  if (!/\d/.test(t)) return false;
  return /\b(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|cir|circle|way|trail|trl|pk|pkwy|park)\b/i.test(t);
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
         and (
           lower(coalesce(name, job_name)) = lower($2)
           or lower(name) = lower($2)
           or lower(job_name) = lower($2)
         )
       order by created_at desc
       limit 1
      `,
      [ownerParam, n]
    );
    return rows?.[0] || null;
  } catch (e) {
    console.warn('[revenue] findJobByName failed:', e?.message);
    return null;
  }
}

/**
 * If a parsed "source" looks like a job (matches existing job or looks like an address),
 * treat it as jobName (contractor-first) and make payer optional.
 */
async function coerceSourceToJobIfLikely({ ownerId, data }) {
  if (!data) return data;
  const out = { ...data };

  const source = String(out.source || '').trim();
  const hasJobAlready = !!(out.jobName && String(out.jobName).trim());

  if (!hasJobAlready && source && source.toLowerCase() !== 'unknown') {
    const jobHit = await findJobByName(ownerId, source);

    // If it matches an existing job OR looks like an address, treat it as the job
    if (jobHit || looksLikeAddress(source)) {
      out.jobName = source;
      // payer/client becomes optional; don’t force it
      out.source = 'Unknown';
      // description stays as-is (memo)
    }
  }

  return out;
}

/**
 * Resolve active job name safely (avoid int=uuid comparisons).
 * Priority:
 *  1) userProfile.active_job_name
 *  2) userProfile.active_job_id (uuid) -> jobs.id
 *  3) userProfile.active_job_id numeric -> jobs.job_no
 */
async function resolveActiveJobName({ ownerId, userProfile }) {
  const ownerParam = String(ownerId || '').trim();

  const name = userProfile?.active_job_name || userProfile?.activeJobName || null;
  if (name && String(name).trim()) return String(name).trim();

  const ref = userProfile?.active_job_id ?? userProfile?.activeJobId ?? null;
  if (ref == null) return null;

  const s = String(ref).trim();

  // UUID jobs.id
  if (looksLikeUuid(s)) {
    try {
      const r = await query(
        `select coalesce(name, job_name) as job_name
           from public.jobs
          where owner_id = $1 and id = $2::uuid
          limit 1`,
        [ownerParam, s]
      );
      if (r?.rows?.[0]?.job_name) return r.rows[0].job_name;
    } catch (e) {
      console.warn('[revenue] resolveActiveJobName uuid failed:', e?.message);
    }
  }

  // Integer jobs.job_no
  if (/^\d+$/.test(s)) {
    try {
      const r = await query(
        `select coalesce(name, job_name) as job_name
           from public.jobs
          where owner_id = $1 and job_no = $2::int
          limit 1`,
        [ownerParam, Number(s)]
      );
      if (r?.rows?.[0]?.job_name) return r.rows[0].job_name;
    } catch (e) {
      console.warn('[revenue] resolveActiveJobName job_no failed:', e?.message);
    }
  }

  return null;
}

// ------------------ CIL ------------------

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
      role: 'owner',
      phone_e164: from && String(from).startsWith('+') ? String(from) : undefined
    },

    occurred_at: new Date().toISOString(),
    job: jobName ? { job_name: String(jobName) } : null,
    needs_job_resolution: !jobName,

    amount_cents: cents,
    currency: 'CAD',

    // payer is OPTIONAL now (contractor-first)
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
    return {
      ok: false,
      // contractor-first copy
      reply: `⚠️ Couldn't log that payment yet. Try: "revenue 2500 for <job>" (payer optional).`
    };
  }
}

// ------------------ DB write ------------------

/**
 * Persist to transactions (based on your schema dump):
 * id (serial), owner_id (varchar, FK to users.user_id), kind, date, description, amount (numeric), amount_cents (bigint),
 * source, job (varchar), job_name (text), category, user_name, source_msg_id, created_at
 *
 * We write BOTH job and job_name for maximum compatibility.
 */
async function saveRevenue({ ownerId, date, description, amount, source, jobName, category, user, sourceMsgId, from, messageSid }) {
  const amountCents = toCents(amount);
  const amountDollars = toDollars(amount);

  if (!amountCents || amountCents <= 0) throw new Error('Invalid amount');
  if (!amountDollars || amountDollars <= 0) throw new Error('Invalid amount');

  const ownerParam = String(ownerId || '').trim();
  const msgParam = String(sourceMsgId || '').trim() || null;

  // payer is optional; keep Unknown if absent
  const payer = String(source || '').trim() || 'Unknown';

  // job is required for your contractor flow (allow "Overhead")
  const job = jobName ? String(jobName).trim() : null;

  // detect columns
  const canUseMsgId = await hasSourceMsgIdColumn();
  const canUseAmount = await hasAmountColumn(); // should be true in your DB

  const cols = [
    'owner_id',
    'kind',
    'date',
    'description',
    'amount_cents',
    'source',
    'job',
    'job_name',
    'category',
    'user_name',
    'created_at'
  ];
  const vals = [
    ownerParam,
    'revenue',
    date,
    String(description || '').trim() || 'Unknown',
    amountCents,
    payer,
    job,
    job, // job_name mirrors job
    category ? String(category).trim() : null,
    user ? String(user).trim() : null
  ];

  if (canUseAmount) {
    cols.splice(4, 0, 'amount');      // insert amount before amount_cents
    vals.splice(4, 0, amountDollars); // keep alignment
  }

  if (canUseMsgId) {
    cols.splice(cols.length - 1, 0, 'source_msg_id');
    vals.splice(vals.length - 1, 0, msgParam);
  }

  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  const sql = canUseMsgId
    ? `
      insert into public.transactions (${cols.join(', ')})
      values (${placeholders})
      on conflict do nothing
      returning id
    `
    : `
      insert into public.transactions (${cols.join(', ')})
      values (${placeholders})
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
      messageSid,
      code: e?.code,
      detail: e?.detail,
      constraint: e?.constraint,
      table: e?.table,
      column: e?.column,
      message: e?.message
    });
    throw e;
  }
}

// ------------------ pending job requirement ------------------

async function ensureJobOrAsk(from, pending, data, msgId) {
  const stableMsgId = String(pending?.revenueSourceMsgId || msgId).trim();

  const jobCandidate =
    (data?.jobName && String(data.jobName).trim()) ||
    null;

  if (jobCandidate) return { ok: true, jobName: jobCandidate, stableMsgId };

  await setPendingTransactionState(from, {
    ...(pending || {}),
    pendingRevenue: data,
    awaitingRevenueJob: true,
    revenueSourceMsgId: stableMsgId,
    type: 'revenue'
  });

  return {
    ok: false,
    reply: `Which job is this payment for? Reply with the job name (or "Overhead").`,
    stableMsgId
  };
}

// ------------------ main handler ------------------

async function handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  const lockKey = `lock:${from}`;
  const msgId = String(sourceMsgId || '').trim() || `${from}:${Date.now()}`;

  let reply;

  try {
    const tz = userProfile?.timezone || userProfile?.tz || 'UTC';
    const defaultData = {
      date: todayInTimeZone(tz),
      description: 'Unknown',
      amount: '$0.00',
      source: 'Unknown'
    };

    let pending = await getPendingTransactionState(from);

    console.log('[REVENUE] pending keys:', {
      pendingRevenue: !!pending?.pendingRevenue,
      awaitingRevenueClarification: !!pending?.awaitingRevenueClarification,
      awaitingRevenueJob: !!pending?.awaitingRevenueJob,
      pendingCorrection: !!pending?.pendingCorrection,
      isEditing: !!pending?.isEditing,
      type: pending?.type
    });

    // ✅ If user previously hit "edit", treat this message as brand new revenue input
    if (pending?.isEditing && pending?.type === 'revenue') {
      await deletePendingTransactionState(from);
      pending = null;
    }

    // Normalize aiErrorHandler pendingCorrection -> pendingRevenue
    if (pending?.pendingCorrection && pending?.type === 'revenue' && pending?.pendingData) {
      const data = pending.pendingData;
      await setPendingTransactionState(from, {
        ...pending,
        pendingRevenue: data,
        pendingCorrection: false,
        revenueSourceMsgId: pending.revenueSourceMsgId || msgId,
        type: 'revenue'
      });
      pending = await getPendingTransactionState(from);
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

        // contractor-first copy (payer optional, job next)
        reply = `Please confirm: Payment ${merged.amount} on ${merged.date}. Reply yes/edit/cancel.`;
        return `<Response><Message>${reply}</Message></Response>`;
      }

      reply = `What date was this payment? (e.g., 2025-12-12 or "today")`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    // Follow-up: ask for job
    if (pending?.awaitingRevenueJob && pending?.pendingRevenue) {
      const jobReply = normalizeJobAnswer(input);

      // Allow "Overhead"
      const finalJob = looksLikeOverhead(jobReply) ? 'Overhead' : jobReply;

      const merged = { ...pending.pendingRevenue, jobName: finalJob };

      await setPendingTransactionState(from, {
        ...pending,
        pendingRevenue: merged,
        awaitingRevenueJob: false
      });

      // payer optional; show it only if present and not Unknown
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
      const stableMsgId = String(pending.revenueSourceMsgId || msgId).trim();

      // If user sends a fresh revenue command while waiting for yes/edit/cancel,
      // treat as new command: clear pending and fall through into parse.
      if (/^(revenue|rev|received)\b/.test(lcInput)) {
        await deletePendingTransactionState(from);
        pending = null;
      } else {
        if (lcInput === 'yes') {
          const data0 = pending.pendingRevenue || {};

          // contractor-first coercion (if source looks like job)
          const data = await coerceSourceToJobIfLikely({ ownerId, data: data0 });

          // enforce job required
          const resolvedActive = await resolveActiveJobName({ ownerId, userProfile });
          let jobName =
            (data.jobName && String(data.jobName).trim()) ||
            (resolvedActive && String(resolvedActive).trim()) ||
            null;

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

          const category =
            data.suggestedCategory || (await categorizeEntry('revenue', data, ownerProfile));

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
            source: data.source, // optional
            jobName,
            category,
            user: userProfile?.name || 'Unknown User',
            sourceMsgId: stableMsgId,
            from,
            messageSid: stableMsgId
          });

          const payerPart =
            data.source && data.source !== 'Unknown' ? ` from ${data.source}` : '';

          reply =
            result.inserted === false
              ? '✅ Already logged that payment (duplicate message).'
              : `✅ Payment logged: ${data.amount}${payerPart} on ${jobName} (Category: ${category})`;

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
    }

    // --- AI PARSE PATH ---
    const { data: rawData, reply: aiReply, confirmed } = await handleInputWithAI(
      from,
      input,
      'revenue',
      parseRevenueMessage,
      defaultData
    );

    if (aiReply) {
      await setPendingTransactionState(from, {
        pendingRevenue: null,
        awaitingRevenueClarification: true,
        revenueClarificationPrompt: aiReply,
        revenueDraftText: input,
        revenueSourceMsgId: msgId,
        type: 'revenue'
      });
      return `<Response><Message>${aiReply}</Message></Response>`;
    }

    // contractor-first coercion (if source looks like job)
    const data = await coerceSourceToJobIfLikely({ ownerId, data: rawData });

    // Make payer/client optional: do NOT require data.source to exist
    if (data && data.amount && data.amount !== '$0.00') {
      // If date missing, default it
      if (!data.date) data.date = todayInTimeZone(tz);

      // detectErrors may complain about client/source — ignore those for revenue
      let errors = await detectErrors(data, 'revenue');
      if (errors) {
        const s = String(errors);
        // strip common "client/source missing" warnings from blocking the flow
        if (/client:\s*missing|source:\s*missing/i.test(s)) errors = null;
      }

      const category = await categorizeEntry('revenue', data, ownerProfile);
      data.suggestedCategory = category;

      // Resolve job: explicit jobName on data, else active job
      const resolvedActive = await resolveActiveJobName({ ownerId, userProfile });
      let jobName =
        (data.jobName && String(data.jobName).trim()) ||
        (resolvedActive && String(resolvedActive).trim()) ||
        null;

      if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

      // If clean + confirmed => enforce job, then write
      if (confirmed && !errors) {
        if (!jobName) {
          await setPendingTransactionState(from, {
            pendingRevenue: data,
            awaitingRevenueJob: true,
            revenueSourceMsgId: msgId,
            type: 'revenue'
          });
          reply = `Which job is this payment for? Reply with the job name (or "Overhead").`;
          return `<Response><Message>${reply}</Message></Response>`;
        }

        const gate = assertRevenueCILOrClarify({
          ownerId,
          from,
          userProfile,
          data,
          jobName,
          category,
          sourceMsgId: msgId
        });
        if (!gate.ok) return `<Response><Message>${gate.reply}</Message></Response>`;

        const result = await saveRevenue({
          ownerId,
          date: data.date,
          description: data.description,
          amount: data.amount,
          source: data.source, // optional
          jobName,
          category,
          user: userProfile?.name || 'Unknown User',
          sourceMsgId: msgId,
          from,
          messageSid: msgId
        });

        const payerPart =
          data.source && data.source !== 'Unknown' ? ` from ${data.source}` : '';

        reply =
          result.inserted === false
            ? '✅ Already logged that payment (duplicate message).'
            : `✅ Payment logged: ${data.amount}${payerPart} on ${jobName} (Category: ${category})`;

        return `<Response><Message>${reply}</Message></Response>`;
      }

      // Otherwise: enforce job before confirm prompt (contractor UX)
      if (!jobName) {
        await setPendingTransactionState(from, {
          pendingRevenue: data,
          awaitingRevenueJob: true,
          revenueSourceMsgId: msgId,
          type: 'revenue'
        });
        reply = `Which job is this payment for? Reply with the job name (or "Overhead").`;
        return `<Response><Message>${reply}</Message></Response>`;
      }

      await setPendingTransactionState(from, {
        pendingRevenue: { ...data, jobName },
        revenueSourceMsgId: msgId,
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
    } catch {
      // never hard-fail
    }
  }
}

module.exports = { handleRevenue };
