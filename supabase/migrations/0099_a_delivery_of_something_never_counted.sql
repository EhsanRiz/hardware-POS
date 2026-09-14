-- Receiving something the shop has never counted.
--
-- 0025 refused a line whose product has stock_qty null, reasoning that whether
-- a product is tracked at all is a catalogue decision and not a side effect of
-- a delivery. The reasoning holds; what it left behind does not. An item
-- photographed onto the shelf from the aisle is created with no stock figure,
-- and a first delivery of it is EXACTLY the moment a shop starts counting it —
-- so the only route was a trip to the catalogue editor to type a zero, and the
-- till, which looked only at tracked lines, reported the whole thing as "no
-- item in the catalogue has that barcode". Which blamed the catalogue for
-- holding the item it was holding.
--
-- So the decision stays explicit, and stays the person's: it is made by whoever
-- puts the line on the delivery, and travels with the delivery as
-- p_start_tracking. With the flag off the refusal is word for word 0025's, so
-- nothing that calls this without knowing about the flag can start counting
-- something by accident.
--
-- One more defaulted argument is a NEW signature, so the old one goes first or
-- every existing caller becomes ambiguous (CLAUDE.md).

drop function if exists public.pos_receive_stock(text, text, jsonb, text, text);

create function public.pos_receive_stock(
  p_register_token text, p_pin text,
  -- [{ "product_id": "…", "qty": 40 }, …]
  p_lines jsonb,
  p_reference text default null,
  p_note text default null,
  -- Lines with no stock figure yet start from zero rather than being refused.
  p_start_tracking boolean default false
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
    if v_prod.stock_qty is null and not coalesce(p_start_tracking, false) then
      raise exception 'Stock is not tracked for %', v_prod.name;
    end if;
  end loop;

  -- Counting starts at nothing, so that the movement about to be written says
  -- the shelf went from nothing to what arrived. apply_stock skips a product
  -- whose stock_qty is null on purpose (0058), so this has to happen first or
  -- the line would book in silently and move nothing at all.
  if coalesce(p_start_tracking, false) then
    update public.products p
       set stock_qty = 0
     where p.org_id = v_user.org_id and p.active and p.stock_qty is null
       and p.id in (select (l->>'product_id')::uuid
                      from jsonb_array_elements(p_lines) l);
  end if;

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

grant execute on function public.pos_receive_stock(text, text, jsonb, text, text, boolean)
  to anon, authenticated;
