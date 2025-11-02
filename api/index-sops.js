// api/index-sops.js
import { searchRag } from '../services/tools/rag.js';
import { ragTool } from '../services/tools/rag.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    // Re-use your existing chunking logic
    const fs = require('fs');
    const path = require('path');
    const OpenAI = require('openai');
    const { Pool } = require('pg');

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    const sops = [
      { file: 'docs/howto/jobs.md', title: 'Jobs SOP' },
      { file: 'docs/howto/tasks.md', title: 'Tasks SOP' },
      { file: 'docs/howto/timeclock.md', title: 'Timeclock SOP' },
      { file: 'docs/howto/shared_contracts.md', title: 'Shared Contracts' },
    ];

    let indexed = 0;
    for (const { file, title } of sops) {
      const fullPath = path.join(process.cwd(), file);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const chunks = content.match(/[\s\S]{1,1000}/g) || [];

      for (const chunk of chunks) {
        const e = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: chunk,
        });
        await pool.query(
          `INSERT INTO doc_chunks (owner_id, doc_id, content, embedding)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          ['GLOBAL', title, chunk, e.data[0].embedding]
        );
        indexed++;
      }
    }

    res.status(200).json({ success: true, indexed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}