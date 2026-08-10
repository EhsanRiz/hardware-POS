-- Customer house accounts (accounts receivable).
--
-- Model: an account is a customer ledger with a running balance.
--   * "Charge to account" is a real SALE (revenue booked now) paid by the
--     'account' method; it increases the customer's balance.
--   * A repayment is NOT a sale (no double-counted revenue); it reduces the
--     balance. Cash/card repayments still affect the drawer, so they are folded
--     into cash-up and the End-of-Day report.
-- Credit limits are advisory (a soft warning on the till), so the server stores
-- the limit but does not block charges.

create table if not exists public.accounts (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  phone           text,
  email           text,
  credit_limit    numeric(10,2),                       -- null = unlimited
  opening_balance numeric(10,2) not null default 0,    -- amount owed at creation
  active          boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now()
);

create table if not exists public.account_payments (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references public.accounts(id),
  amount           numeric(10,2) not null check (amount > 0),
  method           text not null check (method in ('cash','card')),
  received_by      uuid references public.app_users(id),
  received_by_name text,
  note             text,
  created_at       timestamptz not null default now()
);
create index if not exists account_payments_account_idx on public.account_payments(account_id);

alter table public.sales add column if not exists account_id uuid references public.accounts(id);
create index if not exists sales_account_idx on public.sales(account_id);

alter table public.accounts          enable row level security;
alter table public.account_payments  enable row level security;

-- Balance = opening + on-account charges - repayments.
create or replace function public.pos_account_balance(p_account_id uuid)
returns numeric language sql stable security definer set search_path=public,extensions as $$
  select coalesce((select opening_balance from public.accounts where id=p_account_id),0)
       + coalesce((select sum(total) from public.sales
                   where account_id=p_account_id and status='completed'
                     and payment_method='account'),0)
       - coalesce((select sum(amount) from public.account_payments
                   where account_id=p_account_id),0);
$$;
revoke all on function public.pos_account_balance(uuid) from public;

-- Admin: create/update an account.
create or replace function public.pos_manager_upsert_account(
  p_pin text, p_id uuid, p_name text, p_phone text, p_email text,
  p_credit_limit numeric, p_opening_balance numeric, p_active boolean, p_notes text
) returns public.accounts
language plpgsql security definer set search_path=public,extensions as $$
declare v_actor public.app_users; v_a public.accounts;
begin
  v_actor := public.pos_user_with_perm(p_pin, 'manage_accounts');
  if v_actor.id is null then raise exception 'Not permitted to manage accounts'; end if;
  if coalesce(trim(p_name),'')='' then raise exception 'Name is required'; end if;
  if p_id is null then
    insert into public.accounts(name,phone,email,credit_limit,opening_balance,active,notes)
    values (trim(p_name), nullif(trim(p_phone),''), nullif(trim(p_email),''),
            p_credit_limit, coalesce(p_opening_balance,0), coalesce(p_active,true),
            nullif(trim(p_notes),''))
    returning * into v_a;
  else
    update public.accounts set name=trim(p_name), phone=nullif(trim(p_phone),''),
      email=nullif(trim(p_email),''), credit_limit=p_credit_limit,
      opening_balance=coalesce(p_opening_balance,0), active=coalesce(p_active,true),
      notes=nullif(trim(p_notes),'')
    where id=p_id returning * into v_a;
    if not found then raise exception 'Account not found'; end if;
  end if;
  return v_a;
end; $$;

-- Admin: list all accounts (with balances).
create or replace function public.pos_manager_list_accounts(p_pin text)
returns table(id uuid, name text, phone text, email text, credit_limit numeric,
              opening_balance numeric, active boolean, notes text,
              balance numeric, created_at timestamptz)
language plpgsql security definer set search_path=public,extensions as $$
declare v_actor public.app_users;
begin
  v_actor := public.pos_user_with_perm(p_pin, 'manage_accounts');
  if v_actor.id is null then raise exception 'Not permitted to manage accounts'; end if;
  return query select a.id,a.name,a.phone,a.email,a.credit_limit,a.opening_balance,
    a.active,a.notes, public.pos_account_balance(a.id), a.created_at
    from public.accounts a order by a.active desc, a.name;
end; $$;

-- Till: list active accounts (with balances) for charging / repayment.
create or replace function public.pos_list_accounts(p_cashier_id uuid)
returns table(id uuid, name text, phone text, credit_limit numeric, balance numeric)
language plpgsql security definer set search_path=public,extensions as $$
begin
  if not public.pos_cashier_ok(p_cashier_id) then raise exception 'Not permitted'; end if;
  return query select a.id,a.name,a.phone,a.credit_limit, public.pos_account_balance(a.id)
    from public.accounts a where a.active order by a.name;
end; $$;

-- Till: full ledger (charges + repayments) for one account.
create or replace function public.pos_account_ledger(p_cashier_id uuid, p_account_id uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_acct public.accounts; v_out jsonb;
begin
  if not public.pos_cashier_ok(p_cashier_id) then raise exception 'Not permitted'; end if;
  select * into v_acct from public.accounts where id=p_account_id;
  if not found then raise exception 'Account not found'; end if;
  select jsonb_build_object(
    'id', v_acct.id, 'name', v_acct.name, 'phone', v_acct.phone, 'email', v_acct.email,
    'credit_limit', v_acct.credit_limit, 'opening_balance', v_acct.opening_balance,
    'balance', public.pos_account_balance(p_account_id),
    'entries', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'kind', kind, 'at', at, 'amount', amount, 'by', by_name,
        'note', note, 'method', method, 'ref', ref) order by at desc), '[]'::jsonb)
      from (
        select 'charge'::text kind, s.created_at at, s.total amount, s.cashier_name by_name,
               null::text note, null::text method, s.id ref
          from public.sales s
          where s.account_id=p_account_id and s.status='completed'
            and s.payment_method='account'
        union all
        select 'payment', p.created_at, p.amount, p.received_by_name, p.note, p.method, p.id
          from public.account_payments p where p.account_id=p_account_id
      ) u)
  ) into v_out;
  return v_out;
end; $$;

-- Till: record a repayment (any staff who can take payments).
create or replace function public.pos_record_account_payment(
  p_cashier_id uuid, p_account_id uuid, p_amount numeric, p_method text, p_note text
) returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_cashier public.app_users; v_p public.account_payments;
begin
  select * into v_cashier from public.app_users where id=p_cashier_id and active;
  if not found then raise exception 'Invalid cashier'; end if;
  if not (v_cashier.role='admin' or 'take_payments' = any(v_cashier.permissions)) then
    raise exception 'Not permitted to take payments'; end if;
  if p_method not in ('cash','card') then raise exception 'Invalid payment method'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if not exists (select 1 from public.accounts where id=p_account_id and active) then
    raise exception 'Account not found'; end if;
  insert into public.account_payments(account_id,amount,method,received_by,received_by_name,note)
  values (p_account_id,p_amount,p_method,v_cashier.id,v_cashier.name,nullif(trim(p_note),''))
  returning * into v_p;
  return jsonb_build_object('id',v_p.id,'amount',v_p.amount,'method',v_p.method,
    'balance', public.pos_account_balance(p_account_id));
end; $$;

revoke all on function public.pos_manager_upsert_account(text,uuid,text,text,text,numeric,numeric,boolean,text) from public;
revoke all on function public.pos_manager_list_accounts(text) from public;
revoke all on function public.pos_list_accounts(uuid) from public;
revoke all on function public.pos_account_ledger(uuid,uuid) from public;
revoke all on function public.pos_record_account_payment(uuid,uuid,numeric,text,text) from public;
grant execute on function public.pos_manager_upsert_account(text,uuid,text,text,text,numeric,numeric,boolean,text) to anon, authenticated;
grant execute on function public.pos_manager_list_accounts(text) to anon, authenticated;
grant execute on function public.pos_list_accounts(uuid) to anon, authenticated;
grant execute on function public.pos_account_ledger(uuid,uuid) to anon, authenticated;
grant execute on function public.pos_record_account_payment(uuid,uuid,numeric,text,text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Recreate pos_pay_order_v2 with account support (adds p_account_id, allows
-- the 'account' payment method). Signature changes, so drop the old one first.
-- ---------------------------------------------------------------------------
drop function if exists public.pos_pay_order_v2(uuid,uuid,uuid,jsonb,numeric,text,numeric,text,numeric,text,uuid,timestamptz,boolean);

create function public.pos_pay_order_v2(
  p_client_uuid uuid, p_cashier_id uuid, p_order_id uuid, p_items jsonb,
  p_discount_amount numeric, p_discount_reason text,
  p_tip_amount numeric, p_payment_method text,
  p_amount_tendered numeric, p_approver_pin text,
  p_approved_by uuid, p_created_at timestamptz, p_offline boolean,
  p_account_id uuid
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cashier public.app_users; v_approver public.app_users; v_product public.products;
  v_item jsonb; v_qty int; v_subtotal numeric(10,2) := 0;
  v_discount numeric(10,2) := coalesce(p_discount_amount,0);
  v_tip numeric(10,2) := coalesce(p_tip_amount,0);
  v_total numeric(10,2); v_change numeric(10,2);
  v_can_approve boolean; v_approved_by uuid; v_approved_name text; v_sale public.sales;
  v_created timestamptz := coalesce(p_created_at, now());
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
  if p_payment_method not in ('cash','card','account') then raise exception 'Invalid payment method'; end if;
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
    if (not p_offline) and v_product.stock_qty is not null and v_product.stock_qty < v_qty then
      raise exception 'Not enough stock for %', v_product.name;
    end if;
    v_subtotal := v_subtotal + v_product.price * v_qty;
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

  if p_payment_method = 'cash' and p_amount_tendered is not null then
    if p_amount_tendered < v_total then raise exception 'Cash tendered is less than the total'; end if;
    v_change := p_amount_tendered - v_total;
  end if;

  if p_order_id is null then
    insert into public.sales(
      cashier_id, cashier_name, subtotal, discount_amount, discount_reason,
      tip_amount, total, status, approved_by, approved_by_name,
      payment_method, amount_tendered, change_due, client_uuid, created_at, account_id)
    values (
      v_cashier.id, v_cashier.name, v_subtotal, v_discount, p_discount_reason,
      v_tip, v_total, 'completed', v_approved_by, v_approved_name,
      p_payment_method,
      case when p_payment_method='cash' then p_amount_tendered end,
      v_change, p_client_uuid, v_created,
      case when p_payment_method='account' then p_account_id end)
    returning * into v_sale;
  else
    update public.sales set
      cashier_id=v_cashier.id, cashier_name=v_cashier.name, subtotal=v_subtotal,
      discount_amount=v_discount, discount_reason=p_discount_reason, tip_amount=v_tip,
      total=v_total, status='completed', approved_by=v_approved_by, approved_by_name=v_approved_name,
      payment_method=p_payment_method,
      amount_tendered=case when p_payment_method='cash' then p_amount_tendered end,
      change_due=v_change, client_uuid=coalesce(client_uuid, p_client_uuid),
      account_id=case when p_payment_method='account' then p_account_id end
    where id = p_order_id and status = 'open'
    returning * into v_sale;
    if not found then raise exception 'Open order not found'; end if;
    delete from public.sale_items where sale_id = v_sale.id;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::int;
    insert into public.sale_items(sale_id, product_id, name, unit_price, qty, line_total)
    values (v_sale.id, v_product.id, v_product.name, v_product.price, v_qty, v_product.price * v_qty);
  end loop;

  update public.products p set stock_qty = p.stock_qty - x.qty
  from (select (it->>'product_id')::uuid pid, (it->>'qty')::int qty
        from jsonb_array_elements(p_items) it) x
  where p.id = x.pid and p.stock_qty is not null;

  return v_sale;
exception
  when unique_violation then
    select * into v_sale from public.sales where client_uuid = p_client_uuid;
    return v_sale;
end;
$$;

revoke all on function public.pos_pay_order_v2(uuid,uuid,uuid,jsonb,numeric,text,numeric,text,numeric,text,uuid,timestamptz,boolean,uuid) from public;
grant execute on function public.pos_pay_order_v2(uuid,uuid,uuid,jsonb,numeric,text,numeric,text,numeric,text,uuid,timestamptz,boolean,uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fold cash/card account repayments into the live cash session.
-- ---------------------------------------------------------------------------
create or replace function public.pos_get_open_session(p_pin text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_actor public.app_users; v_s public.cash_sessions;
  v_cash numeric(10,2); v_card numeric(10,2); v_in numeric(10,2); v_out numeric(10,2);
  v_acc_cash numeric(10,2); v_acc_card numeric(10,2);
begin
  v_actor := public.pos_user_with_perm(p_pin, 'cash_management');
  if v_actor.id is null then raise exception 'Not permitted to manage cash'; end if;

  select * into v_s from public.cash_sessions where status='open' limit 1;
  if not found then return null; end if;

  select coalesce(sum(total) filter (where payment_method='cash'),0),
         coalesce(sum(total) filter (where payment_method='card'),0)
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
$$;

create or replace function public.pos_close_cash_session(
  p_pin text, p_session_id uuid, p_counted_cash numeric,
  p_settled_card numeric, p_notes text
) returns public.cash_sessions
language plpgsql security definer set search_path = public, extensions as $$
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

  select coalesce(sum(total) filter (where payment_method='cash'),0),
         coalesce(sum(total) filter (where payment_method='card'),0)
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
$$;

-- ---------------------------------------------------------------------------
-- End-of-day: add on-account credit sales and account repayments.
-- ---------------------------------------------------------------------------
create or replace function public.pos_end_of_day(
  p_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_out jsonb;
begin
  v_actor := public.pos_active_user(p_pin);
  if v_actor.id is null then raise exception 'Not signed in'; end if;

  select jsonb_build_object(
    'sales_count', count(*),
    'gross', coalesce(sum(subtotal),0),
    'discount', coalesce(sum(discount_amount),0),
    'tips', coalesce(sum(tip_amount),0),
    'net', coalesce(sum(total),0),
    'cash', coalesce(sum(total) filter (where payment_method = 'cash'),0),
    'card', coalesce(sum(total) filter (where payment_method = 'card'),0),
    'account', coalesce(sum(total) filter (where payment_method = 'account'),0),
    'other', coalesce(sum(total) filter (where payment_method is null),0)
  ) into v_out from public.sales
  where status = 'completed' and created_at >= p_from and created_at < p_to;

  v_out := v_out || (
    select jsonb_build_object(
      'account_repaid_cash', coalesce(sum(amount) filter (where method='cash'),0),
      'account_repaid_card', coalesce(sum(amount) filter (where method='card'),0))
    from public.account_payments where created_at >= p_from and created_at < p_to);

  v_out := v_out || jsonb_build_object('by_cashier', (
    select coalesce(jsonb_agg(c), '[]'::jsonb) from (
      select cashier_name as name,
             count(*)::int as sales,
             coalesce(sum(total),0) as net,
             coalesce(sum(total) filter (where payment_method = 'cash'),0) as cash,
             coalesce(sum(total) filter (where payment_method = 'card'),0) as card,
             coalesce(sum(total) filter (where payment_method = 'account'),0) as account,
             coalesce(sum(total) filter (where payment_method is null),0) as other,
             coalesce(sum(tip_amount),0) as tips,
             coalesce(sum(discount_amount),0) as discount
      from public.sales
      where status = 'completed' and created_at >= p_from and created_at < p_to
      group by cashier_name
      order by sum(total) desc) c));

  return v_out;
end;
$$;
