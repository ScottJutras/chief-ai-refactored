// services/agent/index.js
const { LLMProvider } = require('../llm');

const SYSTEM = `
You are Chief — a professional, calm CFO for contractors.
Voice: concise, plain-English; bullet points over long paragraphs.
Style: ask one targeted follow-up if info is missing; confirm before actions.
Context: WhatsApp-first; everything ties to a Job (active or explicit "@Job").
Never execute actions without explicit user intent; summarize and confirm.
For "how/does/what is" questions, first call the rag_search tool with the user's question,
then answer using the retrieved snippets (cite the titles/paths in your prose).
`;

async function runAgent({ ownerId, fromPhone, text, activeJob = null, tools = [] }) {
  const llm = new LLMProvider();
  const messages = [
    { role: 'system', content: SYSTEM },
    voiceContext({ ownerId, fromPhone, activeJob }),
    { role: 'user', content: text }
  ];
  let msg = await llm.chat({ messages, tools, temperature: 0.3 });

  while (msg.tool_calls?.length) {
    const outs = [];
    for (const call of msg.tool_calls) {
      const { name, arguments: raw } = call.function;
      const args = raw ? JSON.parse(raw) : {};
      const tool = tools.find(t => t.function?.name === name);
      if (!tool) {
        outs.push({ role: 'tool', tool_call_id: call.id, content: `Error: unknown tool ${name}` });
        continue;
      }
      try {
        // Inject ownerId into rag_search if missing
        if (name === 'rag_search' && !args.ownerId) args.ownerId = ownerId || 'GLOBAL';

        const out = await tool.__handler(args);
        outs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out) });
      } catch (e) {
        outs.push({ role: 'tool', tool_call_id: call.id, content: `Error: ${e.message}` });
      }
    }
    msg = await llm.chat({ messages: [...messages, msg, ...outs], tools, temperature: 0.25 });
  }
  return msg.content || 'Done.';
}


module.exports = { runAgent };
