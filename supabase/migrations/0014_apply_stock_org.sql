-- apply_stock learns about organizations.
--
-- Also found by the boundary test: stock_movements.org_id is NOT NULL, but
-- the pre-tenant apply_stock never set it — the first sale after 0012 died on
-- the audit insert. While here, the product update gains an org filter so a
-- movement can never touch another org's stock even if handed a foreign
-- product id (defence in depth; every caller already filters).

create or replace function public.apply_stock(
  p_product_id uuid,
  p_delta numeric,
  p_reason stock_reason,
  p_ref_table text,
  p_ref_id uuid,
  p_user app_users,
  p_note text default null
) returns void
language plpgsql
set search_path to 'public', 'extensions'
as $$
declare v_after numeric(14,3);
begin
  update public.products
     set stock_qty = stock_qty + p_delta
   where id = p_product_id and org_id = p_user.org_id and stock_qty is not null
  returning stock_qty into v_after;

  if not found then return; end if;

  insert into public.stock_movements(
    org_id, product_id, qty_delta, qty_after, reason, ref_table, ref_id,
    by_user_id, by_name, note)
  values (p_user.org_id, p_product_id, p_delta, v_after, p_reason, p_ref_table,
          p_ref_id, p_user.id, p_user.name, p_note);
end;
$$;
