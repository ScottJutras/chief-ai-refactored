// scripts/ingestRAG.js
require('dotenv').config({ path: './config/.env' });   // <<< add
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { query } = require('../services/postgres');

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error(`[RAG] file not found: ${file}`);
    process.exit(1);
  }
  try {
    const csv = fs.readFileSync(file, 'utf8');
    const rows = parse(csv, { columns: true, skip_empty_lines: true });
    console.log('[RAG] rows:', rows.length);

    if (!rows.length) { console.log('[RAG] nothing to ingest'); process.exit(0); }

    const values = [];
    const params = [];
    let p = 1;
    for (const r of rows) {
      params.push(r.Term, r['Meaning (contractor)'] || r.Meaning || null, r['CFO Equivalent'] || r.cfo_map || null, r['Suggested Insight Nudge'] || r.nudge || null, 'contractor_terms.csv');
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++})`);
    }

    await query(
      `INSERT INTO public.rag_terms (term, meaning, cfo_map, nudge, source)
       VALUES ${values.join(',')}
       ON CONFLICT (id) DO NOTHING`,
      params
    );

    console.log('[RAG] ok');
    process.exit(0);
  } catch (e) {
    console.error('[RAG] failed:', e.message);
    process.exit(1);
  }
})();
