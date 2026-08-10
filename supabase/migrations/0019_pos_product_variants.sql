-- ---------------------------------------------------------------------------
-- Product variants (sizes / options) as first-class rows.
--
-- A product can own variants; each variant has an optional name (e.g. "With
-- Milk"), an optional size (e.g. "Large"), its own price, optional stock, and an
-- availability flag. The cart/receipt store the chosen variant's composed name
-- and price. Products with no variants behave exactly as before.
-- ---------------------------------------------------------------------------

create table if not exists public.product_variants (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  name        text,                                   -- optional, e.g. "With Milk"
  size        text,                                   -- optional, e.g. "Large"
  price       numeric(10,2) not null check (price >= 0),
  stock_qty   int,                                    -- null = not tracked
  active      boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists product_variants_product_idx on public.product_variants(product_id);
alter table public.product_variants enable row level security;

-- The device (anon) key may read available variants directly, like the menu.
drop policy if exists product_variants_read on public.product_variants;
create policy product_variants_read on public.product_variants
  for select to anon, authenticated using (active);

-- Link sale lines to the variant they sold (kept for reporting; the name/price
-- snapshot on the line is the source of truth). SET NULL so deleting a variant
-- never breaks history.
alter table public.sale_items
  add column if not exists variant_id uuid references public.product_variants(id) on delete set null;

-- Compose a human label: base [ name] [ (size)].
create or replace function public.pos_variant_label(p_base text, p_name text, p_size text)
returns text language sql immutable as $$
  select btrim(
    p_base
    || coalesce(' ' || nullif(btrim(p_name), ''), '')
    || coalesce(' (' || nullif(btrim(p_size), '') || ')', '')
  );
$$;

-- ---------------------------------------------------------------------------
-- Manager: list every product with its variants (returns jsonb now).
-- ---------------------------------------------------------------------------
drop function if exists public.pos_manager_list_products(text);
create function public.pos_manager_list_products(p_manager_pin text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_out jsonb;
begin
  select * into v_user from public.app_users u
    where u.active and u.pin_hash = crypt(p_manager_pin, u.pin_hash)
      and (u.role='admin' or 'manage_menu' = any(u.permissions)
           or 'manage_inventory' = any(u.permissions))
    limit 1;
  if not found then raise exception 'Not permitted'; end if;

  select coalesce(jsonb_agg(obj order by cat, so, nm), '[]'::jsonb)
    into v_out
  from (
    select p.category cat, p.sort_order so, p.name nm,
      jsonb_build_object(
        'id', p.id, 'name', p.name, 'category', p.category, 'price', p.price,
        'image_url', p.image_url, 'active', p.active, 'sort_order', p.sort_order,
        'stock_qty', p.stock_qty,
        'variants', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', v.id, 'name', v.name, 'size', v.size, 'price', v.price,
            'stock_qty', v.stock_qty, 'active', v.active, 'sort_order', v.sort_order)
            order by v.sort_order, v.price), '[]'::jsonb)
          from public.product_variants v where v.product_id = p.id)
      ) obj
    from public.products p
  ) t;
  return v_out;
end;
$$;
revoke all on function public.pos_manager_list_products(text) from public;
grant execute on function public.pos_manager_list_products(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Manager: create/update a product and replace its variant set in one call.
-- p_variants: array of {id?, name, size, price, stock_qty, active, sort_order}.
-- Variants present are upserted; any existing variant not in the list is removed.
-- ---------------------------------------------------------------------------
create or replace function public.pos_manager_save_product(
  p_manager_pin text, p_id uuid, p_name text, p_category text, p_price numeric,
  p_image_url text, p_active boolean, p_sort_order int, p_stock_qty int,
  p_variants jsonb
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_actor public.app_users; v_prod public.products;
  v_item jsonb; v_keep uuid[] := array[]::uuid[]; v_vid uuid;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'manage_menu');
  if v_actor.id is null then raise exception 'Not permitted to manage the menu'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Name is required'; end if;
  if p_price is null or p_price < 0 then raise exception 'Price must be 0 or more'; end if;

  if p_id is null then
    insert into public.products(name, category, price, image_url, active, sort_order, stock_qty)
    values (trim(p_name), coalesce(nullif(trim(p_category), ''), 'Other'), p_price,
            nullif(trim(p_image_url), ''), coalesce(p_active, true),
            coalesce(p_sort_order, 0), p_stock_qty)
    returning * into v_prod;
  else
    update public.products set
      name = trim(p_name), category = coalesce(nullif(trim(p_category), ''), 'Other'),
      price = p_price, image_url = nullif(trim(p_image_url), ''),
      active = coalesce(p_active, active), sort_order = coalesce(p_sort_order, sort_order),
      stock_qty = p_stock_qty
    where id = p_id returning * into v_prod;
    if not found then raise exception 'Product not found'; end if;
  end if;

  if p_variants is not null then
    for v_item in select * from jsonb_array_elements(p_variants) loop
      if coalesce(nullif(v_item->>'price', ''), '') = '' then
        raise exception 'Each variant needs a price';
      end if;
      if coalesce(nullif(v_item->>'id', ''), '') = '' then
        insert into public.product_variants(product_id, name, size, price, stock_qty, active, sort_order)
        values (v_prod.id, nullif(trim(v_item->>'name'), ''), nullif(trim(v_item->>'size'), ''),
                (v_item->>'price')::numeric, nullif(v_item->>'stock_qty', '')::int,
                coalesce((v_item->>'active')::boolean, true),
                coalesce((v_item->>'sort_order')::int, 0))
        returning id into v_vid;
      else
        v_vid := (v_item->>'id')::uuid;
        update public.product_variants set
          name = nullif(trim(v_item->>'name'), ''), size = nullif(trim(v_item->>'size'), ''),
          price = (v_item->>'price')::numeric, stock_qty = nullif(v_item->>'stock_qty', '')::int,
          active = coalesce((v_item->>'active')::boolean, true),
          sort_order = coalesce((v_item->>'sort_order')::int, 0)
        where id = v_vid and product_id = v_prod.id;
      end if;
      v_keep := array_append(v_keep, v_vid);
    end loop;
    delete from public.product_variants where product_id = v_prod.id and not (id = any(v_keep));
  end if;

  return jsonb_build_object(
    'id', v_prod.id, 'name', v_prod.name, 'category', v_prod.category, 'price', v_prod.price,
    'image_url', v_prod.image_url, 'active', v_prod.active, 'sort_order', v_prod.sort_order,
    'stock_qty', v_prod.stock_qty,
    'variants', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', v.id, 'name', v.name, 'size', v.size, 'price', v.price,
        'stock_qty', v.stock_qty, 'active', v.active, 'sort_order', v.sort_order)
        order by v.sort_order, v.price), '[]'::jsonb)
      from public.product_variants v where v.product_id = v_prod.id));
end;
$$;
revoke all on function public.pos_manager_save_product(text,uuid,text,text,numeric,text,boolean,int,int,jsonb) from public;
grant execute on function public.pos_manager_save_product(text,uuid,text,text,numeric,text,boolean,int,int,jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Save open order — variant-aware pricing.
-- ---------------------------------------------------------------------------
create or replace function public.pos_save_order(
  p_cashier_id uuid, p_order_id uuid, p_label text, p_items jsonb
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cashier public.app_users; v_product public.products; v_variant public.product_variants;
  v_item jsonb; v_qty int; v_subtotal numeric(10,2) := 0; v_sale public.sales;
  v_price numeric(10,2); v_name text; v_has_variant boolean;
begin
  select * into v_cashier from public.app_users where id = p_cashier_id and active;
  if not found then raise exception 'Invalid cashier'; end if;
  if not (v_cashier.role='admin' or 'take_payments' = any(v_cashier.permissions)) then
    raise exception 'Not permitted to take payments';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid and active;
    if not found then raise exception 'Invalid product in cart'; end if;
    v_qty := (v_item->>'qty')::int;
    if v_qty <= 0 then raise exception 'Invalid quantity'; end if;
    v_has_variant := coalesce(v_item->>'variant_id', '') <> '';
    if v_has_variant then
      select * into v_variant from public.product_variants
        where id = (v_item->>'variant_id')::uuid and product_id = v_product.id and active;
      if not found then raise exception 'Invalid option for %', v_product.name; end if;
      v_price := v_variant.price;
    else
      v_price := v_product.price;
    end if;
    v_subtotal := v_subtotal + v_price * v_qty;
  end loop;
  if v_subtotal <= 0 then raise exception 'Empty order'; end if;

  if p_order_id is null then
    insert into public.sales(cashier_id, cashier_name, subtotal, total, status, label)
    values (v_cashier.id, v_cashier.name, v_subtotal, v_subtotal, 'open', nullif(trim(p_label),''))
    returning * into v_sale;
  else
    update public.sales set subtotal = v_subtotal, total = v_subtotal,
      label = nullif(trim(p_label),'')
    where id = p_order_id and status = 'open'
    returning * into v_sale;
    if not found then raise exception 'Open order not found'; end if;
    delete from public.sale_items where sale_id = v_sale.id;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::int;
    if coalesce(v_item->>'variant_id', '') <> '' then
      select * into v_variant from public.product_variants where id = (v_item->>'variant_id')::uuid;
      v_name := public.pos_variant_label(v_product.name, v_variant.name, v_variant.size);
      insert into public.sale_items(sale_id, product_id, variant_id, name, unit_price, qty, line_total)
      values (v_sale.id, v_product.id, v_variant.id, v_name, v_variant.price, v_qty, v_variant.price * v_qty);
    else
      insert into public.sale_items(sale_id, product_id, variant_id, name, unit_price, qty, line_total)
      values (v_sale.id, v_product.id, null, v_product.name, v_product.price, v_qty, v_product.price * v_qty);
    end if;
  end loop;

  return v_sale;
end;
$$;

-- ---------------------------------------------------------------------------
-- Pay order (v2) — variant-aware pricing, stock check and stock decrement.
-- ---------------------------------------------------------------------------
create or replace function public.pos_pay_order_v2(
  p_client_uuid uuid, p_cashier_id uuid, p_order_id uuid, p_items jsonb,
  p_discount_amount numeric, p_discount_reason text,
  p_tip_amount numeric, p_payment_method text,
  p_amount_tendered numeric, p_approver_pin text,
  p_approved_by uuid, p_created_at timestamptz, p_offline boolean,
  p_account_id uuid
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cashier public.app_users; v_approver public.app_users; v_product public.products;
  v_variant public.product_variants;
  v_item jsonb; v_qty int; v_subtotal numeric(10,2) := 0;
  v_discount numeric(10,2) := coalesce(p_discount_amount,0);
  v_tip numeric(10,2) := coalesce(p_tip_amount,0);
  v_total numeric(10,2); v_change numeric(10,2);
  v_can_approve boolean; v_approved_by uuid; v_approved_name text; v_sale public.sales;
  v_created timestamptz := coalesce(p_created_at, now());
  v_limit numeric(10,2); v_balance numeric(10,2);
  v_price numeric(10,2); v_stock int;
begin
  if p_client_uuid is not null then
    select * into v_sale from public.sales where client_uuid = p_client_uuid;
    if found then return v_sale; end if;
  end if;

  select * into v_cashier from public.app_users where id = p_cashier_id and active;
  if not found then raise exception 'Invalid cashier'; end if;
  if not (v_cashier.role='admin' or 'take_payments' = any(v_cashier.permissions)) then
    raise exception 'Not permitted to take payments';
  end if;
  if p_payment_method not in ('cash','card','account') then raise exception 'Invalid payment method'; end if;
  if v_discount < 0 or v_tip < 0 then raise exception 'Amounts cannot be negative'; end if;

  if p_payment_method = 'account' then
    if p_account_id is null then raise exception 'No account selected'; end if;
    if not exists (select 1 from public.accounts where id = p_account_id and active) then
      raise exception 'Account not found'; end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid and active;
    if not found then raise exception 'Invalid product in cart'; end if;
    v_qty := (v_item->>'qty')::int;
    if v_qty <= 0 then raise exception 'Invalid quantity'; end if;
    if coalesce(v_item->>'variant_id', '') <> '' then
      select * into v_variant from public.product_variants
        where id = (v_item->>'variant_id')::uuid and product_id = v_product.id and active;
      if not found then raise exception 'Invalid option for %', v_product.name; end if;
      v_price := v_variant.price; v_stock := v_variant.stock_qty;
    else
      v_price := v_product.price; v_stock := v_product.stock_qty;
    end if;
    if (not p_offline) and v_stock is not null and v_stock < v_qty then
      raise exception 'Not enough stock for %', v_product.name;
    end if;
    v_subtotal := v_subtotal + v_price * v_qty;
  end loop;
  if v_subtotal <= 0 then raise exception 'Empty order'; end if;
  if v_discount > v_subtotal then raise exception 'Discount exceeds subtotal'; end if;

  if v_discount > 0 then
    if not (v_cashier.role='admin' or 'apply_discount' = any(v_cashier.permissions)) then
      raise exception 'Not permitted to apply discounts';
    end if;
    v_can_approve := v_cashier.role='admin' or 'approve_discount' = any(v_cashier.permissions);
    if v_can_approve then
      v_approved_by := v_cashier.id; v_approved_name := v_cashier.name;
    elsif p_approver_pin is not null then
      v_approver := public.pos_user_with_perm(p_approver_pin, 'approve_discount');
      if v_approver.id is null then raise exception 'Invalid approver PIN'; end if;
      v_approved_by := v_approver.id; v_approved_name := v_approver.name;
    elsif p_offline and p_approved_by is not null then
      select * into v_approver from public.app_users
        where id = p_approved_by and active
          and (role='admin' or 'approve_discount' = any(permissions));
      if not found then raise exception 'Invalid discount approver'; end if;
      v_approved_by := v_approver.id; v_approved_name := v_approver.name;
    else
      raise exception 'Discount requires manager approval';
    end if;
  end if;

  v_total := v_subtotal - v_discount + v_tip;

  if p_payment_method = 'account' and not coalesce(p_offline, false) then
    select credit_limit into v_limit from public.accounts where id = p_account_id;
    if v_limit is not null then
      v_balance := public.pos_account_balance(p_account_id);
      if v_balance + v_total > v_limit then
        raise exception 'Account credit limit exceeded';
      end if;
    end if;
  end if;

  if p_payment_method = 'cash' and p_amount_tendered is not null then
    if p_amount_tendered < v_total then raise exception 'Cash tendered is less than the total'; end if;
    v_change := p_amount_tendered - v_total;
  end if;

  if p_order_id is null then
    insert into public.sales(
      cashier_id, cashier_name, subtotal, discount_amount, discount_reason,
      tip_amount, total, status, approved_by, approved_by_name,
      payment_method, amount_tendered, change_due, client_uuid, created_at, account_id)
    values (
      v_cashier.id, v_cashier.name, v_subtotal, v_discount, p_discount_reason,
      v_tip, v_total, 'completed', v_approved_by, v_approved_name,
      p_payment_method,
      case when p_payment_method='cash' then p_amount_tendered end,
      v_change, p_client_uuid, v_created,
      case when p_payment_method='account' then p_account_id end)
    returning * into v_sale;
  else
    update public.sales set
      cashier_id=v_cashier.id, cashier_name=v_cashier.name, subtotal=v_subtotal,
      discount_amount=v_discount, discount_reason=p_discount_reason, tip_amount=v_tip,
      total=v_total, status='completed', approved_by=v_approved_by, approved_by_name=v_approved_name,
      payment_method=p_payment_method,
      amount_tendered=case when p_payment_method='cash' then p_amount_tendered end,
      change_due=v_change, client_uuid=coalesce(client_uuid, p_client_uuid),
      account_id=case when p_payment_method='account' then p_account_id end
    where id = p_order_id and status = 'open'
    returning * into v_sale;
    if not found then raise exception 'Open order not found'; end if;
    delete from public.sale_items where sale_id = v_sale.id;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::int;
    if coalesce(v_item->>'variant_id', '') <> '' then
      select * into v_variant from public.product_variants where id = (v_item->>'variant_id')::uuid;
      insert into public.sale_items(sale_id, product_id, variant_id, name, unit_price, qty, line_total)
      values (v_sale.id, v_product.id, v_variant.id,
              public.pos_variant_label(v_product.name, v_variant.name, v_variant.size),
              v_variant.price, v_qty, v_variant.price * v_qty);
    else
      insert into public.sale_items(sale_id, product_id, variant_id, name, unit_price, qty, line_total)
      values (v_sale.id, v_product.id, null, v_product.name, v_product.price, v_qty, v_product.price * v_qty);
    end if;
  end loop;

  -- Decrement stock: products for plain lines, variants for variant lines.
  update public.products p set stock_qty = p.stock_qty - x.qty
  from (select (it->>'product_id')::uuid pid, sum((it->>'qty')::int) qty
        from jsonb_array_elements(p_items) it
        where coalesce(it->>'variant_id','') = '' group by 1) x
  where p.id = x.pid and p.stock_qty is not null;

  update public.product_variants v set stock_qty = v.stock_qty - x.qty
  from (select (it->>'variant_id')::uuid vid, sum((it->>'qty')::int) qty
        from jsonb_array_elements(p_items) it
        where coalesce(it->>'variant_id','') <> '' group by 1) x
  where v.id = x.vid and v.stock_qty is not null;

  return v_sale;
exception
  when unique_violation then
    select * into v_sale from public.sales where client_uuid = p_client_uuid;
    return v_sale;
end;
$$;
revoke all on function public.pos_pay_order_v2(uuid,uuid,uuid,jsonb,numeric,text,numeric,text,numeric,text,uuid,timestamptz,boolean,uuid) from public;
grant execute on function public.pos_pay_order_v2(uuid,uuid,uuid,jsonb,numeric,text,numeric,text,numeric,text,uuid,timestamptz,boolean,uuid) to anon, authenticated;
