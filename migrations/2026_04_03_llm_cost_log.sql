-- Migration: LLM cost log table
-- Run in Supabase SQL Editor (or direct postgres)
-- Tracks per-request LLM usage for cost dashboard and provider analysis.

CREATE TABLE IF NOT EXISTS public.llm_cost_log (
  id                  bigserial   PRIMARY KEY,
  owner_id            text,                          -- owner_id (digits string); NULL = system/background call
  query_kind          text,                          -- 'financial_analysis' | 'structured_task' | 'portal_chat' | etc.
  provider            text        NOT NULL,          -- 'openai' | 'anthropic'
  model               text        NOT NULL,          -- exact model string (e.g. 'claude-sonnet-4-6', 'gpt-4o-mini')
  input_tokens        integer     NOT NULL DEFAULT 0,
  output_tokens       integer     NOT NULL DEFAULT 0,
  cache_read_tokens   integer     NOT NULL DEFAULT 0,
  cache_write_tokens  integer     NOT NULL DEFAULT 0,
  latency_ms          integer     NOT NULL DEFAULT 0,
  cost_usd            numeric(12,7) NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Index for cost dashboard queries
CREATE INDEX IF NOT EXISTS llm_cost_log_owner_created_idx
  ON public.llm_cost_log (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS llm_cost_log_provider_created_idx
  ON public.llm_cost_log (provider, created_at DESC);

-- Helpful view: daily cost summary by owner + provider
CREATE OR REPLACE VIEW public.llm_cost_daily AS
SELECT
  owner_id,
  provider,
  model,
  query_kind,
  date_trunc('day', created_at) AS day,
  COUNT(*)                       AS requests,
  SUM(input_tokens)              AS total_input_tokens,
  SUM(output_tokens)             AS total_output_tokens,
  SUM(cache_read_tokens)         AS total_cache_hits,
  SUM(latency_ms)                AS total_latency_ms,
  ROUND(AVG(latency_ms))         AS avg_latency_ms,
  SUM(cost_usd)                  AS total_cost_usd
FROM public.llm_cost_log
GROUP BY 1,2,3,4,5
ORDER BY day DESC, total_cost_usd DESC;
