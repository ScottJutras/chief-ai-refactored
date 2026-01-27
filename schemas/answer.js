'use strict';

/**
 * Brain v0 Answer Contract
 *
 * Always return:
 * {
 *   answer: string,
 *   evidence: [{ type, id, date, amount_cents, source, job_id?, job_name? }],
 *   missing: string[],
 *   confidence: 'low'|'med'|'high'
 * }
 */

function normalizeEvidenceItem(x = {}) {
  const type = String(x.type || 'transaction');
  const id = Number(x.id);
  const date = x.date ? String(x.date) : null;
  const amount_cents = Number(x.amount_cents ?? 0) || 0;
  const source = x.source != null ? String(x.source) : null;

  const out = { type, id, date, amount_cents, source };

  if (x.job_id != null) out.job_id = String(x.job_id);
  if (x.job_name != null) out.job_name = String(x.job_name);

  return out;
}

function ensureAnswerContract(raw = {}) {
  const answer = String(raw.answer || raw.text || '').trim() || 'I don’t have enough confirmed data to answer that yet.';
  const missing = Array.isArray(raw.missing) ? raw.missing.map((s) => String(s)).filter(Boolean) : [];
  const confidenceRaw = String(raw.confidence || 'low').toLowerCase();
  const confidence = confidenceRaw === 'high' || confidenceRaw === 'med' || confidenceRaw === 'low'
    ? confidenceRaw
    : 'low';

  const evidenceIn = Array.isArray(raw.evidence) ? raw.evidence : [];
  const evidence = evidenceIn
    .map(normalizeEvidenceItem)
    .filter((e) => Number.isFinite(e.id));

  return { answer, evidence, missing, confidence };
}

module.exports = {
  ensureAnswerContract
};
