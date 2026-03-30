// services/llm/index.js
// Minimal LLM provider used by services/agent.
// OpenAI-only for now, soft-fails if key missing.

const OpenAI = require("openai");

class LLMProvider {
  constructor(opts = {}) {
    // Normalize env var naming (support both)
    const envProvider =
      process.env.LLM_PROVIDER ||
      process.env.AI_PROVIDER ||
      "openai";

    this.provider = String(opts.provider || envProvider).toLowerCase().trim();
    this.model = String(opts.model || process.env.LLM_MODEL || "gpt-4o-mini").trim();

    this.openai =
      this.provider === "openai" && process.env.OPENAI_API_KEY
        ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 22000 })
        : null;
  }

  async chat({ messages, tools, temperature = 0.2, max_tokens = 1200 }) {
    if (this.provider === "openai" && this.openai) {
      const resp = await this.openai.chat.completions.create({
        model: this.model,
        messages,
        // Only send tools if present
        ...(Array.isArray(tools) && tools.length ? { tools } : {}),
        temperature,
        max_tokens,
      });

      return resp.choices?.[0]?.message || { role: "assistant", content: "" };
    }

    // Soft fallback (no key): echo minimal help
    const last = messages?.slice(-1)?.[0]?.content || "";
    return { role: "assistant", content: `(llm offline) You said: ${last}` };
  }
}

module.exports = { LLMProvider };