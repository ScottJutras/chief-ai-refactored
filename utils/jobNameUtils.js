function normalizeJobNameCandidate(s) {
  const out = String(s || '')
    .trim()
    .replace(/^(job|job\s*name)\s*[:\-]?\s*/i, '') // supports "job name: X" too
    .replace(/\bjob\b$/i, '')                     // "Oak Street job"
    .replace(/^the\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return out || null;
}

module.exports = { normalizeJobNameCandidate };

