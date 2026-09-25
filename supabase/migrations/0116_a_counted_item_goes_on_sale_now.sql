-- 0116 — a counted item goes into the catalogue now, not at posting.
--
-- The trial count at IE Test Shop, second morning: two counters on the floor,
-- the owner at the till, and three new items on the review list with photos
-- already on them. The owner could not do anything with any of them. Pricing
-- a new item in 0114/0115 was a decision recorded against the count and only
-- carried out at posting, and posting (rightly, 0115) waits for every counter
-- to say they are done. So the person at the till sat idle for the whole
-- count, and then priced forty things at once at the end of it.
--
-- The catalogue part never needed to wait. What waits is the NUMBER: another
-- counter may still find more of it on another shelf. So the owner now opens
-- the ordinary product form from the review list — the full one, with trade
-- price, cost, department and the rest — and saving it puts the item in the
-- catalogue there and then, on sale if the form says so. This links the
-- count's new item to that product:
--
--   - every count of it, past and future, lands on the product, exactly as
--     "Same as…" an existing product already did (decision 'merge' with
--     merge_product), and so do counts of anything merged into it;
--   - the counters' photos go onto the product at once, if it has none of
--     its own — the same rule posting applies;
--   - the counters' phones stop listing it as a new item: their catalogue
--     now has the real product, found by the same barcode.
--
-- The stock figure still arrives at posting, by the same rule as everything
-- else: counted, plus whatever has moved since it was counted — so a sale of
-- the new product while the count is still going comes off.

create function public.pos_count_new_item_link(
  p_register_token text, p_pin text, p_item_id uuid, p_product_id uuid
) returns void
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_user public.app_users; v_item public.count_new_items; v_job public.count_jobs;
  v_prod public.products; v_ph record;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_inventory');
  perform public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');

  select n.* into v_item from public.count_new_items n
    join public.count_jobs j on j.id = n.job_id
   where n.id = p_item_id and j.org_id = v_user.org_id
   for update of n;
  if v_item.id is null then raise exception 'Unknown item on this count'; end if;
  select * into v_job from public.count_jobs where id = v_item.job_id;
  if v_job.status <> 'open' then
    raise exception 'That count has already been %', v_job.status;
  end if;
  if v_item.decision = 'merge' then
    raise exception '% is already counted as another item', v_item.name;
  end if;

  select * into v_prod from public.products p
   where p.id = p_product_id and p.org_id = v_user.org_id;
  if v_prod.id is null then raise exception 'That item is not in this shop'; end if;

  -- Twelve "each" are not twelve packs. The count is in the counter's unit,
  -- so the product must be sold in it too — or the stock would be wrong by
  -- a pack size, silently.
  if v_prod.unit_code <> v_item.unit_code then
    raise exception '% was counted in %, and the product is sold in % — make them the same',
      v_item.name, v_item.unit_code, v_prod.unit_code;
  end if;

  -- Its counts land on the product (count_job_resolved: merge_product), and
  -- so do counts of anything merged into it (t.product_id).
  update public.count_new_items
     set decision = 'merge', merge_product = v_prod.id, merge_into = null,
         product_id = v_prod.id
   where id = v_item.id;

  -- The counters' photos, onto a product with none of its own — now, so the
  -- till's search shows the item from the moment it is on sale.
  if v_prod.image_url is null and not exists (
       select 1 from public.product_images i where i.product_id = v_prod.id) then
    for v_ph in
      select x.path, row_number() over (order by x.created_at) as k
        from public.count_job_photos(v_job.id) x
       where x.product_id = v_prod.id
    loop
      exit when v_ph.k > public.count_photo_limit();
      insert into public.product_images (org_id, product_id, url, sort_order)
      values (v_user.org_id, v_prod.id, v_ph.path, v_ph.k::int - 1);
      update public.products set image_url = coalesce(image_url, v_ph.path),
                                 updated_at = now()
       where id = v_prod.id;
    end loop;
  end if;
end;
$$;
grant execute on function public.pos_count_new_item_link(text, text, uuid, uuid)
  to anon, authenticated;


-- The phones: a linked or merged item is no longer "new" -------------------
--
-- Its product is in the catalogue the phone downloads, found by the same
-- barcode or by its real name; listing the count's placeholder beside it
-- would offer the counter two of the same thing. A phone that already holds
-- the placeholder's id still counts against it, and that count still lands
-- on the product. 0114's body otherwise, same signature: replaced in place.

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
       where p.org_id = v_job.org_id and coalesce(p.kind, 'goods') = 'goods'),
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


-- The review list says where a linked item went ----------------------------
--
-- Its price and whether it is on sale, so the owner sees "in the catalogue at
-- R200, on sale" rather than a bare "counted as". Return columns change, so
-- the old one goes first (CLAUDE.md).

drop function if exists public.pos_count_job_new_items(text, text, uuid);

create function public.pos_count_job_new_items(
  p_register_token text, p_pin text, p_job_id uuid
) returns table(id uuid, barcode text, name text, unit_code text,
                counted numeric, captures int, counters text, locations text,
                decision text, merge_into uuid, merge_product uuid,
                merge_product_name text, category_id uuid,
                price_retail numeric, price_trade numeric, cost numeric,
                product_id uuid, photos text[],
                merge_product_price numeric, merge_product_active boolean)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  if not exists (select 1 from public.count_jobs j
                  where j.id = p_job_id and j.org_id = v_org) then
    raise exception 'Unknown count';
  end if;
  return query
    select n.id, n.barcode, n.name, n.unit_code,
           coalesce(sum(c.qty), 0), count(c.id)::int,
           string_agg(distinct k.name, ', '), string_agg(distinct c.location, ', '),
           n.decision, n.merge_into, n.merge_product, mp.name, n.category_id,
           n.price_retail, n.price_trade, n.cost, n.product_id,
           coalesce((select array_agg(ph.path order by ph.created_at)
                       from public.count_photos ph
                       join public.count_captures pc on pc.id = ph.capture_id
                      where pc.new_item_id = n.id and pc.voided_at is null),
                    array[]::text[]),
           mp.price_retail, mp.active
      from public.count_new_items n
      left join public.count_captures c
        on c.new_item_id = n.id and c.voided_at is null
      left join public.count_counters k on k.id = c.counter_id
      left join public.products mp on mp.id = n.merge_product
     where n.job_id = p_job_id
     group by n.id, mp.name, mp.price_retail, mp.active
     order by n.name;
end;
$$;
grant execute on function public.pos_count_job_new_items(text, text, uuid)
  to anon, authenticated;
