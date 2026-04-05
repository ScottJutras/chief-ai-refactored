'use strict';

// routes/catalog.js
// Supplier catalog API endpoints.
// Catalog data is shared reference — no tenant_id on reads.
// Tenant preferences are tenant-scoped.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const os = require('os');
const pg = require('../services/postgres');
const { requirePortalUser, withPlanKey } = require('../middleware/requirePortalUser');

const upload = multer({ dest: os.tmpdir() });

// All catalog endpoints require portal auth + plan resolution
router.use(requirePortalUser());
router.use(withPlanKey);

// Plan gate helper
function requireCatalogAccess(req, res, next) {
  const plan = req.planKey || 'free';
  if (plan === 'free') {
    return res.status(402).json({
      ok: false,
      error: {
        code: 'NOT_INCLUDED',
        message: 'Supplier catalog access requires a Starter or Pro plan.',
        hint: 'Upgrade to Starter to browse supplier catalogs.',
      },
    });
  }
  next();
}

function requirePro(req, res, next) {
  if (req.planKey !== 'pro') {
    return res.status(402).json({
      ok: false,
      error: {
        code: 'NOT_INCLUDED',
        message: 'This feature requires a Pro plan.',
        hint: 'Upgrade to Pro to unlock preferred suppliers and cross-supplier comparison.',
      },
    });
  }
  next();
}

// ─── Public Catalog Endpoints (authenticated, no tenant filter on reads) ──────

/**
 * GET /api/catalog/suppliers
 * List all active suppliers with product counts and freshness.
 */
router.get('/suppliers', requireCatalogAccess, async (req, res) => {
  try {
    const suppliers = await pg.listSuppliers();
    return res.json({ ok: true, suppliers });
  } catch (err) {
    console.error('[catalog/suppliers] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'QUERY_FAILED', message: 'Could not fetch suppliers.' } });
  }
});

/**
 * GET /api/catalog/suppliers/:slug
 * Get supplier detail + categories.
 */
router.get('/suppliers/:slug', requireCatalogAccess, async (req, res) => {
  const { slug } = req.params;
  try {
    const supplier = await pg.getSupplierBySlug(slug);
    if (!supplier) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Supplier not found.' } });
    }
    const categories = await pg.listSupplierCategories(supplier.id);
    return res.json({ ok: true, supplier, categories });
  } catch (err) {
    console.error('[catalog/suppliers/:slug] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'QUERY_FAILED', message: 'Could not fetch supplier.' } });
  }
});

/**
 * GET /api/catalog/suppliers/:slug/products
 * List products for a supplier. Supports ?q=search, ?category_id=uuid, ?limit, ?offset
 */
router.get('/suppliers/:slug/products', requireCatalogAccess, async (req, res) => {
  const { slug } = req.params;
  const { q, category_id, limit = '50', offset = '0' } = req.query;

  try {
    const supplier = await pg.getSupplierBySlug(slug);
    if (!supplier) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Supplier not found.' } });
    }

    const products = await pg.listCatalogProducts(supplier.id, {
      categoryId: category_id || null,
      search: q || null,
      limit: Math.min(Number(limit) || 50, 200),
      offset: Number(offset) || 0,
    });

    return res.json({ ok: true, supplier_slug: slug, products });
  } catch (err) {
    console.error('[catalog/products] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'QUERY_FAILED', message: 'Could not fetch products.' } });
  }
});

/**
 * GET /api/catalog/products/search?q=vinyl+siding
 * Cross-supplier full-text product search.
 */
router.get('/products/search', requireCatalogAccess, async (req, res) => {
  const { q, limit = '20' } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ ok: false, error: { code: 'MISSING_QUERY', message: 'Provide a search query with ?q=' } });
  }

  try {
    const products = await pg.searchAllCatalog(q, { limit: Math.min(Number(limit) || 20, 50) });
    return res.json({ ok: true, query: q, products });
  } catch (err) {
    console.error('[catalog/search] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'QUERY_FAILED', message: 'Search failed.' } });
  }
});

/**
 * GET /api/catalog/products/:id
 * Single product detail with price history.
 */
router.get('/products/:id', requireCatalogAccess, async (req, res) => {
  const { id } = req.params;
  try {
    const product = await pg.getCatalogProduct(id);
    if (!product) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Product not found.' } });
    }
    const priceHistory = await pg.getProductPriceHistory(id, 20);
    return res.json({ ok: true, product, price_history: priceHistory });
  } catch (err) {
    console.error('[catalog/products/:id] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'QUERY_FAILED', message: 'Could not fetch product.' } });
  }
});

// ─── Tenant-Scoped Preference Endpoints ──────────────────────────────────────

/**
 * GET /api/catalog/preferences
 * Get the authenticated tenant's supplier preferences.
 */
router.get('/preferences', requireCatalogAccess, async (req, res) => {
  const { tenantId } = req;
  if (!tenantId) {
    return res.status(400).json({ ok: false, error: { code: 'MISSING_TENANT', message: 'No tenant context.' } });
  }
  try {
    const preferences = await pg.getTenantSupplierPreferences(tenantId);
    return res.json({ ok: true, preferences });
  } catch (err) {
    console.error('[catalog/preferences] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'QUERY_FAILED', message: 'Could not fetch preferences.' } });
  }
});

/**
 * PUT /api/catalog/preferences/:supplier_id
 * Set or update a supplier preference for this tenant.
 * Setting preferred suppliers is Pro-only.
 */
router.put('/preferences/:supplier_id', requireCatalogAccess, async (req, res) => {
  const { tenantId, planKey } = req;
  const { supplier_id } = req.params;
  const { is_preferred, contractor_account_number, discount_percentage, notes } = req.body;

  if (!tenantId) {
    return res.status(400).json({ ok: false, error: { code: 'MISSING_TENANT', message: 'No tenant context.' } });
  }

  // Setting preferred suppliers is Pro-only
  if (is_preferred && planKey !== 'pro') {
    return res.status(402).json({
      ok: false,
      error: { code: 'NOT_INCLUDED', message: 'Setting preferred suppliers requires a Pro plan.' },
    });
  }

  try {
    const preference = await pg.upsertTenantSupplierPreference(tenantId, supplier_id, {
      is_preferred: !!is_preferred,
      contractor_account_number: contractor_account_number || null,
      discount_percentage: Number(discount_percentage) || 0,
      notes: notes || null,
    });
    return res.json({ ok: true, preference });
  } catch (err) {
    console.error('[catalog/preferences PUT] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'SAVE_FAILED', message: 'Could not save preference.' } });
  }
});

// ─── Admin Ingestion Endpoints ────────────────────────────────────────────────
// These are internal-only. In production, add admin auth middleware before deploying.
// For now, gated by a simple ADMIN_API_KEY check.

function requireAdminKey(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    // No admin key configured — block in production, allow in development
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin endpoints require ADMIN_API_KEY.' } });
    }
    return next();
  }
  const provided = req.headers['x-admin-key'] || req.query.admin_key;
  if (provided !== adminKey) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Invalid admin key.' } });
  }
  next();
}

/**
 * POST /api/catalog/admin/upload
 * Upload a supplier price list spreadsheet and trigger ingestion.
 * Body (multipart): supplier_slug, file (xlsx or csv)
 */
router.post('/admin/upload', requireAdminKey, upload.single('file'), async (req, res) => {
  const { supplier_slug } = req.body;

  if (!supplier_slug) {
    return res.status(400).json({ ok: false, error: { code: 'MISSING_SUPPLIER', message: 'Provide supplier_slug in the form body.' } });
  }

  if (!req.file) {
    return res.status(400).json({ ok: false, error: { code: 'MISSING_FILE', message: 'Attach a spreadsheet file (xlsx or csv).' } });
  }

  const allowedExts = ['.xlsx', '.xls', '.csv'];
  const ext = path.extname(req.file.originalname || '').toLowerCase();
  if (!allowedExts.includes(ext)) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_FILE_TYPE', message: 'File must be .xlsx, .xls, or .csv.' } });
  }

  try {
    const { runIngestion } = require('../services/catalogIngest');
    const result = await runIngestion(supplier_slug, req.file.path, 'spreadsheet_upload', req.file.originalname);
    return res.json(result);
  } catch (err) {
    console.error('[catalog/admin/upload] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'INGESTION_FAILED', message: err.message } });
  }
});

/**
 * GET /api/catalog/admin/ingestion-log
 * View ingestion history for a supplier.
 */
router.get('/admin/ingestion-log', requireAdminKey, async (req, res) => {
  const { supplier_slug } = req.query;
  try {
    let sql = `SELECT cil.*, s.slug AS supplier_slug, s.name AS supplier_name
               FROM public.catalog_ingestion_log cil
               JOIN public.suppliers s ON s.id = cil.supplier_id`;
    const params = [];

    if (supplier_slug) {
      params.push(supplier_slug);
      sql += ` WHERE s.slug = $${params.length}`;
    }

    sql += ` ORDER BY cil.created_at DESC LIMIT 50`;

    const { rows } = await pg.queryWithTimeout(sql, params, 5000);
    return res.json({ ok: true, log: rows });
  } catch (err) {
    console.error('[catalog/admin/ingestion-log] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'QUERY_FAILED', message: 'Could not fetch log.' } });
  }
});

/**
 * POST /api/catalog/admin/products/:id/deactivate
 * Manually deactivate (discontinue) a product.
 */
router.post('/admin/products/:id/deactivate', requireAdminKey, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pg.queryWithTimeout(
      `UPDATE public.catalog_products
       SET is_active = false, discontinued_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING id, sku, name`,
      [id],
      4000
    );
    if (!rows?.[0]) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Product not found.' } });
    }
    return res.json({ ok: true, deactivated: rows[0] });
  } catch (err) {
    console.error('[catalog/admin/deactivate] error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'UPDATE_FAILED', message: 'Could not deactivate product.' } });
  }
});

module.exports = router;
