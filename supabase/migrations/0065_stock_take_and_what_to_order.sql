-- 0065 — counting the shelves, and knowing what to order.
--
-- The stock value report warns about lines that have gone below zero on hand,
-- because there was no way to correct one. Stock drifts — breakages, a bag
-- that went out unrung, a delivery booked twice — and until somebody counts
-- the shelf and says what is really there, the valuation is a guess and every
-- margin built on it is a guess too.
--
-- stock_reason has had 'stocktake' in it since 0004. Nothing has ever written
-- one.

create table if not exists public.stock_counts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  doc_number  text not null,
  -- One department at a time is how a shop actually does this: a person with
  -- a clipboard walks Plumbing on a Tuesday morning. Null means the lot.
  category_id uuid references public.categories(id) on delete set null,
  status      text not null default 'open',
  note        text,
  started_at  timestamptz not null default now(),
  started_by  uuid references public.app_users(id),
  started_by_name text,
  posted_at   timestamptz,
  posted_by   uuid references public.app_users(id),
  posted_by_name text,
  constraint stock_counts_status_check check (status in ('open', 'posted', 'abandoned')),
  constraint stock_counts_number_unique unique (org_id, doc_number)
);
create index if not exists stock_counts_org_idx
  on public.stock_counts (org_id, status, started_at desc);
alter table public.stock_counts enable row level security;

create table if not exists public.stock_count_lines (
  id          uuid primary key default gen_random_uuid(),
  count_id    uuid not null references public.stock_counts(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  sku         text,
  name        text not null,
  unit_code   text not null,
  /**
   * What the system thought was there WHEN THE COUNT WAS OPENED.
   *
   * Snapshotted deliberately. The shop keeps trading while somebody counts,
   * so setting stock to the counted figure at the end would silently undo
   * every sale rung up in between. What gets posted is the DIFFERENCE between
   * what was counted and what was expected at that moment, applied as a
   * movement — so a sale during the count still counts.
   */
  expected_qty numeric(14,3) not null,
  counted_qty  numeric(14,3),
  counted_at   timestamptz,
  constraint stock_count_lines_unique unique (count_id, product_id)
);
create index if not exists stock_count_lines_count_idx
  on public.stock_count_lines (count_id);
alter table public.stock_count_lines enable row level security;

/** Open a sheet: every tracked line in the shop, or in one department. */
create or replace function public.pos_stock_count_open(
  p_register_token text, p_pin text, p_category_id uuid default null,
  p_note text default null
) returns public.stock_counts
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid; v_user public.app_users; v_row public.stock_counts;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  select * into v_user from public.app_users
   where org_id = v_org and pin_hash = crypt(p_pin, pin_hash) and active limit 1;

  insert into public.stock_counts (org_id, doc_number, category_id, note,
                                   started_by, started_by_name)
  values (v_org, public.next_doc_number(v_org, 'count'), p_category_id,
          nullif(btrim(coalesce(p_note, '')), ''), v_user.id, v_user.name)
  returning * into v_row;

  -- Untracked lines have no shelf to count: a delivery charge is not
  -- somewhere in aisle three.
  insert into public.stock_count_lines
    (count_id, product_id, sku, name, unit_code, expected_qty)
  select v_row.id, p.id, p.sku, p.name, p.unit_code, p.stock_qty
    from public.products p
   where p.org_id = v_org and p.active and p.stock_qty is not null
     and (p_category_id is null or p.category_id = p_category_id);

  return v_row;
end;
$$;

grant execute on function public.pos_stock_count_open(text, text, uuid, text)
  to anon, authenticated;

/** The sheet, in the order somebody walks the aisle. */
create or replace function public.pos_stock_count_lines(
  p_register_token text, p_pin text, p_count_id uuid
) returns table(id uuid, product_id uuid, sku text, name text, unit_code text,
                bin text, expected_qty numeric, counted_qty numeric,
                variance numeric, counted_at timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  return query
    select l.id, l.product_id, l.sku, l.name, l.unit_code, p.bin,
           l.expected_qty, l.counted_qty,
           case when l.counted_qty is null then null
                else l.counted_qty - l.expected_qty end,
           l.counted_at
      from public.stock_count_lines l
      join public.stock_counts c on c.id = l.count_id
      left join public.products p on p.id = l.product_id
     where l.count_id = p_count_id and c.org_id = v_org
     -- Bin first, because that is the order the shelves are in.
     order by coalesce(p.bin, 'zzz'), l.name;
end;
$$;

grant execute on function public.pos_stock_count_lines(text, text, uuid)
  to anon, authenticated;

/** What was on the shelf. Null clears a line back to uncounted. */
create or replace function public.pos_stock_count_set(
  p_register_token text, p_pin text, p_count_id uuid, p_product_id uuid,
  p_qty numeric
) returns numeric
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid; v_status text;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  select status into v_status from public.stock_counts
   where id = p_count_id and org_id = v_org;
  if not found then raise exception 'Unknown stock count'; end if;
  if v_status <> 'open' then
    raise exception 'That count has already been %', v_status;
  end if;
  if p_qty is not null and p_qty < 0 then
    raise exception 'A shelf cannot hold less than nothing';
  end if;

  update public.stock_count_lines
     set counted_qty = p_qty,
         counted_at = case when p_qty is null then null else now() end
   where count_id = p_count_id and product_id = p_product_id;
  if not found then raise exception 'That line is not on this count'; end if;
  return p_qty;
end;
$$;

grant execute on function public.pos_stock_count_set(text, text, uuid, uuid, numeric)
  to anon, authenticated;

/**
 * Post it: every counted line that disagrees becomes a movement.
 *
 * The movement is the DIFFERENCE, not the counted figure. A sale rung up
 * while the aisle was being walked has already come off the quantity, and
 * setting stock to what the shelf held ten minutes ago would put it back.
 *
 * Lines nobody counted are left alone. A half-finished count corrects what it
 * knows and says nothing about the rest, which is the honest reading of a
 * clipboard with blanks on it.
 */
create or replace function public.pos_stock_count_post(
  p_register_token text, p_pin text, p_count_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid; v_user public.app_users; v_row public.stock_counts;
  v_line record; v_moved int := 0; v_up numeric := 0; v_down numeric := 0;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  select * into v_user from public.app_users
   where org_id = v_org and pin_hash = crypt(p_pin, pin_hash) and active limit 1;

  select * into v_row from public.stock_counts
   where id = p_count_id and org_id = v_org for update;
  if not found then raise exception 'Unknown stock count'; end if;
  if v_row.status <> 'open' then
    raise exception 'That count has already been %', v_row.status;
  end if;

  for v_line in
    select * from public.stock_count_lines
     where count_id = p_count_id and counted_qty is not null
       and counted_qty <> expected_qty
  loop
    perform public.apply_stock(
      v_line.product_id, v_line.counted_qty - v_line.expected_qty,
      'stocktake', 'stock_counts', p_count_id, v_user,
      format('Counted %s, expected %s', v_line.counted_qty, v_line.expected_qty));
    v_moved := v_moved + 1;
    if v_line.counted_qty > v_line.expected_qty then
      v_up := v_up + (v_line.counted_qty - v_line.expected_qty);
    else
      v_down := v_down + (v_line.expected_qty - v_line.counted_qty);
    end if;
  end loop;

  update public.stock_counts
     set status = 'posted', posted_at = now(),
         posted_by = v_user.id, posted_by_name = v_user.name
   where id = p_count_id;

  return jsonb_build_object('lines_moved', v_moved, 'units_up', v_up,
                            'units_down', v_down);
end;
$$;

grant execute on function public.pos_stock_count_post(text, text, uuid)
  to anon, authenticated;

/** Give up on a sheet without touching a single quantity. */
create or replace function public.pos_stock_count_abandon(
  p_register_token text, p_pin text, p_count_id uuid
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  update public.stock_counts set status = 'abandoned'
   where id = p_count_id and org_id = v_org and status = 'open';
  if not found then raise exception 'That count cannot be abandoned'; end if;
end;
$$;

grant execute on function public.pos_stock_count_abandon(text, text, uuid)
  to anon, authenticated;

/** The counts, newest first, with how far through each one is. */
create or replace function public.pos_stock_counts(
  p_register_token text, p_pin text, p_limit int default 30
) returns table(id uuid, doc_number text, status text, note text,
                department text, started_at timestamptz, started_by_name text,
                posted_at timestamptz, posted_by_name text,
                lines int, counted int, variances int)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  return query
    select c.id, c.doc_number, c.status, c.note, cat.name,
           c.started_at, c.started_by_name, c.posted_at, c.posted_by_name,
           (select count(*)::int from public.stock_count_lines l where l.count_id = c.id),
           (select count(*)::int from public.stock_count_lines l
             where l.count_id = c.id and l.counted_qty is not null),
           (select count(*)::int from public.stock_count_lines l
             where l.count_id = c.id and l.counted_qty is not null
               and l.counted_qty <> l.expected_qty)
      from public.stock_counts c
      left join public.categories cat on cat.id = c.category_id
     where c.org_id = v_org
     order by c.started_at desc
     limit greatest(1, least(coalesce(p_limit, 30), 200));
end;
$$;

grant execute on function public.pos_stock_counts(text, text, int) to anon, authenticated;

-- --------------------------------------------------------------------------
-- What to order.
-- --------------------------------------------------------------------------
--
-- products.reorder_level has been on every line since 0002 and only one
-- screen has ever read it — to put a badge on a row. "What do I need to
-- order" is a daily question whose answer was already in the database.

create or replace function public.pos_reorder_list(
  p_register_token text, p_pin text
) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_org uuid; v_rows jsonb;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');

  select coalesce(jsonb_agg(row order by (row->>'short')::numeric desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'product_id', p.id, 'sku', p.sku, 'item', p.name,
        'department', coalesce(c.name, '—'),
        'unit', p.unit_code, 'bin', p.bin,
        'on_hand', p.stock_qty, 'reorder_level', p.reorder_level,
        'short', p.reorder_level - p.stock_qty,
        'cost', p.cost,
        -- Who it was last bought from, and at what, so an order can be
        -- raised without going and looking it up.
        'supplier', (select s.name from public.supplier_product_codes spc
                       join public.suppliers s on s.id = spc.supplier_id
                      where spc.product_id = p.id
                      order by spc.created_at desc limit 1),
        'sold_30d', (select coalesce(sum(si.qty), 0)
                       from public.sale_items si
                       join public.sales sa on sa.id = si.sale_id
                      where si.product_id = p.id and sa.status = 'completed'
                        and sa.created_at >= now() - interval '30 days')
      ) as row
      from public.products p
      left join public.categories c on c.id = p.category_id
     where p.org_id = v_org and p.active
       and p.stock_qty is not null and p.reorder_level is not null
       and p.stock_qty <= p.reorder_level
     limit 500
    ) t;
  return v_rows;
end;
$$;

grant execute on function public.pos_reorder_list(text, text) to anon, authenticated;

-- CNT-000001. From 0053's body, with one more prefix.
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
                          else 'CRN-' end)
  on conflict (org_id, doc_type) do nothing;

  select * into v_seq from public.doc_sequences
    where org_id = p_org and doc_type = p_doc_type for update;
  update public.doc_sequences set next_number = next_number + 1
    where org_id = p_org and doc_type = p_doc_type;
  return v_seq.prefix || lpad(v_seq.next_number::text, v_seq.pad_width, '0');
end;
$$;
