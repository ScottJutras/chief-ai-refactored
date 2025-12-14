// scripts/runSql.js
require('dotenv').config({ path: './config/.env' });   // <<< add
const fs = require('fs');
const { query } = require('../services/postgres');

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error(`[SQL] failed: file not found: ${file}`);
    process.exit(1);
  }
  try {
    const sql = fs.readFileSync(file, 'utf8');
    await query(sql);
    console.log('[SQL] ok');
    process.exit(0);
  } catch (e) {
    console.error('[SQL] failed:', e.message);
    process.exit(1);
  }
})();
