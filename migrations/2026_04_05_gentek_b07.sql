DO $$ DECLARE supplier_uuid UUID; BEGIN
  SELECT id INTO supplier_uuid FROM public.suppliers WHERE slug = 'gentek' LIMIT 1;
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'vinyl-trims' LIMIT 1),
    '5451218', '12 X 18" RECT. GABLE VENT', 'ea', 6420,
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
    '5461212', '12"X12" SQUARE VENT', 'ea', 4937,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'sequoia-select-siding' LIMIT 1),
    '64496', 'D4 - CG           (2sq/bx)', 'ea', 1254,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'sequoia-select-siding' LIMIT 1),
    '64495', 'D4.5 Dutch   - CG (2sq/bx)', 'ea', 1368,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'sequoia-select-siding' LIMIT 1),
    '64497', 'D5 - CG  (2sq/bx)', 'ea', 1604,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'sequoia-select-siding' LIMIT 1),
    '64507', 'D5 Dutch -CG   (2sq/bx)', 'ea', 1505,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'sequoia-select-siding' LIMIT 1),
    '64397', 'BOARD & BATTEN VERTICAL(1 SQ/BX)', 'ea', 1033,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'sequoia-select-siding' LIMIT 1),
    '65504', '3.5"  Outside Corner - BF', 'ea', 2600,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'sequoia-select-siding' LIMIT 1),
    '65524', '3.5"  Outside Corner - BF Dark Colours', 'ea', 2522,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'sequoia-select-siding' LIMIT 1),
    '65533', 'Premuim J 3/4"', 'ea', 713,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'sequoia-select-siding' LIMIT 1),
    '65521', 'Inside Corner - BF Dark Colours', 'ea', 1646,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'sequoia-select-siding' LIMIT 1),
    '65571', 'Undersill - BF Dark Colours', 'ea', 783,
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
    'CP001', '2.5" AIGN STEEL STARTER STRIP  10''', 'ea', 1209,
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
    'CP011', 'ALIGN FINISH TRIM  12''6"', 'ea', 1683,
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
    'CP700', '7" ALIGN COMPOSITE PLANK 12'' 3"', 'ea', 3116,
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
    '1829', '2-1/2" STEEL STARTER 10''', 'ea', 872,
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
    '1748', 'SIERRA STEEL 8" KYNAR 12''6"', 'ea', 4527,
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
    '1750', 'SIERRA ST. D4" BEV.KYNAR 12''6"', 'ea', 4831,
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
    '1752', 'SIERRA ST. 12" B&B KYNAR 10''', 'ea', 4541,
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
    '1755', 'SIERRA ST. D5" BEVEL KYNAR 12''', 'ea', 5311,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
END $$;