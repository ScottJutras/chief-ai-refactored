// services/llm/index.js
// Minimal LLM provider used by services/agent.
// OpenAI-only for now, soft-fails if key missing.

const OpenAI = require('openai');

class LLMProvider {
  constructor() {
    this.provider = (process.env.AI_PROVIDER || 'openai').toLowerCase();
    this.model = process.env.LLM_MODEL || 'gpt-4o-mini';
    this.openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  }

  async chat({ messages, temperature = 0.2, max_tokens = 800 }) {
    if (this.provider === 'openai' && this.openai) {
      const resp = await this.openai.chat.completions.create({
        model: this.model,
        messages,
        temperature,
        max_tokens
      });
      return resp.choices?.[0]?.message || { role: 'assistant', content: '' };
    }
    // Soft fallback (no key): echo minimal help
    const last = messages?.slice(-1)?.[0]?.content || '';
    return { role: 'assistant', content: `(llm offline) You said: ${last}` };
  }
}

module.exports = { LLMProvider };
