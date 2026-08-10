-- Hardware POS — register pairing, and the RPCs the till actually calls.
--
-- Why this exists. A sale taken offline is replayed later by sync.ts, and the
-- device deliberately never stores the cashier's PIN (auth.ts caches a PBKDF2
-- hash for offline sign-in, which cannot be reversed). So a PIN-authenticated
-- pos_create_sale simply cannot be replayed.
--
-- The cafe build resolved this by trusting a client-supplied cashier_id with no
-- credential at all: anyone holding the anon key that ships in the PWA could
-- POST a sale as any cashier. Rather than inherit that, the till authenticates
-- as a *register*: a manager pairs the tablet once and it holds a random token.
--
--   * The token says "this is the shop's till" — it survives going offline, so
--     queued sales replay without needing anyone's PIN.
--   * cashier_id says who rang it up, and their permissions are still checked.
--   * A PIN is still required for the privileged things a manager stands at the
--     counter to do: approving a discount, voiding a sale, administration.
--
-- Losing the tablet means revoking one token, not rotating every staff PIN.

create table public.registers (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  -- sha256 of the token. The plaintext is shown once, at pairing.
  token_hash   text not null unique,
  active       boolean not null default true,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now()
);

alter table public.registers enable row level security;

-- Pair a tablet. Returns the token exactly once — it is not recoverable later.
create function public.pos_pair_register(p_pin text, p_name text)
returns table(register_id uuid, token text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_token text; v_id uuid;
begin
  v_user := public.user_with_perm(p_pin, 'manage_settings');
  v_token := encode(gen_random_bytes(32), 'hex');

  insert into public.registers(name, token_hash)
  values (coalesce(nullif(trim(p_name), ''), 'Till'),
          encode(digest(v_token, 'sha256'), 'hex'))
  returning id into v_id;

  return query select v_id, v_token;
end;
$$;

-- Resolve a register token. Internal: never exposed over the API.
create function public.register_by_token(p_token text)
returns public.registers
language plpgsql security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  select * into v_reg from public.registers
   where active and token_hash = encode(digest(p_token, 'sha256'), 'hex');
  if v_reg.id is null then raise exception 'Register not paired or revoked'; end if;
  update public.registers set last_seen_at = now() where id = v_reg.id;
  return v_reg;
end;
$$;

create function public.pos_revoke_register(p_pin text, p_register_id uuid)
returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  perform public.user_with_perm(p_pin, 'manage_settings');
  update public.registers set active = false where id = p_register_id;
end;
$$;

create function public.pos_list_registers(p_pin text)
returns table(id uuid, name text, active boolean, last_seen_at timestamptz,
              created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.user_with_perm(p_pin, 'manage_settings');
  return query select r.id, r.name, r.active, r.last_seen_at, r.created_at
               from public.registers r order by r.created_at;
end;
$$;

-- Re-point the sale RPC at register auth ---------------------------------------

drop function if exists public.pos_create_sale(text, jsonb, uuid, text, numeric,
  text, numeric, numeric, numeric, uuid, text);

create function public.pos_create_sale(
  p_register_token  text,
  p_cashier_id      uuid,
  p_items           jsonb,          -- [{product_id, qty}]
  p_customer_id     uuid    default null,
  p_payment_method  text    default 'cash',
  p_discount_amount numeric default 0,
  p_discount_reason text    default null,
  p_approved_by     uuid    default null,
  p_amount_tendered numeric default null,
  p_paid_cash       numeric default null,
  p_paid_card       numeric default null,
  p_client_ref      uuid    default null,
  p_created_at      timestamptz default null,
  p_note            text    default null
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_reg       public.registers;
  v_user      public.app_users;
  v_approver  public.app_users;
  v_customer  public.customers;
  v_trade     boolean := false;
  v_item      jsonb;
  v_product   public.products;
  v_unit      public.units_of_measure;
  v_qty       numeric(14,3);
  v_price     numeric(12,2);
  v_subtotal  numeric(12,2) := 0;
  v_total     numeric(12,2);
  v_tax_total numeric(12,2) := 0;
  v_status    sale_status;
  v_sale      public.sales;
  v_line      numeric(12,2);
  v_share     numeric(12,2);
  v_rate      numeric(6,4);
  v_existing  public.sales;
  v_available numeric;
  v_at        timestamptz;
begin
  v_reg := public.register_by_token(p_register_token);

  select * into v_user from public.app_users where id = p_cashier_id and active;
  if not found then raise exception 'Unknown cashier'; end if;
  if not ('take_payments' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted to take payments';
  end if;

  -- Idempotency first: a replayed offline sale must not create a second row.
  if p_client_ref is not null then
    select * into v_existing from public.sales where client_ref = p_client_ref;
    if found then return v_existing; end if;
  end if;

  -- Trust the device's clock only for sales taken while it was offline; a
  -- future-dated or absurdly old timestamp falls back to now().
  v_at := coalesce(p_created_at, now());
  if v_at > now() + interval '1 day' or v_at < now() - interval '30 days' then
    v_at := now();
  end if;

  if p_discount_amount < 0 then raise exception 'Discount cannot be negative'; end if;
  if jsonb_array_length(p_items) = 0 then raise exception 'Empty sale'; end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers
      where id = p_customer_id and active;
    if not found then raise exception 'Unknown customer'; end if;
    v_trade := v_customer.is_trade;
  end if;

  if p_payment_method = 'account' and p_customer_id is null then
    raise exception 'An account sale needs a customer';
  end if;

  -- Pass 1 — price the basket and validate every line before writing anything.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and active for update;
    if not found then raise exception 'Product not available'; end if;

    select * into v_unit from public.units_of_measure
      where code = v_product.unit_code;

    v_qty := (v_item->>'qty')::numeric;
    if v_qty <= 0 then raise exception 'Invalid quantity for %', v_product.name; end if;

    -- A fraction of a metre is a sale; a fraction of a padlock is a typo.
    if not v_unit.allows_fraction and v_qty <> trunc(v_qty) then
      raise exception '% is sold per % and cannot be split',
        v_product.name, v_unit.name;
    end if;

    if v_product.stock_qty is not null and v_product.stock_qty < v_qty then
      raise exception 'Not enough stock for % (% % on hand)',
        v_product.name, v_product.stock_qty, v_product.unit_code;
    end if;

    v_price := public.price_for(v_product, v_trade);
    v_subtotal := v_subtotal + round(v_price * v_qty, 2);
  end loop;

  if v_subtotal <= 0 then raise exception 'Empty sale'; end if;
  if p_discount_amount > v_subtotal then
    raise exception 'Discount exceeds the sale total';
  end if;

  v_total := v_subtotal - p_discount_amount;

  -- A discount needs an approver. Online the client sends the manager's user id
  -- after a PIN check; offline sync.ts sends the id it verified against the
  -- device credential cache. Either way the approver's permission is rechecked
  -- here, so a forged id for someone without the right still parks the sale.
  v_status := 'completed';
  if p_discount_amount > 0 then
    if 'approve_discount' = any(public.effective_permissions(v_user)) then
      v_approver := v_user;
    elsif p_approved_by is not null then
      select * into v_approver from public.app_users
        where id = p_approved_by and active;
      if not found
         or not ('approve_discount' = any(public.effective_permissions(v_approver)))
      then
        v_approver := null;
      end if;
    end if;
    if v_approver.id is null then v_status := 'pending_approval'; end if;
  end if;

  if p_payment_method = 'account' and v_status = 'completed' then
    v_available := public.customer_available_credit(p_customer_id);
    if v_available is not null and v_total > v_available then
      raise exception 'Over credit limit: % available', round(v_available, 2);
    end if;
  end if;

  insert into public.sales(
    doc_number, cashier_id, cashier_name, customer_id, customer_name,
    trade_pricing, subtotal, discount_amount, discount_reason, tax_amount,
    total, status, payment_method, amount_tendered, change_due,
    paid_cash, paid_card, client_ref, note, register_id, created_at,
    approved_by, approved_by_name)
  values (
    case when v_status = 'completed' then public.next_doc_number('sale') end,
    v_user.id, v_user.name, p_customer_id, v_customer.name,
    v_trade, v_subtotal, p_discount_amount, p_discount_reason, 0,
    v_total, v_status, p_payment_method::payment_method,
    p_amount_tendered,
    case when p_amount_tendered is not null
         then greatest(p_amount_tendered - v_total, 0) end,
    p_paid_cash, p_paid_card, p_client_ref, p_note, v_reg.id, v_at,
    v_approver.id, v_approver.name)
  returning * into v_sale;

  -- Pass 2 — write the lines, spreading any discount pro-rata so each line's
  -- VAT reflects what was actually charged for it.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid;
    v_qty   := (v_item->>'qty')::numeric;
    v_price := public.price_for(v_product, v_trade);
    v_line  := round(v_price * v_qty, 2);
    v_share := case when v_subtotal > 0
                    then round(v_line * v_total / v_subtotal, 2) else 0 end;
    v_rate  := coalesce(public.tax_rate_at(v_product.tax_code, v_at::date), 0);

    insert into public.sale_items(
      sale_id, product_id, sku, name, unit_code, qty, unit_price,
      line_total, tax_code, tax_rate, tax_amount, cost_at_sale)
    values (
      v_sale.id, v_product.id, v_product.sku, v_product.name,
      v_product.unit_code, v_qty, v_price, v_share,
      v_product.tax_code, v_rate,
      round(v_share - (v_share / (1 + v_rate)), 2),
      v_product.cost);
  end loop;

  select coalesce(sum(tax_amount), 0) into v_tax_total
    from public.sale_items where sale_id = v_sale.id;
  update public.sales set tax_amount = v_tax_total
    where id = v_sale.id returning * into v_sale;

  if v_status = 'completed' then
    perform public.settle_stock_for_sale(v_sale.id, -1, 'sale', v_user);
  end if;

  return v_sale;
end;
$$;

alter table public.sales add column if not exists register_id uuid
  references public.registers(id);

-- Till reads -------------------------------------------------------------------

-- Customers the till can charge to, with live balance and headroom.
create function public.pos_list_customers(p_register_token text)
returns table(id uuid, code text, name text, phone text, is_trade boolean,
              credit_limit numeric, balance numeric, available numeric)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.register_by_token(p_register_token);
  return query
    select c.id, c.code, c.name, c.phone, c.is_trade, c.credit_limit,
           public.customer_balance(c.id),
           public.customer_available_credit(c.id)
    from public.customers c
    where c.active
    order by c.name;
end;
$$;

create function public.pos_recent_sales(p_register_token text, p_limit int default 20)
returns table(id uuid, doc_number text, cashier_name text, customer_name text,
              total numeric, tax_amount numeric, status sale_status,
              payment_method payment_method, created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.register_by_token(p_register_token);
  return query
    select s.id, s.doc_number, s.cashier_name, s.customer_name, s.total,
           s.tax_amount, s.status, s.payment_method, s.created_at
    from public.sales s
    order by s.created_at desc
    limit least(greatest(p_limit, 1), 100);
end;
$$;

create function public.pos_sale_items(p_register_token text, p_sale_id uuid)
returns table(name text, sku text, unit_code text, qty numeric,
              unit_price numeric, line_total numeric, tax_amount numeric)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.register_by_token(p_register_token);
  return query
    select si.name, si.sku, si.unit_code, si.qty, si.unit_price,
           si.line_total, si.tax_amount
    from public.sale_items si where si.sale_id = p_sale_id
    order by si.name;
end;
$$;

-- Grants -----------------------------------------------------------------------

revoke execute on function public.register_by_token(text) from anon, authenticated, public;

grant execute on function public.pos_pair_register(text, text)     to anon, authenticated;
grant execute on function public.pos_revoke_register(text, uuid)   to anon, authenticated;
grant execute on function public.pos_list_registers(text)          to anon, authenticated;
grant execute on function public.pos_create_sale(text, uuid, jsonb, uuid, text, numeric, text, uuid, numeric, numeric, numeric, uuid, timestamptz, text)
  to anon, authenticated;
grant execute on function public.pos_list_customers(text)          to anon, authenticated;
grant execute on function public.pos_recent_sales(text, int)       to anon, authenticated;
grant execute on function public.pos_sale_items(text, uuid)        to anon, authenticated;
