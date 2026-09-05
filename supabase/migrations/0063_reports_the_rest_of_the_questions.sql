-- 0063 — the questions the reports could not answer.
--
-- 0049 gave an owner four: how did the shop do today, what sold by
-- department, what will the VAT return say, and can the accountant have the
-- lines. This adds the ones that were still being answered by hand, or not at
-- all — starting with the one that prompted it: what happened to deliveries.

-- --------------------------------------------------------------------------
-- 1. Delivery is a department, not a dash.
-- --------------------------------------------------------------------------
--
-- The carriage charge is a sale line, so its money was already right
-- everywhere it mattered: the day close counted it, the VAT return included
-- it, the export carried it. But the product had no category, so it landed in
-- the Departments report under '—' at a hundred percent margin, next to
-- whatever else nobody had filed. An owner could not see what delivery
-- earned, and the dash flattered itself.

create or replace function public.delivery_product(p_org uuid)
returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_product public.products; v_unit text; v_cat uuid;
begin
  select * into v_product from public.products
   where org_id = p_org and kind = 'delivery' order by created_at limit 1;
  if found then return v_product; end if;

  -- 'ea' by name, because the till's receipt reads that one string. The
  -- fallback is by sort_order rather than alphabetically: 'ea' is first in the
  -- catalogue's own ordering and 'bag' is merely first in the dictionary.
  select code into v_unit from public.units_of_measure where code = 'ea';
  if v_unit is null then
    select code into v_unit from public.units_of_measure
     where not allows_fraction order by sort_order limit 1;
  end if;

  v_cat := public.delivery_category(p_org);

  insert into public.products (org_id, sku, name, unit_code, price_retail,
                               cost, active, kind, stock_qty, category_id)
  values (p_org, 'DELIVERY', 'Delivery', coalesce(v_unit, 'ea'), 0, 0, true,
          'delivery', null, v_cat)
  returning * into v_product;
  return v_product;
end;
$$;

/** The department a carriage charge belongs to. Made once, on first use. */
create or replace function public.delivery_category(p_org uuid)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  select id into v_id from public.categories
   where org_id = p_org and lower(name) = 'delivery' limit 1;
  if v_id is not null then return v_id; end if;
  -- Last in the list: it is a service, and an owner reading the department
  -- table wants the goods first.
  insert into public.categories (org_id, name, sort_order)
  values (p_org, 'Delivery', 900)
  returning id into v_id;
  return v_id;
end;
$$;

-- The shops that already charged for a delivery before this existed.
do $$
declare v_org uuid;
begin
  for v_org in select distinct org_id from public.products
                where kind = 'delivery' and category_id is null loop
    update public.products
       set category_id = public.delivery_category(v_org)
     where org_id = v_org and kind = 'delivery' and category_id is null;
  end loop;
end $$;

-- --------------------------------------------------------------------------
-- 2. The deliveries themselves.
-- --------------------------------------------------------------------------
--
-- Money is only half of it. The other half is whether the shop did what it
-- promised: how many went out, how many are still outstanding, and how many
-- are past the day they were promised for — which is the number that turns
-- into a phone call from a builder standing on a site.

create or replace function public.pos_deliveries_report(
  p_register_token text, p_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_totals jsonb; v_rows jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  if p_from is null or p_to is null then raise exception 'A date range is required'; end if;
  if p_to < p_from then raise exception 'Those dates are the wrong way round'; end if;

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
    -- What the carriage actually earned, ex VAT, from the sale lines rather
    -- than from the note: the note records what was agreed, the line records
    -- what was charged, and the second is the one the books believe.
    'carriage_net', (select coalesce(sum(si.line_total - si.tax_amount), 0)
                       from public.sale_items si
                       join public.sales sa on sa.id = si.sale_id
                       join public.products p on p.id = si.product_id
                      where sa.org_id = v_user.org_id and sa.status = 'completed'
                        and coalesce(p.kind, 'goods') = 'delivery'
                        and sa.created_at >= p_from and sa.created_at < p_to)
  ) into v_totals;

  -- Everything still owed to somebody, oldest promise first. Not limited to
  -- the window: an outstanding delivery does not stop being outstanding
  -- because the report is looking at this week.
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

grant execute on function public.pos_deliveries_report(text, text, timestamptz, timestamptz)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- 3. Who sold it, and who gave the money away.
-- --------------------------------------------------------------------------
--
-- The day close is per DRAWER, which answers "does the till balance". It does
-- not answer "how did Thabo do this week" or "who is discounting", because
-- two people can work the same drawer and one person can work three.

create or replace function public.pos_sales_by_cashier(
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

  with s as (
    select sa.cashier_id, sa.cashier_name, sa.total, sa.tax_amount,
           sa.discount_amount, sa.id
      from public.sales sa
     where sa.org_id = v_user.org_id and sa.status = 'completed'
       and sa.created_at >= p_from and sa.created_at < p_to
  ),
  r as (
    select rt.by_user as cashier_id, count(*) as n, coalesce(sum(rt.total), 0) as total
      from public.returns rt
     where rt.org_id = v_user.org_id
       and rt.created_at >= p_from and rt.created_at < p_to
     group by 1
  )
  select coalesce(jsonb_agg(row order by (row->>'sales')::numeric desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'cashier', coalesce(s.cashier_name, '—'),
        'sales_count', count(*),
        'sales', sum(s.total),
        'net', sum(s.total) - sum(s.tax_amount),
        'average', round(sum(s.total) / greatest(count(*), 1), 2),
        -- sales.discount_amount is ALREADY the whole discount: pos_create_sale
        -- adds the line discounts to the sale's own before it writes the row
        -- (v_all_disc). Adding the lines again here counted every marked-down
        -- item twice, which the database test caught by giving R5 away and
        -- being told R10.
        'discount', sum(s.discount_amount),
        'refunds_count', coalesce(max(r.n), 0),
        'refunds', coalesce(max(r.total), 0)
      ) as row
      from s
      left join r on r.cashier_id = s.cashier_id
      group by s.cashier_id, s.cashier_name
    ) t;
  return v_rows;
end;
$$;

grant execute on function public.pos_sales_by_cashier(text, text, timestamptz, timestamptz)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- 4. Money that went back across the counter.
-- --------------------------------------------------------------------------
--
-- The day close gives a refunds TOTAL. A total cannot be looked into, and
-- "R4 300 of refunds" is a question, not an answer. Both kinds are here: a
-- return of goods, and a sale cancelled outright (0054), which is a different
-- event with a different reason and had no report at all.

create or replace function public.pos_money_back(
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

  select coalesce(jsonb_agg(row order by (row->>'at') desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'kind', 'return', 'at', r.created_at, 'amount', r.total,
        'doc_number', r.doc_number, 'against', s.doc_number,
        'who', r.by_name, 'reason', r.reason,
        'refund_method', r.refund_method
      ) as row
      from public.returns r
      left join public.sales s on s.id = r.sale_id
     where r.org_id = v_user.org_id
       and r.created_at >= p_from and r.created_at < p_to
      union all
      select jsonb_build_object(
        'kind', 'cancelled', 'at', sa.voided_at, 'amount', sa.total,
        'doc_number', sa.doc_number, 'against', null,
        -- Who rang it up; the cancellation itself needed a manager's PIN or a
        -- phoned code, which pos_void_sale records against the sale.
        'who', sa.cashier_name, 'reason', sa.void_reason,
        'refund_method', sa.payment_method::text
      )
      from public.sales sa
     where sa.org_id = v_user.org_id and sa.voided_at is not null
       and sa.voided_at >= p_from and sa.voided_at < p_to
    ) t;
  return v_rows;
end;
$$;

grant execute on function public.pos_money_back(text, text, timestamptz, timestamptz)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- 5. What moved, line by line.
-- --------------------------------------------------------------------------
--
-- Departments is the only product-level view there was, and it is aggregated
-- to a category — so "what actually sells" and "what has not moved since
-- March" were both questions you could only answer by exporting to a
-- spreadsheet and sorting it yourself.

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
  return v_rows;
end;
$$;

grant execute on function public.pos_item_movement(text, text, timestamptz, timestamptz, int)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- 6. What the shelves are worth.
-- --------------------------------------------------------------------------
--
-- The number an accountant asks for at year end, and the one nobody in the
-- shop can produce without walking the aisles with a clipboard. Stock at COST
-- is the figure that goes in the books; stock at retail is what it would ring
-- up as, and the gap between them is the profit still sitting on the shelf.

create or replace function public.pos_stock_value(
  p_register_token text, p_pin text
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_rows jsonb; v_totals jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');

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

grant execute on function public.pos_stock_value(text, text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- 7. Where the margin went.
-- --------------------------------------------------------------------------
--
-- Promised when the purchasing side went in and never built. Cost is a fact
-- the shop records when goods arrive; retail is a decision it makes on
-- purpose, and nothing moves it automatically. So a supplier's price rise
-- quietly eats the margin on a line until somebody notices — which is what
-- this is for.

create or replace function public.pos_margin_slipped(
  p_register_token text, p_pin text, p_below numeric default 15
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_rows jsonb; v_rate numeric;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
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

grant execute on function public.pos_margin_slipped(text, text, numeric) to anon, authenticated;

-- --------------------------------------------------------------------------
-- 8. Who owes, and how old it is.
-- --------------------------------------------------------------------------
--
-- customer_aging() has answered this per customer since 0024, on the Accounts
-- screen, one name at a time. The whole book aged into buckets is the thing
-- somebody prints before ringing round on a Friday afternoon.

create or replace function public.pos_debtors_ageing(
  p_register_token text, p_pin text
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_rows jsonb; v_totals jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');

  select coalesce(jsonb_agg(row order by (row->>'total_due')::numeric desc), '[]'::jsonb),
         jsonb_build_object(
           'current', coalesce(sum((row->>'current_due')::numeric), 0),
           'days30',  coalesce(sum((row->>'days30')::numeric), 0),
           'days60',  coalesce(sum((row->>'days60')::numeric), 0),
           'days90',  coalesce(sum((row->>'days90')::numeric), 0),
           'total',   coalesce(sum((row->>'total_due')::numeric), 0),
           'accounts', count(*))
    into v_rows, v_totals
    from (
      select jsonb_build_object(
        'customer_id', cu.id, 'customer', cu.name, 'code', cu.code,
        'phone', cu.phone,
        'current_due', a.current_due, 'days30', a.days30,
        'days60', a.days60, 'days90', a.days90,
        'total_due', a.total_due, 'oldest_unpaid', a.oldest_unpaid,
        'credit_limit', cu.credit_limit
      ) as row
      from public.customers cu
      cross join lateral public.customer_aging(cu.id) a
     where cu.org_id = v_user.org_id and a.total_due > 0
    ) t;

  return jsonb_build_object('rows', v_rows, 'totals', v_totals);
end;
$$;

grant execute on function public.pos_debtors_ageing(text, text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- 9. What the shop spent, and with whom.
-- --------------------------------------------------------------------------
--
-- The purchasing side (0055-0058) records every supplier document and what
-- was booked in against it. None of it reached a report, so the money going
-- OUT of the shop was the one direction nobody could total.

create or replace function public.pos_purchases_by_supplier(
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

  select coalesce(jsonb_agg(row order by (row->>'total')::numeric desc nulls last), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'supplier', su.name,
        'documents', count(*),
        -- A quotation is not a purchase. Only what was invoiced or delivered
        -- counts as money the shop owes or has paid.
        'received', count(*) filter (where sd.status = 'received'),
        'total', sum(sd.total) filter (where sd.kind in ('invoice', 'delivery_note')),
        'quoted', sum(sd.total) filter (where sd.kind = 'quote'),
        'last_document', max(coalesce(sd.doc_date, sd.created_at::date))
      ) as row
      from public.supplier_documents sd
      join public.suppliers su on su.id = sd.supplier_id
     where sd.org_id = v_user.org_id
       and coalesce(sd.doc_date, sd.created_at::date)
           between p_from::date and (p_to::date - 1)
     group by su.name
    ) t;
  return v_rows;
end;
$$;

grant execute on function public.pos_purchases_by_supplier(text, text, timestamptz, timestamptz)
  to anon, authenticated;
