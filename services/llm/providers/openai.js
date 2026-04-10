// services/llm/providers/openai.js
// OpenAI provider implementing the ChiefOS LLM provider interface.
// Wraps the openai SDK behind a common chat() contract.

const OpenAI = require('openai');

// Per-model pricing (USD per 1M tokens) — update as pricing changes
const PRICING = {
  'gpt-4o':        { input: 2.50,  output: 10.00, cacheRead: 0 },
  'gpt-4o-mini':   { input: 0.15,  output: 0.60,  cacheRead: 0 },
  'gpt-4o-audio-preview': { input: 2.50, output: 10.00, cacheRead: 0 },
};

function estimateCostUsd(model, inputTokens, outputTokens, cacheHits = 0) {
  const p = PRICING[model] || PRICING['gpt-4o-mini'];
  const billableInput = Math.max(0, inputTokens - cacheHits);
  return (
    (billableInput * p.input + cacheHits * (p.cacheRead || p.input) + outputTokens * p.output)
    / 1_000_000
  );
}

let _client = null;
function getClient() {
  if (_client) return _client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  _client = new OpenAI({ apiKey: key, timeout: 25000 });
  return _client;
}

class OpenAIProvider {
  constructor(opts = {}) {
    this.model = String(opts.model || process.env.LLM_MODEL || 'gpt-4o-mini').trim();
    this.fallbackModel = String(opts.fallbackModel || 'gpt-4o').trim();
  }

  /**
   * chat({ messages, tools, temperature, max_tokens })
   * Returns an OpenAI-compatible message object with an attached _meta field.
   */
  async chat({ messages, tools, temperature = 0.2, max_tokens = 1200 }) {
    const client = getClient();
    if (!client) {
      console.warn('[LLM/openai] OPENAI_API_KEY missing — returning soft-fail');
      return { role: 'assistant', content: '(llm offline)', _meta: this._offlineMeta() };
    }

    const t0 = Date.now();
    const params = {
      model:       this.model,
      messages,
      temperature,
      max_tokens,
      ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    };

    let resp;
    try {
      resp = await client.chat.completions.create(params);
    } catch (err) {
      // One retry with fallback model on rate-limit / overloaded (5xx)
      const retryable = err?.status === 429 || (err?.status >= 500 && err?.status < 600);
      if (retryable && this.model !== this.fallbackModel) {
        console.warn(`[LLM/openai] ${err.status} on ${this.model} — retrying with ${this.fallbackModel}`);
        await _backoff(1);
        params.model = this.fallbackModel;
        try {
          resp = await client.chat.completions.create(params);
        } catch (err2) {
          throw err2;
        }
      } else {
        throw err;
      }
    }

    const msg    = resp.choices?.[0]?.message || { role: 'assistant', content: '' };
    const usage  = resp.usage || {};
    const model  = resp.model || this.model;
    const latencyMs = Date.now() - t0;

    const inputTokens  = usage.prompt_tokens     || 0;
    const outputTokens = usage.completion_tokens  || 0;
    const cacheHits    = usage.prompt_tokens_details?.cached_tokens || 0;

    msg._meta = {
      provider:    'openai',
      model,
      inputTokens,
      outputTokens,
      cacheHits,
      latencyMs,
      costUsd: estimateCostUsd(model, inputTokens, outputTokens, cacheHits),
    };

    return msg;
  }

  /**
   * chatStream({ messages, temperature, max_tokens })
   * Async generator that yields text tokens as they arrive from the API.
   * No tools — used only for the final synthesis step after tool rounds complete.
   */
  async *chatStream({ messages, temperature = 0.2, max_tokens = 1200 }) {
    const client = getClient();
    if (!client) {
      yield '(llm offline)';
      return;
    }

    const params = { model: this.model, messages, temperature, max_tokens, stream: true };

    try {
      const stream = await client.chat.completions.create(params);
      for await (const chunk of stream) {
        const token = chunk.choices?.[0]?.delta?.content;
        if (token) yield token;
      }
    } catch (err) {
      const retryable = err?.status === 429 || (err?.status >= 500 && err?.status < 600);
      if (retryable && this.model !== this.fallbackModel) {
        console.warn(`[LLM/openai/stream] ${err.status} — retrying with ${this.fallbackModel}`);
        await _backoff(1);
        try {
          const stream = await client.chat.completions.create({ ...params, model: this.fallbackModel });
          for await (const chunk of stream) {
            const token = chunk.choices?.[0]?.delta?.content;
            if (token) yield token;
          }
          return;
        } catch (err2) {
          throw err2;
        }
      }
      throw err;
    }
  }

  _offlineMeta() {
    return { provider: 'openai', model: this.model, inputTokens: 0, outputTokens: 0, cacheHits: 0, latencyMs: 0, costUsd: 0 };
  }
}

function _backoff(attempt) {
  const ms = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 200, 8000);
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { OpenAIProvider };
