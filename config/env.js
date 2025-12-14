// config/env.js
// Centralized environment loader for Chief AI

const path = require('path');
const dotenv = require('dotenv');

// 1. Load LOCAL override first (if it exists)
//    Used for Docker Postgres, dev-only, never committed.
dotenv.config({ path: path.join(__dirname, '.env.local') });

// 2. Load default shared config (e.g., Supabase for prod)
dotenv.config({ path: path.join(__dirname, '.env') });
