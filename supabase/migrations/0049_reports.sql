-- 0049: the numbers, out of the till.
--
-- Until now the shop's figures left the building on slips. Four functions
-- change that, all behind view_reports and all read-only:
--
--   pos_day_close        — the whole shop for a window: every till's drawer,
--                          card and EFT check, and banking side by side, and
--                          the shop totals across them. The cash-up is per
--                          till; this is the page that adds the tills up.
--   pos_sales_by_department — what sold, by department, with margin from
--                          cost_at_sale — the cost the line was actually
--                          sold against, so a later price change does not
--                          rewrite history.
--   pos_vat_by_month     — output VAT by month for the return: gross, VAT
--                          within, net, and the credit notes against them.
--   pos_export_sales     — one row per line sold, for a CSV the accountant
--                          can open. Capped, so a careless range cannot pull
--                          a year of lines through a tablet.
--
-- Windows are timestamptz from the device, like pos_sales_history: local
-- midnight is the device's business. Months need a zone to fall into, so the
-- VAT report takes one, defaulting to the shop's.

create function public.pos_day_close(
  p_register_token text, p_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_sessions jsonb; v_totals jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  if p_from is null or p_to is null then raise exception 'A date range is required'; end if;
  if p_to < p_from then raise exception 'Those dates are the wrong way round'; end if;

  -- Every till that had a drawer open at any point in the window.
  select coalesce(jsonb_agg(
           to_jsonb(cs)
           || jsonb_build_object(
                'register_name', r.name,
                'figures', public.cash_session_figures(cs))
           order by r.name, cs.opened_at), '[]'::jsonb)
    into v_sessions
    from public.cash_sessions cs
    left join public.registers r on r.id = cs.register_id
   where cs.org_id = v_user.org_id
     and cs.opened_at < p_to
     and coalesce(cs.closed_at, now()) >= p_from;

  with s as (
    select sa.id, sa.total, sa.tax_amount, sa.discount_amount
      from public.sales sa
     where sa.org_id = v_user.org_id and sa.status = 'completed'
       and sa.created_at >= p_from and sa.created_at < p_to
  ),
  tender as (
    select sp.method::text as method, sum(sp.amount) as amount
      from public.sale_payments sp join s on s.id = sp.sale_id
     group by 1
  ),
  acct as (
    select cp.method as method, sum(cp.amount) as amount
      from public.customer_payments cp
     where cp.org_id = v_user.org_id and cp.voided_at is null
       and cp.created_at >= p_from and cp.created_at < p_to
     group by 1
  ),
  ret as (
    select count(*) as n, coalesce(sum(r.total), 0) as total
      from public.returns r
     where r.org_id = v_user.org_id
       and r.created_at >= p_from and r.created_at < p_to
  ),
  drawers as (
    select count(*) filter (where cs.closed_at is null) as still_open,
           coalesce(sum(cs.opening_float), 0) as floats,
           coalesce(sum(cs.expected_cash), 0) as cash_expected,
           coalesce(sum(cs.counted_cash), 0) as cash_counted,
           coalesce(sum(cs.variance), 0) as cash_variance,
           coalesce(sum(cs.card_counted), 0) as card_counted,
           coalesce(sum(cs.card_variance), 0) as card_variance,
           coalesce(sum(cs.eft_counted), 0) as eft_counted,
           coalesce(sum(cs.eft_variance), 0) as eft_variance,
           coalesce(sum(cs.banked), 0) as banked,
           coalesce(sum(cs.float_kept), 0) as float_kept
      from public.cash_sessions cs
     where cs.org_id = v_user.org_id
       and cs.opened_at < p_to
       and coalesce(cs.closed_at, now()) >= p_from
  )
  select jsonb_build_object(
    'sales_count',      (select count(*) from s),
    'sales_total',      (select coalesce(sum(total), 0) from s),
    'vat_total',        (select coalesce(sum(tax_amount), 0) from s),
    'discount_total',   (select coalesce(sum(discount_amount), 0) from s),
    'refunds_count',    (select n from ret),
    'refunds_total',    (select total from ret),
    'tenders',          (select coalesce(jsonb_object_agg(method, amount), '{}'::jsonb) from tender),
    'account_payments', (select coalesce(jsonb_object_agg(method, amount), '{}'::jsonb) from acct),
    'card_expected',    coalesce((select amount from tender where method = 'card'), 0)
                          + coalesce((select amount from acct where method = 'card'), 0),
    'eft_expected',     coalesce((select amount from tender where method = 'eft'), 0)
                          + coalesce((select amount from acct where method = 'eft'), 0),
    'sessions_open',    (select still_open from drawers),
    'floats',           (select floats from drawers),
    'cash_expected',    (select cash_expected from drawers),
    'cash_counted',     (select cash_counted from drawers),
    'cash_variance',    (select cash_variance from drawers),
    'card_counted',     (select card_counted from drawers),
    'card_variance',    (select card_variance from drawers),
    'eft_counted',      (select eft_counted from drawers),
    'eft_variance',     (select eft_variance from drawers),
    'banked',           (select banked from drawers),
    'float_kept',       (select float_kept from drawers)
  ) into v_totals;

  return jsonb_build_object('sessions', v_sessions, 'totals', v_totals);
end;
$$;
grant execute on function public.pos_day_close(text, text, timestamptz, timestamptz) to anon, authenticated;

create function public.pos_sales_by_department(
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
  return v_rows;
end;
$$;
grant execute on function public.pos_sales_by_department(text, text, timestamptz, timestamptz) to anon, authenticated;

create function public.pos_vat_by_month(
  p_register_token text, p_pin text, p_months int default 12,
  p_tz text default 'Africa/Johannesburg'
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_rows jsonb; v_from timestamptz;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  v_from := (date_trunc('month', (now() at time zone p_tz))
             - make_interval(months => greatest(0, least(coalesce(p_months, 12), 36)) - 1))
            at time zone p_tz;

  with sm as (
    select to_char(date_trunc('month', sa.created_at at time zone p_tz), 'YYYY-MM') as month,
           count(*) as sales_count,
           sum(sa.total) as gross,
           sum(sa.tax_amount) as vat
      from public.sales sa
     where sa.org_id = v_user.org_id and sa.status = 'completed'
       and sa.created_at >= v_from
     group by 1
  ),
  rm as (
    select to_char(date_trunc('month', r.created_at at time zone p_tz), 'YYYY-MM') as month,
           sum(r.total) as refunds, sum(r.tax_total) as refunds_vat
      from public.returns r
     where r.org_id = v_user.org_id and r.created_at >= v_from
     group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'month', m.month,
           'sales_count', coalesce(sm.sales_count, 0),
           'gross', coalesce(sm.gross, 0),
           'vat', coalesce(sm.vat, 0),
           'net', coalesce(sm.gross, 0) - coalesce(sm.vat, 0),
           'refunds', coalesce(rm.refunds, 0),
           'refunds_vat', coalesce(rm.refunds_vat, 0),
           'vat_due', coalesce(sm.vat, 0) - coalesce(rm.refunds_vat, 0)
         ) order by m.month desc), '[]'::jsonb)
    into v_rows
    from (select distinct month from (select month from sm union select month from rm) u) m
    left join sm on sm.month = m.month
    left join rm on rm.month = m.month;
  return v_rows;
end;
$$;
grant execute on function public.pos_vat_by_month(text, text, int, text) to anon, authenticated;

create function public.pos_export_sales(
  p_register_token text, p_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_rows jsonb; v_n int;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  if p_from is null or p_to is null then raise exception 'A date range is required'; end if;
  if p_to < p_from then raise exception 'Those dates are the wrong way round'; end if;

  select count(*) into v_n
    from public.sale_items si join public.sales sa on sa.id = si.sale_id
   where sa.org_id = v_user.org_id and sa.created_at >= p_from and sa.created_at < p_to;
  if v_n > 20000 then
    raise exception 'That range has % lines — export a shorter one', v_n;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'doc_number', sa.doc_number,
           'created_at', sa.created_at,
           'status', sa.status,
           'cashier', sa.cashier_name,
           'customer', sa.customer_name,
           'payment_method', sa.payment_method,
           'sku', si.sku,
           'item', si.name,
           'department', c.name,
           'qty', si.qty,
           'unit', si.unit_code,
           'unit_price', si.unit_price,
           'line_total', si.line_total,
           'vat', si.tax_amount,
           'discount', si.discount_amount,
           'cost_at_sale', si.cost_at_sale
         ) order by sa.created_at, sa.doc_number, si.name), '[]'::jsonb)
    into v_rows
    from public.sale_items si
    join public.sales sa on sa.id = si.sale_id
    left join public.products p on p.id = si.product_id
    left join public.categories c on c.id = p.category_id
   where sa.org_id = v_user.org_id
     and sa.created_at >= p_from and sa.created_at < p_to;
  return v_rows;
end;
$$;
grant execute on function public.pos_export_sales(text, text, timestamptz, timestamptz) to anon, authenticated;
