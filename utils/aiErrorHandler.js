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

/**
 * Main ingestion helper:
 * - Try regex parseFn first
 * - If parseFn fails => ask AI for clarification response
 * - If parseFn succeeds => run detectErrors; if errors => optionally AI suggests corrections + sets pending state
 * - Otherwise return confirmed:true with parsed data
 */
async function handleInputWithAI(from, input, type, parseFn, defaultData = {}) {
  console.log(`[DEBUG] Ingestion parse (${type}): "${input}"`);

  // 1) Attempt deterministic parse first
  let data = null;
  try {
    data = parseFn(input);
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
    data = { ...defaultData, ...data };
  }

  // 3) Detect structural errors (missing fields etc.)
  let errors = null;
  try {
    errors = await detectErrorsImpl(data, type);
  } catch (e) {
    console.warn(`[WARN] detectErrors failed for ${type}:`, e?.message);
    errors = null;
  }

  // 4) If errors exist, ask AI for correction suggestions (optional) and save pending state
  if (errors) {
    const corrections = await correctErrorsWithAI(
      `Type=${type} Errors=${JSON.stringify(errors)} Data=${JSON.stringify(data)}`,
      type
    );

    if (corrections) {
      const pendingKey =
        type === 'expense' ? 'pendingExpense' :
        type === 'revenue' ? 'pendingRevenue' :
        type === 'bill'    ? 'pendingBill' :
        type === 'quote'   ? 'pendingQuote' :
        'pendingData';

      await stateManager.setPendingTransactionState(from, {
        [pendingKey]: data,
        pendingCorrection: true,
        suggestedCorrections: corrections,
        type
      });

      const text = Object.entries(corrections)
        .map(([k, v]) => `${k}: ${data[k] || 'missing'} → ${v}`)
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

/**
 * Deterministic parsers (keep these simple; they feed the CIL gate)
 */
function parseExpenseMessage(input) {
  const match = input.match(/^(?:expense\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
  if (!match) return null;
  return {
    date: new Date().toISOString().split('T')[0],
    item: match[2].trim(),
    amount: `$${parseFloat(match[1]).toFixed(2)}`,
    store: match[3]?.trim() || 'Unknown Store'
  };
}

function parseBillMessage(input) {
  const match = input.match(
    /^bill\s+(.+?)\s+\$?(\d+(?:\.\d{1,2})?)(?:\s+(yearly|monthly|weekly|bi-weekly|one-time))?(?:\s+due\s+(.+))?$/i
  );
  if (!match) return null;

  const dueRaw = match[4];
  const dueIso = dueRaw ? parseNaturalDate(dueRaw) : null;

  return {
    date: dueIso || new Date().toISOString().split('T')[0],
    billName: match[1].trim(),
    amount: `$${parseFloat(match[2]).toFixed(2)}`,
    recurrence: match[3]?.toLowerCase() || 'one-time'
  };
}

function stripDateTail(raw = '') {
  // Pull a trailing date-ish token off the end, if present.
  // Examples:
  //   "... today"
  //   "... on today"
  //   "... 2025-12-12"
  //   "... on 2025-12-12"
  //   "... Dec 12, 2025"
  // NOTE: timezone cannot be applied here unless you pass tz through;
  // follow-up handling in revenue.js should do tz-aware resolution.
  const s = String(raw).trim();

  // ISO at end, optionally preceded by "on"
  const mIso = s.match(/\s+(?:on\s+)?(?<date>\d{4}-\d{2}-\d{2})\s*$/i);
  if (mIso?.groups?.date) {
    return { rest: s.slice(0, mIso.index).trim(), date: mIso.groups.date };
  }

  // today/yesterday/tomorrow at end, optionally preceded by "on"
  const mWord = s.match(/\s+(?:on\s+)?(?<date>today|yesterday|tomorrow)\s*$/i);
  if (mWord?.groups?.date) {
    return { rest: s.slice(0, mWord.index).trim(), date: parseNaturalDate(mWord.groups.date) };
  }

  // Try natural language date at the end (best-effort)
  const mTail = s.match(/\s+(?:on\s+)?(?<date>[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\s*$/);
  if (mTail?.groups?.date) {
    const d = parseNaturalDate(mTail.groups.date);
    if (d) return { rest: s.slice(0, mTail.index).trim(), date: d };
  }

  return { rest: s, date: null };
}

function parseRevenueMessage(input) {
  const text = String(input || '').trim();

  // Support:
  // 1) "revenue $100 from John today"
  // 2) "revenue from John $100 today"
  // 3) "received $100 from John"
  const lower = text.toLowerCase();
  if (!/^(revenue|rev|received)\b/i.test(lower)) return null;

  // Remove leading keyword
  const body = text.replace(/^(revenue|rev|received)\b\s*/i, '').trim();

  // Peel off trailing date token (today / on YYYY-MM-DD / Dec 12 2025)
  const { rest, date } = stripDateTail(body);

  // Pattern A: "$100 from John"
  let m = rest.match(/^\$?(?<amt>\d+(?:\.\d{1,2})?)\s+(?:from\s+)?(?<src>.+)$/i);
  if (m?.groups?.amt && m?.groups?.src) {
    const src = m.groups.src.trim();
    const d = date || new Date().toISOString().split('T')[0];
    return {
      date: d,
      description: `Payment from ${src}`,
      amount: `$${parseFloat(m.groups.amt).toFixed(2)}`,
      source: src
    };
  }

  // Pattern B: "from John $100"
  m = rest.match(/^(?:from\s+)?(?<src>.+?)\s+\$?(?<amt>\d+(?:\.\d{1,2})?)$/i);
  if (m?.groups?.amt && m?.groups?.src) {
    const src = m.groups.src.trim();
    const d = date || new Date().toISOString().split('T')[0];
    return {
      date: d,
      description: `Payment from ${src}`,
      amount: `$${parseFloat(m.groups.amt).toFixed(2)}`,
      source: src
    };
  }

  return null;
}

function parseQuoteMessage(input) {
  const match = input.match(/^quote\s+\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+(?:to|for)\s+(.+))?$/i);
  if (!match) return null;
  return {
    amount: parseFloat(match[1]),
    description: match[2].trim(),
    client: match[3]?.trim() || 'Unknown',
    jobName: match[2].trim()
  };
}

function parseJobMessage(input) {
  const match = input.match(/^(start job|create job)\s+(.+)/i);
  if (!match) return null;
  return { jobName: match[2].trim() };
}

module.exports = {
  // core
  handleInputWithAI,
  correctErrorsWithAI,
  categorizeEntry,

  // date utils (exported so revenue.js can reuse tz-aware parsing if you want)
  todayInTimeZone,
  parseNaturalDate,
  stripDateTail,

  // parsers
  parseExpenseMessage,
  parseBillMessage,
  parseRevenueMessage,
  parseQuoteMessage,
  parseJobMessage,
};
