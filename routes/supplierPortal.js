'use strict';

// routes/supplierPortal.js
// Supplier self-service portal API.
// Public: POST /api/supplier/signup
// Authenticated (supplier JWT): all /api/supplier/* routes
// Admin (CHIEFOS_ADMIN_EMAIL): /api/admin/suppliers/*

const express = require('express');
const router = express.Router();
const multer = require('multer');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const pg = require('../services/postgres');
const { requireSupplierUser, requireSupplierRole } = require('../middleware/requireSupplierUser');

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 20 * 1024 * 1024 } });

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false } });
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Admin auth check ─────────────────────────────────────────────────────────

function requireChiefOSAdmin(req, res, next) {
  const adminEmail = process.env.CHIEFOS_ADMIN_EMAIL;
  if (!adminEmail) {
    return res.status(403).json({ ok: false, error: 'ADMIN_NOT_CONFIGURED', message: 'Admin email not configured.' });
  }
  // Admin endpoints use supplier Bearer token too — just verify email matches
  // We re-use the Supabase service role to verify the token and get email
  const raw = req.get('authorization') || '';
  const m = raw.match(/^bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : null;
  if (!token) return res.status(401).json({ ok: false, error: 'missing_bearer' });

  supabaseAdmin().auth.getUser(token).then(({ data }) => {
    const email = data?.user?.email || '';
    if (email.toLowerCase() !== adminEmail.toLowerCase()) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Admin access required.' });
    }
    req.adminEmail = email;
    next();
  }).catch(() => res.status(401).json({ ok: false, error: 'invalid_session' }));
}

// ─── PUBLIC: Supplier signup ──────────────────────────────────────────────────

router.post('/signup', express.json(), async (req, res) => {
  const {
    company_name, supplier_type = 'manufacturer', region = 'canada',
    contact_name, email, phone, address, description, password,
  } = req.body || {};

  if (!company_name?.trim()) return res.status(400).json({ ok: false, error: 'MISSING_FIELD', message: 'Company name is required.' });
  if (!email?.trim()) return res.status(400).json({ ok: false, error: 'MISSING_FIELD', message: 'Email is required.' });
  if (!password || password.length < 8) return res.status(400).json({ ok: false, error: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters.' });
  if (!contact_name?.trim()) return res.status(400).json({ ok: false, error: 'MISSING_FIELD', message: 'Contact name is required.' });

  try {
    const sb = supabaseAdmin();

    // Check for existing supplier user with this email
    const { rows: existing } = await pg.query(
      `SELECT id FROM public.supplier_users WHERE email = $1 LIMIT 1`,
      [email.trim().toLowerCase()]
    );
    if (existing.length > 0) {
      return res.status(409).json({ ok: false, error: 'EMAIL_EXISTS', message: 'A supplier account with this email already exists.' });
    }

    // Create Supabase auth user
    const { data: authData, error: authErr } = await sb.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: false,
      user_metadata: { user_type: 'supplier', full_name: contact_name.trim() },
    });

    if (authErr || !authData?.user?.id) {
      const msg = authErr?.message || 'Could not create account.';
      return res.status(400).json({ ok: false, error: 'AUTH_CREATE_FAILED', message: msg });
    }

    const authUid = authData.user.id;
    const baseSlug = slugify(company_name);

    // Generate unique slug
    let slug = baseSlug;
    let attempt = 0;
    while (true) {
      const { rows: slugCheck } = await pg.query(
        `SELECT id FROM public.suppliers WHERE slug = $1 LIMIT 1`, [slug]
      );
      if (slugCheck.length === 0) break;
      attempt++;
      slug = `${baseSlug}-${attempt}`;
    }

    // Create supplier org row
    const { rows: supRows } = await pg.query(
      `INSERT INTO public.suppliers
         (slug, name, description, public_description, status, supplier_type, region,
          primary_contact_name, primary_contact_email, primary_contact_phone,
          company_address, catalog_update_cadence, is_active, onboarding_completed)
       VALUES ($1,$2,$3,$4,'pending_review',$5,$6,$7,$8,$9,$10,'quarterly',false,false)
       RETURNING id, slug, name, status`,
      [slug, company_name.trim(), description?.trim() || null, description?.trim() || null,
       supplier_type, region, contact_name.trim(), email.trim().toLowerCase(),
       phone?.trim() || null, address?.trim() || null]
    );
    const supplier = supRows[0];

    // Create supplier_users row
    await pg.query(
      `INSERT INTO public.supplier_users (auth_uid, supplier_id, email, full_name, role)
       VALUES ($1, $2, $3, $4, 'owner')`,
      [authUid, supplier.id, email.trim().toLowerCase(), contact_name.trim()]
    );

    // Notify admin (fire-and-forget)
    try {
      const adminEmail = process.env.CHIEFOS_ADMIN_EMAIL;
      if (adminEmail) {
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');
        await sgMail.send({
          to: adminEmail,
          from: process.env.SENDGRID_FROM_EMAIL || 'noreply@usechiefos.com',
          subject: `New supplier signup: ${company_name}`,
          text: `${contact_name} (${email}) signed up as a supplier.\nCompany: ${company_name}\nType: ${supplier_type}\nRegion: ${region}\n\nReview at: ${process.env.APP_BASE_URL || 'https://app.usechiefos.com'}/app/admin/suppliers`,
        });
      }
    } catch (e) {
      console.warn('[supplier/signup] admin notify failed:', e?.message);
    }

    return res.status(201).json({
      ok: true,
      supplier_id: supplier.id,
      slug: supplier.slug,
      status: supplier.status,
      message: 'Account created. Check your email to verify, then sign in.',
    });
  } catch (err) {
    console.error('[supplier/signup] error:', err.message);
    return res.status(500).json({ ok: false, error: 'SIGNUP_FAILED', message: 'Signup failed. Please try again.' });
  }
});

// ─── All routes below require supplier auth ───────────────────────────────────

router.use(requireSupplierUser());

// GET /api/supplier/me
router.get('/me', async (req, res) => {
  const { supplier, supplierUser } = req;
  return res.json({
    ok: true,
    user: {
      id: supplierUser.id,
      email: supplierUser.email,
      full_name: supplierUser.full_name,
      role: supplierUser.role,
    },
    supplier: {
      id: supplier.id,
      slug: supplier.slug,
      name: supplier.name,
      status: supplier.status,
      supplier_type: supplier.supplier_type,
      region: supplier.region,
      onboarding_completed: supplier.onboarding_completed,
      primary_contact_name: supplier.primary_contact_name,
      website_url: supplier.website_url,
    },
  });
});

// GET /api/supplier/products
router.get('/products', async (req, res) => {
  const { q, category_id, limit = '50', offset = '0', include_inactive } = req.query;
  try {
    const lim = Math.min(Number(limit) || 50, 200);
    const off = Number(offset) || 0;
    const showInactive = include_inactive === 'true';

    let sql = `
      SELECT cp.id, cp.sku, cp.name, cp.description, cp.unit_of_measure,
             cp.unit_price_cents, cp.price_type, cp.price_effective_date,
             cp.min_order_quantity, cp.is_active, cp.discontinued_at,
             cp.updated_at, cp.metadata,
             sc.id AS category_id, sc.name AS category_name
      FROM public.catalog_products cp
      LEFT JOIN public.supplier_categories sc ON sc.id = cp.category_id
      WHERE cp.supplier_id = $1
    `;
    const params = [req.supplierId];
    let p = 2;

    if (!showInactive) { sql += ` AND cp.is_active = true`; }
    if (category_id) { sql += ` AND cp.category_id = $${p++}`; params.push(category_id); }
    if (q?.trim()) {
      sql += ` AND to_tsvector('english', cp.name || ' ' || COALESCE(cp.description,'')) @@ plainto_tsquery('english', $${p++})`;
      params.push(q.trim());
    }

    sql += ` ORDER BY sc.name NULLS LAST, cp.name LIMIT $${p++} OFFSET $${p++}`;
    params.push(lim, off);

    const { rows } = await pg.queryWithTimeout(sql, params, 5000);

    // Count total
    let countSql = `SELECT COUNT(*) FROM public.catalog_products WHERE supplier_id = $1`;
    if (!showInactive) countSql += ` AND is_active = true`;
    const { rows: countRows } = await pg.queryWithTimeout(countSql, [req.supplierId], 3000);
    const total = Number(countRows[0]?.count || 0);

    return res.json({ ok: true, products: rows, total, limit: lim, offset: off });
  } catch (err) {
    console.error('[supplier/products GET]', err.message);
    return res.status(500).json({ ok: false, error: 'QUERY_FAILED', message: 'Could not fetch products.' });
  }
});

// POST /api/supplier/products
router.post('/products', express.json(), async (req, res) => {
  const { sku, name, description, category_id, unit_of_measure, unit_price_cents,
          price_type = 'list', price_effective_date, min_order_quantity = 1, metadata } = req.body || {};

  if (!sku?.trim()) return res.status(400).json({ ok: false, error: 'MISSING_SKU' });
  if (!name?.trim()) return res.status(400).json({ ok: false, error: 'MISSING_NAME' });
  if (!unit_of_measure?.trim()) return res.status(400).json({ ok: false, error: 'MISSING_UOM' });
  if (!unit_price_cents || unit_price_cents <= 0) return res.status(400).json({ ok: false, error: 'INVALID_PRICE', message: 'Price must be greater than zero.' });

  try {
    const effectiveDate = price_effective_date || new Date().toISOString().slice(0, 10);

    const { rows } = await pg.queryWithTimeout(
      `INSERT INTO public.catalog_products
         (supplier_id, category_id, sku, name, description, unit_of_measure,
          unit_price_cents, price_type, price_effective_date, min_order_quantity, metadata, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
       RETURNING *`,
      [req.supplierId, category_id || null, sku.trim(), name.trim(),
       description?.trim() || null, unit_of_measure.trim(),
       unit_price_cents, price_type, effectiveDate,
       min_order_quantity, metadata ? JSON.stringify(metadata) : null],
      5000
    );

    // Record initial price history
    await pg.queryWithTimeout(
      `INSERT INTO public.catalog_price_history
         (product_id, supplier_id, old_price_cents, new_price_cents, price_type, effective_date, change_source)
       VALUES ($1,$2,null,$3,$4,$5,'manual_add')`,
      [rows[0].id, req.supplierId, unit_price_cents, price_type, effectiveDate],
      3000
    ).catch(() => {});

    return res.status(201).json({ ok: true, product: rows[0] });
  } catch (err) {
    if (err.message?.includes('unique') || err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'SKU_EXISTS', message: `SKU "${sku}" already exists for this supplier.` });
    }
    console.error('[supplier/products POST]', err.message);
    return res.status(500).json({ ok: false, error: 'CREATE_FAILED', message: 'Could not create product.' });
  }
});

// PUT /api/supplier/products/:id
router.put('/products/:id', express.json(), async (req, res) => {
  const { id } = req.params;
  const { name, description, category_id, unit_of_measure, unit_price_cents,
          price_type, price_effective_date, min_order_quantity, metadata, is_active } = req.body || {};

  try {
    // Verify ownership
    const { rows: existing } = await pg.queryWithTimeout(
      `SELECT id, unit_price_cents, price_type FROM public.catalog_products
       WHERE id = $1 AND supplier_id = $2 LIMIT 1`,
      [id, req.supplierId], 3000
    );
    if (!existing[0]) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const prev = existing[0];
    const newPrice = unit_price_cents != null ? Number(unit_price_cents) : prev.unit_price_cents;
    const effectiveDate = price_effective_date || new Date().toISOString().slice(0, 10);

    const { rows } = await pg.queryWithTimeout(
      `UPDATE public.catalog_products SET
         name = COALESCE($3, name),
         description = COALESCE($4, description),
         category_id = COALESCE($5, category_id),
         unit_of_measure = COALESCE($6, unit_of_measure),
         unit_price_cents = $7,
         price_type = COALESCE($8, price_type),
         price_effective_date = $9,
         min_order_quantity = COALESCE($10, min_order_quantity),
         metadata = COALESCE($11::jsonb, metadata),
         is_active = COALESCE($12, is_active),
         discontinued_at = CASE WHEN $12 = false THEN now() WHEN $12 = true THEN null ELSE discontinued_at END,
         updated_at = now()
       WHERE id = $1 AND supplier_id = $2
       RETURNING *`,
      [id, req.supplierId, name || null, description || null, category_id || null,
       unit_of_measure || null, newPrice, price_type || null, effectiveDate,
       min_order_quantity || null,
       metadata ? JSON.stringify(metadata) : null,
       is_active != null ? is_active : null],
      5000
    );

    // Record price history if price changed
    if (newPrice !== prev.unit_price_cents) {
      await pg.queryWithTimeout(
        `INSERT INTO public.catalog_price_history
           (product_id, supplier_id, old_price_cents, new_price_cents, price_type, effective_date, change_source)
         VALUES ($1,$2,$3,$4,$5,$6,'manual_edit')`,
        [id, req.supplierId, prev.unit_price_cents, newPrice,
         price_type || prev.price_type, effectiveDate],
        3000
      ).catch(() => {});
    }

    return res.json({ ok: true, product: rows[0] });
  } catch (err) {
    console.error('[supplier/products PUT]', err.message);
    return res.status(500).json({ ok: false, error: 'UPDATE_FAILED', message: 'Could not update product.' });
  }
});

// DELETE /api/supplier/products/:id  (soft deactivate)
router.delete('/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pg.queryWithTimeout(
      `UPDATE public.catalog_products
       SET is_active = false, discontinued_at = now(), updated_at = now()
       WHERE id = $1 AND supplier_id = $2
       RETURNING id, sku, name`,
      [id, req.supplierId], 4000
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, deactivated: rows[0] });
  } catch (err) {
    console.error('[supplier/products DELETE]', err.message);
    return res.status(500).json({ ok: false, error: 'DELETE_FAILED' });
  }
});

// GET /api/supplier/categories
router.get('/categories', async (req, res) => {
  try {
    const { rows } = await pg.queryWithTimeout(
      `SELECT sc.id, sc.name, sc.slug, sc.sort_order, sc.parent_category_id, sc.is_active,
              COUNT(cp.id) FILTER (WHERE cp.is_active = true) AS product_count
       FROM public.supplier_categories sc
       LEFT JOIN public.catalog_products cp ON cp.category_id = sc.id AND cp.supplier_id = sc.supplier_id
       WHERE sc.supplier_id = $1
       GROUP BY sc.id
       ORDER BY sc.sort_order, sc.name`,
      [req.supplierId], 5000
    );
    return res.json({ ok: true, categories: rows });
  } catch (err) {
    console.error('[supplier/categories GET]', err.message);
    return res.status(500).json({ ok: false, error: 'QUERY_FAILED' });
  }
});

// POST /api/supplier/categories
router.post('/categories', express.json(), async (req, res) => {
  const { name, parent_category_id, sort_order = 0 } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ ok: false, error: 'MISSING_NAME' });

  const slug = slugify(name) || `cat-${Date.now()}`;
  try {
    const { rows } = await pg.queryWithTimeout(
      `INSERT INTO public.supplier_categories
         (supplier_id, name, slug, sort_order, parent_category_id, is_active)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order
       RETURNING *`,
      [req.supplierId, name.trim(), slug, sort_order, parent_category_id || null],
      4000
    );
    return res.status(201).json({ ok: true, category: rows[0] });
  } catch (err) {
    console.error('[supplier/categories POST]', err.message);
    return res.status(500).json({ ok: false, error: 'CREATE_FAILED' });
  }
});

// PUT /api/supplier/categories/:id
router.put('/categories/:id', express.json(), async (req, res) => {
  const { id } = req.params;
  const { name, sort_order, parent_category_id } = req.body || {};
  try {
    const newSlug = name ? slugify(name) : null;
    const { rows } = await pg.queryWithTimeout(
      `UPDATE public.supplier_categories SET
         name = COALESCE($3, name),
         slug = COALESCE($4, slug),
         sort_order = COALESCE($5, sort_order),
         parent_category_id = COALESCE($6, parent_category_id),
         updated_at = now()
       WHERE id = $1 AND supplier_id = $2
       RETURNING *`,
      [id, req.supplierId, name || null, newSlug, sort_order ?? null, parent_category_id || null],
      4000
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, category: rows[0] });
  } catch (err) {
    console.error('[supplier/categories PUT]', err.message);
    return res.status(500).json({ ok: false, error: 'UPDATE_FAILED' });
  }
});

// DELETE /api/supplier/categories/:id
router.delete('/categories/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: productCheck } = await pg.queryWithTimeout(
      `SELECT COUNT(*) FROM public.catalog_products WHERE category_id = $1 AND is_active = true`,
      [id], 3000
    );
    if (Number(productCheck[0]?.count) > 0) {
      return res.status(400).json({
        ok: false, error: 'HAS_PRODUCTS',
        message: 'Cannot delete a category that has active products. Reassign products first.',
      });
    }
    const { rows } = await pg.queryWithTimeout(
      `DELETE FROM public.supplier_categories WHERE id = $1 AND supplier_id = $2 RETURNING id, name`,
      [id, req.supplierId], 4000
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, deleted: rows[0] });
  } catch (err) {
    console.error('[supplier/categories DELETE]', err.message);
    return res.status(500).json({ ok: false, error: 'DELETE_FAILED' });
  }
});

// POST /api/supplier/upload/parse  (multipart: file)
router.post('/upload/parse', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'MISSING_FILE' });

  const ext = path.extname(req.file.originalname || '').toLowerCase();
  if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
    return res.status(400).json({ ok: false, error: 'INVALID_FILE_TYPE', message: 'File must be .xlsx, .xls, or .csv.' });
  }

  try {
    const { parseSpreadsheet, validateRow } = require('../services/catalogIngest');
    const mapping = {
      supplier_slug: req.supplier.slug,
      file_type: ext === '.csv' ? 'csv' : 'xlsx',
      header_row: 1,
      data_start_row: 2,
      column_mapping: {
        sku: req.body?.col_sku || 'A',
        name: req.body?.col_name || 'B',
        description: req.body?.col_desc || 'C',
        category: req.body?.col_cat || 'D',
        unit_of_measure: req.body?.col_uom || 'E',
        unit_price: req.body?.col_price || 'F',
      },
      unit_of_measure_mapping: {},
      skip_rows_where: { sku: ['', null], unit_price: ['', null, '0'] },
    };

    // Try loading supplier-specific mapping if available
    let finalMapping = mapping;
    try {
      const { loadSupplierMapping } = require('../services/catalogIngest');
      finalMapping = loadSupplierMapping(req.supplier.slug);
    } catch { /* use default mapping above */ }

    const rows = parseSpreadsheet(req.file.path, finalMapping);
    const valid = [], errors = [];
    for (let i = 0; i < rows.length; i++) {
      const result = validateRow(rows[i], finalMapping);
      if (result.valid) valid.push(result.normalized);
      else if (!result.skip) errors.push({ row: i + 2, errors: result.errors });
    }

    // Diff against existing to count new vs updated vs unchanged
    const { rows: existing } = await pg.queryWithTimeout(
      `SELECT sku, unit_price_cents, name FROM public.catalog_products WHERE supplier_id = $1`,
      [req.supplierId], 5000
    );
    const existingMap = new Map(existing.map((r) => [r.sku, r]));

    let toAdd = 0, toUpdate = 0, unchanged = 0;
    for (const row of valid) {
      const prev = existingMap.get(row.sku);
      if (!prev) toAdd++;
      else if (prev.unit_price_cents !== row.unit_price_cents || prev.name !== row.name) toUpdate++;
      else unchanged++;
    }

    // Store parsed rows in session via a temporary file key (pass back to /apply)
    const tmpKey = require('crypto').randomBytes(12).toString('hex');
    const tmpPath = path.join(os.tmpdir(), `sup_parse_${tmpKey}.json`);
    require('fs').writeFileSync(tmpPath, JSON.stringify({ rows: valid, supplierId: req.supplierId, filename: req.file.originalname }));

    return res.json({
      ok: true,
      parse_key: tmpKey,
      filename: req.file.originalname,
      summary: { total: valid.length, to_add: toAdd, to_update: toUpdate, unchanged, errors: errors.length },
      errors: errors.slice(0, 50),
    });
  } catch (err) {
    console.error('[supplier/upload/parse]', err.message);
    return res.status(500).json({ ok: false, error: 'PARSE_FAILED', message: err.message });
  }
});

// POST /api/supplier/upload/apply
router.post('/upload/apply', express.json(), async (req, res) => {
  const { parse_key } = req.body || {};
  if (!parse_key) return res.status(400).json({ ok: false, error: 'MISSING_PARSE_KEY' });

  const tmpPath = path.join(os.tmpdir(), `sup_parse_${parse_key}.json`);
  if (!require('fs').existsSync(tmpPath)) {
    return res.status(400).json({ ok: false, error: 'PARSE_KEY_EXPIRED', message: 'Upload session expired. Please re-upload the file.' });
  }

  try {
    const { rows, supplierId, filename } = JSON.parse(require('fs').readFileSync(tmpPath, 'utf8'));

    // Verify this parse_key belongs to this supplier
    if (supplierId !== req.supplierId) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }

    const effectiveDate = new Date().toISOString().slice(0, 10);
    const { diffAndUpsert } = require('../services/catalogIngest');
    const result = await diffAndUpsert(req.supplierId, rows, effectiveDate);

    // Write ingestion log
    await pg.queryWithTimeout(
      `INSERT INTO public.catalog_ingestion_log
         (supplier_id, source_type, source_filename, products_added, products_updated,
          products_discontinued, prices_changed, errors, error_details, status, started_at, completed_at)
       VALUES ($1,'supplier_upload',$2,$3,$4,0,$5,$6,$7::jsonb,'success',now(),now())`,
      [req.supplierId, filename, result.added, result.updated,
       result.priceChanges || result.updated, result.errors?.length || 0,
       JSON.stringify(result.errorDetails || [])],
      5000
    ).catch(() => {});

    // Clean up tmp file
    require('fs').unlinkSync(tmpPath);

    // Mark onboarding complete if this is their first upload
    await pg.queryWithTimeout(
      `UPDATE public.suppliers SET onboarding_completed = true WHERE id = $1 AND onboarding_completed = false`,
      [req.supplierId], 3000
    ).catch(() => {});

    return res.json({
      ok: true,
      result: {
        added: result.added,
        updated: result.updated,
        unchanged: result.unchanged,
        errors: result.errors?.length || 0,
        error_details: result.errorDetails || [],
      },
    });
  } catch (err) {
    console.error('[supplier/upload/apply]', err.message);
    return res.status(500).json({ ok: false, error: 'APPLY_FAILED', message: err.message });
  }
});

// GET /api/supplier/upload/history
router.get('/upload/history', async (req, res) => {
  try {
    const { rows } = await pg.queryWithTimeout(
      `SELECT id, source_type, source_filename, products_added, products_updated,
              products_discontinued, prices_changed, errors, status, started_at, completed_at, created_at
       FROM public.catalog_ingestion_log
       WHERE supplier_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.supplierId], 4000
    );
    return res.json({ ok: true, history: rows });
  } catch (err) {
    console.error('[supplier/upload/history]', err.message);
    return res.status(500).json({ ok: false, error: 'QUERY_FAILED' });
  }
});

// ─── Admin endpoints ──────────────────────────────────────────────────────────
// Mounted at /api/admin via index.js

router.get('/suppliers/pending', requireChiefOSAdmin, async (req, res) => {
  try {
    const { rows } = await pg.queryWithTimeout(
      `SELECT s.id, s.slug, s.name, s.status, s.supplier_type, s.region,
              s.primary_contact_name, s.primary_contact_email, s.primary_contact_phone,
              s.company_address, s.public_description, s.created_at,
              COUNT(cp.id) AS product_count
       FROM public.suppliers s
       LEFT JOIN public.catalog_products cp ON cp.supplier_id = s.id AND cp.is_active = true
       WHERE s.status = 'pending_review'
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
      [], 5000
    );
    return res.json({ ok: true, suppliers: rows });
  } catch (err) {
    console.error('[admin/suppliers/pending]', err.message);
    return res.status(500).json({ ok: false, error: 'QUERY_FAILED' });
  }
});

router.get('/suppliers', requireChiefOSAdmin, async (req, res) => {
  try {
    const { rows } = await pg.queryWithTimeout(
      `SELECT s.id, s.slug, s.name, s.status, s.supplier_type, s.region,
              s.primary_contact_name, s.primary_contact_email,
              s.onboarding_completed, s.approved_at, s.created_at,
              COUNT(cp.id) FILTER (WHERE cp.is_active = true) AS product_count,
              MAX(cp.updated_at) AS last_product_update
       FROM public.suppliers s
       LEFT JOIN public.catalog_products cp ON cp.supplier_id = s.id
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
      [], 5000
    );
    return res.json({ ok: true, suppliers: rows });
  } catch (err) {
    console.error('[admin/suppliers]', err.message);
    return res.status(500).json({ ok: false, error: 'QUERY_FAILED' });
  }
});

router.post('/suppliers/:id/approve', requireChiefOSAdmin, express.json(), async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pg.queryWithTimeout(
      `UPDATE public.suppliers
       SET status = 'active', approved_at = now(), approved_by = $2, is_active = true
       WHERE id = $1
       RETURNING id, slug, name, status, primary_contact_email, primary_contact_name`,
      [id, req.adminEmail], 4000
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    // Email supplier
    try {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');
      const appUrl = process.env.APP_BASE_URL || 'https://app.usechiefos.com';
      await sgMail.send({
        to: rows[0].primary_contact_email,
        from: process.env.SENDGRID_FROM_EMAIL || 'noreply@usechiefos.com',
        subject: 'Your ChiefOS supplier account is approved',
        text: `Hi ${rows[0].primary_contact_name},\n\nYour ChiefOS supplier account for ${rows[0].name} has been approved.\n\nSign in and start uploading your catalog at: ${appUrl}/supplier/login\n\nWelcome to ChiefOS.\n`,
      });
    } catch (e) {
      console.warn('[admin/approve] email failed:', e?.message);
    }

    return res.json({ ok: true, supplier: rows[0] });
  } catch (err) {
    console.error('[admin/suppliers/approve]', err.message);
    return res.status(500).json({ ok: false, error: 'UPDATE_FAILED' });
  }
});

router.post('/suppliers/:id/reject', requireChiefOSAdmin, express.json(), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};
  try {
    const { rows } = await pg.queryWithTimeout(
      `UPDATE public.suppliers SET status = 'inactive', is_active = false
       WHERE id = $1
       RETURNING id, name, primary_contact_email, primary_contact_name`,
      [id], 4000
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    try {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');
      await sgMail.send({
        to: rows[0].primary_contact_email,
        from: process.env.SENDGRID_FROM_EMAIL || 'noreply@usechiefos.com',
        subject: 'ChiefOS supplier application — follow up',
        text: `Hi ${rows[0].primary_contact_name},\n\nThank you for your interest in ChiefOS.\n\n${reason || 'We were not able to approve your supplier account at this time.'}\n\nIf you have questions, reply to this email.\n`,
      });
    } catch (e) {
      console.warn('[admin/reject] email failed:', e?.message);
    }

    return res.json({ ok: true, supplier: rows[0] });
  } catch (err) {
    console.error('[admin/suppliers/reject]', err.message);
    return res.status(500).json({ ok: false, error: 'UPDATE_FAILED' });
  }
});

module.exports = router;
