-- ---------------------------------------------------------------------------
-- Per-item sales history: every completed sale line for one product over a
-- date range, with totals. Powers the Reports → Item history lookup.
-- Matches by product_id, so all sizes/variants of the product are included.
-- ---------------------------------------------------------------------------
create or replace function public.pos_manager_item_history(
  p_manager_pin text, p_product_id uuid, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_out jsonb;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'view_reports');
  if v_actor.id is null then raise exception 'Not permitted to view reports'; end if;

  select jsonb_build_object(
    'total_qty', coalesce(sum(si.qty), 0),
    'total_revenue', coalesce(sum(si.line_total), 0),
    'sale_count', count(distinct s.id),
    'entries', coalesce(jsonb_agg(jsonb_build_object(
        'sale_id', s.id, 'at', s.created_at, 'name', si.name,
        'qty', si.qty, 'unit_price', si.unit_price, 'line_total', si.line_total,
        'cashier_name', s.cashier_name) order by s.created_at desc), '[]'::jsonb)
  ) into v_out
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  where si.product_id = p_product_id
    and s.status = 'completed'
    and s.created_at >= p_from and s.created_at < p_to;

  return v_out;
end;
$$;
revoke all on function public.pos_manager_item_history(text, uuid, timestamptz, timestamptz) from public;
grant execute on function public.pos_manager_item_history(text, uuid, timestamptz, timestamptz) to anon, authenticated;
