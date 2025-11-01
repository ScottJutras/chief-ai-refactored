// services/llm/index.js
class LLMProvider {
  constructor({ provider = 'openai', model = process.env.LLM_MODEL || 'gpt-4o-mini' } = {}) {
    this.provider = provider;
    this.model = model;
  }
  async chat({ messages, tools, temperature = 0.3 }) {
    if (this.provider === 'openai') {
      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const r = await openai.chat.completions.create({
        model: this.model, messages, tools, tool_choice: 'auto', temperature
      });
      return r.choices[0].message;
    }
    throw new Error('Unsupported LLM provider');
  }
}
module.exports = { LLMProvider };
