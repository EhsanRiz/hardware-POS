-- Hardware POS — sales, sale lines, stock movements, and the till RPC.
--
-- Four things here are deliberately different from the cafe build:
--
--  1. Quantities are numeric(14,3), not int. Selling 2.5 m of chain is the
--     normal case in a hardware shop, and the unit of measure decides whether
--     a fraction is legitimate at all.
--  2. The VAT rate and amount are resolved once, at the moment of sale, and
--     stored on the line. Reprinting a two-year-old invoice restates exactly
--     what was charged, not what today's rate happens to be.
--  3. Invoice numbers come from a sequence, allocated server-side.
--  4. Every movement of stock is written to an audit table. A cafe can live
--     with a stock number that only goes down; a hardware shop needs to be
--     able to answer "why does the system think we have nine of these?".

create type sale_status as enum ('completed', 'pending_approval', 'voided');
create type payment_method as enum ('cash', 'card', 'account', 'split');

create table public.sales (
  id               uuid primary key default gen_random_uuid(),
  doc_number       text unique,          -- allocated when the sale completes
  cashier_id       uuid references public.app_users(id),
  cashier_name     text not null,
  customer_id      uuid references public.customers(id),
  customer_name    text,
  -- Which price list this sale was rung up on, recorded so a later price
  -- change can't make an old invoice look mispriced.
  trade_pricing    boolean not null default false,

  subtotal         numeric(12,2) not null,   -- VAT-inclusive, before discount
  discount_amount  numeric(12,2) not null default 0,
  discount_reason  text,
  tax_amount       numeric(12,2) not null default 0,  -- VAT within the total
  total            numeric(12,2) not null,   -- VAT-inclusive, after discount

  status           sale_status not null default 'completed',
  payment_method   payment_method,
  amount_tendered  numeric(12,2),
  change_due       numeric(12,2),
  paid_cash        numeric(12,2),
  paid_card        numeric(12,2),

  approved_by      uuid references public.app_users(id),
  approved_by_name text,
  voided_by        uuid references public.app_users(id),
  voided_at        timestamptz,
  void_reason      text,

  session_id       uuid,                 -- cash session, set in 0006
  -- Device-generated idempotency key. A sale queued offline and replayed twice
  -- resolves to the same row instead of charging the customer twice.
  client_ref       uuid unique,
  note             text,
  created_at       timestamptz not null default now()
);

create index sales_created_idx  on public.sales (created_at desc);
create index sales_customer_idx on public.sales (customer_id, created_at desc)
  where customer_id is not null;
create index sales_status_idx   on public.sales (status);

create table public.sale_items (
  id          uuid primary key default gen_random_uuid(),
  sale_id     uuid not null references public.sales(id) on delete cascade,
  product_id  uuid references public.products(id),
  -- Name, SKU and unit are copied, not joined: the invoice must still read
  -- correctly after the product is renamed or deleted.
  sku         text,
  name        text not null,
  unit_code   text not null default 'ea',
  qty         numeric(14,3) not null check (qty > 0),
  unit_price  numeric(12,2) not null,     -- VAT-inclusive
  line_total  numeric(12,2) not null,     -- VAT-inclusive, after its share of discount
  tax_code    text not null default 'standard',
  tax_rate    numeric(6,4) not null default 0,
  tax_amount  numeric(12,2) not null default 0,
  -- Cost at the moment of sale, so margin reporting stays honest when the
  -- replacement cost changes next week.
  cost_at_sale numeric(12,4)
);

create index sale_items_sale_idx    on public.sale_items (sale_id);
create index sale_items_product_idx on public.sale_items (product_id);

-- Customer balances live here rather than in 0003 because they are derived
-- from `sales`, which is defined above.

-- Balance = opening + unpaid charges - payments. Derived, never stored, so it
-- cannot drift away from the documents that justify it.
create function public.customer_balance(p_customer_id uuid)
returns numeric language sql stable as $$
  select round(
    coalesce((select opening_balance from public.customers
              where id = p_customer_id), 0)
    + coalesce((select sum(s.total)
                from public.sales s
                where s.customer_id = p_customer_id
                  and s.payment_method = 'account'
                  and s.status = 'completed'), 0)
    - coalesce((select sum(p.amount)
                from public.customer_payments p
                where p.customer_id = p_customer_id), 0)
  , 2);
$$;

-- Headroom left on the account. Null credit limit means unlimited.
create function public.customer_available_credit(p_customer_id uuid)
returns numeric language sql stable as $$
  select case
    when (select credit_limit from public.customers where id = p_customer_id) is null
      then null
    else (select credit_limit from public.customers where id = p_customer_id)
         - public.customer_balance(p_customer_id)
  end;
$$;


-- Stock audit ----------------------------------------------------------------

create type stock_reason as enum
  ('sale', 'void', 'receipt', 'adjustment', 'stocktake', 'opening');

create table public.stock_movements (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  -- Signed: negative leaves the shop, positive arrives.
  qty_delta   numeric(14,3) not null,
  qty_after   numeric(14,3),
  reason      stock_reason not null,
  ref_table   text,          -- 'sales', 'goods_receipts', ...
  ref_id      uuid,
  note        text,
  by_user_id  uuid references public.app_users(id),
  by_name     text,
  created_at  timestamptz not null default now()
);

create index stock_movements_product_idx
  on public.stock_movements (product_id, created_at desc);

-- Apply a stock change and record why. The single place stock_qty is written,
-- so the movement log can never disagree with the balance.
create function public.apply_stock(
  p_product_id uuid, p_delta numeric, p_reason stock_reason,
  p_ref_table text, p_ref_id uuid, p_user public.app_users, p_note text default null
) returns void language plpgsql as $$
declare v_after numeric(14,3);
begin
  -- Untracked products (stock_qty null) are skipped: nothing to decrement.
  update public.products
     set stock_qty = stock_qty + p_delta
   where id = p_product_id and stock_qty is not null
  returning stock_qty into v_after;

  if not found then return; end if;

  insert into public.stock_movements(
    product_id, qty_delta, qty_after, reason, ref_table, ref_id,
    by_user_id, by_name, note)
  values (p_product_id, p_delta, v_after, p_reason, p_ref_table, p_ref_id,
          p_user.id, p_user.name, p_note);
end;
$$;

-- The till -------------------------------------------------------------------

-- Record a sale. Prices, VAT and totals are all recomputed server-side from the
-- catalogue: the client sends product ids and quantities, nothing more, so a
-- tampered payload cannot change what is charged.
create function public.pos_create_sale(
  p_pin             text,
  p_items           jsonb,          -- [{product_id, qty}]
  p_customer_id     uuid    default null,
  p_payment_method  text    default 'cash',
  p_discount_amount numeric default 0,
  p_discount_reason text    default null,
  p_amount_tendered numeric default null,
  p_paid_cash       numeric default null,
  p_paid_card       numeric default null,
  p_client_ref      uuid    default null,
  p_note            text    default null
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user      public.app_users;
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
begin
  v_user := public.user_with_perm(p_pin, 'take_payments');

  -- Idempotency first: a replayed offline sale must not create a second row.
  if p_client_ref is not null then
    select * into v_existing from public.sales where client_ref = p_client_ref;
    if found then return v_existing; end if;
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
    -- FOR UPDATE: hold the row so a concurrent sale can't oversell the last one.
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

  -- A discount applied by someone who cannot approve one parks the sale until
  -- a manager releases it. Unchanged from the cafe build; still the right rule.
  if p_discount_amount > 0
     and not ('approve_discount' = any(public.effective_permissions(v_user))) then
    v_status := 'pending_approval';
  else
    v_status := 'completed';
  end if;

  -- Credit limit is checked against the live balance, not a cached one.
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
    paid_cash, paid_card, client_ref, note,
    approved_by, approved_by_name)
  values (
    case when v_status = 'completed'
         then public.next_doc_number('sale') end,
    v_user.id, v_user.name, p_customer_id, v_customer.name,
    v_trade, v_subtotal, p_discount_amount, p_discount_reason, 0,
    v_total, v_status, p_payment_method::payment_method,
    p_amount_tendered,
    case when p_amount_tendered is not null
         then greatest(p_amount_tendered - v_total, 0) end,
    p_paid_cash, p_paid_card, p_client_ref, p_note,
    case when v_status = 'completed' and p_discount_amount > 0 then v_user.id end,
    case when v_status = 'completed' and p_discount_amount > 0 then v_user.name end)
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
                    then round(v_line * v_total / v_subtotal, 2)
                    else 0 end;
    v_rate  := coalesce(public.tax_rate_at(v_product.tax_code,
                                           v_sale.created_at::date), 0);

    insert into public.sale_items(
      sale_id, product_id, sku, name, unit_code, qty, unit_price,
      line_total, tax_code, tax_rate, tax_amount, cost_at_sale)
    values (
      v_sale.id, v_product.id, v_product.sku, v_product.name,
      v_product.unit_code, v_qty, v_price, v_share,
      v_product.tax_code, v_rate,
      -- Prices are VAT-inclusive, so the tax is the portion within the line.
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

-- Move stock for every line of a sale. direction -1 sells, +1 puts back.
create function public.settle_stock_for_sale(
  p_sale_id uuid, p_direction int, p_reason stock_reason, p_user public.app_users
) returns void language plpgsql as $$
declare r record;
begin
  for r in select product_id, qty from public.sale_items
           where sale_id = p_sale_id and product_id is not null loop
    perform public.apply_stock(r.product_id, p_direction * r.qty, p_reason,
                               'sales', p_sale_id, p_user, null);
  end loop;
end;
$$;

-- Release a sale that was parked for approval. The approver's PIN is checked
-- here, server-side, and the invoice number is only allocated now — so parked
-- sales never burn a number they might not use.
create function public.pos_approve_sale(p_sale_id uuid, p_pin text)
returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_sale public.sales; v_available numeric;
begin
  v_user := public.user_with_perm(p_pin, 'approve_discount');

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status <> 'pending_approval' then
    raise exception 'Sale is not awaiting approval';
  end if;

  if v_sale.payment_method = 'account' then
    v_available := public.customer_available_credit(v_sale.customer_id);
    if v_available is not null and v_sale.total > v_available then
      raise exception 'Over credit limit: % available', round(v_available, 2);
    end if;
  end if;

  update public.sales
     set status = 'completed',
         doc_number = coalesce(doc_number, public.next_doc_number('sale')),
         approved_by = v_user.id, approved_by_name = v_user.name
   where id = p_sale_id
  returning * into v_sale;

  perform public.settle_stock_for_sale(p_sale_id, -1, 'sale', v_user);
  return v_sale;
end;
$$;

-- Void a completed sale: put the stock back and take it out of the totals.
-- The row is kept — a voided invoice number must stay accounted for.
create function public.pos_void_sale(
  p_sale_id uuid, p_pin text, p_reason text default null
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_sale public.sales;
begin
  v_user := public.user_with_perm(p_pin, 'void_refund');

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status = 'voided' then raise exception 'Already voided'; end if;

  if v_sale.status = 'completed' then
    perform public.settle_stock_for_sale(p_sale_id, 1, 'void', v_user);
  end if;

  update public.sales
     set status = 'voided', voided_by = v_user.id, voided_at = now(),
         void_reason = p_reason
   where id = p_sale_id
  returning * into v_sale;

  return v_sale;
end;
$$;

alter table public.sales           enable row level security;
alter table public.sale_items      enable row level security;
alter table public.stock_movements enable row level security;
