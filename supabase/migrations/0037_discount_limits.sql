-- Who may give money away, and how much of it.
--
-- Until now a discount was one bit: you could apply one or you could not, and
-- any discount at all from anybody without approve_discount parked the sale for
-- a manager. That is too blunt in both directions. A counter hand cannot knock
-- R5 off a R900 sale to close it without fetching somebody, and an owner has no
-- way at all to say "never sell the cement more than 5% off" — once you can
-- approve, you can approve anything.
--
-- So there are two ceilings, and they are deliberately different kinds of
-- thing:
--
--   A STAFF LIMIT is soft. It is how far this person may go on their own say-so
--   — "Amir may give up to 10%, or R200, whichever is less". Within it the sale
--   completes and nobody is fetched. Past it the sale parks for approval
--   exactly as it does today. Nothing is refused; the limit only decides
--   whether a manager has to be asked.
--
--   AN ITEM CAP is hard. It is the shop's own floor on a line — "never more
--   than 5% off a bag of cement" — and it refuses. Not park: refuse. It binds
--   the owner as much as the newest counter hand, because that is the whole
--   point of setting one. If it could be approved away it would be advice.
--
-- Which is why the limit is on the person and the cap is on the product. To
-- rein in a manager who can approve their own discounts, the owner caps the
-- items; there is no third mechanism, and no state where two ceilings on the
-- same person disagree.
--
-- THE ITEM CAP IS MEASURED ON WHAT THE LINE ACTUALLY LOSES. A discount reaches
-- a line two ways — its own, and its pro-rata share of a sale-level one — and a
-- cap that only watched the first could be walked straight around by taking the
-- money off the whole sale instead. So the check is: line gross, minus what the
-- line settles at, must not exceed the cap. Both routes counted, once.
--
-- Both cap figures scale with quantity, which is why the rand one is PER UNIT.
-- "R2 off a bag" on ten bags is R20, the same shape as "5% off" on ten bags.
-- A flat per-line rand cap would mean the cap tightened the more you bought,
-- which is the opposite of what anyone setting it intends.

alter table public.app_users
  add column if not exists discount_limit_percent numeric(5,2)
    check (discount_limit_percent is null
           or (discount_limit_percent > 0 and discount_limit_percent <= 100)),
  add column if not exists discount_limit_amount numeric(12,2)
    check (discount_limit_amount is null or discount_limit_amount > 0);

comment on column public.app_users.discount_limit_percent is
  'How much of a sale this person may discount on their own authority, as a '
  'percent of the gross subtotal. Null means none — every discount goes for '
  'approval, which is how the shop behaved before limits existed.';
comment on column public.app_users.discount_limit_amount is
  'The same authority expressed in rand, per sale. Where both are set the '
  'tighter one binds.';

alter table public.products
  add column if not exists max_discount_percent numeric(5,2)
    check (max_discount_percent is null
           or (max_discount_percent >= 0 and max_discount_percent <= 100)),
  add column if not exists max_discount_amount numeric(12,2)
    check (max_discount_amount is null or max_discount_amount >= 0);

comment on column public.products.max_discount_percent is
  'The most that may ever come off this line, as a percent of what it sells '
  'for. Refuses rather than parks, and binds every role. Null means uncapped.';
comment on column public.products.max_discount_amount is
  'The same ceiling in rand, PER UNIT — multiplied by the quantity sold, so it '
  'behaves like the percentage does. Where both are set the tighter binds.';

-- ------------------------------------------------------------------ sale ---

create or replace function public.pos_create_sale(
  p_register_token text, p_cashier_id uuid, p_items jsonb,
  p_customer_id uuid default null, p_payment_method text default 'cash',
  p_discount_amount numeric default 0, p_discount_reason text default null,
  p_approved_by uuid default null, p_amount_tendered numeric default null,
  p_paid_cash numeric default null, p_paid_card numeric default null,
  p_client_ref uuid default null, p_created_at timestamptz default null,
  p_note text default null, p_payments jsonb default null,
  p_po_number text default null, p_customer_vat_number text default null
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_approver public.app_users;
  v_customer public.customers; v_trade boolean := false; v_item jsonb;
  v_product public.products; v_unit public.units_of_measure;
  v_qty numeric(14,3); v_price numeric(12,2); v_subtotal numeric(12,2) := 0;
  v_total numeric(12,2); v_tax_total numeric(12,2) := 0; v_status sale_status;
  v_sale public.sales; v_line numeric(12,2); v_share numeric(12,2);
  v_rate numeric(6,4); v_existing public.sales; v_available numeric;
  v_at timestamptz; v_payments jsonb; v_pay jsonb;
  v_cash numeric(12,2) := 0; v_non_cash numeric(12,2) := 0;
  v_account numeric(12,2) := 0; v_paid numeric(12,2) := 0;
  v_rounding numeric(12,2) := 0; v_methods text[]; v_summary text;
  v_line_disc numeric(12,2); v_line_pct numeric(6,3);
  v_items_disc numeric(12,2) := 0; v_net_subtotal numeric(12,2) := 0;
  v_all_disc numeric(12,2);
  -- The two ceilings. v_cap is the item's, v_own_cap is the cashier's.
  v_cap numeric(12,2); v_taken numeric(12,2); v_own_cap numeric(12,2);
begin
  v_reg := public.register_by_token(p_register_token);
  perform public.register_touch(v_reg.id);

  if p_client_ref is not null then
    select * into v_existing from public.sales where client_ref = p_client_ref;
    if found then return v_existing; end if;
  end if;

  select * into v_user from public.app_users
   where id = p_cashier_id and org_id = v_reg.org_id and active;
  if not found then raise exception 'Unknown cashier'; end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers
     where id = p_customer_id and org_id = v_reg.org_id;
    if not found then raise exception 'Unknown customer'; end if;
    v_trade := v_customer.is_trade;
  end if;

  v_at := coalesce(p_created_at, now());

  v_payments := p_payments;
  if v_payments is null or jsonb_array_length(v_payments) = 0 then
    if coalesce(p_paid_cash, 0) > 0 or coalesce(p_paid_card, 0) > 0 then
      v_payments := '[]'::jsonb;
      if coalesce(p_paid_cash, 0) > 0 then
        v_payments := v_payments || jsonb_build_array(
          jsonb_build_object('method', 'cash', 'amount', p_paid_cash));
      end if;
      if coalesce(p_paid_card, 0) > 0 then
        v_payments := v_payments || jsonb_build_array(
          jsonb_build_object('method', 'card', 'amount', p_paid_card));
      end if;
    else
      v_payments := jsonb_build_array(
        jsonb_build_object('method', coalesce(p_payment_method, 'cash'), 'amount', null));
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
     where id = (v_item->>'product_id')::uuid and org_id = v_reg.org_id and active
     for update;
    if not found then raise exception 'Product not available'; end if;
    select * into v_unit from public.units_of_measure where code = v_product.unit_code;
    v_qty := (v_item->>'qty')::numeric;
    if v_qty <= 0 then raise exception 'Invalid quantity for %', v_product.name; end if;
    if not v_unit.allows_fraction and v_qty <> trunc(v_qty) then
      raise exception '% is sold per % and cannot be split', v_product.name, v_unit.name;
    end if;
    if v_product.stock_qty is not null and v_product.stock_qty < v_qty then
      raise exception 'Not enough stock for % (% % on hand)',
        v_product.name, v_product.stock_qty, v_product.unit_code;
    end if;
    v_price := public.price_for(v_product, v_trade);
    v_line := round(v_price * v_qty, 2);

    -- The line's own discount. A percentage is resolved here rather than
    -- trusted from the client: the till and the database must not be able to
    -- disagree about what 10% of a line comes to.
    v_line_pct := nullif(v_item->>'discount_percent', '')::numeric;
    if v_line_pct is not null then
      if v_line_pct <= 0 or v_line_pct > 100 then
        raise exception 'A line discount of %%% is not a discount', v_line_pct;
      end if;
      v_line_disc := round(v_line * v_line_pct / 100, 2);
    else
      v_line_disc := round(coalesce(nullif(v_item->>'discount_amount', '')::numeric, 0), 2);
    end if;
    if v_line_disc < 0 then raise exception 'A discount cannot be negative'; end if;
    if v_line_disc > v_line then
      raise exception 'Discount on % is more than the line comes to', v_product.name;
    end if;

    v_subtotal := v_subtotal + v_line;
    v_items_disc := v_items_disc + v_line_disc;
  end loop;

  if v_subtotal <= 0 then raise exception 'Empty sale'; end if;

  -- What the lines come to once their own discounts are off. The sale-level
  -- discount is measured against THIS, not the gross: taking 10% off the lot
  -- after already taking 10% off the ladder means 10% of what is left.
  v_net_subtotal := v_subtotal - v_items_disc;
  if p_discount_amount > v_net_subtotal then
    raise exception 'Discount exceeds the sale total';
  end if;

  v_all_disc := round(v_items_disc + p_discount_amount, 2);
  v_total := v_subtotal - v_all_disc;

  -- The item caps, checked before anything is written and before anybody is
  -- asked to approve — because no approval gets past them. What is measured is
  -- everything the line loses: its own discount plus its share of the sale's,
  -- which is exactly (gross − what it settles at).
  if v_all_disc > 0 then
    for v_item in select * from jsonb_array_elements(p_items) loop
      select * into v_product from public.products
       where id = (v_item->>'product_id')::uuid;
      continue when v_product.max_discount_percent is null
                and v_product.max_discount_amount is null;

      v_qty := (v_item->>'qty')::numeric;
      v_line := round(public.price_for(v_product, v_trade) * v_qty, 2);
      v_line_pct := nullif(v_item->>'discount_percent', '')::numeric;
      if v_line_pct is not null then
        v_line_disc := round(v_line * v_line_pct / 100, 2);
      else
        v_line_disc := round(coalesce(nullif(v_item->>'discount_amount', '')::numeric, 0), 2);
      end if;
      v_share := case
        when v_net_subtotal > 0
          then round((v_line - v_line_disc) * v_total / v_net_subtotal, 2)
        else 0 end;
      v_taken := v_line - v_share;

      -- least() ignores nulls, so an unset half of the cap does not bind.
      v_cap := least(
        case when v_product.max_discount_percent is not null
             then round(v_line * v_product.max_discount_percent / 100, 2) end,
        case when v_product.max_discount_amount is not null
             then round(v_product.max_discount_amount * v_qty, 2) end);

      -- A cent of tolerance: the pro-rata share is rounded per line, so an
      -- exactly-at-the-cap discount can land a cent over through no fault of
      -- whoever gave it.
      if v_taken > v_cap + 0.005 then
        raise exception
          '% is capped at % off and this sale takes % off it. Lower the discount.',
          v_product.name, to_char(v_cap, 'FM999999990.00'),
          to_char(v_taken, 'FM999999990.00');
      end if;
    end loop;
  end if;

  -- Who says this discount may happen.
  --
  -- Three ways it is allowed, in the order they are looked for: the cashier can
  -- approve discounts themselves; a manager stood at the till and approved it;
  -- or it is inside the standing limit the shop has already given this person,
  -- in which case nobody is fetched and approved_by stays null — correctly, as
  -- nobody was asked. Failing all three the sale parks, exactly as before.
  v_status := 'completed';
  if v_all_disc > 0 then
    if 'approve_discount' = any(public.effective_permissions(v_user)) then
      v_approver := v_user;
    elsif p_approved_by is not null then
      select * into v_approver from public.app_users
       where id = p_approved_by and org_id = v_reg.org_id and active;
      if not found
         or not ('approve_discount' = any(public.effective_permissions(v_approver)))
      then v_approver := null; end if;
    end if;

    if v_approver.id is null then
      v_own_cap := least(
        case when v_user.discount_limit_percent is not null
             then round(v_subtotal * v_user.discount_limit_percent / 100, 2) end,
        v_user.discount_limit_amount);
      if v_own_cap is null or v_all_disc > v_own_cap + 0.005 then
        v_status := 'pending_approval';
      end if;
    end if;
  end if;

  for v_pay in select * from jsonb_array_elements(v_payments) loop
    if (v_pay->>'amount') is null then continue; end if;
    if (v_pay->>'method') = 'cash' then
      v_cash := v_cash + (v_pay->>'amount')::numeric;
    else
      v_non_cash := v_non_cash + (v_pay->>'amount')::numeric;
      if (v_pay->>'method') = 'account' then
        v_account := v_account + (v_pay->>'amount')::numeric;
      end if;
    end if;
  end loop;
  v_paid := v_cash + v_non_cash;

  if exists (select 1 from jsonb_array_elements(v_payments) e
              where e->>'method' = 'cash')
  then
    v_rounding := public.cash_rounding(v_total - v_non_cash);
  end if;

  if v_status = 'completed' and v_paid > 0
     and abs(v_paid - (v_total + v_rounding)) > 0.005 then
    raise exception 'Payments of % do not settle % (rounding %)',
      v_paid, v_total, v_rounding;
  end if;

  if v_account > 0 and v_status = 'completed' then
    if p_customer_id is null then raise exception 'An account sale needs a customer'; end if;
    v_available := public.customer_available_credit(p_customer_id);
    if v_available is not null and v_account > v_available then
      raise exception 'Over credit limit: % available', round(v_available, 2);
    end if;
  end if;
  if p_payment_method = 'account' and p_customer_id is null then
    raise exception 'An account sale needs a customer';
  end if;

  select array_agg(distinct e->>'method') into v_methods
    from jsonb_array_elements(v_payments) e;
  v_summary := case
    when v_methods is null or array_length(v_methods, 1) = 0 then coalesce(p_payment_method, 'cash')
    when array_length(v_methods, 1) = 1 then v_methods[1]
    else 'mixed' end;

  insert into public.sales(
    org_id, doc_number, cashier_id, cashier_name, customer_id, customer_name,
    trade_pricing, subtotal, discount_amount, discount_reason, tax_amount,
    total, status, payment_method, amount_tendered, change_due, paid_cash,
    paid_card, client_ref, note, register_id, created_at, approved_by,
    approved_by_name, po_number, customer_vat_number, customer_address, rounding)
  values (
    v_reg.org_id,
    case when v_status = 'completed' then public.next_doc_number(v_reg.org_id, 'sale') end,
    v_user.id, v_user.name, p_customer_id, v_customer.name, v_trade,
    v_subtotal, v_all_disc, p_discount_reason, 0, v_total, v_status,
    v_summary::payment_method, p_amount_tendered,
    case when p_amount_tendered is not null
         then greatest(p_amount_tendered - greatest(v_cash, 0), 0) end,
    nullif(v_cash, 0), nullif(v_non_cash, 0), p_client_ref, p_note, v_reg.id, v_at,
    v_approver.id, v_approver.name,
    nullif(trim(coalesce(p_po_number, '')), ''),
    coalesce(nullif(trim(coalesce(p_customer_vat_number, '')), ''), v_customer.vat_number),
    v_customer.address,
    v_rounding)
  returning * into v_sale;

  for v_pay in select * from jsonb_array_elements(v_payments) loop
    if (v_pay->>'amount') is null then continue; end if;
    if round((v_pay->>'amount')::numeric, 2) = 0 then continue; end if;
    insert into public.sale_payments(org_id, sale_id, method, amount, reference)
    values (v_reg.org_id, v_sale.id, (v_pay->>'method')::payment_method,
            round((v_pay->>'amount')::numeric, 2), v_pay->>'reference');
  end loop;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
     where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::numeric;
    v_price := public.price_for(v_product, v_trade);
    v_line := round(v_price * v_qty, 2);

    v_line_pct := nullif(v_item->>'discount_percent', '')::numeric;
    if v_line_pct is not null then
      v_line_disc := round(v_line * v_line_pct / 100, 2);
    else
      v_line_disc := round(coalesce(nullif(v_item->>'discount_amount', '')::numeric, 0), 2);
    end if;

    -- The sale-level discount spreads across what is left of each line after
    -- its own discount, so a line already marked down does not take a second
    -- helping in proportion to a price it is no longer being sold at.
    v_share := case
      when v_net_subtotal > 0
        then round((v_line - v_line_disc) * v_total / v_net_subtotal, 2)
      else 0 end;

    v_rate := coalesce(public.tax_rate_at(v_product.tax_code, v_at::date), 0);
    insert into public.sale_items(sale_id, product_id, sku, name, unit_code,
      qty, unit_price, line_total, tax_code, tax_rate, tax_amount, cost_at_sale,
      discount_amount, discount_percent)
    values (v_sale.id, v_product.id, v_product.sku, v_product.name,
      v_product.unit_code, v_qty, v_price, v_share, v_product.tax_code, v_rate,
      round(v_share - (v_share / (1 + v_rate)), 2), v_product.cost,
      v_line_disc, v_line_pct);
  end loop;

  select coalesce(sum(tax_amount), 0) into v_tax_total
    from public.sale_items where sale_id = v_sale.id;
  update public.sales set tax_amount = v_tax_total where id = v_sale.id
    returning * into v_sale;

  if v_status = 'completed' then
    perform public.settle_stock_for_sale(v_sale.id, -1, 'sale', v_user);
  end if;
  return v_sale;
end;
$$;

-- ----------------------------------------------------------------- staff ---

-- The roster carries the limits, so the editor can show them without a second
-- round trip and the list can say at a glance who may discount what.
drop function if exists public.pos_admin_list_users(text, text);
create function public.pos_admin_list_users(
  p_register_token text,
  p_pin text
) returns table(id uuid, name text, phone text, role user_role, status text,
                active boolean, permissions text[],
                discount_limit_percent numeric, discount_limit_amount numeric)
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_admin public.app_users;
begin
  v_admin := public.user_with_perm(p_register_token, p_pin, 'manage_staff');
  return query
    select u.id, u.name, u.phone_e164, u.role, u.status, u.active, u.permissions,
           u.discount_limit_percent, u.discount_limit_amount
    from public.app_users u where u.org_id = v_admin.org_id
    order by u.role, u.name;
end;
$$;
grant execute on function public.pos_admin_list_users(text, text)
  to anon, authenticated;

-- Setting a limit is an ordinary staff edit, so it goes through the same guards
-- as a role change does. The two extra arguments follow the null-means-leave-
-- alone convention the rest of this function already uses; clearing a limit
-- needs a distinct signal, and 0 is it — no limit is ever legitimately zero,
-- since a zero limit and no limit are the same thing.
drop function if exists public.pos_admin_update_user(
  text, text, uuid, text, user_role, text[], boolean);
create function public.pos_admin_update_user(
  p_register_token text,
  p_pin text,
  p_user_id uuid,
  p_name text default null,
  p_role user_role default null,
  p_permissions text[] default null,
  p_active boolean default null,
  p_discount_limit_percent numeric default null,
  p_discount_limit_amount numeric default null
) returns table(id uuid, name text, phone text, role user_role, status text,
                active boolean, permissions text[],
                discount_limit_percent numeric, discount_limit_amount numeric)
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_admin public.app_users; v_target public.app_users; v_admins int;
begin
  v_admin := public.user_with_perm(p_register_token, p_pin, 'manage_staff');

  select * into v_target from public.app_users u
   where u.id = p_user_id and u.org_id = v_admin.org_id;
  if v_target.id is null then raise exception 'No such staff member'; end if;

  if v_target.id = v_admin.id
     and (p_active is false or (p_role is not null and p_role <> v_target.role)) then
    raise exception 'You cannot change your own role or sign yourself out';
  end if;

  if (v_target.role = 'admin' or p_role = 'admin') and v_admin.role <> 'admin' then
    raise exception 'Only an admin can change an admin';
  end if;

  if v_target.role = 'admin'
     and (p_active is false or (p_role is not null and p_role <> 'admin')) then
    select count(*) into v_admins from public.app_users u
     where u.org_id = v_admin.org_id and u.role = 'admin' and u.active;
    if v_admins <= 1 then
      raise exception 'This is the only admin left — promote someone else first';
    end if;
  end if;

  if p_name is not null and trim(p_name) = '' then
    raise exception 'A name is required';
  end if;

  if p_discount_limit_percent is not null
     and (p_discount_limit_percent < 0 or p_discount_limit_percent > 100) then
    raise exception 'A discount limit is a percentage between 0 and 100';
  end if;
  if p_discount_limit_amount is not null and p_discount_limit_amount < 0 then
    raise exception 'A discount limit cannot be negative';
  end if;

  update public.app_users u set
    name        = coalesce(nullif(trim(p_name), ''), u.name),
    role        = coalesce(p_role, u.role),
    permissions = coalesce(p_permissions, u.permissions),
    active      = coalesce(p_active, u.active),
    discount_limit_percent = case
      when p_discount_limit_percent is null then u.discount_limit_percent
      when p_discount_limit_percent = 0 then null
      else p_discount_limit_percent end,
    discount_limit_amount = case
      when p_discount_limit_amount is null then u.discount_limit_amount
      when p_discount_limit_amount = 0 then null
      else p_discount_limit_amount end
  where u.id = p_user_id;

  return query
    select u.id, u.name, u.phone_e164, u.role, u.status, u.active, u.permissions,
           u.discount_limit_percent, u.discount_limit_amount
      from public.app_users u where u.id = p_user_id;
end;
$$;
grant execute on function public.pos_admin_update_user(
  text, text, uuid, text, user_role, text[], boolean, numeric, numeric)
  to anon, authenticated;

-- --------------------------------------------------------------- product ---

-- The till needs the caps in its pocket, not on request: the discount dialog
-- has to say "the most you can take off this is R12" while it is being typed
-- into, and it has to do that with the shop's line down. So they ride the
-- catalogue, which is already cached on the device.
drop function if exists public.pos_catalogue(text);
create function public.pos_catalogue(p_register_token text)
returns table(id uuid, sku text, barcode text, name text, description text,
              category_id uuid, category_name text, unit_code text, unit_name text,
              allows_fraction boolean, price_retail numeric, price_trade numeric,
              tax_code text, stock_qty numeric, reorder_level numeric,
              image_url text, sort_order integer, bin text, image_count integer,
              max_discount_percent numeric, max_discount_amount numeric)
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select p.id, p.sku, p.barcode, p.name, p.description, p.category_id,
           c.name, p.unit_code, u.name, u.allows_fraction, p.price_retail,
           p.price_trade, p.tax_code, p.stock_qty, p.reorder_level,
           p.image_url, p.sort_order, p.bin,
           (select count(*)::int from public.product_images i
             where i.product_id = p.id),
           p.max_discount_percent, p.max_discount_amount
    from public.products p
    left join public.categories c on c.id = p.category_id
    join public.units_of_measure u on u.code = p.unit_code
    where p.org_id = v_reg.org_id and p.active
    order by p.sort_order, p.name;
end;
$$;
grant execute on function public.pos_catalogue(text) to anon, authenticated;

drop function if exists public.pos_admin_list_products(text, text);
create function public.pos_admin_list_products(p_register_token text, p_pin text)
returns table(id uuid, sku text, barcode text, name text, description text,
  category_id uuid, category_name text, unit_code text, price_retail numeric,
  price_trade numeric, cost numeric, tax_code text, stock_qty numeric,
  reorder_level numeric, active boolean, image_url text, bin text,
  max_discount_percent numeric, max_discount_amount numeric)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  return query
    select p.id, p.sku, p.barcode, p.name, p.description, p.category_id, c.name,
           p.unit_code, p.price_retail, p.price_trade, p.cost, p.tax_code,
           p.stock_qty, p.reorder_level, p.active, p.image_url, p.bin,
           p.max_discount_percent, p.max_discount_amount
    from public.products p
    left join public.categories c on c.id = p.category_id
    where p.org_id = v_user.org_id
    order by p.name;
end;
$$;
grant execute on function public.pos_admin_list_products(text, text)
  to anon, authenticated;

-- Saving the cap. Unlike the picture in 0027, null here means "clear it": the
-- product editor always sends both fields, empty boxes included, and a cap you
-- cannot remove by clearing the box is a trap.
--
-- Dropped rather than replaced. Two extra arguments make a new signature, and
-- `create or replace` would leave the old eighteen-argument version standing
-- beside it — an overload PostgREST would have to guess between.
drop function if exists public.pos_admin_save_product(text, text, uuid, text,
  text, text, text, uuid, text, numeric, numeric, numeric, text, numeric,
  numeric, boolean, text, text);
create function public.pos_admin_save_product(
  p_register_token text, p_pin text, p_id uuid, p_sku text, p_barcode text,
  p_name text, p_description text, p_category_id uuid, p_unit_code text,
  p_price_retail numeric, p_price_trade numeric, p_cost numeric,
  p_tax_code text, p_stock_qty numeric, p_reorder_level numeric,
  p_active boolean, p_image_url text default null, p_bin text default null,
  p_max_discount_percent numeric default null,
  p_max_discount_amount numeric default null
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_row public.products;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  if trim(coalesce(p_sku, '')) = '' then raise exception 'A stock code is required'; end if;
  if trim(coalesce(p_name, '')) = '' then raise exception 'A name is required'; end if;
  if p_price_retail is null or p_price_retail < 0 then
    raise exception 'A retail price is required';
  end if;
  if p_max_discount_percent is not null
     and (p_max_discount_percent < 0 or p_max_discount_percent > 100) then
    raise exception 'A discount cap is a percentage between 0 and 100';
  end if;
  if p_max_discount_amount is not null and p_max_discount_amount < 0 then
    raise exception 'A discount cap cannot be negative';
  end if;

  if p_id is null then
    insert into public.products(org_id, sku, barcode, name, description,
      category_id, unit_code, price_retail, price_trade, cost, tax_code,
      stock_qty, reorder_level, active, image_url, bin,
      max_discount_percent, max_discount_amount)
    values (v_user.org_id, trim(p_sku), nullif(trim(coalesce(p_barcode,'')),''),
      trim(p_name), p_description, p_category_id, p_unit_code, p_price_retail,
      p_price_trade, p_cost, coalesce(p_tax_code,'standard'), p_stock_qty,
      p_reorder_level, coalesce(p_active, true),
      nullif(trim(coalesce(p_image_url, '')), ''),
      nullif(trim(coalesce(p_bin,'')),''),
      p_max_discount_percent, p_max_discount_amount)
    returning * into v_row;
  else
    update public.products p set
      sku = trim(p_sku), barcode = nullif(trim(coalesce(p_barcode,'')),''),
      name = trim(p_name), description = p_description, category_id = p_category_id,
      unit_code = p_unit_code, price_retail = p_price_retail,
      price_trade = p_price_trade, cost = p_cost,
      tax_code = coalesce(p_tax_code,'standard'), stock_qty = p_stock_qty,
      reorder_level = p_reorder_level, active = coalesce(p_active, true),
      -- See the three-way rule at the top of 0027.
      image_url = case
                    when p_image_url is null then p.image_url
                    when trim(p_image_url) = '' then null
                    else p_image_url
                  end,
      bin = nullif(trim(coalesce(p_bin,'')),''),
      max_discount_percent = p_max_discount_percent,
      max_discount_amount = p_max_discount_amount,
      updated_at = now()
    where p.id = p_id and p.org_id = v_user.org_id
    returning * into v_row;
    if not found then raise exception 'Product not found'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.pos_admin_save_product(text, text, uuid, text,
  text, text, text, uuid, text, numeric, numeric, numeric, text, numeric,
  numeric, boolean, text, text, numeric, numeric) to anon, authenticated;

-- ----------------------------------------------------------------- login ---

-- The limit travels with the person at sign-in.
--
-- The till has to know it before the discount dialog opens, and it has to know
-- it with the line down — the device caches whatever pos_login returned, which
-- is the same cache that lets a cashier start a shift during an outage. So the
-- limit rides the login row rather than being fetched when it is needed.
--
-- A limit changed in the back office therefore reaches a tablet at that
-- person's next online sign-in, not instantly. That is the right side to err
-- on: the server checks again on every sale, so a stale cache can only make the
-- till ask for approval it did not need, never let a discount through that
-- should have been approved.
drop function if exists public.pos_login(text, uuid, text);
create function public.pos_login(
  p_register_token text, p_user_id uuid, p_pin text
) returns table(id uuid, name text, role user_role, phone text, email text,
                permissions text[], discount_limit_percent numeric,
                discount_limit_amount numeric)
language plpgsql volatile security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers; v_user public.app_users; v_recent int;
begin
  v_reg := public.register_by_token(p_register_token);

  select * into v_user from public.app_users u
   where u.id = p_user_id and u.org_id = v_reg.org_id
     and u.active and u.status = 'active' and u.pin_hash is not null;
  if v_user.id is null then return; end if;

  select count(*) into v_recent from public.login_attempts la
   where la.user_id = v_user.id and la.at > now() - interval '15 minutes';
  if v_recent >= 5 then
    raise exception 'Too many wrong PINs for %. Try again in 15 minutes.', v_user.name;
  end if;

  if v_user.pin_hash <> crypt(p_pin, v_user.pin_hash) then
    insert into public.login_attempts (org_id, user_id) values (v_user.org_id, v_user.id);
    return;
  end if;

  delete from public.login_attempts la where la.user_id = v_user.id;
  return query select v_user.id, v_user.name, v_user.role, v_user.phone_e164,
                      v_user.email, public.effective_permissions(v_user),
                      v_user.discount_limit_percent, v_user.discount_limit_amount;
end;
$$;
grant execute on function public.pos_login(text, uuid, text) to anon, authenticated;

drop function if exists public.pos_login(text, text);
create function public.pos_login(p_register_token text, p_pin text)
returns table(id uuid, name text, role user_role, phone text, email text,
              permissions text[], discount_limit_percent numeric,
              discount_limit_amount numeric)
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers; v_user public.app_users; v_matches int;
begin
  v_reg := public.register_by_token(p_register_token);

  select count(*) into v_matches from public.app_users u
   where u.org_id = v_reg.org_id and u.status = 'active' and u.active
     and u.pin_hash is not null and u.pin_hash = crypt(p_pin, u.pin_hash);
  if v_matches <> 1 then return; end if;

  select * into v_user from public.app_users u
   where u.org_id = v_reg.org_id and u.status = 'active' and u.active
     and u.pin_hash is not null and u.pin_hash = crypt(p_pin, u.pin_hash);
  return query select v_user.id, v_user.name, v_user.role, v_user.phone_e164,
                      v_user.email, public.effective_permissions(v_user),
                      v_user.discount_limit_percent, v_user.discount_limit_amount;
end;
$$;
grant execute on function public.pos_login(text, text) to anon, authenticated;
