-- Coffee Shop POS — core schema
-- Tables, RLS, and the SECURITY DEFINER RPCs that keep PIN checks server-side.
create extension if not exists pgcrypto with schema extensions;

create type user_role as enum ('manager', 'employee');
create type sale_status as enum ('completed', 'pending_approval', 'voided');

-- Staff. PINs are stored as bcrypt hashes (pgcrypto crypt/gen_salt).
create table public.app_users (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  role       user_role not null default 'employee',
  pin_hash   text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.products (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  category   text not null default 'Other',
  price      numeric(10,2) not null check (price >= 0),
  active     boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.sales (
  id               uuid primary key default gen_random_uuid(),
  cashier_id       uuid references public.app_users(id),
  cashier_name     text not null,
  subtotal         numeric(10,2) not null,
  discount_amount  numeric(10,2) not null default 0,
  discount_reason  text,
  total            numeric(10,2) not null,
  status           sale_status not null default 'completed',
  approved_by      uuid references public.app_users(id),
  approved_by_name text,
  created_at       timestamptz not null default now()
);

create table public.sale_items (
  id         uuid primary key default gen_random_uuid(),
  sale_id    uuid not null references public.sales(id) on delete cascade,
  product_id uuid references public.products(id),
  name       text not null,
  unit_price numeric(10,2) not null,
  qty        int not null check (qty > 0),
  line_total numeric(10,2) not null
);

create index on public.sale_items (sale_id);
create index on public.sales (created_at);

-- Row Level Security ---------------------------------------------------------
alter table public.app_users  enable row level security;
alter table public.products   enable row level security;
alter table public.sales      enable row level security;
alter table public.sale_items enable row level security;

-- Only the menu is directly readable by the anon (device) key. Everything
-- sensitive (users, sales) is reached exclusively through the SECURITY DEFINER
-- functions below, so PIN hashes and totals never travel over the anon role.
create policy products_read on public.products
  for select to anon, authenticated using (active);

-- Functions ------------------------------------------------------------------

-- Verify a PIN and return the matching active user (login by PIN).
create or replace function public.pos_login(p_pin text)
returns table(id uuid, name text, role user_role)
language sql security definer set search_path = public, extensions as $$
  select u.id, u.name, u.role
  from public.app_users u
  where u.active and u.pin_hash = crypt(p_pin, u.pin_hash)
  limit 1;
$$;

-- Record a sale. Subtotal is recomputed server-side from product prices so the
-- client cannot tamper with totals. An employee discount yields a sale left in
-- 'pending_approval'; managers (or zero-discount sales) complete immediately.
create or replace function public.pos_create_sale(
  p_cashier_id      uuid,
  p_items           jsonb,
  p_discount_amount numeric default 0,
  p_discount_reason text default null
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cashier  public.app_users;
  v_product  public.products;
  v_item     jsonb;
  v_qty      int;
  v_subtotal numeric(10,2) := 0;
  v_total    numeric(10,2);
  v_status   sale_status;
  v_sale     public.sales;
begin
  select * into v_cashier from public.app_users where id = p_cashier_id and active;
  if not found then raise exception 'Invalid cashier'; end if;
  if p_discount_amount < 0 then raise exception 'Discount cannot be negative'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and active;
    if not found then raise exception 'Invalid product in cart'; end if;
    v_qty := (v_item->>'qty')::int;
    if v_qty <= 0 then raise exception 'Invalid quantity'; end if;
    v_subtotal := v_subtotal + v_product.price * v_qty;
  end loop;

  if v_subtotal <= 0 then raise exception 'Empty cart'; end if;
  if p_discount_amount > v_subtotal then raise exception 'Discount exceeds subtotal'; end if;

  v_total := v_subtotal - p_discount_amount;

  if p_discount_amount > 0 and v_cashier.role = 'employee' then
    v_status := 'pending_approval';
  else
    v_status := 'completed';
  end if;

  insert into public.sales(
    cashier_id, cashier_name, subtotal, discount_amount, discount_reason,
    total, status, approved_by, approved_by_name
  ) values (
    v_cashier.id, v_cashier.name, v_subtotal, p_discount_amount, p_discount_reason,
    v_total, v_status,
    case when v_status = 'completed' and p_discount_amount > 0 then v_cashier.id end,
    case when v_status = 'completed' and p_discount_amount > 0 then v_cashier.name end
  ) returning * into v_sale;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::int;
    insert into public.sale_items(sale_id, product_id, name, unit_price, qty, line_total)
    values (v_sale.id, v_product.id, v_product.name, v_product.price, v_qty,
            v_product.price * v_qty);
  end loop;

  return v_sale;
end;
$$;

-- Release a pending sale. The manager PIN is verified here, server-side.
create or replace function public.pos_approve_sale(
  p_sale_id     uuid,
  p_manager_pin text
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_manager public.app_users;
  v_sale    public.sales;
begin
  select * into v_manager from public.app_users
    where role = 'manager' and active and pin_hash = crypt(p_manager_pin, pin_hash)
    limit 1;
  if not found then raise exception 'Invalid manager PIN'; end if;

  update public.sales
     set status = 'completed', approved_by = v_manager.id, approved_by_name = v_manager.name
   where id = p_sale_id and status = 'pending_approval'
   returning * into v_sale;
  if not found then raise exception 'Sale is not awaiting approval'; end if;

  return v_sale;
end;
$$;

-- Lock function execution to the anon/authenticated roles the app uses.
revoke all on function public.pos_login(text)               from public;
revoke all on function public.pos_create_sale(uuid, jsonb, numeric, text) from public;
revoke all on function public.pos_approve_sale(uuid, text)  from public;
grant execute on function public.pos_login(text)               to anon, authenticated;
grant execute on function public.pos_create_sale(uuid, jsonb, numeric, text) to anon, authenticated;
grant execute on function public.pos_approve_sale(uuid, text)  to anon, authenticated;
