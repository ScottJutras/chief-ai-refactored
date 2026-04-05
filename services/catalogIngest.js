'use strict';

/**
 * ChiefOS Supplier Catalog Ingestion Service
 *
 * Parses supplier product spreadsheets (.xlsx, .csv) and upserts into
 * the shared catalog_products table. Per-supplier column mappings are
 * stored in config/catalogMappings/{slug}.json.
 *
 * Flow: load mapping → parse spreadsheet → validate rows →
 *       diff against existing catalog → upsert → write ingestion log
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const Papa = require('papaparse');
const { Pool } = require('pg');

const DB_URL =
  (process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim()) ||
  (process.env.POSTGRES_URL && String(process.env.POSTGRES_URL).trim()) ||
  (process.env.SUPABASE_DB_URL && String(process.env.SUPABASE_DB_URL).trim()) ||
  '';

const shouldSSL = /supabase\.co|render\.com|herokuapp\.com|aws|gcp|azure/i.test(DB_URL);
const _pool = new Pool({
  connectionString: DB_URL,
  ssl: shouldSSL ? { rejectUnauthorized: false } : false,
  max: 3,
});

const MAPPINGS_DIR = path.join(__dirname, '..', 'config', 'catalogMappings');

const VALID_UOMS = new Set(['sq', 'lf', 'ea', 'box', 'bundle']);

// ─── Column mapping loader ────────────────────────────────────────────────────

function loadSupplierMapping(supplierSlug) {
  const mappingPath = path.join(MAPPINGS_DIR, `${supplierSlug}.json`);
  if (!fs.existsSync(mappingPath)) {
    throw new Error(`No column mapping found for supplier: ${supplierSlug}. Add config/catalogMappings/${supplierSlug}.json`);
  }
  return JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
}

// ─── Spreadsheet parser ───────────────────────────────────────────────────────

/**
 * Parse a spreadsheet into an array of raw row objects using the mapping config.
 */
function parseSpreadsheet(filePath, mapping) {
  const ext = path.extname(filePath).toLowerCase();
  let rows = [];

  if (ext === '.csv') {
    const content = fs.readFileSync(filePath, 'utf8');
    const result = Papa.parse(content, { header: false, skipEmptyLines: true });
    rows = result.data;
  } else {
    // .xlsx or .xls
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  }

  const headerRow = (mapping.header_row || 1) - 1;  // 0-indexed
  const dataStartRow = (mapping.data_start_row || 2) - 1;  // 0-indexed
  const colMap = mapping.column_mapping;

  // Convert letter-based column refs to 0-based indexes
  const colIndex = {};
  for (const [field, colRef] of Object.entries(colMap)) {
    if (typeof colRef === 'string' && /^[A-Z]+$/i.test(colRef)) {
      // Excel column letter → 0-based index
      colIndex[field] = colLetterToIndex(colRef);
    } else if (typeof colRef === 'number') {
      colIndex[field] = colRef - 1;
    }
  }

  const parsed = [];
  for (let i = dataStartRow; i < rows.length; i++) {
    const row = rows[i];
    const record = {};
    for (const [field, idx] of Object.entries(colIndex)) {
      record[field] = row[idx] != null ? String(row[idx]).trim() : '';
    }
    parsed.push(record);
  }

  return parsed;
}

function colLetterToIndex(letters) {
  let col = 0;
  for (const ch of letters.toUpperCase()) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return col - 1;
}

// ─── Row validation ───────────────────────────────────────────────────────────

function validateRow(row, mapping) {
  const errors = [];

  // Check skip conditions
  const skipRules = mapping.skip_rows_where || {};
  for (const [field, skipValues] of Object.entries(skipRules)) {
    const val = row[field];
    if (skipValues.includes(val) || skipValues.includes(Number(val))) {
      return { valid: false, skip: true, errors: [] };
    }
  }

  // SKU required
  if (!row.sku || !row.sku.trim()) {
    errors.push('missing SKU');
  }

  // Name required
  if (!row.name || !row.name.trim()) {
    errors.push('missing product name');
  }

  // Price: must be a positive number
  const rawPrice = String(row.unit_price || '').replace(/[$,\s]/g, '');
  const price = parseFloat(rawPrice);
  if (!Number.isFinite(price) || price <= 0) {
    errors.push(`invalid price: ${row.unit_price}`);
  }

  // Normalize unit of measure
  const uomRaw = String(row.unit_of_measure || '').trim();
  const uomMap = mapping.unit_of_measure_mapping || {};
  const uomNorm = uomMap[uomRaw] || uomRaw.toLowerCase();
  if (!VALID_UOMS.has(uomNorm)) {
    errors.push(`unknown unit_of_measure: ${uomRaw}`);
  }

  return {
    valid: errors.length === 0,
    skip: false,
    errors,
    normalized: {
      sku: (row.sku || '').trim(),
      name: (row.name || '').trim(),
      description: (row.description || '').trim() || null,
      category: (row.category || '').trim() || null,
      unit_of_measure: uomNorm,
      unit_price_cents: errors.length === 0 ? Math.round(price * 100) : 0,
    },
  };
}

// ─── Supplier resolver ────────────────────────────────────────────────────────

async function getSupplierRow(slug) {
  const res = await _pool.query(
    `SELECT id, slug, catalog_update_cadence FROM public.suppliers WHERE slug = $1 AND is_active = true LIMIT 1`,
    [slug]
  );
  return res.rows[0] ?? null;
}

async function getOrCreateCategory(supplierId, categoryName) {
  if (!categoryName) return null;
  const slug = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const existing = await _pool.query(
    `SELECT id FROM public.supplier_categories WHERE supplier_id = $1 AND slug = $2 LIMIT 1`,
    [supplierId, slug]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const ins = await _pool.query(
    `INSERT INTO public.supplier_categories (supplier_id, name, slug, is_active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [supplierId, categoryName, slug]
  );
  return ins.rows[0].id;
}

// ─── Diff and upsert ──────────────────────────────────────────────────────────

/**
 * Compare parsed rows against existing catalog and apply changes.
 * Returns counts of { added, updated, unchanged, errors }.
 */
async function diffAndUpsert(supplierId, parsedRows, effectiveDate) {
  // Load existing products for this supplier (sku → row)
  const existingRes = await _pool.query(
    `SELECT id, sku, unit_price_cents, name, description, category_id, unit_of_measure, is_active
     FROM public.catalog_products
     WHERE supplier_id = $1`,
    [supplierId]
  );
  const existing = new Map(existingRes.rows.map((r) => [r.sku, r]));

  const seenSkus = new Set();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const errorDetails = [];

  for (const row of parsedRows) {
    try {
      const categoryId = await getOrCreateCategory(supplierId, row.category);

      seenSkus.add(row.sku);
      const prev = existing.get(row.sku);

      if (!prev) {
        // NEW product
        await _pool.query(
          `INSERT INTO public.catalog_products
             (supplier_id, category_id, sku, name, description, unit_of_measure,
              unit_price_cents, price_type, price_effective_date, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'list', $8, true)
           ON CONFLICT (supplier_id, sku) DO NOTHING`,
          [supplierId, categoryId, row.sku, row.name, row.description,
           row.unit_of_measure, row.unit_price_cents, effectiveDate]
        );
        // Record initial price history
        await _pool.query(
          `INSERT INTO public.catalog_price_history
             (product_id, supplier_id, old_price_cents, new_price_cents, price_type, effective_date, change_source)
           SELECT id, $1, null, $2, 'list', $3, 'catalog_upload'
           FROM public.catalog_products WHERE supplier_id = $1 AND sku = $4`,
          [supplierId, row.unit_price_cents, effectiveDate, row.sku]
        );
        added++;
      } else if (
        prev.unit_price_cents !== row.unit_price_cents ||
        prev.name !== row.name ||
        prev.unit_of_measure !== row.unit_of_measure ||
        !prev.is_active
      ) {
        // CHANGED — update product, record price history if price changed
        const priceChanged = prev.unit_price_cents !== row.unit_price_cents;

        await _pool.query(
          `UPDATE public.catalog_products
           SET name = $1, description = $2, category_id = $3, unit_of_measure = $4,
               unit_price_cents = $5, price_effective_date = $6, is_active = true,
               discontinued_at = NULL, updated_at = now()
           WHERE supplier_id = $7 AND sku = $8`,
          [row.name, row.description, categoryId, row.unit_of_measure,
           row.unit_price_cents, effectiveDate, supplierId, row.sku]
        );

        if (priceChanged) {
          await _pool.query(
            `INSERT INTO public.catalog_price_history
               (product_id, supplier_id, old_price_cents, new_price_cents, price_type, effective_date, change_source)
             VALUES ($1, $2, $3, $4, 'list', $5, 'catalog_upload')`,
            [prev.id, supplierId, prev.unit_price_cents, row.unit_price_cents, effectiveDate]
          );
        }
        updated++;
      } else {
        unchanged++;
      }
    } catch (rowErr) {
      errorDetails.push({ sku: row.sku, error: rowErr.message });
    }
  }

  // Products in existing catalog NOT in the uploaded file → flag as potentially discontinued
  // Do NOT auto-deactivate — require manual review
  let discontinued = 0;
  for (const [sku, existing_row] of existing.entries()) {
    if (!seenSkus.has(sku) && existing_row.is_active) {
      discontinued++;
      console.warn(`[catalogIngest] ${sku} not in upload — may be discontinued. Manual review required.`);
    }
  }

  return { added, updated, unchanged, discontinued, errors: errorDetails.length, errorDetails };
}

// ─── Main ingestion entry point ───────────────────────────────────────────────

/**
 * Run a full catalog ingestion for a supplier.
 *
 * @param {string} supplierSlug - e.g. 'gentek'
 * @param {string} filePath - absolute path to the spreadsheet
 * @param {'spreadsheet_upload'|'email_forward'|'api_sync'} sourceType
 * @param {string|null} sourceFilename - original filename for audit log
 * @returns {object} ingestion summary
 */
async function runIngestion(supplierSlug, filePath, sourceType = 'spreadsheet_upload', sourceFilename = null) {
  const supplier = await getSupplierRow(supplierSlug);
  if (!supplier) throw new Error(`Supplier not found: ${supplierSlug}`);

  // Create ingestion log entry (status: processing)
  const logRes = await _pool.query(
    `INSERT INTO public.catalog_ingestion_log
       (supplier_id, source_type, source_filename, status, started_at)
     VALUES ($1, $2, $3, 'processing', now())
     RETURNING id`,
    [supplier.id, sourceType, sourceFilename || path.basename(filePath)]
  );
  const logId = logRes.rows[0].id;

  const effectiveDate = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD

  try {
    const mapping = loadSupplierMapping(supplierSlug);

    // Parse spreadsheet
    const rawRows = parseSpreadsheet(filePath, mapping);

    // Validate all rows
    const validRows = [];
    const parseErrors = [];

    for (const raw of rawRows) {
      const result = validateRow(raw, mapping);
      if (result.skip) continue;
      if (!result.valid) {
        parseErrors.push({ sku: raw.sku || '(unknown)', errors: result.errors });
        continue;
      }
      validRows.push(result.normalized);
    }

    // Apply changes
    const counts = await diffAndUpsert(supplier.id, validRows, effectiveDate);
    const allErrors = [...parseErrors, ...counts.errorDetails];

    // Update ingestion log to completed
    await _pool.query(
      `UPDATE public.catalog_ingestion_log
       SET status = 'completed', completed_at = now(),
           products_added = $1, products_updated = $2,
           products_discontinued = $3, prices_changed = $4,
           errors = $5, error_details = $6
       WHERE id = $7`,
      [counts.added, counts.updated, counts.discontinued, counts.updated,
       allErrors.length, JSON.stringify(allErrors), logId]
    );

    console.info('[catalogIngest] completed', {
      supplier: supplierSlug,
      added: counts.added, updated: counts.updated,
      unchanged: counts.unchanged, discontinued: counts.discontinued,
      errors: allErrors.length,
    });

    return {
      ok: true,
      supplier: supplierSlug,
      log_id: logId,
      added: counts.added,
      updated: counts.updated,
      unchanged: counts.unchanged,
      discontinued: counts.discontinued,
      errors: allErrors.length,
      error_details: allErrors,
    };

  } catch (err) {
    await _pool.query(
      `UPDATE public.catalog_ingestion_log
       SET status = 'failed', completed_at = now(),
           error_details = $1, errors = 1
       WHERE id = $2`,
      [JSON.stringify([{ error: err.message }]), logId]
    );
    throw err;
  }
}

module.exports = {
  loadSupplierMapping,
  parseSpreadsheet,
  validateRow,
  diffAndUpsert,
  runIngestion,
};
