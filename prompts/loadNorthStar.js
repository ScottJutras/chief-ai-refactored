const fs = require('fs');
const path = require('path');

let cached = null;

function getNorthStar() {
  if (cached) return cached;

  const p = path.join(
    __dirname,
    '..',
    'docs',
    'northstar',
    'ChiefOS_MVP_NorthStar_v1.1.txt'
  );

  cached = fs.readFileSync(p, 'utf8');
  return cached;
}

module.exports = { getNorthStar };
