// prompts/loadNorthStar.js
const fs = require('fs');
const path = require('path');

let cached = null;

function getNorthStar() {
  if (cached !== null) return cached;

  try {
    const p = path.join(
      __dirname,
      '..',
      'docs',
      'northstar',
      'ChiefOS_MVP_North_Star_v2.txt' // ← updated name
    );

    cached = fs.readFileSync(p, 'utf8');
    return cached;
  } catch (err) {
    // Serverless-safe: never hard-fail
    console.warn('[NORTHSTAR] not loaded:', err?.message);
    cached = '';
    return '';
  }
}

module.exports = { getNorthStar };
