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

-- 0033: a PIN confirms who you are; it no longer decides it ------------------
--
-- The hole this closes: nothing requires a PIN to be unique, so two people
-- choosing the same six digits used to mean the second signed in AS the first.

do $$
declare v_tok text; v_mgr uuid; v_twin uuid; v_row record; v_n int;
begin
  select token into v_tok from till;
  select manager_id into v_mgr from fixture;

  -- Somebody who deliberately picks the manager's PIN. Not an attack — just
  -- two people who both like the same six digits.
  select id into v_twin from public.pos_admin_invite_user(
    v_tok, '1234', 'PIN twin', '+27820000007', 'employee'::user_role, array[]::text[]);
  update public.app_users set status = 'active',
         pin_hash = crypt('1234', gen_salt('bf')) where id = v_twin;

  -- Each signs in as themselves, on the same PIN, and gets their own identity.
  select * into v_row from public.pos_login(v_tok, v_mgr, '1234');
  perform assert_eq(v_row.id, v_mgr, 'the manager signs in as the manager');
  select * into v_row from public.pos_login(v_tok, v_twin, '1234');
  perform assert_eq(v_row.id, v_twin, 'and the twin signs in as the twin, on the same PIN');

  -- The old PIN-only form now refuses rather than guessing. Returning either
  -- one would be worse than returning none: a day's sales under a name that
  -- did not ring them up is a lie nobody goes looking for.
  select count(*) into v_n from public.pos_login(v_tok, '1234');
  perform assert_eq(v_n, 0, 'a PIN shared by two people signs nobody in');

  -- And every privileged RPC says so out loud rather than picking one.
  perform assert_refuses(
    format('select public.pos_admin_list_users(%L, %L)', v_tok, '1234'),
    'a shared PIN reaching the back office');

  -- Cleaned up, or it poisons the checks below.
  delete from public.login_attempts;
  delete from public.app_users where id = v_twin;

  -- With the PIN unique again, the old form works exactly as before.
  select count(*) into v_n from public.pos_login(v_tok, '1234');
  perform assert_eq(v_n, 1, 'a unique PIN still signs its owner in');
end $$;

-- Naming people means an attacker can choose a target, so guessing is capped.
do $$
declare v_tok text; v_mgr uuid; v_n int; v_locked boolean := false;
begin
  select token into v_tok from till;
  select manager_id into v_mgr from fixture;
  delete from public.login_attempts;

  for i in 1..5 loop
    select count(*) into v_n from public.pos_login(v_tok, v_mgr, '000000');
    perform assert_eq(v_n, 0, 'a wrong PIN signs nobody in');
  end loop;

  -- The sixth is refused outright, and says so rather than reading as another
  -- wrong PIN — otherwise the cashier tries the same digits for a quarter hour.
  begin
    perform public.pos_login(v_tok, v_mgr, '000000');
  exception when others then
    v_locked := true;
  end;
  perform assert(v_locked, 'five wrong PINs lock the account');

  -- Even the right PIN is refused while locked, or the cap means nothing.
  begin
    perform public.pos_login(v_tok, v_mgr, '1234');
  exception when others then
    null;
  end;

  -- A success clears the slate, so an honest mis-type does not accumulate.
  delete from public.login_attempts;
  select count(*) into v_n from public.pos_login(v_tok, v_mgr, '1234');
  perform assert_eq(v_n, 1, 'the right PIN works once the window has passed');
  perform assert_eq(
    (select count(*)::int from public.login_attempts where user_id = v_mgr), 0,
    'and signing in clears the failures behind it');
end $$;

-- The sign-in roster carries names, and nothing else worth having.
do $$
declare v_tok text; v_row record; v_invited uuid;
begin
  select token into v_tok from till;

  select id into v_invited from public.pos_admin_invite_user(
    v_tok, '1234', 'Not enrolled yet', '+27820000008', 'employee'::user_role, array[]::text[]);

  -- Somebody who has never set a PIN is left off: offering a name that cannot
  -- sign in only has the cashier standing there trying.
  perform assert(
    not exists (select 1 from public.pos_staff_for_login(v_tok) s where s.id = v_invited),
    'an invited person with no PIN is not offered on the sign-in screen');

  select * into v_row from public.pos_staff_for_login(v_tok) limit 1;
  perform assert(v_row.name is not null, 'the roster carries a name');

  delete from public.app_users where id = v_invited;
end $$;

-- 0034: looking back at what was sold ----------------------------------------

do $$
declare v_tok text; v_emp uuid; v_prod uuid; v_price numeric;
        v_today jsonb; v_old jsonb;
begin
  select token into v_tok from till;
  -- The manager, not the seeded cashier: the staff checks above disable that
  -- one, and a disabled cashier cannot ring anything up.
  select manager_id into v_emp from fixture;
  select id, price_retail into v_prod, v_price
    from public.products where active and price_retail > 0 limit 1;

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;

  -- One today, one a fortnight ago. The old one is what proves the window has
  -- ends rather than simply returning everything.
  perform public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 1)),
    p_payment_method => 'cash',
    p_payments => jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', v_price)));
  perform public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 1)),
    p_payment_method => 'card', p_created_at => now() - interval '14 days',
    p_payments => jsonb_build_array(jsonb_build_object('method', 'card', 'amount', v_price)));

  v_today := public.pos_sales_history(v_tok, '1234',
    date_trunc('day', now()), date_trunc('day', now()) + interval '1 day');
  perform assert_eq(jsonb_array_length(v_today -> 'rows'), 1,
    'today shows today, and not a fortnight ago');
  perform assert_eq((v_today -> 'totals' ->> 'gross')::numeric, v_price,
    'and the takings are the day''s, not the whole ledger''s');
  perform assert_eq((v_today -> 'totals' -> 'tenders' ->> 'cash')::numeric, v_price,
    'broken down by how it was paid');

  -- A wider window reaches the older one.
  v_old := public.pos_sales_history(v_tok, '1234',
    now() - interval '30 days', now() + interval '1 day');
  perform assert_eq(jsonb_array_length(v_old -> 'rows'), 2, 'a month reaches both');
  perform assert_eq((v_old -> 'totals' ->> 'gross')::numeric, v_price * 2,
    'and totals both');

  -- Everything a reprint needs comes back, or the slip prints blanks where the
  -- figures should be. subtotal was missing on the first cut of this.
  perform assert(v_old -> 'rows' -> 0 ? 'subtotal', 'a row carries its subtotal');
  perform assert(v_old -> 'rows' -> 0 ? 'paid_cash', 'and the cash/card split');
  perform assert(v_old -> 'rows' -> 0 ? 'trade_pricing', 'and which price list it was on');

  -- The wrong way round is a mistake worth naming rather than an empty list.
  perform assert_refuses(
    format('select public.pos_sales_history(%L, %L, now(), now() - interval ''1 day'')',
           v_tok, '1234'),
    'a range that ends before it starts');

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
end $$;

-- The shop's takings are not for everybody who can work a till.
do $$
declare v_tok text; v_emp uuid;
begin
  select token into v_tok from till;
  select id into v_emp from public.pos_admin_invite_user(
    v_tok, '1234', 'Counter only 2', '+27820000011', 'employee'::user_role, array[]::text[]);
  update public.app_users set status = 'active',
         pin_hash = crypt('9911', gen_salt('bf')) where id = v_emp;

  perform assert_refuses(
    format('select public.pos_sales_history(%L, %L, now() - interval ''1 day'', now())',
           v_tok, '9911'),
    'a cashier reading the shop takings');

  delete from public.app_users where id = v_emp;
end $$;

-- 0035: money off one line ----------------------------------------------------

do $$
declare v_tok text; v_mgr uuid; v_a uuid; v_b uuid; v_pa numeric; v_pb numeric;
        v_sale public.sales; v_row record;
begin
  select token into v_tok from till;
  select manager_id into v_mgr from fixture;
  select id, price_retail into v_a, v_pa from public.products
   where active and price_retail > 0 order by price_retail limit 1;
  select id, price_retail into v_b, v_pb from public.products
   where active and price_retail > 0 and id <> v_a order by price_retail desc limit 1;

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;

  -- Ten percent off the dearer line only.
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(
      jsonb_build_object('product_id', v_a, 'qty', 1),
      jsonb_build_object('product_id', v_b, 'qty', 1, 'discount_percent', 10)),
    p_payment_method => 'cash');

  perform assert_eq(v_sale.subtotal, round(v_pa + v_pb, 2),
    'the subtotal is what the goods cost before anything comes off');
  perform assert_eq(v_sale.discount_amount, round(v_pb * 0.10, 2),
    'the line discount is the sale discount');
  perform assert_eq(v_sale.total, round(v_pa + v_pb - v_pb * 0.10, 2),
    'and the total is the difference');
  -- The invoice has to add up, whichever kind of discount was given.
  perform assert_eq(v_sale.subtotal - v_sale.discount_amount, v_sale.total,
    'subtotal less discount equals total');

  -- The discount sits on the line that got it, and the other line is untouched.
  select * into v_row from public.sale_items where sale_id = v_sale.id and product_id = v_b;
  perform assert_eq(v_row.discount_amount, round(v_pb * 0.10, 2),
    'the discounted line carries its own discount');
  perform assert_eq(v_row.discount_percent, 10::numeric,
    'and remembers it was asked for as a percentage');
  select * into v_row from public.sale_items where sale_id = v_sale.id and product_id = v_a;
  perform assert_eq(v_row.discount_amount, 0::numeric,
    'the line nobody discounted carries nothing');
  perform assert_eq(v_row.line_total, round(v_pa, 2),
    'and still shows full price — the old way spread it across every line');

  -- The percentage is worked out here, not taken on trust: a client sending a
  -- percentage and a mismatched amount must not be able to choose which wins.
  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(jsonb_build_object(
      'product_id', v_b, 'qty', 1, 'discount_percent', 50, 'discount_amount', 1)),
    p_payment_method => 'cash');
  perform assert_eq(v_sale.discount_amount, round(v_pb * 0.50, 2),
    'the percentage decides, not the amount sent beside it');

  -- More off than the line comes to is refused by name, so the cashier knows
  -- which line to fix.
  perform assert_refuses(
    format('select public.pos_create_sale(%L, %L, %L::jsonb)', v_tok, v_mgr,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_b, 'qty', 1, 'discount_amount', v_pb + 1))::text),
    'a line discount bigger than the line');
  perform assert_refuses(
    format('select public.pos_create_sale(%L, %L, %L::jsonb)', v_tok, v_mgr,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_b, 'qty', 1, 'discount_percent', 120))::text),
    'a line discount over 100%');

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
end $$;

-- A line discount is money off, so it needs the same approval a sale discount
-- does. Otherwise the whole approval gate is one tap away from being pointless.
do $$
declare v_tok text; v_emp uuid; v_prod uuid; v_sale public.sales;
begin
  select token into v_tok from till;
  select id, price_retail into v_prod from public.products
   where active and price_retail > 0 limit 1;

  select id into v_emp from public.pos_admin_invite_user(
    v_tok, '1234', 'No approvals', '+27820000012', 'employee'::user_role, array[]::text[]);
  update public.app_users set status = 'active',
         pin_hash = crypt('7788', gen_salt('bf')) where id = v_emp;

  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'qty', 1, 'discount_percent', 10)));
  perform assert_eq(v_sale.status::text, 'pending_approval',
    'a counter hand''s line discount waits for a manager');
  perform assert(v_sale.doc_number is null,
    'and burns no invoice number while it waits');

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
  delete from public.app_users where id = v_emp;
end $$;

-- 0036: a PIN cannot be taken twice ------------------------------------------
--
-- 0033 made a shared PIN refuse rather than sign the second person in as the
-- first. This stops the pair existing at all, at the one place a PIN is set.

do $$
declare v_tok text; v_mgr uuid; v_new uuid; v_taken boolean := false;
begin
  select token into v_tok from till;
  select manager_id into v_mgr from fixture;

  -- Give the manager a known PIN, then have somebody else try to take it.
  update public.app_users set pin_hash = crypt('246810', gen_salt('bf'))
   where id = v_mgr;

  select id into v_new from public.pos_admin_invite_user(
    v_tok, '246810', 'PIN thief', '+27820000013', 'employee'::user_role, array[]::text[]);
  update public.app_users set phone_e164 = '+27820000013' where id = v_new;

  begin
    perform public.auth_set_pin('+27820000013', '246810');
  exception when others then
    v_taken := true;
  end;
  perform assert(v_taken, 'a PIN already in use here is refused at enrolment');
  perform assert_eq(
    (select count(*)::int from public.app_users u
      where u.org_id = (select org_id from fixture) and u.active
        and u.pin_hash is not null and u.pin_hash = crypt('246810', u.pin_hash)),
    1, 'so only one person ever answers to it');

  -- A different PIN goes through, and the person can sign in on it.
  perform public.auth_set_pin('+27820000013', '135791');
  perform assert_eq(
    (select count(*)::int from public.pos_login(v_tok, v_new, '135791')), 1,
    'and a PIN nobody else holds works straight away');

  -- The manager's own PIN still resolves, unshared.
  perform assert_eq(
    (select count(*)::int from public.pos_login(v_tok, v_mgr, '246810')), 1,
    'the first holder keeps theirs');

  -- Resetting to your OWN current PIN is not a collision with yourself.
  perform public.auth_set_pin('+27820000013', '135791');

  delete from public.login_attempts;
  delete from public.app_users where id = v_new;
  update public.app_users set pin_hash = crypt('1234', gen_salt('bf')) where id = v_mgr;
end $$;

-- 0037: two ceilings ---------------------------------------------------------
--
-- The staff limit is soft: it decides whether a manager is fetched. The item
-- cap is hard: it refuses, and it refuses the owner too. Both are checked here
-- against the same sale, because the interesting bugs live where they meet.

do $$
declare v_tok text; v_mgr uuid; v_emp uuid; v_a uuid; v_b uuid;
        v_pa numeric; v_pb numeric; v_sale public.sales; v_row record;
begin
  select token into v_tok from till;
  select manager_id into v_mgr from fixture;
  select employee_id into v_emp from fixture;
  select id, price_retail into v_a, v_pa from public.products
   where active and price_retail > 0 order by price_retail limit 1;
  select id, price_retail into v_b, v_pb from public.products
   where active and price_retail > 0 and id <> v_a order by price_retail desc limit 1;

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;

  -- The counter has apply_discount by role but no approve_discount and, to
  -- begin with, no limit. This is the shop as it behaved before 0037.
  --
  -- Put back on the roster first: the 0028 block above disables this same
  -- person to prove that deleting somebody with sales behind them disables
  -- them instead, and pos_create_sale will not take a sale from a disabled
  -- cashier.
  update public.app_users
     set active = true, status = 'active',
         discount_limit_percent = null, discount_limit_amount = null
   where id = v_emp;
  update public.products
     set max_discount_percent = null, max_discount_amount = null
   where id in (v_a, v_b);

  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => 1, p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'pending_approval'::sale_status,
    'with no limit set, any discount still waits for a manager');

  -- ---- the staff limit, in percent -----------------------------------------
  update public.app_users set discount_limit_percent = 10 where id = v_emp;

  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => round(v_pb * 0.10, 2), p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'completed'::sale_status,
    'a discount inside the limit goes through on the cashier''s own authority');
  perform assert(v_sale.approved_by is null,
    'and records no approver, because nobody was asked');
  perform assert(v_sale.doc_number is not null,
    'so it takes an invoice number like any other sale');

  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => round(v_pb * 0.20, 2), p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'pending_approval'::sale_status,
    'a cent past it and the sale parks, exactly as it used to');

  -- A line discount counts against the same limit. Ten percent off the ladder
  -- is the same money as ten percent off a sale containing only the ladder.
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object(
      'product_id', v_b, 'qty', 1, 'discount_percent', 20)),
    p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'pending_approval'::sale_status,
    'the limit counts line discounts too, not only blanket ones');

  -- ---- the staff limit, in rand --------------------------------------------
  -- Both set: the tighter one binds. 10% of the dearer line is more than R1,
  -- so R1 is what actually holds.
  update public.app_users set discount_limit_amount = 1 where id = v_emp;
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => 1, p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'completed'::sale_status,
    'where both limits are set the sale must clear both');
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => 2, p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'pending_approval'::sale_status,
    'and the tighter of the two is the one that binds');

  update public.app_users
     set discount_limit_percent = null, discount_limit_amount = null
   where id = v_emp;

  -- ---- the item cap --------------------------------------------------------
  -- Five percent off the dearer line, and no more, whoever asks.
  update public.products set max_discount_percent = 5 where id = v_b;

  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(jsonb_build_object(
      'product_id', v_b, 'qty', 1, 'discount_percent', 5)),
    p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'completed'::sale_status,
    'a discount at the cap is allowed');

  -- The owner can approve their own discounts and is refused anyway. That is
  -- the whole difference between a cap and a limit.
  perform assert_refuses(
    format($f$select public.pos_create_sale(%L, %L, %L::jsonb)$f$, v_tok, v_mgr,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_b, 'qty', 1, 'discount_percent', 6))::text),
    'a line discount past the item cap, given by someone who can approve');

  -- And it cannot be walked around by taking the money off the whole sale
  -- instead: the cap watches what the line loses, however it loses it.
  perform assert_refuses(
    format($f$select public.pos_create_sale(%L, %L, %L::jsonb, p_discount_amount => %L)$f$,
      v_tok, v_mgr,
      jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1))::text,
      round(v_pb * 0.20, 2)),
    'a sale-level discount that lands past the item cap');

  -- An uncapped line in the same sale is not held back by the capped one, so
  -- long as the capped line stays inside its own ceiling.
  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
  update public.products set max_discount_percent = 50 where id = v_b;
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(
      jsonb_build_object('product_id', v_a, 'qty', 1),
      jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => round((v_pa + v_pb) * 0.10, 2), p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'completed'::sale_status,
    'a cap looser than the discount does not get in the way');

  -- ---- the rand cap is per unit --------------------------------------------
  -- R1 off a unit means R2 off two of them, the same shape a percentage has.
  -- A per-line rand cap would tighten as the customer bought more.
  update public.products
     set max_discount_percent = null, max_discount_amount = 1 where id = v_b;
  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;

  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(jsonb_build_object(
      'product_id', v_b, 'qty', 2, 'discount_amount', 2)),
    p_payment_method => 'cash');
  perform assert_eq(v_sale.discount_amount, 2::numeric,
    'a R1 cap allows R2 off two units');
  perform assert_refuses(
    format($f$select public.pos_create_sale(%L, %L, %L::jsonb)$f$, v_tok, v_mgr,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_b, 'qty', 2, 'discount_amount', 3))::text),
    'and stops at R2 — the cap scales with quantity, it does not multiply');

  -- ---- a cap of zero means no discount at all ------------------------------
  update public.products set max_discount_amount = 0 where id = v_b;
  perform assert_refuses(
    format($f$select public.pos_create_sale(%L, %L, %L::jsonb)$f$, v_tok, v_mgr,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_b, 'qty', 1, 'discount_amount', 1))::text),
    'a cap of zero is a line that is never discounted');

  update public.products
     set max_discount_percent = null, max_discount_amount = null
   where id in (v_a, v_b);
  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
end $$;

-- 0037: the manager sets both, through the back office ------------------------

do $$
declare v_tok text; v_emp uuid; v_row record; v_prod uuid;
begin
  select token into v_tok from till;
  select employee_id into v_emp from fixture;
  select id into v_prod from public.products where active order by name limit 1;

  select * into v_row from public.pos_admin_update_user(
    v_tok, '1234', v_emp, p_discount_limit_percent => 15,
    p_discount_limit_amount => 250);
  perform assert_eq(v_row.discount_limit_percent, 15::numeric,
    'the manager can set a percentage limit on a staff member');
  perform assert_eq(v_row.discount_limit_amount, 250::numeric,
    'and a rand one beside it');

  -- The roster reports it, so the editor opens on what is actually stored.
  perform assert_eq(
    (select u.discount_limit_percent from public.pos_admin_list_users(v_tok, '1234') u
      where u.id = v_emp), 15::numeric,
    'and the roster carries it back');

  -- Editing something else must not quietly clear the limit.
  select * into v_row from public.pos_admin_update_user(
    v_tok, '1234', v_emp, p_name => 'Counter hand');
  perform assert_eq(v_row.discount_limit_percent, 15::numeric,
    'renaming somebody leaves their limit alone');

  -- Zero is how a limit is taken away; there is no such thing as a zero limit.
  select * into v_row from public.pos_admin_update_user(
    v_tok, '1234', v_emp, p_discount_limit_percent => 0,
    p_discount_limit_amount => 0);
  perform assert(v_row.discount_limit_percent is null
             and v_row.discount_limit_amount is null,
    'and zero clears it');

  perform assert_refuses(
    format($f$select public.pos_admin_update_user(%L, '1234', %L,
                 p_discount_limit_percent => 120)$f$, v_tok, v_emp),
    'a limit of 120%% is not a percentage');

  -- The item cap, set the way the catalogue editor sets it.
  perform public.pos_admin_save_product(
    v_tok, '1234', v_prod,
    (select sku from public.products where id = v_prod),
    (select barcode from public.products where id = v_prod),
    (select name from public.products where id = v_prod),
    (select description from public.products where id = v_prod),
    (select category_id from public.products where id = v_prod),
    (select unit_code from public.products where id = v_prod),
    (select price_retail from public.products where id = v_prod),
    (select price_trade from public.products where id = v_prod),
    (select cost from public.products where id = v_prod),
    (select tax_code from public.products where id = v_prod),
    (select stock_qty from public.products where id = v_prod),
    (select reorder_level from public.products where id = v_prod),
    true, null, null, 7.5, 30);
  perform assert_eq(
    (select p.max_discount_percent from public.products p where p.id = v_prod),
    7.5::numeric, 'the catalogue editor can cap a product');

  -- The till gets the cap with the catalogue, so the discount dialog can hold
  -- the line with the shop's connection down.
  perform assert_eq(
    (select c.max_discount_percent from public.pos_catalogue(v_tok) c
      where c.id = v_prod), 7.5::numeric,
    'and the till is told about it in the catalogue it caches');

  -- Clearing the boxes clears the cap. Null means none, unlike the picture.
  perform public.pos_admin_save_product(
    v_tok, '1234', v_prod,
    (select sku from public.products where id = v_prod),
    (select barcode from public.products where id = v_prod),
    (select name from public.products where id = v_prod),
    (select description from public.products where id = v_prod),
    (select category_id from public.products where id = v_prod),
    (select unit_code from public.products where id = v_prod),
    (select price_retail from public.products where id = v_prod),
    (select price_trade from public.products where id = v_prod),
    (select cost from public.products where id = v_prod),
    (select tax_code from public.products where id = v_prod),
    (select stock_qty from public.products where id = v_prod),
    (select reorder_level from public.products where id = v_prod),
    true, null, null, null, null);
  perform assert(
    (select p.max_discount_percent from public.products p where p.id = v_prod) is null,
    'and clearing the box removes it');

  update public.app_users set name = 'Cashier' where id = v_emp;
end $$;

select 'all database tests passed' as result;
