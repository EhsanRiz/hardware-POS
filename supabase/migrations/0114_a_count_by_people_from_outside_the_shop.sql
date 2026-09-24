-- 0114 — a count done by people from outside the shop.
--
-- A shop coming onto the Till arrives with shelves full of stock and a
-- catalogue that knows almost none of it. 4D sends two people to walk the
-- aisles and write down what is there, and neither of them is — or should
-- be — on the shop's staff: a staff phone belongs to exactly one shop (0012),
-- and a login that can count is a login that can see the rest of the back
-- office. So the stock take in 0065 cannot be what they use. It is also the
-- wrong shape: it counts a sheet made from the catalogue, and the whole point
-- here is the stock the catalogue has never heard of.
--
-- So, a COUNT JOB. A manager opens one on the till and reads out a code. A
-- counter types that code and their name on their own phone, and holds a
-- token that opens this job and nothing else — no prices, no costs, no
-- sales, no other shop — and stops opening anything the moment the job is
-- posted or abandoned. What they send are CAPTURES: who counted what, where,
-- how many, and when. A capture never overwrites another one: the cement on
-- the floor and the cement in the storeroom are two captures that add up.
--
-- Something the catalogue does not know becomes a NEW ITEM on the job, found
-- again by its barcode (or, with none, by its name and unit) so the second
-- counter to meet it counts the same thing instead of inventing a twin. A
-- reviewer prices it, merges it, or skips it; posting creates it.
--
-- POSTING SETS STOCK TO WHAT WAS COUNTED, PLUS WHATEVER HAS HAPPENED SINCE.
-- The shop keeps trading while the aisles are walked, and a job can stay open
-- for days. 0065 snapshots what was expected when the sheet was opened and
-- posts the difference, which is right to the minute it was opened and wrong
-- for every sale between then and the moment the shelf was actually counted.
-- Here every product's figure is taken from the moment it was first counted:
--
--     stock after posting = counted + (every movement since it was counted)
--
-- A sale after the count comes off; a delivery after it goes on; anything
-- before it was already on the shelf the counter looked at. That needs no
-- snapshot at all, only the movements table every stock change already
-- writes — which is also why a phone that counted offline at nine and synced
-- at eleven still lands on the right figure: captured_at is when it was
-- counted, not when it arrived.

-- Tables ---------------------------------------------------------------------

create table public.count_jobs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  doc_number  text not null,
  note        text,
  -- What a counter types. Eight characters with no I, O, 0 or 1, as 0092's
  -- device codes: read aloud across an aisle and typed by thumb.
  join_code   text not null,
  -- The door can close while the count goes on: two people are counting, and
  -- a code written on a whiteboard should not let in a third.
  joining_open boolean not null default true,
  status      text not null default 'open',
  opened_at   timestamptz not null default now(),
  -- Set null, not restrict: a shop reset deletes its staff (0092), and the
  -- names below are what the history keeps.
  opened_by   uuid references public.app_users(id) on delete set null,
  opened_by_name text,
  posted_at   timestamptz,
  posted_by   uuid references public.app_users(id) on delete set null,
  posted_by_name text,
  constraint count_jobs_status_check check (status in ('open', 'posted', 'abandoned')),
  constraint count_jobs_number_unique unique (org_id, doc_number)
);
-- One open job per shop. Two would each post "counted plus since" over the
-- same shelves and the second would be told nothing was wrong.
create unique index count_jobs_one_open on public.count_jobs (org_id)
  where status = 'open';
-- A code opens exactly one job while it is open.
create unique index count_jobs_open_code on public.count_jobs (join_code)
  where status = 'open';
alter table public.count_jobs enable row level security;

create table public.count_counters (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.count_jobs(id) on delete cascade,
  name         text not null,
  -- sha256 of the token, as for registers (0007). The phone holds the only
  -- copy of the plaintext.
  token_hash   text not null unique,
  active       boolean not null default true,
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz
);
create index count_counters_job_idx on public.count_counters (job_id);
alter table public.count_counters enable row level security;

create table public.count_new_items (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.count_jobs(id) on delete cascade,
  -- How a second capture finds this one: 'b:<barcode>', or with no barcode
  -- 'n:<name, case and spacing folded>|<unit>'.
  match_key   text not null,
  barcode     text,
  name        text not null,
  unit_code   text not null references public.units_of_measure(code),
  created_by  uuid references public.count_counters(id) on delete set null,
  created_at  timestamptz not null default now(),
  -- The review. 'pending' is created HIDDEN and unpriced at posting, as the
  -- shelf screen does (0044): counted stock is never thrown away because
  -- nobody got round to a price.
  decision    text not null default 'pending',
  merge_into  uuid references public.count_new_items(id) on delete set null,
  merge_product uuid references public.products(id) on delete set null,
  category_id uuid references public.categories(id) on delete set null,
  price_retail numeric(12,2),
  price_trade  numeric(12,2),
  cost         numeric(12,4),
  -- The product posting made (or found) for it.
  product_id  uuid references public.products(id) on delete set null,
  constraint count_new_items_decision_check
    check (decision in ('pending', 'add', 'skip', 'merge')),
  constraint count_new_items_key_unique unique (job_id, match_key)
);
alter table public.count_new_items enable row level security;

create table public.count_captures (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.count_jobs(id) on delete cascade,
  counter_id  uuid not null references public.count_counters(id) on delete cascade,
  -- Made on the phone, so a capture sent twice through a bad signal is
  -- stored once.
  client_ref  text not null,
  product_id  uuid references public.products(id) on delete cascade,
  new_item_id uuid references public.count_new_items(id) on delete cascade,
  qty         numeric(14,3) not null check (qty >= 0),
  location    text,
  -- When it was COUNTED, which the posting arithmetic depends on. Clamped on
  -- arrival to between the job opening and now.
  captured_at timestamptz not null,
  received_at timestamptz not null default now(),
  voided_at   timestamptz,
  constraint count_captures_one_thing
    check ((product_id is null) <> (new_item_id is null)),
  constraint count_captures_ref_unique unique (counter_id, client_ref)
);
create index count_captures_job_idx on public.count_captures (job_id);
alter table public.count_captures enable row level security;


-- The doc number prefix -----------------------------------------------------
--
-- Same signature as 0066: replaced in place. Without the new case a count job
-- would be numbered CRN-, which is a credit note's prefix.

create or replace function public.next_doc_number(p_org uuid, p_doc_type text)
returns text language plpgsql set search_path = public, extensions as $$
declare v_seq public.doc_sequences;
begin
  -- New orgs get their sequences lazily.
  insert into public.doc_sequences (org_id, doc_type, prefix)
  values (p_org, p_doc_type,
          case p_doc_type when 'sale' then 'INV-' when 'quote' then 'QUO-'
                          when 'grv' then 'GRV-' when 'sku' then 'SKU-'
                          when 'delivery' then 'DEL-' when 'count' then 'CNT-'
                          when 'po' then 'PO-' when 'countjob' then 'STK-'
                          else 'CRN-' end)
  on conflict (org_id, doc_type) do nothing;

  select * into v_seq from public.doc_sequences
    where org_id = p_org and doc_type = p_doc_type for update;
  update public.doc_sequences set next_number = next_number + 1
    where org_id = p_org and doc_type = p_doc_type;
  return v_seq.prefix || lpad(v_seq.next_number::text, v_seq.pad_width, '0');
end;
$$;


-- Helpers (not granted) ------------------------------------------------------

/** The counter a phone's token names, on a job that is still open. */
create function public.count_counter_for(p_token text)
returns public.count_counters
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_c public.count_counters; v_status text;
begin
  select * into v_c from public.count_counters
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if v_c.id is null then
    raise exception 'This phone is not on a count';
  end if;
  select status into v_status from public.count_jobs where id = v_c.job_id;
  if v_status <> 'open' then
    raise exception 'This count has finished';
  end if;
  if not v_c.active then
    raise exception 'You have been taken off this count';
  end if;
  return v_c;
end;
$$;
revoke execute on function public.count_counter_for(text)
  from public, anon, authenticated;

/** Folded the way two people typing the same thing differ: case and spacing. */
create function public.count_fold(p_text text)
returns text language sql immutable
set search_path = public, extensions as $$
  select lower(regexp_replace(btrim(coalesce(p_text, '')), '\s+', ' ', 'g'));
$$;
revoke execute on function public.count_fold(text) from public, anon, authenticated;

/**
 * Every live capture on a job, against the product it will land on.
 *
 * A new item lands on the product posting made for it, or the product it was
 * merged into, or — merged into another new item — on whatever that one
 * lands on. Before posting only the merges into existing products resolve;
 * the rest are null and are the new-items list's business.
 */
create function public.count_job_resolved(p_job uuid)
returns table(product_id uuid, qty numeric, captured_at timestamptz,
              counter_name text, location text)
language sql stable security definer
set search_path = public, extensions as $$
  select coalesce(c.product_id,
           case when n.decision = 'merge'
                then coalesce(n.merge_product, t.product_id)
                else n.product_id end),
         c.qty, c.captured_at, k.name, c.location
    from public.count_captures c
    join public.count_counters k on k.id = c.counter_id
    left join public.count_new_items n on n.id = c.new_item_id
    left join public.count_new_items t on t.id = n.merge_into
   where c.job_id = p_job and c.voided_at is null;
$$;
revoke execute on function public.count_job_resolved(uuid)
  from public, anon, authenticated;


-- The counter's side: a code, a name, and a phone --------------------------

/**
 * Join a count. The only way in, and it asks for nothing but the code.
 *
 * The code is forgiving about how it is typed — lower case, a dash, a space —
 * because it is read aloud across an aisle. It is not forgiving about
 * anything else: a job that is closed to joining, posted or abandoned says
 * the same thing as a code that never existed, so guessing learns nothing.
 */
create function public.pos_count_join(p_code text, p_name text)
returns table(token text, counter_id uuid, counter_name text, job_id uuid,
              doc_number text, note text, shop_name text)
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_code text; v_name text; v_job public.count_jobs; v_token text; v_id uuid;
  v_shop text;
begin
  v_code := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_name := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  if v_name = '' then raise exception 'Type your name, so the shop knows who counted what'; end if;
  if length(v_name) > 40 then raise exception 'A name that short fits on the list: 40 letters at most'; end if;

  select * into v_job from public.count_jobs j
   where j.join_code = v_code and j.status = 'open' and j.joining_open;
  if v_job.id is null then
    raise exception 'That code is not open for counting';
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.count_counters (job_id, name, token_hash, last_seen_at)
  values (v_job.id, v_name, encode(digest(v_token, 'sha256'), 'hex'), now())
  returning id into v_id;

  select o.name into v_shop from public.organizations o where o.id = v_job.org_id;
  return query select v_token, v_id, v_name, v_job.id, v_job.doc_number,
                      v_job.note, v_shop;
end;
$$;
grant execute on function public.pos_count_join(text, text) to anon, authenticated;

/**
 * What a counting phone needs to work with no signal: the names and codes of
 * everything the shop already has, the new items the job has already met, and
 * the units. NO prices, costs or quantities — the people holding these phones
 * do not work for the shop, and a count that shows what it expects is a count
 * that finds what it expects.
 */
create function public.pos_count_state(p_token text)
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
       where n.job_id = v_job.id and n.decision <> 'skip'),
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

/**
 * One capture: this many of this thing, here, at this time.
 *
 * Named three ways, in the order they can be trusted: a product id from the
 * phone's copy of the catalogue; a new item the job already has; or a barcode
 * and/or a name and unit, which the server resolves — to a product if the
 * catalogue has the code after all (the phone's copy was older, or the item
 * is one the shelf screen hid), else to the job's new item with that key,
 * made now if nobody has met it yet.
 */
create function public.pos_count_capture(
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

  -- Sent twice through a bad signal: the first one stands.
  select * into v_hit from public.count_captures c
   where c.counter_id = v_c.id and c.client_ref = v_ref;
  if v_hit.id is not null then
    return jsonb_build_object('id', v_hit.id, 'product_id', v_hit.product_id,
                              'new_item_id', v_hit.new_item_id, 'repeat', true);
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

/** Take back one of your own captures. Somebody else's is the reviewer's. */
create function public.pos_count_void(p_token text, p_client_ref text)
returns boolean
language plpgsql security definer
set search_path = public, extensions as $$
declare v_c public.count_counters;
begin
  v_c := public.count_counter_for(p_token);
  update public.count_captures c set voided_at = coalesce(c.voided_at, now())
   where c.counter_id = v_c.id and c.client_ref = btrim(coalesce(p_client_ref, ''));
  -- A capture that never reached the server has nothing to take back, and
  -- the phone has already dropped it: not an error.
  return found;
end;
$$;
grant execute on function public.pos_count_void(text, text) to anon, authenticated;


-- The shop's side: open, watch, review, post --------------------------------

/**
 * Open a job and get its code.
 *
 * Refused while a stock-take sheet (0065) is open, and 0065's opening is
 * refused while a job is — the sheet posts against a snapshot, and a job
 * posted underneath it would have the sheet take the same shortage off again
 * (0069's double count, by another road).
 */
create function public.pos_count_job_open(
  p_register_token text, p_pin text, p_note text default null
) returns public.count_jobs
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_user public.app_users; v_row public.count_jobs; v_code text; v_clash text;
  v_alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  i int;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_inventory');

  select doc_number into v_clash from public.count_jobs
   where org_id = v_user.org_id and status = 'open';
  if found then
    raise exception 'A count is already open (%). Post it or abandon it first.', v_clash;
  end if;
  select doc_number into v_clash from public.stock_counts
   where org_id = v_user.org_id and status = 'open' limit 1;
  if found then
    raise exception 'A stock-take sheet is open (%). Finish it or abandon it first.', v_clash;
  end if;

  -- 256 is a multiple of 32, so a byte modulo the alphabet is uniform (0092).
  loop
    v_code := '';
    for i in 0..7 loop
      v_code := v_code || substr(v_alphabet,
        1 + get_byte(gen_random_bytes(8), i) % length(v_alphabet), 1);
    end loop;
    exit when not exists (select 1 from public.count_jobs j
                           where j.join_code = v_code and j.status = 'open');
  end loop;

  insert into public.count_jobs (org_id, doc_number, note, join_code,
                                 opened_by, opened_by_name)
  values (v_user.org_id, public.next_doc_number(v_user.org_id, 'countjob'),
          nullif(left(btrim(coalesce(p_note, '')), 120), ''), v_code,
          v_user.id, v_user.name)
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.pos_count_job_open(text, text, text) to anon, authenticated;

/** The jobs, newest first, with how far each has got. The code only while open. */
create function public.pos_count_jobs(p_register_token text, p_pin text)
returns table(id uuid, doc_number text, note text, status text,
              join_code text, joining_open boolean,
              opened_at timestamptz, opened_by_name text,
              posted_at timestamptz, posted_by_name text,
              counters int, captures int, products_counted int,
              new_items int, new_pending int)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  return query
    select j.id, j.doc_number, j.note, j.status,
           case when j.status = 'open' then j.join_code end, j.joining_open,
           j.opened_at, j.opened_by_name, j.posted_at, j.posted_by_name,
           (select count(*)::int from public.count_counters k where k.job_id = j.id),
           (select count(*)::int from public.count_captures c
             where c.job_id = j.id and c.voided_at is null),
           (select count(distinct c.product_id)::int from public.count_captures c
             where c.job_id = j.id and c.voided_at is null),
           (select count(*)::int from public.count_new_items n
             where n.job_id = j.id and n.decision <> 'skip'),
           (select count(*)::int from public.count_new_items n
             where n.job_id = j.id and n.decision = 'pending')
      from public.count_jobs j
     where j.org_id = v_org
     order by j.opened_at desc
     limit 30;
end;
$$;
grant execute on function public.pos_count_jobs(text, text) to anon, authenticated;

create function public.pos_count_job_joining(
  p_register_token text, p_pin text, p_job_id uuid, p_open boolean
) returns void
language plpgsql security definer
set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  update public.count_jobs set joining_open = coalesce(p_open, false)
   where id = p_job_id and org_id = v_org and status = 'open';
  if not found then raise exception 'That count is not open'; end if;
end;
$$;
grant execute on function public.pos_count_job_joining(text, text, uuid, boolean)
  to anon, authenticated;

/** Who is counting, and how much each has sent. */
create function public.pos_count_job_counters(
  p_register_token text, p_pin text, p_job_id uuid
) returns table(id uuid, name text, active boolean, joined_at timestamptz,
                last_seen_at timestamptz, captures int)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  return query
    select k.id, k.name, k.active, k.joined_at, k.last_seen_at,
           (select count(*)::int from public.count_captures c
             where c.counter_id = k.id and c.voided_at is null)
      from public.count_counters k
      join public.count_jobs j on j.id = k.job_id
     where k.job_id = p_job_id and j.org_id = v_org
     order by k.joined_at;
end;
$$;
grant execute on function public.pos_count_job_counters(text, text, uuid)
  to anon, authenticated;

/**
 * Take a phone off the count: a lost phone, or somebody who has gone home.
 * What they already sent stays — it was counted — and the reviewer can see
 * whose it was.
 */
create function public.pos_count_job_remove_counter(
  p_register_token text, p_pin text, p_counter_id uuid
) returns void
language plpgsql security definer
set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  update public.count_counters k set active = false
    from public.count_jobs j
   where k.id = p_counter_id and j.id = k.job_id and j.org_id = v_org;
  if not found then raise exception 'Unknown counter'; end if;
end;
$$;
grant execute on function public.pos_count_job_remove_counter(text, text, uuid)
  to anon, authenticated;

/**
 * What posting will do to the items the shop already has: counted, what is
 * on hand now, and what it will be — counted plus everything since.
 */
create function public.pos_count_job_counted(
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
      ) s
     order by p.name;
end;
$$;
grant execute on function public.pos_count_job_counted(text, text, uuid)
  to anon, authenticated;

/** The things the catalogue did not know, with what the reviewer has said. */
create function public.pos_count_job_new_items(
  p_register_token text, p_pin text, p_job_id uuid
) returns table(id uuid, barcode text, name text, unit_code text,
                counted numeric, captures int, counters text, locations text,
                decision text, merge_into uuid, merge_product uuid,
                merge_product_name text, category_id uuid,
                price_retail numeric, price_trade numeric, cost numeric,
                product_id uuid)
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
           n.price_retail, n.price_trade, n.cost, n.product_id
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

/**
 * The reviewer's word on a new item.
 *
 *   add     — becomes a product on sale, at this price, when the job posts
 *   pending — becomes a HIDDEN product with its stock, to be priced later
 *   skip    — was not really stock (a display, the shop's own tools)
 *   merge   — is the same thing as another new item, or an existing product,
 *             under another name: its count goes there
 *
 * Needs manage_catalogue as well: this is where prices are set and products
 * are made, and a storeman who may count may not necessarily price.
 */
create function public.pos_count_new_item_review(
  p_register_token text, p_pin text, p_item_id uuid, p_decision text,
  p_name text, p_barcode text, p_unit_code text, p_category_id uuid,
  p_price_retail numeric, p_price_trade numeric, p_cost numeric,
  p_merge_into uuid, p_merge_product uuid
) returns void
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_user public.app_users; v_item public.count_new_items; v_job public.count_jobs;
  v_name text; v_code text; v_unit text; v_key text; v_taken text;
  v_target_unit text; v_target_name text;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_inventory');
  perform public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');

  select n.* into v_item from public.count_new_items n
    join public.count_jobs j on j.id = n.job_id
   where n.id = p_item_id and j.org_id = v_user.org_id
   for update of n;
  if v_item.id is null then raise exception 'Unknown item on this count'; end if;
  select * into v_job from public.count_jobs where id = v_item.job_id;
  if v_job.status <> 'open' then raise exception 'That count has already been %', v_job.status; end if;
  if p_decision not in ('pending', 'add', 'skip', 'merge') then
    raise exception 'Unknown decision %', p_decision;
  end if;

  v_name := coalesce(nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), ''), v_item.name);
  -- Null keeps what the counter scanned; an empty string clears a misread.
  v_code := case when p_barcode is null then v_item.barcode
                 else nullif(btrim(p_barcode), '') end;
  v_unit := coalesce(nullif(btrim(coalesce(p_unit_code, '')), ''), v_item.unit_code);
  if not exists (select 1 from public.units_of_measure u where u.code = v_unit) then
    raise exception 'Unknown unit %', v_unit;
  end if;
  if p_price_retail is not null and p_price_retail < 0
     or p_price_trade is not null and p_price_trade < 0
     or p_cost is not null and p_cost < 0 then
    raise exception 'A price cannot be negative';
  end if;
  if p_category_id is not null and not exists (
       select 1 from public.categories c
        where c.id = p_category_id and c.org_id = v_user.org_id) then
    raise exception 'Unknown department';
  end if;

  if p_decision = 'add' and coalesce(p_price_retail, 0) <= 0 then
    raise exception 'Give % a price to put it on sale — or leave it for later, and it is added hidden', v_name;
  end if;

  -- Whatever is merged into this item lands on the product it becomes. Skip
  -- it, or merge it away in turn, and their counts would land on nothing.
  if p_decision in ('merge', 'skip') and exists (
       select 1 from public.count_new_items n
        where n.merge_into = v_item.id and n.decision = 'merge') then
    raise exception 'Something else is merged into %. Merge that one elsewhere first.', v_item.name;
  end if;

  if p_decision = 'merge' then
    if (p_merge_into is null) = (p_merge_product is null) then
      raise exception 'Merge it into one thing: another new item, or an item the shop has';
    end if;
    if p_merge_into is not null then
      if p_merge_into = v_item.id then raise exception 'An item cannot be merged into itself'; end if;
      select n.unit_code, n.name into v_target_unit, v_target_name
        from public.count_new_items n
       where n.id = p_merge_into and n.job_id = v_item.job_id
         and n.decision <> 'merge';
      if v_target_name is null then
        raise exception 'Merge into a new item on this count that is not merged itself';
      end if;
    else
      select p.unit_code, p.name into v_target_unit, v_target_name
        from public.products p
       where p.id = p_merge_product and p.org_id = v_user.org_id;
      if v_target_name is null then raise exception 'That item is not in this shop'; end if;
    end if;
    -- Five "each" and five metres are not the same five. Fix the unit first.
    if v_target_unit <> v_unit then
      raise exception '% is counted in %, % in % — they cannot be the same item',
        v_name, v_unit, v_target_name, v_target_unit;
    end if;
  end if;

  if p_decision in ('add', 'pending') and v_code is not null then
    select p.name into v_taken from public.products p
     where p.org_id = v_user.org_id and p.barcode = v_code limit 1;
    if v_taken is not null then
      raise exception 'That barcode is already on % — merge it into that item instead', v_taken;
    end if;
  end if;

  -- The key follows the item, so the next capture of it still finds it.
  v_key := case when v_code is not null then 'b:' || v_code
                else 'n:' || public.count_fold(v_name) || '|' || v_unit end;
  if exists (select 1 from public.count_new_items n
              where n.job_id = v_item.job_id and n.match_key = v_key
                and n.id <> v_item.id) then
    raise exception 'Another new item on this count is already called that — merge them instead';
  end if;

  update public.count_new_items set
    decision = p_decision, name = v_name, barcode = v_code, unit_code = v_unit,
    match_key = v_key, category_id = p_category_id,
    price_retail = p_price_retail, price_trade = p_price_trade, cost = p_cost,
    merge_into = case when p_decision = 'merge' then p_merge_into end,
    merge_product = case when p_decision = 'merge' then p_merge_product end
   where id = v_item.id;
end;
$$;
grant execute on function public.pos_count_new_item_review(
  text, text, uuid, text, text, text, text, uuid, numeric, numeric, numeric,
  uuid, uuid) to anon, authenticated;

/**
 * Post the job. All of it or none of it.
 *
 *   1. Every new item that is not skipped or merged becomes a product —
 *      on sale if it was priced ('add'), hidden if not ('pending') — unless
 *      the catalogue has meanwhile gained its barcode, in which case its
 *      count goes to that product instead of making a twin.
 *   2. Every product with a live capture is set to counted + everything
 *      since it was first counted, as a 'stocktake' movement of the
 *      difference. An untracked product starts being tracked here: somebody
 *      has just counted it.
 *
 * Products nobody counted are left alone. Two people cannot walk every shelf,
 * and a blank on the list is not a zero.
 */
create function public.pos_count_job_post(
  p_register_token text, p_pin text, p_job_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_user public.app_users; v_job public.count_jobs; v_n record; v_pid uuid;
  v_r record; v_prod public.products; v_since numeric; v_delta numeric;
  v_created int := 0; v_hidden int := 0; v_moved int := 0; v_counted int := 0;
  v_up numeric := 0; v_down numeric := 0;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_inventory');
  perform public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');

  select * into v_job from public.count_jobs
   where id = p_job_id and org_id = v_user.org_id for update;
  if v_job.id is null then raise exception 'Unknown count'; end if;
  if v_job.status <> 'open' then
    raise exception 'That count has already been %', v_job.status;
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

  update public.count_jobs
     set status = 'posted', posted_at = now(),
         posted_by = v_user.id, posted_by_name = v_user.name
   where id = v_job.id;

  return jsonb_build_object('products_counted', v_counted,
                            'products_created', v_created,
                            'created_hidden', v_hidden,
                            'lines_moved', v_moved,
                            'units_up', v_up, 'units_down', v_down);
end;
$$;
grant execute on function public.pos_count_job_post(text, text, uuid)
  to anon, authenticated;

/** Give up on a job. Nothing moves, and every phone on it stops working. */
create function public.pos_count_job_abandon(
  p_register_token text, p_pin text, p_job_id uuid
) returns void
language plpgsql security definer
set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  update public.count_jobs set status = 'abandoned'
   where id = p_job_id and org_id = v_org and status = 'open';
  if not found then raise exception 'That count cannot be abandoned'; end if;
end;
$$;
grant execute on function public.pos_count_job_abandon(text, text, uuid)
  to anon, authenticated;


-- The stock-take sheet learns about jobs ------------------------------------
--
-- 0069's body, plus one refusal. Same signature: replaced in place.

create or replace function public.pos_stock_count_open(
  p_register_token text, p_pin text, p_category_id uuid default null,
  p_note text default null
) returns public.stock_counts
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid; v_user public.app_users; v_row public.stock_counts; v_clash text;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  select * into v_user from public.app_users
   where org_id = v_org and pin_hash = crypt(p_pin, pin_hash) and active limit 1;

  -- Overlapping open sheets double-apply the same difference. A whole-shop
  -- sheet overlaps every department, and a department sheet overlaps a
  -- whole-shop one, so both directions are covered by the same test.
  select doc_number into v_clash from public.stock_counts
   where org_id = v_org and status = 'open'
     and (category_id is null or p_category_id is null
          or category_id = p_category_id)
   order by started_at limit 1;
  if found then
    raise exception
      'A count of these shelves is already open (%). Finish it or abandon it first.',
      v_clash;
  end if;

  -- 0114: and so does a sheet opened under a count job — the job posts first
  -- and the sheet then takes the same shortage off again from its snapshot.
  select doc_number into v_clash from public.count_jobs
   where org_id = v_org and status = 'open';
  if found then
    raise exception
      'A count (%) is open. Post it or abandon it before starting a sheet.',
      v_clash;
  end if;

  -- A sheet with no lines is not a stock take. It filled the list with
  -- "0 of 0" rows nobody could act on and nobody could get rid of.
  if not exists (
    select 1 from public.products p
     where p.org_id = v_org and p.active and p.stock_qty is not null
       and (p_category_id is null or p.category_id = p_category_id)
  ) then
    raise exception 'There is nothing on a shelf in there to count';
  end if;

  insert into public.stock_counts (org_id, doc_number, category_id, note,
                                   started_by, started_by_name)
  values (v_org, public.next_doc_number(v_org, 'count'), p_category_id,
          nullif(btrim(coalesce(p_note, '')), ''), v_user.id, v_user.name)
  returning * into v_row;

  -- Untracked lines have no shelf to count: a delivery charge is not
  -- somewhere in aisle three.
  insert into public.stock_count_lines
    (count_id, product_id, sku, name, unit_code, expected_qty, unit_cost)
  select v_row.id, p.id, p.sku, p.name, p.unit_code, p.stock_qty, p.cost
    from public.products p
   where p.org_id = v_org and p.active and p.stock_qty is not null
     and (p_category_id is null or p.category_id = p_category_id);

  return v_row;
end;
$$;
grant execute on function public.pos_stock_count_open(text, text, uuid, text)
  to anon, authenticated;


-- A reset shop keeps no count jobs ------------------------------------------
--
-- 0092's body plus one line, and the same signature. Its own comment names
-- the fault this avoids: 0086 came after the reset and was never added to it,
-- and a wiped test shop handed its successor the tester's parked baskets. An
-- open job would hand over a code that still opens a count.

create or replace function public.innova_reset_org(
  p_org_id uuid, p_org_name text, p_manager_name text, p_manager_phone text,
  p_keep_catalogue boolean default true
) returns uuid
language plpgsql security definer
set search_path = public, extensions as $$
declare v_org public.organizations; v_mgr uuid;
begin
  select * into v_org from public.organizations where id = p_org_id;
  if v_org.id is null then raise exception 'No such shop'; end if;
  if lower(btrim(p_org_name)) is distinct from lower(btrim(v_org.name)) then
    raise exception 'The name does not match the shop with that id (%): nothing was touched', v_org.name;
  end if;
  if p_manager_phone !~ '^\+\d{9,15}$' then
    raise exception 'Manager phone must be E.164, e.g. +27821234567';
  end if;

  -- The books: children before parents, in the order the foreign keys
  -- demand.
  delete from public.approval_attempts
   where register_id in (select id from public.registers where org_id = p_org_id);
  delete from public.approval_codes where org_id = p_org_id;
  -- 0086 came after this function and was never added to it: a wiped test
  -- shop handed its successor the tester's parked baskets.
  delete from public.parked_sales where org_id = p_org_id;
  delete from public.return_items
   where return_id in (select id from public.returns where org_id = p_org_id);
  delete from public.returns where org_id = p_org_id;
  delete from public.deliveries where org_id = p_org_id;
  delete from public.quote_items
   where quote_id in (select id from public.quotes where org_id = p_org_id);
  delete from public.quotes where org_id = p_org_id;
  delete from public.sale_payments where org_id = p_org_id;
  delete from public.sale_items
   where sale_id in (select id from public.sales where org_id = p_org_id);
  delete from public.sales where org_id = p_org_id;
  delete from public.customer_payments where org_id = p_org_id;
  delete from public.customers where org_id = p_org_id;
  delete from public.cash_movements where org_id = p_org_id;
  delete from public.cash_sessions where org_id = p_org_id;
  delete from public.stock_count_lines
   where count_id in (select id from public.stock_counts where org_id = p_org_id);
  delete from public.stock_counts where org_id = p_org_id;
  -- 0114: counters, captures and new items go with their job (cascade).
  delete from public.count_jobs where org_id = p_org_id;
  delete from public.purchase_order_lines
   where po_id in (select id from public.purchase_orders where org_id = p_org_id);
  delete from public.purchase_orders where org_id = p_org_id;
  delete from public.supplier_document_lines
   where document_id in (select id from public.supplier_documents where org_id = p_org_id);
  delete from public.supplier_document_pages
   where document_id in (select id from public.supplier_documents where org_id = p_org_id);
  delete from public.supplier_documents where org_id = p_org_id;
  delete from public.stock_movements where org_id = p_org_id;
  delete from public.tillai_questions where org_id = p_org_id;
  delete from public.client_errors where org_id = p_org_id;
  delete from public.login_attempts where org_id = p_org_id;

  -- Devices and people. Every till and phone goes back to the front door;
  -- every PIN, code and token is gone with the person it belonged to.
  delete from public.device_enrolments where org_id = p_org_id;
  delete from public.registers where org_id = p_org_id;
  delete from public.auth_otps
   where phone_e164 in (select phone_e164 from public.app_users where org_id = p_org_id);
  delete from public.auth_setpin_tokens
   where phone_e164 in (select phone_e164 from public.app_users where org_id = p_org_id);
  delete from public.app_users where org_id = p_org_id;

  if p_keep_catalogue then
    update public.products set stock_qty = 0 where org_id = p_org_id;
  else
    delete from public.product_images where org_id = p_org_id;
    delete from public.supplier_product_codes where org_id = p_org_id;
    delete from public.products where org_id = p_org_id;
    delete from public.categories where org_id = p_org_id;
    delete from public.suppliers where org_id = p_org_id;
  end if;

  -- The first real invoice is number 1.
  update public.doc_sequences set next_number = 1 where org_id = p_org_id;

  -- The real manager, invited as innova_create_org invites one: they prove
  -- the phone by OTP and choose their PIN; nothing is set for them.
  insert into public.app_users (org_id, name, role, phone_e164, status, pin_hash)
  values (p_org_id, btrim(p_manager_name), 'admin', p_manager_phone, 'invited', null)
  returning id into v_mgr;
  return v_mgr;
end;
$$;
