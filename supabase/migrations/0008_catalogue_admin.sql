-- Hardware POS — catalogue administration.
--
-- Everything here is PIN-gated and permission-checked server-side. Cost prices
-- are the one field that is conditionally withheld: `view_cost_prices` is a
-- separate permission from `manage_catalogue`, so a counter supervisor can fix
-- a price or a barcode without seeing the shop's margins.

-- Products -------------------------------------------------------------------

create function public.pos_admin_list_products(p_pin text)
returns table(id uuid, sku text, barcode text, name text, description text,
              category_id uuid, category_name text, unit_code text,
              price_retail numeric, price_trade numeric, cost numeric,
              tax_code text, stock_qty numeric, reorder_level numeric,
              image_url text, active boolean, sort_order int)
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_costs boolean;
begin
  v_user := public.user_with_perm(p_pin, 'manage_catalogue');
  v_costs := 'view_cost_prices' = any(public.effective_permissions(v_user));

  return query
    select p.id, p.sku, p.barcode, p.name, p.description,
           p.category_id, c.name, p.unit_code,
           p.price_retail, p.price_trade,
           case when v_costs then p.cost end,
           p.tax_code, p.stock_qty, p.reorder_level,
           p.image_url, p.active, p.sort_order
    from public.products p
    left join public.categories c on c.id = p.category_id
    order by p.active desc, c.sort_order nulls last, p.name;
end;
$$;

-- Create (omit id) or update a product.
create function public.pos_admin_save_product(
  p_pin text,
  p_id uuid,
  p_sku text,
  p_barcode text,
  p_name text,
  p_description text,
  p_category_id uuid,
  p_unit_code text,
  p_price_retail numeric,
  p_price_trade numeric,
  p_cost numeric,
  p_tax_code text,
  p_stock_qty numeric,
  p_reorder_level numeric,
  p_active boolean,
  p_image_url text default null
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user public.app_users;
  v_prod public.products;
  v_old  public.products;
  v_sku  text := upper(trim(p_sku));
  v_bar  text := nullif(trim(p_barcode), '');
begin
  v_user := public.user_with_perm(p_pin, 'manage_catalogue');

  if v_sku is null or v_sku = '' then raise exception 'A SKU is required'; end if;
  if trim(coalesce(p_name,'')) = '' then raise exception 'A name is required'; end if;
  if p_price_retail is null or p_price_retail < 0 then
    raise exception 'A retail price is required';
  end if;
  if not exists (select 1 from public.units_of_measure where code = p_unit_code) then
    raise exception 'Unknown unit: %', p_unit_code;
  end if;

  -- Barcodes and SKUs are unique, and a duplicate scan would ring up the wrong
  -- item, so name the clash rather than leaving a raw constraint error.
  if exists (select 1 from public.products
             where sku = v_sku and (p_id is null or id <> p_id)) then
    raise exception 'SKU % is already used', v_sku;
  end if;
  if v_bar is not null and exists (select 1 from public.products
             where barcode = v_bar and (p_id is null or id <> p_id)) then
    raise exception 'Barcode % is already used by another product', v_bar;
  end if;

  if p_id is null then
    insert into public.products(
      sku, barcode, name, description, category_id, unit_code, price_retail,
      price_trade, cost, tax_code, stock_qty, reorder_level, active, image_url)
    values (v_sku, v_bar, trim(p_name), nullif(trim(p_description),''),
            p_category_id, p_unit_code, p_price_retail, p_price_trade, p_cost,
            coalesce(p_tax_code,'standard'), p_stock_qty, p_reorder_level,
            coalesce(p_active,true), p_image_url)
    returning * into v_prod;

    -- Opening stock is a stock movement like any other, so the ledger explains
    -- every unit on hand from the moment the product exists.
    if v_prod.stock_qty is not null and v_prod.stock_qty <> 0 then
      insert into public.stock_movements(product_id, qty_delta, qty_after,
        reason, by_user_id, by_name, note)
      values (v_prod.id, v_prod.stock_qty, v_prod.stock_qty, 'opening',
              v_user.id, v_user.name, 'Opening stock');
    end if;
  else
    select * into v_old from public.products where id = p_id;
    if not found then raise exception 'Product not found'; end if;

    update public.products set
      sku = v_sku, barcode = v_bar, name = trim(p_name),
      description = nullif(trim(p_description),''), category_id = p_category_id,
      unit_code = p_unit_code, price_retail = p_price_retail,
      price_trade = p_price_trade,
      -- A null cost from a user who cannot see costs must not erase the real
      -- one; only an explicit value from someone permitted to see it applies.
      cost = case when 'view_cost_prices' = any(public.effective_permissions(v_user))
                  then p_cost else v_old.cost end,
      tax_code = coalesce(p_tax_code,'standard'),
      reorder_level = p_reorder_level,
      active = coalesce(p_active, true),
      image_url = coalesce(p_image_url, v_old.image_url)
    where id = p_id
    returning * into v_prod;

    -- Stock is deliberately NOT settable here. Changing it silently would leave
    -- the movement ledger unable to explain the balance; use adjust_stock.
    if p_stock_qty is distinct from v_old.stock_qty then
      if v_old.stock_qty is null or p_stock_qty is null then
        -- Turning tracking on or off is a legitimate structural change.
        update public.products set stock_qty = p_stock_qty where id = p_id
        returning * into v_prod;
        if p_stock_qty is not null then
          insert into public.stock_movements(product_id, qty_delta, qty_after,
            reason, by_user_id, by_name, note)
          values (p_id, p_stock_qty, p_stock_qty, 'opening', v_user.id,
                  v_user.name, 'Started tracking stock');
        end if;
      else
        raise exception
          'Use the stock adjustment to change quantity, so the movement is recorded';
      end if;
    end if;
  end if;

  return v_prod;
end;
$$;

-- Retire a product. Anything that has ever been sold is deactivated rather than
-- deleted: the invoice it appears on must stay explainable.
create function public.pos_admin_delete_product(p_pin text, p_id uuid)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_sold boolean;
begin
  perform public.user_with_perm(p_pin, 'manage_catalogue');

  select exists (select 1 from public.sale_items where product_id = p_id)
    into v_sold;

  if v_sold then
    update public.products set active = false where id = p_id;
    return 'deactivated';
  end if;

  delete from public.stock_movements where product_id = p_id;
  delete from public.products where id = p_id;
  return 'deleted';
end;
$$;

-- Stock ----------------------------------------------------------------------

-- Set stock to a counted figure. The difference is written to the ledger with a
-- reason, so "why does it think we have nine?" always has an answer.
create function public.pos_admin_adjust_stock(
  p_pin text, p_product_id uuid, p_new_qty numeric, p_note text default null
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_prod public.products; v_delta numeric;
begin
  v_user := public.user_with_perm(p_pin, 'manage_inventory');

  select * into v_prod from public.products where id = p_product_id for update;
  if not found then raise exception 'Product not found'; end if;
  if v_prod.stock_qty is null then
    raise exception 'Stock is not tracked for %', v_prod.name;
  end if;
  if p_new_qty is null or p_new_qty < 0 then
    raise exception 'Counted quantity cannot be negative';
  end if;

  v_delta := p_new_qty - v_prod.stock_qty;
  if v_delta = 0 then return v_prod; end if;

  perform public.apply_stock(p_product_id, v_delta, 'adjustment', null, null,
                             v_user, coalesce(p_note, 'Manual adjustment'));

  select * into v_prod from public.products where id = p_product_id;
  return v_prod;
end;
$$;

create function public.pos_admin_stock_history(
  p_pin text, p_product_id uuid, p_limit int default 50
) returns table(at timestamptz, qty_delta numeric, qty_after numeric,
                reason stock_reason, by_name text, note text)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.user_with_perm(p_pin, 'manage_inventory');
  return query
    select m.created_at, m.qty_delta, m.qty_after, m.reason, m.by_name, m.note
    from public.stock_movements m
    where m.product_id = p_product_id
    order by m.created_at desc
    limit least(greatest(p_limit, 1), 200);
end;
$$;

-- Categories -----------------------------------------------------------------

create function public.pos_admin_save_category(
  p_pin text, p_id uuid, p_name text, p_sort_order int, p_active boolean
) returns public.categories
language plpgsql security definer set search_path = public, extensions as $$
declare v_cat public.categories;
begin
  perform public.user_with_perm(p_pin, 'manage_catalogue');
  if trim(coalesce(p_name,'')) = '' then raise exception 'A name is required'; end if;

  if p_id is null then
    insert into public.categories(name, sort_order, active)
    values (trim(p_name), coalesce(p_sort_order,0), coalesce(p_active,true))
    returning * into v_cat;
  else
    update public.categories
       set name = trim(p_name), sort_order = coalesce(p_sort_order,0),
           active = coalesce(p_active,true)
     where id = p_id returning * into v_cat;
    if not found then raise exception 'Category not found'; end if;
  end if;
  return v_cat;
end;
$$;

-- Delete a department, moving its products somewhere rather than orphaning them.
create function public.pos_admin_delete_category(
  p_pin text, p_id uuid, p_reassign_to uuid default null
) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.user_with_perm(p_pin, 'manage_catalogue');
  update public.products set category_id = p_reassign_to where category_id = p_id;
  delete from public.categories where id = p_id;
end;
$$;

-- Bulk import ------------------------------------------------------------------

-- NOTE: the first version of pos_admin_import_products is superseded by 0009,
-- which fixes an ambiguity between its OUT column `sku` and `products.sku`.
create function public.pos_admin_import_products(p_pin text, p_rows jsonb)
returns table(row_no int, sku text, outcome text, detail text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user public.app_users;
  v_row  jsonb;
  v_i    int := 0;
  v_sku  text;
  v_cat  uuid;
  v_existing public.products;
begin
  v_user := public.user_with_perm(p_pin, 'manage_catalogue');

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_sku := upper(trim(coalesce(v_row->>'sku', '')));
    begin
      if v_sku = '' then raise exception 'Missing SKU'; end if;

      v_cat := null;
      if coalesce(trim(v_row->>'category'), '') <> '' then
        select id into v_cat from public.categories
          where lower(name) = lower(trim(v_row->>'category'));
        if v_cat is null then
          insert into public.categories(name) values (trim(v_row->>'category'))
          returning id into v_cat;
        end if;
      end if;

      select * into v_existing from public.products where sku = v_sku;

      if found then
        update public.products set
          name          = coalesce(nullif(trim(v_row->>'name'),''), name),
          barcode       = coalesce(nullif(trim(v_row->>'barcode'),''), barcode),
          category_id   = coalesce(v_cat, category_id),
          unit_code     = coalesce(nullif(trim(v_row->>'unit'),''), unit_code),
          price_retail  = coalesce((v_row->>'price')::numeric, price_retail),
          price_trade   = coalesce((v_row->>'trade')::numeric, price_trade),
          cost          = coalesce((v_row->>'cost')::numeric, cost),
          reorder_level = coalesce((v_row->>'reorder')::numeric, reorder_level)
        where id = v_existing.id;
        return query select v_i, v_sku, 'updated'::text, null::text;
      else
        insert into public.products(sku, barcode, name, category_id, unit_code,
          price_retail, price_trade, cost, stock_qty, reorder_level)
        values (v_sku, nullif(trim(v_row->>'barcode'),''),
                nullif(trim(v_row->>'name'),''), v_cat,
                coalesce(nullif(trim(v_row->>'unit'),''), 'ea'),
                (v_row->>'price')::numeric, (v_row->>'trade')::numeric,
                (v_row->>'cost')::numeric, (v_row->>'stock')::numeric,
                (v_row->>'reorder')::numeric);
        return query select v_i, v_sku, 'created'::text, null::text;
      end if;
    exception when others then
      -- One bad row must not abandon the rest of the price list.
      return query select v_i, v_sku, 'rejected'::text, sqlerrm;
    end;
  end loop;
end;
$$;

-- Shop settings ----------------------------------------------------------------

create function public.pos_admin_save_settings(p_pin text, p_settings jsonb)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_key text;
begin
  perform public.user_with_perm(p_pin, 'manage_settings');
  for v_key in select jsonb_object_keys(p_settings) loop
    update public.settings
       set value = p_settings->>v_key, updated_at = now()
     where key = v_key;
  end loop;
end;
$$;

-- Grants -------------------------------------------------------------------------

grant execute on function public.pos_admin_list_products(text)          to anon, authenticated;
grant execute on function public.pos_admin_save_product(text, uuid, text, text, text, text, uuid, text, numeric, numeric, numeric, text, numeric, numeric, boolean, text) to anon, authenticated;
grant execute on function public.pos_admin_delete_product(text, uuid)   to anon, authenticated;
grant execute on function public.pos_admin_adjust_stock(text, uuid, numeric, text) to anon, authenticated;
grant execute on function public.pos_admin_stock_history(text, uuid, int) to anon, authenticated;
grant execute on function public.pos_admin_save_category(text, uuid, text, int, boolean) to anon, authenticated;
grant execute on function public.pos_admin_delete_category(text, uuid, uuid) to anon, authenticated;
grant execute on function public.pos_admin_import_products(text, jsonb) to anon, authenticated;
grant execute on function public.pos_admin_save_settings(text, jsonb)   to anon, authenticated;
