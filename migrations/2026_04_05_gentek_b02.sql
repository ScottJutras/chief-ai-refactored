DO $$ DECLARE supplier_uuid UUID; BEGIN
  SELECT id INTO supplier_uuid FROM public.suppliers WHERE slug = 'gentek' LIMIT 1;
  INSERT INTO public.catalog_products
    (supplier_id, category_id, sku, name, unit_of_measure, unit_price_cents,
     price_type, price_effective_date, is_active)
  VALUES (
    supplier_uuid,
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '1003', '8" Horiz.Woodgrain 2000 (2sq/bx)', 'ea', 3370,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '1302', 'Vertical Deluxe Smooth', 'ea', 2638,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '1303', 'Vertical Woodgrain 2000', 'ea', 2819,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '1439', 'Vertical "V" Woodgrain 2000', 'ea', 2011,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '1186', 'D4 Woodgrain 44', 'ea', 2825,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '1191', 'Double 4" Deluxe Smooth', 'ea', 2428,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '1192', 'Double 4" Woodgrain 2000', 'ea', 2114,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '1188', 'Double 4" Dutch (40) WG', 'ea', 2458,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '2503', 'Universal J - 10''', 'ea', 873,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '2300', '8" Corner Cap - Smooth', 'ea', 212,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '2311', '8" Corner Cap - Woodgrain', 'ea', 212,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '0109025', 'Aluminum Universal Starter 10''', 'ea', 774,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '2502', '3/4"J Trim - Aluminum 12''', 'ea', 728,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '2538', 'L Trim - Small - Aluminum 12''', 'ea', 687,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '2543', 'Drip Cap /Returned Edge 12'' Alum', 'ea', 1079,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '2504', 'Undersill Trim 10"', 'ea', 699,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '2567', 'Roof edge 10''', 'ea', 597,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '2319', 'Corner Post .44mm plain', 'ea', 2681,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '2043', 'Gable sill/Fascia trim', 'ea', 986,
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
    (SELECT id FROM public.supplier_categories WHERE supplier_id = supplier_uuid AND slug = 'aluminum-fascia' LIMIT 1),
    '2573', '3" ROOF EDGE 0 DEG', 'ea', 735,
    'list', '2024-01-15', true
  )
  ON CONFLICT (supplier_id, sku) DO UPDATE SET
    name = EXCLUDED.name, unit_price_cents = EXCLUDED.unit_price_cents,
    unit_of_measure = EXCLUDED.unit_of_measure, category_id = EXCLUDED.category_id,
    price_effective_date = EXCLUDED.price_effective_date,
    is_active = true, updated_at = now();
END $$;