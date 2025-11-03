// api/index-sops.js
'use strict';
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { Pool } = require('pg');
const { v5: uuidv5 } = require('uuid');

// Clients (created once per cold start)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Config
const DOCS = [
  { file: 'docs/howto/jobs.md',      title: 'Jobs SOP' },
  { file: 'docs/howto/tasks.md',     title: 'Tasks SOP' },
  { file: 'docs/howto/timeclock.md', title: 'Timeclock SOP' },
  { file: 'docs/howto/shared_contracts.md', title: 'Shared Contracts' },
];

const CHUNK_SIZE = 1000;            // ~1k chars per chunk
const UUID_NS = uuidv5.URL;         // deterministic namespace per file path

function chunkText(str, size = CHUNK_SIZE) {
  if (!str) return [];
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

async function ensureSchema() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doc_chunks (
      id        SERIAL PRIMARY KEY,
      owner_id  TEXT   NOT NULL,
      doc_id    UUID   NOT NULL,
      content   TEXT   NOT NULL,
      embedding VECTOR(1536),
      metadata  JSONB  DEFAULT '{}'::jsonb,
      UNIQUE (owner_id, doc_id, content)
    );
  `);
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
  if (req.method === 'HEAD') {
    return res.status(200).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
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

      // deterministic doc_id per file path
      const docId = uuidv5(file, UUID_NS);

      let added = 0, skipped = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const vec = await embed(chunk);

        const result = await pool.query(
          `INSERT INTO doc_chunks (owner_id, doc_id, content, embedding, metadata)
           VALUES ($1, $2, $3, $4::vector, $5::jsonb)
           ON CONFLICT (owner_id, doc_id, content) DO NOTHING
           RETURNING id`,
          [
            'GLOBAL',
            docId,
            chunk,
            vec,
            JSON.stringify({ path: file, title, chunk_index: i })
          ]
        );

        if (result.rowCount > 0) added++;
        else skipped++;
      }

      summary.indexed += added;
      summary.skipped += skipped;
      summary.perDoc[title] = { indexed: added, skipped, source: file, doc_id: docId };
    }

    // helpful flag when nothing new was added
    summary.alreadyPresent = summary.indexed === 0;

    res.status(200).json({ success: true, ...summary });
  } catch (err) {
    console.error('Indexer error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
};
