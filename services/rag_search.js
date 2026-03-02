// services/rag_search.js
// Simple keyword RAG over public.doc_chunks (tsvector).
// - Detect optional columns once (no repeated undefined-column warnings)
// - Soft-fail if OPENAI_API_KEY missing
// - Answer must be grounded ONLY in retrieved context

const OpenAI = require("openai");
const pg = require("./postgres");

let _docChunksCols = null;

/**
 * Cache doc_chunks column availability so we don’t spam logs
 * with undefined-column retries on every RAG call.
 */
async function getDocChunksColumns() {
  if (_docChunksCols) return _docChunksCols;

  try {
    const r = await pg.query(
      `
      select column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'doc_chunks'
      `
    );

    const set = new Set((r?.rows || []).map((x) => String(x.column_name || "").toLowerCase()));
    _docChunksCols = {
      hasSource: set.has("source"),
      // If you later add scoping columns, this will automatically start using them:
      hasOwnerId: set.has("owner_id"),
      hasTenantId: set.has("tenant_id"),
    };
    return _docChunksCols;
  } catch (e) {
    // Fail open: assume minimal schema
    _docChunksCols = { hasSource: false, hasOwnerId: false, hasTenantId: false };
    return _docChunksCols;
  }
}

async function fetchRagContext(query, { k = 6, ownerId = null, tenantId = null } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];

  const cols = await getDocChunksColumns();

  // Build SELECT list
  const selectSource = cols.hasSource ? "source" : "null::text as source";

  // Build optional WHERE scoping (only if columns exist AND values are provided)
  // NOTE: We do NOT assume these columns exist today; this is future-proofing.
  const whereParts = [
    `to_tsvector('english', content) @@ plainto_tsquery('english', $1)`,
  ];
  const params = [q];
  let paramIdx = 2;

  if (cols.hasOwnerId && ownerId) {
    whereParts.push(`owner_id = $${paramIdx++}`);
    params.push(String(ownerId));
  }
  if (cols.hasTenantId && tenantId) {
    whereParts.push(`tenant_id = $${paramIdx++}::uuid`);
    params.push(String(tenantId));
  }

  // LIMIT param
  params.push(Number(k) || 6);
  const limitParam = `$${paramIdx++}`;

  // Prefer rank if you later add a tsvector column; for now, stable recency order
  const sql = `
    select content, ${selectSource}
      from public.doc_chunks
     where ${whereParts.join("\n       and ")}
     order by id desc
     limit ${limitParam}
  `;

  const r = await pg.query(sql, params);
  return r?.rows || [];
}

async function ragAnswer({ text, ownerId, tenantId } = {}) {
  const q = String(text || "").trim();
  if (!q) return "";

  const ctx = await fetchRagContext(q, { k: 6, ownerId: ownerId || null, tenantId: tenantId || null });
  if (!ctx.length) return "";

  // Soft-fail if no OpenAI key (keeps webhook stable)
  if (!process.env.OPENAI_API_KEY) return "";

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const context = ctx
    .map((c, i) => {
      const src = c?.source ? ` (src: ${String(c.source).slice(0, 80)})` : "";
      return `[${i + 1}]${src}\n${String(c.content || "").trim()}`;
    })
    .join("\n\n");

  const sys =
    "Answer based ONLY on the provided context snippets. " +
    "If the answer is not in the context, say you don’t have it.";

  const r = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || process.env.LLM_MODEL || "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `User question: ${q}\n\nContext:\n${context}` },
    ],
  });

  const answer = String(r?.choices?.[0]?.message?.content || "").trim();
  return answer || "";
}

module.exports = { ragAnswer, fetchRagContext };