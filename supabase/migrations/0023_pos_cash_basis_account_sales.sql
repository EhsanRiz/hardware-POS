-- ---------------------------------------------------------------------------
-- Cash-basis revenue: on-account (credit) sales are NOT counted as income until
-- the customer repays. "Total sales" now = cash + card + (other) sales actually
-- collected + account repayments received in the period. On-account charges are
-- reported separately as money owed. Item quantities (top sellers / item
-- history) still count at sale time — the goods left the shop.
-- ---------------------------------------------------------------------------
create or replace function public.pos_manager_sales_summary(
  p_manager_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_actor public.app_users; v_out jsonb;
  v_count int; v_gross numeric; v_discount numeric; v_tips numeric;
  v_cash numeric; v_card numeric; v_collected numeric; v_owed numeric; v_repaid numeric;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'view_reports');
  if v_actor.id is null then raise exception 'Not permitted to view reports'; end if;

  select count(*), coalesce(sum(subtotal),0), coalesce(sum(discount_amount),0),
         coalesce(sum(tip_amount),0),
         coalesce(sum(total) filter (where payment_method='cash'),0),
         coalesce(sum(total) filter (where payment_method='card'),0),
         coalesce(sum(total) filter (where payment_method is distinct from 'account'),0),
         coalesce(sum(total) filter (where payment_method='account'),0)
    into v_count, v_gross, v_discount, v_tips, v_cash, v_card, v_collected, v_owed
  from public.sales
  where status='completed' and created_at >= p_from and created_at < p_to;

  select coalesce(sum(amount) filter (where method in ('cash','card')),0)
    into v_repaid
  from public.account_payments where created_at >= p_from and created_at < p_to;

  v_out := jsonb_build_object(
    'sales_count', v_count, 'gross', v_gross, 'discount', v_discount, 'tips', v_tips,
    'cash', v_cash, 'card', v_card,
    'account_owed', v_owed, 'account_repaid', v_repaid,
    -- money actually collected in the period
    'net', v_collected + v_repaid
  );

  -- Top sellers count units at sale time (includes on-account sales).
  v_out := v_out || jsonb_build_object('top_items', (
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select si.name, sum(si.qty)::int as qty, sum(si.line_total) as revenue
      from public.sale_items si join public.sales s on s.id = si.sale_id
      where s.status='completed' and s.created_at >= p_from and s.created_at < p_to
      group by si.name order by sum(si.qty) desc limit 5) t));

  -- Per cashier: net is money they collected (cash + card + other), excluding
  -- unpaid account charges.
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

-- End-of-day: same cash-basis treatment.
create or replace function public.pos_end_of_day(
  p_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_actor public.app_users; v_out jsonb;
  v_count int; v_gross numeric; v_discount numeric; v_tips numeric;
  v_cash numeric; v_card numeric; v_account numeric; v_other numeric;
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
    into v_count, v_gross, v_discount, v_tips, v_cash, v_card, v_account, v_other
  from public.sales
  where status='completed' and created_at >= p_from and created_at < p_to;

  select coalesce(sum(amount) filter (where method='cash'),0),
         coalesce(sum(amount) filter (where method='card'),0)
    into v_rc, v_rk
  from public.account_payments where created_at >= p_from and created_at < p_to;

  v_out := jsonb_build_object(
    'sales_count', v_count, 'gross', v_gross, 'discount', v_discount, 'tips', v_tips,
    'cash', v_cash, 'card', v_card, 'account', v_account, 'other', v_other,
    'account_repaid_cash', v_rc, 'account_repaid_card', v_rk,
    -- money actually collected: non-account sales + account repayments
    'net', v_cash + v_card + v_other + v_rc + v_rk
  );

  v_out := v_out || jsonb_build_object('by_cashier', (
    select coalesce(jsonb_agg(c), '[]'::jsonb) from (
      select cashier_name as name, count(*)::int as sales,
             coalesce(sum(total) filter (where payment_method='cash'),0) as cash,
             coalesce(sum(total) filter (where payment_method='card'),0) as card,
             coalesce(sum(total) filter (where payment_method='account'),0) as account,
             coalesce(sum(total) filter (where payment_method is null),0) as other,
             coalesce(sum(tip_amount),0) as tips,
             coalesce(sum(discount_amount),0) as discount,
             coalesce(sum(total) filter (where payment_method is distinct from 'account'),0) as net
      from public.sales
      where status = 'completed' and created_at >= p_from and created_at < p_to
      group by cashier_name
      order by 9 desc) c));

  return v_out;
end;
$$;
