// api/index-sops.js
'use strict';

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { Pool } = require('pg');

// ---- Clients (created once per cold start) ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---- Config ----
const DOCS = [
  { file: 'docs/howto/jobs.md', title: 'Jobs SOP' },
  { file: 'docs/howto/tasks.md', title: 'Tasks SOP' },
  { file: 'docs/howto/timeclock.md', title: 'Timeclock SOP' },
  { file: 'docs/howto/shared_contracts.md', title: 'Shared Contracts' },
];

const CHUNK_SIZE = 1000; // ~1k chars per chunk keeps costs+results good

// ---- Utilities ----
function chunkText(str, size = CHUNK_SIZE) {
  if (!str) return [];
  // simple fixed-size chunking; could be upgraded to sentence-aware later
  const chunks = [];
  let i = 0;
  while (i < str.length) {
    chunks.push(str.slice(i, i + size));
    i += size;
  }
  return chunks;
}

async function ensureSchema() {
  // Safe to run repeatedly (idempotent)
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doc_chunks (
      id SERIAL PRIMARY KEY,
      owner_id TEXT NOT NULL,
      doc_id   TEXT NOT NULL,
      content  TEXT NOT NULL,
      embedding VECTOR(1536),
      metadata JSONB DEFAULT '{}',
      UNIQUE (owner_id, doc_id, content)
    );
  `);
  // Smaller lists to avoid high maintenance_work_mem needs
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_doc_chunks_embedding
      ON doc_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
  `);
}

async function embed(text) {
  const resp = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return resp.data[0].embedding;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  try {
    // Basic env sanity
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY missing' });
    }
    if (!process.env.DATABASE_URL) {
      return res.status(500).json({ error: 'DATABASE_URL missing' });
    }

    await ensureSchema();

    const summary = { indexed: 0, skipped: 0, perDoc: {} };

    for (const { file, title } of DOCS) {
      const fullPath = path.join(process.cwd(), file);
      if (!fs.existsSync(fullPath)) {
        summary.perDoc[title] = { indexed: 0, skipped: 0, note: 'file not found' };
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const chunks = chunkText(content, CHUNK_SIZE);

      let iAdded = 0;
      let iSkipped = 0;

      for (const chunk of chunks) {
        // Create embedding
        const vec = await embed(chunk);

        // Insert (idempotent). IMPORTANT: cast to ::vector.
        const result = await pool.query(
          `INSERT INTO doc_chunks (owner_id, doc_id, content, embedding, metadata)
           VALUES ($1, $2, $3, $4::vector, $5)
           ON CONFLICT (owner_id, doc_id, content) DO NOTHING
           RETURNING id`,
          ['GLOBAL', title, chunk, vec, { source: file }]
        );

        if (result.rowCount > 0) {
          iAdded++;
          summary.indexed++;
        } else {
          iSkipped++;
          summary.skipped++;
        }
      }

      summary.perDoc[title] = { indexed: iAdded, skipped: iSkipped, source: file };
    }

    res.status(200).json({ success: true, ...summary });
  } catch (err) {
    console.error('Indexer error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
};
