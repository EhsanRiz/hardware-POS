-- 0058: the delivery note becomes stock on the shelf.
--
-- Until now a scanned invoice was a picture with data behind it. This is the
-- step that makes the scanning worth doing: the lines that were read become
-- quantities received and cost prices, against the products they actually are.
--
-- The bridge is the supplier's own code. "PL 0065" is Jasbro's name for what
-- this shop calls a copper elbow, and only a person knows that the first
-- time. So the pairing is confirmed once, remembered per supplier, and the
-- next Jasbro delivery matches itself.
--
-- What this does NOT do is decide prices. Cost is what the supplier charged
-- and is recorded as fact; the retail price is the owner's decision and is
-- never touched. When a cost rises past its retail margin that is worth being
-- told about, on a screen, by a person who can act on it.

alter table public.stock_movements
  add column if not exists unit_cost numeric(12,4);

alter table public.supplier_documents
  add column if not exists received_at timestamptz;

-- What this supplier calls the things we sell. One code, one product.
create table public.supplier_product_codes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  supplier_id   uuid not null references public.suppliers(id) on delete cascade,
  supplier_code text not null,
  product_id    uuid not null references public.products(id) on delete cascade,
  -- What the supplier called it when the pairing was made, so a person
  -- reviewing the list later can see what they agreed to.
  description   text,
  created_at    timestamptz not null default now(),
  unique (supplier_id, supplier_code)
);
create index supplier_product_codes_product_idx
  on public.supplier_product_codes (product_id);
alter table public.supplier_product_codes enable row level security;

-- One more defaulted argument is a NEW signature, so the old one goes first
-- or every existing caller becomes ambiguous (CLAUDE.md). Internal: the grant
-- was revoked in 0006 and stays revoked.
drop function if exists public.apply_stock(
  uuid, numeric, stock_reason, text, uuid, public.app_users, text);
create function public.apply_stock(
  p_product_id uuid, p_delta numeric, p_reason stock_reason,
  p_ref_table text, p_ref_id uuid, p_user public.app_users, p_note text default null,
  -- What one unit cost on this movement, when the movement knows. Stock can
  -- then be valued at what was actually paid rather than at today's guess.
  p_unit_cost numeric default null
) returns void language plpgsql set search_path = public, extensions as $$
declare v_after numeric(14,3);
begin
  -- The body is 0014's, plus the cost. Recreating this from 0004's version
  -- would drop the org — which is exactly the bug 0014 was written to fix,
  -- and it would come back silently on the first sale after deploy.
  update public.products
     set stock_qty = stock_qty + p_delta
   where id = p_product_id and org_id = p_user.org_id and stock_qty is not null
  returning stock_qty into v_after;

  if not found then return; end if;

  insert into public.stock_movements(
    org_id, product_id, qty_delta, qty_after, reason, ref_table, ref_id,
    by_user_id, by_name, note, unit_cost)
  values (p_user.org_id, p_product_id, p_delta, v_after, p_reason, p_ref_table,
          p_ref_id, p_user.id, p_user.name, p_note, p_unit_cost);
end;
$$;
revoke execute on function public.apply_stock(
  uuid, numeric, stock_reason, text, uuid, public.app_users, text, numeric)
  from public, anon, authenticated;

-- The receiving screen, opened. Every line with what it is already known to
-- be, what it would cost, and what it costs today — so the change is visible
-- BEFORE anything moves.
create function public.pos_purchasing_receive_lines(
  p_register_token text, p_pin text, p_document_id uuid
) returns table(line_no int, supplier_code text, description text,
                qty numeric, unit_price numeric, line_total numeric,
                product_id uuid, product_name text, product_sku text,
                stock_qty numeric, current_cost numeric, retail numeric,
                remembered boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_sup uuid;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  select d.supplier_id into v_sup from public.supplier_documents d
   where d.id = p_document_id and d.org_id = v_user.org_id;
  if v_sup is null then raise exception 'Document not found'; end if;

  return query
  with matched as (
    select l.line_no, l.supplier_code, l.description, l.qty, l.unit_price,
           l.line_total,
           -- Three ways to already know, in the order they can be trusted:
           -- a pairing a person confirmed, then the supplier's code being our
           -- own SKU, then this line already matched on an earlier visit.
           coalesce(
             l.product_id,
             (select c.product_id from public.supplier_product_codes c
               where c.supplier_id = v_sup and c.supplier_code = l.supplier_code),
             (select p.id from public.products p
               where p.org_id = v_user.org_id and p.active
                 and l.supplier_code is not null
                 and lower(p.sku) = lower(l.supplier_code))
           ) as pid,
           (select c.product_id from public.supplier_product_codes c
             where c.supplier_id = v_sup and c.supplier_code = l.supplier_code)
             is not null as remembered
      from public.supplier_document_lines l
     where l.document_id = p_document_id
  )
  select m.line_no, m.supplier_code, m.description, m.qty, m.unit_price,
         m.line_total, m.pid, p.name, p.sku, p.stock_qty, p.cost, p.price_retail,
         m.remembered
    from matched m
    left join public.products p on p.id = m.pid
   order by m.line_no;
end;
$$;
grant execute on function public.pos_purchasing_receive_lines(text, text, uuid)
  to anon, authenticated;

-- Book the delivery in. All of it or none of it: a receipt that lands half way
-- is worse than one that fails whole, because somebody then has to work out
-- which half.
create function public.pos_purchasing_receive_document(
  p_register_token text, p_pin text, p_document_id uuid,
  -- [{ "line_no": 1, "product_id": "…"|null, "create": true|false,
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
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');

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

    if v_pid is null then
      if coalesce((v_line->>'create')::boolean, false) then
        -- Something this shop has not sold before. Born INACTIVE and unpriced,
        -- exactly as an item captured at the shelf is: it arrived in the
        -- store room, it has not been priced, and the till must not offer it.
        insert into public.products(org_id, sku, name, unit_code, price_retail,
          cost, stock_qty, active)
        values (v_user.org_id, public.next_sku(v_user.org_id),
                left(trim(v_src.description), 200), 'ea', 0, v_cost, 0, false)
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

    -- Remember what this supplier calls it, so the next delivery matches
    -- itself. Only when a person confirmed the pairing on the screen.
    if coalesce((v_line->>'remember')::boolean, true)
       and v_src.supplier_code is not null then
      insert into public.supplier_product_codes(org_id, supplier_id, supplier_code,
        product_id, description)
      values (v_user.org_id, v_doc.supplier_id, v_src.supplier_code, v_pid,
              left(trim(v_src.description), 300))
      on conflict (supplier_id, supplier_code)
        do update set product_id = excluded.product_id,
                      description = excluded.description;
    end if;

    select p.stock_qty into v_after from public.products p where p.id = v_pid;
    v_out := v_out || jsonb_build_object(
      'product_id', v_pid, 'name', v_prod.name, 'received', v_qty,
      'stock_qty', v_after,
      -- v_prod was read BEFORE the update, so this is genuinely the old cost.
      'old_cost', v_prod.cost, 'new_cost', coalesce(v_cost, v_prod.cost),
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
grant execute on function public.pos_purchasing_receive_document(text, text, uuid, jsonb)
  to anon, authenticated;

-- What this supplier's codes are known to mean, for a manager who wants to
-- correct a pairing rather than wait for the next delivery to do it.
create function public.pos_purchasing_supplier_codes(
  p_register_token text, p_pin text, p_supplier_id uuid
) returns table(supplier_code text, description text, product_id uuid,
                product_name text, product_sku text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  return query
    select c.supplier_code, c.description, c.product_id, p.name, p.sku
      from public.supplier_product_codes c
      join public.products p on p.id = c.product_id
     where c.org_id = v_user.org_id and c.supplier_id = p_supplier_id
     order by c.supplier_code;
end;
$$;
grant execute on function public.pos_purchasing_supplier_codes(text, text, uuid)
  to anon, authenticated;
