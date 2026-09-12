-- Deleting an order that was called off before it ever went out.
--
-- A called-off order is kept: an order number that vanishes is a hole in
-- the record, and a supplier may still be holding the copy that was sent.
-- But an order called off before it went anywhere — a draft raised by
-- mistake, an empty one — is noise on the list, and this deletes it. Only
-- a cancelled order that was never sent and has nothing received against
-- it may go; everything else stays, called off.

create function public.pos_po_delete(
  p_register_token text, p_pin text, p_po_id uuid
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid; v_po public.purchase_orders;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  select * into v_po from public.purchase_orders where id = p_po_id and org_id = v_org;
  if v_po.id is null then raise exception 'Order not found'; end if;
  if v_po.status <> 'cancelled' then
    raise exception 'Only a called-off order can be deleted';
  end if;
  if v_po.sent_at is not null then
    raise exception 'That order went to the supplier; it stays on the record as called off';
  end if;
  if exists (select 1 from public.purchase_order_lines l where l.po_id = v_po.id and l.received_qty > 0) then
    raise exception 'Something was received against that order; it stays on the record';
  end if;
  delete from public.purchase_order_lines where po_id = v_po.id;
  delete from public.purchase_orders where id = v_po.id;
end;
$$;
grant execute on function public.pos_po_delete(text, text, uuid) to anon, authenticated;
