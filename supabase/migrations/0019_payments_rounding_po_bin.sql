-- Five things a real counter needs, learned from watching one work.
--
-- 1. CASH ROUNDING. South Africa stopped minting 1c, 2c and 5c coins, so a
--    cash total of R186.95 cannot be paid. Cash settles to the nearest 10c;
--    card, EFT and account settle to the exact cent. The invoice total stays
--    exact — VAT is computed on it — and the rounding is recorded separately
--    as the adjustment it is.
--
-- 2. MANY PAYMENTS PER SALE. R2 000 cash, the rest on card, R500 on account is
--    an ordinary builder's transaction. The old model held one method plus a
--    cash/card special case; this holds a list and settles when it covers the
--    total.
--
-- 3. PO NUMBER. Contractors buy against a purchase order and their bookkeeper
--    rejects an invoice without it on the face of the document.
--
-- 4. THE BUYER'S VAT NUMBER. SARS requires the recipient's name, address and
--    VAT registration number on a full tax invoice — mandatory above R5 000,
--    which an ordinary pump or a pallet of cement clears. Snapshotted onto the
--    sale rather than read from the customer at print time, because a reprint
--    two years later must restate what was true then.
--
-- 5. BIN LOCATION. In a shop with thousands of SKUs this is how a cashier
--    tells a customer which aisle to walk to.

-- ---------------------------------------------------------------- columns --

alter table public.products add column if not exists bin text;

alter table public.sales
  add column if not exists po_number text,
  add column if not exists customer_vat_number text,
  add column if not exists customer_address text,
  -- The cash-rounding adjustment applied at settlement. Positive means the
  -- customer paid up to the nearest 10c, negative means down.
  add column if not exists rounding numeric(12,2) not null default 0;

-- ------------------------------------------------------------- payments ---

create table if not exists public.sale_payments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  sale_id     uuid not null references public.sales(id) on delete cascade,
  method      payment_method not null,
  amount      numeric(12,2) not null check (amount <> 0),
  -- Card terminal slip number, EFT reference, Zapper transaction id: whatever
  -- the cashier must be able to quote when a customer disputes the charge.
  reference   text,
  created_at  timestamptz not null default now()
);

create index if not exists sale_payments_sale_idx on public.sale_payments(sale_id);
create index if not exists sale_payments_org_idx on public.sale_payments(org_id, created_at desc);

alter table public.sale_payments enable row level security;
-- No policies: reached only through the SECURITY DEFINER RPCs below, like
-- every other tenant table.

-- --------------------------------------------------------------- helpers --

/**
 * The cash-rounding adjustment for an amount that must be paid in coins.
 *
 * Nearest 10c, and an exact half rounds DOWN — in the customer's favour.
 * R187.05 in cash settles at R187.00, not R187.10: that is the convention South
 * African retail adopted when the 5c coin was withdrawn, and it is the one a
 * customer can check in their head without feeling cheated. The shop carries at
 * most 5c per cash sale for it.
 */
create or replace function public.cash_rounding(p_amount numeric)
returns numeric language sql immutable as $$
  select round(ceil(round(p_amount, 2) * 10 - 0.5) / 10, 2) - round(p_amount, 2);
$$;

-- ------------------------------------------------------------ the sale ----

drop function if exists public.pos_create_sale(text, uuid, jsonb, uuid, text,
  numeric, text, uuid, numeric, numeric, numeric, uuid, timestamptz, text);

create function public.pos_create_sale(
  p_register_token text, p_cashier_id uuid, p_items jsonb,
  p_customer_id uuid default null, p_payment_method text default 'cash',
  p_discount_amount numeric default 0, p_discount_reason text default null,
  p_approved_by uuid default null, p_amount_tendered numeric default null,
  p_paid_cash numeric default null, p_paid_card numeric default null,
  p_client_ref uuid default null, p_created_at timestamptz default null,
  p_note text default null,
  -- [{ "method": "cash", "amount": 186.90, "reference": null }, ...]
  p_payments jsonb default null,
  p_po_number text default null,
  p_customer_vat_number text default null
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
  v_non_cash numeric(12,2) := 0; v_cash numeric(12,2) := 0;
  v_account numeric(12,2) := 0; v_paid numeric(12,2) := 0;
  v_rounding numeric(12,2) := 0; v_methods text[]; v_summary text;
begin
  v_reg := public.register_by_token(p_register_token);

  -- Every lookup below carries "and org_id = v_reg.org_id". That clause is the
  -- tenant boundary; nothing else enforces it.
  select * into v_user from public.app_users
   where id = p_cashier_id and org_id = v_reg.org_id and active and status = 'active';
  if not found then raise exception 'Unknown cashier'; end if;
  if not ('take_payments' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted to take payments';
  end if;

  if p_client_ref is not null then
    select * into v_existing from public.sales
     where client_ref = p_client_ref and org_id = v_reg.org_id;
    if found then return v_existing; end if;
  end if;

  v_at := coalesce(p_created_at, now());
  if v_at > now() + interval '1 day' or v_at < now() - interval '30 days' then
    v_at := now();
  end if;

  if p_discount_amount < 0 then raise exception 'Discount cannot be negative'; end if;
  if jsonb_array_length(p_items) = 0 then raise exception 'Empty sale'; end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers
     where id = p_customer_id and org_id = v_reg.org_id and active;
    if not found then raise exception 'Unknown customer'; end if;
    v_trade := v_customer.is_trade;
  end if;

  -- A till queued before this release replays with the old parameters only, so
  -- the legacy shape is folded into the new one rather than rejected. An
  -- offline sale can be days old; it must never fail because we shipped.
  v_payments := p_payments;
  if v_payments is null then
    if p_paid_cash is not null or p_paid_card is not null then
      v_payments := jsonb_build_array(
        jsonb_build_object('method', 'cash', 'amount', coalesce(p_paid_cash, 0)),
        jsonb_build_object('method', 'card', 'amount', coalesce(p_paid_card, 0)));
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
    v_subtotal := v_subtotal + round(v_price * v_qty, 2);
  end loop;

  if v_subtotal <= 0 then raise exception 'Empty sale'; end if;
  if p_discount_amount > v_subtotal then raise exception 'Discount exceeds the sale total'; end if;
  v_total := v_subtotal - p_discount_amount;

  v_status := 'completed';
  if p_discount_amount > 0 then
    if 'approve_discount' = any(public.effective_permissions(v_user)) then
      v_approver := v_user;
    elsif p_approved_by is not null then
      select * into v_approver from public.app_users
       where id = p_approved_by and org_id = v_reg.org_id and active;
      if not found
         or not ('approve_discount' = any(public.effective_permissions(v_approver)))
      then v_approver := null; end if;
    end if;
    if v_approver.id is null then v_status := 'pending_approval'; end if;
  end if;

  -- Tally the tenders. A null amount means "whatever is left", which is how a
  -- legacy single-method sale arrives.
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

  -- Coins: only the part actually settled in cash gets rounded, and only when
  -- there is a cash part at all.
  if exists (select 1 from jsonb_array_elements(v_payments) e
              where e->>'method' = 'cash')
  then
    v_rounding := public.cash_rounding(v_total - v_non_cash);
  end if;

  -- A completed sale must be fully covered. Pending ones are not paid yet, and
  -- a legacy replay carries no amounts to check.
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
    v_subtotal, p_discount_amount, p_discount_reason, 0, v_total, v_status,
    v_summary::payment_method, p_amount_tendered,
    case when p_amount_tendered is not null
         then greatest(p_amount_tendered - greatest(v_cash, 0), 0) end,
    nullif(v_cash, 0), nullif(v_non_cash, 0), p_client_ref, p_note, v_reg.id, v_at,
    v_approver.id, v_approver.name,
    nullif(trim(coalesce(p_po_number, '')), ''),
    -- The buyer's VAT number: what the cashier typed wins, otherwise the
    -- account's own. Snapshotted either way.
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
    v_share := case when v_subtotal > 0 then round(v_line * v_total / v_subtotal, 2) else 0 end;
    v_rate := coalesce(public.tax_rate_at(v_product.tax_code, v_at::date), 0);
    insert into public.sale_items(sale_id, product_id, sku, name, unit_code,
      qty, unit_price, line_total, tax_code, tax_rate, tax_amount, cost_at_sale)
    values (v_sale.id, v_product.id, v_product.sku, v_product.name,
      v_product.unit_code, v_qty, v_price, v_share, v_product.tax_code, v_rate,
      round(v_share - (v_share / (1 + v_rate)), 2), v_product.cost);
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

grant execute on function public.pos_create_sale(text, uuid, jsonb, uuid, text,
  numeric, text, uuid, numeric, numeric, numeric, uuid, timestamptz, text,
  jsonb, text, text) to anon, authenticated;

-- What was actually tendered, for a reprint or a dispute.
create or replace function public.pos_sale_payments(p_register_token text, p_sale_id uuid)
returns table(method payment_method, amount numeric, reference text, created_at timestamptz)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select sp.method, sp.amount, sp.reference, sp.created_at
    from public.sale_payments sp
    join public.sales s on s.id = sp.sale_id
    where sp.sale_id = p_sale_id and s.org_id = v_reg.org_id
    order by sp.created_at;
end;
$$;

grant execute on function public.pos_sale_payments(text, uuid) to anon, authenticated;

-- ------------------------------------------------------------ catalogue ---

drop function if exists public.pos_catalogue(text);
create function public.pos_catalogue(p_register_token text)
returns table(id uuid, sku text, barcode text, name text, description text,
  category_id uuid, category_name text, unit_code text, unit_name text,
  allows_fraction boolean, price_retail numeric, price_trade numeric,
  tax_code text, stock_qty numeric, reorder_level numeric, image_url text,
  sort_order int, bin text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select p.id, p.sku, p.barcode, p.name, p.description, p.category_id,
           c.name, p.unit_code, u.name, u.allows_fraction, p.price_retail,
           p.price_trade, p.tax_code, p.stock_qty, p.reorder_level,
           p.image_url, p.sort_order, p.bin
    from public.products p
    left join public.categories c on c.id = p.category_id
    join public.units_of_measure u on u.code = p.unit_code
    where p.org_id = v_reg.org_id and p.active
    order by p.sort_order, p.name;
end;
$$;
grant execute on function public.pos_catalogue(text) to anon, authenticated;

-- ---------------------------------------------------------------- admin ---

drop function if exists public.pos_admin_save_product(text, text, uuid, text,
  text, text, text, uuid, text, numeric, numeric, numeric, text, numeric,
  numeric, boolean, text);

create function public.pos_admin_save_product(
  p_register_token text, p_pin text, p_id uuid, p_sku text, p_barcode text,
  p_name text, p_description text, p_category_id uuid, p_unit_code text,
  p_price_retail numeric, p_price_trade numeric, p_cost numeric,
  p_tax_code text, p_stock_qty numeric, p_reorder_level numeric,
  p_active boolean, p_image_url text default null, p_bin text default null
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_row public.products;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  if trim(coalesce(p_sku, '')) = '' then raise exception 'A stock code is required'; end if;
  if trim(coalesce(p_name, '')) = '' then raise exception 'A name is required'; end if;
  if not exists (select 1 from public.units_of_measure where code = p_unit_code) then
    raise exception 'Unknown unit %', p_unit_code;
  end if;

  if p_id is null then
    insert into public.products(org_id, sku, barcode, name, description,
      category_id, unit_code, price_retail, price_trade, cost, tax_code,
      stock_qty, reorder_level, active, image_url, bin)
    values (v_user.org_id, trim(p_sku), nullif(trim(coalesce(p_barcode,'')),''),
      trim(p_name), p_description, p_category_id, p_unit_code, p_price_retail,
      p_price_trade, p_cost, coalesce(p_tax_code,'standard'), p_stock_qty,
      p_reorder_level, coalesce(p_active, true), p_image_url,
      nullif(trim(coalesce(p_bin,'')),''))
    returning * into v_row;
  else
    update public.products set
      sku = trim(p_sku), barcode = nullif(trim(coalesce(p_barcode,'')),''),
      name = trim(p_name), description = p_description, category_id = p_category_id,
      unit_code = p_unit_code, price_retail = p_price_retail,
      price_trade = p_price_trade, cost = p_cost,
      tax_code = coalesce(p_tax_code,'standard'), stock_qty = p_stock_qty,
      reorder_level = p_reorder_level, active = coalesce(p_active, true),
      image_url = p_image_url, bin = nullif(trim(coalesce(p_bin,'')),''),
      updated_at = now()
    where id = p_id and org_id = v_user.org_id
    returning * into v_row;
    if not found then raise exception 'Product not found'; end if;
  end if;
  return v_row;
end;
$$;

grant execute on function public.pos_admin_save_product(text, text, uuid, text,
  text, text, text, uuid, text, numeric, numeric, numeric, text, numeric,
  numeric, boolean, text, text) to anon, authenticated;

drop function if exists public.pos_admin_list_products(text, text);
create function public.pos_admin_list_products(p_register_token text, p_pin text)
returns table(id uuid, sku text, barcode text, name text, description text,
  category_id uuid, category_name text, unit_code text, price_retail numeric,
  price_trade numeric, cost numeric, tax_code text, stock_qty numeric,
  reorder_level numeric, active boolean, image_url text, bin text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  return query
    select p.id, p.sku, p.barcode, p.name, p.description, p.category_id, c.name,
           p.unit_code, p.price_retail, p.price_trade, p.cost, p.tax_code,
           p.stock_qty, p.reorder_level, p.active, p.image_url, p.bin
    from public.products p
    left join public.categories c on c.id = p.category_id
    where p.org_id = v_user.org_id
    order by p.name;
end;
$$;
grant execute on function public.pos_admin_list_products(text, text) to anon, authenticated;
