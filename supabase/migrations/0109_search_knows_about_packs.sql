-- The search box did not know a pipe could be cut.
--
-- 0107 gave products five new columns — sold_in_packs, pack_size, pack_label,
-- price_cut_retail, price_cut_trade — and taught pos_catalogue,
-- pos_admin_list_products, pos_admin_save_product and pos_quote_items to carry
-- them. It did not touch pos_search_products, and that is the till's OTHER way
-- of putting a product on a sale.
--
-- Reported from the counter, with a photograph: opening Barb wire Fencing 50M
-- showed "R550.00 per Metre", no roll-or-cut picker, and "1 Metre x R550.00".
-- The item is a 50 m roll at R550 or R60 the metre, and the shop had entered
-- it correctly. The picker was missing because soldBothWays() asks a product
-- whether sold_in_packs is true, and a product that arrived through search had
-- no such field to answer with.
--
-- So the two doors onto the same product disagreed:
--
--   SCAN A BARCODE   matched against the cached catalogue, which has the
--                    columns. Picker drawn, line priced as a roll. Correct.
--
--   TYPE IN SEARCH   hit this function, which does not. No picker, and the
--                    line went on as a plain metre item at R550 — which the
--                    SERVER then read as a roll (0108: a pack item with no
--                    mode is a whole one) and took 50 m off the drum for what
--                    the screen had called one metre.
--
-- The money was the same R550 either way. The shelf was not, and neither was
-- what the customer was owed. That is the worse half.
--
-- AND THREE MORE THE SAME, older than 0107. Comparing the two functions
-- column by column, search was also missing image_count, max_discount_percent
-- and max_discount_amount. The discount pair is the one that reaches the
-- counter: the till works a line's ceiling out from them, so a line added by
-- SEARCH had no ceiling, the dialog asked for no manager, and pos_create_sale
-- — which enforces the limit regardless (0037) — refused the sale at the
-- tender screen. A cashier promises a discount and then cannot give it, for
-- no reason anybody can see. Search now returns what the catalogue returns,
-- which is the only version of this that stays fixed.
--
-- WHY IT SURVIVED A GREEN SUITE. There is an e2e test that reaches this exact
-- product through search and taps "Cut to length", and it passed throughout,
-- because the hand-written fake returns `{ ...product, score: 1 }` — the whole
-- row, every field. The real function projects a fixed column list. The fake
-- could not represent the thing that was broken, so the test proved the till
-- worked against a server that does not exist. CLAUDE.md names this exactly:
-- extend the fake when it lies. It has been fixed in the same change.
--
-- DROP AND RECREATE, because the return columns change. create or replace
-- cannot alter a function's OUT columns and would fail; CLAUDE.md has this
-- rule for the argument-list case and it holds just as firmly here.
drop function if exists public.pos_search_products(text, text, integer);
create function public.pos_search_products(
  p_register_token text, p_query text, p_limit integer default 25
) returns table(id uuid, sku text, barcode text, name text, description text,
                category_id uuid, category_name text, unit_code text,
                unit_name text, allows_fraction boolean, price_retail numeric,
                price_trade numeric, tax_code text, stock_qty numeric,
                reorder_level numeric, image_url text, sort_order integer,
                bin text,
                -- Everything pos_catalogue serves, in its order, because the
                -- till reads ONE Product shape and does not care which door a
                -- product came through. The pack columns are 0107's; the
                -- other three had been missing since long before and are the
                -- same fault wearing different clothes (see the note below).
                image_count integer,
                max_discount_percent numeric, max_discount_amount numeric,
                sold_in_packs boolean, pack_size numeric, pack_label text,
                price_cut_retail numeric, price_cut_trade numeric,
                score real)
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
           (select count(*)::int from public.product_images i
             where i.product_id = p.id),
           p.max_discount_percent, p.max_discount_amount,
           p.sold_in_packs, p.pack_size, p.pack_label,
           p.price_cut_retail, p.price_cut_trade,
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
           (select count(*)::int from public.product_images i
             where i.product_id = p.id),
           p.max_discount_percent, p.max_discount_amount,
           p.sold_in_packs, p.pack_size, p.pack_label,
           p.price_cut_retail, p.price_cut_trade,
           (1.0 / (1 + levenshtein(left(p.search_text, 40), left(v_norm, 40))))::real
             as score
    from public.products p
    left join public.categories c on c.id = p.category_id
    join public.units_of_measure u on u.code = p.unit_code
    where p.org_id = v_reg.org_id and p.active
      and levenshtein(left(p.search_text, 40), left(v_norm, 40)) <= 3
    -- BY NAME, not by position. This read "order by 19 desc", and 19 was the
    -- score column — until eight columns landed in front of it and 19 became
    -- image_count. A typo-fallback silently sorted by how many photographs a
    -- product has is the kind of fault that gets noticed as "search got
    -- worse" and never traced to a migration. Naming it makes the next
    -- column addition harmless.
    order by score desc, p.name
    limit p_limit;
end;
$$;
-- A dropped function takes its grants with it — the fault 0106 caught.
grant execute on function public.pos_search_products(text, text, integer)
  to anon, authenticated;
