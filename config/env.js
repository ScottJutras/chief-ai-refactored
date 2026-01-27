// config/env.js
// Deterministic environment loader for Chief AI
// Goal:
// - Default to shared config (.env) for consistency (Supabase/prod-like)
// - Only load .env.local when you explicitly opt-in via USE_LOCAL_DB=true
// - Log what happened so debugging is never ambiguous

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

function loadEnvFile(p, opts = {}) {
  if (!fs.existsSync(p)) return { loaded: false };
  const r = dotenv.config({ path: p, override: !!opts.override });
  return { loaded: true, error: r.error || null };
}

const sharedPath = path.join(__dirname, '.env');
const localPath = path.join(__dirname, '.env.local');

// 1) Load shared first (default truth)
const shared = loadEnvFile(sharedPath, { override: false });

// 2) Load local ONLY if explicitly enabled
const useLocal =
  String(process.env.USE_LOCAL_DB || '').trim().toLowerCase() === 'true' ||
  String(process.env.USE_LOCAL_DB || '').trim() === '1';

const local = useLocal ? loadEnvFile(localPath, { override: true }) : { loaded: false };

const dbSet = !!process.env.DATABASE_URL;

console.log(
  `[ENV] loaded shared=${!!shared.loaded} local=${!!local.loaded} (USE_LOCAL_DB=${useLocal ? 'true' : 'false'}) (DATABASE_URL=${dbSet ? 'set' : 'missing'})`
);
