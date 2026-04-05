DO $$ DECLARE supplier_uuid UUID; BEGIN
  SELECT id INTO supplier_uuid FROM public.suppliers WHERE slug = 'gentek' LIMIT 1;
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'painted-screws-trim-nails' LIMIT 1),
    '50540L', 'CAULKING GUN MODEL B12 W/LOGO', 'ea', 2829,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'painted-screws-trim-nails' LIMIT 1),
    '512621', 'LEPAGE QUAD FOAM GUN', 'ea', 6423,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '62450', 'DRIFTWOOD II D4 12''6"     (2sq/bx)', 'ea', 930,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '62452', 'DRIFTWOOD II D4.5 12"6"   (2sq/bx)', 'ea', 871,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64686', 'D4 Bevel - LRS   (2sq/bx)', 'ea', 1109,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64621', 'D4 Dutch - LRS   (2sq/bx)', 'ea', 1120,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '62317', 'D5 Bevel - LRS   (2sq/bx)', 'ea', 1357,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '62215', 'D5 Dutch - LRS   (2sq/bx)', 'ea', 1316,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '63319', '6.5" Berkshire Beaded B/F (2sq/bx)', 'ea', 1442,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64695', '(2sq/bx)', 'ea', 1234,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64696', '(2sq/bx)', 'ea', 1234,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64697', '(2sq/bx)', 'ea', 1481,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64698', '(2sq/bx)', 'ea', 1481,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64266', 'D4 Dutch - DW   (2sq/bx)', 'ea', 1029,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64268', 'D5 Dutch - DW   (2sq/bx)', 'ea', 1257,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64370', 'Vinyl Beaded Solid   (1sq/bx)8"x12''6"', 'ea', 1987,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64375', 'Vinyl Beaded Vented  (1sq/bx)8"x12''6"', 'ea', 1987,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64751', 'Oxford Solid     (2sq/bx) 10''', 'ea', 947,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64754', 'Oxford Vented    (2sq/bx) 12''', 'ea', 1137,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'driftwood-ii-siding' LIMIT 1),
    '64458', 'Fairweather 3 Panel Vented  (192 sq ft/bx)', 'ea', 1396,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
END $$;