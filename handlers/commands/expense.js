// handlers/commands/expense.js
const { query, insertTransaction, listOpenJobs, normalizeVendorName } = require('../../services/postgres');

const state = require('../../utils/stateManager');
const getPendingTransactionState = state.getPendingTransactionState;
const deletePendingTransactionState = state.deletePendingTransactionState;

const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

const ai = require('../../utils/aiErrorHandler');
const handleInputWithAI = ai.handleInputWithAI;
const parseExpenseMessage = ai.parseExpenseMessage;

const todayInTimeZone =
  (typeof ai.todayInTimeZone === 'function' && ai.todayInTimeZone) ||
  (() => new Date().toISOString().split('T')[0]);

const parseNaturalDateTz =
  (typeof ai.parseNaturalDate === 'function' && ai.parseNaturalDate) ||
  ((s, tz) => {
    const t = String(s || '').trim().toLowerCase();
    const today = new Date().toISOString().split('T')[0];
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
  });

const categorizeEntry =
  (typeof ai.categorizeEntry === 'function' && ai.categorizeEntry) ||
  (async () => null);

// ---- CIL validator (fail-open) ----
const cilMod = require('../../cil');
const validateCIL =
  (cilMod && typeof cilMod.validateCIL === 'function' && cilMod.validateCIL) ||
  (cilMod && typeof cilMod.validateCil === 'function' && cilMod.validateCil) ||
  (cilMod && typeof cilMod.validate === 'function' && cilMod.validate) ||
  (typeof cilMod === 'function' && cilMod) ||
  null;

/* ---------------- Twilio Content Template ---------------- */

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

function getExpenseConfirmTemplateSid() {
  return (
    process.env.TWILIO_EXPENSE_CONFIRM_TEMPLATE_SID ||
    process.env.EXPENSE_CONFIRM_TEMPLATE_SID ||
    process.env.TWILIO_TEMPLATE_EXPENSE_CONFIRM_SID ||
    null
  );
}

function waTo(from) {
  const d = String(from || '').replace(/\D/g, '');
  return d ? `whatsapp:+${d}` : null;
}

async function sendWhatsAppTemplate({ to, templateSid, summaryLine }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || null;
  const waFrom = process.env.TWILIO_WHATSAPP_FROM || null;

  if (!accountSid || !authToken) throw new Error('Missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN');
  if (!to) throw new Error('Missing "to"');
  if (!templateSid) throw new Error('Missing templateSid');

  const toClean = String(to).startsWith('whatsapp:')
    ? String(to)
    : `whatsapp:${String(to).replace(/^whatsapp:/, '')}`;

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

async function sendConfirmExpenseOrFallback(from, summaryLine) {
  const sid = getExpenseConfirmTemplateSid();
  const to = waTo(from);

  console.info('[EXPENSE] confirm template attempt', { from, to, hasSid: !!sid, sid: sid || null });

  if (sid && to) {
    try {
      await sendWhatsAppTemplate({ to, templateSid: sid, summaryLine });
      console.info('[EXPENSE] confirm template sent OK', { to, sid });
      return twimlEmpty();
    } catch (e) {
      console.warn('[EXPENSE] template send failed; falling back to TwiML:', e?.message);
    }
  }

  return twimlText(`Please confirm this Expense:\n${summaryLine}\n\nReply yes/edit/cancel.`);
}

/* ---------------- helpers ---------------- */

const MAX_MEDIA_TRANSCRIPT_CHARS = 8000;
function truncateText(str, maxChars) {
  if (!str) return null;
  const s = String(str);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
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

function stripExpensePrefixes(input) {
  let s = String(input || '').trim();
  s = s.replace(/^(edit\s+)?expense\s*:\s*/i, '');
  s = s.replace(/^edit\s*:\s*/i, '');
  return s.trim();
}

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

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(str || '')
  );
}

function looksLikeOverhead(s) {
  const t = String(s || '').trim().toLowerCase();
  return t === 'overhead' || t === 'oh';
}

function normalizeJobAnswer(text) {
  let s = String(text || '').trim();
  s = s.replace(/^(job\s*name|job)\s*[:\-]?\s*/i, '');
  s = s.replace(/^(create|new)\s+job\s+/i, '');
  s = s.replace(/[?]+$/g, '').trim();
  return s;
}

/**
 * ✅ Fix "for for" (and related duplication):
 * - If item starts with "for ", strip it.
 * - Collapse whitespace.
 */
function cleanExpenseItemForDisplay(item) {
  let s = String(item || '').trim();
  s = s.replace(/^for\s+/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s || 'Unknown';
}

/**
 * ✅ One canonical line builder for templates + final replies.
 * Avoids double "for", "on", etc. if item already contains fragments.
 */
function buildExpenseSummaryLine({ amount, item, store, date, jobName }) {
  const amt = String(amount || '').trim();
  const it = cleanExpenseItemForDisplay(item);
  const st = String(store || '').trim() || 'Unknown Store';
  const dt = String(date || '').trim();
  const jb = jobName ? String(jobName).trim() : '';

  const itLower = it.toLowerCase();
  const parts = [];
  parts.push(`Expense: ${amt} for ${it}`);

  if (st && st !== 'Unknown Store' && !itLower.includes(`from ${st.toLowerCase()}`)) parts.push(`from ${st}`);
  if (dt && !itLower.includes(dt.toLowerCase())) parts.push(`on ${dt}`);
  if (jb && !itLower.includes(jb.toLowerCase())) parts.push(`for ${jb}`);

  return parts.join(' ') + '.';
}

async function resolveActiveJobName({ ownerId, userProfile }) {
  const ownerParam = String(ownerId || '').trim();
  const name = userProfile?.active_job_name || userProfile?.activeJobName || null;
  if (name && String(name).trim()) return String(name).trim();

  const ref = userProfile?.active_job_id ?? userProfile?.activeJobId ?? null;
  if (ref == null) return null;

  const s = String(ref).trim();

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
      console.warn('[expense] resolveActiveJobName uuid failed:', e?.message);
    }
  }

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
      console.warn('[expense] resolveActiveJobName job_no failed:', e?.message);
    }
  }

  return null;
}

function inferExpenseCategoryHeuristic(data) {
  const memo = `${data?.item || ''} ${data?.store || ''}`.toLowerCase();

  if (
    /\b(lumber|plywood|2x4|2x6|drywall|shingle|nails|screws|concrete|rebar|insulation|caulk|adhesive|materials?)\b/.test(
      memo
    )
  ) {
    return 'Materials';
  }
  if (/\b(gas|diesel|fuel|petro|esso|shell)\b/.test(memo)) return 'Fuel';
  if (/\b(tool|saw|drill|blade|bit|ladder|hammer)\b/.test(memo)) return 'Tools';
  if (/\b(subcontract|sub-contractor|subcontractor)\b/.test(memo)) return 'Subcontractors';
  if (/\b(office|paper|printer|ink|stationery)\b/.test(memo)) return 'Office Supplies';

  return null;
}

function formatMoneyDisplay(n) {
  try {
    const fmt = new Intl.NumberFormat('en-CA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return `$${fmt.format(n)}`;
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function normalizeExpenseData(data, userProfile) {
  const tz = userProfile?.timezone || userProfile?.tz || 'UTC';
  const d = { ...(data || {}) };

  if (d.amount != null) {
    const n = toNumberAmount(d.amount);
    if (Number.isFinite(n) && n > 0) d.amount = formatMoneyDisplay(n);
  }

  d.date = String(d.date || '').trim() || todayInTimeZone(tz);

  // ✅ normalize item to avoid "for for" downstream
  d.item = cleanExpenseItemForDisplay(d.item);

  d.store = String(d.store || '').trim() || 'Unknown Store';

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

/* --------- NL money/date helpers (aligned with mediaParser) --------- */

function extractMoneyToken(input) {
  const s = String(input || '');

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
  const raw = String(token || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;
  const normalized = cleaned.replace(/,/g, '');
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  return formatMoneyDisplay(n);
}

function isIsoDateToken(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

/**
 * Deterministic NL expense parse (voice transcript backstop)
 * Canonical: "$X for ITEM from VENDOR on DATE for JOB"
 */
function deterministicExpenseParse(input, userProfile) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const token = extractMoneyToken(raw);
  if (!token) return null;

  const amount = moneyToFixed(token);
  if (!amount) return null;

  const tz = userProfile?.timezone || userProfile?.tz || 'UTC';

  // date
  let date = null;
  if (/\btoday\b/i.test(raw)) date = parseNaturalDateTz('today', tz);
  else if (/\byesterday\b/i.test(raw)) date = parseNaturalDateTz('yesterday', tz);
  else if (/\btomorrow\b/i.test(raw)) date = parseNaturalDateTz('tomorrow', tz);

  if (!date) {
    const iso = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (iso?.[1]) date = iso[1];
  }
  if (!date) {
    const mNat = raw.match(/\bon\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/i);
    if (mNat?.[1]) date = parseNaturalDateTz(mNat[1], tz);
  }
  if (!date) date = todayInTimeZone(tz);

  // job: prefer trailing "for <job>"
  let jobName = null;
  const forJob = raw.match(/\bfor\s+(?:job\s+)?(.+?)(?:[.?!]|$)/i);
  if (forJob?.[1]) {
    const cand = String(forJob[1]).trim();
    if (cand && !isIsoDateToken(cand)) jobName = cand;
  }
  if (jobName && looksLikeOverhead(jobName)) jobName = 'Overhead';

  // store: "from|at <vendor>" stopping before on/for/date/end
  let store = null;
  const fromMatch = raw.match(
    /\b(?:from|at)\s+(.+?)(?:\s+\bon\b|\s+\bfor\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
  );
  if (fromMatch?.[1]) store = String(fromMatch[1]).trim();

  // item: prefer "for <item> from|at"
  let item = null;
  const itemMatch = raw.match(
    /\bfor\s+(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i
  );
  if (itemMatch?.[1]) {
    const cand = String(itemMatch[1]).trim();
    if (cand && !isIsoDateToken(cand)) item = cand;
  }

  if (!item) {
    const worthOf = raw.match(/\bworth\s+of\s+(.+?)(?:\s+\b(from|at)\b|\s+\bon\b|\s+\bfor\b|[.?!]|$)/i);
    if (worthOf?.[1]) item = String(worthOf[1]).trim();
  }

  return {
    date,
    amount,
    item: cleanExpenseItemForDisplay(item || 'Unknown'),
    store: store || 'Unknown Store',
    jobName: jobName || null
  };
}

/* ---------------- CIL builders ---------------- */

function buildExpenseCIL_LogExpense({ from, data, jobName, category, sourceMsgId }) {
  const cents = toCents(data.amount);
  return {
    type: 'LogExpense',
    job: jobName ? String(jobName) : undefined,
    item: String(data.item || '').trim() || undefined,
    amount_cents: cents,
    store: data.store && data.store !== 'Unknown Store' ? String(data.store) : undefined,
    date: data.date ? String(data.date) : undefined,
    category: category ? String(category) : undefined,
    source_msg_id: sourceMsgId ? String(sourceMsgId) : undefined,
    actor_phone: from ? String(from) : undefined
  };
}

function buildExpenseCIL_Legacy({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  const cents = toCents(data.amount);
  return {
    cil_version: '1.0',
    type: 'expense',
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

    total_cents: cents,
    currency: 'CAD',

    vendor: data.store && data.store !== 'Unknown Store' ? String(data.store) : undefined,
    memo: data.item && data.item !== 'Unknown' ? String(data.item) : undefined,
    category: category ? String(category) : undefined
  };
}

function assertExpenseCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  try {
    if (typeof validateCIL !== 'function') {
      console.warn('[EXPENSE] validateCIL missing; skipping CIL validation (fail-open).');
      return { ok: true, cil: null, skipped: true };
    }

    const cil1 = buildExpenseCIL_LogExpense({ from, data, jobName, category, sourceMsgId });
    try {
      validateCIL(cil1);
      return { ok: true, cil: cil1, variant: 'LogExpense' };
    } catch {
      const cil2 = buildExpenseCIL_Legacy({ ownerId, from, userProfile, data, jobName, category, sourceMsgId });
      validateCIL(cil2);
      return { ok: true, cil: cil2, variant: 'Legacy' };
    }
  } catch (e) {
    console.warn('[EXPENSE] CIL validate failed', {
      message: e?.message,
      name: e?.name,
      details: e?.errors || e?.issues || null
    });
    return { ok: false, reply: `⚠️ Couldn't log that expense yet. Try: "expense 84.12 nails from Home Depot".` };
  }
}

async function withTimeout(promise, ms, fallbackValue = '__TIMEOUT__') {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))]);
}

async function buildJobPrompt(ownerId) {
  const jobs = await listOpenJobs(ownerId, { limit: 8 });
  if (jobs.length) {
    const shown = jobs.map((j) => `"${j}"`).join(', ');
    return `Which job is this expense for? You currently have these jobs on-the-go: ${shown}\nReply with one of them, or "Overhead".`;
  }
  return `Which job is this expense for?\nStart your first job by replying with the job name for this entry (or "Overhead").`;
}

/* ---------------- main handler ---------------- */

async function handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  input = stripExpensePrefixes(input);

  const lockKey = `lock:${from}`;

  const msgId = String(sourceMsgId || '').trim() || `${from}:${Date.now()}`;
  const safeMsgId = String(sourceMsgId || msgId || '').trim();

  let reply;

  try {
    const tz = userProfile?.timezone || userProfile?.tz || 'UTC';
    const defaultData = {
      date: todayInTimeZone(tz),
      item: 'Unknown',
      amount: '$0.00',
      store: 'Unknown Store'
    };

    let pending = await getPendingTransactionState(from);

    // If user previously hit "edit", treat next message as brand new
    if (pending?.isEditing && pending?.type === 'expense') {
      await deletePendingTransactionState(from);
      pending = null;
    }

    // Follow-up: job resolution
    if (pending?.awaitingExpenseJob && pending?.pendingExpense) {
      const jobReply = normalizeJobAnswer(input);
      const finalJob = looksLikeOverhead(jobReply) ? 'Overhead' : jobReply || null;

      const merged = normalizeExpenseData({ ...pending.pendingExpense, jobName: finalJob }, userProfile);
      merged.store = await normalizeVendorName(ownerId, merged.store);

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: merged,
        awaitingExpenseJob: false
      });

      const summaryLine = buildExpenseSummaryLine({
        amount: merged.amount,
        item: merged.item,
        store: merged.store,
        date: merged.date,
        jobName: merged.jobName
      });
      return await sendConfirmExpenseOrFallback(from, summaryLine);
    }

    // --- CONFIRM FLOW ---
    if (pending?.pendingExpense || pending?.pendingDelete?.type === 'expense') {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = '⚠️ Only the owner can manage expenses.';
        return twimlText(reply);
      }

      const token = normalizeDecisionToken(input);
      const stableMsgId = String(pending?.expenseSourceMsgId || safeMsgId).trim();

      if (token === 'yes' && pending?.pendingExpense) {
        const rawData = pending.pendingExpense || {};
        const mediaMeta = pending?.pendingMediaMeta || null;

        let data = normalizeExpenseData(rawData, userProfile);

        // ✅ vendor normalization (snap to known vendors)
        data.store = await normalizeVendorName(ownerId, data.store);

        const category =
          data.suggestedCategory ||
          (await Promise.resolve(categorizeEntry('expense', data, ownerProfile)).catch(() => null)) ||
          inferExpenseCategoryHeuristic(data) ||
          null;

        const jobName =
          (data.jobName && String(data.jobName).trim()) ||
          (await resolveActiveJobName({ ownerId, userProfile })) ||
          null;

        if (!jobName) {
          await mergePendingTransactionState(from, {
            ...(pending || {}),
            pendingExpense: { ...data, suggestedCategory: category },
            awaitingExpenseJob: true,
            expenseSourceMsgId: stableMsgId,
            type: 'expense'
          });
          reply = await buildJobPrompt(ownerId);
          return twimlText(reply);
        }

        const gate = assertExpenseCILOrClarify({
          ownerId,
          from,
          userProfile,
          data,
          jobName,
          category,
          sourceMsgId: stableMsgId
        });
        if (!gate.ok) return twimlText(String(gate.reply || '').slice(0, 1500));

        const amountCents = toCents(data.amount);
        if (!amountCents || amountCents <= 0) throw new Error('Invalid amount');

        const writeResult = await withTimeout(
          insertTransaction({
            ownerId,
            kind: 'expense',
            date: data.date || todayInTimeZone(tz),
            description: String(data.item || '').trim() || 'Unknown',
            amount_cents: amountCents,
            amount: toNumberAmount(data.amount),
            source: String(data.store || '').trim() || 'Unknown',
            job: jobName,
            job_name: jobName,
            category: category ? String(category).trim() : null,
            user_name: userProfile?.name || 'Unknown User',
            source_msg_id: stableMsgId,
            mediaMeta: mediaMeta
              ? {
                  url: mediaMeta.url || null,
                  type: mediaMeta.type || null,
                  transcript: truncateText(mediaMeta.transcript, MAX_MEDIA_TRANSCRIPT_CHARS),
                  confidence: mediaMeta.confidence ?? null
                }
              : null
          }),
          5000,
          '__DB_TIMEOUT__'
        );

        if (writeResult === '__DB_TIMEOUT__') {
          await mergePendingTransactionState(from, {
            ...(pending || {}),
            pendingExpense: { ...data, jobName, suggestedCategory: category },
            expenseSourceMsgId: stableMsgId,
            type: 'expense'
          });

          reply = `⚠️ Saving is taking longer than expected (database slow). Please tap Yes again in a few seconds.`;
          return twimlText(reply);
        }

        const summaryLine = buildExpenseSummaryLine({
          amount: data.amount,
          item: data.item,
          store: data.store,
          date: data.date || todayInTimeZone(tz),
          jobName
        });

        reply =
          writeResult?.inserted === false
            ? '✅ Already logged that expense (duplicate message).'
            : `✅ Expense logged: ${summaryLine}${category ? ` (Category: ${category})` : ''}`;

        await deletePendingTransactionState(from);
        return twimlText(reply);
      }

      if (token === 'edit') {
        await deletePendingTransactionState(from);
        reply = '✏️ Okay — resend the expense in one line (e.g., "expense $84.12 nails from Home Depot today for <job>").';
        return twimlText(reply);
      }

      if (token === 'cancel') {
        await deletePendingTransactionState(from);
        reply = '❌ Operation cancelled.';
        return twimlText(reply);
      }

      reply = `⚠️ Please choose Yes, Edit, or Cancel.`;
      return twimlText(reply);
    }

    // DIRECT PARSE PATH (simple formats)
    const m = String(input || '').match(
      /^(?:expense\s+|exp\s+)?\$?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i
    );
    if (m) {
      const [, amountRaw, item, store] = m;

      const n = Number(String(amountRaw).replace(/,/g, ''));
      const amount = Number.isFinite(n) && n > 0 ? formatMoneyDisplay(n) : '$0.00';

      const data0 = normalizeExpenseData(
        {
          date: todayInTimeZone(tz),
          item,
          amount,
          store: store || 'Unknown Store'
        },
        userProfile
      );

      data0.store = await normalizeVendorName(ownerId, data0.store);

      const category =
        (await Promise.resolve(categorizeEntry('expense', data0, ownerProfile)).catch(() => null)) ||
        inferExpenseCategoryHeuristic(data0) ||
        null;

      const jobName = data0.jobName || (await resolveActiveJobName({ ownerId, userProfile })) || null;

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: { ...data0, jobName, suggestedCategory: category },
        expenseSourceMsgId: safeMsgId,
        type: 'expense',
        awaitingExpenseJob: !jobName
      });

      if (!jobName) {
        reply = await buildJobPrompt(ownerId);
        return twimlText(reply);
      }

      const summaryLine = buildExpenseSummaryLine({
        amount: data0.amount,
        item: data0.item,
        store: data0.store,
        date: data0.date,
        jobName
      });
      return await sendConfirmExpenseOrFallback(from, summaryLine);
    }

    // NL BACKSTOP (voice transcript)
    const backstop = deterministicExpenseParse(input, userProfile);
    if (backstop && backstop.amount) {
      const data0 = normalizeExpenseData(backstop, userProfile);

      data0.store = await normalizeVendorName(ownerId, data0.store);

      const category =
        (await Promise.resolve(categorizeEntry('expense', data0, ownerProfile)).catch(() => null)) ||
        inferExpenseCategoryHeuristic(data0) ||
        null;

      const jobName = data0.jobName || (await resolveActiveJobName({ ownerId, userProfile })) || null;

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: { ...data0, jobName, suggestedCategory: category },
        expenseSourceMsgId: safeMsgId,
        type: 'expense',
        awaitingExpenseJob: !jobName
      });

      if (!jobName) {
        reply = await buildJobPrompt(ownerId);
        return twimlText(reply);
      }

      const summaryLine = buildExpenseSummaryLine({
        amount: data0.amount,
        item: data0.item,
        store: data0.store,
        date: data0.date,
        jobName
      });
      return await sendConfirmExpenseOrFallback(from, summaryLine);
    }

    // AI PATH (fallback)
    const aiRes = await handleInputWithAI(from, input, 'expense', parseExpenseMessage, defaultData);
    let data = aiRes?.data || null;
    let aiReply = aiRes?.reply || null;

    if (aiReply && /\bcategory\b/i.test(aiReply)) aiReply = null;
    if (data) data = normalizeExpenseData(data, userProfile);

    const missingCore =
      !data ||
      !data.amount ||
      data.amount === '$0.00' ||
      !data.item ||
      data.item === 'Unknown' ||
      !data.store ||
      data.store === 'Unknown Store';

    if (aiReply && missingCore) {
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: null,
        isEditing: true,
        type: 'expense'
      });
      return twimlText(aiReply);
    }

    if (data && data.amount && data.amount !== '$0.00') {
      data.store = await normalizeVendorName(ownerId, data.store);

      const category =
        (await Promise.resolve(categorizeEntry('expense', data, ownerProfile)).catch(() => null)) ||
        inferExpenseCategoryHeuristic(data) ||
        null;

      const jobName = data.jobName || (await resolveActiveJobName({ ownerId, userProfile })) || null;

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: { ...data, jobName, suggestedCategory: category },
        expenseSourceMsgId: safeMsgId,
        type: 'expense',
        awaitingExpenseJob: !jobName
      });

      if (!jobName) {
        reply = await buildJobPrompt(ownerId);
        return twimlText(reply);
      }

      const summaryLine = buildExpenseSummaryLine({
        amount: data.amount,
        item: data.item,
        store: data.store,
        date: data.date || todayInTimeZone(tz),
        jobName
      });
      return await sendConfirmExpenseOrFallback(from, summaryLine);
    }

    reply = `🤔 Couldn’t parse an expense from "${input}". Try "expense 84.12 nails from Home Depot".`;
    return twimlText(reply);
  } catch (error) {
    console.error(`[ERROR] handleExpense failed for ${from}:`, error?.message, {
      code: error?.code,
      detail: error?.detail,
      constraint: error?.constraint
    });
    reply = '⚠️ Error logging expense. Please try again.';
    return twimlText(reply);
  } finally {
    try {
      await require('../../middleware/lock').releaseLock(lockKey);
    } catch {}
  }
}

module.exports = { handleExpense };
