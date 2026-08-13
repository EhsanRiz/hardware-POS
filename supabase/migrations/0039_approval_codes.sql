-- Approving a discount when the manager is not in the building.
--
-- The counter's real problem is not the discount, it is the phone call. A
-- cashier with a customer pressing for money off, a manager at the bank, and
-- the only way to release the sale being six digits that live in the manager's
-- head. What happens next is entirely predictable: the manager reads their PIN
-- over the phone, and from that moment it is not their PIN. It opens the back
-- office, the staff list, the cash-up and every till in the shop, and there is
-- no way to take it back except by changing it and telling everybody.
--
-- So this offers something safer that is just as easy over a voice call, which
-- is the only way a bad habit ever actually gets replaced. The manager issues a
-- code and reads THAT out. It is
--
--   single use          — the second attempt is refused, so overhearing it is
--                         worth nothing once it has been used
--   short-lived         — minutes, chosen when it is issued
--   capped              — it may carry a rand ceiling; a code for R80 cannot
--                         release R800
--   good for one thing  — it approves a discount. It cannot sign in, cannot
--                         open the back office, cannot cash up
--   attributable        — the sale records the MANAGER WHO ISSUED IT as the
--                         approver, not the cashier who typed it. Swapping a
--                         traceable PIN for an anonymous token would be a
--                         worse system, not a safer one
--
-- Deliberately NOT lifted by a code: an item's discount cap. A cap exists
-- precisely so that no authority overrides it, and a code is an authority.
--
-- The code is stored hashed, like a PIN and like a register token. Six digits
-- is small, so the guard is the shape of the window rather than the length: a
-- code must be unused, unexpired and belong to this shop before it is even
-- compared, which leaves a handful of live rows at any moment.

create table if not exists public.approval_codes (
  id             uuid primary key default extensions.gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  code_hash      text not null,
  issued_by      uuid not null references public.app_users(id),
  -- Snapshotted the way sales snapshot cashier_name: the invoice has to keep
  -- making sense after somebody leaves and their row is disabled.
  issued_by_name text not null,
  /** The most this code may release. Null means only the ordinary rules bind. */
  max_amount     numeric(12,2) check (max_amount is null or max_amount > 0),
  reason         text,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  used_at        timestamptz,
  used_by        uuid references public.app_users(id),
  used_on_sale   uuid references public.sales(id)
);

create index if not exists approval_codes_live
  on public.approval_codes (org_id, expires_at) where used_at is null;

alter table public.approval_codes enable row level security;

-- Issue one. Returns the code in the clear exactly once — the same bargain as
-- a register token, and for the same reason: the row keeps only the hash, so
-- nobody, including whoever runs the database, can read it back out later.
create or replace function public.pos_issue_approval_code(
  p_register_token text,
  p_pin text,
  p_minutes int default 10,
  p_max_amount numeric default null,
  p_reason text default null
) returns table(code text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_code text; v_expires timestamptz;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'approve_discount');

  if p_minutes is null or p_minutes < 1 or p_minutes > 120 then
    raise exception 'A code lasts between 1 and 120 minutes';
  end if;
  if p_max_amount is not null and p_max_amount <= 0 then
    raise exception 'A ceiling of nothing is not a ceiling';
  end if;

  -- Six digits, uniformly drawn. lpad because a leading zero is a digit and
  -- dropping it would quietly shrink the space by a tenth.
  v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
  v_expires := now() + make_interval(mins => p_minutes);

  insert into public.approval_codes(
    org_id, code_hash, issued_by, issued_by_name, max_amount, reason, expires_at)
  values (v_user.org_id, crypt(v_code, gen_salt('bf')), v_user.id, v_user.name,
          p_max_amount, nullif(trim(coalesce(p_reason, '')), ''), v_expires);

  return query select v_code, v_expires;
end;
$$;
grant execute on function public.pos_issue_approval_code(text, text, int, numeric, text)
  to anon, authenticated;

-- Is this code live? Asked while the cashier is typing, so they find out at the
-- counter rather than at the tender screen with a customer waiting.
--
-- It does not consume the code — that happens in pos_create_sale, atomically
-- with the sale it authorised, so a code is never burnt on a sale that then
-- fails a stock check. Which makes this an oracle, so it is rate-limited per
-- till: ten wrong guesses in fifteen minutes and it stops answering. Against a
-- six-digit space with only a handful of live codes that is not a race anybody
-- wins, and it is far more patience than a cashier reading digits off a phone
-- call will ever need.
create table if not exists public.approval_attempts (
  id          uuid primary key default extensions.gen_random_uuid(),
  register_id uuid not null references public.registers(id) on delete cascade,
  at          timestamptz not null default now()
);
create index if not exists approval_attempts_recent
  on public.approval_attempts (register_id, at);
alter table public.approval_attempts enable row level security;

create or replace function public.pos_check_approval_code(
  p_register_token text, p_code text
) returns table(ok boolean, issued_by_name text, max_amount numeric,
                expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare v_reg public.registers; v_row public.approval_codes; v_recent int;
begin
  v_reg := public.register_by_token(p_register_token);

  select count(*) into v_recent from public.approval_attempts a
   where a.register_id = v_reg.id and a.at > now() - interval '15 minutes';
  if v_recent >= 10 then
    raise exception 'Too many wrong codes on this till. Try again in 15 minutes.';
  end if;

  select * into v_row from public.approval_codes c
   where c.org_id = v_reg.org_id and c.used_at is null and c.expires_at > now()
     and c.code_hash = crypt(p_code, c.code_hash)
   limit 1;

  if v_row.id is null then
    insert into public.approval_attempts(register_id) values (v_reg.id);
    return query select false, null::text, null::numeric, null::timestamptz;
    return;
  end if;

  delete from public.approval_attempts a where a.register_id = v_reg.id;
  return query select true, v_row.issued_by_name, v_row.max_amount, v_row.expires_at;
end;
$$;
grant execute on function public.pos_check_approval_code(text, text)
  to anon, authenticated;

-- What has been issued lately, and what became of it. A code that approves a
-- sale without leaving a trail is a hole with a user interface; this is the
-- trail, and it is why the panel that issues codes also lists them.
create or replace function public.pos_approval_codes(
  p_register_token text, p_pin text, p_limit int default 50
) returns table(id uuid, issued_by_name text, max_amount numeric, reason text,
                created_at timestamptz, expires_at timestamptz,
                used_at timestamptz, used_by_name text, doc_number text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'approve_discount');
  return query
    select c.id, c.issued_by_name, c.max_amount, c.reason, c.created_at,
           c.expires_at, c.used_at, u.name, s.doc_number
      from public.approval_codes c
      left join public.app_users u on u.id = c.used_by
      left join public.sales s on s.id = c.used_on_sale
     where c.org_id = v_user.org_id
     order by c.created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;
grant execute on function public.pos_approval_codes(text, text, int)
  to anon, authenticated;

-- ------------------------------------------------------------------ sale ---
--
-- pos_create_sale gains p_approval_code. The code is consumed here rather than
-- in a step of its own, so it is spent exactly when the sale it released is
-- written — a separate redeem could burn a code on a sale that then fails a
-- stock check, and the customer would be standing there while the manager was
-- phoned a second time.
--
-- Expiry is measured against the moment the sale was RUNG UP, not the moment it
-- reached the server. This shop sells through outages by design: a sale taken
-- on a dropped line can sit in the queue for an hour, and a code that was live
-- when the cashier typed it should not be refused because the connection came
-- back late. A day's bound keeps that from becoming an open door.

-- Dropped rather than replaced. One more defaulted argument makes a new
-- signature, and `create or replace` would leave the seventeen-argument version
-- standing beside it — after which every existing caller, which names none of
-- the optional arguments, is ambiguous and fails outright.
drop function if exists public.pos_create_sale(
  text, uuid, jsonb, uuid, text, numeric, text, uuid, numeric, numeric, numeric,
  uuid, timestamptz, text, jsonb, text, text);

create function public.pos_create_sale(
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
    v_price := public.price_for(v_product, v_trade);
    v_line := round(v_price * v_qty, 2);

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

grant execute on function public.pos_create_sale(
  text, uuid, jsonb, uuid, text, numeric, text, uuid, numeric, numeric, numeric,
  uuid, timestamptz, text, jsonb, text, text, text) to anon, authenticated;
