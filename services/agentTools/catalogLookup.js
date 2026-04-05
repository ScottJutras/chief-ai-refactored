'use strict';

/**
 * Agent Tool: catalog_lookup
 * Search supplier product catalogs for materials and pricing.
 * Used by Ask Chief when the owner asks about material costs,
 * product availability, or wants to reference supplier data.
 *
 * Catalog is shared reference data — accessible to all paid plans.
 * Always includes price_effective_date and freshness disclaimer.
 */

const pg = require('../postgres');

const FRESHNESS_NOTES = {
  FRESH: null,
  AGING: 'Note: This pricing is approaching its scheduled refresh date — confirm with the supplier before finalizing a quote.',
  STALE: 'Note: This pricing is past its expected refresh date and may be outdated. Confirm with the supplier.',
  EXPIRED: 'Warning: This pricing has not been updated in a long time and may be significantly outdated. Contact the supplier for current pricing.',
  UNKNOWN: 'Note: Price effective date unknown — confirm current pricing with the supplier.',
};

function formatPrice(cents) {
  if (cents == null) return 'price unavailable';
  return `$${(cents / 100).toFixed(2)}`;
}

function formatProduct(p) {
  return {
    sku: p.sku,
    name: p.name,
    supplier: p.supplier_name || p.supplier_slug,
    price: formatPrice(p.unit_price_cents),
    price_cents: p.unit_price_cents,
    unit: p.unit_of_measure,
    category: p.category_name || null,
    price_as_of: p.price_effective_date || null,
    freshness: p.freshness || 'UNKNOWN',
    freshness_note: FRESHNESS_NOTES[p.freshness] || null,
    description: p.description || null,
  };
}

async function catalogLookup({ search_query, supplier_slug, limit }) {
  if (!search_query || !String(search_query).trim()) {
    return { error: 'search_query is required.' };
  }

  const maxResults = Math.min(Number(limit) || 10, 20);

  try {
    let products;

    if (supplier_slug && String(supplier_slug).trim()) {
      // Supplier-specific search
      const slug = String(supplier_slug).trim().toLowerCase();
      const supplier = await pg.getSupplierBySlug(slug);
      if (!supplier) {
        return { error: `Supplier "${slug}" not found. Available suppliers can be browsed in the Catalogs section.` };
      }

      const rows = await pg.listCatalogProducts(supplier.id, {
        search: search_query,
        limit: maxResults,
      });

      products = rows.map((p) => ({
        ...p,
        supplier_name: supplier.name,
        supplier_slug: supplier.slug,
        freshness: pg.getSupplierFreshnessState(p.price_effective_date, supplier.catalog_update_cadence),
      }));
    } else {
      // Cross-supplier search
      products = await pg.searchAllCatalog(search_query, { limit: maxResults });
    }

    if (!products.length) {
      const suppNote = supplier_slug ? ` from ${supplier_slug}` : '';
      return {
        results: [],
        summary: `No products found${suppNote} matching "${search_query}". Try broader search terms or browse the Catalogs section.`,
      };
    }

    const formatted = products.map(formatProduct);

    // Build a summary note about freshness
    const hasStale = formatted.some((p) => p.freshness === 'STALE' || p.freshness === 'EXPIRED');
    const freshnessSummary = hasStale
      ? 'Some pricing shown may be outdated — check the freshness note on each result.'
      : null;

    return {
      results: formatted,
      count: formatted.length,
      freshness_summary: freshnessSummary,
    };
  } catch (err) {
    console.error('[catalogLookup] error:', err.message);
    return { error: 'Catalog search temporarily unavailable. Try again in a moment.' };
  }
}

const catalogLookupTool = {
  type: 'function',
  function: {
    name: 'catalog_lookup',
    description: [
      'Search supplier product catalogs for materials and current pricing.',
      'Use when the owner asks about material prices, product availability, or wants to',
      'reference catalog pricing for quotes or expenses.',
      'Examples: "What does Gentek charge for vinyl siding?",',
      '"What are the J-channel options?", "Show me soffit panel pricing".',
      'Always reports the price effective date and flags stale pricing.',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['search_query'],
      properties: {
        search_query: {
          type: 'string',
          description: 'Product search terms (e.g., "vinyl siding", "J-channel", "soffit panels")',
        },
        supplier_slug: {
          type: 'string',
          description: 'Supplier identifier to scope search (e.g., "gentek", "kaycan"). Omit to search all suppliers.',
        },
        limit: {
          type: 'integer',
          description: 'Max results to return (default 10, max 20)',
        },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await catalogLookup({
        search_query: args.search_query ? String(args.search_query).trim() : '',
        supplier_slug: args.supplier_slug ? String(args.supplier_slug).trim() : null,
        limit: args.limit,
      });
    } catch (err) {
      return { error: `catalog_lookup failed: ${err?.message}` };
    }
  },
};

module.exports = { catalogLookupTool, catalogLookup };
