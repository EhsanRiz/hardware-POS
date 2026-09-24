-- 0115 — a counter says when they are done, and takes photos as they go.
--
-- The first real count at the trial shop found two things 0114 got wrong.
--
-- ONE: POSTING SHUT A COUNTER OUT MID-SHELF. The manager posted the count at
-- 16:00 while the counter's phone was half-way through writing down the next
-- item; the phone then said "This count has finished" and the item was lost.
-- In 0114 the only thing that ended a counter's count was the till. That is
-- the wrong way round: the person on the shelf is the one who knows whether
-- the shelf is finished. So a counter now says "I'm done" on their own phone,
-- can take it back ("carry on") until the count is posted, and posting is
-- REFUSED while anybody on the count has not said so. The manager keeps one
-- way to override — taking a phone off the count, for the lost phone or the
-- counter who went home — and it is a deliberate act with a name on it.
--
-- TWO: NO PHOTOGRAPHS. A counter writing down "Andolex" for something the
-- catalogue has never heard of is the one person who can see what it is, and
-- the reviewer pricing it later cannot. So a count carries photos: taken on
-- the phone against a capture, stored like product photos (the product-image
-- function, now also opened by a counter's token), shown to the reviewer, and
-- at posting given to the product — to a new product always, and to an
-- existing one only if it has no photo of its own. A counter never adds to,
-- or replaces, a shop's own pictures.

alter table public.count_counters
  add column if not exists finished_at timestamptz;

create table public.count_photos (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.count_jobs(id) on delete cascade,
  counter_id  uuid not null references public.count_counters(id) on delete cascade,
  capture_id  uuid not null references public.count_captures(id) on delete cascade,
  -- Made on the phone, like a capture's: a photo sent twice is stored once.
  photo_ref   text not null,
  -- A storage path in the product-images bucket, as product_images.url is.
  path        text not null,
  created_at  timestamptz not null default now(),
  constraint count_photos_ref_unique unique (counter_id, photo_ref)
);
create index count_photos_job_idx on public.count_photos (job_id);
create index count_photos_capture_idx on public.count_photos (capture_id);
alter table public.count_photos enable row level security;

/** As many photos as one stop at a shelf is worth — the shelf screen's four. */
create function public.count_photo_limit() returns int
language sql immutable set search_path = public, extensions as $$ select 4 $$;
revoke execute on function public.count_photo_limit() from public, anon, authenticated;


-- Done, and not done after all ------------------------------------------------

/**
 * "I'm done." Said by the counter, about themselves. The phone checks first
 * that nothing it holds is still unsent; the server cannot see the phone.
 */
create function public.pos_count_finish(p_token text)
returns timestamptz
language plpgsql security definer
set search_path = public, extensions as $$
declare v_c public.count_counters; v_at timestamptz;
begin
  v_c := public.count_counter_for(p_token);
  update public.count_counters set finished_at = coalesce(finished_at, now()),
                                   last_seen_at = now()
   where id = v_c.id
  returning finished_at into v_at;
  return v_at;
end;
$$;
grant execute on function public.pos_count_finish(text) to anon, authenticated;

/** "I'm not done." Until the count is posted, a counter can always go back. */
create function public.pos_count_resume(p_token text)
returns void
language plpgsql security definer
set search_path = public, extensions as $$
declare v_c public.count_counters;
begin
  v_c := public.count_counter_for(p_token);
  update public.count_counters set finished_at = null, last_seen_at = now()
   where id = v_c.id;
end;
$$;
grant execute on function public.pos_count_resume(text) to anon, authenticated;


-- A capture from somebody who said they were done ----------------------------
--
-- Refused, with the way back in the sentence. The manager may be about to
-- post on the strength of that "done", and a count arriving underneath it
-- would be posted or lost depending on which came first. 0114's body
-- otherwise, same signature: replaced in place.

create or replace function public.pos_count_capture(
  p_token text, p_client_ref text, p_product_id uuid, p_new_item_id uuid,
  p_barcode text, p_name text, p_unit_code text, p_qty numeric,
  p_location text, p_captured_at timestamptz
) returns jsonb
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_c public.count_counters; v_job public.count_jobs; v_ref text;
  v_hit public.count_captures; v_product uuid; v_item uuid; v_unit text;
  v_code text; v_name text; v_key text; v_frac boolean; v_qty numeric;
  v_label text; v_at timestamptz;
begin
  v_c := public.count_counter_for(p_token);
  select * into v_job from public.count_jobs where id = v_c.job_id;

  v_ref := btrim(coalesce(p_client_ref, ''));
  if v_ref = '' then raise exception 'A capture needs a reference'; end if;

  -- Sent twice through a bad signal: the first one stands. Checked before
  -- "done", so a count that was sent, then said done, then re-sent by a
  -- phone that never heard the answer is still the same count.
  select * into v_hit from public.count_captures c
   where c.counter_id = v_c.id and c.client_ref = v_ref;
  if v_hit.id is not null then
    return jsonb_build_object('id', v_hit.id, 'product_id', v_hit.product_id,
                              'new_item_id', v_hit.new_item_id, 'repeat', true);
  end if;

  if v_c.finished_at is not null then
    raise exception 'You said you were done — tap Carry on counting first';
  end if;

  v_qty := round(p_qty, 3);
  if v_qty is null then raise exception 'How many are there?'; end if;
  if v_qty < 0 then raise exception 'A shelf cannot hold less than nothing'; end if;
  if v_qty > 1000000 then raise exception 'That is more than any shelf holds — check the number'; end if;

  v_code := nullif(btrim(coalesce(p_barcode, '')), '');
  v_name := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');

  if p_product_id is not null then
    select p.id, p.unit_code, p.name into v_product, v_unit, v_label
      from public.products p
     where p.id = p_product_id and p.org_id = v_job.org_id;
    if v_product is null then raise exception 'That item is not in this shop'; end if;
  elsif p_new_item_id is not null then
    select n.id, n.unit_code, n.name into v_item, v_unit, v_label
      from public.count_new_items n
     where n.id = p_new_item_id and n.job_id = v_job.id;
    if v_item is null then raise exception 'That item is not on this count'; end if;
  else
    -- The catalogue first: exact barcode, or the shop's own code case-folded,
    -- the same two a scan at the till tries (lib/search, 0112).
    if v_code is not null then
      select p.id, p.unit_code, p.name into v_product, v_unit, v_label
        from public.products p
       where p.org_id = v_job.org_id
         and (p.barcode = v_code or lower(p.sku) = lower(v_code))
       order by (p.barcode = v_code) desc
       limit 1;
    end if;

    if v_product is null then
      if v_code is not null then
        v_key := 'b:' || v_code;
      else
        if v_name is null then
          raise exception 'Say what it is: a name, or its barcode';
        end if;
        v_key := 'n:' || public.count_fold(v_name) || '|' || coalesce(p_unit_code, 'ea');
      end if;

      select n.id, n.unit_code, n.name into v_item, v_unit, v_label
        from public.count_new_items n
       where n.job_id = v_job.id and n.match_key = v_key;

      if v_item is null then
        if v_name is null then
          raise exception 'Nobody has named this one yet — type what it is';
        end if;
        if length(v_name) > 120 then
          raise exception 'Keep the name under 120 letters';
        end if;
        if not exists (select 1 from public.units_of_measure u
                        where u.code = coalesce(p_unit_code, 'ea')) then
          raise exception 'Unknown unit %', p_unit_code;
        end if;
        insert into public.count_new_items
          (job_id, match_key, barcode, name, unit_code, created_by)
        values (v_job.id, v_key, v_code, v_name, coalesce(p_unit_code, 'ea'), v_c.id)
        on conflict (job_id, match_key) do nothing;
        select n.id, n.unit_code, n.name into v_item, v_unit, v_label
          from public.count_new_items n
         where n.job_id = v_job.id and n.match_key = v_key;
      end if;
    end if;
  end if;

  -- 2.5 padlocks is a typo, whoever typed it (README).
  select u.allows_fraction into v_frac from public.units_of_measure u
   where u.code = v_unit;
  if not coalesce(v_frac, false) and v_qty <> trunc(v_qty) then
    raise exception '% is counted in whole numbers', v_label;
  end if;

  -- When it was counted, kept honest: not before the job existed, and not in
  -- the future a phone with a wrong clock can claim.
  v_at := least(greatest(coalesce(p_captured_at, now()), v_job.opened_at), now());

  insert into public.count_captures
    (job_id, counter_id, client_ref, product_id, new_item_id, qty, location,
     captured_at)
  values (v_job.id, v_c.id, v_ref, v_product, v_item, v_qty,
          nullif(left(btrim(coalesce(p_location, '')), 60), ''), v_at)
  returning * into v_hit;

  update public.count_counters set last_seen_at = now() where id = v_c.id;

  return jsonb_build_object('id', v_hit.id, 'product_id', v_product,
                            'new_item_id', v_item, 'name', v_label,
                            'repeat', false);
end;
$$;
grant execute on function public.pos_count_capture(
  text, text, uuid, uuid, text, text, text, numeric, text, timestamptz)
  to anon, authenticated;


-- Photos -----------------------------------------------------------------------
--
-- The product-image function does the storing (it holds the service role; the
-- bucket is not writable with the anon key). These two are its questions:
-- may this phone put a photo on this capture, and where; then, record it.
-- Both check the token themselves — the function's check is to avoid an
-- orphaned file, not the authorisation.

/**
 * May this phone add this photo to this capture of its own? Returns where it
 * goes, or — sent before — where it already is, so a retry uploads nothing.
 */
create function public.pos_count_photo_check(
  p_token text, p_capture_ref text, p_photo_ref text
) returns table(org_id uuid, job_id uuid, existing_path text)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_c public.count_counters; v_cap public.count_captures; v_org uuid;
        v_path text; v_n int;
begin
  v_c := public.count_counter_for(p_token);
  select j.org_id into v_org from public.count_jobs j where j.id = v_c.job_id;

  select p.path into v_path from public.count_photos p
   where p.counter_id = v_c.id and p.photo_ref = btrim(coalesce(p_photo_ref, ''));
  if v_path is not null then
    return query select v_org, v_c.job_id, v_path;
    return;
  end if;

  select * into v_cap from public.count_captures c
   where c.counter_id = v_c.id and c.client_ref = btrim(coalesce(p_capture_ref, ''));
  if v_cap.id is null then raise exception 'That count has not reached the shop yet'; end if;
  if v_cap.voided_at is not null then raise exception 'That count was taken back'; end if;

  select count(*) into v_n from public.count_photos p where p.capture_id = v_cap.id;
  if v_n >= public.count_photo_limit() then
    raise exception 'That is % photos already', public.count_photo_limit();
  end if;

  return query select v_org, v_c.job_id, null::text;
end;
$$;
grant execute on function public.pos_count_photo_check(text, text, text)
  to anon, authenticated;

/** Record a stored photo against its capture. Once, however often it is sent. */
create function public.pos_count_add_photo(
  p_token text, p_capture_ref text, p_photo_ref text, p_path text
) returns text
language plpgsql security definer
set search_path = public, extensions as $$
declare v_c public.count_counters; v_cap public.count_captures; v_org uuid;
        v_path text; v_ref text; v_n int;
begin
  v_c := public.count_counter_for(p_token);
  select j.org_id into v_org from public.count_jobs j where j.id = v_c.job_id;
  v_ref := btrim(coalesce(p_photo_ref, ''));
  if v_ref = '' then raise exception 'A photo needs a reference'; end if;

  select p.path into v_path from public.count_photos p
   where p.counter_id = v_c.id and p.photo_ref = v_ref;
  if v_path is not null then return v_path; end if;

  -- Only somewhere the function could have put it: this shop's count folder.
  if coalesce(p_path, '') not like v_org::text || '/count/' || v_c.job_id::text || '/%'
     or p_path like '%..%' then
    raise exception 'That photo is not in this count''s folder';
  end if;

  select * into v_cap from public.count_captures c
   where c.counter_id = v_c.id and c.client_ref = btrim(coalesce(p_capture_ref, ''));
  if v_cap.id is null then raise exception 'That count has not reached the shop yet'; end if;
  if v_cap.voided_at is not null then raise exception 'That count was taken back'; end if;

  select count(*) into v_n from public.count_photos p where p.capture_id = v_cap.id;
  if v_n >= public.count_photo_limit() then
    raise exception 'That is % photos already', public.count_photo_limit();
  end if;

  insert into public.count_photos (job_id, counter_id, capture_id, photo_ref, path)
  values (v_c.job_id, v_c.id, v_cap.id, v_ref, p_path);
  return p_path;
end;
$$;
grant execute on function public.pos_count_add_photo(text, text, text, text)
  to anon, authenticated;

/**
 * Every photo on a job against the product it will land on, the same way
 * count_job_resolved lands a capture. Taken-back captures take their photos
 * with them.
 */
create function public.count_job_photos(p_job uuid)
returns table(product_id uuid, new_item_id uuid, path text, created_at timestamptz)
language sql stable security definer
set search_path = public, extensions as $$
  select coalesce(c.product_id,
           case when n.decision = 'merge'
                then coalesce(n.merge_product, t.product_id)
                else n.product_id end),
         c.new_item_id, ph.path, ph.created_at
    from public.count_photos ph
    join public.count_captures c on c.id = ph.capture_id
    left join public.count_new_items n on n.id = c.new_item_id
    left join public.count_new_items t on t.id = n.merge_into
   where ph.job_id = p_job and c.voided_at is null;
$$;
revoke execute on function public.count_job_photos(uuid) from public, anon, authenticated;


-- The till's view -----------------------------------------------------------------
--
-- Return columns change on all three, so each old one goes first (CLAUDE.md).

drop function if exists public.pos_count_job_counters(text, text, uuid);

/** Who is counting, whether they have said they are done, and how much each sent. */
create function public.pos_count_job_counters(
  p_register_token text, p_pin text, p_job_id uuid
) returns table(id uuid, name text, active boolean, joined_at timestamptz,
                last_seen_at timestamptz, captures int, finished_at timestamptz)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  return query
    select k.id, k.name, k.active, k.joined_at, k.last_seen_at,
           (select count(*)::int from public.count_captures c
             where c.counter_id = k.id and c.voided_at is null),
           k.finished_at
      from public.count_counters k
      join public.count_jobs j on j.id = k.job_id
     where k.job_id = p_job_id and j.org_id = v_org
     order by k.joined_at;
end;
$$;
grant execute on function public.pos_count_job_counters(text, text, uuid)
  to anon, authenticated;

drop function if exists public.pos_count_job_new_items(text, text, uuid);

/** The things the catalogue did not know, what the reviewer said, and their photos. */
create function public.pos_count_job_new_items(
  p_register_token text, p_pin text, p_job_id uuid
) returns table(id uuid, barcode text, name text, unit_code text,
                counted numeric, captures int, counters text, locations text,
                decision text, merge_into uuid, merge_product uuid,
                merge_product_name text, category_id uuid,
                price_retail numeric, price_trade numeric, cost numeric,
                product_id uuid, photos text[])
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
                    array[]::text[])
      from public.count_new_items n
      left join public.count_captures c
        on c.new_item_id = n.id and c.voided_at is null
      left join public.count_counters k on k.id = c.counter_id
      left join public.products mp on mp.id = n.merge_product
     where n.job_id = p_job_id
     group by n.id, mp.name
     order by n.name;
end;
$$;
grant execute on function public.pos_count_job_new_items(text, text, uuid)
  to anon, authenticated;


-- Posting waits for everybody, and hands the photos over ---------------------
--
-- 0114's body plus the two. Same signature: replaced in place.

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
     where m.product_id = v_prod.id and m.created_at > v_r.first_at;

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
