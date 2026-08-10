-- Hardware POS — natural-language product lookup.
--
-- The problem: a cashier types "concrete nail 2.5x5" and a plain substring
-- search finds nothing, because no product is literally called that. The shop's
-- own name for it is "Nail Concrete 2.5 x 50mm".
--
-- Three separate difficulties hide in that one query, and only the third
-- actually needs a model:
--
--   1. WORD ORDER — "concrete nail" vs "Nail Concrete". Solved by matching each
--      word independently rather than as a phrase.
--   2. SIZE NOTATION — hardware sizes are written every possible way: 2.5x50,
--      2,5 x 50, 2.5X50mm, 2.5*50. Solved by normalising both the query and the
--      product text to one canonical form.
--   3. SYNONYM AND INTENT — "something to fix wood to a brick wall". That is
--      the part worth an embedding model, and it layers on top of this.
--
-- This migration does 1 and 2. They are deterministic, cost nothing per query,
-- and the same normalisation runs on the device (src/lib/search.ts), so the
-- till still finds products during an outage.

create extension if not exists pg_trgm with schema extensions;

-- Canonical form for both product text and typed queries.
--
-- Immutable because a generated column depends on it. Note this is a
-- regexp-only pipeline: unaccent's dictionary lookup is not actually immutable,
-- and labelling it so to get it into a generated column would be lying to the
-- planner.
create or replace function public.normalize_search_text(p_text text)
returns text language sql immutable parallel safe as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(coalesce(p_text, '')),
          -- Decimal commas to points: "2,5" -> "2.5"
          '(\d),(\d)', '\1.\2', 'g'
        ),
        -- Dimension separators to a spaced "x": "2.5x50", "2.5*50" -> "2.5 x 50"
        '(\d)\s*[x*×]\s*(\d)', '\1 x \2', 'g'
      ),
      -- Split a unit suffix off a number: "50mm" -> "50 mm"
      '(\d)(mm|cm|m|kg|g|l|ml)\b', '\1 \2', 'g'
    ),
    -- Everything else that is not a letter, digit or point becomes a space.
    '[^a-z0-9. ]+', ' ', 'g'
  );
$$;

-- One text blob per product covering every way someone might refer to it.
alter table public.products
  add column if not exists search_text text
  generated always as (
    public.normalize_search_text(
      coalesce(name, '') || ' ' ||
      coalesce(sku, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(barcode, '')
    )
  ) stored;

create index if not exists products_search_trgm
  on public.products using gin (search_text extensions.gin_trgm_ops);

-- Search the catalogue.
--
-- Every word in the query must match something (AND, not OR): "concrete nail"
-- should not return every nail in the shop. Within that, a word matches either
-- as a substring — which is what makes the "5" in "2.5x5" reach "50 mm" — or by
-- trigram similarity, which absorbs a dropped letter.
--
-- Superseded by 0011, which adds a typo-tolerant second pass.
create or replace function public.pos_search_products(
  p_register_token text,
  p_query text,
  p_limit int default 25
) returns table(
  id uuid, sku text, barcode text, name text, category_name text,
  unit_code text, unit_name text, allows_fraction boolean,
  price_retail numeric, price_trade numeric, tax_code text,
  stock_qty numeric, reorder_level numeric, image_url text,
  score real
)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare
  v_norm   text;
  v_tokens text[];
begin
  perform public.register_by_token(p_register_token);

  v_norm := trim(public.normalize_search_text(p_query));
  if v_norm = '' then return; end if;

  -- Drop the bare "x" left by "2.5 x 50": alone it carries no meaning and would
  -- match nearly every product.
  v_tokens := array(
    select t from unnest(string_to_array(v_norm, ' ')) as t
    where t <> '' and t <> 'x'
  );
  if array_length(v_tokens, 1) is null then return; end if;

  return query
  select p.id, p.sku, p.barcode, p.name, c.name, p.unit_code, u.name,
         u.allows_fraction, p.price_retail, p.price_trade, p.tax_code,
         p.stock_qty, p.reorder_level, p.image_url,
         (
           -- An exact code is unambiguous and outranks everything.
           case when p.barcode = trim(p_query) then 100.0
                when lower(p.sku) = lower(trim(p_query)) then 90.0
                else 0.0 end
           + similarity(p.search_text, v_norm) * 10.0
           + case when p.search_text like '%' || v_norm || '%' then 5.0 else 0.0 end
           -- Prefer the shorter name for an equally good match.
           + (1.0 / (1 + length(p.name) / 40.0))
         )::real
  from public.products p
  left join public.categories c on c.id = p.category_id
  join public.units_of_measure u on u.code = p.unit_code
  where p.active
    and (
      select bool_and(
        p.search_text like '%' || tok || '%'
        or word_similarity(tok, p.search_text) > 0.55
      )
      from unnest(v_tokens) as tok
    )
  order by 15 desc, p.name
  limit least(greatest(p_limit, 1), 100);
end;
$$;

grant execute on function public.pos_search_products(text, text, int) to anon, authenticated;
revoke execute on function public.normalize_search_text(text) from anon, authenticated, public;
