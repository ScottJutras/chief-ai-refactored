// utils/aiErrorHandler.js
const { callOpenAI } = require('../services/openAI');
const stateManager = require('./stateManager');
const { detectErrors: detectErrorsImpl } = require('./errorDetector');

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
 * Timezone-aware "today" (YYYY-MM-DD) using Intl.
 * If tz is invalid or Intl fails, fall back to server time.
 */
function todayInTimeZone(tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    // en-CA yields YYYY-MM-DD
    return dtf.format(new Date());
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

/**
 * Parse common natural date tokens into YYYY-MM-DD.
 * Supports: today/yesterday/tomorrow, ISO, and "Dec 12, 2025" formats.
 * tz is optional but recommended so "today" matches the user's locale.
 */
function parseNaturalDate(s, tz) {
  const t = String(s || '').trim().toLowerCase();

  const today = todayInTimeZone(tz || 'UTC');
  if (!t || t === 'today') return today;

  if (t === 'yesterday') {
    // use noon Z anchored on "today" to avoid DST edge weirdness
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }

  if (t === 'tomorrow') {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
  }

  // strict ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  // “December 12, 2025”, “Dec 12 2025”, etc.
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().split('T')[0];

  return null;
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
 * ctx is optional (ex: { tz }) and will be passed to parseFn if parseFn accepts 2 args.
 */
async function handleInputWithAI(from, input, type, parseFn, defaultData = {}, ctx = {}) {
  console.log(`[DEBUG] Ingestion parse (${type}): "${input}"`);

  // 1) Attempt deterministic parse first
  let data = null;
  try {
    if (typeof parseFn === 'function') {
      data = parseFn.length >= 2 ? parseFn(input, ctx) : parseFn(input);
    }
  } catch (e) {
    console.warn(`[WARN] parseFn threw for ${type}:`, e?.message);
    data = null;
  }

  // 2) If deterministic parse failed, ask for clarification (but still ingestion-only)
  if (!data) {
    return await proposeClarification(input, type);
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
    // ✅ key patch: pass ctx through
    errors = await detectErrorsImpl(data, type, ctx);

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

  // 4) If errors exist, ask AI for correction suggestions (optional) and save pending state
  if (errors) {
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

  return null;
}

/**
 * stripDateTail(raw, tz?)
 * Pull a trailing date-ish token off the end, if present.
 */
function stripDateTail(raw = '', tz) {
  const s = String(raw).trim();

  // ISO at end, optionally preceded by "on"
  const mIso = s.match(/\s+(?:on\s+)?(?<date>\d{4}-\d{2}-\d{2})\s*$/i);
  if (mIso?.groups?.date) {
    return { rest: s.slice(0, mIso.index).trim(), date: mIso.groups.date };
  }

  // today/yesterday/tomorrow at end, optionally preceded by "on"
  const mWord = s.match(/\s+(?:on\s+)?(?<date>today|yesterday|tomorrow)\s*$/i);
  if (mWord?.groups?.date) {
    return { rest: s.slice(0, mWord.index).trim(), date: parseNaturalDate(mWord.groups.date, tz) };
  }

  // Try natural language date at the end (best-effort)
  const mTail = s.match(/\s+(?:on\s+)?(?<date>[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\s*$/);
  if (mTail?.groups?.date) {
    const d = parseNaturalDate(mTail.groups.date, tz);
    if (d) return { rest: s.slice(0, mTail.index).trim(), date: d };
  }

  return { rest: s, date: null };
}

/**
 * parseExpenseMessage(input, ctx?)
 * Supports:
 * - "expense 84.12 nails from Home Depot"
 * - "I bought $489.78 worth of Lumber from Home Depot today for 1556 Medway Park Dr"
 */
function parseExpenseMessage(input, ctx = {}) {
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
      jobName = candidate.replace(/^job\s*[:\-]?\s*/i, '').trim();
      base = base.slice(0, jobMatch.index).trim();
    }
  }

  // item/memo:
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
 * NOTE: revenue parsing currently does not use tz for date tail unless you add it (optional).
 */
function parseRevenueMessage(input, ctx = {}) {
  const text = String(input || '').trim();

  const lower = text.toLowerCase();
  if (!/^(revenue|rev|received)\b/i.test(lower)) return null;

  const tz = ctx?.tz || ctx?.timezone || null;

  const body = text.replace(/^(revenue|rev|received)\b\s*/i, '').trim();

  const { rest, date } = stripDateTail(body, tz);
  const d = date || todayInTimeZone(tz || 'UTC');

  const asAmount = (amt) => `$${parseFloat(amt).toFixed(2)}`;
  const normalizeJobPrefix = (s) =>
    String(s || '')
      .trim()
      .replace(/^(job|job\s*name)\s*[:\-]?\s*/i, '')
      .trim();

  let m = rest.match(/^\$?(?<amt>\d+(?:\.\d{1,2})?)\s+(?:(?<kw>from|for)\s+)?(?<src>.+)$/i);
  if (m?.groups?.amt && m?.groups?.src) {
    let src = m.groups.src.trim();
    const kw = (m.groups.kw || '').toLowerCase();

    if (kw === 'for') {
      const jobName = normalizeJobPrefix(src);
      return stripUndefined({
        date: d,
        description: `Payment for ${jobName}`,
        amount: asAmount(m.groups.amt),
        source: 'Unknown',
        jobName
      });
    }

    const srcLc = src.toLowerCase();
    if (srcLc.startsWith('job ') || srcLc.startsWith('jobname ') || srcLc.startsWith('job:')) {
      const jobName = normalizeJobPrefix(src.replace(/^jobname\b/i, 'job'));
      return stripUndefined({
        date: d,
        description: `Payment for ${jobName}`,
        amount: asAmount(m.groups.amt),
        source: 'Unknown',
        jobName
      });
    }

    return stripUndefined({
      date: d,
      description: `Payment from ${src}`,
      amount: asAmount(m.groups.amt),
      source: src
    });
  }

  m = rest.match(/^(?:(?<kw>from|for)\s+)?(?<src>.+?)\s+\$?(?<amt>\d+(?:\.\d{1,2})?)$/i);
  if (m?.groups?.amt && m?.groups?.src) {
    let src = m.groups.src.trim();
    const kw = (m.groups.kw || '').toLowerCase();

    if (kw === 'for') {
      const jobName = normalizeJobPrefix(src);
      return stripUndefined({
        date: d,
        description: `Payment for ${jobName}`,
        amount: asAmount(m.groups.amt),
        source: 'Unknown',
        jobName
      });
    }

    const srcLc = src.toLowerCase();
    if (srcLc.startsWith('job ') || srcLc.startsWith('jobname ') || srcLc.startsWith('job:')) {
      const jobName = normalizeJobPrefix(src.replace(/^jobname\b/i, 'job'));
      return stripUndefined({
        date: d,
        description: `Payment for ${jobName}`,
        amount: asAmount(m.groups.amt),
        source: 'Unknown',
        jobName
      });
    }

    return stripUndefined({
      date: d,
      description: `Payment from ${src}`,
      amount: asAmount(m.groups.amt),
      source: src
    });
  }

  return null;
}

function parseQuoteMessage(input) {
  const match = input.match(/^quote\s+\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+(?:to|for)\s+(.+))?$/i);
  if (!match) return null;
  return stripUndefined({
    amount: parseFloat(match[1]),
    description: match[2].trim(),
    client: match[3]?.trim() || 'Unknown',
    jobName: match[2].trim()
  });
}

function parseJobMessage(input) {
  const match = input.match(/^(start job|create job|new job|add job)\s+(.+)/i);
  if (!match) return null;
  return stripUndefined({ jobName: match[2].trim() });
}

module.exports = {
  // core
  handleInputWithAI,
  correctErrorsWithAI,
  categorizeEntry,

  // keep compat
  detectErrors: detectErrorsImpl,

  // date utils
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
