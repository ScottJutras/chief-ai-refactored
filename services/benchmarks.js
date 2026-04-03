'use strict';

/**
 * services/benchmarks.js
 * Phase 3.4 — Opinionated Industry Benchmarks
 *
 * Static benchmark data for common Canadian/US contractor trades.
 * Sources: CIBC Small Business, Statistics Canada, NAHB, CFMA.
 */

const BENCHMARKS = {
  general_contractor: {
    label: 'General Contractor',
    gross_margin_pct:         { p25: 18, median: 28, p75: 38 },
    labour_pct_of_revenue:    { p25: 30, median: 40, p75: 52 },
    materials_pct_of_revenue: { p25: 25, median: 35, p75: 45 },
    overhead_pct_of_revenue:  { p25: 8,  median: 12, p75: 18 },
  },
  electrician: {
    label: 'Electrician',
    gross_margin_pct:         { p25: 22, median: 35, p75: 48 },
    labour_pct_of_revenue:    { p25: 35, median: 48, p75: 60 },
    materials_pct_of_revenue: { p25: 15, median: 22, p75: 30 },
    overhead_pct_of_revenue:  { p25: 8,  median: 13, p75: 20 },
  },
  plumber: {
    label: 'Plumber',
    gross_margin_pct:         { p25: 20, median: 32, p75: 44 },
    labour_pct_of_revenue:    { p25: 32, median: 44, p75: 56 },
    materials_pct_of_revenue: { p25: 18, median: 26, p75: 36 },
    overhead_pct_of_revenue:  { p25: 8,  median: 12, p75: 18 },
  },
  painter: {
    label: 'Painter',
    gross_margin_pct:         { p25: 25, median: 38, p75: 50 },
    labour_pct_of_revenue:    { p25: 40, median: 52, p75: 64 },
    materials_pct_of_revenue: { p25: 10, median: 18, p75: 26 },
    overhead_pct_of_revenue:  { p25: 5,  median: 10, p75: 15 },
  },
  hvac: {
    label: 'HVAC',
    gross_margin_pct:         { p25: 22, median: 34, p75: 46 },
    labour_pct_of_revenue:    { p25: 30, median: 42, p75: 54 },
    materials_pct_of_revenue: { p25: 22, median: 30, p75: 40 },
    overhead_pct_of_revenue:  { p25: 8,  median: 14, p75: 20 },
  },
  roofer: {
    label: 'Roofer',
    gross_margin_pct:         { p25: 20, median: 30, p75: 42 },
    labour_pct_of_revenue:    { p25: 28, median: 38, p75: 50 },
    materials_pct_of_revenue: { p25: 25, median: 34, p75: 44 },
    overhead_pct_of_revenue:  { p25: 8,  median: 12, p75: 18 },
  },
  landscaper: {
    label: 'Landscaper',
    gross_margin_pct:         { p25: 22, median: 34, p75: 46 },
    labour_pct_of_revenue:    { p25: 38, median: 50, p75: 62 },
    materials_pct_of_revenue: { p25: 15, median: 22, p75: 32 },
    overhead_pct_of_revenue:  { p25: 6,  median: 10, p75: 16 },
  },
  mason: {
    label: 'Mason / Concrete',
    gross_margin_pct:         { p25: 18, median: 28, p75: 40 },
    labour_pct_of_revenue:    { p25: 35, median: 48, p75: 60 },
    materials_pct_of_revenue: { p25: 20, median: 28, p75: 38 },
    overhead_pct_of_revenue:  { p25: 7,  median: 12, p75: 18 },
  },
};

const DEFAULT_TRADE = 'general_contractor';

function getBenchmarks(tradeKey) {
  const key = String(tradeKey || '').toLowerCase().replace(/\s+/g, '_');
  return BENCHMARKS[key] || BENCHMARKS[DEFAULT_TRADE];
}

function rateMetric(metricKey, value, tradeKey) {
  const bench = getBenchmarks(tradeKey);
  const data  = bench[metricKey];
  if (!data || value == null) return null;

  const { p25, median, p75 } = data;
  const label = bench.label;

  if (value >= p75) {
    return { rating: 'above', message: `${value}% is above the top quartile for ${label} (industry top: ${p75}%)`, benchmark: data };
  }
  if (value >= median) {
    return { rating: 'median', message: `${value}% is above the median for ${label} (median: ${median}%)`, benchmark: data };
  }
  if (value >= p25) {
    return { rating: 'below', message: `${value}% is below the median for ${label} (median: ${median}%, bottom quartile: ${p25}%)`, benchmark: data };
  }
  return { rating: 'concern', message: `${value}% is below the bottom quartile for ${label} (industry bottom: ${p25}%). This warrants attention.`, benchmark: data };
}

function enrichWithBenchmarks(metrics, tradeKey) {
  const result = {};
  if (metrics.margin_pct != null)    result.margin    = rateMetric('gross_margin_pct', metrics.margin_pct, tradeKey);
  if (metrics.labour_pct != null)    result.labour    = rateMetric('labour_pct_of_revenue', metrics.labour_pct, tradeKey);
  if (metrics.materials_pct != null) result.materials = rateMetric('materials_pct_of_revenue', metrics.materials_pct, tradeKey);
  return result;
}

function normaliseTrade(rawTrade) {
  const t = String(rawTrade || '').toLowerCase().trim();
  if (/electric/.test(t)) return 'electrician';
  if (/plumb/.test(t))    return 'plumber';
  if (/paint/.test(t))    return 'painter';
  if (/hvac|heat|cool|air/.test(t)) return 'hvac';
  if (/roof/.test(t))     return 'roofer';
  if (/landscape|lawn|garden/.test(t)) return 'landscaper';
  if (/mason|concrete|brick|stone/.test(t)) return 'mason';
  return DEFAULT_TRADE;
}

module.exports = { BENCHMARKS, getBenchmarks, rateMetric, enrichWithBenchmarks, normaliseTrade, DEFAULT_TRADE };
