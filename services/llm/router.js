// services/llm/router.js
// Rules-based LLM query router for ChiefOS.
//
// Routing rules (v1 — keyword matching):
//   Financial analysis → Anthropic Claude (Sonnet 4.6)
//   Structured/parsing tasks → OpenAI (GPT-4o mini)
//
// Kill switches and rollout controls:
//   LLM_ROUTER_MODE               "dual" | "openai-only" | "anthropic-only"
//   LLM_ROUTER_ANTHROPIC_PERCENT  0-100 integer (percentage of financial queries to Claude)

// ---------------------------------------------------------------------------
// Financial intent detection
// ---------------------------------------------------------------------------

// Primary financial keywords — strong signal, route to Claude
const FINANCIAL_SIGNAL_RE = /\b(profit|margin|cost|revenue|money|unbilled|overspent|compare jobs?|expensive|losing money|make money|labor costs?|labour costs?|material costs?|cashflow|cash flow|break[- ]?even|overhead|budget|billable|markup|gross|net|roi|return on|where did.*go|how much.*made|how much.*spent|are we up|are we down|job profitab|which jobs?.*los|which jobs?.*mak|anomal|underbill|overbill|underpaid|overpaid)\b/i;

// Secondary signals — weaker, but tip the scales toward Claude
const FINANCIAL_SECONDARY_RE = /\b(spend|spending|earnings|expenses?|invoic|quot|estimate|forecast|ytd|mtd|wtd|this month|this week|last month|last week|total|sum|breakdown|analysis|analys|report|summary|summarize|trend)\b/i;

// Structured / parsing tasks that should stay on OpenAI regardless
const STRUCTURED_TASK_RE = /^(expense|revenue|clock|punch|task|drive|break|job create|create job|new job|list jobs?|set active|done #?\d+)\b/i;

/**
 * detectFinancialIntent(messages)
 * Returns true if the conversation's user content signals financial analysis.
 * "When in doubt, route to Claude" — so we use a low threshold.
 */
function detectFinancialIntent(messages = []) {
  // Collect all user + system message text
  const text = messages
    .filter(m => m.role === 'user' || m.role === 'system')
    .map(m => {
      const c = m.content;
      if (!c) return '';
      if (typeof c === 'string') return c;
      // Anthropic-style content array
      if (Array.isArray(c)) return c.map(b => b.text || b.content || '').join(' ');
      return '';
    })
    .join(' ');

  const lc = String(text || '').toLowerCase();

  // Structured task → always OpenAI
  if (STRUCTURED_TASK_RE.test(lc)) return false;

  // Strong financial signal → Claude
  if (FINANCIAL_SIGNAL_RE.test(lc)) return true;

  // Two or more secondary signals → Claude
  const secondaryMatches = (lc.match(FINANCIAL_SECONDARY_RE) || []).length;
  if (secondaryMatches >= 2) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Rollout gate
// ---------------------------------------------------------------------------

/**
 * shouldUseAnthropic(messages)
 * Returns true when this query should go to Claude, respecting all kill switches.
 */
function shouldUseAnthropic(messages = []) {
  const mode = String(process.env.LLM_ROUTER_MODE || 'dual').toLowerCase();

  if (mode === 'openai-only')    return false;
  if (mode === 'anthropic-only') return true;

  // Kill switch: no key
  if (!process.env.ANTHROPIC_API_KEY) return false;

  // Must be a financial query
  if (!detectFinancialIntent(messages)) return false;

  // Percentage-based rollout (default 100 = all financial queries go to Claude)
  const pct = parseInt(process.env.LLM_ROUTER_ANTHROPIC_PERCENT ?? '100', 10);
  if (isNaN(pct) || pct <= 0)   return false;
  if (pct >= 100)               return true;

  return Math.random() * 100 < pct;
}

/**
 * pickProvider(messages)
 * Returns 'anthropic' or 'openai'.
 */
function pickProvider(messages = []) {
  return shouldUseAnthropic(messages) ? 'anthropic' : 'openai';
}

module.exports = { pickProvider, detectFinancialIntent, shouldUseAnthropic };
