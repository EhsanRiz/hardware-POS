-- Void / refund + inventory management.

alter table public.sales add column if not exists voided_by uuid references public.app_users(id);
alter table public.sales add column if not exists voided_at timestamptz;
alter table public.sales add column if not exists void_reason text;

-- Void (reverse) a completed sale: restores stock, drops it from reports.
create or replace function public.pos_void_sale(
  p_pin text, p_sale_id uuid, p_reason text
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_sale public.sales;
begin
  v_actor := public.pos_user_with_perm(p_pin, 'void_refund');
  if v_actor.id is null then raise exception 'Not permitted to void or refund'; end if;

  select * into v_sale from public.sales where id = p_sale_id;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status <> 'completed' then
    raise exception 'Only a completed sale can be voided';
  end if;

  update public.products p set stock_qty = p.stock_qty + si.qty
  from public.sale_items si
  where si.sale_id = p_sale_id and p.id = si.product_id and p.stock_qty is not null;

  update public.sales set
    status = 'voided', voided_by = v_actor.id, voided_at = now(),
    void_reason = nullif(trim(p_reason), '')
  where id = p_sale_id
  returning * into v_sale;

  return v_sale;
end;
$$;

-- Inventory: set/clear a product's stock (manage_inventory).
create or replace function public.pos_manager_set_stock(
  p_pin text, p_product_id uuid, p_stock_qty int
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_prod public.products;
begin
  v_actor := public.pos_user_with_perm(p_pin, 'manage_inventory');
  if v_actor.id is null then raise exception 'Not permitted to manage inventory'; end if;
  if p_stock_qty is not null and p_stock_qty < 0 then raise exception 'Stock cannot be negative'; end if;
  update public.products set stock_qty = p_stock_qty where id = p_product_id
    returning * into v_prod;
  if not found then raise exception 'Product not found'; end if;
  return v_prod;
end;
$$;

-- Listing products is open to menu OR inventory managers.
create or replace function public.pos_manager_list_products(p_manager_pin text)
returns setof public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  select * into v_user from public.app_users u
    where u.active and u.pin_hash = crypt(p_manager_pin, u.pin_hash)
      and (u.role='admin' or 'manage_menu' = any(u.permissions)
           or 'manage_inventory' = any(u.permissions))
    limit 1;
  if not found then raise exception 'Not permitted'; end if;
  return query select * from public.products order by category, sort_order, name;
end;
$$;

revoke all on function public.pos_void_sale(text, uuid, text) from public;
revoke all on function public.pos_manager_set_stock(text, uuid, int) from public;
grant execute on function public.pos_void_sale(text, uuid, text) to anon, authenticated;
grant execute on function public.pos_manager_set_stock(text, uuid, int) to anon, authenticated;
