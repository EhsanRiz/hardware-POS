-- 0126 — a counted item comes into the catalogue WITH what was counted.
--
-- IE Test Shop: a counter found 20 Celebrex, the owner added it to the
-- catalogue from the count's review list, and the till said "out of stock".
-- 0116 put the item on sale at once but kept its number back until the whole
-- count is posted, because another counter might still find more of it on
-- another shelf. True, and no reason to sell it as if there were none: the
-- 20 are on the shelf now.
--
-- So linking a counted item to a product that has never had stock puts what
-- is counted of it so far on as stock, there and then — a stocktake movement
-- against the count, "counted 20 so far". Posting still settles the rest by
-- the same rule as every other item (counted, plus whatever moved since it
-- was first counted), except that this count's own early movement is not
-- one of the things that "moved since": it is the count, not a sale. So:
--
--   20 counted, linked       stock 20
--   3 sold                   stock 17
--   another counter finds 5  (still 17 — it arrives at posting)
--   posted                   25 counted - 3 sold = 22
--
-- Only a product with no stock history at all takes the early figure — the
-- form's own new product. A count linked to an item that already had stock
-- would replace a real figure with half a count, so that waits for posting
-- as it always did.

-- The early figure, in one place: used by the link and by the catch-up below.
create function public.count_early_stock(
  p_job public.count_jobs, p_product uuid, p_user public.app_users
) returns numeric
language plpgsql security definer set search_path = public, extensions as $$
declare v_prod public.products; v_counted numeric;
begin
  select * into v_prod from public.products
   where id = p_product and org_id = p_job.org_id for update;
  if v_prod.id is null or coalesce(v_prod.stock_qty, 0) <> 0 then return 0; end if;
  if exists (select 1 from public.stock_movements m where m.product_id = p_product) then
    return 0;
  end if;
  select coalesce(sum(x.qty), 0) into v_counted
    from public.count_job_resolved(p_job.id) x where x.product_id = p_product;
  if v_counted = 0 then return 0; end if;
  -- apply_stock moves nothing on a null figure (0058).
  if v_prod.stock_qty is null then
    update public.products set stock_qty = 0 where id = p_product;
  end if;
  perform public.apply_stock(p_product, v_counted, 'stocktake', 'count_jobs', p_job.id,
    p_user, format('%s: counted %s so far', p_job.doc_number, trim_scale(v_counted)), v_prod.cost);
  return v_counted;
end;
$$;
revoke execute on function public.count_early_stock(public.count_jobs, uuid, public.app_users)
  from public, anon, authenticated;


-- The link: 0116's body, plus the early figure. Same arguments and return,
-- so a plain replace.
create or replace function public.pos_count_new_item_link(
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

  -- ADDED (0126): what is counted of it so far goes on the shelf now.
  perform public.count_early_stock(v_job, v_prod.id, v_user);

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


-- Posting: 0115's body, with this count's own early movement left out of
-- "moved since". Same arguments and return, so a plain replace.
create or replace function public.pos_count_job_post(
  p_register_token text, p_pin text, p_job_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_user public.app_users; v_job public.count_jobs; v_n record; v_pid uuid;
  v_r record; v_prod public.products; v_since numeric; v_delta numeric;
  v_created int := 0; v_hidden int := 0; v_moved int := 0; v_counted int := 0;
  v_up numeric := 0; v_down numeric := 0; v_still text; v_photos int := 0;
  v_ph record;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_inventory');
  perform public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');

  select * into v_job from public.count_jobs
   where id = p_job_id and org_id = v_user.org_id for update;
  if v_job.id is null then raise exception 'Unknown count'; end if;
  if v_job.status <> 'open' then
    raise exception 'That count has already been %', v_job.status;
  end if;

  -- Nobody is shut out mid-shelf. A phone taken off the count (active =
  -- false) is the manager's deliberate override and does not hold it up.
  select string_agg(k.name, ', ' order by k.joined_at) into v_still
    from public.count_counters k
   where k.job_id = v_job.id and k.active and k.finished_at is null;
  if v_still is not null then
    raise exception 'Still counting: %. Each presses "I''m done" on their phone first — or take a phone off the count.', v_still;
  end if;

  -- 1. New items become products.
  for v_n in
    select n.* from public.count_new_items n
     where n.job_id = v_job.id and n.decision in ('add', 'pending')
       -- Counted itself, or something counted was merged into it.
       and exists (select 1 from public.count_captures c
                    left join public.count_new_items m on m.id = c.new_item_id
                    where c.voided_at is null
                      and (c.new_item_id = n.id
                           or (m.decision = 'merge' and m.merge_into = n.id)))
     order by n.created_at
  loop
    v_pid := null;
    if v_n.barcode is not null then
      select p.id into v_pid from public.products p
       where p.org_id = v_user.org_id and p.barcode = v_n.barcode;
    end if;
    if v_pid is null then
      insert into public.products (org_id, sku, barcode, name, category_id,
        unit_code, price_retail, price_trade, cost, stock_qty, active)
      values (v_user.org_id, public.next_sku(v_user.org_id), v_n.barcode,
              v_n.name, v_n.category_id, v_n.unit_code,
              coalesce(v_n.price_retail, 0), v_n.price_trade, v_n.cost, 0,
              v_n.decision = 'add')
      returning id into v_pid;
      v_created := v_created + 1;
      if v_n.decision = 'pending' then v_hidden := v_hidden + 1; end if;
    end if;
    update public.count_new_items set product_id = v_pid where id = v_n.id;
  end loop;

  -- 2. Every counted product, to counted + since.
  for v_r in
    select x.product_id as pid, sum(x.qty) as counted,
           min(x.captured_at) as first_at
      from public.count_job_resolved(v_job.id) x
     where x.product_id is not null
     group by x.product_id
  loop
    select * into v_prod from public.products
     where id = v_r.pid and org_id = v_user.org_id for update;
    if v_prod.id is null then continue; end if;
    v_counted := v_counted + 1;

    -- Counted means tracked from here on. apply_stock moves nothing on a
    -- null figure (0058), so the zero has to be there first.
    if v_prod.stock_qty is null then
      update public.products set stock_qty = 0 where id = v_prod.id;
      v_prod.stock_qty := 0;
    end if;

    select coalesce(sum(m.qty_delta), 0) into v_since
      from public.stock_movements m
     where m.product_id = v_prod.id and m.created_at > v_r.first_at
       -- ADDED (0126): not this count's own early figure. It is what the
       -- counted total below already stands for, not a sale or delivery.
       and (m.ref_table, m.ref_id) is distinct from ('count_jobs', v_job.id);

    v_delta := v_r.counted + v_since - v_prod.stock_qty;
    if v_delta <> 0 then
      perform public.apply_stock(
        v_prod.id, v_delta, 'stocktake', 'count_jobs', v_job.id, v_user,
        case when v_since = 0
             then format('%s: counted %s', v_job.doc_number, v_r.counted)
             else format('%s: counted %s, %s since', v_job.doc_number,
                         v_r.counted, v_since) end,
        v_prod.cost);
      v_moved := v_moved + 1;
      if v_delta > 0 then v_up := v_up + v_delta; else v_down := v_down - v_delta; end if;
    end if;
  end loop;

  -- 3. Photos: to a product with none, up to the limit, in the order taken.
  --    A product that already has a picture keeps exactly what it has.
  for v_ph in
    select x.product_id as pid, x.path,
           row_number() over (partition by x.product_id order by x.created_at) as k
      from public.count_job_photos(v_job.id) x
      join public.products p on p.id = x.product_id and p.org_id = v_user.org_id
     where not exists (select 1 from public.product_images i
                        where i.product_id = x.product_id)
       and p.image_url is null
  loop
    continue when v_ph.k > public.count_photo_limit();
    insert into public.product_images (org_id, product_id, url, sort_order)
    values (v_user.org_id, v_ph.pid, v_ph.path, v_ph.k::int - 1);
    update public.products set image_url = coalesce(image_url, v_ph.path),
                               updated_at = now()
     where id = v_ph.pid;
    v_photos := v_photos + 1;
  end loop;

  update public.count_jobs
     set status = 'posted', posted_at = now(),
         posted_by = v_user.id, posted_by_name = v_user.name
   where id = v_job.id;

  return jsonb_build_object('products_counted', v_counted,
                            'products_created', v_created,
                            'created_hidden', v_hidden,
                            'lines_moved', v_moved,
                            'units_up', v_up, 'units_down', v_down,
                            'photos', v_photos);
end;
$$;
grant execute on function public.pos_count_job_post(text, text, uuid)
  to anon, authenticated;


-- The review's "what posting will do", by the same rule. 0114's body with
-- the one condition; same columns, so a plain replace.
create or replace function public.pos_count_job_counted(
  p_register_token text, p_pin text, p_job_id uuid
) returns table(product_id uuid, sku text, name text, unit_code text,
                counted numeric, captures int, counters text, locations text,
                first_counted_at timestamptz, on_hand numeric, since numeric,
                becomes numeric)
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
    with r as (
      select * from public.count_job_resolved(p_job_id) x
       where x.product_id is not null
    ), agg as (
      select r.product_id as pid, sum(r.qty) as counted, count(*)::int as n,
             string_agg(distinct r.counter_name, ', ') as who,
             string_agg(distinct r.location, ', ') as wherever,
             min(r.captured_at) as first_at
        from r group by r.product_id
    )
    select a.pid, p.sku, p.name, p.unit_code, a.counted, a.n, a.who, a.wherever,
           a.first_at, p.stock_qty, s.since, a.counted + s.since
      from agg a
      join public.products p on p.id = a.pid
      cross join lateral (
        select coalesce(sum(m.qty_delta), 0)::numeric as since
          from public.stock_movements m
         where m.product_id = a.pid and m.created_at > a.first_at
           -- ADDED (0126): not this count's own early figure.
           and (m.ref_table, m.ref_id) is distinct from ('count_jobs', p_job_id)
      ) s
     order by p.name;
end;
$$;
grant execute on function public.pos_count_job_counted(text, text, uuid)
  to anon, authenticated;


-- The items already linked on a count still open — Celebrex at IE — take
-- their early figure now, recorded against whoever opened the count.
do $$
declare v_n record; v_user public.app_users;
begin
  for v_n in
    select j.*, n.product_id as pid from public.count_new_items n
      join public.count_jobs j on j.id = n.job_id
     where j.status = 'open' and n.decision = 'merge'
       and n.product_id is not null and n.product_id = n.merge_product
  loop
    select * into v_user from public.app_users where id = v_n.opened_by;
    continue when v_user.id is null;
    perform public.count_early_stock(
      (select j from public.count_jobs j where j.id = v_n.id), v_n.pid, v_user);
  end loop;
end;
$$;
