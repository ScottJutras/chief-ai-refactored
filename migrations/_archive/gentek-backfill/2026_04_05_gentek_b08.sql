DO $$ DECLARE supplier_uuid UUID; BEGIN
  SELECT id INTO supplier_uuid FROM public.suppliers WHERE slug = 'gentek' LIMIT 1;
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'align-composite-plank' LIMIT 1),
    '1835', 'KYNAR STEEL 3/4" O/S CORNER 10''', 'ea', 4443,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'align-composite-plank' LIMIT 1),
    '1841', '1 1/8" J-CHANNEL - KYNAR', 'ea', 1860,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'align-composite-plank' LIMIT 1),
    '1842', '3/4" J-CHANNEL 12''6" KYNAR', 'ea', 1601,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'align-composite-plank' LIMIT 1),
    '1850', 'SNAP-LOCK KYNAR', 'ea', 1559,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'align-composite-plank' LIMIT 1),
    '5550', 'SAW BLADE 10" STEEL PRF 2550D', 'ea', 10234,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'align-composite-plank' LIMIT 1),
    '5009', 'T-UP PAINT SIDING', 'ea', 451,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '1954', '2 5/8" DOWNPIPE', 'ea', 1317,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '1955', '2 5/8" ELBOWS', 'ea', 184,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '4127', 'SMALL SQUARE OUTLETS (100/BX)', 'ea', 106,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '1950', 'LARGE SQUARE DOWNPIPE (10/BX)', 'ea', 1494,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '1951', 'LARGE SQUARE ELBOW (30/BX)', 'ea', 179,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '4131', 'LARGE SQUARE OUTLETS (100/BX)', 'ea', 124,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '1957', '2 X 3 DOWNPIPE', 'ea', 1420,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '1958', '2 X 3 "A" ELBOWS', 'ea', 145,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '1959', '2 X 3 "B" ELBOWS', 'ea', 166,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '4128', '2" X 3" OUTLETS', 'ea', 111,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '1952', '3X4 DOWNPIPE (10/BX)', 'ea', 2368,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '1953', '3X4 "A" ELBOW (20/BX)', 'ea', 353,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '1956', '3X4 "B" ELBOW (20/BX)', 'ea', 353,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'rainware-accessories' LIMIT 1),
    '4141', '5" K STYLE END CAP LH (50/BX)               50 pc/bx           $.84 pc', 'bx', 4213,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
END $$;