-- 0072 — order what you ticked, not everything that is short.
--
-- pos_po_from_reorder put every short line onto one supplier's order. A shop
-- does not buy allen keys, a ladder and 100m of twin-and-earth from the same
-- merchant, so the first thing anybody had to do with a raised order was
-- delete most of it — and deleting lines off a document is exactly where
-- mistakes get made.
--
-- Filtering by "who we last bought this from" was the obvious alternative and
-- is wrong today: no product in the catalogue has a supplier code against it
-- yet, so the filter would raise an empty order every time. The person doing
-- the buying knows who sells what. Let them say.

-- One more argument is a NEW signature, so the old one goes first or every
-- existing caller becomes ambiguous (CLAUDE.md).
drop function if exists public.pos_po_from_reorder(text, text, uuid, date);

/**
 * The lines somebody ticked on the reorder list, as an order.
 *
 * `p_product_ids` null means all of them, which is what the whole-list button
 * did and what the database tests exercise. A list means those and only
 * those — and only where they are genuinely on the reorder list, because this
 * function's meaning is "from the reorder list". Anything else goes on by
 * hand through pos_po_set_line.
 *
 * Quantity is the shortfall plus what has sold in the last month, floored at
 * one (0071): a shop that orders exactly the shortfall is back on the list
 * the same week.
 */
create function public.pos_po_from_reorder(
  p_register_token text, p_pin text, p_supplier_id uuid,
  p_expected_on date default null, p_product_ids uuid[] default null
) returns public.purchase_orders
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid; v_row public.purchase_orders; v_n int;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  v_row := public.pos_po_create(p_register_token, p_pin, p_supplier_id,
                                p_expected_on, 'From the reorder list');

  insert into public.purchase_order_lines
    (po_id, product_id, sku, name, unit_code, qty, unit_cost)
  select v_row.id, p.id, p.sku, p.name, p.unit_code,
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
     and p.stock_qty <= p.reorder_level
     and (p_product_ids is null or p.id = any(p_product_ids));

  get diagnostics v_n = row_count;
  -- An order with nothing on it cannot be sent and cannot be got rid of
  -- except by cancelling it, so it is refused rather than created. The whole
  -- statement rolls back, including the document number.
  if v_n = 0 then
    raise exception 'Nothing on the reorder list was selected';
  end if;

  return v_row;
end;
$$;

grant execute on function public.pos_po_from_reorder(text, text, uuid, date, uuid[])
  to anon, authenticated;
