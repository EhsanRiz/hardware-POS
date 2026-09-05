-- 0062 — a delivery is not sold by the bag.
--
-- 0061 gave the shop's delivery line "whatever this shop calls each", and
-- picked it with `order by code limit 1`. Alphabetically that is 'bag', so the
-- first delivery ever charged printed as
--
--     1 bag Delivery          R50.00
--       @ R50.00/bag
--
-- on a customer's invoice. The till prints a plain "1x" and no rate line only
-- for 'ea' (see lib/receipt.ts: `unit_code !== "ea" || qty !== 1`), so the
-- unit is not decoration — it is what makes the line read as a delivery
-- rather than as a sack of something.
--
-- The tax code was chosen the same careless way: the first non-null tax_code
-- on any product in the org, unordered. It happened to land on 'standard' in
-- the shop that found this, and would have zero-rated the carriage in a shop
-- whose scan hit a zero-rated line first. The column already defaults to
-- 'standard', so the guess is removed rather than improved.

create or replace function public.delivery_product(p_org uuid)
returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_product public.products; v_unit text;
begin
  select * into v_product from public.products
   where org_id = p_org and kind = 'delivery' order by created_at limit 1;
  if found then return v_product; end if;

  -- 'ea' by name, because the till's receipt reads that one string. The
  -- fallback is by sort_order rather than alphabetically: 'ea' is first in the
  -- catalogue's own ordering and 'bag' is merely first in the dictionary.
  select code into v_unit from public.units_of_measure where code = 'ea';
  if v_unit is null then
    select code into v_unit from public.units_of_measure
     where not allows_fraction order by sort_order limit 1;
  end if;

  insert into public.products (org_id, sku, name, unit_code, price_retail,
                               cost, active, kind, stock_qty)
  values (p_org, 'DELIVERY', 'Delivery', coalesce(v_unit, 'ea'), 0, 0, true,
          'delivery', null)
  returning * into v_product;
  return v_product;
end;
$$;

-- The shops that already have one. Their invoices keep what they printed —
-- sale_items carries its own unit_code, and a record of what was handed over
-- is not something a migration rewrites — but nothing new says "1 bag".
update public.products
   set unit_code = 'ea'
 where kind = 'delivery' and sku = 'DELIVERY' and unit_code <> 'ea';
