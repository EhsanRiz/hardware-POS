-- Staff management, sales reporting, and inventory.

alter table public.products add column if not exists stock_qty int; -- null = not tracked

-- ---- Staff management (manager-gated) --------------------------------------

create or replace function public.pos_manager_list_users(p_manager_pin text)
returns table(id uuid, name text, role user_role, active boolean, created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare v_mgr public.app_users;
begin
  select * into v_mgr from public.app_users u
    where u.role='manager' and u.active and u.pin_hash = crypt(p_manager_pin, u.pin_hash) limit 1;
  if not found then raise exception 'Invalid manager PIN'; end if;
  return query select u.id, u.name, u.role, u.active, u.created_at
    from public.app_users u order by u.role, u.name;
end;
$$;

create or replace function public.pos_manager_upsert_user(
  p_manager_pin text, p_id uuid, p_name text, p_role user_role,
  p_pin text, p_active boolean
) returns table(id uuid, name text, role user_role, active boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare v_mgr public.app_users; v_id uuid;
begin
  select * into v_mgr from public.app_users u
    where u.role='manager' and u.active and u.pin_hash = crypt(p_manager_pin, u.pin_hash) limit 1;
  if not found then raise exception 'Invalid manager PIN'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'Name is required'; end if;

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
    insert into public.app_users(name, role, pin_hash, active)
    values (trim(p_name), p_role, crypt(p_pin, gen_salt('bf')), coalesce(p_active, true))
    returning public.app_users.id into v_id;
  else
    update public.app_users set
      name = trim(p_name), role = p_role, active = coalesce(p_active, public.app_users.active),
      pin_hash = case when p_pin is not null and p_pin <> ''
                      then crypt(p_pin, gen_salt('bf')) else public.app_users.pin_hash end
    where public.app_users.id = p_id
    returning public.app_users.id into v_id;
    if v_id is null then raise exception 'User not found'; end if;
  end if;

  if not exists (select 1 from public.app_users a where a.role='manager' and a.active) then
    raise exception 'There must be at least one active manager';
  end if;

  return query select u.id, u.name, u.role, u.active from public.app_users u where u.id = v_id;
end;
$$;

-- ---- Sales reporting (manager-gated) ---------------------------------------

create or replace function public.pos_manager_sales_summary(
  p_manager_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_mgr public.app_users; v_out jsonb;
begin
  select * into v_mgr from public.app_users u
    where u.role='manager' and u.active and u.pin_hash = crypt(p_manager_pin, u.pin_hash) limit 1;
  if not found then raise exception 'Invalid manager PIN'; end if;

  select jsonb_build_object(
    'sales_count', count(*),
    'gross',    coalesce(sum(subtotal), 0),
    'discount', coalesce(sum(discount_amount), 0),
    'net',      coalesce(sum(total), 0)
  ) into v_out
  from public.sales
  where status='completed' and created_at >= p_from and created_at < p_to;

  v_out := v_out || jsonb_build_object('top_items', (
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select si.name, sum(si.qty)::int as qty, sum(si.line_total) as revenue
      from public.sale_items si join public.sales s on s.id = si.sale_id
      where s.status='completed' and s.created_at >= p_from and s.created_at < p_to
      group by si.name order by sum(si.qty) desc limit 5
    ) t
  ));

  v_out := v_out || jsonb_build_object('by_cashier', (
    select coalesce(jsonb_agg(c), '[]'::jsonb) from (
      select cashier_name as name, count(*)::int as sales, sum(total) as net
      from public.sales
      where status='completed' and created_at >= p_from and created_at < p_to
      group by cashier_name order by sum(total) desc
    ) c
  ));

  return v_out;
end;
$$;

-- ---- Product upsert now includes stock --------------------------------------

drop function if exists public.pos_manager_upsert_product(text, uuid, text, text, numeric, text, boolean, int);

create or replace function public.pos_manager_upsert_product(
  p_manager_pin text, p_id uuid, p_name text, p_category text, p_price numeric,
  p_image_url text, p_active boolean, p_sort_order int, p_stock_qty int
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_mgr public.app_users; v_prod public.products;
begin
  select * into v_mgr from public.app_users
    where role='manager' and active and pin_hash = crypt(p_manager_pin, pin_hash) limit 1;
  if not found then raise exception 'Invalid manager PIN'; end if;
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

-- ---- Sale creation / approval enforce + decrement stock --------------------

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
  if p_discount_amount < 0 then raise exception 'Discount cannot be negative'; end if;

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
declare v_manager public.app_users; v_sale public.sales;
begin
  select * into v_manager from public.app_users
    where role='manager' and active and pin_hash = crypt(p_manager_pin, pin_hash) limit 1;
  if not found then raise exception 'Invalid manager PIN'; end if;

  if exists (
    select 1 from public.sale_items si join public.products p on p.id = si.product_id
    where si.sale_id = p_sale_id and p.stock_qty is not null and p.stock_qty < si.qty
  ) then
    raise exception 'Not enough stock to approve this sale';
  end if;

  update public.sales
     set status='completed', approved_by=v_manager.id, approved_by_name=v_manager.name
   where id = p_sale_id and status='pending_approval'
   returning * into v_sale;
  if not found then raise exception 'Sale is not awaiting approval'; end if;

  update public.products p set stock_qty = p.stock_qty - si.qty
  from public.sale_items si
  where si.sale_id = v_sale.id and p.id = si.product_id and p.stock_qty is not null;

  return v_sale;
end;
$$;

-- Grants
revoke all on function public.pos_manager_list_users(text) from public;
revoke all on function public.pos_manager_upsert_user(text, uuid, text, user_role, text, boolean) from public;
revoke all on function public.pos_manager_sales_summary(text, timestamptz, timestamptz) from public;
revoke all on function public.pos_manager_upsert_product(text, uuid, text, text, numeric, text, boolean, int, int) from public;
grant execute on function public.pos_manager_list_users(text) to anon, authenticated;
grant execute on function public.pos_manager_upsert_user(text, uuid, text, user_role, text, boolean) to anon, authenticated;
grant execute on function public.pos_manager_sales_summary(text, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.pos_manager_upsert_product(text, uuid, text, text, numeric, text, boolean, int, int) to anon, authenticated;
