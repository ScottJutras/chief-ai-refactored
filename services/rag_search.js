// services/rag_search.js
// Hybrid RAG (BM25 + embeddings). Stubbed to local SOPs + Bernie KPI example.
const OpenAI = require('openai');
const pg = require('./postgres');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function fetchRagContext(query, { k = 6 } = {}) {
  // Stub: use pgvector in prod
  const { rows } = await pg.query(
    `SELECT content, source
       FROM public.doc_chunks
      WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)
      ORDER BY id DESC
      LIMIT $2`,
    [query, k]
  );
  return rows || [];
}

async function ragAnswer({ text, ownerId }) {
  const ctx = await fetchRagContext(text);
  if (!ctx.length) return { ok: false };

  const context = ctx.map((c,i)=>`[${i+1}] ${c.content}`).join('\n\n');
  const sys = `Answer based only on the provided context. If not present, say you don't have it.`;
  const r = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `User question: ${text}\n\nContext:\n${context}` }
    ]
  });
  const answer = r.choices[0].message.content.trim();
  // naive confidence: require at least one “strong” hit
  const ok = /timeclock|tasks|jobs|invoice|kpi|timesheet|chief ai|pocketcfo/i.test(context);
  return { ok, text: answer };
}

module.exports = { ragAnswer };