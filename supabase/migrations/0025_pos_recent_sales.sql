-- ---------------------------------------------------------------------------
-- Recent completed sales for quick receipt re-printing at the till.
-- Any staff member who can take payments can pull the last N invoices (with
-- their line items) so a receipt can be reprinted for a customer.
-- ---------------------------------------------------------------------------
create or replace function public.pos_recent_sales(p_cashier_id uuid, p_limit int default 5)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_out jsonb;
begin
  if not public.pos_cashier_ok(p_cashier_id) then raise exception 'Not permitted'; end if;

  select coalesce(jsonb_agg(row order by ca desc), '[]'::jsonb) into v_out
  from (
    select s.created_at as ca, jsonb_build_object(
      'id', s.id, 'cashier_id', s.cashier_id, 'cashier_name', s.cashier_name,
      'subtotal', s.subtotal, 'discount_amount', s.discount_amount,
      'discount_reason', s.discount_reason, 'tip_amount', s.tip_amount,
      'total', s.total, 'status', s.status, 'approved_by', s.approved_by,
      'approved_by_name', s.approved_by_name, 'payment_method', s.payment_method,
      'amount_tendered', s.amount_tendered, 'change_due', s.change_due,
      'label', s.label, 'account_id', s.account_id, 'created_at', s.created_at,
      'account_name', (select a.name from public.accounts a where a.id = s.account_id),
      'account_balance',
        case when s.account_id is not null then public.pos_account_balance(s.account_id) end,
      'items', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'name', si.name, 'price', si.unit_price, 'qty', si.qty) order by si.id), '[]'::jsonb)
        from public.sale_items si where si.sale_id = s.id)
    ) as row
    from (
      select * from public.sales
      where status = 'completed'
      order by created_at desc
      limit greatest(1, least(coalesce(p_limit, 5), 20))
    ) s
  ) t;

  return v_out;
end;
$$;
revoke all on function public.pos_recent_sales(uuid, int) from public;
grant execute on function public.pos_recent_sales(uuid, int) to anon, authenticated;
