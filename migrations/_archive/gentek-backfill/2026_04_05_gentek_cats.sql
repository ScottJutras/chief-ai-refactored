-- Gentek supplier categories
DO $$ DECLARE supplier_uuid UUID; BEGIN
  SELECT id INTO supplier_uuid FROM public.suppliers WHERE slug = 'gentek' LIMIT 1;
  IF supplier_uuid IS NULL THEN RAISE EXCEPTION 'Gentek supplier not found'; END IF;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Aluminum Fascia', 'aluminum-fascia', 10)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Painted Screws & Trim Nails', 'painted-screws-trim-nails', 20)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Driftwood II Siding', 'driftwood-ii-siding', 30)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Vinyl Trims', 'vinyl-trims', 40)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Sequoia Select Siding', 'sequoia-select-siding', 50)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Align Composite Plank', 'align-composite-plank', 60)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Rainware & Accessories', 'rainware-accessories', 70)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Versetta Stone', 'versetta-stone', 80)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Foundry Shake & Scallop', 'foundry-shake-scallop', 90)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'James Hardie Cement Board', 'james-hardie-cement-board', 100)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'St Laurent (James Hardie)', 'st-laurent-james-hardie', 110)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Light Trim (James Hardie)', 'light-trim-james-hardie', 120)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'ChamClad', 'chamclad', 130)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Longboard Siding & Soffit', 'longboard-siding-soffit', 140)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Tapco Tools', 'tapco-tools', 150)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Valor PVC Sheeting', 'valor-pvc-sheeting', 160)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Distinction Steel Siding', 'distinction-steel-siding', 170)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.supplier_categories (supplier_id, name, slug, sort_order)
  VALUES (supplier_uuid, 'Everlast Composite Siding', 'everlast-composite-siding', 180)
  ON CONFLICT (supplier_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
END $$;