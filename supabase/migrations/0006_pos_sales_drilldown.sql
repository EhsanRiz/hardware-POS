-- Sales drill-down: list sales by filters, and fetch a sale's line items.

create or replace function public.pos_manager_list_sales(
  p_manager_pin text, p_from timestamptz, p_to timestamptz,
  p_cashier_name text default null, p_only_discounted boolean default false,
  p_item_name text default null
) returns setof public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare v_mgr public.app_users;
begin
  select * into v_mgr from public.app_users u
    where u.role='manager' and u.active and u.pin_hash = crypt(p_manager_pin, u.pin_hash) limit 1;
  if not found then raise exception 'Invalid manager PIN'; end if;

  return query
    select s.* from public.sales s
    where s.status = 'completed' and s.created_at >= p_from and s.created_at < p_to
      and (p_cashier_name is null or s.cashier_name = p_cashier_name)
      and (not p_only_discounted or s.discount_amount > 0)
      and (p_item_name is null or exists (
            select 1 from public.sale_items si
            where si.sale_id = s.id and si.name = p_item_name))
    order by s.created_at desc
    limit 500;
end;
$$;

create or replace function public.pos_manager_sale_items(
  p_manager_pin text, p_sale_id uuid
) returns table(id uuid, name text, unit_price numeric, qty int, line_total numeric)
language plpgsql security definer set search_path = public, extensions as $$
declare v_mgr public.app_users;
begin
  select * into v_mgr from public.app_users u
    where u.role='manager' and u.active and u.pin_hash = crypt(p_manager_pin, u.pin_hash) limit 1;
  if not found then raise exception 'Invalid manager PIN'; end if;
  return query select si.id, si.name, si.unit_price, si.qty, si.line_total
    from public.sale_items si where si.sale_id = p_sale_id order by si.name;
end;
$$;

revoke all on function public.pos_manager_list_sales(text, timestamptz, timestamptz, text, boolean, text) from public;
revoke all on function public.pos_manager_sale_items(text, uuid) from public;
grant execute on function public.pos_manager_list_sales(text, timestamptz, timestamptz, text, boolean, text) to anon, authenticated;
grant execute on function public.pos_manager_sale_items(text, uuid) to anon, authenticated;
