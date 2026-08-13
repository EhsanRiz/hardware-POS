-- End to end against the real database.
--
-- Everything else in this repo tests the till against a hand-written fake of
-- the server (e2e/fake-backend.ts). That fake is a second implementation of the
-- same rules, and a second implementation agrees with the first right up until
-- it doesn't: the payment_method enum had been missing 'eft', 'zapper' and
-- 'mixed' since 0004, so every EFT and split-tender sale failed in the database
-- while the whole browser suite stayed green. Nothing here can catch that,
-- because nothing here runs the migrations.
--
-- This does. It applies every migration to a real Postgres and then calls the
-- RPCs the way the client calls them, so the SQL is exercised as written rather
-- than as re-typed in TypeScript.
--
-- Run it with supabase/test/run.sh. Assertions raise, and psql is run with
-- ON_ERROR_STOP, so the first failure stops the file and fails the build.

\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages to warning;

create or replace function assert(cond boolean, what text) returns void
language plpgsql as $$
begin
  if cond is not true then raise exception 'FAILED: %', what; end if;
end $$;

create or replace function assert_eq(got anyelement, want anyelement, what text)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAILED: % — got %, wanted %', what, got, want;
  end if;
end $$;

-- Something that should be refused actually is. Passing when the statement
-- succeeds would make every guard in here vacuous.
create or replace function assert_refuses(sql text, what text) returns void
language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    return;
  end;
  raise exception 'FAILED: % — it was allowed', what;
end $$;

-- The fixture: a paired till, a manager and a cashier who can both sign in.
do $$
declare v_org uuid; v_mgr uuid; v_emp uuid;
begin
  select id into v_org from public.organizations limit 1;
  select id into v_mgr from public.app_users where role = 'admin' limit 1;
  select id into v_emp from public.app_users where role = 'employee' limit 1;

  update public.app_users set phone_e164 = '+27820000001', status = 'active'
   where id = v_mgr;
  update public.app_users set phone_e164 = '+27820000002', status = 'active'
   where id = v_emp;

  create temp table fixture as
    select v_org as org_id, v_mgr as manager_id, v_emp as employee_id;
end $$;

create temp table till as
  select token from public.pos_pair_register('+27820000001', '1234', 'Test till');


-- 0030: the tenders the till actually offers ---------------------------------
--
-- The bug this file was written for. Each of these casts a method straight into
-- payment_method inside pos_create_sale, and all three used to raise
-- "invalid input value for enum payment_method".

do $$
declare v_tok text; v_emp uuid; v_prod uuid; v_price numeric; v_sale public.sales;
begin
  select token into v_tok from till;
  select employee_id into v_emp from fixture;
  select id, price_retail into v_prod, v_price
    from public.products where active and price_retail > 0 limit 1;

  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 1)),
    p_payment_method => 'eft',
    p_payments => jsonb_build_array(
      jsonb_build_object('method', 'eft', 'amount', v_price))
  );
  perform assert_eq(v_sale.payment_method::text, 'eft', 'an EFT sale stores as EFT');

  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 1)),
    p_payment_method => 'zapper',
    p_payments => jsonb_build_array(
      jsonb_build_object('method', 'zapper', 'amount', v_price))
  );
  perform assert_eq(v_sale.payment_method::text, 'zapper', 'a Zapper sale stores as Zapper');

  -- The builder's ordinary transaction: part card, the rest in cash. 0019
  -- summarises this as 'mixed', which the enum had never heard of.
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 2)),
    p_payment_method => 'mixed',
    p_payments => jsonb_build_array(
      jsonb_build_object('method', 'card', 'amount', v_price),
      jsonb_build_object('method', 'cash', 'amount', v_price))
  );
  perform assert_eq(v_sale.payment_method::text, 'mixed', 'a split tender stores as mixed');
  perform assert_eq(
    (select count(*)::int from public.sale_payments where sale_id = v_sale.id), 2,
    'both halves of a split tender are recorded');

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
end $$;


-- 0028: editing staff, and the guards that keep a shop out of a corner -------

do $$
declare v_tok text; v_mgr uuid; v_emp uuid; v_row record;
begin
  select token into v_tok from till;
  select manager_id, employee_id into v_mgr, v_emp from fixture;

  select * into v_row from public.pos_admin_update_user(v_tok, '1234', v_emp,
    p_name => 'Samuel', p_permissions => array['cash_management']);
  perform assert_eq(v_row.name, 'Samuel', 'a cashier can be renamed');
  perform assert_eq(v_row.permissions, array['cash_management'],
    'an explicit grant is stored');

  -- The manager holding the PIN is the one person who cannot afford to be shut
  -- out mid-shift, so neither of these is allowed however it is asked.
  perform assert_refuses(
    format('select public.pos_admin_update_user(%L, %L, %L, p_active => false)',
           v_tok, '1234', v_mgr),
    'signing yourself out');
  perform assert_refuses(
    format('select public.pos_admin_update_user(%L, %L, %L, p_role => %L::user_role)',
           v_tok, '1234', v_mgr, 'employee'),
    'demoting yourself');
  perform assert_refuses(
    format('select public.pos_admin_delete_user(%L, %L, %L)', v_tok, '1234', v_mgr),
    'removing yourself');

  -- Promote the cashier, then the last-admin guard has something to protect.
  perform public.pos_admin_update_user(v_tok, '1234', v_emp,
    p_role => 'admin'::user_role);
  perform assert_eq(
    (select role::text from public.app_users where id = v_emp), 'admin',
    'an admin can promote somebody to admin');

  -- Now there are two admins, so demoting the other one is allowed again.
  perform public.pos_admin_update_user(v_tok, '1234', v_emp,
    p_role => 'employee'::user_role);

  -- The seeded cashier has stock movements against them, so they are spared
  -- for the same reason a seller is: deleting them would orphan somebody's
  -- work. Sales are the case worth naming; they are not the only one.
  perform assert_eq(public.pos_admin_delete_user(v_tok, '1234', v_emp), 'disabled',
    'anything still pointing at a person disables them rather than deleting');
end $$;

-- Somebody who really has left no trace is actually removed, or the roster
-- fills up with people who were invited to the wrong number.
do $$
declare v_tok text; v_new uuid;
begin
  select token into v_tok from till;
  select id into v_new from public.pos_admin_invite_user(
    v_tok, '1234', 'Wrong number', '+27820000009', 'employee'::user_role, array[]::text[]);
  perform assert_eq(public.pos_admin_delete_user(v_tok, '1234', v_new), 'deleted',
    'somebody who never traded is actually removed');
  perform assert_eq(
    (select count(*)::int from public.app_users where id = v_new), 0,
    'and they are gone from the roster');
end $$;

-- Put the cashier back, with a sale against them this time.
do $$
declare v_tok text; v_emp uuid; v_prod uuid;
begin
  select token into v_tok from till;
  select id, price_retail into v_prod from public.products
   where active and price_retail > 0 limit 1;

  select id into v_emp from public.pos_admin_invite_user(
    v_tok, '1234', 'Sam', '+27820000003', 'employee'::user_role, array[]::text[]);
  update public.app_users set status = 'active',
         pin_hash = crypt('5678', gen_salt('bf')) where id = v_emp;

  perform public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 1)),
    p_payment_method => 'cash');

  perform assert_eq(public.pos_admin_delete_user(v_tok, '1234', v_emp), 'disabled',
    'a cashier with sales behind them is disabled, not deleted');
  perform assert_eq(
    (select active from public.app_users where id = v_emp), false,
    'and they can no longer sign in');

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
end $$;


-- 0029: the drawer -----------------------------------------------------------

do $$
declare
  v_tok text; v_mgr uuid; v_prod uuid; v_price numeric;
  v_session public.cash_sessions; v_closed jsonb; v_fig jsonb;
  v_cust uuid; v_expected numeric;
begin
  select token into v_tok from till;
  select manager_id into v_mgr from fixture;
  select id, price_retail into v_prod, v_price
    from public.products where active and price_retail > 0 limit 1;

  v_session := public.pos_cash_session_open(v_tok, '1234', 500);
  perform assert_eq(v_session.opening_float, 500::numeric, 'the float is recorded');

  -- One till, one drawer. Two open sessions would put two days' takings in the
  -- same window with no way to tell them apart.
  perform assert_refuses(
    format('select public.pos_cash_session_open(%L, %L, 100)', v_tok, '1234'),
    'opening a second session on the same till');

  -- A cash sale, a card sale, and an account settlement paid in cash.
  perform public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 1)),
    p_payment_method => 'cash',
    p_payments => jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', v_price)));
  perform public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 1)),
    p_payment_method => 'card',
    p_payments => jsonb_build_array(jsonb_build_object('method', 'card', 'amount', v_price)));

  select id into v_cust from public.customers limit 1;
  if v_cust is not null then
    perform public.pos_take_account_payment(v_tok, v_mgr, v_cust, 200, 'cash', null, null, null);
  end if;

  -- Diesel out of the drawer. A payout that did not count would read as a
  -- shortfall against a cashier who is not short.
  perform public.pos_cash_movement(v_tok, '1234', 'pay_out', 60, 'Diesel for the bakkie');
  perform public.pos_cash_movement(v_tok, '1234', 'pay_in', 40, 'Float top-up');
  perform assert_refuses(
    format('select public.pos_cash_movement(%L, %L, %L, 50, %L)', v_tok, '1234', 'pay_out', ''),
    'a movement with no reason');

  v_fig := public.pos_cash_session_current(v_tok, '1234') -> 'figures';

  -- Card takings are in the tender breakdown but not in the drawer.
  perform assert_eq((v_fig->>'cash_sales')::numeric, v_price,
    'cash sales are drawer money');
  perform assert_eq((v_fig->'tenders'->>'card')::numeric, v_price,
    'card takings show in the breakdown');
  perform assert_eq((v_fig->>'pay_out')::numeric, 60::numeric, 'the payout counts');
  perform assert_eq((v_fig->>'pay_in')::numeric, 40::numeric, 'the pay-in counts');
  if v_cust is not null then
    perform assert_eq((v_fig->>'account_cash')::numeric, 200::numeric,
      'an account settlement paid in cash is drawer money too');
  end if;

  v_expected := 500 + v_price + coalesce(case when v_cust is null then 0 else 200 end, 0) + 40 - 60;
  perform assert_eq((v_fig->>'expected_cash')::numeric, v_expected,
    'expected cash is float plus cash in, less cash out');

  -- Count it R5 light.
  v_closed := public.pos_cash_session_close(v_tok, '1234', v_expected - 5, 'Short a fiver');
  perform assert_eq((v_closed->>'variance')::numeric, -5::numeric,
    'the variance is counted less expected');
  perform assert_eq((v_closed->>'expected_cash')::numeric, v_expected,
    'and the expected figure is snapshotted, not recomputed later');

  -- The session's sales are stamped on the way out, so the window it was
  -- measured over stays reconstructable.
  perform assert(
    (select count(*) from public.sales where session_id = (v_closed->>'id')::uuid) = 2,
    'closing stamps the sales it counted');

  perform assert_refuses(
    format('select public.pos_cash_movement(%L, %L, %L, 10, %L)',
           v_tok, '1234', 'pay_out', 'after close'),
    'a movement against a closed session');

  -- And the till is free to open tomorrow.
  perform public.pos_cash_session_open(v_tok, '1234', 300);
end $$;

-- Reprinting a past day carries what explains it.
--
-- The figures alone are not the cash-up. A reprint that keeps the shortfall and
-- drops the R60 taken out for diesel hands somebody a piece of paper accusing a
-- cashier of being R60 down with the answer removed.
do $$
declare v_tok text; v_past jsonb; v_day jsonb;
begin
  select token into v_tok from till;
  v_past := public.pos_cash_sessions(v_tok, '1234', 30);
  perform assert(jsonb_array_length(v_past) >= 1, 'a closed day is listed for reprinting');

  v_day := v_past -> 0;
  perform assert(v_day ? 'figures', 'a reprint carries its figures');
  perform assert(v_day ? 'movements', 'a reprint carries its movements');
  perform assert_eq(jsonb_array_length(v_day -> 'movements'), 2,
    'both the payout and the pay-in survive to the reprint');
  perform assert(
    (v_day -> 'movements') @> '[{"reason": "Diesel for the bakkie"}]'::jsonb,
    'and the reprint still says where the money went');
  perform assert_eq((v_day ->> 'variance')::numeric, -5::numeric,
    'the stored variance is what reprints, not a recomputed one');
end $$;


-- Permissions are enforced in the database, not only hidden in the UI --------

do $$
declare v_tok text; v_emp uuid;
begin
  select token into v_tok from till;
  -- A cashier with none of the management permissions. The screens would not
  -- offer any of this; what matters is that the RPCs refuse it anyway.
  select id into v_emp from public.pos_admin_invite_user(
    v_tok, '1234', 'Counter only', '+27820000004', 'employee'::user_role, array[]::text[]);
  update public.app_users set status = 'active',
         pin_hash = crypt('4321', gen_salt('bf')) where id = v_emp;

  perform assert_refuses(
    format('select public.pos_cash_session_current(%L, %L)', v_tok, '4321'),
    'a cashier reading the cash-up');
  perform assert_refuses(
    format('select public.pos_admin_list_users(%L, %L)', v_tok, '4321'),
    'a cashier listing staff');
  perform assert_refuses(
    format('select public.pos_admin_save_settings(%L, %L, %L::jsonb)',
           v_tok, '4321', '{"shop_name":"Mine now"}'),
    'a cashier editing the shop');
end $$;

select 'all database tests passed' as result;
