// services/tools/rag.js
const { Pool } = require('pg');
const OpenAI = require('openai');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function searchRag({ ownerId = 'GLOBAL', query, k = 8 }) {
  const e = await openai.embeddings.create({ model: 'text-embedding-3-small', input: query });
  const v = e.data[0].embedding;

  const { rows } = await pool.query(
    `select d.title, d.path, c.content, c.metadata
       from doc_chunks c
       join docs d on d.id = c.doc_id
      where c.owner_id = $1
      order by c.embedding <=> $2
      limit $3`,
    [ownerId || 'GLOBAL', v, Math.min(k, 12)]
  );

  return rows.map(r => ({
    title: r.title || r.path || '(untitled)',
    path: r.path,
    snippet: r.content.slice(0, 900),
    meta: r.metadata || {}
  }));
}

const ragTool = {
  type: 'function',
  function: {
    name: 'rag_search',
    description: 'Search PocketCFO docs/SOPs/code to answer how/does questions; return relevant snippets.',
    parameters: {
      type: 'object',
      properties: {
        ownerId: { type: 'string', description: 'tenant id or "GLOBAL"' },
        query:   { type: 'string' },
        k:       { type: 'number', default: 8 }
      },
      required: ['query']
    }
  },
  __handler: async (args) => {
    const result = await searchRag({ ownerId: args.ownerId || 'GLOBAL', query: args.query, k: args.k || 8 });
    return { results: result };
  }
};

module.exports = { ragTool, searchRag };
