// services/llm/index.js
// ChiefOS dual-provider LLM router.
//
// LLMProvider.chat() transparently routes each query to the right provider:
//   Financial analysis  →  Anthropic Claude (Sonnet 4.6, fallback Haiku)
//   Structured tasks    →  OpenAI GPT-4o mini (fallback GPT-4o)
//
// Environment variables:
//   OPENAI_API_KEY
//   ANTHROPIC_API_KEY
//   ANTHROPIC_MODEL_PRIMARY   (default: claude-sonnet-4-6)
//   ANTHROPIC_MODEL_FALLBACK  (default: claude-haiku-4-5)
//   LLM_ROUTER_MODE           "dual" | "openai-only" | "anthropic-only"
//   LLM_ROUTER_ANTHROPIC_PERCENT  0-100 (% of financial queries sent to Claude)
//   LLM_MODEL                 default OpenAI model (default: gpt-4o-mini)
//   LLM_MODEL_PORTAL          OpenAI model for portal (default: gpt-4o)

const { OpenAIProvider }    = require('./providers/openai');
const { AnthropicProvider } = require('./providers/anthropic');
const { pickProvider }      = require('./router');
const { logLLMCost, logFallbackEvent } = require('./costLogger');

// ----- Financial system prompt for Claude -----
// Injected before the user's messages when Claude handles financial queries.
// These rules are stable text → gets prompt caching at 90% discount.
const FINANCIAL_SYSTEM_ADDENDUM = `You are Chief, the financial analysis engine for ChiefOS.

Rules you must follow on every response:
- Only answer from the provided job records and tool results. Never invent numbers.
- If data is missing, say exactly what is missing instead of guessing.
- Calculate gross margin as: (revenue - costs) / revenue * 100
- When comparing jobs, always show the raw numbers (revenue, costs, margin%) side by side.
- Amounts should be in dollars with two decimal places unless the user asks otherwise.
- Be direct and concise. Contractors want numbers, not disclaimers.

Uncertainty rules — required on every response:
- Tool returned zero rows / empty:  "No [X] is logged for [Y] yet. Record it via WhatsApp and I can answer this."
- Tool returned error:  "I couldn't retrieve [X] right now — [brief reason if available]. Try again or ask a different way."
- Partial data (some categories missing):  "Based on what's recorded: [findings]. [Missing field] isn't logged yet, so [stated implication]."
  Example: "3 cost entries found but no material costs logged — margin may be understated."
  Example: "No revenue logged for this job yet — cannot calculate profitability."
- Missing crew rates:  "Hours are recorded but [employee name] has no pay rate set. Use 'set rate [name] $X/hour' to unlock the dollar figure."
- Full data, confident answer:  Lead directly with the number. No hedges.
Never say "probably", "might be", "I think", or "possibly" about tool results — either you have the data or you don't. State which.`;

class LLMProvider {
  constructor(opts = {}) {
    const envProvider = process.env.LLM_PROVIDER || process.env.AI_PROVIDER || 'openai';
    this.providerHint = String(opts.provider || envProvider).toLowerCase().trim();

    // OpenAI defaults
    const oaiModel = String(opts.model || process.env.LLM_MODEL || 'gpt-4o-mini').trim();
    const oaiFallback = String(opts.fallbackModel || process.env.LLM_MODEL_PORTAL || 'gpt-4o').trim();

    // Anthropic defaults (driven by env; constructor opts can override)
    const anthropicModel         = String(opts.anthropicModel         || process.env.ANTHROPIC_MODEL_PRIMARY  || 'claude-sonnet-4-6').trim();
    const anthropicFallbackModel = String(opts.anthropicFallbackModel || process.env.ANTHROPIC_MODEL_FALLBACK || 'claude-haiku-4-5').trim();

    this._openai    = new OpenAIProvider({ model: oaiModel, fallbackModel: oaiFallback });
    this._anthropic = new AnthropicProvider({ model: anthropicModel, fallbackModel: anthropicFallbackModel });

    // Stored for cost logging context
    this._queryKind = opts.queryKind || null;
    this._ownerId   = opts.ownerId   || null;
  }

  /**
   * chatStream({ messages, temperature, max_tokens })
   *
   * Async generator — yields text tokens from whichever provider handles this query.
   * No tools are passed; this is used only for the final synthesis step after tool
   * rounds have already run. Falls back cross-provider if the primary throws.
   */
  async *chatStream({ messages, temperature = 0.2, max_tokens = 1200 }) {
    const target = pickProvider(messages);
    const effectiveMessages = target === 'anthropic' ? _injectFinancialSystemPrompt(messages) : messages;
    const primary   = target === 'anthropic' ? this._anthropic : this._openai;
    const fallback  = target === 'anthropic' ? this._openai    : this._anthropic;

    try {
      for await (const token of primary.chatStream({ messages: effectiveMessages, temperature, max_tokens })) {
        yield token;
      }
    } catch (primaryErr) {
      console.warn(`[LLM] chatStream primary (${target}) failed, falling back:`, primaryErr?.message);
      try {
        for await (const token of fallback.chatStream({ messages, temperature, max_tokens })) {
          yield token;
        }
      } catch (fallbackErr) {
        console.error('[LLM] chatStream fallback also failed:', fallbackErr?.message);
        yield '(llm offline)';
      }
    }
  }

  /**
   * chat({ messages, tools, temperature, max_tokens })
   *
   * Routes to Anthropic or OpenAI based on financial intent detection.
   * Falls back cross-provider on transient errors.
   * Returns an OpenAI-compatible message object with _meta attached.
   */
  async chat({ messages, tools, temperature = 0.2, max_tokens = 1200 }) {
    const routerMode = String(process.env.LLM_ROUTER_MODE || 'dual').toLowerCase();

    // Determine target provider
    let target;
    if (routerMode === 'openai-only') {
      target = 'openai';
    } else if (routerMode === 'anthropic-only') {
      target = 'anthropic';
    } else if (this.providerHint !== 'openai' && this.providerHint !== 'anthropic') {
      // Legacy "auto" or unrecognized → use router
      target = pickProvider(messages);
    } else {
      // Explicit provider set by caller, but still run financial router check
      // to potentially upgrade to Anthropic for financial queries
      target = pickProvider(messages);
    }

    const queryKind = this._queryKind
      || (target === 'anthropic' ? 'financial_analysis' : 'structured_task');

    // Inject financial system prompt when routing to Claude
    let effectiveMessages = messages;
    if (target === 'anthropic') {
      effectiveMessages = _injectFinancialSystemPrompt(messages);
    }

    // Attempt primary provider
    try {
      const msg = target === 'anthropic'
        ? await this._anthropic.chat({ messages: effectiveMessages, tools, temperature, max_tokens })
        : await this._openai.chat({ messages, tools, temperature, max_tokens });

      if (msg._meta) {
        logLLMCost({ ownerId: this._ownerId, queryKind, meta: msg._meta });
      }

      return msg;
    } catch (primaryErr) {
      // Cross-provider fallback
      const fallback = target === 'anthropic' ? 'openai' : 'anthropic';
      const fallbackAvailable = fallback === 'openai'
        ? !!process.env.OPENAI_API_KEY
        : !!process.env.ANTHROPIC_API_KEY;

      logFallbackEvent({
        ownerId:      this._ownerId,
        queryKind,
        fromProvider: target,
        toProvider:   fallback,
        reason:       primaryErr?.message || String(primaryErr),
      });

      if (!fallbackAvailable) {
        console.error(`[LLM] Both providers unavailable — soft-failing`);
        return { role: 'assistant', content: '(llm offline)' };
      }

      console.warn(`[LLM] Primary (${target}) failed, falling back to ${fallback}`);

      try {
        const msg = fallback === 'anthropic'
          ? await this._anthropic.chat({ messages: effectiveMessages, tools, temperature, max_tokens })
          : await this._openai.chat({ messages, tools, temperature, max_tokens });

        if (msg._meta) {
          msg._meta.fallback = true;
          logLLMCost({ ownerId: this._ownerId, queryKind: `${queryKind}:fallback`, meta: msg._meta });
        }

        return msg;
      } catch (fallbackErr) {
        console.error('[LLM] Fallback also failed:', fallbackErr?.message);
        return { role: 'assistant', content: '(llm offline)' };
      }
    }
  }
}

/**
 * Inject the financial system addendum into the messages array.
 * If a system message already exists, append to it.
 * If not, prepend a new one.
 * Never mutates the original array.
 */
function _injectFinancialSystemPrompt(messages = []) {
  const copy = [...messages];
  const sysIdx = copy.findIndex(m => m.role === 'system');

  if (sysIdx >= 0) {
    const existing = String(copy[sysIdx].content || '');
    // Only inject if not already present (idempotent)
    if (!existing.includes('financial analysis engine')) {
      copy[sysIdx] = {
        ...copy[sysIdx],
        content: `${existing}\n\n${FINANCIAL_SYSTEM_ADDENDUM}`,
      };
    }
  } else {
    copy.unshift({ role: 'system', content: FINANCIAL_SYSTEM_ADDENDUM });
  }

  return copy;
}

module.exports = { LLMProvider };
