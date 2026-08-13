-- Three things, all about what a figure on a screen actually means.
--
-- ------------------------------------------------------------------------
-- 1. A percent limit is a RATE, not a sum of money
-- ------------------------------------------------------------------------
--
-- 0037 gave a person "up to 10%, or R200". It then measured the percentage
-- against the whole sale and compared the total money off against it, which
-- turns a rate into an amount and loses the thing the rate was for.
--
-- The hole, with the shop's own numbers. A counter hand on 5% rings up R1,710
-- and takes 10% off one R714 line. That is R71.40 — under 5% of R1,710, which
-- is R85.50 — so it completed on his own authority. He gave 10% on a 5% limit
-- and nobody was asked. Worse at the extremes: 100% off a R50 item inside a
-- R5,000 sale is R50, under a 5% ceiling of R250, so a cashier could give a
-- thing away free without the till blinking.
--
-- So the two halves of a limit are two different kinds of ceiling, and each is
-- applied to the thing it is actually about:
--
--   THE PERCENT is a rate, and it holds on EVERY LINE. No line may lose more
--   than that share of what it sells for, however the discount reached it.
--
--   THE RAND is a ceiling on the SALE. The whole discount, lines and blanket
--   together, may not exceed it.
--
-- Either one exceeded and the sale goes for approval, exactly as before. It is
-- still soft: nothing is refused, a manager is simply asked.
--
-- The sale-level percentage check disappears rather than being kept alongside,
-- because it is implied: if no line loses more than 5%, the sale cannot lose
-- more than 5% either. One rule, checked in one place.
--
-- ------------------------------------------------------------------------
-- 2. Where to pay the shop
-- ------------------------------------------------------------------------
--
-- The till takes EFT, and the slip it printed gave the customer no account to
-- pay into. Somebody who walks out with an EFT invoice has to phone the shop to
-- find out where the money goes, which is the sort of friction that turns into
-- an unpaid invoice.
--
-- ------------------------------------------------------------------------
-- 3. The VAT rate the till shows
-- ------------------------------------------------------------------------
--
-- What is CHARGED has never been hardcoded: sale lines resolve
-- tax_rate_at(code, date) at the moment of sale and store the result, so the
-- rate is already a dated fact and a reprint restates what was actually
-- charged. Only the "VAT at 15%" the cashier reads on screen was a build
-- constant, which means the display and the charge could disagree the day a
-- new rate takes effect. So the rate is served with the rest of the shop's
-- settings, from the same table the sale uses.
--
-- Note what is NOT done here: the rate is not made editable per shop.
-- public.tax_rates has no org_id, because VAT is a national fact rather than a
-- shop's opinion of one — and a box on one shop's settings screen that silently
-- changed every other shop's invoices would be a bad way to find that out.
-- Moving the rate is a dated insert into that table when Treasury moves it.

alter table public.organizations
  add column if not exists email               text,
  add column if not exists bank_name           text,
  add column if not exists bank_account_name   text,
  add column if not exists bank_account_number text,
  add column if not exists bank_branch_code    text;

comment on column public.organizations.bank_account_name is
  'The name the account is held in, which is not always the trading name — a '
  'customer whose bank refuses the payee has no way to ask.';

drop function if exists public.pos_org_settings(text);
create function public.pos_org_settings(p_register_token text)
returns table(shop_name text, address_line1 text, address_line2 text,
              phone text, vat_number text, currency text,
              registration_number text, email text,
              bank_name text, bank_account_name text,
              bank_account_number text, bank_branch_code text,
              vat_rate numeric)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query select o.name, o.address_line1, o.address_line2, o.phone,
                      o.vat_number, o.currency, o.registration_number,
                      o.email, o.bank_name, o.bank_account_name,
                      o.bank_account_number, o.bank_branch_code,
                      -- The standard rate as it stands today, from the same
                      -- table pos_create_sale reads. The till displays this
                      -- rather than a figure compiled into the build, so the
                      -- number on screen cannot outlive the number charged.
                      coalesce(public.tax_rate_at('standard', current_date), 0)
    from public.organizations o where o.id = v_reg.org_id;
end;
$$;
grant execute on function public.pos_org_settings(text) to anon, authenticated;

create or replace function public.pos_admin_save_settings(
  p_register_token text, p_pin text, p_settings jsonb
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_settings');
  update public.organizations set
    name = coalesce(p_settings->>'shop_name', name),
    address_line1 = coalesce(p_settings->>'address_line1', address_line1),
    address_line2 = coalesce(p_settings->>'address_line2', address_line2),
    phone = coalesce(p_settings->>'phone', phone),
    vat_number = coalesce(p_settings->>'vat_number', vat_number),
    currency = coalesce(p_settings->>'currency', currency),
    registration_number = coalesce(p_settings->>'registration_number', registration_number),
    email = coalesce(p_settings->>'email', email),
    bank_name = coalesce(p_settings->>'bank_name', bank_name),
    bank_account_name = coalesce(p_settings->>'bank_account_name', bank_account_name),
    bank_account_number = coalesce(p_settings->>'bank_account_number', bank_account_number),
    bank_branch_code = coalesce(p_settings->>'bank_branch_code', bank_branch_code)
  where id = v_user.org_id;
end;
$$;
grant execute on function public.pos_admin_save_settings(text, text, jsonb)
  to anon, authenticated;

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
  -- The item's hard cap, and what the line ends up losing to all discounts.
  v_cap numeric(12,2); v_taken numeric(12,2);
  -- Whether this sale sits inside what the cashier may give unasked.
  v_within boolean;
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

  -- Both ceilings walk the lines together, because both need the same figure:
  -- what this line actually loses, its own discount plus its share of the
  -- sale's, which is exactly (gross − what it settles at). Neither can be
  -- walked around by choosing which kind of discount to give.
  --
  --   the item cap    refuses, whoever asks, approval or not
  --   the percent limit only decides whether a manager is fetched
  v_within := v_user.discount_limit_percent is not null
           or v_user.discount_limit_amount is not null;

  -- The rand half of the limit is a ceiling on the whole sale, so it is settled
  -- before the walk rather than inside it.
  if v_user.discount_limit_amount is not null
     and v_all_disc > v_user.discount_limit_amount + 0.005 then
    v_within := false;
  end if;

  if v_all_disc > 0 then
    for v_item in select * from jsonb_array_elements(p_items) loop
      select * into v_product from public.products
       where id = (v_item->>'product_id')::uuid;

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

      -- The percent limit, as a rate on this line. A cent of tolerance,
      -- because the pro-rata share is rounded per line.
      if v_within and v_user.discount_limit_percent is not null
         and v_taken > round(v_line * v_user.discount_limit_percent / 100, 2) + 0.005
      then
        v_within := false;
      end if;

      if v_product.max_discount_percent is null
         and v_product.max_discount_amount is null then
        continue;
      end if;

      -- least() ignores nulls, so an unset half of the cap does not bind.
      v_cap := least(
        case when v_product.max_discount_percent is not null
             then round(v_line * v_product.max_discount_percent / 100, 2) end,
        case when v_product.max_discount_amount is not null
             then round(v_product.max_discount_amount * v_qty, 2) end);

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
  -- nobody was asked. Failing all three the sale parks.
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

    if v_approver.id is null and not v_within then
      v_status := 'pending_approval';
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
