-- 0122 — a name printed twice is one name; a discount is not a new item.
--
-- BlueWave and Turf-Ag print every description twice, the second time cut
-- off where the column ends — often through a letter the reader then gets
-- wrong:
--
--   NON-PC DRIP, 16MM, 1.0MM, 2LPH, 30CM, 400M - NON-PC DRIP, 16M
--   HYDROLINK NYLON 40MM ELBOW (HL245) - HYDROLINK NYLC
--   DRIP BARBED OFFTAKE WITH RUBBER 12X16MM (NO.667) - DI
--
-- The tail made every one of IE Test Shop's new items carry it, and it broke
-- matching: the first line above read "16M" as a second length, so the same
-- drip roll from a second supplier was not offered. match_without_tail cuts
-- a tail that repeats the start of the name — word for word, then the start
-- of the next word, give or take the letter the page cut through. Run over
-- the names and descriptions with a " - " in both shops, it cut every such
-- repeat and left the rest ("Blue Chip - Cream 20L", "MORTICE LOCKSET SABS
-- 2L - MATT BLACK", "BFN PLAS GEM - BFN PLASTER GEM") alone.
--
-- It sits inside match_norm, so every comparison ignores the tail on both
-- sides, including names already in the catalogue. A new item is named
-- without it: receive_lines says what it would be called (clean_name, so
-- the screen shows it and it can still be edited) and booking in uses it
-- when no name is given. The description itself is kept as printed.
--
-- Also: a remembered code was set aside as "a different item" when its price
-- moved by half again — but the check compared the LISTED price with the
-- item's cost AFTER discount. At Turf-Ag's and BlueWave's 30% off, that is
-- already 1.43x, so a 5% price rise (R21.00 to R22.50) tipped it, and
-- BlueWave BW0000712669 made a second end cap and male adaptor it already
-- had. It now compares what one actually cost (0119's net cost).
--
-- receive_lines gains a column, so it is dropped and recreated (CLAUDE.md);
-- the rest are same-signature replaces.

create function public.match_without_tail(p text) returns text
language plpgsql immutable set search_path = public, extensions as $$
declare
  v_m text[]; v_head text[]; v_tail text[]; v_n int; v_last text; v_want text;
begin
  if p is null then return null; end if;
  -- The last " - " on the line, and what follows it.
  v_m := regexp_match(p, '^(.*\S)\s+-\s+(\S.*)$');
  if v_m is null then return btrim(p); end if;
  v_head := regexp_split_to_array(upper(regexp_replace(v_m[1], '[^[:alnum:][:space:].,/()&+:=-]', '', 'g')), '\s+');
  v_tail := regexp_split_to_array(upper(btrim(regexp_replace(v_m[2], '[^[:alnum:][:space:].,/()&+:=-]', '', 'g'))), '\s+');
  v_n := coalesce(array_length(v_tail, 1), 0);
  if v_n = 0 or v_n > coalesce(array_length(v_head, 1), 0) then return btrim(p); end if;
  -- Every word but the last is the name's own, word for word...
  for i in 1 .. v_n - 1 loop
    if v_tail[i] <> v_head[i] then return btrim(p); end if;
  end loop;
  -- ...and the last is where the printer cut it off: the start of the
  -- name's next word, give or take its final letter, which is where the
  -- page is cut through ("NYLC" for NYLON, "40MI" for 40MM, "DI" for DRIP).
  v_last := v_tail[v_n]; v_want := v_head[v_n];
  if v_last = '' or left(v_last, 1) <> left(v_want, 1)
     or left(v_want, length(v_last) - 1) <> left(v_last, length(v_last) - 1) then
    return btrim(p);
  end if;
  return btrim(v_m[1]);
end;
$$;
revoke execute on function public.match_without_tail(text) from public, anon, authenticated;

create or replace function public.match_norm(p text) returns text
language sql immutable set search_path = public, extensions as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(lower(coalesce(public.match_without_tail(p), '')),
                '(\d),(\d)', '\1.\2', 'g'),
              '(\d)\s*(litres|litre|liters|liter|ltrs|ltr|lt|l)\y', '\1l', 'g'),
            '(\d)\s*(mtrs|mtr|mt)\y', '\1m', 'g'),
          '(\d)\s*(mm|cm|ml|mic|kg|m|g|w)\y', '\1\2', 'g'),
        '(\d)\s*[x×*]\s*(?=\d)', '\1 x ', 'g'),
      '[^a-z0-9./ ]', ' ', 'g'),
    '\s+', ' ', 'g'))
$$;

drop function if exists public.pos_purchasing_receive_lines(text, text, uuid);
create function public.pos_purchasing_receive_lines(
  p_register_token text, p_pin text, p_document_id uuid
) returns table(line_no int, supplier_code text, description text,
                qty numeric, unit_price numeric, line_total numeric,
                product_id uuid, product_name text, product_sku text,
                stock_qty numeric, current_cost numeric, retail numeric,
                remembered boolean,
                sorted text, suggestion_id uuid, suggestion_name text,
                same_as_line int, sort_note text,
                net_cost numeric, price_basis text,
                clean_name text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_user public.app_users; v_doc public.supplier_documents; v_sorting boolean;
  v_l public.supplier_document_lines; v_pair uuid; v_pid uuid; v_conf text;
  v_prod public.products; v_ids uuid[]; v_scores numeric[];
  -- The first line each supplier code appeared on, and what it said.
  v_first jsonb := '{}'::jsonb;
  -- How many different codes share each (normalised) description.
  v_names jsonb;
  -- What turns a line total into a cost: 1 for lines without VAT, the
  -- invoice's own subtotal/total for lines with it, null when unclear.
  v_ex numeric; v_lines numeric; v_ratio numeric; v_factor numeric; v_basis text;
  v_vat numeric;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  select * into v_doc from public.supplier_documents d
   where d.id = p_document_id and d.org_id = v_user.org_id;
  if not found then raise exception 'Document not found'; end if;
  select coalesce(o.sort_deliveries, false) into v_sorting
    from public.organizations o where o.id = v_user.org_id;
  -- Once it is booked in there is nothing left to decide.
  v_sorting := v_sorting and v_doc.status <> 'received';

  -- 0119: what one of each actually cost, before a person types anything.
  -- The unit price column is the LIST price on most invoices (Turf-Ag's
  -- elbow says R21.00 and the line says R14.70 after 30% off), and on some it
  -- is ex VAT while the line total is not (GC Central Coatings). The line
  -- total is what was charged; whether it includes VAT is read off the
  -- invoice's own totals: lines that add up to the subtotal are ex VAT, lines
  -- that add up to the total include it. Anything else — a misread, a page
  -- filed twice — is said to be unclear rather than guessed at.
  if v_sorting then
    v_ex := coalesce(v_doc.subtotal, v_doc.total - v_doc.tax_total);
    -- The standard rate on the invoice's date, from the table sales read.
    v_vat := coalesce(public.tax_rate_at('standard', coalesce(v_doc.doc_date, current_date)), 0);
    select sum(x.line_total) into v_lines from public.supplier_document_lines x
     where x.document_id = p_document_id;
    if v_ex > 0 and v_lines > 0 then
      v_ratio := v_ex / v_lines;
      if abs(v_ratio - 1) <= 0.015 then
        v_basis := 'ex_vat'; v_factor := 1;
      elsif v_vat > 0 and abs(v_ratio - 1 / (1 + v_vat)) <= 0.015 then
        -- The totals say the lines include VAT; the RATE takes it out. Not the
        -- invoice's own subtotal/total: GC Central Coatings print a fuel
        -- surcharge without VAT among lines with it, which skews that ratio
        -- (Blue Chip 20L came out R130.60 instead of R130.00).
        v_basis := 'incl_vat'; v_factor := 1 / (1 + v_vat);
      else
        v_basis := 'unclear';
      end if;
    else
      v_basis := 'unclear';
    end if;
  end if;

  select coalesce(jsonb_object_agg(n, c), '{}'::jsonb) into v_names
    from (select public.match_norm(x.description) n,
                 count(distinct coalesce(x.supplier_code, x.line_no::text)) c
            from public.supplier_document_lines x
           where x.document_id = p_document_id group by 1) s;

  for v_l in select * from public.supplier_document_lines x
              where x.document_id = p_document_id order by x.line_no loop
    line_no := v_l.line_no; supplier_code := v_l.supplier_code;
    description := v_l.description; qty := v_l.qty; unit_price := v_l.unit_price;
    line_total := v_l.line_total;
    sorted := null; suggestion_id := null; suggestion_name := null;
    same_as_line := null; sort_note := null;
    price_basis := v_basis;
    -- ADDED (0122): the name a new item would get, without the supplier's
    -- repeated tail.
    clean_name := case when v_sorting then public.match_without_tail(v_l.description) end;
    net_cost := case when v_factor is not null and v_l.line_total is not null and v_l.qty > 0
                     then round(v_l.line_total * v_factor / v_l.qty, 2) end;

    v_pair := null;
    if v_l.supplier_code is not null then
      select c.product_id into v_pair from public.supplier_product_codes c
       where c.supplier_id = v_doc.supplier_id and c.supplier_code = v_l.supplier_code;
    end if;
    remembered := v_pair is not null;

    -- 0058's three ways to already know, in the order they can be trusted: a
    -- pairing a person confirmed, then the supplier's code being our own SKU,
    -- then this line already matched on an earlier visit.
    v_pid := coalesce(
      v_l.product_id,
      v_pair,
      (select p.id from public.products p
        where p.org_id = v_user.org_id and p.active
          and v_l.supplier_code is not null
          and lower(p.sku) = lower(v_l.supplier_code)
        limit 1));

    if v_sorting then
      if v_l.product_id is not null then
        sorted := 'sure';
      elsif public.match_not_stock(v_l.supplier_code, v_l.description, v_l.unit_price) then
        sorted := 'not_stock';
        v_pid := null;
      elsif v_pair is not null then
        select * into v_prod from public.products p where p.id = v_pair;
        v_conf := coalesce(public.match_conflict(v_l.description, v_prod.name),
          -- CHANGED (0122): what one actually cost against what it cost
          -- before. The listed price is before discount, the item's cost is
          -- after, so at 30% off a 5% price rise read as a different item.
          case when public.match_price_differs(coalesce(net_cost, v_l.unit_price), v_prod.cost)
               then 'price' end);
        if v_conf is null then
          sorted := 'sure';
        else
          -- The code is this supplier's name for SOMETHING, but the words (or
          -- the price) say a different size or colour of it. The paired item
          -- is exactly the one it is NOT, so it is not offered; the line is
          -- looked for by name like any other, and says why.
          sort_note := 'code_reused_' || v_conf;
          v_pid := null;
        end if;
      elsif v_pid is not null then
        sorted := 'sure';
      elsif v_l.supplier_code is not null and v_first ? v_l.supplier_code then
        v_conf := coalesce(
          public.match_conflict(v_l.description, v_first -> v_l.supplier_code ->> 'description'),
          case when public.match_price_differs(v_l.unit_price,
                 (v_first -> v_l.supplier_code ->> 'unit_price')::numeric) then 'price' end);
        if v_conf is null then
          sorted := 'same_as_line';
          same_as_line := (v_first -> v_l.supplier_code ->> 'line_no')::int;
        else
          sorted := 'new';
          sort_note := 'code_reused_' || v_conf;
        end if;
      end if;

      if v_sorting and sorted is null then
        -- A name that could be something the shop already has. The best two,
        -- among items with exactly the same sizes, colours and sides: the best
        -- is offered only if it is close AND clearly ahead of the next.
        select array_agg(x.id order by x.s desc), array_agg(x.s order by x.s desc)
          into v_ids, v_scores
          from (select p.id, public.match_similarity(v_l.description, p.name) s
                  from public.products p
                 where p.org_id = v_user.org_id and p.stock_qty is not null
                   and public.match_same_variant(v_l.description, p.name)
                 order by 2 desc limit 2) x;
        if v_ids is not null and v_scores[1] >= 0.75
           and v_scores[1] - coalesce(v_scores[2], 0) >= 0.05 then
          sorted := 'likely';
          suggestion_id := v_ids[1];
        else
          sorted := 'new';
          -- It will be made under this name. Say so when the till would then
          -- show two things it cannot tell apart.
          if sort_note is null
             and (coalesce((v_names ->> public.match_norm(v_l.description))::int, 0) > 1
             or exists (select 1 from public.products p
                         where p.org_id = v_user.org_id
                           and public.match_norm(p.name) = public.match_norm(v_l.description))) then
            sort_note := 'name_clash';
          end if;
        end if;
        if v_l.supplier_code is not null then
          v_first := v_first || jsonb_build_object(v_l.supplier_code,
            jsonb_build_object('line_no', v_l.line_no, 'description', v_l.description,
                               'unit_price', v_l.unit_price));
        end if;
      end if;
      if suggestion_id is not null then
        select p.name into suggestion_name from public.products p where p.id = suggestion_id;
      end if;
    end if;

    product_id := v_pid;
    select * into v_prod from public.products p where p.id = v_pid;
    product_name := v_prod.name; product_sku := v_prod.sku;
    stock_qty := v_prod.stock_qty; current_cost := v_prod.cost;
    retail := v_prod.price_retail;
    if v_pid is null then
      product_name := null; product_sku := null; stock_qty := null;
      current_cost := null; retail := null;
    end if;
    return next;
  end loop;
end;
$$;
grant execute on function public.pos_purchasing_receive_lines(text, text, uuid)
  to anon, authenticated;

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
        -- CHANGED (0122): and without the supplier's repeated tail when the
        -- shop sorts its deliveries.
        v_name := coalesce(nullif(trim(coalesce(v_line->>'name', '')), ''),
                           case when v_sorting then public.match_without_tail(v_src.description)
                                else trim(v_src.description) end);
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

