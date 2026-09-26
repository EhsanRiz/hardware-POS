-- 0120 — the same delivery is not booked in twice.
--
-- 0117 stops the same invoice being FILED twice, but only the same kind of
-- paper: IE Test Shop has Jasbro 10022994 filed once as a delivery note and
-- once as an invoice — one delivery, 13 lines, R5 300.35 — and both sat in
-- "Waiting to be booked in". Booking in each would have counted every item
-- twice. So booking in now refuses an invoice or delivery note whose number
-- is already booked in for the same supplier, and names the one that was.
--
-- Same signature and return as 0117, so a plain replace; the body is 0117's
-- with the one check added, marked. Behind sort_deliveries like the rest.

create or replace function public.pos_purchasing_receive_document(
  p_register_token text, p_pin text, p_document_id uuid,
  -- [{ "line_no": 1, "product_id": "…"|null, "create": true|false,
  --    "same_as_line": 3|null, "name": "…"|null,
  --    "qty": 20, "unit_cost": 16.85, "remember": true }, …]
  -- A line that is left out, or given no quantity, was not received.
  p_lines jsonb
) returns table(product_id uuid, name text, received numeric, stock_qty numeric,
                old_cost numeric, new_cost numeric, created boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user public.app_users; v_doc public.supplier_documents; v_line jsonb;
  v_prod public.products; v_qty numeric; v_cost numeric; v_pid uuid;
  v_no int; v_src public.supplier_document_lines; v_made boolean;
  v_count int := 0; v_out jsonb := '[]'::jsonb; v_after numeric;
  v_sorting boolean; v_same int; v_name text;
  v_twin public.supplier_documents;
  -- What each line was received against in THIS call, for "same as line N".
  v_got jsonb := '{}'::jsonb;
  -- What each supplier code was paired with in THIS call.
  v_codes jsonb := '{}'::jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  select coalesce(o.sort_deliveries, false) into v_sorting
    from public.organizations o where o.id = v_user.org_id;

  select * into v_doc from public.supplier_documents d
   where d.id = p_document_id and d.org_id = v_user.org_id
   for update;
  if not found then raise exception 'Document not found'; end if;
  if v_doc.status = 'received' then
    raise exception 'This document has already been booked in';
  end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Nothing to receive';
  end if;

  -- ADDED (0120), when the shop sorts its deliveries: the same delivery is
  -- not booked in twice. A supplier's delivery note and invoice for one
  -- delivery carry one number — IE Test Shop has Jasbro 10022994 filed as
  -- both — and booking in each counts every item twice. Numbers compared
  -- without spaces or case, as filing compares them (0117).
  if v_sorting and v_doc.kind in ('invoice', 'delivery_note')
     and nullif(trim(coalesce(v_doc.doc_number, '')), '') is not null then
    select * into v_twin from public.supplier_documents d
     where d.org_id = v_user.org_id and d.supplier_id = v_doc.supplier_id
       and d.id <> v_doc.id and d.status = 'received'
       and d.kind in ('invoice', 'delivery_note')
       and upper(regexp_replace(coalesce(d.doc_number, ''), '\s', '', 'g'))
         = upper(regexp_replace(v_doc.doc_number, '\s', '', 'g'))
     order by d.received_at limit 1;
    if found then
      raise exception '% % was already booked in on % — this is the same delivery. Booking it in again would count the stock twice.',
        case when v_twin.kind = 'invoice' then 'Invoice' else 'Delivery note' end,
        v_twin.doc_number, to_char(v_twin.received_at, 'DD Mon YYYY');
    end if;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := round(coalesce(nullif(v_line->>'qty', '')::numeric, 0), 3);
    continue when v_qty <= 0;

    v_no := (v_line->>'line_no')::int;
    select * into v_src from public.supplier_document_lines
     where document_id = p_document_id and line_no = v_no;
    if not found then raise exception 'No line % on this document', v_no; end if;

    v_cost := nullif(v_line->>'unit_cost', '')::numeric;
    v_pid := nullif(v_line->>'product_id', '')::uuid;
    v_made := false;

    -- ADDED: the same item as an earlier line of this delivery — AMBRO's Stay
    -- Peg on two lines is one product, made once, with both quantities on it.
    v_same := nullif(v_line->>'same_as_line', '')::int;
    if v_pid is null and v_same is not null then
      v_pid := nullif(v_got ->> v_same::text, '')::uuid;
      if v_pid is null then
        raise exception 'Line % is the same item as line %, which is not being received',
          v_no, v_same;
      end if;
    end if;

    if v_pid is null then
      if coalesce((v_line->>'create')::boolean, false) then
        -- Something this shop has not sold before. Born INACTIVE and unpriced,
        -- exactly as an item captured at the shelf is: it arrived in the
        -- store room, it has not been priced, and the till must not offer it.
        -- ADDED: under the name a person gave it, when the supplier's was not
        -- enough to tell it apart ("cornice" x9).
        v_name := coalesce(nullif(trim(coalesce(v_line->>'name', '')), ''),
                           trim(v_src.description));
        insert into public.products(org_id, sku, name, unit_code, price_retail,
          cost, stock_qty, active)
        values (v_user.org_id, public.next_sku(v_user.org_id),
                left(v_name, 200), 'ea', 0, v_cost, 0, false)
        returning * into v_prod;
        v_pid := v_prod.id;
        v_made := true;
      else
        raise exception 'Line % has nothing to receive it against', v_no;
      end if;
    end if;

    select * into v_prod from public.products
     where id = v_pid and org_id = v_user.org_id
     for update;
    if not found then raise exception 'Unknown product on line %', v_no; end if;
    if v_prod.stock_qty is null then
      raise exception 'Stock is not tracked for %', v_prod.name;
    end if;

    perform public.apply_stock(
      v_pid, v_qty, 'receipt', 'supplier_documents', p_document_id, v_user,
      coalesce(v_doc.doc_number, 'Goods received'), v_cost);

    -- Cost is a fact about what was paid, so it is recorded. The RETAIL price
    -- is a decision and is deliberately left alone; a cost that has outgrown
    -- its margin is reported, not silently corrected.
    if v_cost is not null and v_cost >= 0 then
      update public.products set cost = v_cost, updated_at = now() where id = v_pid;
    end if;

    update public.supplier_document_lines set product_id = v_pid
     where document_id = p_document_id and line_no = v_no;
    v_got := v_got || jsonb_build_object(v_no::text, v_pid);

    -- Remember what this supplier calls it, so the next delivery matches
    -- itself. Only when a person confirmed the pairing on the screen.
    -- ADDED, when the shop sorts its deliveries: a code that means two
    -- different things on ONE delivery (STOEPENRED, Red 5L and Red 1L) keeps
    -- the first pairing rather than silently swapping it for the second —
    -- which pointed every later Red 5L at the 1L.
    if coalesce((v_line->>'remember')::boolean, true)
       and v_src.supplier_code is not null
       and not (v_sorting and v_codes ? v_src.supplier_code
                and v_codes ->> v_src.supplier_code <> v_pid::text) then
      insert into public.supplier_product_codes(org_id, supplier_id, supplier_code,
        product_id, description)
      values (v_user.org_id, v_doc.supplier_id, v_src.supplier_code, v_pid,
              left(trim(v_src.description), 300))
      on conflict (supplier_id, supplier_code)
        do update set product_id = excluded.product_id,
                      description = excluded.description;
      v_codes := v_codes || jsonb_build_object(v_src.supplier_code, v_pid);
    end if;

    select p.stock_qty into v_after from public.products p where p.id = v_pid;
    v_out := v_out || jsonb_build_object(
      'product_id', v_pid, 'name', v_prod.name, 'received', v_qty,
      'stock_qty', v_after,
      -- v_prod was read BEFORE the update, so this is genuinely the old cost.
      'old_cost', v_prod.cost,
      'new_cost', coalesce(v_cost, v_prod.cost),
      'created', v_made);
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then raise exception 'Nothing to receive'; end if;

  update public.supplier_documents
     set status = 'received', received_at = now()
   where id = p_document_id;

  return query
    select r.product_id, r.name, r.received, r.stock_qty, r.old_cost,
           r.new_cost, r.created
      from jsonb_to_recordset(v_out) as r(product_id uuid, name text,
        received numeric, stock_qty numeric, old_cost numeric,
        new_cost numeric, created boolean);
end;
$$;
