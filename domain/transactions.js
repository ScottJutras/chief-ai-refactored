// domain/transactions.js
const { query, insertTransaction } = require('../services/postgres');

function isoDateOrToday(d) {
  try {
    return d ? new Date(d).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function safeStr(x) {
  const s = String(x ?? '').trim();
  return s || null;
}

async function resolveJobName(owner_id, jobRef) {
  if (!owner_id || !jobRef) return null;
  const ref = String(jobRef).trim();
  if (!ref) return null;

  // UUID
  if (/^[0-9a-f-]{36}$/i.test(ref)) {
    const r = await query(
      `select coalesce(name, job_name) as name
         from public.jobs
        where owner_id=$1 and id=$2
        limit 1`,
      [owner_id, ref]
    );
    return r.rows?.[0]?.name || null;
  }

  // job_no "#123" or "123"
  const m = ref.match(/^#?(\d+)$/);
  if (m) {
    const r = await query(
      `select coalesce(name, job_name) as name
         from public.jobs
        where owner_id=$1 and job_no=$2
        limit 1`,
      [owner_id, parseInt(m[1], 10)]
    );
    return r.rows?.[0]?.name || null;
  }

  // name
  const r = await query(
    `select coalesce(name, job_name) as name
       from public.jobs
      where owner_id=$1
        and lower(coalesce(name, job_name)) = lower($2)
      limit 1`,
    [owner_id, ref]
  );
  return r.rows?.[0]?.name || null;
}

function buildMediaMeta(ctx, cil) {
  const fromCtx = ctx?.mediaMetaNormalized || ctx?.mediaMeta || ctx?.pendingMediaMeta || null;

  const fromCil = {
    url: cil?.media_url || cil?.mediaUrl || null,
    type: cil?.media_type || cil?.mediaType || null,
    transcript: cil?.media_transcript || cil?.mediaTranscript || null,
    confidence: cil?.media_confidence ?? cil?.mediaConfidence ?? null
  };

  return fromCtx || fromCil || null;
}

async function logExpense(cil, ctx) {
  const ownerId = safeStr(ctx?.owner_id);
  if (!ownerId) throw new Error('Missing ctx.owner_id');

  const jobRef = safeStr(cil?.job);
  const jobNameForSummary = jobRef ? await resolveJobName(ownerId, jobRef) : null;

  const item = safeStr(cil?.item) || 'Expense';
  const amountCents = Number(cil?.amount_cents ?? 0) || 0;
  if (!amountCents || amountCents <= 0) throw new Error('Invalid expense amount_cents');

  const store = safeStr(cil?.store);
  const category = safeStr(cil?.category);
  const date = isoDateOrToday(cil?.date);

  const sourceMsgId = safeStr(ctx?.source_msg_id);
  const userName = safeStr(ctx?.user_name || ctx?.actor_name || null);

  const mediaMeta = buildMediaMeta(ctx, cil);

  const result = await insertTransaction(
    {
      ownerId,
      kind: 'expense',
      date,
      description: item,
      amount_cents: amountCents,
      amount: cil?.amount != null ? Number(cil.amount) : undefined,
      source: store || 'Unknown',
      job: jobRef || null,
      job_id: cil?.job_id ?? null, // ✅ pass-through if caller has it
      job_no: cil?.job_no ?? null, // ✅ pass-through if caller has it
      job_name: jobNameForSummary || jobRef || null,
      category,
      user_name: userName,
      source_msg_id: sourceMsgId,
      mediaMeta
    },
    { timeoutMs: 4000 }
  );

  const dollars = (amountCents / 100).toFixed(2);

  return {
    ok: true,
    inserted: !!result?.inserted,
    summary: result?.inserted
      ? `✅ Expense logged: $${dollars} for ${item}${jobNameForSummary ? ` on ${jobNameForSummary}` : ''}.`
      : `✅ Already logged that expense (duplicate message).`
  };
}

async function logRevenue(cil, ctx) {
  const ownerId = safeStr(ctx?.owner_id);
  if (!ownerId) throw new Error('Missing ctx.owner_id');

  const jobRef = safeStr(cil?.job);
  const jobNameForSummary = jobRef ? await resolveJobName(ownerId, jobRef) : null;

  const description = safeStr(cil?.description) || 'Payment received';
  const amountCents = Number(cil?.amount_cents ?? 0) || 0;
  if (!amountCents || amountCents <= 0) throw new Error('Invalid revenue amount_cents');

  const source = safeStr(cil?.source) || 'Unknown';
  const category = safeStr(cil?.category);
  const date = isoDateOrToday(cil?.date);

  const sourceMsgId = safeStr(ctx?.source_msg_id);
  const userName = safeStr(ctx?.user_name || ctx?.actor_name || null);

  const mediaMeta = buildMediaMeta(ctx, cil);

  const result = await insertTransaction(
    {
      ownerId,
      kind: 'revenue',
      date,
      description,
      amount_cents: amountCents,
      amount: cil?.amount != null ? Number(cil.amount) : undefined,
      source,
      job: jobRef || null,
      job_id: cil?.job_id ?? null,
      job_no: cil?.job_no ?? null,
      job_name: jobNameForSummary || jobRef || null,
      category,
      user_name: userName,
      source_msg_id: sourceMsgId,
      mediaMeta
    },
    { timeoutMs: 4000 }
  );

  const dollars = (amountCents / 100).toFixed(2);

  return {
    ok: true,
    inserted: !!result?.inserted,
    summary: result?.inserted
      ? `✅ Revenue logged: $${dollars} – ${description}${jobNameForSummary ? ` on ${jobNameForSummary}` : ''}.`
      : `✅ Already logged that revenue (duplicate message).`
  };
}

module.exports = { logExpense, logRevenue };
