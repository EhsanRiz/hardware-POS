-- ---------------------------------------------------------------------------
-- Split payments: a sale can be settled part cash + part card.
--
-- We store the cash and card portions on the sale (paid_cash / paid_card) for
-- payment_method='split'. Every cash/card total (reports, End of Day, cash-up)
-- now reads the portion: split -> its paid_cash/paid_card, pure cash -> total to
-- cash, pure card -> total to card. Existing single-method sales are unaffected
-- (their paid_* stay null and the CASE falls back to payment_method).
-- ---------------------------------------------------------------------------

alter table public.sales add column if not exists paid_cash numeric(10,2);
alter table public.sales add column if not exists paid_card numeric(10,2);

-- Pay (v2) with split support: adds p_paid_cash / p_paid_card. Signature grows,
-- so drop the old one first.
drop function if exists public.pos_pay_order_v2(uuid,uuid,uuid,jsonb,numeric,text,numeric,text,numeric,text,uuid,timestamptz,boolean,uuid);

create function public.pos_pay_order_v2(
  p_client_uuid uuid, p_cashier_id uuid, p_order_id uuid, p_items jsonb,
  p_discount_amount numeric, p_discount_reason text, p_tip_amount numeric,
  p_payment_method text, p_amount_tendered numeric, p_approver_pin text,
  p_approved_by uuid, p_created_at timestamptz, p_offline boolean, p_account_id uuid,
  p_paid_cash numeric default null, p_paid_card numeric default null
) returns public.sales
language plpgsql security definer set search_path to 'public','extensions'
as $function$
declare
  v_cashier public.app_users; v_approver public.app_users; v_product public.products;
  v_variant public.product_variants;
  v_item jsonb; v_qty int; v_subtotal numeric(10,2) := 0;
  v_discount numeric(10,2) := coalesce(p_discount_amount,0);
  v_tip numeric(10,2) := coalesce(p_tip_amount,0);
  v_total numeric(10,2); v_change numeric(10,2);
  v_can_approve boolean; v_approved_by uuid; v_approved_name text; v_sale public.sales;
  v_created timestamptz := coalesce(p_created_at, now());
  v_limit numeric(10,2); v_balance numeric(10,2);
  v_price numeric(10,2); v_stock int;
begin
  if p_client_uuid is not null then
    select * into v_sale from public.sales where client_uuid = p_client_uuid;
    if found then return v_sale; end if;
  end if;

  select * into v_cashier from public.app_users where id = p_cashier_id and active;
  if not found then raise exception 'Invalid cashier'; end if;
  if not (v_cashier.role='admin' or 'take_payments' = any(v_cashier.permissions)) then
    raise exception 'Not permitted to take payments';
  end if;
  if p_payment_method not in ('cash','card','account','split') then raise exception 'Invalid payment method'; end if;
  if v_discount < 0 or v_tip < 0 then raise exception 'Amounts cannot be negative'; end if;

  if p_payment_method = 'account' then
    if p_account_id is null then raise exception 'No account selected'; end if;
    if not exists (select 1 from public.accounts where id = p_account_id and active) then
      raise exception 'Account not found'; end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid and active;
    if not found then raise exception 'Invalid product in cart'; end if;
    v_qty := (v_item->>'qty')::int;
    if v_qty <= 0 then raise exception 'Invalid quantity'; end if;
    if coalesce(v_item->>'variant_id', '') <> '' then
      select * into v_variant from public.product_variants
        where id = (v_item->>'variant_id')::uuid and product_id = v_product.id and active;
      if not found then raise exception 'Invalid option for %', v_product.name; end if;
      v_price := v_variant.price; v_stock := v_variant.stock_qty;
    else
      v_price := v_product.price; v_stock := v_product.stock_qty;
    end if;
    if (not p_offline) and v_stock is not null and v_stock < v_qty then
      raise exception 'Not enough stock for %', v_product.name;
    end if;
    v_subtotal := v_subtotal + v_price * v_qty;
  end loop;
  if v_subtotal <= 0 then raise exception 'Empty order'; end if;
  if v_discount > v_subtotal then raise exception 'Discount exceeds subtotal'; end if;

  if v_discount > 0 then
    if not (v_cashier.role='admin' or 'apply_discount' = any(v_cashier.permissions)) then
      raise exception 'Not permitted to apply discounts';
    end if;
    v_can_approve := v_cashier.role='admin' or 'approve_discount' = any(v_cashier.permissions);
    if v_can_approve then
      v_approved_by := v_cashier.id; v_approved_name := v_cashier.name;
    elsif p_approver_pin is not null then
      v_approver := public.pos_user_with_perm(p_approver_pin, 'approve_discount');
      if v_approver.id is null then raise exception 'Invalid approver PIN'; end if;
      v_approved_by := v_approver.id; v_approved_name := v_approver.name;
    elsif p_offline and p_approved_by is not null then
      select * into v_approver from public.app_users
        where id = p_approved_by and active
          and (role='admin' or 'approve_discount' = any(permissions));
      if not found then raise exception 'Invalid discount approver'; end if;
      v_approved_by := v_approver.id; v_approved_name := v_approver.name;
    else
      raise exception 'Discount requires manager approval';
    end if;
  end if;

  v_total := v_subtotal - v_discount + v_tip;

  -- Split payment must add up to the total (cash + card only).
  if p_payment_method = 'split' then
    if coalesce(p_paid_cash,0) < 0 or coalesce(p_paid_card,0) < 0 then
      raise exception 'Amounts cannot be negative';
    end if;
    if coalesce(p_paid_cash,0) + coalesce(p_paid_card,0) <> v_total then
      raise exception 'Split amounts must add up to the total';
    end if;
  end if;

  if p_payment_method = 'account' and not coalesce(p_offline, false) then
    select credit_limit into v_limit from public.accounts where id = p_account_id;
    if v_limit is not null then
      v_balance := public.pos_account_balance(p_account_id);
      if v_balance + v_total > v_limit then
        raise exception 'Account credit limit exceeded';
      end if;
    end if;
  end if;

  if p_payment_method = 'cash' and p_amount_tendered is not null then
    if p_amount_tendered < v_total then raise exception 'Cash tendered is less than the total'; end if;
    v_change := p_amount_tendered - v_total;
  end if;

  if p_order_id is null then
    insert into public.sales(
      cashier_id, cashier_name, subtotal, discount_amount, discount_reason,
      tip_amount, total, status, approved_by, approved_by_name,
      payment_method, amount_tendered, change_due, client_uuid, created_at, account_id,
      paid_cash, paid_card)
    values (
      v_cashier.id, v_cashier.name, v_subtotal, v_discount, p_discount_reason,
      v_tip, v_total, 'completed', v_approved_by, v_approved_name,
      p_payment_method,
      case when p_payment_method='cash' then p_amount_tendered end,
      v_change, p_client_uuid, v_created,
      case when p_payment_method='account' then p_account_id end,
      case when p_payment_method='split' then p_paid_cash end,
      case when p_payment_method='split' then p_paid_card end)
    returning * into v_sale;
  else
    update public.sales set
      cashier_id=v_cashier.id, cashier_name=v_cashier.name, subtotal=v_subtotal,
      discount_amount=v_discount, discount_reason=p_discount_reason, tip_amount=v_tip,
      total=v_total, status='completed', approved_by=v_approved_by, approved_by_name=v_approved_name,
      payment_method=p_payment_method,
      amount_tendered=case when p_payment_method='cash' then p_amount_tendered end,
      change_due=v_change, client_uuid=coalesce(client_uuid, p_client_uuid),
      account_id=case when p_payment_method='account' then p_account_id end,
      paid_cash=case when p_payment_method='split' then p_paid_cash end,
      paid_card=case when p_payment_method='split' then p_paid_card end
    where id = p_order_id and status = 'open'
    returning * into v_sale;
    if not found then raise exception 'Open order not found'; end if;
    delete from public.sale_items where sale_id = v_sale.id;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::int;
    if coalesce(v_item->>'variant_id', '') <> '' then
      select * into v_variant from public.product_variants where id = (v_item->>'variant_id')::uuid;
      insert into public.sale_items(sale_id, product_id, variant_id, name, unit_price, qty, line_total)
      values (v_sale.id, v_product.id, v_variant.id,
              public.pos_variant_label(v_product.name, v_variant.name, v_variant.size),
              v_variant.price, v_qty, v_variant.price * v_qty);
    else
      insert into public.sale_items(sale_id, product_id, variant_id, name, unit_price, qty, line_total)
      values (v_sale.id, v_product.id, null, v_product.name, v_product.price, v_qty, v_product.price * v_qty);
    end if;
  end loop;

  update public.products p set stock_qty = p.stock_qty - x.qty
  from (select (it->>'product_id')::uuid pid, sum((it->>'qty')::int) qty
        from jsonb_array_elements(p_items) it
        where coalesce(it->>'variant_id','') = '' group by 1) x
  where p.id = x.pid and p.stock_qty is not null;

  update public.product_variants v set stock_qty = v.stock_qty - x.qty
  from (select (it->>'variant_id')::uuid vid, sum((it->>'qty')::int) qty
        from jsonb_array_elements(p_items) it
        where coalesce(it->>'variant_id','') <> '' group by 1) x
  where v.id = x.vid and v.stock_qty is not null;

  return v_sale;
exception
  when unique_violation then
    select * into v_sale from public.sales where client_uuid = p_client_uuid;
    return v_sale;
end;
$function$;
revoke all on function public.pos_pay_order_v2(uuid,uuid,uuid,jsonb,numeric,text,numeric,text,numeric,text,uuid,timestamptz,boolean,uuid,numeric,numeric) from public;
grant execute on function public.pos_pay_order_v2(uuid,uuid,uuid,jsonb,numeric,text,numeric,text,numeric,text,uuid,timestamptz,boolean,uuid,numeric,numeric) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reports summary: cash/card read the split-aware portion.
-- ---------------------------------------------------------------------------
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
         coalesce(sum(case when payment_method='split' then coalesce(paid_cash,0)
                           when payment_method='cash' then total else 0 end),0),
         coalesce(sum(case when payment_method='split' then coalesce(paid_card,0)
                           when payment_method='card' then total else 0 end),0),
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

-- ---------------------------------------------------------------------------
-- End of day: cash/card read the split-aware portion.
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
         coalesce(sum(case when payment_method='split' then coalesce(paid_cash,0)
                           when payment_method='cash' then total else 0 end),0),
         coalesce(sum(case when payment_method='split' then coalesce(paid_card,0)
                           when payment_method='card' then total else 0 end),0),
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
    'cash', v_cash_sales + v_rc, 'card', v_card_sales + v_rk,
    'account', v_account, 'other', v_other,
    'account_repaid_cash', v_rc, 'account_repaid_card', v_rk,
    'net', v_cash_sales + v_rc + v_card_sales + v_rk + v_other
  );

  v_out := v_out || jsonb_build_object('by_cashier', (
    with sales_by as (
      select cashier_name as name, count(*)::int as sales,
             coalesce(sum(case when payment_method='split' then coalesce(paid_cash,0)
                               when payment_method='cash' then total else 0 end),0) as cash_sales,
             coalesce(sum(case when payment_method='split' then coalesce(paid_card,0)
                               when payment_method='card' then total else 0 end),0) as card_sales,
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
             coalesce(s.account,0) as account, coalesce(s.other,0) as other,
             coalesce(s.tips,0) as tips, coalesce(s.discount,0) as discount,
             coalesce(r.rc,0) as repaid_cash, coalesce(r.rk,0) as repaid_card
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

-- ---------------------------------------------------------------------------
-- Cash-up (live + close): cash/card read the split-aware portion.
-- ---------------------------------------------------------------------------
create or replace function public.pos_get_open_session(p_pin text)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions'
as $function$
declare
  v_actor public.app_users; v_s public.cash_sessions;
  v_cash numeric(10,2); v_card numeric(10,2); v_in numeric(10,2); v_out numeric(10,2);
  v_acc_cash numeric(10,2); v_acc_card numeric(10,2);
begin
  v_actor := public.pos_user_with_perm(p_pin, 'cash_management');
  if v_actor.id is null then raise exception 'Not permitted to manage cash'; end if;

  select * into v_s from public.cash_sessions where status='open' limit 1;
  if not found then return null; end if;

  select coalesce(sum(case when payment_method='split' then coalesce(paid_cash,0)
                           when payment_method='cash' then total else 0 end),0),
         coalesce(sum(case when payment_method='split' then coalesce(paid_card,0)
                           when payment_method='card' then total else 0 end),0)
    into v_cash, v_card
  from public.sales where status='completed' and created_at >= v_s.opened_at;

  select coalesce(sum(amount) filter (where type='pay_in'),0),
         coalesce(sum(amount) filter (where type='pay_out'),0)
    into v_in, v_out
  from public.cash_movements where session_id = v_s.id;

  select coalesce(sum(amount) filter (where method='cash'),0),
         coalesce(sum(amount) filter (where method='card'),0)
    into v_acc_cash, v_acc_card
  from public.account_payments where created_at >= v_s.opened_at;

  return jsonb_build_object(
    'id', v_s.id, 'opened_by_name', v_s.opened_by_name, 'opened_at', v_s.opened_at,
    'opening_float', v_s.opening_float,
    'cash_sales', v_cash, 'card_sales', v_card, 'pay_ins', v_in, 'pay_outs', v_out,
    'account_cash', v_acc_cash, 'account_card', v_acc_card,
    'expected_cash', v_s.opening_float + v_cash + v_acc_cash + v_in - v_out,
    'expected_card', v_card + v_acc_card,
    'movements', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'type', m.type, 'amount', m.amount, 'reason', m.reason,
        'by_name', m.by_name, 'at', m.at) order by m.at desc), '[]'::jsonb)
      from public.cash_movements m where m.session_id = v_s.id)
  );
end;
$function$;

create or replace function public.pos_close_cash_session(
  p_pin text, p_session_id uuid, p_counted_cash numeric, p_settled_card numeric, p_notes text
) returns cash_sessions
language plpgsql security definer set search_path to 'public','extensions'
as $function$
declare
  v_actor public.app_users; v_s public.cash_sessions;
  v_cash numeric(10,2); v_card numeric(10,2); v_in numeric(10,2); v_out numeric(10,2);
  v_acc_cash numeric(10,2); v_acc_card numeric(10,2);
  v_exp_cash numeric(10,2); v_exp_card numeric(10,2);
begin
  v_actor := public.pos_user_with_perm(p_pin, 'cash_management');
  if v_actor.id is null then raise exception 'Not permitted to manage cash'; end if;
  select * into v_s from public.cash_sessions where id=p_session_id and status='open';
  if not found then raise exception 'Shift is not open'; end if;

  select coalesce(sum(case when payment_method='split' then coalesce(paid_cash,0)
                           when payment_method='cash' then total else 0 end),0),
         coalesce(sum(case when payment_method='split' then coalesce(paid_card,0)
                           when payment_method='card' then total else 0 end),0)
    into v_cash, v_card
  from public.sales where status='completed'
    and created_at >= v_s.opened_at and created_at <= now();

  select coalesce(sum(amount) filter (where type='pay_in'),0),
         coalesce(sum(amount) filter (where type='pay_out'),0)
    into v_in, v_out
  from public.cash_movements where session_id = v_s.id;

  select coalesce(sum(amount) filter (where method='cash'),0),
         coalesce(sum(amount) filter (where method='card'),0)
    into v_acc_cash, v_acc_card
  from public.account_payments
  where created_at >= v_s.opened_at and created_at <= now();

  v_exp_cash := v_s.opening_float + v_cash + v_acc_cash + v_in - v_out;
  v_exp_card := v_card + v_acc_card;

  update public.cash_sessions set
    status='closed', closed_by=v_actor.id, closed_by_name=v_actor.name, closed_at=now(),
    cash_sales=v_cash, card_sales=v_card, pay_ins=v_in, pay_outs=v_out,
    expected_cash=v_exp_cash, counted_cash=p_counted_cash,
    cash_variance = case when p_counted_cash is not null then p_counted_cash - v_exp_cash end,
    expected_card=v_exp_card, settled_card=p_settled_card,
    card_variance = case when p_settled_card is not null then p_settled_card - v_exp_card end,
    notes=nullif(trim(p_notes),'')
  where id=p_session_id
  returning * into v_s;
  return v_s;
end;
$function$;
