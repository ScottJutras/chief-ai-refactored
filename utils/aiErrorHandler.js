// utils/aiErrorHandler.js
const { callOpenAI } = require('../services/openAI');
const stateManager = require('./stateManager');
const { detectErrors: detectErrorsImpl } = require('./errorDetector');
const { todayInTimeZone, parseNaturalDate, stripDateTail } = require('./dateUtils');
const { normalizeJobNameCandidate } = require('./jobNameUtils');

/**
 * ChiefOS Ingestion AI helper
 * - WhatsApp is a “sense”: extract fields OR ask a clarification question.
 * - No analytics, no business-wide answers, no “CFO advice” in ingestion.
 * - Always return structured JSON.
 */

/**
 * Robust JSON parsing helper (handles model returning stringified JSON).
 */
function coerceJson(maybeJson) {
  if (!maybeJson) return null;
  if (typeof maybeJson === 'object') return maybeJson;

  if (typeof maybeJson === 'string') {
    const s = maybeJson.trim();

    // try raw parse
    try { return JSON.parse(s); } catch {}

    // try to extract first JSON object block
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch {}
    }
  }
  return null;
}

/**
 * Enforce the “Ingestion-only” system instruction.
 */
function ingestionSystemPrompt(type) {
  return `
You are the Ingestion Layer for ChiefOS. You record facts only.
You do NOT provide business-wide analytics, advice, KPIs, or answers to global questions.
Your ONLY job is to either:
(1) extract structured fields for a single ${type} record, OR
(2) ask a single clarifying question needed to extract those fields.

Output MUST be JSON only. No markdown. No extra text.
`;
}


/**
 * For parse failures: return a helpful example + one clarifying question.
 */
async function proposeClarification(input, type) {
  const prompt = `
${ingestionSystemPrompt(type)}

The user's message could not be parsed as a ${type} record:
"${input}"

Return JSON with this exact shape:
{
  "data": null,
  "reply": "string",
  "confirmed": false
}

The reply must:
- give ONE concrete example command the user can copy
- ask ONE clarifying question
- be short (1-3 sentences)
`;
  const raw = await callOpenAI(prompt, input, process.env.INGESTION_MODEL || 'gpt-4o', 200, 0.2);
  const parsed = coerceJson(raw);

  if (parsed && typeof parsed.reply === 'string') return parsed;

  // Safe fallback
  return {
    data: null,
    reply: `I couldn't log that ${type} yet. Example: "expense 84.12 nails from Home Depot". What was the amount?`,
    confirmed: false
  };
}

/**
 * If fields are missing/weird, ask for correction suggestions.
 * Returns an object of suggested field corrections or null.
 */
async function correctErrorsWithAI(errorContext, type) {
  const prompt = `
${ingestionSystemPrompt(type)}

Suggest corrections for this parsing/validation error context:
"${errorContext}"

Return JSON only:
{
  "corrections": { "fieldName": "suggestedValue", ... } | null
}

Rules:
- Only include fields relevant to a single ${type} record
- Never invent amounts; if missing, leave it out and ask in reply elsewhere
`;
  const raw = await callOpenAI(prompt, errorContext, process.env.INGESTION_MODEL || 'gpt-4o', 200, 0.2);
  const parsed = coerceJson(raw);

  if (parsed && parsed.corrections && typeof parsed.corrections === 'object') {
    return parsed.corrections;
  }
  return null;
}

function stripUndefined(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function buildPendingKey(type) {
  return (
    type === 'expense' ? 'pendingExpense' :
    type === 'revenue' ? 'pendingRevenue' :
    type === 'bill'    ? 'pendingBill' :
    type === 'quote'   ? 'pendingQuote' :
    'pendingData'
  );
}

/**
 * Main ingestion helper:
 * - Try deterministic parseFn first
 * - If parseFn fails => ask AI for clarification response
 * - If parseFn succeeds => run detectErrors; if errors => optionally AI suggests corrections + sets pending state
 * - Otherwise return confirmed:true with parsed data
 *
 * ctx is optional (ex: { tz }) and will be passed to parseFn.
 */
async function handleInputWithAI(from, input, type, parseFn, defaultData = {}, ctx = {}, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const disableCorrections = options.disableCorrections === true; // ✅ for edit-mode flows
  const disablePendingState = options.disablePendingState === true; // ✅ for edit-mode flows

  // normalize ctx to plain object
  ctx = ctx && typeof ctx === 'object' ? ctx : {};

  // ✅ accept both { tz } and { timezone } callers
  if (!ctx.tz && ctx.timezone) ctx.tz = ctx.timezone;

  let rawInput = String(input ?? '');

  // Optional: transcript normalization hook (voice → deterministic-friendly)
  // Safe: only applies if module exists and exposes a normalizer.
  try {
    const tn = require('./transcriptNormalize'); // utils/transcriptNormalize.js
    if (tn && typeof tn.normalizeTranscriptMoney === 'function') {
      rawInput = tn.normalizeTranscriptMoney(rawInput);
    }
  } catch {
    // ignore; module optional
  }

  console.log(`[DEBUG] Ingestion parse (${type}): "${rawInput}"`);

  // 1) Attempt deterministic parse first (SAFE RULE: always pass ctx)
  let data = null;
  try {
    if (typeof parseFn === 'function') {
      // IMPORTANT: Always pass ctx. Do NOT use parseFn.length gating (regresses tz-aware parsing).
      data = parseFn(rawInput, ctx);
    }
  } catch (e) {
    console.warn(`[WARN] parseFn threw for ${type}:`, e?.message);
    data = null;
  }

  // 2) If deterministic parse failed, ask for clarification (but still ingestion-only)
  if (!data) {
    return await proposeClarification(rawInput, type);
  }

  // 2b) Apply default fields if missing (non-destructive)
  if (defaultData && typeof defaultData === 'object') {
    data = { ...defaultData, ...stripUndefined(data) };
  } else {
    data = stripUndefined(data);
  }

  // 3) Detect structural errors (missing fields etc.)
  let errors = null;
  try {
    errors = await detectErrorsImpl(data, type, ctx);

    if (Array.isArray(errors)) {
      const hard = errors.filter((e) => String(e?.severity || 'hard') === 'hard');
      const soft = errors.filter((e) => String(e?.severity || '') === 'soft');

      // ✅ Log soft warnings (non-blocking visibility)
      if (!hard.length && soft.length) {
        console.info('[INGESTION_SOFT_WARNINGS]', { type, soft });
      }

      errors = hard.length ? hard : null;
    }

    // ✅ contractor-first: revenue payer/client is optional
    if (type === 'revenue' && errors) {
      const s = JSON.stringify(errors);
      if (/client|payer|source/i.test(s) && /missing/i.test(s)) {
        errors = null;
      }
    }
  } catch (e) {
    console.warn(`[WARN] detectErrors failed for ${type}:`, e?.message);
    errors = null;
  }

  // 4) If errors exist...
  if (errors) {
    // ✅ Edit-mode / confirm-mode: do NOT generate "issues" diffs or write pending state.
    if (disableCorrections || disablePendingState) {
      return {
        data: null,
        reply: `I couldn't apply that edit yet. Please resend with amount + store + date (if changing date).`,
        confirmed: false
      };
    }

    const corrections = await correctErrorsWithAI(
      `Type=${type} Errors=${JSON.stringify(errors)} Data=${JSON.stringify(data)} Ctx=${JSON.stringify(ctx || {})}`,
      type
    );

    if (corrections) {
      const pendingKey = buildPendingKey(type);

      await stateManager.setPendingTransactionState(from, {
        [pendingKey]: data,
        pendingCorrection: true,
        suggestedCorrections: corrections,
        type
      });

      const text = Object.entries(corrections)
        .map(([k, v]) => `${k}: ${data?.[k] ?? 'missing'} → ${v}`)
        .join('\n');

      return {
        data: null,
        reply: `🤔 I found a few issues:\n${text}\nReply "yes" to accept, "edit" to resend, or "cancel" to abort.`,
        confirmed: false
      };
    }

    return {
      data: null,
      reply: `⚠️ I couldn't log that ${type} yet. Please resend with the missing details.`,
      confirmed: false
    };
  }

  // 5) Looks good. Caller must STILL CIL-validate before any DB writes.
  return { data, reply: null, confirmed: true };
}


/**
 * Categorization helper. Keep as-is but this is still “ingestion-side enrichment”.
 */
async function categorizeEntry(type, data, userProfile, categories) {
  return require('../services/openAI').categorizeEntry(type, data, userProfile, categories);
}

/* ---------------- Deterministic parsers ---------------- */

function toMoneyNumber(val) {
  if (val == null) return null;
  const n = Number(String(val).replace(/[^0-9.,]/g, '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return n;
}

function formatMoney(n) {
  const v = toMoneyNumber(n);
  if (!Number.isFinite(v)) return null;
  return `$${v.toFixed(2)}`;
}

function looksLikeAddress(str) {
  const t = String(str || '').trim();
  if (!t) return false;
  if (!/\d/.test(t)) return false;
  return /\b(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|cir|circle|way|trail|trl|pkwy|park)\b/i.test(t);
}

/**
 * Extract a likely $ amount from free text:
 * - prefers explicit $ amounts
 * - supports commas ($8,436.10)
 * - avoids grabbing address numbers
 * - supports common transcript pattern: "for 10" / "for 10.50" (no $ sign)
 */
function extractDollarAmount(text) {
  const s = String(text || '');

  // all $ amounts
  const dollarMatches = [...s.matchAll(/\$\s*([0-9]{1,3}(?:,\d{3})*(?:\.\d{1,2})?|[0-9]+(?:\.\d{1,2})?)/g)];
  if (dollarMatches.length) {
    // pick largest $ amount (safer for long transcripts)
    let best = null;
    for (const m of dollarMatches) {
      const v = toMoneyNumber(m[1]);
      if (!Number.isFinite(v)) continue;
      if (best == null || v > best) best = v;
    }
    return best;
  }

  // fallback: "489 dollars/bucks"
  const nearMoney = s.match(/\b([0-9]{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\b\s*(?:dollars|bucks)\b/i);
  if (nearMoney?.[1]) return toMoneyNumber(nearMoney[1]);

  // fallback: "for 10" / "for 10.50" (common transcript style)
  // Guard: avoid obvious address patterns like "for 1556 Medway Park Dr"
  const forMoney = s.match(
    /\bfor\s+([0-9]{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\b(?!\s*(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|cir|circle|way|trail|trl|pkwy|park)\b)/i
  );
  if (forMoney?.[1]) return toMoneyNumber(forMoney[1]);

  return null;
}



/**
 * parseExpenseMessage(input, ctx?)
 * Supports:
 * - "expense 84.12 nails from Home Depot"
 * - "I bought $489.78 worth of Lumber from Home Depot today for 1556 Medway Park Dr"
 */
function parseExpenseMessage(input, ctx) {
  // ✅ Make ctx always a plain object (so tz access is stable)
  ctx = ctx && typeof ctx === 'object' ? ctx : {};

  const text = String(input || '').trim();
  if (!text) return null;

  const tz = ctx?.tz || ctx?.timezone || null;

  // tz-aware date tail peel
  const { rest, date } = stripDateTail(text, tz);
  const d = date || todayInTimeZone(tz || 'UTC');

  // amount
  const amountNum = extractDollarAmount(rest);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    // fallback to strict "expense 84.12 ..."
    const strict = rest.match(
      /^(?:expense|exp)\s+\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+(?:from|at)\s+(.+))?$/i
    );
    if (!strict) return null;

    return stripUndefined({
      date: d,
      item: strict[2]?.trim() || 'Unknown',
      amount: formatMoney(strict[1]) || '$0.00',
      store: strict[3]?.trim() || 'Unknown Store'
    });
  }

  // store/vendor: "from X" or "at X"
  let store = null;
  let base = rest;

  const storeMatch = base.match(
    /\b(?:from|at)\s+([^,]+?)(?=(\s+\b(for|on|today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|$))/i
  );
  if (storeMatch?.[1]) {
    store = storeMatch[1].trim();
    base = base.replace(storeMatch[0], ' ').replace(/\s+/g, ' ').trim();
  }

  // job hint: trailing "for <something>" where it looks like an address/job token
  let jobName = null;
  const jobMatch = base.match(/\bfor\s+(.+)\s*$/i);
  if (jobMatch?.[1]) {
    const candidate = jobMatch[1].trim();
    if (looksLikeAddress(candidate) || /\bjob\b/i.test(candidate)) {
      jobName = normalizeJobNameCandidate(candidate); // ✅ shared canonical normalizer
      base = base.slice(0, jobMatch.index).trim();
    }
  }

  // item/memo
  let item = null;

  const worth = base.match(/\bworth\s+of\s+(.+?)\b/i);
  if (worth?.[1]) item = worth[1].trim();

  if (!item) {
    let cleaned = base.replace(/\$\s*[0-9]{1,3}(?:,\d{3})*(?:\.\d{1,2})?/g, ' ');
    cleaned = cleaned.replace(
      /\b(i\s+)?(bought|buy|purchased|purchase|spent|spend|paid|pay|picked\s*up|got|ordered|charge|charged)\b/ig,
      ' '
    );
    cleaned = cleaned.replace(/\b(worth\s+of)\b/ig, ' ');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/^(expense|exp)\b\s*/i, '').trim();

    const forItem = cleaned.match(/\bfor\s+(.+)\s*$/i);
    if (forItem?.[1] && !jobName) {
      item = forItem[1].trim();
    } else {
      item = cleaned;
    }
  }

  if (!item) item = 'Unknown';

  return stripUndefined({
    date: d,
    item,
    amount: formatMoney(amountNum) || '$0.00',
    store: store || 'Unknown Store',
    jobName: jobName || undefined
  });
}


function parseBillMessage(input) {
  const match = input.match(
    /^bill\s+(.+?)\s+\$?(\d+(?:\.\d{1,2})?)(?:\s+(yearly|monthly|weekly|bi-weekly|one-time))?(?:\s+due\s+(.+))?$/i
  );
  if (!match) return null;

  const dueRaw = match[4];
  const dueIso = dueRaw ? parseNaturalDate(dueRaw) : null;

  return stripUndefined({
    date: dueIso || new Date().toISOString().split('T')[0],
    billName: match[1].trim(),
    amount: `$${parseFloat(match[2]).toFixed(2)}`,
    recurrence: match[3]?.toLowerCase() || 'one-time'
  });
}

/**
 * parseRevenueMessage(input, ctx?)
 * Supports tz-aware date tail via stripDateTail(body, tz).
 */
function parseRevenueMessage(input, ctx = {}) {
  const text = String(input || '').trim();

  const lower = text.toLowerCase();
  if (!/^(revenue|rev|received)\b/i.test(lower)) return null;

  const tz = ctx?.tz || ctx?.timezone || null;

  const body = text.replace(/^(revenue|rev|received)\b\s*/i, '').trim();

  const { rest, date } = stripDateTail(body, tz);
  const d = date || todayInTimeZone(tz || 'UTC');

  const asAmount = (amt) => {
    const n = Number(String(amt).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(n)) return null;
    return `$${n.toFixed(2)}`;
  };

  // Pattern A: "$500 for X" OR "$500 from X"
  let m = rest.match(/^\$?(?<amt>\d+(?:\.\d{1,2})?)\s+(?:(?<kw>from|for)\s+)?(?<src>.+)$/i);
  if (m?.groups?.amt && m?.groups?.src) {
    const src = m.groups.src.trim();
    const kw = (m.groups.kw || '').toLowerCase();
    const amount = asAmount(m.groups.amt);
    if (!amount) return null;

    // ✅ If "for ..." treat as jobName (supports "... job")
    if (kw === 'for') {
      const jobName = normalizeJobNameCandidate(src);
      return stripUndefined({
        date: d,
        description: `Payment for ${jobName}`,
        amount,
        source: 'Unknown',
        jobName
      });
    }

    // Existing behavior: if src begins with "job ..." also treat as job
    const srcLc = src.toLowerCase();
    if (
      srcLc.startsWith('job ') ||
      srcLc.startsWith('jobname ') ||
      srcLc.startsWith('job:') ||
      srcLc.startsWith('job name')
    ) {
      const jobName = normalizeJobNameCandidate(src.replace(/^jobname\b/i, 'job'));
      return stripUndefined({
        date: d,
        description: `Payment for ${jobName}`,
        amount,
        source: 'Unknown',
        jobName
      });
    }

    // Otherwise treat as payer/source
    return stripUndefined({
      date: d,
      description: `Payment from ${src}`,
      amount,
      source: src
    });
  }

  // Pattern B: "from X $500" OR "for X $500"
  m = rest.match(/^(?:(?<kw>from|for)\s+)?(?<src>.+?)\s+\$?(?<amt>\d+(?:\.\d{1,2})?)$/i);
  if (m?.groups?.amt && m?.groups?.src) {
    const src = m.groups.src.trim();
    const kw = (m.groups.kw || '').toLowerCase();
    const amount = asAmount(m.groups.amt);
    if (!amount) return null;

    if (kw === 'for') {
      const jobName = normalizeJobNameCandidate(src);
      return stripUndefined({
        date: d,
        description: `Payment for ${jobName}`,
        amount,
        source: 'Unknown',
        jobName
      });
    }

    const srcLc = src.toLowerCase();
    if (
      srcLc.startsWith('job ') ||
      srcLc.startsWith('jobname ') ||
      srcLc.startsWith('job:') ||
      srcLc.startsWith('job name')
    ) {
      const jobName = normalizeJobNameCandidate(src.replace(/^jobname\b/i, 'job'));
      return stripUndefined({
        date: d,
        description: `Payment for ${jobName}`,
        amount,
        source: 'Unknown',
        jobName
      });
    }

    return stripUndefined({
      date: d,
      description: `Payment from ${src}`,
      amount,
      source: src
    });
  }

  return null;
}


function parseQuoteMessage(input) {
  const match = String(input || '').match(
    /^quote\s+\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+(?:to|for)\s+(.+))?$/i
  );
  if (!match) return null;

  const amount = Number(match[1]);
  const description = match[2].trim();
  const clientOrJobRaw = match[3]?.trim() || '';

  // Keep semantics:
  // - client = 3rd group or 'Unknown'
  // - jobName = if user provided tail, treat as job hint; otherwise fall back to description
  const jobName = clientOrJobRaw ? normalizeJobNameCandidate(clientOrJobRaw) : description;

  return stripUndefined({
    amount,
    description,
    client: clientOrJobRaw || 'Unknown',
    jobName
  });
}

function parseJobMessage(input) {
  const match = String(input || '').match(/^(start job|create job|new job|add job)\s+(.+)/i);
  if (!match) return null;

  const jobName = normalizeJobNameCandidate(match[2]);

  return stripUndefined({ jobName });
}



module.exports = {
  // core
  handleInputWithAI,
  correctErrorsWithAI,
  categorizeEntry,

  // keep compat
  detectErrors: detectErrorsImpl,

  // date utils (re-exported)
  todayInTimeZone,
  parseNaturalDate,
  stripDateTail,

  // parsers
  parseExpenseMessage,
  parseBillMessage,
  parseRevenueMessage,
  parseQuoteMessage,
  parseJobMessage
};
