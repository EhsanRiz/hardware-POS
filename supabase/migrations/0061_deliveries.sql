-- 0061 — deliveries.
--
-- The shop delivers. At the counter, "Deliver" is chosen alongside the tender:
-- the charge goes into the sale as its own line so the money is banked and the
-- VAT is right, the receipt prints as always, and a delivery note is written
-- that anyone can find, print, and mark off when the signed page comes back.
--
-- The note itself carries NO prices. A customer signs for goods received, not
-- for money — the invoice carries the figures and may travel with the load or
-- follow it.

-- --------------------------------------------------------------------------
-- 1. A line whose price the counter names.
-- --------------------------------------------------------------------------
--
-- Delivery is quoted per job: five kilometres of tar and twenty of farm road
-- are not the same money. Every other line in this system is priced by the
-- shop and not by the till, and that stays true — a client that can name its
-- own price can sell cement for a rand. So the right is granted to the
-- PRODUCT, not to the request: only a product the shop has marked as
-- something other than goods will take the figure the counter typed.

alter table public.products
  add column if not exists kind text not null default 'goods';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_kind_check') then
    alter table public.products
      add constraint products_kind_check check (kind in ('goods', 'delivery'));
  end if;
end $$;

comment on column public.products.kind is
  'goods (priced by the shop) or delivery (priced per job at the counter).';

/**
 * What a line costs: the shop's price, or the counter's for an open line.
 *
 * pos_create_sale works the lines out three times — once to total them, once
 * to walk the discount limits, once to write them down — and all three must
 * agree to the cent. That is why this is a function and not three copies of
 * an `if`.
 */
create or replace function public.line_price(
  p_product public.products, p_trade boolean, p_item jsonb
) returns numeric
language plpgsql stable set search_path = public, extensions as $$
declare v_asked numeric;
begin
  if coalesce(p_product.kind, 'goods') = 'goods' then
    return public.price_for(p_product, p_trade);
  end if;
  v_asked := nullif(p_item->>'unit_price', '')::numeric;
  if v_asked is null then return public.price_for(p_product, p_trade); end if;
  if v_asked < 0 then raise exception 'A price cannot be negative'; end if;
  return round(v_asked, 2);
end;
$$;

-- Rebuilt from 0041 with the three pricing sites moved onto line_price, and
-- nothing else changed. Same signature, so this is a replace and no old
-- version is left standing beside it.
create or replace function public.pos_create_sale(
  p_register_token text, p_cashier_id uuid, p_items jsonb,
  p_customer_id uuid default null, p_payment_method text default 'cash',
  p_discount_amount numeric default 0, p_discount_reason text default null,
  p_approved_by uuid default null, p_amount_tendered numeric default null,
  p_paid_cash numeric default null, p_paid_card numeric default null,
  p_client_ref uuid default null, p_created_at timestamptz default null,
  p_note text default null, p_payments jsonb default null,
  p_po_number text default null, p_customer_vat_number text default null,
  p_approval_code text default null
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
  v_cap numeric(12,2); v_taken numeric(12,2);
  v_within boolean;
  v_code public.approval_codes;
  v_line_reason text;
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
    v_price := public.line_price(v_product, v_trade, v_item);
    v_line := round(v_price * v_qty, 2);

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

  v_net_subtotal := v_subtotal - v_items_disc;
  if p_discount_amount > v_net_subtotal then
    raise exception 'Discount exceeds the sale total';
  end if;

  v_all_disc := round(v_items_disc + p_discount_amount, 2);
  v_total := v_subtotal - v_all_disc;

  -- Both ceilings walk the lines together: the item cap refuses whoever asks,
  -- the percent limit only decides whether a manager is fetched.
  v_within := v_user.discount_limit_percent is not null
           or v_user.discount_limit_amount is not null;

  if v_user.discount_limit_amount is not null
     and v_all_disc > v_user.discount_limit_amount + 0.005 then
    v_within := false;
  end if;

  if v_all_disc > 0 then
    for v_item in select * from jsonb_array_elements(p_items) loop
      select * into v_product from public.products
       where id = (v_item->>'product_id')::uuid;

      v_qty := (v_item->>'qty')::numeric;
      v_line := round(public.line_price(v_product, v_trade, v_item) * v_qty, 2);
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

      if v_within and v_user.discount_limit_percent is not null
         and v_taken > round(v_line * v_user.discount_limit_percent / 100, 2) + 0.005
      then
        v_within := false;
      end if;

      if v_product.max_discount_percent is null
         and v_product.max_discount_amount is null then
        continue;
      end if;

      v_cap := least(
        case when v_product.max_discount_percent is not null
             then round(v_line * v_product.max_discount_percent / 100, 2) end,
        case when v_product.max_discount_amount is not null
             then round(v_product.max_discount_amount * v_qty, 2) end);

      -- Checked before any approval is considered, so no code can lift it.
      if v_taken > v_cap + 0.005 then
        raise exception
          '% is capped at % off and this sale takes % off it. Lower the discount.',
          v_product.name, to_char(v_cap, 'FM999999990.00'),
          to_char(v_taken, 'FM999999990.00');
      end if;
    end loop;
  end if;

  -- Who says this discount may happen. Four ways, in the order they are looked
  -- for: the cashier approves their own; a manager stood at the till and typed
  -- a PIN; a manager issued a code and read it over the phone; or it is inside
  -- the cashier's standing limit and nobody was asked at all.
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

    if v_approver.id is null and p_approval_code is not null then
      -- Locked, because two tills racing on the same overheard code must not
      -- both win: the second finds it used and is refused.
      select * into v_code from public.approval_codes c
       where c.org_id = v_reg.org_id and c.used_at is null
         and c.expires_at >= v_at
         and v_at > now() - interval '1 day'
         and c.code_hash = crypt(p_approval_code, c.code_hash)
       limit 1
       for update;

      if v_code.id is null then
        raise exception
          'That approval code was not accepted. It may have expired or already been used.';
      end if;
      if v_code.max_amount is not null and v_all_disc > v_code.max_amount + 0.005 then
        raise exception 'That code releases up to %, and this discount is %.',
          to_char(v_code.max_amount, 'FM999999990.00'),
          to_char(v_all_disc, 'FM999999990.00');
      end if;

      -- The approver is the manager who ISSUED the code, not the cashier who
      -- typed it. Anything else would put the counter hand's name against a
      -- decision they did not make.
      select * into v_approver from public.app_users where id = v_code.issued_by;
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

  -- Spent, and pointed at the sale it released.
  if v_code.id is not null then
    update public.approval_codes
       set used_at = now(), used_by = v_user.id, used_on_sale = v_sale.id
     where id = v_code.id;
  end if;

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
    v_price := public.line_price(v_product, v_trade, v_item);
    v_line := round(v_price * v_qty, 2);

    v_line_pct := nullif(v_item->>'discount_percent', '')::numeric;
    if v_line_pct is not null then
      v_line_disc := round(v_line * v_line_pct / 100, 2);
    else
      v_line_disc := round(coalesce(nullif(v_item->>'discount_amount', '')::numeric, 0), 2);
    end if;

    -- Bounded, because this is free text off a till and nothing downstream
    -- wants a paragraph. Kept only where there is a discount for it to explain:
    -- a reason attached to a line that was never marked down is a note about
    -- nothing, and it would read on a reprint as though money had come off.
    v_line_reason := nullif(trim(coalesce(left(v_item->>'discount_reason', 200), '')), '');
    if v_line_disc <= 0 then v_line_reason := null; end if;

    v_share := case
      when v_net_subtotal > 0
        then round((v_line - v_line_disc) * v_total / v_net_subtotal, 2)
      else 0 end;

    v_rate := coalesce(public.tax_rate_at(v_product.tax_code, v_at::date), 0);
    insert into public.sale_items(sale_id, product_id, sku, name, unit_code,
      qty, unit_price, line_total, tax_code, tax_rate, tax_amount, cost_at_sale,
      discount_amount, discount_percent, discount_reason)
    values (v_sale.id, v_product.id, v_product.sku, v_product.name,
      v_product.unit_code, v_qty, v_price, v_share, v_product.tax_code, v_rate,
      round(v_share - (v_share / (1 + v_rate)), 2), v_product.cost,
      v_line_disc, v_line_pct, v_line_reason);
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
grant execute on function public.pos_create_sale(
  text, uuid, jsonb, uuid, text, numeric, text, uuid, numeric, numeric,
  numeric, uuid, timestamptz, text, jsonb, text, text, text
) to anon, authenticated;

-- --------------------------------------------------------------------------
-- 2. The shop's delivery line.
-- --------------------------------------------------------------------------
--
-- One per shop, made the first time somebody delivers something. It is a real
-- product because the charge is a real line on a real invoice: it is banked,
-- it is taxed, and it shows in the day's takings. Its price is zero because
-- the price is named at the counter.

create or replace function public.delivery_product(p_org uuid)
returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_product public.products; v_unit text;
begin
  select * into v_product from public.products
   where org_id = p_org and kind = 'delivery' order by created_at limit 1;
  if found then return v_product; end if;

  -- Whatever this shop calls "each"; every catalogue has one.
  select code into v_unit from public.units_of_measure
   where not allows_fraction order by code limit 1;

  insert into public.products (org_id, sku, name, unit_code, price_retail,
                               cost, active, kind, stock_qty, tax_code)
  values (p_org, 'DELIVERY', 'Delivery', coalesce(v_unit, 'ea'), 0, 0, true,
          'delivery', null,
          (select tax_code from public.products
            where org_id = p_org and tax_code is not null limit 1))
  returning * into v_product;
  return v_product;
end;
$$;

/** The line to put a delivery charge on. The till asks before it charges. */
create or replace function public.pos_delivery_product(p_register_token text)
returns table(id uuid, sku text, name text, unit_code text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_reg public.registers; v_product public.products;
begin
  v_reg := public.register_by_token(p_register_token);
  v_product := public.delivery_product(v_reg.org_id);
  return query select v_product.id, v_product.sku, v_product.name, v_product.unit_code;
end;
$$;

grant execute on function public.pos_delivery_product(text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- 3. The delivery notes.
-- --------------------------------------------------------------------------

create table if not exists public.deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  doc_number text not null,
  -- Always from a sale: the goods on the note are the goods on the invoice.
  sale_id uuid not null references public.sales(id) on delete cascade,
  customer_name text not null,
  address text not null,
  deliver_on date not null,
  -- Free text on purpose. "After 14:00" and "Tue morning" are what a shop
  -- actually promises, and neither fits a time column.
  deliver_at text,
  charge numeric(12,2) not null default 0,
  note text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  created_by uuid references public.app_users(id),
  cashier_name text,
  delivered_at timestamptz,
  delivered_by uuid references public.app_users(id),
  delivered_by_name text,
  constraint deliveries_status_check check (status in ('pending', 'delivered')),
  constraint deliveries_number_unique unique (org_id, doc_number),
  -- One note per sale. A second would be a second promise to deliver the same
  -- goods, and two drivers would load the same bakkie.
  constraint deliveries_one_per_sale unique (sale_id)
);

create index if not exists deliveries_org_status_idx
  on public.deliveries (org_id, status, deliver_on);

alter table public.deliveries enable row level security;

/**
 * Write the note, at the moment the sale is rung up.
 *
 * No permission beyond a working register and a signed-in operator: whoever
 * takes the money takes the address, and a delivery nobody may record is a
 * delivery that happens on a scrap of paper instead.
 */
create or replace function public.pos_create_delivery(
  p_register_token text, p_cashier_id uuid, p_sale_id uuid,
  p_customer_name text, p_address text, p_deliver_on date,
  p_deliver_at text default null, p_charge numeric default 0,
  p_note text default null
) returns public.deliveries
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_sale public.sales;
  v_row public.deliveries;
begin
  v_reg := public.register_by_token(p_register_token);
  select * into v_user from public.app_users
   where id = p_cashier_id and org_id = v_reg.org_id and active;
  if not found then raise exception 'Unknown cashier'; end if;

  select * into v_sale from public.sales
   where id = p_sale_id and org_id = v_reg.org_id;
  if not found then raise exception 'Unknown sale'; end if;

  if coalesce(btrim(p_customer_name), '') = '' then
    raise exception 'A delivery needs a name';
  end if;
  if coalesce(btrim(p_address), '') = '' then
    raise exception 'A delivery needs an address';
  end if;

  -- Asking twice is a double-tap, not a second delivery: hand back the note
  -- that already exists rather than refusing and losing the address.
  select * into v_row from public.deliveries where sale_id = p_sale_id;
  if found then return v_row; end if;

  insert into public.deliveries (org_id, doc_number, sale_id, customer_name,
    address, deliver_on, deliver_at, charge, note, created_by, cashier_name)
  values (v_reg.org_id, public.next_doc_number(v_reg.org_id, 'delivery'),
    p_sale_id, btrim(p_customer_name), btrim(p_address),
    coalesce(p_deliver_on, current_date), nullif(btrim(coalesce(p_deliver_at, '')), ''),
    round(coalesce(p_charge, 0), 2), nullif(btrim(coalesce(p_note, '')), ''),
    v_user.id, v_user.name)
  returning * into v_row;
  return v_row;
end;
$$;

grant execute on function public.pos_create_delivery(
  text, uuid, uuid, text, text, date, text, numeric, text) to anon, authenticated;

/** Everything still to go out, then everything that has gone. */
create or replace function public.pos_list_deliveries(
  p_register_token text, p_limit int default 100
) returns table(id uuid, doc_number text, sale_id uuid, sale_number text,
                customer_name text, address text, deliver_on date,
                deliver_at text, charge numeric, note text, status text,
                created_at timestamptz, cashier_name text,
                delivered_at timestamptz, delivered_by_name text,
                item_count int)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select d.id, d.doc_number, d.sale_id, s.doc_number, d.customer_name,
           d.address, d.deliver_on, d.deliver_at, d.charge, d.note, d.status,
           d.created_at, d.cashier_name, d.delivered_at, d.delivered_by_name,
           (select count(*)::int from public.sale_items i
             join public.products p on p.id = i.product_id
            where i.sale_id = d.sale_id and coalesce(p.kind, 'goods') = 'goods')
      from public.deliveries d
      join public.sales s on s.id = d.sale_id
     where d.org_id = v_reg.org_id
     -- What is still owed to somebody comes first, oldest promise at the top:
     -- that is the order a driver loads in.
     order by (d.status = 'pending') desc, d.deliver_on asc, d.created_at asc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

grant execute on function public.pos_list_deliveries(text, int) to anon, authenticated;

/**
 * What is on the load.
 *
 * The goods, and only the goods: the delivery charge is a line on the invoice
 * but it is not something anybody hands over at a gate, and a customer asked
 * to sign for "Delivery x 1" would be right to ask what they were signing for.
 */
create or replace function public.pos_delivery_items(
  p_register_token text, p_delivery_id uuid
) returns table(sku text, name text, unit_code text, qty numeric)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_row public.deliveries;
begin
  v_reg := public.register_by_token(p_register_token);
  select * into v_row from public.deliveries
   where id = p_delivery_id and org_id = v_reg.org_id;
  if not found then raise exception 'Unknown delivery'; end if;

  return query
    select i.sku, i.name, i.unit_code, i.qty
      from public.sale_items i
      left join public.products p on p.id = i.product_id
     where i.sale_id = v_row.sale_id
       and coalesce(p.kind, 'goods') = 'goods'
     order by i.name;
end;
$$;

grant execute on function public.pos_delivery_items(text, uuid) to anon, authenticated;

/**
 * The signed page came back.
 *
 * Anyone may mark it: the driver, whoever took the page off them, or the
 * owner going through the pile at six. Who did it is recorded, which is what
 * makes the tab answer "who says so?" the following week.
 */
create or replace function public.pos_mark_delivered(
  p_register_token text, p_user_id uuid, p_delivery_id uuid,
  p_note text default null
) returns public.deliveries
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_row public.deliveries;
begin
  v_reg := public.register_by_token(p_register_token);
  select * into v_user from public.app_users
   where id = p_user_id and org_id = v_reg.org_id and active;
  if not found then raise exception 'Unknown user'; end if;

  select * into v_row from public.deliveries
   where id = p_delivery_id and org_id = v_reg.org_id;
  if not found then raise exception 'Unknown delivery'; end if;
  if v_row.status = 'delivered' then
    raise exception 'That delivery is already marked as delivered';
  end if;

  update public.deliveries
     set status = 'delivered', delivered_at = now(),
         delivered_by = v_user.id, delivered_by_name = v_user.name,
         note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note)
   where id = p_delivery_id
   returning * into v_row;
  return v_row;
end;
$$;

grant execute on function public.pos_mark_delivered(text, uuid, uuid, text)
  to anon, authenticated;

/** One delivery note, for the screen that prints it. */
create or replace function public.pos_delivery(
  p_register_token text, p_delivery_id uuid
) returns public.deliveries
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_row public.deliveries;
begin
  v_reg := public.register_by_token(p_register_token);
  select * into v_row from public.deliveries
   where id = p_delivery_id and org_id = v_reg.org_id;
  if not found then raise exception 'Unknown delivery'; end if;
  return v_row;
end;
$$;

grant execute on function public.pos_delivery(text, uuid) to anon, authenticated;

-- --------------------------------------------------------------------------
-- 4. DEL-000001.
-- --------------------------------------------------------------------------
--
-- From 0053, with one more prefix. Same signature, so it replaces rather than
-- joining the old one; the sequence itself is created lazily on first use, so
-- a shop that never delivers never has one.
create or replace function public.next_doc_number(p_org uuid, p_doc_type text)
returns text language plpgsql set search_path = public, extensions as $$
declare v_seq public.doc_sequences;
begin
  -- New orgs get their sequences lazily.
  insert into public.doc_sequences (org_id, doc_type, prefix)
  values (p_org, p_doc_type,
          case p_doc_type when 'sale' then 'INV-' when 'quote' then 'QUO-'
                          when 'grv' then 'GRV-' when 'sku' then 'SKU-'
                          when 'delivery' then 'DEL-'
                          else 'CRN-' end)
  on conflict (org_id, doc_type) do nothing;

  select * into v_seq from public.doc_sequences
    where org_id = p_org and doc_type = p_doc_type for update;
  update public.doc_sequences set next_number = next_number + 1
    where org_id = p_org and doc_type = p_doc_type;
  return v_seq.prefix || lpad(v_seq.next_number::text, v_seq.pad_width, '0');
end;
$$;
