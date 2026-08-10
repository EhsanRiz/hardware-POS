-- Role-based access control: per-user permissions with admin override.
-- Roles set defaults; an admin can tick/untick individual permissions per user.
alter table public.app_users add column if not exists permissions text[] not null default '{}';

update public.app_users set permissions =
  array['take_payments','apply_discount','approve_discount','void_refund',
        'manage_menu','manage_inventory','view_reports']
  where role = 'manager';
update public.app_users set permissions =
  array['take_payments','apply_discount']
  where role = 'employee' and (permissions = '{}' or permissions is null);
update public.app_users set role = 'admin', permissions =
  array['take_payments','apply_discount','approve_discount','void_refund',
        'manage_menu','manage_inventory','view_reports','manage_staff','manage_settings']
  where name = 'Manager' and role = 'manager';

-- Returns the active user for this PIN IF they hold the permission (admins always).
create or replace function public.pos_user_with_perm(p_pin text, p_perm text)
returns public.app_users
language sql stable security definer set search_path = public, extensions as $$
  select u.* from public.app_users u
  where u.active and u.pin_hash = crypt(p_pin, u.pin_hash)
    and (u.role = 'admin' or p_perm = any(u.permissions))
  limit 1;
$$;
revoke all on function public.pos_user_with_perm(text, text) from public;

drop function if exists public.pos_login(text);
create function public.pos_login(p_pin text)
returns table(id uuid, name text, role user_role, phone text, email text, permissions text[])
language sql security definer set search_path = public, extensions as $$
  select u.id, u.name, u.role, u.phone, u.email, u.permissions
  from public.app_users u
  where u.active and u.pin_hash = crypt(p_pin, u.pin_hash)
  limit 1;
$$;
revoke all on function public.pos_login(text) from public;
grant execute on function public.pos_login(text) to anon, authenticated;

create or replace function public.pos_create_sale(
  p_cashier_id uuid, p_items jsonb,
  p_discount_amount numeric default 0, p_discount_reason text default null
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cashier public.app_users; v_product public.products;
  v_item jsonb; v_qty int; v_subtotal numeric(10,2) := 0;
  v_total numeric(10,2); v_status sale_status; v_sale public.sales;
begin
  select * into v_cashier from public.app_users where id = p_cashier_id and active;
  if not found then raise exception 'Invalid cashier'; end if;
  if not (v_cashier.role='admin' or 'take_payments' = any(v_cashier.permissions)) then
    raise exception 'Not permitted to take payments';
  end if;
  if p_discount_amount < 0 then raise exception 'Discount cannot be negative'; end if;
  if p_discount_amount > 0 and not (v_cashier.role='admin' or 'apply_discount' = any(v_cashier.permissions)) then
    raise exception 'Not permitted to apply discounts';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and active;
    if not found then raise exception 'Invalid product in cart'; end if;
    v_qty := (v_item->>'qty')::int;
    if v_qty <= 0 then raise exception 'Invalid quantity'; end if;
    if v_product.stock_qty is not null and v_product.stock_qty < v_qty then
      raise exception 'Not enough stock for %', v_product.name;
    end if;
    v_subtotal := v_subtotal + v_product.price * v_qty;
  end loop;

  if v_subtotal <= 0 then raise exception 'Empty cart'; end if;
  if p_discount_amount > v_subtotal then raise exception 'Discount exceeds subtotal'; end if;
  v_total := v_subtotal - p_discount_amount;

  if p_discount_amount > 0
     and not (v_cashier.role='admin' or 'approve_discount' = any(v_cashier.permissions)) then
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
    case when v_status='completed' and p_discount_amount>0 then v_cashier.id end,
    case when v_status='completed' and p_discount_amount>0 then v_cashier.name end
  ) returning * into v_sale;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::int;
    insert into public.sale_items(sale_id, product_id, name, unit_price, qty, line_total)
    values (v_sale.id, v_product.id, v_product.name, v_product.price, v_qty,
            v_product.price * v_qty);
  end loop;

  if v_status = 'completed' then
    update public.products p set stock_qty = p.stock_qty - x.qty
    from (select (it->>'product_id')::uuid pid, (it->>'qty')::int qty
          from jsonb_array_elements(p_items) it) x
    where p.id = x.pid and p.stock_qty is not null;
  end if;

  return v_sale;
end;
$$;

create or replace function public.pos_approve_sale(
  p_sale_id uuid, p_manager_pin text
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_sale public.sales;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'approve_discount');
  if v_actor.id is null then raise exception 'Not permitted to approve discounts'; end if;

  if exists (
    select 1 from public.sale_items si join public.products p on p.id = si.product_id
    where si.sale_id = p_sale_id and p.stock_qty is not null and p.stock_qty < si.qty
  ) then
    raise exception 'Not enough stock to approve this sale';
  end if;

  update public.sales
     set status='completed', approved_by=v_actor.id, approved_by_name=v_actor.name
   where id = p_sale_id and status='pending_approval'
   returning * into v_sale;
  if not found then raise exception 'Sale is not awaiting approval'; end if;

  update public.products p set stock_qty = p.stock_qty - si.qty
  from public.sale_items si
  where si.sale_id = v_sale.id and p.id = si.product_id and p.stock_qty is not null;

  return v_sale;
end;
$$;

create or replace function public.pos_manager_list_products(p_manager_pin text)
returns setof public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'manage_menu');
  if v_actor.id is null then raise exception 'Not permitted to manage the menu'; end if;
  return query select * from public.products order by category, sort_order, name;
end;
$$;

create or replace function public.pos_manager_upsert_product(
  p_manager_pin text, p_id uuid, p_name text, p_category text, p_price numeric,
  p_image_url text, p_active boolean, p_sort_order int, p_stock_qty int
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_prod public.products;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'manage_menu');
  if v_actor.id is null then raise exception 'Not permitted to manage the menu'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Name is required'; end if;
  if p_price is null or p_price < 0 then raise exception 'Price must be 0 or more'; end if;

  if p_id is null then
    insert into public.products(name, category, price, image_url, active, sort_order, stock_qty)
    values (trim(p_name), coalesce(nullif(trim(p_category), ''), 'Other'),
            p_price, nullif(trim(p_image_url), ''), coalesce(p_active, true),
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
  return v_prod;
end;
$$;

create or replace function public.pos_manager_sales_summary(
  p_manager_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_out jsonb;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'view_reports');
  if v_actor.id is null then raise exception 'Not permitted to view reports'; end if;

  select jsonb_build_object(
    'sales_count', count(*), 'gross', coalesce(sum(subtotal),0),
    'discount', coalesce(sum(discount_amount),0), 'net', coalesce(sum(total),0)
  ) into v_out from public.sales
  where status='completed' and created_at >= p_from and created_at < p_to;

  v_out := v_out || jsonb_build_object('top_items', (
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select si.name, sum(si.qty)::int as qty, sum(si.line_total) as revenue
      from public.sale_items si join public.sales s on s.id = si.sale_id
      where s.status='completed' and s.created_at >= p_from and s.created_at < p_to
      group by si.name order by sum(si.qty) desc limit 5) t));

  v_out := v_out || jsonb_build_object('by_cashier', (
    select coalesce(jsonb_agg(c), '[]'::jsonb) from (
      select cashier_name as name, count(*)::int as sales, sum(total) as net
      from public.sales
      where status='completed' and created_at >= p_from and created_at < p_to
      group by cashier_name order by sum(total) desc) c));
  return v_out;
end;
$$;

create or replace function public.pos_manager_list_sales(
  p_manager_pin text, p_from timestamptz, p_to timestamptz,
  p_cashier_name text default null, p_only_discounted boolean default false,
  p_item_name text default null
) returns setof public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'view_reports');
  if v_actor.id is null then raise exception 'Not permitted to view reports'; end if;
  return query
    select s.* from public.sales s
    where s.status='completed' and s.created_at >= p_from and s.created_at < p_to
      and (p_cashier_name is null or s.cashier_name = p_cashier_name)
      and (not p_only_discounted or s.discount_amount > 0)
      and (p_item_name is null or exists (
            select 1 from public.sale_items si where si.sale_id = s.id and si.name = p_item_name))
    order by s.created_at desc limit 500;
end;
$$;

create or replace function public.pos_manager_sale_items(
  p_manager_pin text, p_sale_id uuid
) returns table(id uuid, name text, unit_price numeric, qty int, line_total numeric)
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'view_reports');
  if v_actor.id is null then raise exception 'Not permitted to view reports'; end if;
  return query select si.id, si.name, si.unit_price, si.qty, si.line_total
    from public.sale_items si where si.sale_id = p_sale_id order by si.name;
end;
$$;

drop function if exists public.pos_manager_list_users(text);
create function public.pos_manager_list_users(p_manager_pin text)
returns table(id uuid, name text, role user_role, active boolean,
              phone text, email text, permissions text[], created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'manage_staff');
  if v_actor.id is null then raise exception 'Not permitted to manage staff'; end if;
  return query select u.id, u.name, u.role, u.active, u.phone, u.email, u.permissions, u.created_at
    from public.app_users u order by u.role, u.name;
end;
$$;

drop function if exists public.pos_manager_upsert_user(text, uuid, text, user_role, text, boolean, text, text);
create function public.pos_manager_upsert_user(
  p_manager_pin text, p_id uuid, p_name text, p_role user_role,
  p_pin text, p_active boolean, p_phone text, p_email text, p_permissions text[]
) returns table(id uuid, name text, role user_role, active boolean,
                phone text, email text, permissions text[])
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_id uuid; v_perms text[] := coalesce(p_permissions, '{}');
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'manage_staff');
  if v_actor.id is null then raise exception 'Not permitted to manage staff'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'Name is required'; end if;

  if (p_role = 'admin' or 'manage_staff' = any(v_perms) or 'manage_settings' = any(v_perms))
     and v_actor.role <> 'admin' then
    raise exception 'Only an admin can grant admin-level access';
  end if;

  if p_pin is not null and p_pin <> '' then
    if length(p_pin) < 4 then raise exception 'PIN must be at least 4 digits'; end if;
    if exists (select 1 from public.app_users u
               where (p_id is null or u.id <> p_id) and u.active
                 and u.pin_hash = crypt(p_pin, u.pin_hash)) then
      raise exception 'That PIN is already in use';
    end if;
  end if;

  if p_id is null then
    if p_pin is null or p_pin = '' then raise exception 'A PIN is required for a new user'; end if;
    insert into public.app_users(name, role, pin_hash, active, phone, email, permissions)
    values (trim(p_name), p_role, crypt(p_pin, gen_salt('bf')), coalesce(p_active, true),
            nullif(trim(p_phone), ''), nullif(trim(p_email), ''), v_perms)
    returning public.app_users.id into v_id;
  else
    update public.app_users set
      name = trim(p_name), role = p_role, active = coalesce(p_active, public.app_users.active),
      phone = nullif(trim(p_phone), ''), email = nullif(trim(p_email), ''),
      permissions = v_perms,
      pin_hash = case when p_pin is not null and p_pin <> ''
                      then crypt(p_pin, gen_salt('bf')) else public.app_users.pin_hash end
    where public.app_users.id = p_id
    returning public.app_users.id into v_id;
    if v_id is null then raise exception 'User not found'; end if;
  end if;

  if not exists (select 1 from public.app_users a where a.role='admin' and a.active) then
    raise exception 'There must be at least one active admin';
  end if;

  return query select u.id, u.name, u.role, u.active, u.phone, u.email, u.permissions
    from public.app_users u where u.id = v_id;
end;
$$;

revoke all on function public.pos_manager_list_users(text) from public;
revoke all on function public.pos_manager_upsert_user(text, uuid, text, user_role, text, boolean, text, text, text[]) from public;
grant execute on function public.pos_manager_list_users(text) to anon, authenticated;
grant execute on function public.pos_manager_upsert_user(text, uuid, text, user_role, text, boolean, text, text, text[]) to anon, authenticated;
