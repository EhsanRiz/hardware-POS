-- ---------------------------------------------------------------------------
-- Open orders with their line items, in a single call.
--
-- The till caches this on the device while online so that previously-saved
-- (server-side) open orders stay visible AND reopenable after the connection
-- drops — the plain list/items RPCs can't be reached offline.
-- ---------------------------------------------------------------------------
create or replace function public.pos_open_orders_full(p_cashier_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_out jsonb;
begin
  if not public.pos_cashier_ok(p_cashier_id) then raise exception 'Not permitted'; end if;
  select coalesce(jsonb_agg(o order by o->>'created_at'), '[]'::jsonb)
    into v_out
  from (
    select jsonb_build_object(
      'id', s.id,
      'label', s.label,
      'cashier_name', s.cashier_name,
      'total', s.total,
      'created_at', s.created_at,
      'item_count', (select count(*)::int from public.sale_items si where si.sale_id = s.id),
      'items', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'product_id', si.product_id, 'name', si.name,
          'unit_price', si.unit_price, 'qty', si.qty)), '[]'::jsonb)
        from public.sale_items si where si.sale_id = s.id)
    ) as o
    from public.sales s where s.status = 'open'
  ) t;
  return v_out;
end;
$$;

revoke all on function public.pos_open_orders_full(uuid) from public;
grant execute on function public.pos_open_orders_full(uuid) to anon, authenticated;
