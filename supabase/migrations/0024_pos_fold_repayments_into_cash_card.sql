-- ---------------------------------------------------------------------------
-- Fold account REPAYMENTS into the Cash / Card figures by how they were
-- collected (so Cash = cash sales + cash tab-settlements, matching the drawer).
-- The split is still returned (account_repaid_cash/card) for an "incl. repaid"
-- note. On-account *charges* (credit given out) are unaffected — they stay as
-- "owed" and out of the collected total. Collected total is unchanged; only the
-- grouping moves.
-- ---------------------------------------------------------------------------
create or replace function public.pos_end_of_day(
  p_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_actor public.app_users; v_out jsonb;
  v_count int; v_gross numeric; v_discount numeric; v_tips numeric;
  v_cash_sales numeric; v_card_sales numeric; v_account numeric; v_other numeric;
  v_rc numeric; v_rk numeric;
begin
  v_actor := public.pos_active_user(p_pin);
  if v_actor.id is null then raise exception 'Not signed in'; end if;

  select count(*), coalesce(sum(subtotal),0), coalesce(sum(discount_amount),0),
         coalesce(sum(tip_amount),0),
         coalesce(sum(total) filter (where payment_method='cash'),0),
         coalesce(sum(total) filter (where payment_method='card'),0),
         coalesce(sum(total) filter (where payment_method='account'),0),
         coalesce(sum(total) filter (where payment_method is null),0)
    into v_count, v_gross, v_discount, v_tips, v_cash_sales, v_card_sales, v_account, v_other
  from public.sales
  where status='completed' and created_at >= p_from and created_at < p_to;

  select coalesce(sum(amount) filter (where method='cash'),0),
         coalesce(sum(amount) filter (where method='card'),0)
    into v_rc, v_rk
  from public.account_payments where created_at >= p_from and created_at < p_to;

  v_out := jsonb_build_object(
    'sales_count', v_count, 'gross', v_gross, 'discount', v_discount, 'tips', v_tips,
    -- Cash / Card now include account repayments collected by that method.
    'cash', v_cash_sales + v_rc, 'card', v_card_sales + v_rk,
    'account', v_account, 'other', v_other,
    'account_repaid_cash', v_rc, 'account_repaid_card', v_rk,
    'net', v_cash_sales + v_rc + v_card_sales + v_rk + v_other
  );

  -- Per cashier: fold each staff member's repayments (by who received them) into
  -- their cash / card. Full join so repayment-only staff still appear.
  v_out := v_out || jsonb_build_object('by_cashier', (
    with sales_by as (
      select cashier_name as name, count(*)::int as sales,
             coalesce(sum(total) filter (where payment_method='cash'),0) as cash_sales,
             coalesce(sum(total) filter (where payment_method='card'),0) as card_sales,
             coalesce(sum(total) filter (where payment_method='account'),0) as account,
             coalesce(sum(total) filter (where payment_method is null),0) as other,
             coalesce(sum(tip_amount),0) as tips,
             coalesce(sum(discount_amount),0) as discount
      from public.sales
      where status='completed' and created_at >= p_from and created_at < p_to
      group by cashier_name
    ),
    rep_by as (
      select received_by_name as name,
             coalesce(sum(amount) filter (where method='cash'),0) as rc,
             coalesce(sum(amount) filter (where method='card'),0) as rk
      from public.account_payments
      where created_at >= p_from and created_at < p_to and received_by_name is not null
      group by received_by_name
    ),
    merged as (
      select coalesce(s.name, r.name) as name,
             coalesce(s.sales,0) as sales,
             coalesce(s.cash_sales,0) + coalesce(r.rc,0) as cash,
             coalesce(s.card_sales,0) + coalesce(r.rk,0) as card,
             coalesce(s.account,0) as account,
             coalesce(s.other,0) as other,
             coalesce(s.tips,0) as tips,
             coalesce(s.discount,0) as discount,
             coalesce(r.rc,0) as repaid_cash,
             coalesce(r.rk,0) as repaid_card
      from sales_by s full join rep_by r on s.name = r.name
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', name, 'sales', sales, 'cash', cash, 'card', card, 'account', account,
      'other', other, 'tips', tips, 'discount', discount,
      'repaid_cash', repaid_cash, 'repaid_card', repaid_card,
      'net', cash + card + other) order by (cash + card + other) desc), '[]'::jsonb)
    from merged));

  return v_out;
end;
$$;

-- Reports summary: mirror the same treatment so the two screens agree.
create or replace function public.pos_manager_sales_summary(
  p_manager_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_actor public.app_users; v_out jsonb;
  v_count int; v_gross numeric; v_discount numeric; v_tips numeric;
  v_cash_sales numeric; v_card_sales numeric; v_other numeric; v_owed numeric;
  v_rc numeric; v_rk numeric;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'view_reports');
  if v_actor.id is null then raise exception 'Not permitted to view reports'; end if;

  select count(*), coalesce(sum(subtotal),0), coalesce(sum(discount_amount),0),
         coalesce(sum(tip_amount),0),
         coalesce(sum(total) filter (where payment_method='cash'),0),
         coalesce(sum(total) filter (where payment_method='card'),0),
         coalesce(sum(total) filter (where payment_method is null),0),
         coalesce(sum(total) filter (where payment_method='account'),0)
    into v_count, v_gross, v_discount, v_tips, v_cash_sales, v_card_sales, v_other, v_owed
  from public.sales
  where status='completed' and created_at >= p_from and created_at < p_to;

  select coalesce(sum(amount) filter (where method='cash'),0),
         coalesce(sum(amount) filter (where method='card'),0)
    into v_rc, v_rk
  from public.account_payments where created_at >= p_from and created_at < p_to;

  v_out := jsonb_build_object(
    'sales_count', v_count, 'gross', v_gross, 'discount', v_discount, 'tips', v_tips,
    'cash', v_cash_sales + v_rc, 'card', v_card_sales + v_rk,
    'account_owed', v_owed, 'account_repaid', v_rc + v_rk,
    'net', v_cash_sales + v_rc + v_card_sales + v_rk + v_other
  );

  v_out := v_out || jsonb_build_object('top_items', (
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select si.name, sum(si.qty)::int as qty, sum(si.line_total) as revenue
      from public.sale_items si join public.sales s on s.id = si.sale_id
      where s.status='completed' and s.created_at >= p_from and s.created_at < p_to
      group by si.name order by sum(si.qty) desc limit 5) t));

  v_out := v_out || jsonb_build_object('by_cashier', (
    select coalesce(jsonb_agg(c), '[]'::jsonb) from (
      select cashier_name as name, count(*)::int as sales,
             coalesce(sum(total) filter (where payment_method is distinct from 'account'),0) as net
      from public.sales
      where status='completed' and created_at >= p_from and created_at < p_to
      group by cashier_name order by 3 desc) c));

  v_out := v_out || jsonb_build_object('by_method', (
    select coalesce(jsonb_object_agg(coalesce(payment_method,'other'), net), '{}'::jsonb) from (
      select payment_method, sum(total) as net from public.sales
      where status='completed' and created_at >= p_from and created_at < p_to
      group by payment_method) m));

  return v_out;
end;
$$;
