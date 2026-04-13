# ChiefOS — Supplier Catalog Integration Plan

## For: Claude Code Implementation
## Status: New Feature — Beta Expansion
## Priority: Post-core-Beta, pre-public-launch
## Author: Scott Jutras
## Date: 2026-04-04

---

## 1. PURPOSE

Build a supplier catalog system that allows ChiefOS to store, serve, and reason over
building material product catalogs from partner suppliers. First integration target: 
Gentek Building Products.

This system enables:
- Contractors browsing supplier catalogs and pricing within ChiefOS
- Itemized expense logging against real catalog products
- Catalog-assisted quote building with current supplier pricing
- Ask Chief queries about materials and pricing ("What does Gentek charge for vinyl siding?")
- Supplier-side value: their products become the default materials in contractor workflows

---

## 2. ARCHITECTURAL PRINCIPLES

### This is SHARED REFERENCE DATA, not tenant data.

Supplier catalogs are NOT tenant-scoped. They are global reference tables that all tenants
can read from. This is fundamentally different from transactions, time entries, or jobs.

**Read access:** Any authenticated tenant can query catalog data. No tenant_id filter needed
on catalog reads.

**Write access:** Only the catalog ingestion pipeline writes to catalog tables. No tenant,
owner, or user can modify catalog data. This is system-managed reference data.

**Tenant interaction with catalogs:** When a contractor uses a catalog item in an expense,
quote, or invoice, the system COPIES the relevant fields (product name, SKU, unit price at
time of use, supplier name) into the tenant-scoped record (transaction, quote line item, etc.).
This snapshot ensures historical accuracy — if catalog prices change, tenant records reflect
what was actually quoted or logged at that time.

### Identity model compliance

- Catalog tables do NOT have tenant_id, owner_id, or user_id columns
- Catalog tables have their own identity: supplier_id
- Tenant-scoped tables that REFERENCE catalog items store a snapshot, not a foreign key
  (to prevent breakage if catalog items are removed)
- RLS is NOT applied to catalog tables — they are public read within the authenticated scope

### CIL compliance

When a catalog item is used in an expense or quote:
- The CIL draft includes the catalog snapshot fields (supplier_name, product_sku, 
  product_name, unit_price_cents, unit_of_measure)
- The CIL draft still follows: Ingress → CIL Draft → Validation → Domain Mutation
- The catalog lookup happens BEFORE CIL draft creation, not during mutation

---

## 3. DATABASE SCHEMA

### Table: public.suppliers

Stores partner supplier information.

```sql
CREATE TABLE public.suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,                    -- 'gentek', 'kaycan', 'royal'
  name TEXT NOT NULL,                           -- 'Gentek Building Products'
  description TEXT,                             -- Short supplier description
  website_url TEXT,                             -- 'https://www.gentek.ca'
  logo_storage_key TEXT,                        -- Reference to supplier logo in storage
  contact_email TEXT,                           -- For catalog update reminders
  catalog_update_cadence TEXT DEFAULT 'quarterly', -- 'monthly', 'quarterly', 'annual'
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_suppliers_slug ON public.suppliers(slug);
CREATE INDEX idx_suppliers_active ON public.suppliers(is_active) WHERE is_active = true;
```

### Table: public.supplier_categories

Hierarchical product categories per supplier.

```sql
CREATE TABLE public.supplier_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES public.suppliers(id),
  parent_category_id UUID REFERENCES public.supplier_categories(id),
  name TEXT NOT NULL,                           -- 'Siding', 'Vinyl Siding', 'Accessories'
  slug TEXT NOT NULL,                           -- 'vinyl-siding'
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(supplier_id, slug)
);

CREATE INDEX idx_supplier_categories_supplier ON public.supplier_categories(supplier_id);
CREATE INDEX idx_supplier_categories_parent ON public.supplier_categories(parent_category_id);
```

### Table: public.catalog_products

The core product catalog. One row per product per supplier.

```sql
CREATE TABLE public.catalog_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES public.suppliers(id),
  category_id UUID REFERENCES public.supplier_categories(id),
  sku TEXT NOT NULL,                            -- Supplier's product SKU
  name TEXT NOT NULL,                           -- 'Premium Vinyl Siding - White'
  description TEXT,                             -- Full product description
  unit_of_measure TEXT NOT NULL,                -- 'sq' (square), 'lf' (linear foot), 'ea', 'box', 'bundle'
  unit_price_cents INTEGER NOT NULL,            -- Price in cents (e.g., 4200 = $42.00)
  price_type TEXT NOT NULL DEFAULT 'list',      -- 'list', 'contractor', 'volume'
  price_effective_date DATE NOT NULL,           -- When this price became effective
  price_expires_date DATE,                      -- When this price is expected to expire (nullable)
  min_order_quantity INTEGER DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,      -- false = discontinued/unavailable
  discontinued_at TIMESTAMPTZ,                  -- When product was marked discontinued
  metadata JSONB DEFAULT '{}',                  -- Flexible: color, dimensions, weight, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(supplier_id, sku)
);

CREATE INDEX idx_catalog_products_supplier ON public.catalog_products(supplier_id);
CREATE INDEX idx_catalog_products_category ON public.catalog_products(category_id);
CREATE INDEX idx_catalog_products_sku ON public.catalog_products(supplier_id, sku);
CREATE INDEX idx_catalog_products_active ON public.catalog_products(supplier_id, is_active) 
  WHERE is_active = true;
CREATE INDEX idx_catalog_products_name_search ON public.catalog_products 
  USING gin(to_tsvector('english', name || ' ' || COALESCE(description, '')));
```

### Table: public.catalog_price_history

Track price changes over time for analytics and audit.

```sql
CREATE TABLE public.catalog_price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.catalog_products(id),
  supplier_id UUID NOT NULL REFERENCES public.suppliers(id),
  old_price_cents INTEGER,                     -- null on first insert
  new_price_cents INTEGER NOT NULL,
  price_type TEXT NOT NULL DEFAULT 'list',
  effective_date DATE NOT NULL,
  change_source TEXT NOT NULL,                 -- 'catalog_upload', 'manual_update', 'api_sync'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_price_history_product ON public.catalog_price_history(product_id);
CREATE INDEX idx_price_history_supplier ON public.catalog_price_history(supplier_id);
```

### Table: public.catalog_ingestion_log

Audit trail for catalog updates.

```sql
CREATE TABLE public.catalog_ingestion_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES public.suppliers(id),
  source_type TEXT NOT NULL,                   -- 'spreadsheet_upload', 'email_forward', 'api_sync'
  source_filename TEXT,                        -- Original filename if uploaded
  source_email_id TEXT,                        -- Email message ID if forwarded
  products_added INTEGER NOT NULL DEFAULT 0,
  products_updated INTEGER NOT NULL DEFAULT 0,
  products_discontinued INTEGER NOT NULL DEFAULT 0,
  prices_changed INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  error_details JSONB DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',      -- 'pending', 'processing', 'completed', 'failed'
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ingestion_log_supplier ON public.catalog_ingestion_log(supplier_id);
```

### Table: public.tenant_supplier_preferences

Tenant-scoped preferences for supplier catalog usage.

```sql
CREATE TABLE public.tenant_supplier_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,                     -- Standard tenant boundary
  supplier_id UUID NOT NULL REFERENCES public.suppliers(id),
  is_preferred BOOLEAN NOT NULL DEFAULT false,  -- Preferred supplier for this tenant
  contractor_account_number TEXT,               -- Contractor's account with this supplier
  discount_percentage INTEGER DEFAULT 0,        -- Negotiated discount (in basis points, e.g., 1000 = 10%)
  notes TEXT,                                   -- Internal notes about this supplier relationship
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, supplier_id)
);

CREATE INDEX idx_tenant_supplier_prefs_tenant ON public.tenant_supplier_preferences(tenant_id);
```

**NOTE:** This is the ONLY catalog-related table with tenant_id. RLS applies here.
All other catalog tables are shared reference data.

---

## 4. CATALOG INGESTION PIPELINE

### 4.1 Ingestion Sources (in priority order)

**Source 1: Spreadsheet Upload (Primary for Gentek launch)**
- Admin or supplier uploads spreadsheet via a simple upload endpoint
- Supports .xlsx, .csv
- Requires a per-supplier column mapping configuration

**Source 2: Email Forwarding (Future — uses existing email ingestion pipeline)**
- Supplier forwards updated price list to catalog-specific ingestion email
- e.g., catalog-gentek@ingest.usechiefos.com
- Attachment extracted, routed to spreadsheet parser

**Source 3: API Sync (Future — if supplier provides API)**
- Scheduled pull from supplier API
- Map to internal schema
- Not expected for Gentek initially

### 4.2 Spreadsheet Parsing Pipeline

```
Spreadsheet received
  → Identify supplier (from upload context or email routing)
  → Load supplier column mapping config
  → Parse spreadsheet rows
  → For each row:
      → Extract: sku, name, description, category, unit_of_measure, price
      → Validate:
          - SKU is non-empty and unique within file
          - Price is positive integer (convert to cents)
          - Unit of measure is in allowed set
          - Category exists or should be created
      → Classify:
          - NEW: SKU not in current catalog → INSERT
          - UPDATED: SKU exists, price or details changed → UPDATE + price history
          - UNCHANGED: SKU exists, no changes → SKIP
          - ERROR: validation failed → log to error_details
  → Products in current catalog NOT in spreadsheet:
      → Flag as potentially discontinued (do NOT auto-deactivate)
      → Log for manual review
  → Write ingestion log entry
  → Return summary: added, updated, unchanged, errors, potentially discontinued
```

### 4.3 Supplier Column Mapping Configuration

Store as JSON per supplier. Example for Gentek:

```json
{
  "supplier_slug": "gentek",
  "file_type": "xlsx",
  "header_row": 1,
  "data_start_row": 2,
  "column_mapping": {
    "sku": "A",
    "name": "B",
    "description": "C",
    "category": "D",
    "unit_of_measure": "E",
    "unit_price": "F"
  },
  "price_format": "dollars",
  "unit_of_measure_mapping": {
    "SQ": "sq",
    "Square": "sq",
    "LF": "lf",
    "Linear Foot": "lf",
    "EA": "ea",
    "Each": "ea",
    "BOX": "box",
    "BDL": "bundle",
    "Bundle": "bundle"
  },
  "skip_rows_where": {
    "sku": ["", null],
    "unit_price": ["", null, 0]
  }
}
```

**IMPORTANT:** This mapping will need to be configured once when Gentek provides their
actual spreadsheet format. The structure above is a template — adjust columns after
receiving the real file.

### 4.4 LLM-Assisted Parsing (Fallback)

If the spreadsheet format doesn't match the mapping config (new format, different columns),
route to an LLM extraction step:

- Send first 10 rows + headers to LLM with prompt:
  "Identify which columns contain: product SKU, product name, description, category, 
   unit of measure, and unit price. Return a JSON column mapping."
- Validate LLM output against expected schema
- If confidence is high (all fields mapped), proceed with LLM-generated mapping
- If confidence is low, flag for manual review and do NOT process
- Log the LLM-generated mapping for future reference

This ensures the system can handle format changes without breaking.

---

## 5. CATALOG QUERY PATTERNS

### 5.1 Portal Catalog Browsing

```sql
-- List all active suppliers
SELECT id, slug, name, description, website_url, logo_storage_key
FROM public.suppliers
WHERE is_active = true
ORDER BY name;

-- List categories for a supplier
SELECT id, name, slug, parent_category_id
FROM public.supplier_categories
WHERE supplier_id = $1 AND is_active = true
ORDER BY sort_order, name;

-- List products in a category
SELECT id, sku, name, description, unit_of_measure, 
       unit_price_cents, price_effective_date, price_expires_date, metadata
FROM public.catalog_products
WHERE supplier_id = $1 
  AND category_id = $2 
  AND is_active = true
ORDER BY name;

-- Search products across a supplier
SELECT id, sku, name, description, unit_of_measure, unit_price_cents,
       price_effective_date, metadata
FROM public.catalog_products
WHERE supplier_id = $1
  AND is_active = true
  AND to_tsvector('english', name || ' ' || COALESCE(description, ''))
      @@ plainto_tsquery('english', $2)
ORDER BY ts_rank(
  to_tsvector('english', name || ' ' || COALESCE(description, '')),
  plainto_tsquery('english', $2)
) DESC
LIMIT 20;

-- Search products across ALL suppliers
SELECT cp.id, cp.sku, cp.name, cp.description, cp.unit_of_measure,
       cp.unit_price_cents, cp.price_effective_date, cp.metadata,
       s.name AS supplier_name, s.slug AS supplier_slug
FROM public.catalog_products cp
JOIN public.suppliers s ON s.id = cp.supplier_id
WHERE cp.is_active = true
  AND s.is_active = true
  AND to_tsvector('english', cp.name || ' ' || COALESCE(cp.description, ''))
      @@ plainto_tsquery('english', $1)
ORDER BY ts_rank(
  to_tsvector('english', cp.name || ' ' || COALESCE(cp.description, '')),
  plainto_tsquery('english', $1)
) DESC
LIMIT 20;
```

### 5.2 Ask Chief Catalog Queries

When Ask Chief detects a materials/pricing intent, route to catalog tools:

```sql
-- "What does Gentek charge for vinyl siding?"
SELECT name, sku, unit_price_cents, unit_of_measure, price_effective_date
FROM public.catalog_products
WHERE supplier_id = (SELECT id FROM public.suppliers WHERE slug = 'gentek')
  AND is_active = true
  AND to_tsvector('english', name || ' ' || COALESCE(description, ''))
      @@ plainto_tsquery('english', 'vinyl siding')
ORDER BY ts_rank(
  to_tsvector('english', name || ' ' || COALESCE(description, '')),
  plainto_tsquery('english', 'vinyl siding')
) DESC
LIMIT 10;
```

Chief must always include the price_effective_date in responses:
- "Gentek's Premium Vinyl Siding is listed at $42.00/sq as of January 2026."
- If price_effective_date is older than 90 days, add: "This pricing may be outdated — 
  I'd confirm with Gentek before finalizing a quote."

### 5.3 Catalog-Assisted Quote Building

When building a quote, the user can reference catalog items:

```
User: "Add 20 squares of Gentek vinyl siding to the Mitchell Deck quote"

Chief:
1. Search catalog for "Gentek vinyl siding"
2. Find matching product(s)
3. If single match: "Gentek Premium Vinyl Siding — $42.00/sq × 20 = $840.00. Add to quote?"
4. If multiple matches: "I found a few options from Gentek: [list]. Which one?"
5. On confirmation: add quote line item with SNAPSHOT of catalog data
```

### 5.4 Expense Itemization

When logging an expense from a known supplier:

```
User: "Spent $892 at Gentek for the Mitchell job"

Chief: "Got it — $892 at Gentek on the Mitchell Deck job. Want to itemize against 
        Gentek's catalog? I can break it down by materials."

User: "Yeah, 20 squares vinyl siding and J-channel"

Chief looks up current catalog pricing, calculates expected totals, compares to 
receipt amount, and logs itemized expense with catalog snapshots.
```

---

## 6. CATALOG SNAPSHOT ON TENANT RECORDS

When a catalog product is used in a tenant-scoped record, store a snapshot.

### On transactions (expenses):

Add optional columns or use a JSONB field for catalog reference:

```sql
-- Option A: JSONB snapshot (recommended — flexible, no schema migration for new fields)
ALTER TABLE public.transactions
ADD COLUMN catalog_snapshot JSONB DEFAULT NULL;

-- Snapshot structure:
-- {
--   "supplier_slug": "gentek",
--   "supplier_name": "Gentek Building Products",
--   "items": [
--     {
--       "product_sku": "GEN-VS-001",
--       "product_name": "Premium Vinyl Siding - White",
--       "unit_price_cents": 4200,
--       "quantity": 20,
--       "unit_of_measure": "sq",
--       "line_total_cents": 84000,
--       "catalog_price_date": "2026-01-15"
--     }
--   ]
-- }
```

### On quote line items:

```sql
-- Quote line items should store catalog snapshot at time of quoting
-- This ensures the quote reflects the price when it was created,
-- not current catalog pricing
ALTER TABLE public.quote_line_items  -- or whatever the quote items table is called
ADD COLUMN catalog_product_id UUID,           -- reference for traceability (not FK — catalog items can be removed)
ADD COLUMN catalog_snapshot JSONB DEFAULT NULL;
```

---

## 7. PRICING FRESHNESS SYSTEM

### 7.1 Freshness States

```
FRESH:    price_effective_date is within supplier's update cadence
          → Show price with confidence
          
AGING:    price_effective_date is approaching expiry (within 30 days of expected refresh)
          → Show price with note: "Pricing from [date] — confirm with supplier for quotes"
          
STALE:    price_effective_date has passed expected refresh without update
          → Show price with warning: "This pricing may be outdated (last updated [date])"
          
EXPIRED:  More than 2x the update cadence has passed without refresh
          → Show price with strong warning: "Pricing is significantly outdated — 
            do not use for quoting without confirming current prices"
```

### 7.2 Automated Supplier Nudge

When a supplier's catalog approaches staleness:

```
At 7 days before expected refresh:
  → Send email to supplier contact_email:
     "Your product catalog in ChiefOS is due for a refresh next week.
      Upload your current price list at [upload_url] to keep your contractors
      working with accurate numbers."

At expected refresh date (if not updated):
  → Send follow-up email:
     "Your ChiefOS product catalog is now past its refresh date.
      Contractors will see a note that pricing may be outdated.
      Upload your current list: [upload_url]"

At 2x cadence (if still not updated):
  → Mark catalog as EXPIRED in system
  → Send final notification
  → Flag for ChiefOS admin review
```

---

## 8. API ENDPOINTS

### 8.1 Public Catalog Endpoints (authenticated, no tenant scope needed)

```
GET  /api/catalog/suppliers
     → List all active suppliers

GET  /api/catalog/suppliers/:slug
     → Get supplier details + top-level categories

GET  /api/catalog/suppliers/:slug/categories
     → List categories (with optional parent_id filter)

GET  /api/catalog/suppliers/:slug/products
     → List products (with category_id, search query, pagination)

GET  /api/catalog/products/search?q=vinyl+siding
     → Cross-supplier product search
```

### 8.2 Tenant-Scoped Preference Endpoints

```
GET    /api/catalog/preferences
       → Get tenant's supplier preferences (requires tenant_id via auth)

PUT    /api/catalog/preferences/:supplier_id
       → Set/update preference (is_preferred, account_number, discount)
       → Requires tenant_id via auth
```

### 8.3 Admin/Ingestion Endpoints (internal only)

```
POST   /api/admin/catalog/upload
       → Upload spreadsheet for a supplier
       → Requires admin authentication
       → Triggers ingestion pipeline

GET    /api/admin/catalog/ingestion-log
       → View ingestion history

POST   /api/admin/catalog/products/:id/deactivate
       → Manually deactivate a product
```

---

## 9. ASK CHIEF TOOL INTEGRATION

### 9.1 New Tool: catalog_lookup

Add to Ask Chief's tool registry:

```javascript
{
  name: "catalog_lookup",
  description: "Search supplier product catalogs for materials, pricing, and availability. Use when the user asks about material prices, product availability, or wants to reference supplier catalogs.",
  parameters: {
    supplier_slug: {
      type: "string",
      description: "Supplier identifier (e.g., 'gentek', 'kaycan'). Optional — omit to search all suppliers.",
      required: false
    },
    search_query: {
      type: "string", 
      description: "Product search terms (e.g., 'vinyl siding', 'J-channel', 'soffit panels')",
      required: true
    },
    category: {
      type: "string",
      description: "Product category filter. Optional.",
      required: false
    },
    limit: {
      type: "integer",
      description: "Max results to return. Default 5.",
      required: false
    }
  }
}
```

### 9.2 New Tool: catalog_quote_item

Add to Ask Chief's tool registry for quote building:

```javascript
{
  name: "catalog_quote_item",
  description: "Add a catalog product to a quote with quantity and current pricing. Use when the user wants to add specific materials to a quote from a supplier catalog.",
  parameters: {
    quote_id: { type: "string", required: true },
    product_id: { type: "string", required: true },
    quantity: { type: "number", required: true },
    notes: { type: "string", required: false }
  }
}
```

### 9.3 Intent Classification Updates

Add catalog-related intents to the intent classifier:

```
CATALOG_INTENTS = [
  'catalog_price_check',      -- "What does X cost at Y?"
  'catalog_browse',           -- "Show me Gentek's siding options"
  'catalog_compare',          -- "Compare siding prices between Gentek and Kaycan"
  'catalog_add_to_quote',     -- "Add 20 squares of vinyl siding to the quote"
  'catalog_itemize_expense',  -- "Break down my Gentek receipt"
]
```

---

## 10. PORTAL UI — CATALOG PAGES

### 10.1 Navigation

Add "Materials" or "Supplier Catalogs" to portal primary navigation.
Plan-gated: Builder and Boss only. Free tier sees the nav item grayed with upgrade prompt.

### 10.2 Catalog Browse Page

```
/portal/catalogs
  → Grid of supplier cards (logo, name, product count, last updated date)
  → Click → /portal/catalogs/:supplier_slug

/portal/catalogs/:supplier_slug  
  → Supplier header (name, logo, description, freshness indicator)
  → Category sidebar
  → Product list with search
  → Product cards: name, SKU, price, unit, freshness badge
  → Click product → detail drawer with full description, metadata, price history
```

### 10.3 Catalog in Quote Builder

When building a quote in the portal:
  → "Add from catalog" button on quote line items
  → Opens catalog search modal
  → Select supplier → search/browse → select product → enter quantity
  → Line item auto-populates with catalog snapshot

### 10.4 Catalog in Expense Detail

When viewing an expense detail drawer:
  → If catalog_snapshot exists, show itemized breakdown
  → If no snapshot, show "Itemize against catalog" button
  → Opens matching flow: select supplier → match items → confirm

---

## 11. PLAN GATING

### Catalog access by plan:

| Feature                          | Free | Builder | Boss |
|----------------------------------|------|---------|------|
| Browse supplier catalogs         | ✗    | ✓       | ✓    |
| Search products                  | ✗    | ✓       | ✓    |
| Ask Chief catalog queries        | ✗    | ✓*      | ✓*   |
| Catalog-assisted quoting         | ✗    | ✓       | ✓    |
| Expense itemization              | ✗    | ✓       | ✓    |
| Set preferred suppliers          | ✗    | ✗       | ✓    |
| Cross-supplier price comparison  | ✗    | ✗       | ✓    |
| Purchasing history analytics     | ✗    | ✗       | ✓    |

*Ask Chief catalog queries count against the tenant's monthly Ask Chief quota.

### Gating implementation:

```javascript
// Before serving catalog endpoints
const plan = await resolvePlan(tenantId);
if (plan === 'free') {
  return { ok: false, error: { code: 'PLAN_NOT_INCLUDED', message: 'Upgrade to Builder to access supplier catalogs.' }};
}
```

---

## 12. GENTEK-SPECIFIC CONFIGURATION

### Initial supplier record:

```sql
INSERT INTO public.suppliers (slug, name, description, website_url, catalog_update_cadence)
VALUES (
  'gentek',
  'Gentek Building Products',
  'Canadian manufacturer of exterior building products including siding, soffit, fascia, rainware, and accessories.',
  'https://www.gentek.ca',
  'quarterly'
);
```

### Expected product categories for Gentek:

Based on Gentek's product lines, expect these top-level categories:
- Vinyl Siding
- Engineered Wood Siding  
- Aluminum Siding
- Soffit & Fascia
- Rainware (Gutters & Downspouts)
- Trim & Mouldings
- Accessories (J-channel, starter strip, utility trim, etc.)
- Windows (if included in catalog)

### Column mapping:

To be configured AFTER receiving Gentek's actual price list spreadsheet. Use the 
template in Section 4.3 and adjust column letters, header row, and unit mapping
based on the real file format.

---

## 13. MIGRATION PLAN

### Phase 1: Schema (do first)
1. Create suppliers table
2. Create supplier_categories table  
3. Create catalog_products table
4. Create catalog_price_history table
5. Create catalog_ingestion_log table
6. Create tenant_supplier_preferences table
7. Add catalog_snapshot JSONB column to public.transactions
8. Add catalog_snapshot JSONB column to quote line items table (if exists)

### Phase 2: Ingestion Pipeline
1. Build spreadsheet parser service
2. Build column mapping config loader
3. Build diff engine (new/updated/unchanged/discontinued classification)
4. Build ingestion endpoint (admin-only upload)
5. Build ingestion log writer
6. Build price history tracker

### Phase 3: API Endpoints
1. Build catalog browse endpoints (suppliers, categories, products)
2. Build product search endpoint (full-text search)
3. Build tenant preference endpoints
4. Wire plan gating middleware

### Phase 4: Ask Chief Integration
1. Add catalog_lookup tool to tool registry
2. Add catalog intent classification
3. Build catalog query execution in domain services
4. Add freshness disclaimers to response formatting
5. Test: "What does Gentek charge for vinyl siding?" returns real data

### Phase 5: Portal UI
1. Add Catalogs page to portal navigation
2. Build supplier grid view
3. Build category/product browse view
4. Build product search
5. Build product detail drawer
6. Wire plan gating on UI (Free sees upgrade prompt)

### Phase 6: Quote & Expense Integration
1. Add "Add from catalog" to quote builder
2. Build catalog search modal for quote line items
3. Build expense itemization flow
4. Snapshot catalog data on quote/expense creation

### Phase 7: Freshness & Supplier Communication
1. Build freshness calculation service
2. Build supplier nudge email system
3. Build freshness badges for portal display
4. Build admin dashboard for catalog health monitoring

---

## 14. TESTING REQUIREMENTS

### Before deploying:

1. **Catalog isolation:** Verify catalog data is accessible to ALL tenants (no tenant_id filtering on reads)
2. **Snapshot integrity:** Verify that changing a catalog price does NOT change historical tenant records
3. **Ingestion idempotency:** Upload same spreadsheet twice → no duplicates, no price history noise
4. **Search quality:** Test full-text search with common contractor queries (vinyl siding, J-channel, soffit, etc.)
5. **Plan gating:** Free user cannot access catalog endpoints or UI
6. **Freshness:** Verify freshness states display correctly based on price_effective_date
7. **Ask Chief:** Verify catalog_lookup tool returns relevant results and includes freshness disclaimers

---

## 15. SECURITY NOTES

- Catalog data is NOT sensitive (it's supplier pricing, not tenant financial data)
- No PII exists in catalog tables
- Admin ingestion endpoints must require admin auth (not tenant auth)
- Tenant preference endpoints must enforce tenant_id via RLS
- Catalog product IDs stored in tenant records are for traceability only — never use as FK

---

End of Document — Supplier Catalog Integration Plan
