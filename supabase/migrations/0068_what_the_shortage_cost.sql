-- 0068 — what a shortage actually costs, and scanning the shelf to count it.
--
-- 0065 corrected the quantity and stopped there. A count that finds three bags
-- of cement missing writes a movement saying "Counted 5, expected 8" and never
-- says that R345 of the shop's money has gone. A shop can lose a few thousand
-- rand a year that way and never see one figure for it — which is the whole
-- reason counting is worth the morning it takes.
--
-- Two changes: the count sheet carries what each line cost, so the loss can be
-- totalled BEFORE anybody posts it; and the movement records that cost, so the
-- loss can be added up afterwards by department and by reason.

-- What it cost, snapshotted when the sheet was opened, exactly as expected_qty
-- is. A cost that moved between opening the sheet and posting it must not
-- silently revalue a count somebody has already walked.
alter table public.stock_count_lines
  add column if not exists unit_cost numeric(12,4);

-- The barcode is not copied onto the line: it is read live, because scanning
-- is about finding the row now, not about what the row said last week.

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

-- Return columns change, so the old signature goes first (CLAUDE.md).
drop function if exists public.pos_stock_count_lines(text, text, uuid);

/**
 * The sheet, in the order somebody walks the aisle.
 *
 * `barcode` is here so a scanner can find the line. `variance_value` is what
 * the difference is worth at cost — negative when the shelf is short, which
 * is the number an owner actually reacts to.
 */
create function public.pos_stock_count_lines(
  p_register_token text, p_pin text, p_count_id uuid
) returns table(id uuid, product_id uuid, sku text, barcode text, name text,
                unit_code text, bin text, expected_qty numeric,
                counted_qty numeric, variance numeric, unit_cost numeric,
                variance_value numeric, counted_at timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  return query
    select l.id, l.product_id, l.sku, p.barcode, l.name, l.unit_code, p.bin,
           l.expected_qty, l.counted_qty,
           case when l.counted_qty is null then null
                else l.counted_qty - l.expected_qty end,
           l.unit_cost,
           case when l.counted_qty is null or l.unit_cost is null then null
                else round((l.counted_qty - l.expected_qty) * l.unit_cost, 2) end,
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

/**
 * Post it: every counted line that disagrees becomes a movement.
 *
 * The movement now carries what the unit cost, so the loss can be valued
 * later. Same rule as everywhere else: the DIFFERENCE is applied, never the
 * counted figure.
 */
create or replace function public.pos_stock_count_post(
  p_register_token text, p_pin text, p_count_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid; v_user public.app_users; v_row public.stock_counts;
  v_line record; v_moved int := 0; v_up numeric := 0; v_down numeric := 0;
  v_value_up numeric := 0; v_value_down numeric := 0; v_diff numeric;
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
    v_diff := v_line.counted_qty - v_line.expected_qty;
    perform public.apply_stock(
      v_line.product_id, v_diff,
      'stocktake', 'stock_counts', p_count_id, v_user,
      format('Counted %s, expected %s', v_line.counted_qty, v_line.expected_qty),
      v_line.unit_cost);
    v_moved := v_moved + 1;
    if v_diff > 0 then
      v_up := v_up + v_diff;
      v_value_up := v_value_up + v_diff * coalesce(v_line.unit_cost, 0);
    else
      v_down := v_down - v_diff;
      v_value_down := v_value_down - v_diff * coalesce(v_line.unit_cost, 0);
    end if;
  end loop;

  update public.stock_counts
     set status = 'posted', posted_at = now(),
         posted_by = v_user.id, posted_by_name = v_user.name
   where id = p_count_id;

  return jsonb_build_object('lines_moved', v_moved, 'units_up', v_up,
                            'units_down', v_down,
                            'value_up', round(v_value_up, 2),
                            'value_down', round(v_value_down, 2));
end;
$$;

grant execute on function public.pos_stock_count_post(text, text, uuid)
  to anon, authenticated;

-- Return columns change again.
drop function if exists public.pos_stock_counts(text, text, int);

/** The counts, newest first, with how far through each one is and what it found. */
create function public.pos_stock_counts(
  p_register_token text, p_pin text, p_limit int default 30
) returns table(id uuid, doc_number text, status text, note text,
                department text, started_at timestamptz, started_by_name text,
                posted_at timestamptz, posted_by_name text,
                lines int, counted int, variances int, short_value numeric)
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
               and l.counted_qty <> l.expected_qty),
           -- What the sheet is short, at cost. Positive means money gone.
           (select coalesce(round(sum((l.expected_qty - l.counted_qty)
                                      * coalesce(l.unit_cost, 0)), 2), 0)
              from public.stock_count_lines l
             where l.count_id = c.id and l.counted_qty is not null
               and l.counted_qty < l.expected_qty)
      from public.stock_counts c
      left join public.categories cat on cat.id = c.category_id
     where c.org_id = v_org
     order by c.started_at desc
     limit greatest(1, least(coalesce(p_limit, 30), 200));
end;
$$;

grant execute on function public.pos_stock_counts(text, text, int) to anon, authenticated;

-- --------------------------------------------------------------------------
-- What walked out of the door without being sold.
-- --------------------------------------------------------------------------
--
-- Every stock movement down that is NOT a sale: what a count found missing,
-- and what somebody wrote off by hand. Both are losses; a shop that separates
-- them learns something, because "counted short" and "written off as damaged"
-- have different cures.
--
-- Valued at the cost recorded ON THE MOVEMENT where there is one, and at the
-- product's cost today where there is not. Movements written before 0068
-- carry no cost, so their value is an estimate at today's prices and is
-- reported as such rather than left out.

create or replace function public.pos_shrinkage(
  p_register_token text, p_pin text, p_from date, p_to date
) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_rows jsonb; v_totals jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  if p_from > p_to then
    raise exception 'A report cannot end before it starts';
  end if;

  -- One statement: a CTE is visible only to the query it is attached to, so
  -- totalling in a second `select ... from m` finds no such relation.
  with m as (
    select coalesce(c.name, '—') as department,
           pr.name as item, pr.sku, m.reason::text as reason,
           m.qty_delta,
           coalesce(m.unit_cost, pr.cost) as unit_cost,
           m.unit_cost is null as estimated
      from public.stock_movements m
      join public.products pr on pr.id = m.product_id
      left join public.categories c on c.id = pr.category_id
     where m.org_id = v_user.org_id
       and m.reason in ('stocktake', 'adjustment')
       and m.qty_delta < 0
       and m.created_at >= p_from
       and m.created_at < (p_to + 1)
  ),
  g as (
    select department, item, sku, reason,
           -sum(qty_delta) as qty,
           round(sum(-qty_delta * coalesce(unit_cost, 0)), 2) as at_cost,
           -- True where the figure is today's cost rather than the cost on the
           -- day it was lost. A number nobody can trust is worse than none.
           bool_or(estimated) as estimated
      from m
     group by department, item, sku, reason
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'department', department, 'item', item, 'sku', sku,
           'reason', reason, 'qty', qty, 'at_cost', at_cost,
           'estimated', estimated) order by at_cost desc), '[]'::jsonb),
         jsonb_build_object(
           'at_cost', coalesce(round(sum(at_cost), 2), 0),
           'counted_short', coalesce(round(sum(
             case when reason = 'stocktake' then at_cost else 0 end), 2), 0),
           'written_off', coalesce(round(sum(
             case when reason = 'adjustment' then at_cost else 0 end), 2), 0),
           'lines', count(*),
           'any_estimated', coalesce(bool_or(estimated), false))
    into v_rows, v_totals
    from g;

  return jsonb_build_object('rows', v_rows, 'totals', v_totals,
                            'from', p_from, 'to', p_to);
end;
$$;

grant execute on function public.pos_shrinkage(text, text, date, date)
  to anon, authenticated;
