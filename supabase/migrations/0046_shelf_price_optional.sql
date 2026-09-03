-- 0046: the shelf records what an item is, not what it sells for.
--
-- 0044 made a proposed price compulsory when an unknown barcode was recorded
-- from the aisle. In use, the person with the phone is naming and
-- photographing stock; pricing is the reviewer's job, and the reviewer
-- checks the figure before anything goes live regardless. So the price is
-- now optional. With none given the item is stored at 0.00 — the same state
-- the supplier import left ~1,400 rows in — and hidden, where Catalogue's
-- "Not priced yet" filter lists it for review.
--
-- A defaulted argument is a NEW signature. The 0044 five-argument function
-- is dropped first so that a caller naming four arguments is not ambiguous
-- between the two (see CLAUDE.md — this has bitten twice).

drop function if exists public.pos_shelf_add_item(text, text, text, text, numeric);

create function public.pos_shelf_add_item(
  p_register_token text,
  p_pin text,
  p_barcode text,
  p_name text,
  p_price_retail numeric default null
) returns table(id uuid, name text, barcode text, unit_code text,
                price_retail numeric, active boolean, has_photo boolean)
language plpgsql security definer
set search_path = public, extensions as $$
declare v_user public.app_users; v_code text; v_row public.products;
begin
  v_user := public.shelf_user(p_register_token, p_pin);
  v_code := trim(coalesce(p_barcode, ''));
  if v_code !~ '^\d{6,14}$' then
    raise exception 'A barcode is 6 to 14 digits';
  end if;
  if trim(coalesce(p_name, '')) = '' then
    raise exception 'A name is required';
  end if;
  if p_price_retail < 0 then
    raise exception 'A price cannot be negative';
  end if;
  -- The screen only offers "add" after a lookup missed, but two phones can
  -- walk the same aisle. Refusing here beats a duplicate a reviewer has to
  -- untangle later.
  if exists (select 1 from public.products p
              where p.org_id = v_user.org_id and p.barcode = v_code) then
    raise exception 'That barcode is already in the catalogue — scan it again to add a photo';
  end if;

  -- Born INACTIVE, always, and unpriced unless a price was offered. The
  -- reviewer prices it in Catalogue before it can be flipped live.
  insert into public.products (org_id, sku, barcode, name, unit_code,
                               price_retail, active)
  values (v_user.org_id, 'SHELF-' || v_code, v_code, trim(p_name), 'ea',
          coalesce(p_price_retail, 0), false)
  returning * into v_row;

  return query select v_row.id, v_row.name, v_row.barcode, v_row.unit_code,
                      v_row.price_retail, v_row.active, false;
end;
$$;
grant execute on function public.pos_shelf_add_item(text, text, text, text, numeric)
  to anon, authenticated;
