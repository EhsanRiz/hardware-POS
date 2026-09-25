-- 0117 — a delivery sorts itself, and the same invoice is not filed twice.
--
-- 5 Star's staff were booking deliveries in on a small phone, one line at a
-- time: "Match", search, or "Not on our list — create it", for every line of
-- every invoice. Replayed against their first week (356 received lines, 47
-- invoices), 91% of lines were things the shop had never stocked, 4% were
-- repeats that the supplier's code already identified, and the rest were
-- notes and charges ("* 1BOX", "Diesel Surcharge") that became products
-- because nothing said they were not. The person was doing by hand what the
-- server could have worked out, and the few decisions that really needed a
-- person were buried among the rest.
--
-- So the receive screen now arrives SORTED. Every line is one of:
--
--   sure          the supplier's code is already paired with an item, and
--                 the description still agrees with it on size, colour and
--                 side — or the line was matched on an earlier visit
--   likely        no pairing, but an item with a very similar name and the
--                 same sizes and colours. Offered, never taken for granted:
--                 on their history this was right for "CEM II 32.5 N BAG"
--                 and wrong for "ECONO GLOSS PWD Brown 1L" (it offered HIGH
--                 GLOSS PWD BROWN 1LT, a different range).
--   same_as_line  the same supplier code earlier on this invoice, with no
--                 disagreement in words or price: AMBRO put Stay Peg 150mm on two lines at two
--                 prices, and staff made two products of it.
--   (code_reused) a note, not a group: the code IS paired, but the words
--                 disagree on size or colour — GC Central Coatings print
--                 STOEPENRED on the Red 5L and the Red 1L alike. The paired
--                 item is exactly what it is not, so the line is looked for
--                 by name like any other. A price more than 1.5x apart counts
--                 as disagreeing too (STOEPWINGR at R317 and at R83.50).
--   new           nothing like it in the shop: created at booking in,
--                 inactive and unpriced, exactly as today. Marked name_clash
--                 when its name would be indistinguishable at the till from
--                 another line or item — Meinan's nine lines all called
--                 "cornice", NAZ's four ".TYSON LED OUTDOOR WALL LIGHT".
--   not_stock     a note, a surcharge, a delivery charge, a line at R0.
--                 Left off unless a person says otherwise.
--
-- Names only ever SUGGEST. The only thing trusted without a look is a code
-- this supplier has used for this item before, and even that is questioned
-- when the words disagree with it.
--
-- And filing refuses an invoice or delivery note whose number is already on
-- file for the same supplier. 5 Star filed Build Mart IN140910 twice.
--
-- All of it is behind organizations.sort_deliveries, OFF by default, so a shop
-- keeps today's screen until it is switched on. It goes on for IE Test Shop
-- first, by hand:
--
--   update public.organizations set sort_deliveries = true where id = '<org>';
--
-- The two additions to booking in — "the same item as line N", and a name for
-- a new item — are just arguments, and do nothing unless the screen sends them.

alter table public.organizations
  add column if not exists sort_deliveries boolean not null default false;


-- ---- How a description is compared -----------------------------------------
--
-- Internal. Nobody calls these but the functions below, so they are revoked
-- from everyone (0092: a new function is nobody's until granted).

-- One spelling for the ways a size is written: "5 LT", "5lt" and "5 L" are all
-- 5l; "32,5" is 32.5; "38 X 38" is "38 x 38". The x is only touched between
-- two numbers, so "box" and "mixer" keep theirs.
create function public.match_norm(p text) returns text
language sql immutable set search_path = public, extensions as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(lower(coalesce(p, '')),
                '(\d),(\d)', '\1.\2', 'g'),
              '(\d)\s*(litres|litre|liters|liter|ltrs|ltr|lt|l)\y', '\1l', 'g'),
            '(\d)\s*(mtrs|mtr|mt)\y', '\1m', 'g'),
          '(\d)\s*(mm|cm|ml|mic|kg|m|g|w)\y', '\1\2', 'g'),
        '(\d)\s*[x×*]\s*(?=\d)', '\1 x ', 'g'),
      '[^a-z0-9./ ]', ' ', 'g'),
    '\s+', ' ', 'g'))
$$;

-- The words that say what it is, without the ones every line has.
create function public.match_tokens(p text) returns text[]
language sql immutable set search_path = public, extensions as $$
  select coalesce(array_agg(distinct t), '{}')
    from unnest(string_to_array(public.match_norm(p), ' ')) t
   where t not in ('', '.', '/', 'the', 'and', 'of', 'with', 'for', 'in', 'x',
                   'each', 'pc', 'pcs', 'box', 'bag', 'carded', 'loose')
$$;

-- How alike two names are, 0 to 1: shared words over all words.
create function public.match_similarity(a text, b text) returns numeric
language sql immutable set search_path = public, extensions as $$
  select case when cardinality(ta) = 0 or cardinality(tb) = 0 then 0
         else round(2.0 * cardinality(array(select unnest(ta) intersect select unnest(tb)))
                    / (cardinality(ta) + cardinality(tb)), 3) end
    from (select public.match_tokens(a) ta, public.match_tokens(b) tb) s
$$;

-- Every size in it, as unit:value. "150mm" is mm:150, "5l" is l:5, and a bare
-- number is :number. Numbers stuck to letters in front ("pls06") are a model
-- code, not a size, and are left out.
create function public.match_sizes(p text) returns text[]
language sql immutable set search_path = public, extensions as $$
  select coalesce(array_agg(distinct m[2] || ':' || trim_scale(m[1]::numeric)::text), '{}')
    from regexp_matches(public.match_norm(p), '(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)([a-z]*)', 'g') m
$$;

create function public.match_colours(p text) returns text[]
language sql immutable set search_path = public, extensions as $$
  select coalesce(array_agg(distinct t), '{}')
    from unnest(string_to_array(public.match_norm(p), ' ')) t
   where t in ('black', 'white', 'red', 'green', 'blue', 'grey', 'gray', 'cream',
               'peach', 'brown', 'gold', 'silver', 'yellow', 'orange', 'sahara',
               'charcoal', 'clear', 'bronze', 'brz', 'chrome', 'maple', 'cherry',
               'oak', 'ash', 'slate', 'onyx', 'stone', 'roseg', 'pink', 'purple',
               'burgandy', 'burgundy', 'maroon', 'beige', 'ivory', 'navy', 'tan',
               'khaki', 'olive', 'teal')
$$;

create function public.match_sides(p text) returns text[]
language sql immutable set search_path = public, extensions as $$
  select coalesce(array_agg(distinct case when t in ('left', 'l/h', 'lh') then 'L' else 'R' end), '{}')
    from unnest(string_to_array(public.match_norm(p), ' ')) t
   where t in ('left', 'right', 'l/h', 'r/h', 'lh', 'rh')
$$;

-- Why two descriptions are clearly different variants of a thing, or null.
-- Only what BOTH say is compared: "HRC 32.5" and "HRC 32,5 ECO CEMENT" agree,
-- "STOEP ENAMEL: Red 5L" and "STOEP ENAMEL: Red 1L" do not.
create function public.match_conflict(a text, b text) returns text
language plpgsql immutable set search_path = public, extensions as $$
declare ca text[]; cb text[]; sa text[]; sb text[];
begin
  ca := public.match_colours(a); cb := public.match_colours(b);
  if cardinality(ca) > 0 and cardinality(cb) > 0 and not (ca @> cb and cb @> ca) then
    return 'colour';
  end if;
  sa := public.match_sides(a); sb := public.match_sides(b);
  if cardinality(sa) > 0 and cardinality(sb) > 0 and not (sa @> sb and sb @> sa) then
    return 'side';
  end if;
  if exists (
    select 1
      from (select split_part(x, ':', 1) u, array_agg(split_part(x, ':', 2)) v
              from unnest(public.match_sizes(a)) x group by 1) ua
      join (select split_part(x, ':', 1) u, array_agg(split_part(x, ':', 2)) v
              from unnest(public.match_sizes(b)) x group by 1) ub using (u)
     where not (ua.v @> ub.v and ub.v @> ua.v)
  ) then
    return 'size';
  end if;
  return null;
end;
$$;

-- The stricter test a name-only suggestion has to pass: not merely no
-- disagreement, but the SAME sizes, colours and sides on both.
create function public.match_same_variant(a text, b text) returns boolean
language sql immutable set search_path = public, extensions as $$
  select public.match_sizes(a) @> public.match_sizes(b) and public.match_sizes(b) @> public.match_sizes(a)
     and public.match_colours(a) @> public.match_colours(b) and public.match_colours(b) @> public.match_colours(a)
     and public.match_sides(a) @> public.match_sides(b) and public.match_sides(b) @> public.match_sides(a)
$$;

-- Two prices for what would be one item, far enough apart that it is not one:
-- GC Central Coatings print STOEPWINGR on Windsor Green at R317 and at R83.50,
-- with no size on either line — a 5L and a 1L. Prices move, but not by half in
-- a week; AMBRO's Stay Peg at R10 and R12 is still one item.
create function public.match_price_differs(a numeric, b numeric) returns boolean
language sql immutable set search_path = public, extensions as $$
  select coalesce(a > 0 and b > 0 and greatest(a, b) / least(a, b) > 1.5, false)
$$;

-- A line that is not something to put on a shelf.
create function public.match_not_stock(p_code text, p_description text, p_price numeric)
returns boolean
language sql immutable set search_path = public, extensions as $$
  select upper(trim(coalesce(p_code, ''))) = 'NOTE'
      or coalesce(p_description, '') ~* '(surcharge|delivery|transport|freight|fuel|diesel|^\s*\*|^\s*note\y|^\s*income\y)'
      -- A price nobody read is not a price of nothing: null is not zero.
      or coalesce(p_price = 0, false)
$$;

revoke execute on function public.match_norm(text) from public, anon, authenticated;
revoke execute on function public.match_tokens(text) from public, anon, authenticated;
revoke execute on function public.match_similarity(text, text) from public, anon, authenticated;
revoke execute on function public.match_sizes(text) from public, anon, authenticated;
revoke execute on function public.match_colours(text) from public, anon, authenticated;
revoke execute on function public.match_sides(text) from public, anon, authenticated;
revoke execute on function public.match_conflict(text, text) from public, anon, authenticated;
revoke execute on function public.match_same_variant(text, text) from public, anon, authenticated;
revoke execute on function public.match_not_stock(text, text, numeric) from public, anon, authenticated;
revoke execute on function public.match_price_differs(numeric, numeric) from public, anon, authenticated;


-- ---- Does this shop sort its deliveries? --------------------------------------
-- For the Suppliers screen, which shows "Waiting to be booked in" only when it
-- is on.
create function public.pos_purchasing_sorts_deliveries(p_register_token text, p_pin text)
returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  return coalesce((select o.sort_deliveries from public.organizations o
                    where o.id = v_user.org_id), false);
end;
$$;
grant execute on function public.pos_purchasing_sorts_deliveries(text, text)
  to anon, authenticated;


-- ---- The receive screen, sorted -----------------------------------------------
--
-- Five columns more, so the old one goes first (CLAUDE.md: changing a
-- function's return columns is a drop and recreate). With the switch off the
-- five are null and every other column is exactly what 0058 returned.
drop function if exists public.pos_purchasing_receive_lines(text, text, uuid);
create function public.pos_purchasing_receive_lines(
  p_register_token text, p_pin text, p_document_id uuid
) returns table(line_no int, supplier_code text, description text,
                qty numeric, unit_price numeric, line_total numeric,
                product_id uuid, product_name text, product_sku text,
                stock_qty numeric, current_cost numeric, retail numeric,
                remembered boolean,
                sorted text, suggestion_id uuid, suggestion_name text,
                same_as_line int, sort_note text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_user public.app_users; v_doc public.supplier_documents; v_sorting boolean;
  v_l public.supplier_document_lines; v_pair uuid; v_pid uuid; v_conf text;
  v_prod public.products; v_ids uuid[]; v_scores numeric[];
  -- The first line each supplier code appeared on, and what it said.
  v_first jsonb := '{}'::jsonb;
  -- How many different codes share each (normalised) description.
  v_names jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  select * into v_doc from public.supplier_documents d
   where d.id = p_document_id and d.org_id = v_user.org_id;
  if not found then raise exception 'Document not found'; end if;
  select coalesce(o.sort_deliveries, false) into v_sorting
    from public.organizations o where o.id = v_user.org_id;
  -- Once it is booked in there is nothing left to decide.
  v_sorting := v_sorting and v_doc.status <> 'received';

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
          case when public.match_price_differs(v_l.unit_price, v_prod.cost) then 'price' end);
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


-- ---- Booking in: "the same as line N", a name for a new item ------------------
--
-- Same signature and return as 0058, so a plain replace. The body is 0058's
-- with three additions, each marked.
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


-- ---- Filing: the same invoice is not filed twice ------------------------------
--
-- Same signature as 0057, so a plain replace. The body is 0057's with the one
-- check added, marked.
create or replace function public.pos_purchasing_file_document(
  p_register_token text, p_pin text,
  p_supplier_id uuid,
  p_supplier_name text, p_supplier_vat text, p_supplier_phone text,
  p_supplier_email text,
  p_kind text, p_doc_number text, p_doc_date date,
  p_subtotal numeric, p_tax_total numeric, p_total numeric,
  p_note text,
  p_lines jsonb,
  p_read boolean default true,
  -- The rest of the letterhead, and the foot of the page.
  p_supplier_address text default null,
  p_bank_name text default null, p_bank_account_name text default null,
  p_bank_account_number text default null, p_bank_branch_code text default null
) returns table(document_id uuid, supplier_id uuid, supplier_name text,
                supplier_created boolean, details_filled int)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user public.app_users; v_sup public.suppliers; v_made boolean := false;
  v_doc uuid; v_line jsonb; v_no int := 0; v_desc text; v_filled int := 0;
  v_after public.suppliers;
  v_dup timestamptz;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');

  if p_kind not in ('quote','invoice','delivery_note','statement','other') then
    raise exception 'Say what kind of document it is';
  end if;
  if p_lines is not null and jsonb_array_length(p_lines) > 500 then
    raise exception 'Too many lines for one document';
  end if;

  if p_supplier_id is not null then
    select * into v_sup from public.suppliers s
     where s.id = p_supplier_id and s.org_id = v_user.org_id;
    if not found then raise exception 'Supplier not found'; end if;
  else
    v_sup := public.supplier_match(v_user.org_id, p_supplier_vat, p_supplier_name);
    if v_sup.id is null then
      if trim(coalesce(p_supplier_name, '')) = '' then
        raise exception 'A supplier needs a name';
      end if;
      insert into public.suppliers(org_id, name, phone, email, vat_number, address,
        bank_name, bank_account_name, bank_account_number, bank_branch_code)
      values (v_user.org_id, trim(p_supplier_name),
              nullif(trim(coalesce(p_supplier_phone, '')), ''),
              nullif(trim(coalesce(p_supplier_email, '')), ''),
              nullif(trim(coalesce(p_supplier_vat, '')), ''),
              nullif(trim(coalesce(p_supplier_address, '')), ''),
              nullif(trim(coalesce(p_bank_name, '')), ''),
              nullif(trim(coalesce(p_bank_account_name, '')), ''),
              nullif(trim(coalesce(p_bank_account_number, '')), ''),
              nullif(trim(coalesce(p_bank_branch_code, '')), ''))
      returning * into v_sup;
      v_made := true;
    end if;
  end if;

  -- ADDED (0117), when the shop sorts its deliveries: the same invoice twice
  -- is the same stock twice. Compared without spaces or case, because the
  -- reader gives "IN 140910" one day and "IN140910" the next.
  if coalesce((select o.sort_deliveries from public.organizations o
                where o.id = v_user.org_id), false)
     and p_kind in ('invoice', 'delivery_note')
     and nullif(trim(coalesce(p_doc_number, '')), '') is not null then
    select d.created_at into v_dup from public.supplier_documents d
     where d.org_id = v_user.org_id and d.supplier_id = v_sup.id
       and d.kind in ('invoice', 'delivery_note')
       and upper(regexp_replace(coalesce(d.doc_number, ''), '\s', '', 'g'))
         = upper(regexp_replace(p_doc_number, '\s', '', 'g'))
     order by d.created_at limit 1;
    if v_dup is not null then
      raise exception '% % from % is already filed (%). Open that one instead of filing it again.',
        case when p_kind = 'invoice' then 'Invoice' else 'Delivery note' end,
        trim(p_doc_number), v_sup.name, to_char(v_dup, 'DD Mon YYYY');
    end if;
  end if;

  -- Fill the blanks on a supplier we already had. Never overwrite: a changed
  -- account number is a phone call, not a silent update from a photograph.
  if not v_made then
    update public.suppliers s set
      phone = coalesce(s.phone, nullif(trim(coalesce(p_supplier_phone, '')), '')),
      email = coalesce(s.email, nullif(trim(coalesce(p_supplier_email, '')), '')),
      address = coalesce(s.address, nullif(trim(coalesce(p_supplier_address, '')), '')),
      vat_number = coalesce(s.vat_number, nullif(trim(coalesce(p_supplier_vat, '')), '')),
      bank_name = coalesce(s.bank_name, nullif(trim(coalesce(p_bank_name, '')), '')),
      bank_account_name = coalesce(s.bank_account_name, nullif(trim(coalesce(p_bank_account_name, '')), '')),
      bank_account_number = coalesce(s.bank_account_number, nullif(trim(coalesce(p_bank_account_number, '')), '')),
      bank_branch_code = coalesce(s.bank_branch_code, nullif(trim(coalesce(p_bank_branch_code, '')), ''))
    where s.id = v_sup.id
    returning * into v_after;

    -- How many were actually learnt, so the till can say so rather than
    -- changing the record behind the manager's back.
    v_filled :=
      (case when v_sup.phone is null and v_after.phone is not null then 1 else 0 end) +
      (case when v_sup.email is null and v_after.email is not null then 1 else 0 end) +
      (case when v_sup.address is null and v_after.address is not null then 1 else 0 end) +
      (case when v_sup.vat_number is null and v_after.vat_number is not null then 1 else 0 end) +
      (case when v_sup.bank_name is null and v_after.bank_name is not null then 1 else 0 end) +
      (case when v_sup.bank_account_name is null and v_after.bank_account_name is not null then 1 else 0 end) +
      (case when v_sup.bank_account_number is null and v_after.bank_account_number is not null then 1 else 0 end) +
      (case when v_sup.bank_branch_code is null and v_after.bank_branch_code is not null then 1 else 0 end);
    v_sup := v_after;
  end if;

  insert into public.supplier_documents(org_id, supplier_id, kind, doc_number, doc_date,
    subtotal, tax_total, total, note, status, read_at, created_by)
  values (v_user.org_id, v_sup.id, p_kind,
          nullif(trim(coalesce(p_doc_number, '')), ''), p_doc_date,
          p_subtotal, p_tax_total, p_total,
          nullif(trim(coalesce(p_note, '')), ''),
          case when p_read then 'read' else 'stored' end,
          case when p_read then now() else null end,
          v_user.id)
  returning id into v_doc;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_desc := nullif(trim(coalesce(v_line->>'description', '')), '');
    continue when v_desc is null;
    v_no := v_no + 1;
    insert into public.supplier_document_lines(document_id, line_no, supplier_code,
      description, qty, unit_price, line_total)
    values (v_doc, v_no,
            nullif(trim(coalesce(v_line->>'supplier_code', '')), ''),
            left(v_desc, 300),
            nullif(v_line->>'qty', '')::numeric,
            nullif(v_line->>'unit_price', '')::numeric,
            nullif(v_line->>'line_total', '')::numeric);
  end loop;

  return query select v_doc, v_sup.id, v_sup.name, v_made, v_filled;
end;
$$;
grant execute on function public.pos_purchasing_file_document(
  text, text, uuid, text, text, text, text, text, text, date,
  numeric, numeric, numeric, text, jsonb, boolean, text, text, text, text, text)
  to anon, authenticated;
