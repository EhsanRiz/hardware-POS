-- Fix: pos_admin_import_products declared an OUT column named `sku`, which made
-- every bare reference to products.sku ambiguous, so every row was rejected with
-- "column reference sku is ambiguous". The per-row exception handler turned what
-- would have been a loud failure into a quiet one where the import simply did
-- nothing — worth noting, because a bulk import that silently imports nothing is
-- exactly the kind of thing that looks fine in a demo.
--
-- Table references are now schema-qualified so they cannot collide with OUT
-- parameters.

create or replace function public.pos_admin_import_products(p_pin text, p_rows jsonb)
returns table(row_no int, sku text, outcome text, detail text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user public.app_users;
  v_row  jsonb;
  v_i    int := 0;
  v_sku  text;
  v_cat  uuid;
  v_id   uuid;
begin
  v_user := public.user_with_perm(p_pin, 'manage_catalogue');

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_sku := upper(trim(coalesce(v_row->>'sku', '')));
    begin
      if v_sku = '' then raise exception 'Missing SKU'; end if;

      -- Departments are created on demand so a price list can be pasted whole.
      v_cat := null;
      if coalesce(trim(v_row->>'category'), '') <> '' then
        select c.id into v_cat from public.categories c
          where lower(c.name) = lower(trim(v_row->>'category'));
        if v_cat is null then
          insert into public.categories(name) values (trim(v_row->>'category'))
          returning id into v_cat;
        end if;
      end if;

      select p.id into v_id from public.products p where p.sku = v_sku;

      if v_id is not null then
        update public.products p set
          name          = coalesce(nullif(trim(v_row->>'name'),''), p.name),
          barcode       = coalesce(nullif(trim(v_row->>'barcode'),''), p.barcode),
          category_id   = coalesce(v_cat, p.category_id),
          unit_code     = coalesce(nullif(trim(v_row->>'unit'),''), p.unit_code),
          price_retail  = coalesce((v_row->>'price')::numeric, p.price_retail),
          price_trade   = coalesce((v_row->>'trade')::numeric, p.price_trade),
          cost          = coalesce((v_row->>'cost')::numeric, p.cost),
          reorder_level = coalesce((v_row->>'reorder')::numeric, p.reorder_level)
        where p.id = v_id;
        return query select v_i, v_sku, 'updated'::text, null::text;
      else
        insert into public.products(sku, barcode, name, category_id, unit_code,
          price_retail, price_trade, cost, stock_qty, reorder_level)
        values (v_sku, nullif(trim(v_row->>'barcode'),''),
                nullif(trim(v_row->>'name'),''), v_cat,
                coalesce(nullif(trim(v_row->>'unit'),''), 'ea'),
                (v_row->>'price')::numeric, (v_row->>'trade')::numeric,
                (v_row->>'cost')::numeric, (v_row->>'stock')::numeric,
                (v_row->>'reorder')::numeric)
        returning id into v_id;

        -- Opening stock from an import is still a movement, so the ledger can
        -- explain the balance.
        if (v_row->>'stock') is not null then
          insert into public.stock_movements(product_id, qty_delta, qty_after,
            reason, by_user_id, by_name, note)
          values (v_id, (v_row->>'stock')::numeric, (v_row->>'stock')::numeric,
                  'opening', v_user.id, v_user.name, 'Imported opening stock');
        end if;

        return query select v_i, v_sku, 'created'::text, null::text;
      end if;
    exception when others then
      -- One bad row must not abandon the rest of the price list.
      return query select v_i, v_sku, 'rejected'::text, sqlerrm;
    end;
  end loop;
end;
$$;

grant execute on function public.pos_admin_import_products(text, jsonb) to anon, authenticated;
