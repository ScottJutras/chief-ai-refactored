// services/llm/costLogger.js
// Per-request LLM cost logging for ChiefOS.
//
// Every LLM call logs: provider, model, tokens, cache hits, latency, estimated cost.
// Writes to:
//   1. Console (always) — visible in Vercel logs
//   2. public.llm_cost_log table (async, fire-and-forget) — for cost dashboard
//
// The DB write never blocks the response. If the table doesn't exist yet,
// the write silently fails until the migration is applied.

let pg = null;
try {
  pg = require('../postgres');
} catch {
  // postgres not available in test environments
}

/**
 * logLLMCost({ ownerId, queryKind, meta })
 *
 * @param {string} ownerId   - owner_id (digits string, matches ingestion boundary)
 * @param {string} queryKind - human label: 'financial_analysis' | 'structured_task' | 'portal_chat' | etc.
 * @param {object} meta      - _meta object from provider.chat()
 */
function logLLMCost({ ownerId, queryKind, meta } = {}) {
  if (!meta) return;

  const {
    provider     = 'unknown',
    model        = 'unknown',
    inputTokens  = 0,
    outputTokens = 0,
    cacheHits    = 0,
    cacheWriteTokens = 0,
    latencyMs    = 0,
    costUsd      = 0,
  } = meta;

  // 1) Console log — always
  console.info('[LLM_COST]', JSON.stringify({
    ownerId:     ownerId || null,
    queryKind:   queryKind || null,
    provider,
    model,
    inputTokens,
    outputTokens,
    cacheHits,
    cacheWriteTokens,
    latencyMs,
    costUsd:     Number(costUsd.toFixed(7)),
  }));

  // 2) DB write — async, fire-and-forget
  if (!pg?.query) return;

  setImmediate(async () => {
    try {
      await pg.query(
        `INSERT INTO public.llm_cost_log
           (owner_id, query_kind, provider, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, latency_ms, cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          ownerId   || null,
          queryKind || null,
          provider,
          model,
          inputTokens,
          outputTokens,
          cacheHits,
          cacheWriteTokens || 0,
          latencyMs,
          Number(costUsd.toFixed(7)),
        ]
      );
    } catch {
      // Table may not exist yet — suppress until migration applied
    }
  });
}

/**
 * logFallbackEvent({ ownerId, fromProvider, toProvider, reason, queryKind })
 * Logs whenever the router falls back from one provider to another.
 */
function logFallbackEvent({ ownerId, fromProvider, toProvider, reason, queryKind } = {}) {
  console.warn('[LLM_FALLBACK]', JSON.stringify({
    ownerId: ownerId || null,
    queryKind,
    fromProvider,
    toProvider,
    reason,
    ts: new Date().toISOString(),
  }));
}

module.exports = { logLLMCost, logFallbackEvent };
