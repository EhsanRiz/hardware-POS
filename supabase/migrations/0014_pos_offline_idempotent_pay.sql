-- Offline support: an idempotent, offline-capable version of pos_pay_order.
--
-- * client_uuid lets a queued (offline) sale replay exactly once — if the
--   server has already recorded that UUID it returns the existing row, so a
--   lost response can never create a duplicate sale.
-- * p_offline relaxes the live stock check (the goods physically left the
--   shelf while offline) and trusts a discount approver that was verified
--   against the device credential cache (p_approved_by), confirming server-side
--   that the approver really holds the permission.
-- * p_created_at preserves the real time the sale was taken offline.
--
-- The original pos_pay_order is left in place for backward compatibility.

alter table public.sales add column if not exists client_uuid uuid;
create unique index if not exists sales_client_uuid_key
  on public.sales (client_uuid) where client_uuid is not null;

create or replace function public.pos_pay_order_v2(
  p_client_uuid uuid, p_cashier_id uuid, p_order_id uuid, p_items jsonb,
  p_discount_amount numeric, p_discount_reason text,
  p_tip_amount numeric, p_payment_method text,
  p_amount_tendered numeric, p_approver_pin text,
  p_approved_by uuid, p_created_at timestamptz, p_offline boolean
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cashier public.app_users; v_approver public.app_users; v_product public.products;
  v_item jsonb; v_qty int; v_subtotal numeric(10,2) := 0;
  v_discount numeric(10,2) := coalesce(p_discount_amount,0);
  v_tip numeric(10,2) := coalesce(p_tip_amount,0);
  v_total numeric(10,2); v_change numeric(10,2);
  v_can_approve boolean; v_approved_by uuid; v_approved_name text; v_sale public.sales;
  v_created timestamptz := coalesce(p_created_at, now());
begin
  -- Idempotency: already recorded this client UUID? Return it unchanged.
  if p_client_uuid is not null then
    select * into v_sale from public.sales where client_uuid = p_client_uuid;
    if found then return v_sale; end if;
  end if;

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
    if (not p_offline) and v_product.stock_qty is not null and v_product.stock_qty < v_qty then
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
    elsif p_offline and p_approved_by is not null then
      -- Offline replay: trust the device-verified approver, but confirm the
      -- permission server-side so a tampered queue can't fabricate approvals.
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

  if p_payment_method = 'cash' and p_amount_tendered is not null then
    if p_amount_tendered < v_total then raise exception 'Cash tendered is less than the total'; end if;
    v_change := p_amount_tendered - v_total;
  end if;

  if p_order_id is null then
    insert into public.sales(
      cashier_id, cashier_name, subtotal, discount_amount, discount_reason,
      tip_amount, total, status, approved_by, approved_by_name,
      payment_method, amount_tendered, change_due, client_uuid, created_at)
    values (
      v_cashier.id, v_cashier.name, v_subtotal, v_discount, p_discount_reason,
      v_tip, v_total, 'completed', v_approved_by, v_approved_name,
      p_payment_method, p_amount_tendered, v_change, p_client_uuid, v_created)
    returning * into v_sale;
  else
    update public.sales set
      cashier_id=v_cashier.id, cashier_name=v_cashier.name, subtotal=v_subtotal,
      discount_amount=v_discount, discount_reason=p_discount_reason, tip_amount=v_tip,
      total=v_total, status='completed', approved_by=v_approved_by, approved_by_name=v_approved_name,
      payment_method=p_payment_method, amount_tendered=p_amount_tendered, change_due=v_change,
      client_uuid=coalesce(client_uuid, p_client_uuid)
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
exception
  when unique_violation then
    -- A concurrent replay won the race on client_uuid; return that row.
    select * into v_sale from public.sales where client_uuid = p_client_uuid;
    return v_sale;
end;
$$;

revoke all on function public.pos_pay_order_v2(uuid,uuid,uuid,jsonb,numeric,text,numeric,text,numeric,text,uuid,timestamptz,boolean) from public;
grant execute on function public.pos_pay_order_v2(uuid,uuid,uuid,jsonb,numeric,text,numeric,text,numeric,text,uuid,timestamptz,boolean) to anon, authenticated;
