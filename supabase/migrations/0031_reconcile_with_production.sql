-- Bring a database built from this repository in line with the one running the
-- shop.
--
-- The two had drifted. The live database's migration ledger records work this
-- repository never captured — 0012_search_drop_temp_table, 0018_payment_methods,
-- 0021_customers_carry_vat — so a build from these files produced a schema that
-- was close to production but not equal to it, which is the worst of both: near
-- enough to look right, different enough to be wrong in ways nobody was looking
-- for.
--
-- It had already cost something. The payment_method enum was missing 'eft',
-- 'zapper' and 'mixed' in the repo but present in production, so a reading of
-- the migrations said every EFT and split-tender sale must be failing when in
-- fact none of them were. 0030 closed that one. These are the rest.
--
-- Everything below is production's definition, transcribed. Production is the
-- authority here, not this file: the shop has been running these versions for
-- weeks and the repo's are the ones out of date. Three of the four differ in
-- return columns, so they are dropped and recreated rather than replaced, and
-- their grants are reissued with them.
--
-- After this, a fresh build matches the live database exactly, function for
-- function. supabase/test/fingerprint.sql is how that claim is checked, and
-- README documents running it against both.

-- The catalogue carries a photo count, so the till can show which lines have a
-- picture without fetching every image row. From 0020's follow-up work.
drop function if exists public.pos_catalogue(text);
create function public.pos_catalogue(p_register_token text)
returns table(id uuid, sku text, barcode text, name text, description text,
              category_id uuid, category_name text, unit_code text, unit_name text,
              allows_fraction boolean, price_retail numeric, price_trade numeric,
              tax_code text, stock_qty numeric, reorder_level numeric,
              image_url text, sort_order integer, bin text, image_count integer)
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select p.id, p.sku, p.barcode, p.name, p.description, p.category_id,
           c.name, p.unit_code, u.name, u.allows_fraction, p.price_retail,
           p.price_trade, p.tax_code, p.stock_qty, p.reorder_level,
           p.image_url, p.sort_order, p.bin,
           (select count(*)::int from public.product_images i
             where i.product_id = p.id)
    from public.products p
    left join public.categories c on c.id = p.category_id
    join public.units_of_measure u on u.code = p.unit_code
    where p.org_id = v_reg.org_id and p.active
    order by p.sort_order, p.name;
end;
$$;
grant execute on function public.pos_catalogue(text) to anon, authenticated;

-- Customers carry their VAT number and address, so an account sale can put both
-- on the invoice without a second round trip. This is 0021_customers_carry_vat,
-- which reached the other customer RPCs in this repo but never this one.
drop function if exists public.pos_list_customers(text);
create function public.pos_list_customers(p_register_token text)
returns table(id uuid, code text, name text, phone text, is_trade boolean,
              credit_limit numeric, balance numeric, available numeric,
              vat_number text, address text)
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select c.id, c.code, c.name, c.phone, c.is_trade, c.credit_limit,
           public.customer_balance(c.id), public.customer_available_credit(c.id),
           c.vat_number, c.address
    from public.customers c
    where c.org_id = v_reg.org_id and c.active order by c.name;
end;
$$;
grant execute on function public.pos_list_customers(text) to anon, authenticated;

-- Search, as the shop actually runs it.
--
-- The repo's version scored token by token and returned a narrower row; this
-- one scores on trigram similarity with a word-similarity floor, returns the
-- description, category and bin the closer look needs, and falls back to edit
-- distance over the whole search text — which is what catches the
-- transpositions trigrams score badly ("nial" for "nail").
--
-- This is the drift that mattered most: search is the counter's main way in,
-- and the repo described a different algorithm from the one serving customers.
drop function if exists public.pos_search_products(text, text, integer);
create function public.pos_search_products(
  p_register_token text, p_query text, p_limit integer default 25
) returns table(id uuid, sku text, barcode text, name text, description text,
                category_id uuid, category_name text, unit_code text,
                unit_name text, allows_fraction boolean, price_retail numeric,
                price_trade numeric, tax_code text, stock_qty numeric,
                reorder_level numeric, image_url text, sort_order integer,
                bin text, score real)
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers; v_norm text; v_found int;
begin
  v_reg := public.register_by_token(p_register_token);
  v_norm := public.normalize_search_text(p_query);
  if v_norm = '' then return; end if;

  return query
    select p.id, p.sku, p.barcode, p.name, p.description, p.category_id, c.name,
           p.unit_code, u.name, u.allows_fraction, p.price_retail, p.price_trade,
           p.tax_code, p.stock_qty, p.reorder_level, p.image_url, p.sort_order,
           p.bin,
           greatest(similarity(p.search_text, v_norm),
                    word_similarity(v_norm, p.search_text))::real as score
    from public.products p
    left join public.categories c on c.id = p.category_id
    join public.units_of_measure u on u.code = p.unit_code
    where p.org_id = v_reg.org_id and p.active
      and (p.search_text like '%' || v_norm || '%'
           or v_norm % p.search_text
           or word_similarity(v_norm, p.search_text) > 0.5)
    order by score desc, p.name
    limit p_limit;

  get diagnostics v_found = row_count;
  if v_found > 0 then return; end if;

  -- Nothing matched: fall back to edit distance, which catches the
  -- transpositions trigrams score badly ("nial" for "nail").
  return query
    select p.id, p.sku, p.barcode, p.name, p.description, p.category_id, c.name,
           p.unit_code, u.name, u.allows_fraction, p.price_retail, p.price_trade,
           p.tax_code, p.stock_qty, p.reorder_level, p.image_url, p.sort_order,
           p.bin,
           (1.0 / (1 + levenshtein(left(p.search_text, 40), left(v_norm, 40))))::real
    from public.products p
    left join public.categories c on c.id = p.category_id
    join public.units_of_measure u on u.code = p.unit_code
    where p.org_id = v_reg.org_id and p.active
      and levenshtein(left(p.search_text, 40), left(v_norm, 40)) <= 3
    order by 19 desc, p.name
    limit p_limit;
end;
$$;
grant execute on function public.pos_search_products(text, text, integer) to anon, authenticated;
