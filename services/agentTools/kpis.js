// services/agentTools/kpis.js
const { getCompanyKpis, KPI_DEFINITIONS } = require('../kpis');

/**
 * Tool: get_company_kpis
 * input: { window?: "MTD" | "YTD" | "ALL" }
 * (window is currently ignored; metrics are "all time" based on views)
 */
async function get_company_kpis({ ownerId, window = 'ALL' }) {
  const { metrics } = await getCompanyKpis({ ownerId });

  // Flatten into an array of { code, label, category, unit, value }
  const result = Object.keys(KPI_DEFINITIONS).map((code) => {
    const def = KPI_DEFINITIONS[code];
    return {
      code,
      label: def.label,
      category: def.category,
      unit: def.unit,
      value: metrics[code] ?? null,
    };
  });

  return {
    ok: true,
    window,
    metrics: result,
  };
}

module.exports = { get_company_kpis };
