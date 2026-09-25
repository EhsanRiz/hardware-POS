-- 0118 — a star in front of a name is not a note.
--
-- 0117 left a line off the delivery as "not stock" if its description began
-- with "*", because NAZ Agencies hand-write notes like "* 1BOX". Turf-Ag print
-- "*" in front of real products: on IE Test Shop's first sorted invoice,
-- CN000068973, five of twelve lines were left off — a R1 607 roll of pipe,
-- ball valves, thread tape, hose clamps and drip offtakes. The loose charge
-- words were the same mistake waiting: "fuel" is a fuel can, and "transport"
-- left off 5 Star's BFN plaster at R2 090 because its description says
-- "Price includes transport".
--
-- NAZ's notes never needed the star: every one carries the code NOTE, or a
-- price of R0, or both. So the star goes, and a charge is named as a charge.
-- Checked against every invoice line in both shops before this was written:
-- all 22 notes and charges are still left off, and the six items above are
-- the only lines that change.
create or replace function public.match_not_stock(p_code text, p_description text, p_price numeric)
returns boolean
language sql immutable set search_path = public, extensions as $$
  select upper(trim(coalesce(p_code, ''))) = 'NOTE'
      or coalesce(p_description, '') ~* '(surcharge|freight|transport (fee|charge|cost)|delivery (fee|charge|cost)|^\s*delivery\s*$|fuel levy|^\s*note\y)'
      -- A price nobody read is not a price of nothing: null is not zero.
      or coalesce(p_price = 0, false)
$$;
revoke execute on function public.match_not_stock(text, text, numeric) from public, anon, authenticated;
