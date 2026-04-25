DO $$ DECLARE supplier_uuid UUID; BEGIN
  SELECT id INTO supplier_uuid FROM public.suppliers WHERE slug = 'gentek' LIMIT 1;
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '65735', '3.5 Window/Door Surround - MF', 'ea', 4453,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '68005', '5.0 Window/Door Surroung - MF', 'ea', 5281,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '65700', 'Surround Starter', 'ea', 1191,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5030101', 'ORIGINAL SCALLOPED MOUNTING BLOCK', 'ea', 1338,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5030102', 'ORIGINAL SQUARE MOUNTING BLOCK', 'ea', 1338,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5030103', 'SLIMLINE MOUNTMASTER', 'ea', 1320,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5030201', 'Recessed Mini Mount Block (Electrical', 'ea', 1263,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5030401', 'Split Mini Mount Block (Water)', 'ea', 1429,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5030802', '4" SQUARE DRYER VENT', 'ea', 2402,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '530804', '4" HOODED VENT', 'ea', 2549,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '530806', '6" HOODED VENT', 'bx', 6021,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '530807', 'MASTER INTAKE/EXHAUST VENT', 'ea', 3842,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '530901', 'METER BLOCK', 'ea', 3917,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '532701', 'JUMBO MOUNTING BLOCK', 'ea', 1996,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5400018', '18" OCTAGON GABLE VENT', 'ea', 5363,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5400022', '22" OCTAGON GABLE VENT', 'ea', 6128,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5410018', '18" ROUND GABLE VENT', 'ea', 5363,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5410022', '22" ROUND GABLE VENT', 'ea', 6128,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5432234', '22 X 34 HALF ROUND GABLE VENT', 'ea', 11112,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5441422', '14" X 22" ROUND TOP VENT', 'ea', 6892,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
END $$;