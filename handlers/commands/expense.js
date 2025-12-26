// handlers/commands/expense.js
const { query, insertTransaction } = require('../../services/postgres');

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
const parseExpenseMessage = ai.parseExpenseMessage;

// Prefer tz-aware helpers from aiErrorHandler if available
const todayInTimeZone =
  (typeof ai.todayInTimeZone === 'function' && ai.todayInTimeZone) ||
  (() => new Date().toISOString().split('T')[0]);

const parseNaturalDateTz =
  (typeof ai.parseNaturalDate === 'function' && ai.parseNaturalDate) ||
  ((s) => {
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

const detectErrors =
  (typeof ai.detectErrors === 'function' && ai.detectErrors) ||
  (typeof ai.detectError === 'function' && ai.detectError) ||
  (async () => null); // fail-open

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
    contentVariables: JSON.stringify({ "1": String(summaryLine || '').slice(0, 900) })
  };

  if (waFrom) payload.from = waFrom;
  else if (messagingServiceSid) payload.messagingServiceSid = messagingServiceSid;
  else throw new Error('Missing TWILIO_WHATSAPP_FROM or TWILIO_MESSAGING_SERVICE_SID');

  const twilio = require('twilio');
  const client = twilio(accountSid, authToken);

  const TIMEOUT_MS = 2500;
  const msg = await Promise.race([
    client.messages.create(payload),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Twilio send timeout')), TIMEOUT_MS)),
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

  console.info('[EXPENSE] confirm template attempt', {
    from,
    to,
    hasSid: !!sid,
    sid: sid || null
  });

  if (sid && to) {
    try {
      await sendWhatsAppTemplate({ to, templateSid: sid, summaryLine });
      console.info('[EXPENSE] confirm template sent OK', { to, sid });
      return twimlEmpty(); // IMPORTANT: don't also send TwiML message
    } catch (e) {
      console.warn('[EXPENSE] template send failed; falling back to TwiML:', e?.message);
    }
  }

  return twimlText(`Please confirm this Expense:\n${summaryLine}\n\nReply yes/edit/cancel.`);
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

// ---- Media limits (Option A truncation) ----
const MAX_MEDIA_TRANSCRIPT_CHARS = 8000;
function truncateText(str, maxChars) {
  if (!str) return null;
  const s = String(str);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

// ---- basic parsing helpers ----
function toCents(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str || ''));
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

function safeDateForUser(userProfile) {
  const tz = userProfile?.timezone || userProfile?.tz || 'UTC';
  return todayInTimeZone(tz);
}

/**
 * Resolve active job name safely (avoid int=uuid comparisons).
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
      console.warn('[expense] resolveActiveJobName uuid failed:', e?.message);
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
      console.warn('[expense] resolveActiveJobName job_no failed:', e?.message);
    }
  }

  return null;
}

/**
 * Deterministic NL expense parse (backstop)
 * Handles: "I bought $489.78 worth of Lumber from Home Depot today for 1556 Medway Park Dr"
 */
function deterministicExpenseParse(input, userProfile) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // amount: allow commas
  const money =
    raw.match(/\$\s*([0-9]{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/) ||
    raw.match(/\b([0-9]{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:dollars|bucks)\b/i);

  if (!money?.[1]) return null;

  const amtNum = Number(String(money[1]).replace(/,/g, ''));
  if (!Number.isFinite(amtNum) || amtNum <= 0) return null;

  const amount = `$${amtNum.toFixed(2)}`;

  // date (tz-aware)
  const tz = userProfile?.timezone || userProfile?.tz || 'UTC';
  let date = null;
  if (/\btoday\b/i.test(raw)) date = parseNaturalDateTz('today', tz);
  else if (/\byesterday\b/i.test(raw)) date = parseNaturalDateTz('yesterday', tz);
  else if (/\btomorrow\b/i.test(raw)) date = parseNaturalDateTz('tomorrow', tz);
  else {
    const iso = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (iso) date = iso[1];
  }
  if (!date) date = todayInTimeZone(tz);

  // vendor/store: prefer "from X" or "at X"
  let store = null;
  const fromMatch = raw.match(/\b(?:from|at)\s+(.+?)(?:\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|\s+\bfor\b|$)/i);
  if (fromMatch?.[1]) store = String(fromMatch[1]).trim();

  // item: "worth of X" or "bought ... X"
  let item = null;
  const worthOf = raw.match(/\bworth\s+of\s+(.+?)(?:\s+\bfrom\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|\s+\bfor\b|$)/i);
  if (worthOf?.[1]) item = String(worthOf[1]).trim();

  // jobName: "for <job>" at end
  let jobName = null;
  const forMatch = raw.match(/\bfor\s+(.+?)(?:\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|$)/i);
  if (forMatch?.[1]) jobName = String(forMatch[1]).trim();

  return {
    date,
    amount,
    item: item || 'Unknown',
    store: store || 'Unknown Store',
    jobName: jobName || null
  };
}

function normalizeExpenseData(data, userProfile) {
  const tz = userProfile?.timezone || userProfile?.tz || 'UTC';
  const d = { ...(data || {}) };

  // normalize amount
  if (d.amount != null) {
    const amt = String(d.amount).trim();
    if (amt) {
      const n = Number(amt.replace(/[^0-9.,]/g, '').replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) d.amount = `$${n.toFixed(2)}`;
    }
  }

  d.date = String(d.date || '').trim() || todayInTimeZone(tz);
  d.item = String(d.item || '').trim() || 'Unknown';
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

function inferExpenseCategoryHeuristic(data) {
  const memo = `${data?.item || ''} ${data?.store || ''}`.toLowerCase();

  if (/\b(lumber|plywood|2x4|2x6|drywall|shingle|nails|screws|concrete|rebar|insulation|caulk|adhesive|materials?)\b/.test(memo)) {
    return 'Materials';
  }
  if (/\b(gas|diesel|fuel|petro|esso|shell)\b/.test(memo)) return 'Fuel';
  if (/\b(tool|saw|drill|blade|bit|ladder|hammer)\b/.test(memo)) return 'Tools';
  if (/\b(subcontract|sub-contractor|subcontractor)\b/.test(memo)) return 'Subcontractors';
  if (/\b(office|paper|printer|ink|stationery)\b/.test(memo)) return 'Office Supplies';

  return null;
}

/**
 * Build two possible CIL shapes:
 * 1) "LogExpense" style (common in your new flows)
 * 2) Legacy "expense" style (your current one)
 * Validate-first → fallback.
 */
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
    cil_version: "1.0",
    type: "expense",
    tenant_id: String(ownerId),
    source: "whatsapp",
    source_msg_id: String(sourceMsgId),

    actor: {
      actor_id: String(userProfile?.user_id || from || "unknown"),
      role: "owner",
      phone_e164: from && String(from).startsWith("+") ? String(from) : undefined,
    },

    occurred_at: new Date().toISOString(),
    job: jobName ? { job_name: String(jobName) } : null,
    needs_job_resolution: !jobName,

    total_cents: cents,
    currency: "CAD",

    vendor: data.store && data.store !== 'Unknown Store' ? String(data.store) : undefined,
    memo: data.item && data.item !== 'Unknown' ? String(data.item) : undefined,
    category: category ? String(category) : undefined,
  };
}

function assertExpenseCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  try {
    if (typeof validateCIL !== 'function') {
      console.warn('[EXPENSE] validateCIL missing; skipping CIL validation (fail-open).');
      return { ok: true, cil: null, skipped: true };
    }

    // Try LogExpense first
    const cil1 = buildExpenseCIL_LogExpense({ from, data, jobName, category, sourceMsgId });
    try {
      validateCIL(cil1);
      return { ok: true, cil: cil1, variant: 'LogExpense' };
    } catch (e1) {
      // Fall back to legacy
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
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms))
  ]);
}

/* ---------------- main handler ---------------- */

async function handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
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

    // Follow-up: expense clarification (DATE only)
    if (pending?.awaitingExpenseClarification) {
      const maybeDate = parseNaturalDateTz(input, tz);

      if (maybeDate) {
        const draft = pending.expenseDraftText || '';

        const parsed = parseExpenseMessage(draft) || {};
        const backstop = deterministicExpenseParse(draft, userProfile) || {};

        // Force defaults so confirm never prints undefined
        const merged = normalizeExpenseData(
          {
            ...backstop,
            ...parsed,
            date: maybeDate,
            item: parsed.item || backstop.item || 'Unknown',
            amount: parsed.amount || backstop.amount || '$0.00',
            store: parsed.store || backstop.store || 'Unknown Store',
            jobName: parsed.jobName ?? backstop.jobName ?? null
          },
          userProfile
        );

        await mergePendingTransactionState(from, {
          ...(pending || {}),
          pendingExpense: merged,
          awaitingExpenseClarification: false
        });

        const summaryLine = `Expense: ${merged.amount} for ${merged.item} from ${merged.store} on ${merged.date}.`;
        return await sendConfirmExpenseOrFallback(from, summaryLine);
      }

      reply = `What date was this expense? (e.g., 2025-12-12 or "today")`;
      return twimlText(reply);
    }

    // Follow-up: job resolution
    if (pending?.awaitingExpenseJob && pending?.pendingExpense) {
      const jobReply = normalizeJobAnswer(input);
      const finalJob = looksLikeOverhead(jobReply) ? 'Overhead' : (jobReply || null);

      const merged = normalizeExpenseData({ ...pending.pendingExpense, jobName: finalJob }, userProfile);

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: merged,
        awaitingExpenseJob: false
      });

      const summaryLine = `Expense: ${merged.amount} for ${merged.item} from ${merged.store} on ${merged.date}${merged.jobName ? ` for ${merged.jobName}` : ''}.`;
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

        const data = normalizeExpenseData(rawData, userProfile);

        // Prefer AI category, but always have a fallback suggestion
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
          reply = `Which job is this expense for? Reply with the job name (or "Overhead").`;
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
            amount: null,
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
          // Preserve pending so user can tap "yes" again
          await mergePendingTransactionState(from, {
            ...(pending || {}),
            pendingExpense: { ...data, jobName, suggestedCategory: category },
            expenseSourceMsgId: stableMsgId,
            type: 'expense'
          });

          reply = `⚠️ Saving is taking longer than expected (database slow). Please tap Yes again in a few seconds.`;
          return twimlText(reply);
        }

        reply =
          writeResult?.inserted === false
            ? '✅ Already logged that expense (duplicate message).'
            : `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} on ${jobName}${category ? ` (Category: ${category})` : ''}`;

        await deletePendingTransactionState(from);
        return twimlText(reply);
      }

      if (token === 'edit') {
        await mergePendingTransactionState(from, {
          ...(pending || {}),
          isEditing: true,
          type: 'expense',
          awaitingExpenseClarification: false,
          awaitingExpenseJob: false
        });
        reply = '✏️ Okay — resend the expense in one line (e.g., "expense 84.12 nails from Home Depot").';
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
    const m = String(input || '').match(/^(?:expense\s+|exp\s+)?\$?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
    if (m) {
      const [, amountRaw, item, store] = m;

      const n = Number(String(amountRaw).replace(/,/g, ''));
      const amount = Number.isFinite(n) ? `$${n.toFixed(2)}` : '$0.00';

      const data = normalizeExpenseData({
        date: todayInTimeZone(tz),
        item,
        amount,
        store: store || 'Unknown Store'
      }, userProfile);

      const category =
        (await Promise.resolve(categorizeEntry('expense', data, ownerProfile)).catch(() => null)) ||
        inferExpenseCategoryHeuristic(data) ||
        null;

      const jobName =
        data.jobName ||
        (await resolveActiveJobName({ ownerId, userProfile })) ||
        null;

      if (!jobName) {
        await mergePendingTransactionState(from, {
          ...(pending || {}),
          pendingExpense: { ...data, suggestedCategory: category },
          awaitingExpenseJob: true,
          expenseSourceMsgId: safeMsgId,
          type: 'expense'
        });
        reply = `Which job is this expense for? Reply with the job name (or "Overhead").`;
        return twimlText(reply);
      }

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: { ...data, jobName, suggestedCategory: category },
        expenseSourceMsgId: safeMsgId,
        type: 'expense'
      });

      const summaryLine = `Expense: ${data.amount} for ${data.item} from ${data.store} on ${data.date} for ${jobName}.`;
      return await sendConfirmExpenseOrFallback(from, summaryLine);
    }

    // NL BACKSTOP FIRST (so your exact sentence works even if AI parser is flaky)
    const backstop = deterministicExpenseParse(input, userProfile);
    if (backstop && backstop.amount) {
      const data = normalizeExpenseData(backstop, userProfile);

      const category =
        (await Promise.resolve(categorizeEntry('expense', data, ownerProfile)).catch(() => null)) ||
        inferExpenseCategoryHeuristic(data) ||
        null;

      const jobName =
        data.jobName ||
        (await resolveActiveJobName({ ownerId, userProfile })) ||
        null;

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: { ...data, jobName, suggestedCategory: category },
        expenseSourceMsgId: safeMsgId,
        type: 'expense',
        awaitingExpenseJob: !jobName
      });

      if (!jobName) {
        reply = `Which job is this expense for? Reply with the job name (or "Overhead").`;
        return twimlText(reply);
      }

      const summaryLine = `Expense: ${data.amount} for ${data.item} from ${data.store} on ${data.date} for ${jobName}.`;
      return await sendConfirmExpenseOrFallback(from, summaryLine);
    }

    // AI PATH (only ask follow-ups if we truly lack core fields)
    const aiRes = await handleInputWithAI(from, input, 'expense', parseExpenseMessage, defaultData);
    let data = aiRes?.data || null;
    let aiReply = aiRes?.reply || null;

    // If AI is asking for "category", ignore that — we infer category ourselves
    if (aiReply && /\bcategory\b/i.test(aiReply)) {
      aiReply = null;
    }

    if (data) data = normalizeExpenseData(data, userProfile);

    const missingCore =
      !data ||
      !data.amount ||
      data.amount === '$0.00' ||
      !data.item ||
      data.item === 'Unknown' ||
      !data.store ||
      data.store === 'Unknown Store';

    // If AI wants clarification AND core missing: store draft & ask
    if (aiReply && missingCore) {
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: null,
        awaitingExpenseClarification: true, // DATE follow-up only (your expense.js is date-only flow)
        expenseClarificationPrompt: aiReply,
        expenseDraftText: input,
        expenseSourceMsgId: safeMsgId,
        type: 'expense'
      });
      return twimlText(aiReply);
    }

    // If we have usable data: suggest category and go to confirm
    if (data && data.amount && data.amount !== '$0.00') {
      const category =
        (await Promise.resolve(categorizeEntry('expense', data, ownerProfile)).catch(() => null)) ||
        inferExpenseCategoryHeuristic(data) ||
        null;

      data.suggestedCategory = category;

      const jobName =
        data.jobName ||
        (await resolveActiveJobName({ ownerId, userProfile })) ||
        null;

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: { ...data, jobName },
        expenseSourceMsgId: safeMsgId,
        type: 'expense',
        awaitingExpenseJob: !jobName
      });

      if (!jobName) {
        reply = `Which job is this expense for? Reply with the job name (or "Overhead").`;
        return twimlText(reply);
      }

      const summaryLine = `Expense: ${data.amount} for ${data.item} from ${data.store} on ${data.date || todayInTimeZone(tz)} for ${jobName}.`;
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
