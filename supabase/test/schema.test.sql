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
  v_cust uuid; v_expected numeric; v_status jsonb;
begin
  select token into v_tok from till;
  select manager_id into v_mgr from fixture;
  select id, price_retail into v_prod, v_price
    from public.products where active and price_retail > 0 limit 1;

  -- 0047: the till may ask, without a PIN, whether a drawer is open here.
  perform assert(public.pos_cash_session_status(v_tok) is null,
    'no drawer open, no status');

  v_session := public.pos_cash_session_open(v_tok, '1234', 500);
  perform assert_eq(v_session.opening_float, 500::numeric, 'the float is recorded');

  v_status := public.pos_cash_session_status(v_tok);
  perform assert_eq(v_status->>'opened_by_name', 'Manager', 'the status names who opened it');
  perform assert((v_status->>'hours_open')::numeric < 1, 'and says how long ago');
  perform assert(v_status ? 'expected_cash' = false and v_status ? 'figures' = false,
    'and carries no figures — it is answered without a PIN');

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

  -- 0047: a settlement on the card machine is listed by its method — the
  -- card batch does not know a sale from a debtor paying up.
  if v_cust is not null then
    perform public.pos_take_account_payment(v_tok, v_mgr, v_cust, 75, 'card', 'batch 12', null, null);
    v_fig := public.pos_cash_session_current(v_tok, '1234') -> 'figures';
    perform assert_eq((v_fig->'account_payments'->>'card')::numeric, 75::numeric,
      'an account settlement by card is listed under its method');
    perform assert_eq((v_fig->'account_payments'->>'cash')::numeric, 200::numeric,
      'and the cash one is listed there too');
    perform assert_eq((v_fig->>'account_cash')::numeric, 200::numeric,
      'while the drawer still counts only the cash one');
    perform assert_eq((v_fig->>'expected_cash')::numeric, v_expected,
      'a card settlement is not drawer money');
  end if;

  -- 0048: the card machine and the bank against the till, and the banking.
  -- The till's card figure is the card sale plus the card settlement.
  perform assert_eq((v_fig->>'card_expected')::numeric,
    v_price + coalesce(case when v_cust is null then 0 else 75 end, 0),
    'the card figure is card sales plus card settlements');
  perform assert_refuses(
    format('select public.pos_cash_session_close(%L, %L, 100, null, null, null, 500)', v_tok, '1234'),
    'more cannot be banked than was counted');
  perform assert_refuses(
    format('select public.pos_cash_session_close(%L, %L, 100, null, -1, null, null)', v_tok, '1234'),
    'a negative card total');
  perform assert_eq(
    (select count(*)::int from pg_proc where proname = 'pos_cash_session_close'),
    1, 'the close has exactly one signature');

  -- Count it R5 light; the card machine R10 over; bank all but R300.
  v_closed := public.pos_cash_session_close(v_tok, '1234', v_expected - 5, 'Short a fiver',
    p_card_counted => (v_fig->>'card_expected')::numeric + 10,
    p_eft_counted => 0,
    p_banked => v_expected - 5 - 300);
  perform assert_eq((v_closed->>'variance')::numeric, -5::numeric,
    'the variance is counted less expected');
  perform assert_eq((v_closed->>'expected_cash')::numeric, v_expected,
    'and the expected figure is snapshotted, not recomputed later');
  perform assert_eq((v_closed->>'card_variance')::numeric, 10::numeric,
    'the card machine is over by what it is over by');
  perform assert_eq((v_closed->>'eft_variance')::numeric, 0::numeric,
    'no EFTs expected, none received, agrees');
  perform assert_eq((v_closed->>'float_kept')::numeric, 300::numeric,
    'what was not banked is tomorrow''s float');
  perform assert_eq(public.pos_cash_session_suggested_float(v_tok, '1234'), 300::numeric,
    'and the open form is offered it');

  -- The session's sales are stamped on the way out, so the window it was
  -- measured over stays reconstructable.
  perform assert(
    (select count(*) from public.sales where session_id = (v_closed->>'id')::uuid) = 2,
    'closing stamps the sales it counted');

  perform assert_refuses(
    format('select public.pos_cash_movement(%L, %L, %L, 10, %L)',
           v_tok, '1234', 'pay_out', 'after close'),
    'a movement against a closed session');

  -- And the till is free to open tomorrow, on the float that was kept.
  v_session := public.pos_cash_session_open(v_tok, '1234', public.pos_cash_session_suggested_float(v_tok, '1234'));
  perform assert_eq(v_session.opening_float, 300::numeric, 'tomorrow opens on last night''s float');
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

-- 0038: a percent limit is a rate, not a sum of money --------------------------
--
-- 0037 measured the percentage against the whole sale, so a cashier on 5% could
-- take 10% off one line inside a bigger sale and complete it unasked. These are
-- the shop's own figures from the day it was spotted.

do $$
declare v_tok text; v_emp uuid; v_a uuid; v_b uuid; v_pa numeric; v_pb numeric;
        v_sale public.sales;
begin
  select token into v_tok from till;
  select employee_id into v_emp from fixture;
  select id, price_retail into v_a, v_pa from public.products
   where active and price_retail > 0 order by price_retail limit 1;
  select id, price_retail into v_b, v_pb from public.products
   where active and price_retail > 0 and id <> v_a order by price_retail desc limit 1;

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
  update public.app_users set active = true, status = 'active' where id = v_emp;
  -- Put stock back. The blocks above have been selling these two lines all
  -- file, and this one rings up a dozen more sales; running out here would be
  -- a stock check failing, not a discount rule.
  update public.products
     set max_discount_percent = null, max_discount_amount = null, stock_qty = 1000
   where id in (v_a, v_b);

  -- Five percent, and a rand ceiling loose enough that it is never the thing
  -- doing the work — the percentage has to hold on its own.
  update public.app_users
     set discount_limit_percent = 5, discount_limit_amount = 100000
   where id = v_emp;

  -- THE BUG. Ten percent off the dear line, inside a sale big enough that the
  -- money involved is under five percent of the whole. This completed.
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(
      jsonb_build_object('product_id', v_a, 'qty', 1),
      jsonb_build_object('product_id', v_b, 'qty', 1, 'discount_percent', 10)),
    p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'pending_approval'::sale_status,
    'ten percent off a line is past a five percent limit, whatever the sale totals');

  -- The extreme the old rule allowed: a whole line given away free, because the
  -- money it came to was small next to the rest of the basket.
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(
      jsonb_build_object('product_id', v_b, 'qty', 1),
      jsonb_build_object('product_id', v_a, 'qty', 1, 'discount_percent', 100)),
    p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'pending_approval'::sale_status,
    'and a line given away free is never inside a five percent limit');

  -- At the rate, it still goes through on the cashier's own authority.
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(
      jsonb_build_object('product_id', v_a, 'qty', 1),
      jsonb_build_object('product_id', v_b, 'qty', 1, 'discount_percent', 5)),
    p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'completed'::sale_status,
    'five percent off a line is inside a five percent limit');
  perform assert(v_sale.approved_by is null,
    'and nobody is recorded as approving what nobody was asked about');

  -- A blanket discount spreads evenly, so the rate is the same on every line
  -- and the limit behaves exactly as it always did for this shape of discount.
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(
      jsonb_build_object('product_id', v_a, 'qty', 1),
      jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => round((v_pa + v_pb) * 0.05, 2), p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'completed'::sale_status,
    'five percent off the whole sale is still five percent');
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(
      jsonb_build_object('product_id', v_a, 'qty', 1),
      jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => round((v_pa + v_pb) * 0.06, 2), p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'pending_approval'::sale_status,
    'and six percent off the whole sale is past it');

  -- Line and blanket together land on the same line, and are counted once,
  -- against the same rate. Neither route is a way around the other.
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(
      jsonb_build_object('product_id', v_b, 'qty', 1, 'discount_percent', 4)),
    p_discount_amount => round(v_pb * 0.03, 2), p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'pending_approval'::sale_status,
    'four percent off the line plus three off the sale is seven, not four');

  -- ---- the rand half is still a ceiling on the sale ------------------------
  update public.app_users
     set discount_limit_percent = 100, discount_limit_amount = 10
   where id = v_emp;
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => 10, p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'completed'::sale_status,
    'the rand half holds at its figure');
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => 11, p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'pending_approval'::sale_status,
    'and a rand past it fetches a manager, whatever the rate came to');

  -- Either exceeded is enough. Here the rate is fine and the money is not.
  update public.app_users
     set discount_limit_percent = 50, discount_limit_amount = 1
   where id = v_emp;
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(
      jsonb_build_object('product_id', v_b, 'qty', 1, 'discount_percent', 10)),
    p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'pending_approval'::sale_status,
    'whichever of the two is exceeded is the one that decides');

  -- No limit at all is still no standing authority.
  update public.app_users
     set discount_limit_percent = null, discount_limit_amount = null
   where id = v_emp;
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => 1, p_payment_method => 'cash');
  perform assert_eq(v_sale.status, 'pending_approval'::sale_status,
    'somebody with no limit still has nothing they may give unasked');

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
end $$;

-- 0038: where to pay the shop, and the rate it charges -------------------------

do $$
declare v_tok text; v_row record;
begin
  select token into v_tok from till;

  perform public.pos_admin_save_settings(v_tok, '1234', jsonb_build_object(
    'bank_name', 'First National Bank',
    'bank_account_name', '5 Star Hardware CC',
    'bank_account_number', '62012345678',
    'bank_branch_code', '250655',
    'email', 'accounts@5star.co.za'));

  select * into v_row from public.pos_org_settings(v_tok);
  perform assert_eq(v_row.bank_account_number, '62012345678',
    'the shop can say where its money goes');
  perform assert_eq(v_row.bank_branch_code, '250655', 'branch code and all');
  perform assert_eq(v_row.email, 'accounts@5star.co.za', 'and where to write to it');

  -- The rate the till shows comes from the table the sale reads, so the two
  -- cannot disagree the day a new rate takes effect.
  perform assert_eq(v_row.vat_rate, public.tax_rate_at('standard', current_date),
    'the VAT rate on screen is the one that will be charged');

  -- Saving something else leaves the banking alone — the settings screen sends
  -- one field at a time when a manager edits one field at a time.
  perform public.pos_admin_save_settings(v_tok, '1234',
    jsonb_build_object('phone', '065 735 2766'));
  select * into v_row from public.pos_org_settings(v_tok);
  perform assert_eq(v_row.bank_account_number, '62012345678',
    'and editing the phone number does not lose the bank account');
end $$;

-- 0039: approving over the phone without giving away a PIN --------------------

do $$
declare v_tok text; v_mgr uuid; v_emp uuid; v_b uuid; v_pb numeric;
        v_code text; v_exp timestamptz; v_sale public.sales; v_row record;
begin
  select token into v_tok from till;
  select manager_id into v_mgr from fixture;
  select employee_id into v_emp from fixture;
  select id, price_retail into v_b, v_pb from public.products
   where active and price_retail > 0 order by price_retail desc limit 1;

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
  delete from public.approval_codes;
  update public.app_users
     set active = true, status = 'active',
         discount_limit_percent = null, discount_limit_amount = null
   where id = v_emp;
  update public.products
     set max_discount_percent = null, max_discount_amount = null, stock_qty = 1000
   where id = v_b;

  select code, expires_at into v_code, v_exp
    from public.pos_issue_approval_code(v_tok, '1234', 10, 100, 'Mr Molefe');
  perform assert(v_code ~ '^\d{6}$', 'a code is six digits');
  perform assert(v_exp > now(), 'and it is alive when it is issued');

  -- Nothing anywhere stores the code itself, only its hash — the same bargain
  -- as a PIN. Nobody can read it back out, including whoever runs the database.
  perform assert_eq(
    (select count(*)::int from public.approval_codes where code_hash = v_code), 0,
    'the code is stored hashed, never in the clear');

  -- The till asks before the cashier is committed to anything.
  select * into v_row from public.pos_check_approval_code(v_tok, v_code);
  perform assert(v_row.ok, 'a live code checks out');
  perform assert_eq(v_row.max_amount, 100::numeric, 'and says what it will carry');
  select * into v_row from public.pos_check_approval_code(v_tok, '000000');
  perform assert(not v_row.ok, 'a code nobody issued does not');

  -- It releases the sale, and the sale names the MANAGER who issued it.
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => 50, p_payment_method => 'cash',
    p_approval_code => v_code);
  perform assert_eq(v_sale.status, 'completed'::sale_status,
    'a code releases the sale');
  perform assert_eq(v_sale.approved_by, v_mgr,
    'and the manager who issued it is the approver, not the cashier who typed it');
  perform assert(v_sale.doc_number is not null, 'so it takes an invoice number');

  -- Single use. Overhearing it is worth nothing once it has been spent.
  perform assert_refuses(
    format($f$select public.pos_create_sale(%L, %L, %L::jsonb,
                     p_discount_amount => 50, p_approval_code => %L)$f$,
      v_tok, v_emp,
      jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1))::text,
      v_code),
    'a code that has already been used');
  select * into v_row from public.pos_check_approval_code(v_tok, v_code);
  perform assert(not v_row.ok, 'and it stops checking out too');

  -- The trail: who issued it, who spent it, on what.
  select * into v_row from public.pos_approval_codes(v_tok, '1234') limit 1;
  perform assert(v_row.used_at is not null, 'a spent code says so');
  perform assert_eq(v_row.used_by_name,
    (select name from public.app_users where id = v_emp),
    'and names who spent it');
  perform assert_eq(v_row.doc_number, v_sale.doc_number,
    'and which invoice it released');

  -- ---- the ceiling ---------------------------------------------------------
  select code into v_code from public.pos_issue_approval_code(v_tok, '1234', 10, 20);
  perform assert_refuses(
    format($f$select public.pos_create_sale(%L, %L, %L::jsonb,
                     p_discount_amount => 50, p_approval_code => %L)$f$,
      v_tok, v_emp,
      jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1))::text,
      v_code),
    'a code for R20 releasing a R50 discount');
  -- Refused, and NOT spent: the manager should not have to issue a second one
  -- because the first was burnt on a sale that never happened.
  select * into v_row from public.pos_check_approval_code(v_tok, v_code);
  perform assert(v_row.ok, 'a code refused for being too small is not spent');

  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => 20, p_payment_method => 'cash',
    p_approval_code => v_code);
  perform assert_eq(v_sale.status, 'completed'::sale_status,
    'and it still works at its ceiling');

  -- ---- expiry --------------------------------------------------------------
  select code into v_code from public.pos_issue_approval_code(v_tok, '1234', 1);
  update public.approval_codes set expires_at = now() - interval '1 minute'
   where used_at is null;
  perform assert_refuses(
    format($f$select public.pos_create_sale(%L, %L, %L::jsonb,
                     p_discount_amount => 5, p_approval_code => %L)$f$,
      v_tok, v_emp,
      jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1))::text,
      v_code),
    'a code that has expired');

  -- But a sale RUNG UP while it was live still goes through when the line comes
  -- back. This shop sells through outages; a queued sale must not be refused
  -- because the connection returned late.
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => 5, p_payment_method => 'cash',
    p_created_at => now() - interval '5 minutes',
    p_approval_code => v_code);
  perform assert_eq(v_sale.status, 'completed'::sale_status,
    'a sale taken while the code was live syncs later on that code');

  -- ---- what a code may NOT do ---------------------------------------------
  -- An item cap is not an authority question. No code lifts one.
  update public.products set max_discount_percent = 5 where id = v_b;
  select code into v_code from public.pos_issue_approval_code(v_tok, '1234', 10);
  perform assert_refuses(
    format($f$select public.pos_create_sale(%L, %L, %L::jsonb,
                     p_discount_amount => %L, p_approval_code => %L)$f$,
      v_tok, v_emp,
      jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1))::text,
      round(v_pb * 0.20, 2), v_code),
    'a code lifting an item cap');
  update public.products set max_discount_percent = null where id = v_b;

  -- Only somebody who could approve in person may issue one.
  perform assert_refuses(
    format($f$select public.pos_issue_approval_code(%L, '5678', 10)$f$, v_tok),
    'a counter hand issuing themselves an approval code');

  delete from public.approval_codes;
  delete from public.approval_attempts;
  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
end $$;

-- 0039: guessing at codes is not a game you can play --------------------------

do $$
declare v_tok text; v_row record; v_blocked boolean := false;
begin
  select token into v_tok from till;
  delete from public.approval_attempts;

  for i in 1..10 loop
    select * into v_row from public.pos_check_approval_code(v_tok, '999999');
    perform assert(not v_row.ok, 'a wrong code is wrong');
  end loop;

  begin
    perform public.pos_check_approval_code(v_tok, '999999');
  exception when others then
    v_blocked := true;
  end;
  perform assert(v_blocked, 'and a till that keeps guessing stops being answered');

  delete from public.approval_attempts;
end $$;

-- 0040: telling a phone approval from one given at the counter ----------------

do $$
declare v_tok text; v_mgr uuid; v_emp uuid; v_b uuid; v_code text;
        v_sale public.sales; v_hist jsonb; v_row jsonb;
begin
  select token into v_tok from till;
  select manager_id into v_mgr from fixture;
  select employee_id into v_emp from fixture;
  select id into v_b from public.products
   where active and price_retail > 0 order by price_retail desc limit 1;

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
  delete from public.approval_codes;
  update public.app_users
     set active = true, status = 'active',
         discount_limit_percent = null, discount_limit_amount = null
   where id = v_emp;
  update public.products
     set max_discount_percent = null, max_discount_amount = null, stock_qty = 1000
   where id = v_b;

  -- One released by a manager standing at the till.
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => 10, p_payment_method => 'cash',
    p_approved_by => v_mgr);
  perform assert_eq(v_sale.status, 'completed'::sale_status, 'a PIN releases it');

  -- And one released down a phone line.
  select code into v_code from public.pos_issue_approval_code(v_tok, '1234', 10);
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_emp,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_b, 'qty', 1)),
    p_discount_amount => 10, p_payment_method => 'cash',
    p_approval_code => v_code);
  perform assert_eq(v_sale.status, 'completed'::sale_status, 'so does a code');

  v_hist := public.pos_sales_history(
    v_tok, '1234', now() - interval '1 hour', now() + interval '1 hour');

  -- Both name the manager, because both were the manager's decision. Only one
  -- of them was made by somebody who could see the counter.
  select r into v_row from jsonb_array_elements(v_hist->'rows') r
   where (r->>'id')::uuid = v_sale.id;
  perform assert_eq(v_row->>'approved_by_name',
    (select name from public.app_users where id = v_mgr),
    'the sales list says who released it');
  perform assert_eq((v_row->>'approved_by_code')::boolean, true,
    'and that this one was released by a code');

  select r into v_row from jsonb_array_elements(v_hist->'rows') r
   where (r->>'approved_by_code')::boolean is false;
  perform assert_eq(v_row->>'approved_by_name',
    (select name from public.app_users where id = v_mgr),
    'while the one approved at the counter names the same manager');

  delete from public.approval_codes;
  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
end $$;

-- 0041: why the money came off this line --------------------------------------
--
-- The amount and the percentage have been stored since 0035. The words the
-- cashier typed were dropped between the modal and the server, so an invoice
-- could say a line was marked down 10% and nothing anywhere said why.

do $$
declare v_tok text; v_mgr uuid; v_a uuid; v_b uuid; v_pb numeric;
        v_sale public.sales; v_row record; v_long text;
begin
  select token into v_tok from till;
  select manager_id into v_mgr from fixture;
  select id into v_a from public.products
   where active and price_retail > 0 order by price_retail limit 1;
  select id, price_retail into v_b, v_pb from public.products
   where active and price_retail > 0 and id <> v_a order by price_retail desc limit 1;

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
  update public.products
     set max_discount_percent = null, max_discount_amount = null, stock_qty = 1000
   where id in (v_a, v_b);

  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(
      jsonb_build_object('product_id', v_a, 'qty', 1,
                         'discount_reason', 'no discount here'),
      jsonb_build_object('product_id', v_b, 'qty', 1, 'discount_percent', 10,
                         'discount_reason', '  church job, Mr Molefe  ')),
    p_payment_method => 'cash');

  select * into v_row from public.sale_items
   where sale_id = v_sale.id and product_id = v_b;
  perform assert_eq(v_row.discount_reason, 'church job, Mr Molefe',
    'the line keeps the words the cashier typed, trimmed');
  -- The percentage lives in its own column and must not be doubled up here:
  -- two copies of one fact are two facts that can disagree.
  perform assert_eq(v_row.discount_percent, 10::numeric,
    'while the percentage stays where it has always been');

  select * into v_row from public.sale_items
   where sale_id = v_sale.id and product_id = v_a;
  perform assert(v_row.discount_reason is null,
    'a reason on a line nobody discounted is a note about nothing');

  -- The reprint reads it back. Without this the reason exists only in the
  -- database and never on the paper the customer and the month-end look at.
  select * into v_row from public.pos_sale_items(v_tok, v_sale.id)
   where discount_amount > 0;
  perform assert_eq(v_row.discount_reason, 'church job, Mr Molefe',
    'and a reprint can say it');

  -- Free text off a till, so it is bounded. Nothing downstream wants a
  -- paragraph pasted into an invoice line.
  v_long := repeat('x', 500);
  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(jsonb_build_object(
      'product_id', v_b, 'qty', 1, 'discount_percent', 10,
      'discount_reason', v_long)),
    p_payment_method => 'cash');
  select * into v_row from public.sale_items where sale_id = v_sale.id;
  perform assert_eq(length(v_row.discount_reason), 200,
    'a reason is cut to something an invoice line can hold');

  -- Whitespace is not a reason.
  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(jsonb_build_object(
      'product_id', v_b, 'qty', 1, 'discount_percent', 10,
      'discount_reason', '   ')),
    p_payment_method => 'cash');
  select * into v_row from public.sale_items where sale_id = v_sale.id;
  perform assert(v_row.discount_reason is null,
    'and blank is no reason at all');

  delete from public.sale_payments where sale_id in (select id from public.sales);
  delete from public.sale_items    where sale_id in (select id from public.sales);
  delete from public.sales;
end $$;

-- 0042: a quote that prices the job rather than the shopping list ------------
--
-- An itemised quote is a list a competitor can read. Shops that quote on jobs
-- want a total and nothing else, and this is a shop-wide choice rather than a
-- tick somebody has to remember at the counter.

do $$
declare v_tok text; v_row record;
begin
  select token into v_tok from till;

  -- The default has to be "show", or turning this on would silently change the
  -- paper every existing shop hands out.
  select * into v_row from public.pos_org_settings(v_tok);
  perform assert_eq(v_row.quote_show_line_prices, true,
    'a shop that has never been asked still prices every line');

  perform public.pos_admin_save_settings(v_tok, '1234',
    jsonb_build_object('quote_show_line_prices', false));
  select * into v_row from public.pos_org_settings(v_tok);
  perform assert_eq(v_row.quote_show_line_prices, false,
    'and a shop that asks for totals only gets it');

  -- The awkward one. Every other field here is text, where coalesce on a
  -- missing key does the right thing by accident. A boolean read for
  -- truthiness rather than cast would treat `false` as "not supplied" and
  -- refuse ever to turn the setting off again.
  perform public.pos_admin_save_settings(v_tok, '1234',
    jsonb_build_object('phone', '065 735 2766'));
  select * into v_row from public.pos_org_settings(v_tok);
  perform assert_eq(v_row.quote_show_line_prices, false,
    'editing the phone number does not put the prices back');

  perform public.pos_admin_save_settings(v_tok, '1234',
    jsonb_build_object('quote_show_line_prices', true));
  select * into v_row from public.pos_org_settings(v_tok);
  perform assert_eq(v_row.quote_show_line_prices, true,
    'and it can be turned back on');
end $$;

-- 0043: a code that failed to send is news the roster carries ----------------
--
-- The auth edge function used to hand each OTP to the SMS provider and throw
-- the answer away, so "they never asked for a code" and "they asked and the
-- provider failed them" were indistinguishable from the staff screen. The
-- outcome now lands on the attempt, and pos_admin_list_users reports the most
-- recent one per phone.

do $$
declare v_tok text; v_new uuid; v_err text;
begin
  select token into v_tok from till;

  select id into v_new from public.pos_admin_invite_user(
    v_tok, '1234', 'Waiting on SMS', '+27820000008', 'employee'::user_role,
    array[]::text[]);

  -- Nobody has asked for a code yet: nothing to report.
  select u.last_code_error into v_err
    from public.pos_admin_list_users(v_tok, '1234') u where u.id = v_new;
  perform assert_eq(v_err, null::text,
    'no attempt yet reads as nothing to report');

  -- The provider refused the first attempt.
  insert into public.auth_otps (phone_e164, purpose, code_hash, expires_at,
                                send_error, created_at)
  values ('+27820000008', 'enrol', 'x', now() + interval '10 minutes',
          'The SMS service could not be reached', now() - interval '2 minutes');

  select u.last_code_error into v_err
    from public.pos_admin_list_users(v_tok, '1234') u where u.id = v_new;
  perform assert_eq(v_err, 'The SMS service could not be reached',
    'a failed send reaches the roster, in its own words');

  -- And it stays on the row it belongs to: the manager's own line is clean.
  select u.last_code_error into v_err
    from public.pos_admin_list_users(v_tok, '1234') u
   where u.phone = '+27820000001';
  perform assert_eq(v_err, null::text,
    'one person''s failure does not bleed onto another''s row');

  -- A later attempt goes through; the failure has been dealt with and must
  -- stop being reported, or it nags for ever about an outage that is over.
  insert into public.auth_otps (phone_e164, purpose, code_hash, expires_at,
                                sent_at)
  values ('+27820000008', 'enrol', 'x', now() + interval '10 minutes', now());

  select u.last_code_error into v_err
    from public.pos_admin_list_users(v_tok, '1234') u where u.id = v_new;
  perform assert_eq(v_err, null::text,
    'a send that went through clears the failure before it');
end $$;

-- 0044: shelf capture --------------------------------------------------------
--
-- The aisle permission. The properties that matter: it opens exactly the
-- shelf RPCs and nothing else in the back office; what it records cannot
-- change what the till sells (photos are cosmetic, new items are born
-- hidden); and both roads in — the grant, and manage_catalogue as the
-- broader power — arrive at the same place.

do $$
declare v_tok text; v_shelf uuid; v_super uuid; v_row record; v_new record; v_np record; v_img uuid;
begin
  select token into v_tok from till;

  perform assert(
    exists (select 1 from public.permissions where code = 'shelf_capture'),
    'the shelf permission is in the catalogue');
  perform assert('shelf_capture' = any(public.role_default_permissions('manager')),
    'a manager holds it through the role');
  perform assert(not ('shelf_capture' = any(public.role_default_permissions('employee'))),
    'a counter hand does not, until granted');

  -- Somebody granted exactly the shelf, nothing else.
  select id into v_shelf from public.pos_admin_invite_user(
    v_tok, '1234', 'Shelf hand', '+27820000031', 'employee'::user_role,
    array['shelf_capture']);
  update public.app_users set status = 'active',
         pin_hash = crypt('7777', gen_salt('bf')) where id = v_shelf;

  -- The branch point: a barcode either names an item or it does not.
  select * into v_row from public.pos_shelf_lookup(v_tok, '7777', '6001234000015');
  perform assert_eq(v_row.name, 'Cement 42.5N 50kg', 'the barcode finds the item');
  perform assert_eq(v_row.has_photo, false, 'and says it has no photo yet');
  perform assert_eq(
    (select count(*)::int from public.pos_shelf_lookup(v_tok, '7777', '6000000000009')),
    0, 'an unknown barcode returns nothing');

  -- A new item is born hidden, and the same barcode cannot be born twice.
  select * into v_new from public.pos_shelf_add_item(
    v_tok, '7777', '6009876543210', 'Padlock 60mm brass', 96);
  perform assert_eq(v_new.active, false, 'a shelf-recorded item is born hidden');
  perform assert_eq(
    (select p.active from public.products p where p.id = v_new.id), false,
    'hidden in the table, not only in the reply');
  perform assert_eq(
    (select p.sku from public.products p where p.id = v_new.id),
    'SHELF-6009876543210', 'its stock code says where it came from');
  perform assert_refuses(
    format('select public.pos_shelf_add_item(%L, %L, %L, %L, 50)',
           v_tok, '7777', '6009876543210', 'Padlock again'),
    'the same barcode cannot be recorded twice');
  perform assert_refuses(
    format('select public.pos_shelf_add_item(%L, %L, %L, %L, 50)',
           v_tok, '7777', 'not-a-code', 'Mystery item'),
    'a barcode is digits, not prose');
  -- 0046: a price is the reviewer's job. Recorded without one, the item
  -- sits at 0.00 and hidden — "not priced yet" in Catalogue — and the
  -- four-argument call is not ambiguous with the old five-argument one.
  select * into v_np from public.pos_shelf_add_item(
    v_tok, '7777', '6001111111119', 'Priceless');
  perform assert_eq(v_np.price_retail, 0::numeric,
    'an item recorded without a price is stored unpriced');
  perform assert_eq(v_np.active, false, 'and is still born hidden');
  perform assert_eq(
    (select count(*)::int from pg_proc where proname = 'pos_shelf_add_item'),
    1, 'the shelf add has exactly one signature');
  perform assert_refuses(
    format('select public.pos_shelf_add_item(%L, %L, %L, %L, -1)',
           v_tok, '7777', '6001111111126', 'Below zero'),
    'a negative price is still refused');

  -- The fence: the shelf permission opens the shelf and nothing else.
  perform assert_refuses(
    format('select public.pos_admin_list_products(%L, %L)', v_tok, '7777'),
    'a shelf hand cannot read the catalogue screen');
  perform assert_refuses(
    format('select public.pos_admin_list_users(%L, %L)', v_tok, '7777'),
    'nor the staff list');

  -- The photo path: recording an image is exactly what the grant is for.
  select public.pos_admin_add_product_image(
    v_tok, '7777', v_row.id, 'org/test/cement.jpg') into v_img;
  perform assert(v_img is not null, 'a shelf hand can record a photograph');
  select * into v_row from public.pos_shelf_lookup(v_tok, '7777', '6001234000015');
  perform assert_eq(v_row.has_photo, true, 'and the lookup now says so');

  -- The other road in: manage_catalogue without the shelf grant also opens
  -- the shelf — a supervisor who can already edit every product must not be
  -- refused the quicker path.
  select id into v_super from public.pos_admin_invite_user(
    v_tok, '1234', 'Counter supervisor', '+27820000032', 'employee'::user_role,
    array['manage_catalogue']);
  update public.app_users set status = 'active',
         pin_hash = crypt('8888', gen_salt('bf')) where id = v_super;
  perform assert_eq(
    (select count(*)::int from public.pos_shelf_lookup(v_tok, '8888', '6001234000015')),
    1, 'manage_catalogue opens the shelf too');

  -- A price fixed at the shelf needs catalogue rights, and the shelf grant
  -- alone must NOT be enough — that is the whole safety story of handing the
  -- phone to whoever walks the aisle.
  perform assert_eq(
    public.pos_shelf_set_price(v_tok, '8888', v_new.id, 99.50), 99.50::numeric,
    'catalogue rights can fix a price from the shelf');
  perform assert_refuses(
    format('select public.pos_shelf_set_price(%L, %L, %L, 1)',
           v_tok, '7777', v_new.id),
    'the shelf grant alone cannot touch a price');

  -- And no permission at all opens nothing. An ACTIVE counter hand, so the
  -- refusal is about the permission — '5678' would also refuse, but only
  -- because its owner was disabled two tests ago, which proves nothing here.
  update public.app_users set pin_hash = crypt('2222', gen_salt('bf'))
   where id = (select employee_id from fixture);
  perform assert_refuses(
    format('select public.pos_shelf_lookup(%L, %L, %L)', v_tok, '2222', '6001234000015'),
    'a plain counter PIN does not open the shelf');
end $$;

-- 0045: returns --------------------------------------------------------------
--
-- The properties that make a return trustworthy: the refund is what was paid
-- (discounts included, cents exact across partial returns); nothing can come
-- back twice; the money moves the way it came in — cash out of an OPEN
-- drawer, or credit onto the account; and the shelf gains only what is fit
-- to sell again.

do $$
declare
  v_fig jsonb;
  v_tok text; v_mgr uuid; v_emp uuid; v_cust uuid;
  v_cem uuid; v_stock_before numeric;
  v_sale public.sales; v_li public.sale_items;
  r1 record; r2 record; r3 record;
  v_bal numeric;
begin
  select token into v_tok from till;
  select manager_id, employee_id into v_mgr, v_emp from fixture;
  select id, stock_qty into v_cem, v_stock_before
    from public.products where sku = 'CEM-425-50';

  -- A drawer nobody is counting refuses to pay out: close anything open,
  -- then try a cash refund with no session.
  update public.cash_sessions set closed_at = now() where closed_at is null;

  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(jsonb_build_object(
      'product_id', v_cem, 'qty', 3, 'discount_amount', 0.01)),
    p_payment_method => 'cash');
  select * into v_li from public.sale_items where sale_id = v_sale.id;
  perform assert_eq(v_li.line_total, 344.99::numeric,
    'the fixture line carries an uneven total so the cents matter');

  -- Not assert_refuses: with the guard deleted this still fails, but on
  -- cash_movements' not-null session — a lucky crash, not a rule. The DESIGNED
  -- refusal names the drawer, so the message is what proves the guard exists.
  begin
    perform public.pos_return_sale(v_tok, '1234', v_sale.id,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_li.id, 'qty', 1)),
      'no drawer open');
    raise exception 'FAILED: a cash refund with no till session open — it was allowed';
  exception when others then
    if sqlerrm not like '%till session open%' then
      raise exception 'FAILED: the no-session refusal is the deliberate one — got: %', sqlerrm;
    end if;
  end;

  perform public.pos_cash_session_open(v_tok, '1234', 500);

  -- Guards that hold regardless of the drawer.
  perform assert_refuses(
    format('select public.pos_return_sale(%L, %L, %L, %L::jsonb, %L)',
      v_tok, '2222', v_sale.id,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_li.id, 'qty', 1)),
      'not my right'),
    'a counter PIN without void_refund cannot take a return');
  perform assert_refuses(
    format('select public.pos_return_sale(%L, %L, %L, %L::jsonb, %L)',
      v_tok, '1234', v_sale.id,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_li.id, 'qty', 1)),
      '  '),
    'a return with no reason');
  perform assert_refuses(
    format('select public.pos_return_sale(%L, %L, %L, %L::jsonb, %L)',
      v_tok, '1234', v_sale.id,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_li.id, 'qty', 0.5)),
      'half a bag'),
    'whole-unit goods come back whole');
  perform assert_refuses(
    format('select public.pos_return_sale(%L, %L, %L, %L::jsonb, %L)',
      v_tok, '1234', v_sale.id,
      jsonb_build_array(
        jsonb_build_object('sale_item_id', v_li.id, 'qty', 1),
        jsonb_build_object('sale_item_id', v_li.id, 'qty', 1)),
      'twice in one note'),
    'the same line cannot appear twice on one credit note');

  -- First partial: 1 of 3, back to the shelf. Rounded per unit: 115.00.
  select * into r1 from public.pos_return_sale(v_tok, '1234', v_sale.id,
    jsonb_build_array(jsonb_build_object(
      'sale_item_id', v_li.id, 'qty', 1, 'restock', true)),
    'burst bag');
  perform assert(r1.doc_number like 'CRN-%', 'the credit note is numbered CRN-');
  perform assert_eq(r1.refund_method, 'cash', 'a cash sale refunds cash');
  perform assert_eq(r1.total, 115.00::numeric, 'a third of R344.99, rounded');
  perform assert_eq(
    (select stock_qty from public.products where id = v_cem),
    v_stock_before - 3 + 1, 'one bag is back on the shelf');
  perform assert_eq(
    (select count(*)::int from public.cash_movements
      where kind = 'pay_out' and amount = 115.00
        and reason like 'Refund ' || r1.doc_number || '%'),
    1, 'the cash left the drawer as a recorded pay-out');
  -- Not "the latest row": everything here shares one transaction timestamp,
  -- so recency is a coin toss. The claim is that a movement with the honest
  -- reason exists, and gained exactly one bag.
  perform assert_eq(
    (select count(*)::int from public.stock_movements sm
      where sm.product_id = v_cem and sm.reason::text = 'return'
        and sm.qty_delta = 1),
    1, 'the shelf knows WHY it gained a bag');

  -- Second partial, damaged: recorded, refunded, never on the shelf.
  select * into r2 from public.pos_return_sale(v_tok, '1234', v_sale.id,
    jsonb_build_array(jsonb_build_object(
      'sale_item_id', v_li.id, 'qty', 1, 'restock', false)),
    'bag torn in the bakkie');
  perform assert_eq(r2.total, 115.00::numeric, 'same arithmetic for the second');
  perform assert_eq(
    (select stock_qty from public.products where id = v_cem),
    v_stock_before - 3 + 1, 'a damaged bag never reaches the count');

  -- The last of the line refunds EXACTLY what remains: 344.99 - 230.00.
  select * into r3 from public.pos_return_sale(v_tok, '1234', v_sale.id,
    jsonb_build_array(jsonb_build_object(
      'sale_item_id', v_li.id, 'qty', 1, 'restock', true)),
    'changed his mind');
  perform assert_eq(r3.total, 114.99::numeric,
    'the last return pays out the remainder to the cent — no drift, no invention');

  -- And now the line is spent.
  perform assert_refuses(
    format('select public.pos_return_sale(%L, %L, %L, %L::jsonb, %L)',
      v_tok, '1234', v_sale.id,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_li.id, 'qty', 1)),
      'greedy'),
    'a fourth bag cannot come back off a sale of three');

  -- The listing carries what the screen needs: every credit note, per line.
  perform assert_eq(
    (select count(*)::int from public.pos_sale_returns(v_tok, '1234', v_sale.id)),
    3, 'three credit notes, one line each, all listed');
  perform assert_eq(
    (select sum(item_qty)::numeric from public.pos_sale_returns(v_tok, '1234', v_sale.id)
      where sale_item_id = v_li.id),
    3::numeric, 'and they sum to what the stepper must subtract');

  -- 0047: the cash-up counts them as refunds, not only as pay-outs, so
  -- "Sales" less "Refunds" is what the shop actually took.
  v_fig := public.pos_cash_session_current(v_tok, '1234') -> 'figures';
  perform assert_eq((v_fig->>'refunds_count')::int, 3, 'the cash-up counts the refunds');
  perform assert_eq((v_fig->>'refunds_total')::numeric, 344.99::numeric,
    'and their total is what went back');

  -- A voided sale has nothing left to return.
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_cem, 'qty', 1)),
    p_payment_method => 'cash');
  perform public.pos_void_sale(v_sale.id, v_tok, '1234', 'mistake');
  select * into v_li from public.sale_items where sale_id = v_sale.id;
  perform assert_refuses(
    format('select public.pos_return_sale(%L, %L, %L, %L::jsonb, %L)',
      v_tok, '1234', v_sale.id,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_li.id, 'qty', 1)),
      'after the void'),
    'a voided sale takes no return');

  -- An account sale refunds the account — the customer never handed over
  -- cash, so none is handed back. The balance falls through the ONE function
  -- everything reads.
  select id into v_cust from public.customers limit 1;
  update public.customers set credit_limit = 100000 where id = v_cust;
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_cem, 'qty', 2)),
    p_payment_method => 'account', p_customer_id => v_cust);
  select * into v_li from public.sale_items where sale_id = v_sale.id;
  v_bal := public.customer_balance(v_cust);

  select * into r1 from public.pos_return_sale(v_tok, '1234', v_sale.id,
    jsonb_build_array(jsonb_build_object(
      'sale_item_id', v_li.id, 'qty', 1, 'restock', true)),
    'wrong grade');
  perform assert_eq(r1.refund_method, 'account',
    'an account sale credits the account');
  perform assert_eq(public.customer_balance(v_cust), v_bal - r1.total,
    'and the customer owes exactly that much less');
end $$;


-- 0049: reports ----------------------------------------------------------------
--
-- The whole shop for a window, sales by department with margin, VAT by
-- month, and an export a spreadsheet can open. All behind view_reports.

do $$
declare
  v_tok text; v_mgr uuid; v_emp uuid; v_cust uuid; v_cem uuid; v_price numeric;
  v_sale public.sales; v_li public.sale_items; v_day jsonb; v_dep jsonb; v_vat jsonb; v_exp jsonb;
  v_from timestamptz; v_to timestamptz; v_closed jsonb; v_expected numeric;
begin
  select token into v_tok from till;
  select manager_id, employee_id into v_mgr, v_emp from fixture;
  select id, price_retail into v_cem, v_price from public.products where sku = 'CEM-425-50';
  update public.products set cost = 80 where id = v_cem;
  -- Leftover drawers are shut a second before the window so they are not
  -- counted as this day's tills.
  update public.cash_sessions set closed_at = now() - interval '1 second' where closed_at is null;
  -- now() is this block's transaction time: earlier blocks' sales sit before
  -- it, this block's land exactly on it.
  v_from := now();
  v_to := now() + interval '1 hour';

  -- A day: a drawer opened on R500, a cash bag and a card bag of cement, a
  -- debtor paying R75 by card, one bag back for cash, then the close with the
  -- card machine R10 over and R300 banked.
  perform public.pos_cash_session_open(v_tok, '1234', 500);
  v_sale := public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_cem, 'qty', 1)),
    p_payment_method => 'cash',
    p_payments => jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', v_price)));
  perform public.pos_create_sale(
    p_register_token => v_tok, p_cashier_id => v_mgr,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_cem, 'qty', 1)),
    p_payment_method => 'card',
    p_payments => jsonb_build_array(jsonb_build_object('method', 'card', 'amount', v_price)));
  select id into v_cust from public.customers limit 1;
  if v_cust is not null then
    perform public.pos_take_account_payment(v_tok, v_mgr, v_cust, 75, 'card', 'batch 9', null, null);
  end if;
  select * into v_li from public.sale_items where sale_id = v_sale.id;
  perform public.pos_return_sale(v_tok, '1234', v_sale.id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_li.id, 'qty', 1)), 'wrong size');
  v_expected := 500 + v_price - v_price;  -- cash in, cash back out
  v_closed := public.pos_cash_session_close(v_tok, '1234', v_expected, null,
    p_card_counted => v_price + coalesce(case when v_cust is null then 0 else 75 end, 0) + 10,
    p_banked => 200);

  -- The whole shop, in one answer.
  v_day := public.pos_day_close(v_tok, '1234', v_from, v_to);
  perform assert_eq((v_day->'totals'->>'sales_count')::int, 2, 'the day counts both sales');
  perform assert_eq((v_day->'totals'->>'sales_total')::numeric, 2 * v_price, 'and adds them up');
  perform assert_eq((v_day->'totals'->>'refunds_total')::numeric, v_price, 'and nets the refund');
  perform assert_eq((v_day->'totals'->'tenders'->>'card')::numeric, v_price, 'card takings by tender');
  perform assert_eq((v_day->'totals'->>'cash_variance')::numeric, 0::numeric, 'the drawer balanced');
  perform assert_eq((v_day->'totals'->>'card_variance')::numeric, 10::numeric, 'the card machine was R10 over');
  perform assert_eq((v_day->'totals'->>'banked')::numeric, 200::numeric, 'and R200 went to the bank');
  perform assert_eq((v_day->'totals'->>'sessions_open')::int, 0, 'no drawer left open');
  perform assert_eq(jsonb_array_length(v_day->'sessions'), 1, 'one till had a drawer');
  perform assert((v_day->'sessions'->0) ? 'register_name', 'named by its till');

  -- Sales by department: two bags at v_price incl VAT, costing 80 each.
  v_dep := public.pos_sales_by_department(v_tok, '1234', v_from, v_to);
  perform assert_eq(jsonb_array_length(v_dep), 1, 'one department sold');
  perform assert_eq((v_dep->0->>'lines')::int, 2, 'two lines');
  perform assert_eq((v_dep->0->>'sales')::numeric, 2 * v_price, 'sales incl VAT');
  perform assert_eq((v_dep->0->>'cost')::numeric, 160::numeric, 'cost from cost_at_sale');
  perform assert_eq((v_dep->0->>'margin')::numeric,
    round(2 * v_price - 2 * round(v_price - v_price / 1.15, 2) - 160, 2),
    'margin is ex VAT less cost');
  perform assert_eq((v_dep->0->>'uncosted_lines')::int, 0, 'every line had a cost');

  -- VAT by month: this month carries the two sales and the credit note.
  v_vat := public.pos_vat_by_month(v_tok, '1234', 3);
  perform assert(jsonb_array_length(v_vat) >= 1, 'this month is listed');
  perform assert_eq(v_vat->0->>'month', to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM'),
    'newest month first');
  perform assert((v_vat->0->>'gross')::numeric >= 2 * v_price, 'gross includes the sales');
  perform assert((v_vat->0->>'refunds')::numeric >= v_price, 'and the credit note');
  perform assert_eq((v_vat->0->>'vat_due')::numeric,
    (v_vat->0->>'vat')::numeric - (v_vat->0->>'refunds_vat')::numeric,
    'VAT due nets the credit notes');

  -- Export: one row per line, carrying the cost the line was sold at.
  v_exp := public.pos_export_sales(v_tok, '1234', v_from, v_to);
  perform assert_eq(jsonb_array_length(v_exp), 2, 'one row per line');
  perform assert_eq((v_exp->0->>'cost_at_sale')::numeric, 80::numeric, 'with its cost at sale');
  perform assert(v_exp->0->>'doc_number' like 'INV-%', 'and its invoice number');

  -- Behind the permission, all four.
  perform assert_refuses(
    format('select public.pos_day_close(%L, %L, now() - interval ''1 day'', now())', v_tok, '5678'),
    'a cashier cannot read the day close');
  perform assert_refuses(
    format('select public.pos_export_sales(%L, %L, now() - interval ''1 day'', now())', v_tok, '5678'),
    'nor export the sales');
  perform assert_refuses(
    format('select public.pos_day_close(%L, %L, now(), now() - interval ''1 day'')', v_tok, '1234'),
    'a range the wrong way round');
end $$;

select 'all database tests passed' as result;
