-- 0124 — an item's history says what each delivery cost, and from whom.
--
-- Turf-Ag charged R14.70 for the Emjay elbow; BlueWave, a week later,
-- R15.75. Booking in keeps the item's cost at what was paid last and never
-- touches the selling price — that is the owner's decision, and it stays
-- theirs. The receive screen says so as it happens, but only then. When the
-- item is opened from the catalogue later, to price it or re-price it,
-- nothing said the cost had moved.
--
-- The stock history already held what each receipt cost (0058,
-- stock_movements.unit_cost) and which delivery it was (ref_id). It now
-- returns both, with the supplier's name, so the item can say "Cost went up:
-- R14.70 (Turf-Ag) → R15.75 (BlueWave)".
--
-- Two more columns, so the function is dropped and recreated (CLAUDE.md).

drop function if exists public.pos_admin_stock_history(text, text, uuid, int);
create function public.pos_admin_stock_history(
  p_register_token text, p_pin text, p_product_id uuid, p_limit int default 50
) returns table(at timestamptz, qty_delta numeric, qty_after numeric,
                reason stock_reason, by_name text, note text,
                unit_cost numeric, supplier_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_inventory');
  return query
    select m.created_at, m.qty_delta, m.qty_after, m.reason, m.by_name, m.note,
           m.unit_cost,                                     -- ADDED (0124)
           s.name                                           -- ADDED (0124)
    from public.stock_movements m
    join public.products p on p.id = m.product_id
    left join public.supplier_documents d
      on m.ref_table = 'supplier_documents' and d.id = m.ref_id
    left join public.suppliers s on s.id = d.supplier_id
    where m.product_id = p_product_id and p.org_id = v_user.org_id
    order by m.created_at desc limit least(greatest(p_limit, 1), 200);
end;
$$;
grant execute on function public.pos_admin_stock_history(text, text, uuid, int)
  to anon, authenticated;
