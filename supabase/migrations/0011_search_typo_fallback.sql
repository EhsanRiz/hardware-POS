-- Typo tolerance for product search.
--
-- Trigram similarity handles a dropped letter well — "conrete" scores 0.55
-- against "concrete" — but collapses on a transposition in a short word:
-- "nial" versus "nail" scores 0.2, because swapping two letters of a
-- four-letter word leaves almost no trigrams in common. A counter hand typing
-- quickly produces exactly that mistake.
--
-- Rather than loosen the main filter — which would drag junk into every
-- ordinary search — this adds a second pass that runs ONLY when the first found
-- nothing. Precision first, recall as a fallback.
--
-- (Deployment note: the live database records this as two migrations, 0011 and
-- 0012. The first attempt created a temp table to count pass-1 rows, which a
-- STABLE function may not do — every call failed with "CREATE TABLE AS is not
-- allowed in a non-volatile function". GET DIAGNOSTICS needs no scratch table.
-- This file is the corrected version; there is nothing to gain from replaying
-- the broken intermediate on a fresh project.)

create extension if not exists fuzzystrmatch with schema extensions;

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
  v_found  int;
begin
  perform public.register_by_token(p_register_token);

  v_norm := trim(public.normalize_search_text(p_query));
  if v_norm = '' then return; end if;

  v_tokens := array(
    select t from unnest(string_to_array(v_norm, ' ')) as t
    where t <> '' and t <> 'x'
  );
  if array_length(v_tokens, 1) is null then return; end if;

  -- Pass 1: precise. Every token must appear as a substring or be a close
  -- trigram match somewhere in the product's text.
  return query
  select p.id, p.sku, p.barcode, p.name, c.name, p.unit_code, u.name,
         u.allows_fraction, p.price_retail, p.price_trade, p.tax_code,
         p.stock_qty, p.reorder_level, p.image_url,
         (
           case when p.barcode = trim(p_query) then 100.0
                when lower(p.sku) = lower(trim(p_query)) then 90.0
                else 0.0 end
           + similarity(p.search_text, v_norm) * 10.0
           + case when p.search_text like '%' || v_norm || '%' then 5.0 else 0.0 end
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

  get diagnostics v_found = row_count;
  if v_found > 0 then return; end if;

  -- Pass 2: forgiving, and only reached when pass 1 found nothing. Compare each
  -- typed word against each word of the product text by edit distance. A
  -- transposition costs 2 in plain Levenshtein, so a four-letter word needs a
  -- tolerance of 2 — loose on its own, but every token must still match, which
  -- is what keeps "conrete nial" pointing at concrete nails rather than at
  -- every rail, tail and mail in the shop.
  return query
  select p.id, p.sku, p.barcode, p.name, c.name, p.unit_code, u.name,
         u.allows_fraction, p.price_retail, p.price_trade, p.tax_code,
         p.stock_qty, p.reorder_level, p.image_url,
         (
           similarity(p.search_text, v_norm) * 10.0
           + (1.0 / (1 + length(p.name) / 40.0))
         )::real
  from public.products p
  left join public.categories c on c.id = p.category_id
  join public.units_of_measure u on u.code = p.unit_code
  where p.active
    and (
      select bool_and(
        exists (
          select 1
          from unnest(string_to_array(p.search_text, ' ')) as w
          where w <> ''
            and levenshtein(tok, w) <= case when length(tok) < 4 then 1 else 2 end
        )
      )
      from unnest(v_tokens) as tok
    )
  order by 15 desc, p.name
  limit least(greatest(p_limit, 1), 100);
end;
$$;

grant execute on function public.pos_search_products(text, text, int) to anon, authenticated;
