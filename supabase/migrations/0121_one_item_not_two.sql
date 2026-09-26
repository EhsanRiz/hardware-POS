-- 0121 — one item, not two: merge a duplicate into the item it duplicates.
--
-- Duplicates happen. A delivery line nobody recognised becomes a new item
-- beside the one already on the shelf; the same thing arrives from a second
-- supplier under other words; two people capture it at the shelf. 5 Star
-- already has Stay Peg 150mm twice and ALUMINIUM DOOR FANCY RIGHT three times.
-- Until now the only way out was to keep selling both, or to delete one and
-- lose its history.
--
-- pos_admin_merge_product(keep, duplicate) folds the duplicate into the item
-- being kept, in one transaction:
--
--   stock        moved across as a pair of stock movements, "Merged into …"
--                on the duplicate and "Merged from …" on the kept item, so
--                both ledgers still add up and say why
--   what points  supplier codes (so the next delivery finds the kept item),
--   at it        delivery lines, sale, return and quote lines, order lines,
--                count captures, photos — reports then show one item
--   barcode      the duplicate's, when the kept item has none
--   duplicate    taken off sale and marked merged_into, never deleted: its
--                own stock history stays readable, and nothing is lost
--
-- The catalogue and a count no longer list it.
--
-- Refused, with a sentence, when the two cannot honestly be one item: a
-- different unit (a length and a bag), one sold in packs and one not, stock
-- counted for one and not the other, both on a count still open, or either
-- already merged away.
--
-- Two lines for one product on the same order are added together, because an
-- order has one line per product. A count already posted keeps its own line
-- for the duplicate: that count happened, as it happened.

alter table public.products
  add column if not exists merged_into uuid references public.products(id);

create function public.pos_admin_merge_product(
  p_register_token text, p_pin text, p_keep uuid, p_duplicate uuid
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user public.app_users; v_keep public.products; v_dup public.products;
  v_moved numeric := 0; v_codes int; v_sales int; v_lines int;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  if p_keep = p_duplicate then
    raise exception 'An item cannot be merged into itself';
  end if;

  -- Both locked, in id order, so two merges touching the same pair cannot
  -- deadlock each other.
  perform 1 from public.products p
   where p.id in (p_keep, p_duplicate) and p.org_id = v_user.org_id
   order by p.id for update;
  select * into v_keep from public.products p where p.id = p_keep and p.org_id = v_user.org_id;
  if not found then raise exception 'Product not found'; end if;
  select * into v_dup from public.products p where p.id = p_duplicate and p.org_id = v_user.org_id;
  if not found then raise exception 'Product not found'; end if;

  if v_dup.merged_into is not null then
    raise exception '% was already merged into another item', v_dup.name;
  end if;
  if v_keep.merged_into is not null then
    raise exception '% was merged away. Merge into the item it went to instead.', v_keep.name;
  end if;
  if v_keep.unit_code <> v_dup.unit_code then
    raise exception '% is sold by the % and % by the % — they cannot be one item',
      v_keep.name, v_keep.unit_code, v_dup.name, v_dup.unit_code;
  end if;
  if coalesce(v_keep.sold_in_packs, false) <> coalesce(v_dup.sold_in_packs, false)
     or (coalesce(v_keep.sold_in_packs, false)
         and v_keep.pack_size is distinct from v_dup.pack_size) then
    raise exception '% and % are not sold in the same packs — they cannot be one item',
      v_keep.name, v_dup.name;
  end if;
  if (v_keep.stock_qty is null) <> (v_dup.stock_qty is null) then
    raise exception 'Stock is counted for one of these and not the other — they cannot be one item';
  end if;
  if exists (
    select 1 from public.stock_count_lines a
      join public.stock_count_lines b on b.count_id = a.count_id
      join public.stock_counts s on s.id = a.count_id
     where a.product_id = p_keep and b.product_id = p_duplicate and s.status = 'open'
  ) then
    raise exception 'Both are on a stock count that is still open. Finish or abandon the count first.';
  end if;

  -- The stock, as two movements that say what happened.
  if v_dup.stock_qty is not null and v_dup.stock_qty <> 0 then
    v_moved := v_dup.stock_qty;
    perform public.apply_stock(p_duplicate, -v_moved, 'adjustment', 'products', p_keep,
      v_user, 'Merged into ' || v_keep.name);
    perform public.apply_stock(p_keep, v_moved, 'adjustment', 'products', p_duplicate,
      v_user, 'Merged from ' || v_dup.name, v_dup.cost);
  end if;

  -- Everything that points at the duplicate points at the kept item.
  update public.supplier_product_codes set product_id = p_keep where product_id = p_duplicate;
  get diagnostics v_codes = row_count;
  update public.supplier_document_lines set product_id = p_keep where product_id = p_duplicate;
  update public.sale_items set product_id = p_keep where product_id = p_duplicate;
  get diagnostics v_sales = row_count;
  update public.return_items set product_id = p_keep where product_id = p_duplicate;
  update public.quote_items set product_id = p_keep where product_id = p_duplicate;

  -- One line per product on an order: two become one.
  update public.purchase_order_lines k
     set qty = k.qty + d.qty, received_qty = k.received_qty + d.received_qty
    from public.purchase_order_lines d
   where k.po_id = d.po_id and k.product_id = p_keep and d.product_id = p_duplicate;
  delete from public.purchase_order_lines d
   where d.product_id = p_duplicate
     and exists (select 1 from public.purchase_order_lines k
                  where k.po_id = d.po_id and k.product_id = p_keep);
  update public.purchase_order_lines set product_id = p_keep where product_id = p_duplicate;
  get diagnostics v_lines = row_count;

  -- A count keeps its own line where it already has one for the kept item.
  update public.stock_count_lines d set product_id = p_keep
   where d.product_id = p_duplicate
     and not exists (select 1 from public.stock_count_lines k
                      where k.count_id = d.count_id and k.product_id = p_keep);
  update public.count_captures set product_id = p_keep where product_id = p_duplicate;
  update public.count_new_items set product_id = p_keep where product_id = p_duplicate;
  update public.count_new_items set merge_product = p_keep where merge_product = p_duplicate;

  -- Photos after the kept item's own.
  update public.product_images set product_id = p_keep, sort_order = sort_order + 1000
   where product_id = p_duplicate;
  if v_keep.image_url is null and v_dup.image_url is not null then
    update public.products set image_url = v_dup.image_url where id = p_keep;
  end if;

  -- The barcode, when the kept item has none. Off the duplicate first: a
  -- barcode is on one item at a time (0113).
  if v_keep.barcode is null and v_dup.barcode is not null then
    update public.products set barcode = null where id = p_duplicate;
    update public.products set barcode = v_dup.barcode where id = p_keep;
  end if;

  update public.products set active = false, merged_into = p_keep where id = p_duplicate;

  return jsonb_build_object(
    'kept', v_keep.name, 'merged', v_dup.name, 'stock_moved', v_moved,
    'supplier_codes', v_codes, 'sale_lines', v_sales,
    'barcode_kept', case when v_keep.barcode is not null and v_dup.barcode is not null
                         then v_dup.barcode end,
    'stock_now', (select p.stock_qty from public.products p where p.id = p_keep));
end;
$$;
grant execute on function public.pos_admin_merge_product(text, text, uuid, uuid)
  to anon, authenticated;


-- The catalogue no longer lists what was merged away: it is not an item any
-- more, only a record of one. Same columns, so a plain replace; the body is
-- 0107's with the one condition added.
create or replace function public.pos_admin_list_products(p_register_token text, p_pin text)
returns table(id uuid, sku text, barcode text, name text, description text,
  category_id uuid, category_name text, unit_code text, price_retail numeric,
  price_trade numeric, cost numeric, tax_code text, stock_qty numeric,
  reorder_level numeric, active boolean, image_url text, bin text,
  max_discount_percent numeric, max_discount_amount numeric,
  sold_in_packs boolean, pack_size numeric, pack_label text,
  price_cut_retail numeric, price_cut_trade numeric)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  return query
    select p.id, p.sku, p.barcode, p.name, p.description, p.category_id, c.name,
           p.unit_code, p.price_retail, p.price_trade, p.cost, p.tax_code,
           p.stock_qty, p.reorder_level, p.active, p.image_url, p.bin,
           p.max_discount_percent, p.max_discount_amount,
           p.sold_in_packs, p.pack_size, p.pack_label,
           p.price_cut_retail, p.price_cut_trade
    from public.products p
    left join public.categories c on c.id = p.category_id
    where p.org_id = v_user.org_id
      and p.merged_into is null   -- ADDED (0121)
    order by p.name;
end;
$$;


-- Nor does a count: a phone counting for the shop is not asked about an item
-- that no longer exists as one. 0116's body with the one condition added.
create or replace function public.pos_count_state(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_c public.count_counters; v_job public.count_jobs; v_shop text;
begin
  v_c := public.count_counter_for(p_token);
  select * into v_job from public.count_jobs where id = v_c.job_id;
  select name into v_shop from public.organizations where id = v_job.org_id;
  return jsonb_build_object(
    'job', jsonb_build_object('id', v_job.id, 'doc_number', v_job.doc_number,
                              'note', v_job.note, 'shop_name', v_shop),
    'counter', jsonb_build_object('id', v_c.id, 'name', v_c.name),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'sku', p.sku, 'barcode', p.barcode,
               'unit_code', p.unit_code) order by p.name)
        from public.products p
       where p.org_id = v_job.org_id and coalesce(p.kind, 'goods') = 'goods'
         and p.merged_into is null),   -- ADDED (0121)
      '[]'::jsonb),
    'new_items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', n.id, 'name', n.name, 'barcode', n.barcode,
               'unit_code', n.unit_code) order by n.name)
        from public.count_new_items n
       where n.job_id = v_job.id and n.decision not in ('skip', 'merge')),
      '[]'::jsonb),
    'units', (
      select jsonb_agg(jsonb_build_object(
               'code', u.code, 'name', u.name,
               'allows_fraction', u.allows_fraction) order by u.sort_order)
        from public.units_of_measure u)
  );
end;
$$;
grant execute on function public.pos_count_state(text) to anon, authenticated;
