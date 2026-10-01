-- 0128 — a delivery opens in time, however big the catalogue.
--
-- 5 Star could not open Receive on invoice 686694: "canceling statement due
-- to statement timeout". Twelve lines, none matched yet, against 488 items.
-- For every unmatched line pos_purchasing_receive_lines (0117, 0122) looked at
-- every stock item in the shop and asked match_same_variant and
-- match_similarity about the pair — and each of those runs the item's NAME
-- back through match_norm's chain of regular expressions, four or five times
-- over, for every line. Measured on production: 6.0 s in match_same_variant
-- and 11.2 s in match_similarity, against the 3 s the anon role is allowed.
-- It grew with lines × items, so every shop would have met it in time.
--
-- An item's name does not change between one line and the next. So its
-- normalised form, its tokens, sizes, colours and sides are worked out ONCE,
-- when the name is written, and kept in product_match_keys. Receiving reads
-- them. The tests and the scores are the same functions as before, applied to
-- the same values — only when they are computed moves.
--
-- A side table, not columns on products: about ten functions return a whole
-- products row, and growing that row grows every one of their answers. Kept
-- in step by a trigger on products, so nothing that writes a name has to
-- remember it.
--
-- IF match_norm, match_tokens, match_sizes, match_colours or match_sides ever
-- change, the stored keys are stale until rebuilt: that migration must end
-- with `select public.rebuild_product_match_keys();`.

create table public.product_match_keys (
  product_id uuid primary key references public.products(id) on delete cascade,
  org_id     uuid,
  nm         text   not null,
  tk         text[] not null,
  sz         text[] not null,
  co         text[] not null,
  si         text[] not null
);
-- "Is there already an item called this?" is asked by name within a shop.
create index product_match_keys_org_nm_idx on public.product_match_keys (org_id, nm);
alter table public.product_match_keys enable row level security;
revoke all on public.product_match_keys from anon, authenticated;

-- match_similarity on tokens already worked out. The same arithmetic, so a
-- score is the same number whichever way it was reached.
create function public.match_token_similarity(ta text[], tb text[]) returns numeric
language sql immutable set search_path = public, extensions as $$
  select case when cardinality(ta) = 0 or cardinality(tb) = 0 then 0
         else round(2.0 * cardinality(array(select unnest(ta) intersect select unnest(tb)))
                    / (cardinality(ta) + cardinality(tb)), 3) end
$$;
revoke execute on function public.match_token_similarity(text[], text[]) from public, anon, authenticated;

create function public.product_match_keys_sync() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.product_match_keys (product_id, org_id, nm, tk, sz, co, si)
  values (new.id, new.org_id, public.match_norm(new.name), public.match_tokens(new.name),
          public.match_sizes(new.name), public.match_colours(new.name),
          public.match_sides(new.name))
  on conflict (product_id) do update
    set org_id = excluded.org_id, nm = excluded.nm, tk = excluded.tk,
        sz = excluded.sz, co = excluded.co, si = excluded.si;
  return null;
end;
$$;
revoke execute on function public.product_match_keys_sync() from public, anon, authenticated;

-- Only when the name (or the shop) changes: a price edit or a sale's stock
-- movement leaves the keys alone and costs nothing.
create trigger products_match_keys
  after insert or update of name, org_id on public.products
  for each row execute function public.product_match_keys_sync();

-- Every item's keys, from scratch. For this migration, and for any later one
-- that changes how names are read.
create function public.rebuild_product_match_keys() returns void
language sql security definer set search_path = public, extensions as $$
  insert into public.product_match_keys (product_id, org_id, nm, tk, sz, co, si)
  select p.id, p.org_id, public.match_norm(p.name), public.match_tokens(p.name),
         public.match_sizes(p.name), public.match_colours(p.name), public.match_sides(p.name)
    from public.products p
  on conflict (product_id) do update
    set org_id = excluded.org_id, nm = excluded.nm, tk = excluded.tk,
        sz = excluded.sz, co = excluded.co, si = excluded.si;
$$;
revoke execute on function public.rebuild_product_match_keys() from public, anon, authenticated;

select public.rebuild_product_match_keys();


-- 0122's body, with the two marked changes. Same arguments and columns, so
-- `create or replace` is enough (CLAUDE.md: only a changed signature or
-- return needs drop-and-recreate).
create or replace function public.pos_purchasing_receive_lines(
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
  -- ADDED (0128): the line's own keys, worked out once per line.
  v_lnm text; v_ltk text[]; v_lsz text[]; v_lco text[]; v_lsi text[];
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
        -- CHANGED (0128): against each item's stored keys, not its name worked
        -- through the regexes again for every line. Same tests, same scores.
        v_lnm := public.match_norm(v_l.description);
        v_ltk := public.match_tokens(v_l.description);
        v_lsz := public.match_sizes(v_l.description);
        v_lco := public.match_colours(v_l.description);
        v_lsi := public.match_sides(v_l.description);
        select array_agg(x.id order by x.s desc), array_agg(x.s order by x.s desc)
          into v_ids, v_scores
          from (select p.id, public.match_token_similarity(v_ltk, k.tk) s
                  from public.products p
                  join public.product_match_keys k on k.product_id = p.id
                 where p.org_id = v_user.org_id and p.stock_qty is not null
                   and k.sz @> v_lsz and v_lsz @> k.sz
                   and k.co @> v_lco and v_lco @> k.co
                   and k.si @> v_lsi and v_lsi @> k.si
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
             and (coalesce((v_names ->> v_lnm)::int, 0) > 1
             -- CHANGED (0128): the stored key, found by index.
             or exists (select 1 from public.product_match_keys k
                         where k.org_id = v_user.org_id and k.nm = v_lnm)) then
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
