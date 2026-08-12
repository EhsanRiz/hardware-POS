-- Receiving goods: the way stock actually arrives at a hardware shop.
--
-- A delivery is a pallet with forty lines on one supplier invoice, checked off
-- at the back door. The existing pos_admin_adjust_stock is a stocktake
-- correction — one product, one counted figure — and using it to book in a
-- delivery would mean forty separate "adjustments" with no common reference,
-- which is an audit trail that explains nothing.
--
-- One RPC per delivery, one movement per line, every movement stamped
-- 'receipt' and carrying the supplier's document number, so that six months
-- later "where did these 200 bags come from" has an answer.
--
-- New stock (stock_qty null, meaning untracked) is deliberately NOT switched on
-- here: whether a product is tracked at all is a catalogue decision, not a
-- side effect of a delivery.

create or replace function public.pos_receive_stock(
  p_register_token text, p_pin text,
  -- [{ "product_id": "…", "qty": 40 }, …]
  p_lines jsonb,
  p_reference text default null,
  p_note text default null
) returns table(product_id uuid, name text, received numeric, stock_qty numeric)
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_user public.app_users; v_line jsonb; v_prod public.products;
  v_qty numeric; v_ref text; v_count int := 0;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_inventory');
  v_ref := nullif(trim(coalesce(p_reference, '')), '');

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Nothing to receive';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'Too many lines for one delivery';
  end if;

  -- Validate every line before moving anything: a delivery that books in
  -- half-way is worse than one that fails whole, because someone must then
  -- work out which half.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := round((v_line->>'qty')::numeric, 3);
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every line needs a quantity above zero';
    end if;

    select * into v_prod from public.products p
     where p.id = (v_line->>'product_id')::uuid
       and p.org_id = v_user.org_id and p.active
     for update;
    if not found then raise exception 'Unknown product on the delivery'; end if;
    if v_prod.stock_qty is null then
      raise exception 'Stock is not tracked for %', v_prod.name;
    end if;
  end loop;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := round((v_line->>'qty')::numeric, 3);
    perform public.apply_stock(
      (v_line->>'product_id')::uuid, v_qty, 'receipt', null, null, v_user,
      coalesce(v_ref, 'Goods received') ||
      coalesce(' · ' || nullif(trim(coalesce(p_note, '')), ''), ''));
    v_count := v_count + 1;
  end loop;

  return query
    select p.id, p.name,
           round((l->>'qty')::numeric, 3),
           p.stock_qty
      from jsonb_array_elements(p_lines) l
      join public.products p on p.id = (l->>'product_id')::uuid
     where p.org_id = v_user.org_id;
end;
$$;

grant execute on function public.pos_receive_stock(text, text, jsonb, text, text)
  to anon, authenticated;

/**
 * The whole shop's recent stock story, for the Stock screen's ledger.
 *
 * Per-product history exists (pos_admin_stock_history); this is the other
 * question a manager asks: "what moved today, across everything?"
 */
create or replace function public.pos_stock_movements(
  p_register_token text, p_pin text, p_limit int default 100
) returns table(at timestamptz, product_id uuid, product_name text,
                qty_delta numeric, qty_after numeric, reason stock_reason,
                by_name text, note text)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_inventory');
  return query
    select m.created_at, m.product_id, p.name, m.qty_delta, m.qty_after,
           m.reason, m.by_name, m.note
      from public.stock_movements m
      join public.products p on p.id = m.product_id
     where m.org_id = v_user.org_id
     order by m.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

grant execute on function public.pos_stock_movements(text, text, int)
  to anon, authenticated;
