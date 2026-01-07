// services/tools/rag.js
// Lightweight, lazy-initialized RAG with a string-returning `answer()`
// so services/agent can call rag.answer(...) safely.

let _pool = null;
let _openai = null;
let _inited = false;

function initOnce() {
  if (_inited) return;
  _inited = true;

  try {
    const { Pool } = require('pg'); // lazy require

    // Use DATABASE_URL if present; keep it simple + serverless-friendly SSL.
    const cs =
      String(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL || '').trim();

    _pool = new Pool({
      connectionString: cs,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      application_name: 'chief-ai-rag',
    });
  } catch (e) {
    console.warn('[RAG] pg init failed:', e?.message);
    _pool = null;
  }

  try {
    const OpenAI = require('openai'); // lazy require
    if (process.env.OPENAI_API_KEY) {
      _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
  } catch (e) {
    console.warn('[RAG] OpenAI init failed:', e?.message);
    _openai = null;
  }
}

/**
 * Convert numeric array -> pgvector literal string.
 * pgvector expects: "[0.1,0.2,0.3]" (NOT Postgres array "{...}").
 */
function toPgVectorLiteral(v) {
  if (!Array.isArray(v) || v.length === 0) return null;

  const nums = v.map((x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  });

  return `[${nums.join(',')}]`;
}

async function embedWithTimeout(text, ms = 2500) {
  if (!_openai) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);

  try {
    const e = await _openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
      signal: ctl.signal,
    });
    return e?.data?.[0]?.embedding || null;
  } catch (err) {
    console.warn('[RAG] embeddings failed:', err?.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function pgSearch(ownerId, embedding, k = 8) {
  if (!_pool || !embedding) return [];

  const limit = Math.min(Math.max(Number(k) || 8, 1), 12);

  // ✅ Critical fix: force pgvector literal + cast
  const vec = toPgVectorLiteral(embedding);
  if (!vec) return [];

  try {
    // Optional debug (leave on until you confirm it’s fixed)
    // console.info('[RAG] vector param preview', { head: vec.slice(0, 60), len: vec.length });

    const { rows } = await _pool.query(
      `select d.title, d.path, c.content, c.metadata
         from doc_chunks c
         join docs d on d.id = c.doc_id
        where c.owner_id = $1
        order by c.embedding <=> $2::vector
        limit $3`,
      [ownerId || 'GLOBAL', vec, limit]
    );

    return (rows || []).map((r) => ({
      title: r.title || r.path || '(untitled)',
      path: r.path,
      snippet: (r.content || '').slice(0, 900),
      meta: r.metadata || {},
    }));
  } catch (err) {
    console.warn('[RAG] pgSearch failed:', err?.message);
    return [];
  }
}

async function searchRag({ ownerId = 'GLOBAL', query, k = 8 }) {
  initOnce();
  if (!query || typeof query !== 'string') return [];

  // If embeddings/OpenAI missing, skip rather than hang
  const v = await embedWithTimeout(query, 2500);
  if (!v) return [];

  return pgSearch(ownerId, v, k);
}

// ---------- Agent-facing string answer ----------
async function answer({ from, query, hints = [], ownerId = 'GLOBAL' } = {}) {
  const q = String(query || '');

  // ✅ Guard: don't treat receipt/OCR dumps as RAG questions
  if (
    q.length > 200 &&
    /\b(total|subtotal|hst|gst|pst|tax|receipt|invoice|visa|mastercard|debit|cash)\b/i.test(q)
  ) {
    return '';
  }

  const lc = q.toLowerCase();

  if (/\b(what can i do|what can i do here|help|how to|how do i|what now)\b/i.test(lc)) {
    return [
      'PocketCFO — What I can do:',
      '• Jobs: create job, set active job, list jobs, close job',
      '• Tasks: task – buy nails, my tasks, done #4, due #3 Friday',
      '• Timeclock: clock in/out, start break, timesheet',
      '• Money: expense $50, revenue $500, bill $200',
      '• Reports: metrics, tax, quotes',
      '• Ask me anything — I’ll search your SOPs!',
    ].join('\n');
  }

  const results = await searchRag({ ownerId, query: q, k: 8 });
  if (!results.length) return '';

  const bullets = results.slice(0, 3).map((r, i) => {
    const head = r.title || r.path || `Result ${i + 1}`;
    const snip = (r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    return `- ${head}: ${snip}${snip.length >= 280 ? '…' : ''}`;
  });

  return `Here’s what I found:\n${bullets.join('\n')}`;
}


// Optional: keep the tool wrapper if something else uses it
const ragTool = {
  type: 'function',
  function: {
    name: 'rag_search',
    description: 'Search PocketCFO docs/SOPs/code; return relevant snippets.',
    parameters: {
      type: 'object',
      properties: {
        ownerId: { type: 'string', description: 'tenant id or "GLOBAL"' },
        query: { type: 'string' },
        k: { type: 'number', default: 8 },
      },
      required: ['query'],
    },
  },
  __handler: async (args) => {
    const result = await searchRag({ ownerId: args.ownerId || 'GLOBAL', query: args.query, k: args.k || 8 });
    return { results: result };
  },
};

module.exports = { answer, searchRag, ragTool };
