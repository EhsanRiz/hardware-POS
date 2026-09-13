-- A till numbers its own invoices, from a block it reserved while the line
-- was up.
--
-- Invoice and delivery-note numbers are issued here, at insert, so two tills
-- never issue the same one. That left a sale taken with the line down with no
-- number until it synced — a slip that said the number would follow, and a
-- till reference to bring back. The shop wants the number on the paper, line
-- or no line. So a till now RESERVES a block of numbers ahead of time (25 at
-- a time, topped up as it goes), holds them on the device, and gives each
-- sale the next one itself, online or off; the server keeps the number the
-- till gave, having checked it is that till's and unspent. Reserving advances
-- the shop's sequence, so a number is still issued exactly once. Two tills
-- interleave their blocks, so the run of numbers is no longer in time order
-- across the shop; within one till it is. A block a till never uses — it
-- was unpaired, or the line stayed down past twenty-five sales and the rest
-- fell back to a till reference — is a gap, and doc_reservations says which
-- till held it and when.
--
-- Adding a defaulted argument is a NEW signature: the old pos_create_sale
-- and pos_create_delivery are dropped first, or every caller that names no
-- optional argument becomes ambiguous.

create table public.doc_reservations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id),
  register_id  uuid not null references public.registers(id),
  doc_type     text not null,
  from_number  bigint not null,
  to_number    bigint not null,
  reserved_at  timestamptz not null default now(),
  check (to_number >= from_number)
);
create index doc_reservations_register_idx
  on public.doc_reservations (register_id, doc_type);
alter table public.doc_reservations enable row level security;

-- How many of the numbers this till holds are still unspent. Counted from
-- the documents themselves, so nothing has to be kept in step.
create function public.doc_numbers_unspent(p_reg public.registers, p_doc_type text)
returns bigint language plpgsql stable
set search_path = public, extensions as $$
declare v_held bigint; v_used bigint;
begin
  select coalesce(sum(r.to_number - r.from_number + 1), 0) into v_held
    from public.doc_reservations r
   where r.register_id = p_reg.id and r.doc_type = p_doc_type;
  if p_doc_type = 'sale' then
    select count(*) into v_used
      from public.doc_reservations r
      join public.sales s on s.org_id = r.org_id
       and s.doc_number ~ '^[A-Z]+-[0-9]+$'
       and (substring(s.doc_number from '[0-9]+$'))::bigint between r.from_number and r.to_number
     where r.register_id = p_reg.id and r.doc_type = 'sale';
  else
    select count(*) into v_used
      from public.doc_reservations r
      join public.deliveries d on d.org_id = r.org_id
       and d.doc_number ~ '^[A-Z]+-[0-9]+$'
       and (substring(d.doc_number from '[0-9]+$'))::bigint between r.from_number and r.to_number
     where r.register_id = p_reg.id and r.doc_type = 'delivery';
  end if;
  return v_held - v_used;
end;
$$;
revoke execute on function public.doc_numbers_unspent(public.registers, text) from public, anon, authenticated;

-- The till asks for a block. Capped at fifty a time, and refused while the
-- till still holds fifty unspent, so a stolen token cannot run the shop's
-- sequence into the millions.
create function public.pos_reserve_doc_numbers(
  p_register_token text, p_doc_type text, p_count int default 25
) returns table(prefix text, pad_width int, from_number bigint, to_number bigint)
language plpgsql security definer set search_path = public, extensions as $$
declare v_reg public.registers; v_seq public.doc_sequences; v_count int;
begin
  v_reg := public.register_by_token(p_register_token);
  if p_doc_type not in ('sale', 'delivery') then
    raise exception 'A till does not number that';
  end if;
  v_count := least(greatest(coalesce(p_count, 25), 1), 50);
  if public.doc_numbers_unspent(v_reg, p_doc_type) >= 50 then
    raise exception 'This till already holds enough numbers';
  end if;

  insert into public.doc_sequences (org_id, doc_type, prefix)
  values (v_reg.org_id, p_doc_type,
          case p_doc_type when 'sale' then 'INV-' else 'DEL-' end)
  on conflict (org_id, doc_type) do nothing;
  select * into v_seq from public.doc_sequences
    where org_id = v_reg.org_id and doc_type = p_doc_type for update;
  update public.doc_sequences set next_number = next_number + v_count
    where org_id = v_reg.org_id and doc_type = p_doc_type;

  insert into public.doc_reservations (org_id, register_id, doc_type, from_number, to_number)
  values (v_reg.org_id, v_reg.id, p_doc_type, v_seq.next_number, v_seq.next_number + v_count - 1);
  return query select v_seq.prefix, v_seq.pad_width, v_seq.next_number, v_seq.next_number + v_count - 1;
end;
$$;
grant execute on function public.pos_reserve_doc_numbers(text, text, int) to anon, authenticated;

-- A number the till gave: null when it gave none; otherwise the number, once
-- it is shown to be this till's, formatted as the sequence formats it, and
-- not yet on any document. Anything else is refused by name.
create function public.claim_doc_number(p_reg public.registers, p_doc_type text, p_doc_number text)
returns text language plpgsql stable
set search_path = public, extensions as $$
declare v_doc text; v_n bigint; v_seq public.doc_sequences; v_taken boolean;
begin
  v_doc := nullif(upper(btrim(coalesce(p_doc_number, ''))), '');
  if v_doc is null then return null; end if;
  if v_doc !~ '^[A-Z]+-[0-9]+$' then
    raise exception 'Number % is not one this till was given', v_doc;
  end if;
  v_n := (substring(v_doc from '[0-9]+$'))::bigint;
  select * into v_seq from public.doc_sequences
   where org_id = p_reg.org_id and doc_type = p_doc_type;
  if not found or v_doc <> v_seq.prefix || lpad(v_n::text, v_seq.pad_width, '0') then
    raise exception 'Number % is not one this till was given', v_doc;
  end if;
  if not exists (select 1 from public.doc_reservations r
                  where r.register_id = p_reg.id and r.doc_type = p_doc_type
                    and v_n between r.from_number and r.to_number) then
    raise exception 'Number % is not one this till was given', v_doc;
  end if;
  if p_doc_type = 'sale' then
    select exists (select 1 from public.sales s where s.org_id = p_reg.org_id and s.doc_number = v_doc) into v_taken;
  else
    select exists (select 1 from public.deliveries d where d.org_id = p_reg.org_id and d.doc_number = v_doc) into v_taken;
  end if;
  if v_taken then raise exception 'Number % has already been used', v_doc; end if;
  return v_doc;
end;
$$;
revoke execute on function public.claim_doc_number(public.registers, text, text) from public, anon, authenticated;

drop function if exists public.pos_create_sale(
  text, uuid, jsonb, uuid, text, numeric, text, uuid, numeric, numeric, numeric,
  uuid, timestamptz, text, jsonb, text, text, text);

create function public.pos_create_sale(
  p_register_token text, p_cashier_id uuid, p_items jsonb,
  p_customer_id uuid default null, p_payment_method text default 'cash',
  p_discount_amount numeric default 0, p_discount_reason text default null,
  p_approved_by uuid default null, p_amount_tendered numeric default null,
  p_paid_cash numeric default null, p_paid_card numeric default null,
  p_client_ref uuid default null, p_created_at timestamptz default null,
  p_note text default null, p_payments jsonb default null,
  p_po_number text default null, p_customer_vat_number text default null,
  p_approval_code text default null, p_doc_number text default null
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
  v_doc text;
begin
  v_reg := public.register_by_token(p_register_token);
  perform public.register_touch(v_reg.id);

  if p_client_ref is not null then
    -- Scoped to the shop: the constraint is (org_id, client_ref) since 0013,
    -- so the same ref can legitimately exist in two shops, and without this
    -- clause a matching ref handed back another shop's whole sale row.
    select * into v_existing from public.sales
     where client_ref = p_client_ref and org_id = v_reg.org_id;
    if found then return v_existing; end if;
  end if;

  -- 0096: a number the till gave itself, from a block reserved here. It has
  -- to be this till's and unspent, or the slip in the customer's hand names
  -- an invoice the shop never issued.
  v_doc := public.claim_doc_number(v_reg, 'sale', p_doc_number);

  -- Somebody who can sign in AND may take payments. Both were here in 0012
  -- and 0019 and went missing in 0039, so a register token alone could post
  -- a numbered, stock-moving invoice under any name on the roster —
  -- somebody who never enrolled included.
  select * into v_user from public.app_users
   where id = p_cashier_id and org_id = v_reg.org_id
     and active and status = 'active';
  if not found then raise exception 'Unknown cashier'; end if;
  if not ('take_payments' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted: take_payments';
  end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers
     where id = p_customer_id and org_id = v_reg.org_id;
    if not found then raise exception 'Unknown customer'; end if;
    v_trade := v_customer.is_trade;
  end if;

  -- The till's own clock, for a sale taken offline and replayed later — but
  -- bounded, as 0012 and 0019 had it before 0039 dropped the clamp: a
  -- caller could otherwise file a sale into a closed cash-up or VAT month,
  -- or a future one, and stretch the approval-code window with it.
  v_at := coalesce(p_created_at, now());
  if v_at > now() + interval '5 minutes' or v_at < now() - interval '30 days' then
    v_at := now();
  end if;

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
    case when v_status = 'completed'
         then coalesce(v_doc, public.next_doc_number(v_reg.org_id, 'sale')) end,
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

drop function if exists public.pos_create_delivery(
  text, uuid, uuid, text, text, date, text, numeric, text);

create function public.pos_create_delivery(
  p_register_token text, p_cashier_id uuid, p_sale_id uuid,
  p_customer_name text, p_address text, p_deliver_on date,
  p_deliver_at text default null, p_charge numeric default 0,
  p_note text default null, p_doc_number text default null
) returns public.deliveries
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_sale public.sales;
  v_row public.deliveries; v_doc text;
begin
  v_reg := public.register_by_token(p_register_token);
  select * into v_user from public.app_users
   where id = p_cashier_id and org_id = v_reg.org_id
     and active and status = 'active';
  if not found then raise exception 'Unknown cashier'; end if;
  if not ('take_payments' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted: take_payments';
  end if;

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

  v_doc := public.claim_doc_number(v_reg, 'delivery', p_doc_number);

  insert into public.deliveries (org_id, doc_number, sale_id, customer_name,
    address, deliver_on, deliver_at, charge, note, created_by, cashier_name)
  values (v_reg.org_id, coalesce(v_doc, public.next_doc_number(v_reg.org_id, 'delivery')),
    p_sale_id, btrim(p_customer_name), btrim(p_address),
    coalesce(p_deliver_on, current_date), nullif(btrim(coalesce(p_deliver_at, '')), ''),
    round(coalesce(p_charge, 0), 2), nullif(btrim(coalesce(p_note, '')), ''),
    v_user.id, v_user.name)
  returning * into v_row;
  return v_row;
end;
$$;

grant execute on function public.pos_create_sale(
  text, uuid, jsonb, uuid, text, numeric, text, uuid, numeric, numeric, numeric,
  uuid, timestamptz, text, jsonb, text, text, text, text) to anon, authenticated;
grant execute on function public.pos_create_delivery(
  text, uuid, uuid, text, text, date, text, numeric, text, text) to anon, authenticated;
