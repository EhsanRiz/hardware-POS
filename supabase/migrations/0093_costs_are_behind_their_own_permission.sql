-- view_cost_prices means what it says, in every report.
--
-- "See cost prices and margins" was enforced on the catalogue screen and
-- nowhere else: six report and inventory RPCs handed out cost and margin
-- behind view_reports or manage_inventory. A manager holds all three by
-- role, so nothing showed in normal use; the hole opened the moment an
-- owner gave a counter supervisor "View reports" as an extra, believing
-- costs stayed behind the permission the screen said they were behind.
--
-- Two shapes of fix. Reports that ARE the cost — stock at cost, margin
-- slipped, shrinkage, what a delivery cost — need view_cost_prices as well.
-- Reports that carry a cost column among others — by department, by item,
-- what to order — keep the row and null the cost keys for a caller without
-- it; the screens already show a null cost as "—" (an uncosted line).

create function public.without_costs(j jsonb) returns jsonb
language sql immutable as $$
  select case jsonb_typeof(j)
    when 'array' then coalesce((select jsonb_agg(public.without_costs(e)) from jsonb_array_elements(j) e), '[]'::jsonb)
    when 'object' then (
      select coalesce(jsonb_object_agg(k,
               case when k in ('cost', 'margin', 'margin_percent', 'at_cost', 'cost_at_sale',
                               'unit_cost', 'gross_profit', 'uncosted_lines')
                    then 'null'::jsonb
                    else public.without_costs(v) end), '{}'::jsonb)
        from jsonb_each(j) as t(k, v))
    else j end;
$$;
revoke execute on function public.without_costs(jsonb) from anon, authenticated, public;

-- pos_stock_value: costs are the report.
create or replace function public.pos_stock_value(
  p_register_token text, p_pin text
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_rows jsonb; v_totals jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  -- Cost is the whole of this report (0093); view_reports alone does not see it.
  perform public.user_with_perm(p_register_token, p_pin, 'view_cost_prices');

  with p as (
    select coalesce(c.name, '—') as department,
           pr.stock_qty, pr.cost, pr.price_retail
      from public.products pr
      left join public.categories c on c.id = pr.category_id
     where pr.org_id = v_user.org_id and pr.active
       -- Untracked lines (services, delivery) have no quantity and so no value
       -- on a shelf. Counting them as zero would be right; listing them as
       -- rows of zeroes is noise.
       and pr.stock_qty is not null
  )
  select coalesce(jsonb_agg(row order by (row->>'at_cost')::numeric desc nulls last), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'department', department,
        'lines', count(*),
        'units', sum(stock_qty),
        'at_cost', sum(stock_qty * cost),
        'at_retail', sum(stock_qty * price_retail),
        'uncosted_lines', count(*) filter (where cost is null),
        'negative_lines', count(*) filter (where stock_qty < 0)
      ) as row
      from p group by department
    ) t;

  select jsonb_build_object(
    'at_cost', coalesce(sum(stock_qty * cost), 0),
    'at_retail', coalesce(sum(stock_qty * price_retail), 0),
    'units', coalesce(sum(stock_qty), 0),
    'lines', count(*),
    'uncosted_lines', count(*) filter (where cost is null),
    -- Stock that has gone below zero is not a valuation problem, it is a
    -- counting problem, and it makes every figure above it a guess.
    'negative_lines', count(*) filter (where stock_qty < 0)
  ) into v_totals
    from public.products pr
   where pr.org_id = v_user.org_id and pr.active and pr.stock_qty is not null;

  return jsonb_build_object('departments', v_rows, 'totals', v_totals);
end;
$$;

-- pos_margin_slipped: costs are the report.
create or replace function public.pos_margin_slipped(
  p_register_token text, p_pin text, p_below numeric default 15
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_rows jsonb; v_rate numeric;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  -- Cost is the whole of this report (0093); view_reports alone does not see it.
  perform public.user_with_perm(p_register_token, p_pin, 'view_cost_prices');
  v_rate := coalesce(public.tax_rate_at('standard', current_date), 0);

  select coalesce(jsonb_agg(row order by (row->>'margin_percent')::numeric asc nulls first), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'sku', pr.sku, 'item', pr.name,
        'department', coalesce(c.name, '—'),
        'cost', pr.cost, 'retail', pr.price_retail,
        'on_hand', pr.stock_qty,
        -- Retail includes VAT; cost does not. Comparing them raw is the
        -- mistake that makes every margin in a shop look 15 points better
        -- than it is.
        'net_retail', round(pr.price_retail / (1 + v_rate), 2),
        'margin', round(pr.price_retail / (1 + v_rate) - pr.cost, 2),
        'margin_percent', case
          when pr.price_retail <= 0 then null
          else round((pr.price_retail / (1 + v_rate) - pr.cost)
                     / (pr.price_retail / (1 + v_rate)) * 100, 1) end,
        'below_cost', pr.price_retail / (1 + v_rate) < pr.cost
      ) as row
      from public.products pr
      left join public.categories c on c.id = pr.category_id
     where pr.org_id = v_user.org_id and pr.active
       and pr.cost is not null and pr.cost > 0 and pr.price_retail > 0
       and (pr.price_retail / (1 + v_rate) - pr.cost)
           / (pr.price_retail / (1 + v_rate)) * 100
           < greatest(0, least(coalesce(p_below, 15), 100))
     limit 200
    ) t;
  return v_rows;
end;
$$;

-- pos_shrinkage: costs are the report.
create or replace function public.pos_shrinkage(
  p_register_token text, p_pin text, p_from date, p_to date
) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_rows jsonb; v_totals jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  -- Cost is the whole of this report (0093); view_reports alone does not see it.
  perform public.user_with_perm(p_register_token, p_pin, 'view_cost_prices');
  if p_from > p_to then
    raise exception 'A report cannot end before it starts';
  end if;

  with m as (
    select coalesce(c.name, '—') as department,
           pr.name as item, pr.sku, m.reason::text as reason,
           m.qty_delta,
           coalesce(m.unit_cost, pr.cost) as unit_cost,
           -- Three states, not two: what it cost on the day, what it costs
           -- today, and no idea.
           (m.unit_cost is null and pr.cost is not null) as estimated,
           coalesce(m.unit_cost, pr.cost) is null as uncosted
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
           bool_or(estimated) as estimated,
           bool_or(uncosted) as uncosted
      from m
     group by department, item, sku, reason
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'department', department, 'item', item, 'sku', sku,
           'reason', reason, 'qty', qty, 'at_cost', at_cost,
           'estimated', estimated, 'uncosted', uncosted) order by at_cost desc),
         '[]'::jsonb),
         jsonb_build_object(
           'at_cost', coalesce(round(sum(at_cost), 2), 0),
           'counted_short', coalesce(round(sum(
             case when reason = 'stocktake' then at_cost else 0 end), 2), 0),
           'written_off', coalesce(round(sum(
             case when reason = 'adjustment' then at_cost else 0 end), 2), 0),
           'lines', count(*),
           'any_estimated', coalesce(bool_or(estimated), false),
           -- Counted, not valued. Folding them in at zero would make the
           -- total look better than the shop's actual position.
           'uncosted_lines', count(*) filter (where uncosted),
           'uncosted_units', coalesce(sum(qty) filter (where uncosted), 0))
    into v_rows, v_totals
    from g;

  return jsonb_build_object('rows', v_rows, 'totals', v_totals,
                            'from', p_from, 'to', p_to);
end;
$$;

-- pos_deliveries_report: costs are the report.
create or replace function public.pos_deliveries_report(
  p_register_token text, p_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_totals jsonb; v_rows jsonb;
        v_net numeric; v_cost numeric;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  -- Cost is the whole of this report (0093); view_reports alone does not see it.
  perform public.user_with_perm(p_register_token, p_pin, 'view_cost_prices');
  if p_from is null or p_to is null then raise exception 'A date range is required'; end if;
  if p_to < p_from then raise exception 'Those dates are the wrong way round'; end if;

  -- Earned and cost come from the same lines, walked once: the invoice is
  -- what the books believe, and cost_at_sale is what the trip was worth when
  -- it was made rather than what the figure happens to be today.
  select coalesce(sum(si.line_total - si.tax_amount), 0),
         coalesce(sum(si.cost_at_sale * si.qty), 0)
    into v_net, v_cost
    from public.sale_items si
    join public.sales sa on sa.id = si.sale_id
    join public.products p on p.id = si.product_id
   where sa.org_id = v_user.org_id and sa.status = 'completed'
     and coalesce(p.kind, 'goods') = 'delivery'
     and sa.created_at >= p_from and sa.created_at < p_to;

  with d as (
    select * from public.deliveries
     where org_id = v_user.org_id
       and created_at >= p_from and created_at < p_to
  )
  select jsonb_build_object(
    'count',        (select count(*) from d),
    'delivered',    (select count(*) filter (where status = 'delivered') from d),
    'outstanding',  (select count(*) filter (where status = 'pending') from d),
    -- Promised for a day that has passed and still not signed for. Counted
    -- across the whole book, not only this window: a note from three weeks ago
    -- that never went out is exactly the one nobody is looking at.
    'late',         (select count(*) from public.deliveries
                      where org_id = v_user.org_id and status = 'pending'
                        and deliver_on < current_date),
    'carriage',     (select coalesce(sum(charge), 0) from d),
    'carriage_free',(select count(*) filter (where charge = 0) from d),
    'carriage_net', v_net,
    'carriage_cost', v_cost,
    -- What delivering is actually worth. It can be negative, and a shop that
    -- delivers free to keep a builder happy should be able to see what that
    -- decision costs rather than assume it is free.
    'carriage_margin', round(v_net - v_cost, 2)
  ) into v_totals;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'doc_number', x.doc_number, 'customer_name', x.customer_name,
           'address', x.address, 'deliver_on', x.deliver_on, 'deliver_at', x.deliver_at,
           'charge', x.charge, 'sale_number', x.sale_number, 'cashier_name', x.cashier_name,
           'days_late', greatest(0, current_date - x.deliver_on)
         ) order by x.deliver_on, x.created_at), '[]'::jsonb)
    into v_rows
    from (
      select d.*, s.doc_number as sale_number
        from public.deliveries d
        join public.sales s on s.id = d.sale_id
       where d.org_id = v_user.org_id and d.status = 'pending'
       limit 200
    ) x;

  return jsonb_build_object('totals', v_totals, 'outstanding', v_rows);
end;
$$;

-- pos_sales_by_department: the row stays, the cost columns go.
create or replace function public.pos_sales_by_department(
  p_register_token text, p_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_rows jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  if p_from is null or p_to is null then raise exception 'A date range is required'; end if;
  if p_to < p_from then raise exception 'Those dates are the wrong way round'; end if;

  -- Margin is on the ex-VAT line against the cost the line was sold at. A
  -- line with no recorded cost contributes sales but no cost, and says so.
  with li as (
    select coalesce(c.name, '—') as department,
           si.qty, si.line_total, si.tax_amount,
           si.cost_at_sale * si.qty as cost
      from public.sale_items si
      join public.sales sa on sa.id = si.sale_id
      left join public.products p on p.id = si.product_id
      left join public.categories c on c.id = p.category_id
     where sa.org_id = v_user.org_id and sa.status = 'completed'
       and sa.created_at >= p_from and sa.created_at < p_to
  )
  select coalesce(jsonb_agg(row order by (row->>'sales')::numeric desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'department', department,
        'lines', count(*),
        'qty', sum(qty),
        'sales', sum(line_total),
        'vat', sum(tax_amount),
        'net', sum(line_total) - sum(tax_amount),
        'cost', sum(cost),
        'uncosted_lines', count(*) filter (where cost is null),
        'margin', case when sum(cost) is null then null
                       else sum(line_total) - sum(tax_amount) - sum(cost) end,
        'margin_percent', case
          when sum(cost) is null or sum(line_total) - sum(tax_amount) <= 0 then null
          else round((sum(line_total) - sum(tax_amount) - sum(cost))
                     / (sum(line_total) - sum(tax_amount)) * 100, 1) end
      ) as row
      from li group by department
    ) t;
  -- What it cost is behind its own permission (0093); the rest of the row is not.
  if not ('view_cost_prices' = any(public.effective_permissions(v_user))) then
    v_rows := public.without_costs(v_rows);
  end if;
  return v_rows;
end;
$$;

-- pos_item_movement: the row stays, the cost columns go.
create or replace function public.pos_item_movement(
  p_register_token text, p_pin text, p_from timestamptz, p_to timestamptz,
  p_limit int default 100
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_rows jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  if p_from is null or p_to is null then raise exception 'A date range is required'; end if;
  if p_to < p_from then raise exception 'Those dates are the wrong way round'; end if;

  select coalesce(jsonb_agg(row order by (row->>'sales')::numeric desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'sku', si.sku, 'item', si.name,
        'department', coalesce(c.name, '—'),
        'qty', sum(si.qty), 'unit', min(si.unit_code),
        'lines', count(*),
        'sales', sum(si.line_total),
        'net', sum(si.line_total) - sum(si.tax_amount),
        'cost', sum(si.cost_at_sale * si.qty),
        'uncosted_lines', count(*) filter (where si.cost_at_sale is null),
        'margin', case when sum(si.cost_at_sale * si.qty) is null then null
                       else sum(si.line_total) - sum(si.tax_amount)
                            - sum(si.cost_at_sale * si.qty) end,
        'on_hand', max(p.stock_qty)
      ) as row
      from public.sale_items si
      join public.sales sa on sa.id = si.sale_id
      left join public.products p on p.id = si.product_id
      left join public.categories c on c.id = p.category_id
     where sa.org_id = v_user.org_id and sa.status = 'completed'
       and sa.created_at >= p_from and sa.created_at < p_to
     group by si.sku, si.name, c.name
     limit greatest(1, least(coalesce(p_limit, 100), 500))
    ) t;
  -- What it cost is behind its own permission (0093); the rest of the row is not.
  if not ('view_cost_prices' = any(public.effective_permissions(v_user))) then
    v_rows := public.without_costs(v_rows);
  end if;
  return v_rows;
end;
$$;

-- pos_reorder_list: the row stays, the cost columns go.
create or replace function public.pos_reorder_list(
  p_register_token text, p_pin text
) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_org uuid; v_rows jsonb; v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_inventory');
  v_org := v_user.org_id;

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
  -- What it cost is behind its own permission (0093); the rest of the row is not.
  if not ('view_cost_prices' = any(public.effective_permissions(v_user))) then
    v_rows := public.without_costs(v_rows);
  end if;
  return v_rows;
end;
$$;
