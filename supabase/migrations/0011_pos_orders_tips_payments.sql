-- Open orders (tables/tabs), tips, and cash/card payments.

alter table public.sales add column if not exists tip_amount numeric(10,2) not null default 0;
alter table public.sales add column if not exists payment_method text;
alter table public.sales add column if not exists amount_tendered numeric(10,2);
alter table public.sales add column if not exists change_due numeric(10,2);
alter table public.sales add column if not exists label text;

create or replace function public.pos_cashier_ok(p_cashier_id uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.app_users u where u.id = p_cashier_id and u.active
                 and (u.role='admin' or 'take_payments' = any(u.permissions)));
$$;
revoke all on function public.pos_cashier_ok(uuid) from public;

-- Save (create/update) an OPEN order. No stock movement until it is paid.
create or replace function public.pos_save_order(
  p_cashier_id uuid, p_order_id uuid, p_label text, p_items jsonb
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cashier public.app_users; v_product public.products;
  v_item jsonb; v_qty int; v_subtotal numeric(10,2) := 0; v_sale public.sales;
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
    v_subtotal := v_subtotal + v_product.price * v_qty;
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
    insert into public.sale_items(sale_id, product_id, name, unit_price, qty, line_total)
    values (v_sale.id, v_product.id, v_product.name, v_product.price, v_qty, v_product.price * v_qty);
  end loop;

  return v_sale;
end;
$$;

create function public.pos_list_open_orders(p_cashier_id uuid)
returns table(id uuid, label text, cashier_name text, total numeric, item_count int, created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.pos_cashier_ok(p_cashier_id) then raise exception 'Not permitted'; end if;
  return query
    select s.id, s.label, s.cashier_name, s.total,
      (select count(*)::int from public.sale_items si where si.sale_id = s.id),
      s.created_at
    from public.sales s where s.status='open' order by s.created_at;
end;
$$;

create function public.pos_get_order_items(p_cashier_id uuid, p_order_id uuid)
returns table(product_id uuid, name text, unit_price numeric, qty int)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.pos_cashier_ok(p_cashier_id) then raise exception 'Not permitted'; end if;
  return query select si.product_id, si.name, si.unit_price, si.qty
    from public.sale_items si where si.sale_id = p_order_id;
end;
$$;

create function public.pos_cancel_order(p_cashier_id uuid, p_order_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.pos_cashier_ok(p_cashier_id) then raise exception 'Not permitted'; end if;
  delete from public.sales where id = p_order_id and status = 'open';
  if not found then raise exception 'Open order not found'; end if;
end;
$$;

-- Pay: finalize a fresh cart (p_order_id null) or an open order, with tip,
-- payment method, optional cash tendered, and optional inline discount approval.
create or replace function public.pos_pay_order(
  p_cashier_id uuid, p_order_id uuid, p_items jsonb,
  p_discount_amount numeric, p_discount_reason text,
  p_tip_amount numeric, p_payment_method text,
  p_amount_tendered numeric, p_approver_pin text
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cashier public.app_users; v_approver public.app_users; v_product public.products;
  v_item jsonb; v_qty int; v_subtotal numeric(10,2) := 0;
  v_discount numeric(10,2) := coalesce(p_discount_amount,0);
  v_tip numeric(10,2) := coalesce(p_tip_amount,0);
  v_total numeric(10,2); v_change numeric(10,2);
  v_can_approve boolean; v_approved_by uuid; v_approved_name text; v_sale public.sales;
begin
  select * into v_cashier from public.app_users where id = p_cashier_id and active;
  if not found then raise exception 'Invalid cashier'; end if;
  if not (v_cashier.role='admin' or 'take_payments' = any(v_cashier.permissions)) then
    raise exception 'Not permitted to take payments';
  end if;
  if p_payment_method not in ('cash','card') then raise exception 'Invalid payment method'; end if;
  if v_discount < 0 or v_tip < 0 then raise exception 'Amounts cannot be negative'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid and active;
    if not found then raise exception 'Invalid product in cart'; end if;
    v_qty := (v_item->>'qty')::int;
    if v_qty <= 0 then raise exception 'Invalid quantity'; end if;
    if v_product.stock_qty is not null and v_product.stock_qty < v_qty then
      raise exception 'Not enough stock for %', v_product.name;
    end if;
    v_subtotal := v_subtotal + v_product.price * v_qty;
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
    else
      raise exception 'Discount requires manager approval';
    end if;
  end if;

  v_total := v_subtotal - v_discount + v_tip;

  if p_payment_method = 'cash' and p_amount_tendered is not null then
    if p_amount_tendered < v_total then raise exception 'Cash tendered is less than the total'; end if;
    v_change := p_amount_tendered - v_total;
  end if;

  if p_order_id is null then
    insert into public.sales(
      cashier_id, cashier_name, subtotal, discount_amount, discount_reason,
      tip_amount, total, status, approved_by, approved_by_name,
      payment_method, amount_tendered, change_due)
    values (
      v_cashier.id, v_cashier.name, v_subtotal, v_discount, p_discount_reason,
      v_tip, v_total, 'completed', v_approved_by, v_approved_name,
      p_payment_method, p_amount_tendered, v_change)
    returning * into v_sale;
  else
    update public.sales set
      cashier_id=v_cashier.id, cashier_name=v_cashier.name, subtotal=v_subtotal,
      discount_amount=v_discount, discount_reason=p_discount_reason, tip_amount=v_tip,
      total=v_total, status='completed', approved_by=v_approved_by, approved_by_name=v_approved_name,
      payment_method=p_payment_method, amount_tendered=p_amount_tendered, change_due=v_change
    where id = p_order_id and status = 'open'
    returning * into v_sale;
    if not found then raise exception 'Open order not found'; end if;
    delete from public.sale_items where sale_id = v_sale.id;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::int;
    insert into public.sale_items(sale_id, product_id, name, unit_price, qty, line_total)
    values (v_sale.id, v_product.id, v_product.name, v_product.price, v_qty, v_product.price * v_qty);
  end loop;

  update public.products p set stock_qty = p.stock_qty - x.qty
  from (select (it->>'product_id')::uuid pid, (it->>'qty')::int qty
        from jsonb_array_elements(p_items) it) x
  where p.id = x.pid and p.stock_qty is not null;

  return v_sale;
end;
$$;

-- Reporting: add tips total and a cash/card breakdown.
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
    'discount', coalesce(sum(discount_amount),0), 'tips', coalesce(sum(tip_amount),0),
    'net', coalesce(sum(total),0)
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

  v_out := v_out || jsonb_build_object('by_method', (
    select coalesce(jsonb_object_agg(coalesce(payment_method,'other'), net), '{}'::jsonb) from (
      select payment_method, sum(total) as net from public.sales
      where status='completed' and created_at >= p_from and created_at < p_to
      group by payment_method) m));

  return v_out;
end;
$$;

revoke all on function public.pos_save_order(uuid, uuid, text, jsonb) from public;
revoke all on function public.pos_list_open_orders(uuid) from public;
revoke all on function public.pos_get_order_items(uuid, uuid) from public;
revoke all on function public.pos_cancel_order(uuid, uuid) from public;
revoke all on function public.pos_pay_order(uuid, uuid, jsonb, numeric, text, numeric, text, numeric, text) from public;
grant execute on function public.pos_save_order(uuid, uuid, text, jsonb) to anon, authenticated;
grant execute on function public.pos_list_open_orders(uuid) to anon, authenticated;
grant execute on function public.pos_get_order_items(uuid, uuid) to anon, authenticated;
grant execute on function public.pos_cancel_order(uuid, uuid) to anon, authenticated;
grant execute on function public.pos_pay_order(uuid, uuid, jsonb, numeric, text, numeric, text, numeric, text) to anon, authenticated;
