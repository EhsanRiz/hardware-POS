-- 0071 — an order line of none is not an order line.
--
-- pos_po_from_reorder asks for the shortfall plus a month's selling. Both are
-- zero for a line sitting exactly AT its reorder level that has not sold in a
-- month — which is a perfectly ordinary state for a slow item — and that is a
-- quantity of zero. purchase_order_lines.qty is `check (qty > 0)`, so the
-- insert is a single statement that fails on that one row and takes the whole
-- order with it: the button reports a raw constraint violation and raises
-- nothing at all.
--
-- If a line is on the reorder list the shop wants some of it, so the floor is
-- one. Somebody raising the order can change it before it goes out.

create or replace function public.pos_po_from_reorder(
  p_register_token text, p_pin text, p_supplier_id uuid,
  p_expected_on date default null
) returns public.purchase_orders
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid; v_row public.purchase_orders;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  v_row := public.pos_po_create(p_register_token, p_pin, p_supplier_id,
                                p_expected_on, 'From the reorder list');

  insert into public.purchase_order_lines
    (po_id, product_id, sku, name, unit_code, qty, unit_cost)
  select v_row.id, p.id, p.sku, p.name, p.unit_code,
         -- At least one: it is on the list, so the shop wants some.
         greatest(
           ceil(greatest(p.reorder_level - p.stock_qty, 0)
                + coalesce((select sum(si.qty) from public.sale_items si
                              join public.sales sa on sa.id = si.sale_id
                             where si.product_id = p.id and sa.status = 'completed'
                               and sa.created_at >= now() - interval '30 days'), 0)),
           1),
         p.cost
    from public.products p
   where p.org_id = v_org and p.active
     and p.stock_qty is not null and p.reorder_level is not null
     and p.stock_qty <= p.reorder_level;

  return v_row;
end;
$$;

grant execute on function public.pos_po_from_reorder(text, text, uuid, date)
  to anon, authenticated;
