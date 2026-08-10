-- Multi-tenant: organizations, phone-based staff, per-org documents.
--
-- The rule that carries the whole migration: org_id is NEVER accepted from the
-- client. It is derived from the credential — a register token resolves to a
-- register that belongs to an org; a PIN resolves to a user that belongs to an
-- org. Our RPCs are SECURITY DEFINER, so RLS cannot catch a missing filter;
-- deriving the org at the top of every function is the defence.

create table public.organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  vertical      text not null default 'hardware',
  address_line1 text not null default '',
  address_line2 text not null default '',
  phone         text not null default '',
  vat_number    text not null default '',
  registration_number text not null default '',
  currency      text not null default 'R',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
alter table public.organizations enable row level security;

-- Existing data becomes org #1.
insert into public.organizations (name, vertical, address_line1, address_line2, phone, vat_number, currency)
select coalesce((select value from public.settings where key='shop_name'), 'Ladybrand Hardware'),
       'hardware',
       coalesce((select value from public.settings where key='address_line1'), ''),
       coalesce((select value from public.settings where key='address_line2'), ''),
       coalesce((select value from public.settings where key='phone'), ''),
       coalesce((select value from public.settings where key='vat_number'), ''),
       coalesce((select value from public.settings where key='currency'), 'R');

-- org_id everywhere ----------------------------------------------------------
do $$
declare v_org uuid; t text;
begin
  select id into v_org from public.organizations limit 1;
  foreach t in array array['app_users','registers','products','categories',
    'customers','customer_payments','suppliers','sales','stock_movements'] loop
    execute format('alter table public.%I add column org_id uuid references public.organizations(id)', t);
    execute format('update public.%I set org_id = %L', t, v_org);
    execute format('alter table public.%I alter column org_id set not null', t);
    execute format('create index %I_org_idx on public.%I (org_id)', t, t);
  end loop;
end $$;

-- Uniqueness moves inside the org: two shops may both have SKU CEM-425-50.
alter table public.products drop constraint products_sku_key;
alter table public.products drop constraint products_barcode_key;
create unique index products_org_sku_key on public.products (org_id, sku);
create unique index products_org_barcode_key on public.products (org_id, barcode)
  where barcode is not null;
alter table public.categories drop constraint categories_name_key;
create unique index categories_org_name_key on public.categories (org_id, name);
alter table public.customers drop constraint customers_code_key;
create unique index customers_org_code_key on public.customers (org_id, code)
  where code is not null;

-- Staff get phones. Globally unique: the phone IS the tenant lookup, so no org
-- code exists anywhere in the product.
alter table public.app_users add column phone_e164 text;
alter table public.app_users add column status text not null default 'active'
  check (status in ('invited','active','disabled'));
alter table public.app_users alter column pin_hash drop not null; -- invited users have none yet
create unique index app_users_phone_key on public.app_users (phone_e164)
  where phone_e164 is not null;

-- Per-org document sequences: every shop gets its own gapless INV-000001.
alter table public.doc_sequences add column org_id uuid references public.organizations(id);
update public.doc_sequences set org_id = (select id from public.organizations limit 1);
alter table public.doc_sequences alter column org_id set not null;
alter table public.doc_sequences drop constraint doc_sequences_pkey;
alter table public.doc_sequences add primary key (org_id, doc_type);

create or replace function public.next_doc_number(p_org uuid, p_doc_type text)
returns text language plpgsql as $$
declare v_seq public.doc_sequences;
begin
  -- New orgs get their sequences lazily.
  insert into public.doc_sequences (org_id, doc_type, prefix)
  values (p_org, p_doc_type,
          case p_doc_type when 'sale' then 'INV-' when 'quote' then 'QUO-'
                          when 'grv' then 'GRV-' else 'CRN-' end)
  on conflict (org_id, doc_type) do nothing;

  select * into v_seq from public.doc_sequences
    where org_id = p_org and doc_type = p_doc_type for update;
  update public.doc_sequences set next_number = next_number + 1
    where org_id = p_org and doc_type = p_doc_type;
  return v_seq.prefix || lpad(v_seq.next_number::text, v_seq.pad_width, '0');
end;
$$;
drop function public.next_doc_number(text);

-- Auth bookkeeping (written only by the auth edge function via service role) --
create table public.auth_otps (
  id         uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  purpose    text not null check (purpose in ('enrol','reset')),
  code_hash  text not null,             -- sha256; the code itself is never stored
  expires_at timestamptz not null,
  attempts   int not null default 0,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);
create index auth_otps_phone_idx on public.auth_otps (phone_e164, created_at desc);

-- One-time permits to set a PIN, minted when a code verifies.
create table public.auth_setpin_tokens (
  token      uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  expires_at timestamptz not null,
  used       boolean not null default false
);

alter table public.auth_otps enable row level security;
alter table public.auth_setpin_tokens enable row level security;

-- Set a PIN with pgcrypto. Service-role only; the anon key can never touch it.
create function public.auth_set_pin(p_phone text, p_pin text)
returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  if p_pin !~ '^\d{6}$' then raise exception 'PIN must be 6 digits'; end if;
  update public.app_users
     set pin_hash = crypt(p_pin, gen_salt('bf')), status = 'active'
   where phone_e164 = p_phone and status <> 'disabled';
  if not found then raise exception 'No such user'; end if;
end;
$$;
revoke execute on function public.auth_set_pin(text, text) from anon, authenticated, public;

-- POS requests from the website form ------------------------------------------
create table public.pos_requests (
  id           uuid primary key default gen_random_uuid(),
  org_name     text not null,
  contact_name text not null,
  email        text not null,
  phone        text,
  country      text,
  vertical     text not null default 'hardware',
  message      text,
  status       text not null default 'new',
  created_at   timestamptz not null default now()
);
alter table public.pos_requests enable row level security;

-- InnovaEarth-side org creation. Run from the SQL editor; not exposed to the API.
-- Creates the shop and invites the manager: they enrol on the site with the OTP
-- and choose their own PIN. Nobody at InnovaEarth ever knows a PIN.
create function public.innova_create_org(
  p_name text, p_manager_name text, p_manager_phone text,
  p_vertical text default 'hardware', p_vat_number text default '',
  p_address1 text default '', p_address2 text default '', p_phone text default ''
) returns uuid language plpgsql security definer
set search_path = public, extensions as $$
declare v_org uuid;
begin
  if p_manager_phone !~ '^\+\d{9,15}$' then
    raise exception 'Manager phone must be E.164, e.g. +27821234567';
  end if;
  insert into public.organizations (name, vertical, vat_number, address_line1, address_line2, phone)
  values (trim(p_name), p_vertical, p_vat_number, p_address1, p_address2, p_phone)
  returning id into v_org;
  insert into public.app_users (org_id, name, role, phone_e164, status, pin_hash)
  values (v_org, trim(p_manager_name), 'admin', p_manager_phone, 'invited', null);
  return v_org;
end;
$$;
revoke execute on function public.innova_create_org(text,text,text,text,text,text,text,text)
  from anon, authenticated, public;

-- RPCs re-derived from credentials ---------------------------------------------

-- Pairing: phone identifies the person globally, PIN proves it, the register is
-- created in THEIR org. The old PIN-only version is ambiguous across orgs.
drop function public.pos_pair_register(text, text);
create function public.pos_pair_register(p_phone text, p_pin text, p_name text)
returns table(register_id uuid, token text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_token text; v_id uuid;
begin
  select * into v_user from public.app_users
   where phone_e164 = p_phone and status = 'active'
     and pin_hash is not null and pin_hash = crypt(p_pin, pin_hash);
  if v_user.id is null then raise exception 'Invalid phone or PIN'; end if;
  if not ('manage_settings' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted: manage_settings';
  end if;
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.registers(org_id, name, token_hash)
  values (v_user.org_id, coalesce(nullif(trim(p_name), ''), 'Till'),
          encode(digest(v_token, 'sha256'), 'hex'))
  returning id into v_id;
  return query select v_id, v_token;
end;
$$;
grant execute on function public.pos_pair_register(text, text, text) to anon, authenticated;

-- Daily sign-in is register-scoped: the PIN is checked only against this shop's
-- staff, so PINs never collide across orgs and the org is implied by the till.
drop function public.pos_login(text);
create function public.pos_login(p_register_token text, p_pin text)
returns table(id uuid, name text, role user_role, phone text, email text,
              permissions text[])
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_reg public.registers; v_user public.app_users;
begin
  v_reg := public.register_by_token(p_register_token);
  select * into v_user from public.app_users u
   where u.org_id = v_reg.org_id and u.status = 'active' and u.active
     and u.pin_hash is not null and u.pin_hash = crypt(p_pin, u.pin_hash)
   limit 1;
  if v_user.id is null then return; end if;
  return query select v_user.id, v_user.name, v_user.role, v_user.phone_e164,
                      v_user.email, public.effective_permissions(v_user);
end;
$$;
grant execute on function public.pos_login(text, text) to anon, authenticated;

-- A PIN alone can no longer identify anyone: two shops' staff may well choose
-- the same six digits. Every PIN check is therefore scoped by the register the
-- request arrives from — token resolves the org, PIN resolves the person
-- WITHIN it. The global helpers go away so nothing can reach for them.
drop function public.user_with_perm(text, text);
drop function public.user_by_pin(text);

create function public.user_with_perm(p_register_token text, p_pin text, p_perm text)
returns public.app_users language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_user public.app_users;
begin
  v_reg := public.register_by_token(p_register_token);
  select * into v_user from public.app_users u
   where u.org_id = v_reg.org_id and u.status = 'active' and u.active
     and u.pin_hash is not null and u.pin_hash = crypt(p_pin, u.pin_hash)
   limit 1;
  if v_user.id is null then raise exception 'Invalid PIN'; end if;
  if not (p_perm = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted: %', p_perm;
  end if;
  return v_user;
end;
$$;
revoke execute on function public.user_with_perm(text, text, text) from anon, authenticated, public;

drop function public.pos_approve_sale(uuid, text);
create function public.pos_approve_sale(p_sale_id uuid, p_register_token text, p_pin text)
returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_sale public.sales; v_available numeric;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'approve_discount');
  select * into v_sale from public.sales
   where id = p_sale_id and org_id = v_user.org_id for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status <> 'pending_approval' then
    raise exception 'Sale is not awaiting approval'; end if;
  if v_sale.payment_method = 'account' then
    v_available := public.customer_available_credit(v_sale.customer_id);
    if v_available is not null and v_sale.total > v_available then
      raise exception 'Over credit limit: % available', round(v_available, 2);
    end if;
  end if;
  update public.sales
     set status = 'completed',
         doc_number = coalesce(doc_number, public.next_doc_number(v_user.org_id, 'sale')),
         approved_by = v_user.id, approved_by_name = v_user.name
   where id = p_sale_id returning * into v_sale;
  perform public.settle_stock_for_sale(p_sale_id, -1, 'sale', v_user);
  return v_sale;
end;
$$;

drop function public.pos_void_sale(uuid, text, text);
create function public.pos_void_sale(
  p_sale_id uuid, p_register_token text, p_pin text, p_reason text default null
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_sale public.sales;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'void_refund');
  select * into v_sale from public.sales
   where id = p_sale_id and org_id = v_user.org_id for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status = 'voided' then raise exception 'Already voided'; end if;
  if v_sale.status = 'completed' then
    perform public.settle_stock_for_sale(p_sale_id, 1, 'void', v_user);
  end if;
  update public.sales
     set status = 'voided', voided_by = v_user.id, voided_at = now(),
         void_reason = p_reason
   where id = p_sale_id returning * into v_sale;
  return v_sale;
end;
$$;

grant execute on function public.pos_approve_sale(uuid, text, text) to anon, authenticated;
grant execute on function public.pos_void_sale(uuid, text, text, text) to anon, authenticated;

-- Old admin signatures out; token-scoped ones defined below.
drop function public.pos_admin_list_products(text);
drop function public.pos_admin_save_product(text, uuid, text, text, text, text, uuid, text, numeric, numeric, numeric, text, numeric, numeric, boolean, text);
drop function public.pos_admin_delete_product(text, uuid);
drop function public.pos_admin_adjust_stock(text, uuid, numeric, text);
drop function public.pos_admin_stock_history(text, uuid, int);
drop function public.pos_admin_save_category(text, uuid, text, int, boolean);
drop function public.pos_admin_delete_category(text, uuid, uuid);
drop function public.pos_admin_import_products(text, jsonb);
drop function public.pos_admin_save_settings(text, jsonb);

-- The catalogue was anon-readable — fine for one shop, a cross-tenant leak for
-- two. It is now reachable only with a register token, scoped to that org.
drop view if exists public.catalogue;
drop policy if exists products_read on public.products;
drop policy if exists categories_read on public.categories;
drop policy if exists settings_read on public.settings;
revoke select on public.products from anon, authenticated;
revoke select on public.categories from anon, authenticated;
revoke select on public.settings from anon, authenticated;

create function public.pos_catalogue(p_register_token text)
returns table(id uuid, sku text, barcode text, name text, description text,
  category_id uuid, category_name text, unit_code text, unit_name text,
  allows_fraction boolean, price_retail numeric, price_trade numeric,
  tax_code text, stock_qty numeric, reorder_level numeric, image_url text,
  sort_order int)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select p.id, p.sku, p.barcode, p.name, p.description, p.category_id,
           c.name, p.unit_code, u.name, u.allows_fraction, p.price_retail,
           p.price_trade, p.tax_code, p.stock_qty, p.reorder_level,
           p.image_url, p.sort_order
    from public.products p
    left join public.categories c on c.id = p.category_id
    join public.units_of_measure u on u.code = p.unit_code
    where p.org_id = v_reg.org_id and p.active
    order by p.sort_order, p.name;
end;
$$;

create function public.pos_categories(p_register_token text)
returns table(id uuid, name text, sort_order int)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query select c.id, c.name, c.sort_order from public.categories c
    where c.org_id = v_reg.org_id and c.active order by c.sort_order;
end;
$$;

create function public.pos_org_settings(p_register_token text)
returns table(shop_name text, address_line1 text, address_line2 text,
              phone text, vat_number text, currency text, registration_number text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query select o.name, o.address_line1, o.address_line2, o.phone,
                      o.vat_number, o.currency, o.registration_number
    from public.organizations o where o.id = v_reg.org_id;
end;
$$;

grant execute on function public.pos_catalogue(text)    to anon, authenticated;
grant execute on function public.pos_categories(text)   to anon, authenticated;
grant execute on function public.pos_org_settings(text) to anon, authenticated;

-- Org-scope the till's existing RPCs -------------------------------------------

create or replace function public.pos_create_sale(
  p_register_token text, p_cashier_id uuid, p_items jsonb,
  p_customer_id uuid default null, p_payment_method text default 'cash',
  p_discount_amount numeric default 0, p_discount_reason text default null,
  p_approved_by uuid default null, p_amount_tendered numeric default null,
  p_paid_cash numeric default null, p_paid_card numeric default null,
  p_client_ref uuid default null, p_created_at timestamptz default null,
  p_note text default null
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
  v_at timestamptz;
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
  if p_payment_method = 'account' and p_customer_id is null then
    raise exception 'An account sale needs a customer';
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

  if p_payment_method = 'account' and v_status = 'completed' then
    v_available := public.customer_available_credit(p_customer_id);
    if v_available is not null and v_total > v_available then
      raise exception 'Over credit limit: % available', round(v_available, 2);
    end if;
  end if;

  insert into public.sales(
    org_id, doc_number, cashier_id, cashier_name, customer_id, customer_name,
    trade_pricing, subtotal, discount_amount, discount_reason, tax_amount,
    total, status, payment_method, amount_tendered, change_due, paid_cash,
    paid_card, client_ref, note, register_id, created_at, approved_by, approved_by_name)
  values (
    v_reg.org_id,
    case when v_status = 'completed' then public.next_doc_number(v_reg.org_id, 'sale') end,
    v_user.id, v_user.name, p_customer_id, v_customer.name, v_trade,
    v_subtotal, p_discount_amount, p_discount_reason, 0, v_total, v_status,
    p_payment_method::payment_method, p_amount_tendered,
    case when p_amount_tendered is not null then greatest(p_amount_tendered - v_total, 0) end,
    p_paid_cash, p_paid_card, p_client_ref, p_note, v_reg.id, v_at,
    v_approver.id, v_approver.name)
  returning * into v_sale;

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

create or replace function public.pos_search_products(
  p_register_token text, p_query text, p_limit int default 25
) returns table(
  id uuid, sku text, barcode text, name text, category_name text,
  unit_code text, unit_name text, allows_fraction boolean,
  price_retail numeric, price_trade numeric, tax_code text,
  stock_qty numeric, reorder_level numeric, image_url text, score real)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_reg public.registers; v_norm text; v_tokens text[]; v_found int;
begin
  v_reg := public.register_by_token(p_register_token);
  v_norm := trim(public.normalize_search_text(p_query));
  if v_norm = '' then return; end if;
  v_tokens := array(select t from unnest(string_to_array(v_norm, ' ')) as t
                    where t <> '' and t <> 'x');
  if array_length(v_tokens, 1) is null then return; end if;

  return query
  select p.id, p.sku, p.barcode, p.name, c.name, p.unit_code, u.name,
         u.allows_fraction, p.price_retail, p.price_trade, p.tax_code,
         p.stock_qty, p.reorder_level, p.image_url,
         (case when p.barcode = trim(p_query) then 100.0
               when lower(p.sku) = lower(trim(p_query)) then 90.0 else 0.0 end
          + similarity(p.search_text, v_norm) * 10.0
          + case when p.search_text like '%' || v_norm || '%' then 5.0 else 0.0 end
          + (1.0 / (1 + length(p.name) / 40.0)))::real
  from public.products p
  left join public.categories c on c.id = p.category_id
  join public.units_of_measure u on u.code = p.unit_code
  where p.org_id = v_reg.org_id and p.active
    and (select bool_and(p.search_text like '%' || tok || '%'
                         or word_similarity(tok, p.search_text) > 0.55)
         from unnest(v_tokens) as tok)
  order by 15 desc, p.name
  limit least(greatest(p_limit, 1), 100);

  get diagnostics v_found = row_count;
  if v_found > 0 then return; end if;

  return query
  select p.id, p.sku, p.barcode, p.name, c.name, p.unit_code, u.name,
         u.allows_fraction, p.price_retail, p.price_trade, p.tax_code,
         p.stock_qty, p.reorder_level, p.image_url,
         (similarity(p.search_text, v_norm) * 10.0
          + (1.0 / (1 + length(p.name) / 40.0)))::real
  from public.products p
  left join public.categories c on c.id = p.category_id
  join public.units_of_measure u on u.code = p.unit_code
  where p.org_id = v_reg.org_id and p.active
    and (select bool_and(exists (
           select 1 from unnest(string_to_array(p.search_text, ' ')) as w
           where w <> '' and levenshtein(tok, w)
             <= case when length(tok) < 4 then 1 else 2 end))
         from unnest(v_tokens) as tok)
  order by 15 desc, p.name
  limit least(greatest(p_limit, 1), 100);
end;
$$;

create or replace function public.pos_list_customers(p_register_token text)
returns table(id uuid, code text, name text, phone text, is_trade boolean,
              credit_limit numeric, balance numeric, available numeric)
language plpgsql security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select c.id, c.code, c.name, c.phone, c.is_trade, c.credit_limit,
           public.customer_balance(c.id), public.customer_available_credit(c.id)
    from public.customers c
    where c.org_id = v_reg.org_id and c.active order by c.name;
end;
$$;

create or replace function public.pos_recent_sales(p_register_token text, p_limit int default 20)
returns table(id uuid, doc_number text, cashier_name text, customer_name text,
              total numeric, tax_amount numeric, status sale_status,
              payment_method payment_method, created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select s.id, s.doc_number, s.cashier_name, s.customer_name, s.total,
           s.tax_amount, s.status, s.payment_method, s.created_at
    from public.sales s where s.org_id = v_reg.org_id
    order by s.created_at desc limit least(greatest(p_limit, 1), 100);
end;
$$;

create or replace function public.pos_sale_items(p_register_token text, p_sale_id uuid)
returns table(name text, sku text, unit_code text, qty numeric,
              unit_price numeric, line_total numeric, tax_amount numeric)
language plpgsql security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select si.name, si.sku, si.unit_code, si.qty, si.unit_price, si.line_total,
           si.tax_amount
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    where si.sale_id = p_sale_id and s.org_id = v_reg.org_id
    order by si.name;
end;
$$;

-- Admin RPCs: scope every query to the caller's own org --------------------------

create or replace function public.pos_admin_list_products(p_register_token text, p_pin text)
returns table(id uuid, sku text, barcode text, name text, description text,
              category_id uuid, category_name text, unit_code text,
              price_retail numeric, price_trade numeric, cost numeric,
              tax_code text, stock_qty numeric, reorder_level numeric,
              image_url text, active boolean, sort_order int)
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_costs boolean;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  v_costs := 'view_cost_prices' = any(public.effective_permissions(v_user));
  return query
    select p.id, p.sku, p.barcode, p.name, p.description, p.category_id,
           c.name, p.unit_code, p.price_retail, p.price_trade,
           case when v_costs then p.cost end, p.tax_code, p.stock_qty,
           p.reorder_level, p.image_url, p.active, p.sort_order
    from public.products p
    left join public.categories c on c.id = p.category_id
    where p.org_id = v_user.org_id
    order by p.active desc, c.sort_order nulls last, p.name;
end;
$$;

create or replace function public.pos_admin_save_product(
  p_register_token text, p_pin text, p_id uuid, p_sku text, p_barcode text, p_name text,
  p_description text, p_category_id uuid, p_unit_code text,
  p_price_retail numeric, p_price_trade numeric, p_cost numeric,
  p_tax_code text, p_stock_qty numeric, p_reorder_level numeric,
  p_active boolean, p_image_url text default null
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user public.app_users; v_prod public.products; v_old public.products;
  v_sku text := upper(trim(p_sku)); v_bar text := nullif(trim(p_barcode), '');
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  if v_sku is null or v_sku = '' then raise exception 'A SKU is required'; end if;
  if trim(coalesce(p_name,'')) = '' then raise exception 'A name is required'; end if;
  if p_price_retail is null or p_price_retail < 0 then
    raise exception 'A retail price is required'; end if;
  if not exists (select 1 from public.units_of_measure where code = p_unit_code) then
    raise exception 'Unknown unit: %', p_unit_code; end if;
  if p_category_id is not null and not exists (select 1 from public.categories
     where id = p_category_id and org_id = v_user.org_id) then
    raise exception 'Unknown department'; end if;
  if exists (select 1 from public.products where org_id = v_user.org_id
             and sku = v_sku and (p_id is null or id <> p_id)) then
    raise exception 'SKU % is already used', v_sku; end if;
  if v_bar is not null and exists (select 1 from public.products
             where org_id = v_user.org_id and barcode = v_bar
             and (p_id is null or id <> p_id)) then
    raise exception 'Barcode % is already used by another product', v_bar; end if;

  if p_id is null then
    insert into public.products(org_id, sku, barcode, name, description,
      category_id, unit_code, price_retail, price_trade, cost, tax_code,
      stock_qty, reorder_level, active, image_url)
    values (v_user.org_id, v_sku, v_bar, trim(p_name),
      nullif(trim(p_description),''), p_category_id, p_unit_code,
      p_price_retail, p_price_trade, p_cost, coalesce(p_tax_code,'standard'),
      p_stock_qty, p_reorder_level, coalesce(p_active,true), p_image_url)
    returning * into v_prod;
    if v_prod.stock_qty is not null and v_prod.stock_qty <> 0 then
      insert into public.stock_movements(org_id, product_id, qty_delta,
        qty_after, reason, by_user_id, by_name, note)
      values (v_user.org_id, v_prod.id, v_prod.stock_qty, v_prod.stock_qty,
        'opening', v_user.id, v_user.name, 'Opening stock');
    end if;
  else
    select * into v_old from public.products
      where id = p_id and org_id = v_user.org_id;
    if not found then raise exception 'Product not found'; end if;
    update public.products set
      sku = v_sku, barcode = v_bar, name = trim(p_name),
      description = nullif(trim(p_description),''), category_id = p_category_id,
      unit_code = p_unit_code, price_retail = p_price_retail,
      price_trade = p_price_trade,
      cost = case when 'view_cost_prices' = any(public.effective_permissions(v_user))
                  then p_cost else v_old.cost end,
      tax_code = coalesce(p_tax_code,'standard'),
      reorder_level = p_reorder_level, active = coalesce(p_active, true),
      image_url = coalesce(p_image_url, v_old.image_url)
    where id = p_id returning * into v_prod;
    if p_stock_qty is distinct from v_old.stock_qty then
      if v_old.stock_qty is null or p_stock_qty is null then
        update public.products set stock_qty = p_stock_qty where id = p_id
          returning * into v_prod;
        if p_stock_qty is not null then
          insert into public.stock_movements(org_id, product_id, qty_delta,
            qty_after, reason, by_user_id, by_name, note)
          values (v_user.org_id, p_id, p_stock_qty, p_stock_qty, 'opening',
            v_user.id, v_user.name, 'Started tracking stock');
        end if;
      else
        raise exception 'Use the stock adjustment to change quantity, so the movement is recorded';
      end if;
    end if;
  end if;
  return v_prod;
end;
$$;

create or replace function public.pos_admin_delete_product(p_register_token text, p_pin text, p_id uuid)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_sold boolean;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  if not exists (select 1 from public.products
                 where id = p_id and org_id = v_user.org_id) then
    raise exception 'Product not found'; end if;
  select exists (select 1 from public.sale_items where product_id = p_id) into v_sold;
  if v_sold then
    update public.products set active = false where id = p_id;
    return 'deactivated';
  end if;
  delete from public.stock_movements where product_id = p_id;
  delete from public.products where id = p_id;
  return 'deleted';
end;
$$;

create or replace function public.pos_admin_adjust_stock(
  p_register_token text, p_pin text, p_product_id uuid, p_new_qty numeric, p_note text default null
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_prod public.products; v_delta numeric;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_inventory');
  select * into v_prod from public.products
    where id = p_product_id and org_id = v_user.org_id for update;
  if not found then raise exception 'Product not found'; end if;
  if v_prod.stock_qty is null then
    raise exception 'Stock is not tracked for %', v_prod.name; end if;
  if p_new_qty is null or p_new_qty < 0 then
    raise exception 'Counted quantity cannot be negative'; end if;
  v_delta := p_new_qty - v_prod.stock_qty;
  if v_delta = 0 then return v_prod; end if;
  perform public.apply_stock(p_product_id, v_delta, 'adjustment', null, null,
                             v_user, coalesce(p_note, 'Manual adjustment'));
  select * into v_prod from public.products where id = p_product_id;
  return v_prod;
end;
$$;

create or replace function public.pos_admin_stock_history(
  p_register_token text, p_pin text, p_product_id uuid, p_limit int default 50
) returns table(at timestamptz, qty_delta numeric, qty_after numeric,
                reason stock_reason, by_name text, note text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_inventory');
  return query
    select m.created_at, m.qty_delta, m.qty_after, m.reason, m.by_name, m.note
    from public.stock_movements m
    join public.products p on p.id = m.product_id
    where m.product_id = p_product_id and p.org_id = v_user.org_id
    order by m.created_at desc limit least(greatest(p_limit, 1), 200);
end;
$$;

create or replace function public.pos_admin_save_category(
  p_register_token text, p_pin text, p_id uuid, p_name text, p_sort_order int, p_active boolean
) returns public.categories
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_cat public.categories;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  if trim(coalesce(p_name,'')) = '' then raise exception 'A name is required'; end if;
  if p_id is null then
    insert into public.categories(org_id, name, sort_order, active)
    values (v_user.org_id, trim(p_name), coalesce(p_sort_order,0),
            coalesce(p_active,true))
    returning * into v_cat;
  else
    update public.categories
       set name = trim(p_name), sort_order = coalesce(p_sort_order,0),
           active = coalesce(p_active,true)
     where id = p_id and org_id = v_user.org_id returning * into v_cat;
    if not found then raise exception 'Category not found'; end if;
  end if;
  return v_cat;
end;
$$;

create or replace function public.pos_admin_delete_category(
  p_register_token text, p_pin text, p_id uuid, p_reassign_to uuid default null
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  if p_reassign_to is not null and not exists (select 1 from public.categories
     where id = p_reassign_to and org_id = v_user.org_id) then
    raise exception 'Unknown destination department'; end if;
  update public.products set category_id = p_reassign_to
    where category_id = p_id and org_id = v_user.org_id;
  delete from public.categories where id = p_id and org_id = v_user.org_id;
end;
$$;

create or replace function public.pos_admin_import_products(p_register_token text, p_pin text, p_rows jsonb)
returns table(row_no int, sku text, outcome text, detail text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user public.app_users; v_row jsonb; v_i int := 0; v_sku text;
  v_cat uuid; v_id uuid;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_sku := upper(trim(coalesce(v_row->>'sku', '')));
    begin
      if v_sku = '' then raise exception 'Missing SKU'; end if;
      v_cat := null;
      if coalesce(trim(v_row->>'category'), '') <> '' then
        select c.id into v_cat from public.categories c
          where c.org_id = v_user.org_id
            and lower(c.name) = lower(trim(v_row->>'category'));
        if v_cat is null then
          insert into public.categories(org_id, name)
            values (v_user.org_id, trim(v_row->>'category'))
            returning id into v_cat;
        end if;
      end if;
      select p.id into v_id from public.products p
        where p.org_id = v_user.org_id and p.sku = v_sku;
      if v_id is not null then
        update public.products p set
          name = coalesce(nullif(trim(v_row->>'name'),''), p.name),
          barcode = coalesce(nullif(trim(v_row->>'barcode'),''), p.barcode),
          category_id = coalesce(v_cat, p.category_id),
          unit_code = coalesce(nullif(trim(v_row->>'unit'),''), p.unit_code),
          price_retail = coalesce((v_row->>'price')::numeric, p.price_retail),
          price_trade = coalesce((v_row->>'trade')::numeric, p.price_trade),
          cost = coalesce((v_row->>'cost')::numeric, p.cost),
          reorder_level = coalesce((v_row->>'reorder')::numeric, p.reorder_level)
        where p.id = v_id;
        return query select v_i, v_sku, 'updated'::text, null::text;
      else
        insert into public.products(org_id, sku, barcode, name, category_id,
          unit_code, price_retail, price_trade, cost, stock_qty, reorder_level)
        values (v_user.org_id, v_sku, nullif(trim(v_row->>'barcode'),''),
          nullif(trim(v_row->>'name'),''), v_cat,
          coalesce(nullif(trim(v_row->>'unit'),''), 'ea'),
          (v_row->>'price')::numeric, (v_row->>'trade')::numeric,
          (v_row->>'cost')::numeric, (v_row->>'stock')::numeric,
          (v_row->>'reorder')::numeric)
        returning id into v_id;
        if (v_row->>'stock') is not null then
          insert into public.stock_movements(org_id, product_id, qty_delta,
            qty_after, reason, by_user_id, by_name, note)
          values (v_user.org_id, v_id, (v_row->>'stock')::numeric,
            (v_row->>'stock')::numeric, 'opening', v_user.id, v_user.name,
            'Imported opening stock');
        end if;
        return query select v_i, v_sku, 'created'::text, null::text;
      end if;
    exception when others then
      return query select v_i, v_sku, 'rejected'::text, sqlerrm;
    end;
  end loop;
end;
$$;

create or replace function public.pos_admin_save_settings(p_register_token text, p_pin text, p_settings jsonb)
returns void
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
    registration_number = coalesce(p_settings->>'registration_number', registration_number)
  where id = v_user.org_id;
end;
$$;

grant execute on function public.pos_admin_list_products(text, text) to anon, authenticated;
grant execute on function public.pos_admin_save_product(text, text, uuid, text, text, text, text, uuid, text, numeric, numeric, numeric, text, numeric, numeric, boolean, text) to anon, authenticated;
grant execute on function public.pos_admin_delete_product(text, text, uuid) to anon, authenticated;
grant execute on function public.pos_admin_adjust_stock(text, text, uuid, numeric, text) to anon, authenticated;
grant execute on function public.pos_admin_stock_history(text, text, uuid, int) to anon, authenticated;
grant execute on function public.pos_admin_save_category(text, text, uuid, text, int, boolean) to anon, authenticated;
grant execute on function public.pos_admin_delete_category(text, text, uuid, uuid) to anon, authenticated;
grant execute on function public.pos_admin_import_products(text, text, jsonb) to anon, authenticated;
grant execute on function public.pos_admin_save_settings(text, text, jsonb) to anon, authenticated;

-- The settings table is superseded by columns on organizations.
drop table public.settings;
