// services/llm/providers/anthropic.js
// Anthropic Claude provider implementing the ChiefOS LLM provider interface.
//
// Key features:
//   - Prompt caching: system prompt + job schema get cache_control markers so
//     repeated queries get a 90% discount on those tokens.
//   - Tool format translation: converts between OpenAI tool format (expected by
//     the agent loop) and Anthropic's native tool format transparently.
//   - Exponential backoff on rate-limit / overloaded errors.
//   - Soft-fail: returns { role:'assistant', content:'(llm offline)' } if key missing.

// Lazy-load the SDK — same pattern as visionService/transcriptionService.
// Top-level require crashes Vercel's bundler when the package isn't in the
// function's bundle; lazy load lets the server start and falls back to OpenAI.
let Anthropic = null;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch (e) {
  console.warn('[LLM/anthropic] @anthropic-ai/sdk not available:', e?.message);
}

// Per-model pricing (USD per 1M tokens)
const PRICING = {
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5':  { input: 0.80,  output: 4.00,  cacheWrite: 1.00, cacheRead: 0.08 },
  // Aliases
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00, cacheWrite: 1.00, cacheRead: 0.08 },
};

function estimateCostUsd(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  const billableInput = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  return (
    billableInput * p.input
    + outputTokens * p.output
    + cacheReadTokens * p.cacheRead
    + cacheWriteTokens * p.cacheWrite
  ) / 1_000_000;
}

// ----- Tool format translation: OpenAI ↔ Anthropic -----

/**
 * Convert OpenAI-format tool specs to Anthropic format.
 * OpenAI:    { type:'function', function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
function oaiToolsToAnthropic(tools = []) {
  return tools
    .filter(t => t?.type === 'function' && t?.function?.name)
    .map(t => ({
      name:         t.function.name,
      description:  t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
}

/**
 * Convert OpenAI-format messages to Anthropic format.
 * - system messages are extracted (returned separately)
 * - tool messages (role:'tool') become user messages with tool_result content
 * - assistant messages with tool_calls become assistant messages with tool_use content
 */
function oaiMessagesToAnthropic(messages = []) {
  const systemParts = [];
  const converted   = [];

  for (const m of messages) {
    const role = m.role;

    if (role === 'system') {
      // Collect all system content; we'll apply cache_control to the last block
      systemParts.push(String(m.content || ''));
      continue;
    }

    if (role === 'tool') {
      // OpenAI: { role:'tool', tool_call_id, content }
      // Anthropic: user message with content block type:'tool_result'
      const lastMsg = converted[converted.length - 1];
      const block = {
        type:        'tool_result',
        tool_use_id: m.tool_call_id,
        content:     String(m.content || ''),
      };

      if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
        lastMsg.content.push(block);
      } else {
        converted.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (role === 'assistant') {
      if (m.tool_calls?.length) {
        // Convert tool_calls → content blocks of type 'tool_use'
        const content = [];
        if (m.content) content.push({ type: 'text', text: String(m.content) });
        for (const tc of m.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
          content.push({
            type:  'tool_use',
            id:    tc.id,
            name:  tc.function?.name,
            input,
          });
        }
        converted.push({ role: 'assistant', content });
      } else {
        converted.push({ role: 'assistant', content: String(m.content || '') });
      }
      continue;
    }

    if (role === 'user') {
      converted.push({ role: 'user', content: String(m.content || '') });
      continue;
    }
  }

  // Ensure first message is user (Anthropic requirement)
  if (converted.length && converted[0].role !== 'user') {
    converted.unshift({ role: 'user', content: '.' });
  }

  // Build system array with cache_control on the last block (stable prefix)
  let systemBlocks = null;
  if (systemParts.length) {
    const combined = systemParts.join('\n\n');
    systemBlocks = [
      {
        type:          'text',
        text:          combined,
        cache_control: { type: 'ephemeral' },
      },
    ];
  }

  return { systemBlocks, messages: converted };
}

/**
 * Convert Anthropic response back to OpenAI-format message.
 */
function anthropicRespToOai(resp) {
  const content  = resp.content || [];
  const textBlocks = content.filter(b => b.type === 'text');
  const toolBlocks = content.filter(b => b.type === 'tool_use');

  const text = textBlocks.map(b => b.text || '').join('');

  if (toolBlocks.length) {
    return {
      role:       'assistant',
      content:    text || null,
      tool_calls: toolBlocks.map(b => ({
        id:       b.id,
        type:     'function',
        function: {
          name:      b.name,
          arguments: JSON.stringify(b.input || {}),
        },
      })),
    };
  }

  return { role: 'assistant', content: text };
}

// ----- Client singleton -----
let _client = null;
function getClient() {
  if (_client) return _client;
  if (!Anthropic) return null;          // SDK not available in this bundle
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  // SDK v0.82: both Anthropic.default and Anthropic.Anthropic work; prefer named export
  const Ctor = Anthropic.Anthropic || Anthropic.default;
  if (!Ctor) return null;
  _client = new Ctor({ apiKey: key, timeout: 30000 });
  return _client;
}

function _backoff(attempt) {
  const ms = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 300, 10000);
  return new Promise(r => setTimeout(r, ms));
}

// ----- Provider class -----
class AnthropicProvider {
  constructor(opts = {}) {
    this.model         = String(opts.model         || process.env.ANTHROPIC_MODEL_PRIMARY  || 'claude-sonnet-4-6').trim();
    this.fallbackModel = String(opts.fallbackModel || process.env.ANTHROPIC_MODEL_FALLBACK || 'claude-haiku-4-5').trim();
  }

  /**
   * chat({ messages, tools, temperature, max_tokens })
   * Returns an OpenAI-compatible message object with _meta.
   */
  async chat({ messages, tools, temperature = 0.2, max_tokens = 1200 }) {
    const client = getClient();
    if (!client) {
      console.warn('[LLM/anthropic] ANTHROPIC_API_KEY missing — returning soft-fail');
      return { role: 'assistant', content: '(llm offline)', _meta: this._offlineMeta() };
    }

    const { systemBlocks, messages: anthropicMessages } = oaiMessagesToAnthropic(messages);
    const anthropicTools = tools?.length ? oaiToolsToAnthropic(tools) : undefined;

    const params = {
      model:       this.model,
      max_tokens,
      temperature,
      messages:    anthropicMessages,
      ...(systemBlocks  ? { system: systemBlocks }  : {}),
      ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
      betas: ['prompt-caching-2024-07-31'],
    };

    const t0 = Date.now();
    let resp;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // beta.messages.create supports cache_control blocks + prompt-caching beta
        resp = await client.beta.messages.create(params);
        break;
      } catch (err) {
        const status  = err?.status || err?.statusCode || 0;
        const retryable = status === 529 || status === 429 || (status >= 500 && status < 600);

        if (retryable && attempt < 2) {
          const model = attempt === 1 ? this.fallbackModel : this.model;
          console.warn(`[LLM/anthropic] ${status} on ${params.model} (attempt ${attempt+1}) — backoff then retry with ${model}`);
          params.model = model;
          await _backoff(attempt);
          continue;
        }

        // Non-retryable or exhausted retries
        console.error('[LLM/anthropic] API error:', err?.message || err);
        throw err;
      }
    }

    const latencyMs = Date.now() - t0;
    const usage     = resp.usage || {};

    const inputTokens      = usage.input_tokens  || 0;
    const outputTokens     = usage.output_tokens || 0;
    const cacheReadTokens  = usage.cache_read_input_tokens   || 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens || 0;

    const msg = anthropicRespToOai(resp);
    msg._meta = {
      provider:   'anthropic',
      model:      resp.model || this.model,
      inputTokens,
      outputTokens,
      cacheHits:  cacheReadTokens,
      cacheWriteTokens,
      latencyMs,
      costUsd: estimateCostUsd(resp.model || this.model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
    };

    return msg;
  }

  _offlineMeta() {
    return { provider: 'anthropic', model: this.model, inputTokens: 0, outputTokens: 0, cacheHits: 0, latencyMs: 0, costUsd: 0 };
  }
}

module.exports = { AnthropicProvider };
