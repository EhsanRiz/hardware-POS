-- Shelf capture: photographing the catalogue where it lives, on a phone.
--
-- The shop's catalogue arrived as a supplier import — ~1,400 rows, almost none
-- with a photo. The job of fixing that happens in the aisles, and the person
-- doing it is not necessarily someone who should hold the keys to prices,
-- costs or the rest of the back office. So the capability is a PERMISSION, not
-- a role: 'shelf_capture' lets somebody look an item up by its barcode and put
-- a photo on it, and lets them record an item the catalogue has never heard of
-- — which lands HIDDEN, because aisle capture is quick and error-prone, and a
-- wrong price must go through a reviewer before it can reach a till.
--
-- Managers and admins get the permission through their role; the grant exists
-- so a counter hand can be given exactly this and nothing else. Nothing a
-- shelf-only person can do changes what the till charges today: photos are
-- cosmetic, and new items are born inactive.

insert into public.permissions (code, description) values
  ('shelf_capture', 'Photograph items and record barcodes from the shelf');

-- Managers had every management permission except this one, which did not
-- exist. Same signature and return type, so replace-in-place is safe — no
-- caller names these arguments optionally. (Admins need nothing: their set is
-- computed from the permissions table, so the insert above already reaches
-- them.)
create or replace function public.role_default_permissions(p_role user_role)
returns text[] language sql immutable
set search_path = public, extensions as $$
  select case p_role
    when 'admin' then array(select code from public.permissions)
    when 'manager' then array[
      'take_payments','apply_discount','approve_discount','void_refund',
      'manage_catalogue','manage_inventory','manage_purchasing',
      'manage_customers','manage_quotes','view_reports','view_cost_prices',
      'cash_management','shelf_capture'
    ]
    else array['take_payments','apply_discount']
  end;
$$;

-- The permission that opens each shelf RPC.
--
-- shelf_capture is the grant made for this screen, but it is not the only
-- right that should open it: a counter supervisor who was given
-- manage_catalogue as an explicit extra can already edit every product from
-- the back office, and refusing them the quicker path would be a rule with no
-- reason. So: shelf_capture first, manage_catalogue as the fallback. The
-- fallback re-raises user_with_perm's own errors, so a wrong PIN still says
-- 'Invalid PIN' rather than something about permissions.
create function public.shelf_user(
  p_register_token text, p_pin text
) returns public.app_users
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  begin
    v_user := public.user_with_perm(p_register_token, p_pin, 'shelf_capture');
  exception when others then
    v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  end;
  return v_user;
end;
$$;
revoke execute on function public.shelf_user(text, text)
  from anon, authenticated, public;

-- One barcode in, one answer out: the item it names, or nothing.
--
-- This is the branch point of the whole screen — "in the catalogue" opens the
-- add-a-photo sheet, "not found" opens the new-item sheet — so it returns just
-- enough to render the first and no more. No cost, no margins: the person
-- holding the phone may be exactly the person view_cost_prices exists to keep
-- those from.
create function public.pos_shelf_lookup(
  p_register_token text,
  p_pin text,
  p_barcode text
) returns table(id uuid, name text, barcode text, unit_code text,
                price_retail numeric, active boolean, has_photo boolean)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.shelf_user(p_register_token, p_pin);
  return query
    select p.id, p.name, p.barcode, p.unit_code, p.price_retail, p.active,
           (p.image_url is not null
            or exists (select 1 from public.product_images i
                        where i.product_id = p.id)) as has_photo
      from public.products p
     where p.org_id = v_user.org_id
       and p.barcode = trim(coalesce(p_barcode, ''))
     limit 1;
end;
$$;
grant execute on function public.pos_shelf_lookup(text, text, text)
  to anon, authenticated;

-- An item the catalogue has never heard of, recorded where it stands.
--
-- Born INACTIVE, always — there is deliberately no argument to say otherwise.
-- The aisle is where the photo and the barcode are; the back office is where
-- somebody decides what the till may sell and for how much. The captured
-- price travels along as a proposal for that reviewer, not as a fact.
--
-- The SKU is derived from the barcode rather than asked for: the person at
-- the shelf has the packet in one hand and a phone in the other, and the
-- reviewer can rename it in Catalogue if the shop's scheme wants otherwise.
create function public.pos_shelf_add_item(
  p_register_token text,
  p_pin text,
  p_barcode text,
  p_name text,
  p_price_retail numeric
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
  if p_price_retail is null or p_price_retail < 0 then
    raise exception 'A price is required — put the shelf price, it is checked before going live';
  end if;
  -- The screen only offers "add" after a lookup missed, but two phones can
  -- walk the same aisle. Refusing here beats a duplicate a reviewer has to
  -- untangle later.
  if exists (select 1 from public.products p
              where p.org_id = v_user.org_id and p.barcode = v_code) then
    raise exception 'That barcode is already in the catalogue — scan it again to add a photo';
  end if;

  insert into public.products (org_id, sku, barcode, name, unit_code,
                               price_retail, active)
  values (v_user.org_id, 'SHELF-' || v_code, v_code, trim(p_name), 'ea',
          p_price_retail, false)
  returning * into v_row;

  return query select v_row.id, v_row.name, v_row.barcode, v_row.unit_code,
                      v_row.price_retail, v_row.active, false;
end;
$$;
grant execute on function public.pos_shelf_add_item(text, text, text, text, numeric)
  to anon, authenticated;

-- Photographs are the whole point of the shelf permission, and the recording
-- half of an upload was gated on manage_catalogue alone (0020). Same argument
-- list, so replace-in-place; the only change is WHO may call it — the file
-- half is widened the same way in the product-image edge function, which
-- probes pos_admin_org_for with either permission before writing anything.
create or replace function public.pos_admin_add_product_image(
  p_register_token text, p_pin text, p_product_id uuid, p_url text,
  p_sort_order int default 0
) returns uuid
language plpgsql security definer
set search_path = public, extensions as $$
declare v_user public.app_users; v_id uuid;
begin
  v_user := public.shelf_user(p_register_token, p_pin);
  if trim(coalesce(p_url, '')) = '' then raise exception 'An image address is required'; end if;
  if not exists (select 1 from public.products
                  where id = p_product_id and org_id = v_user.org_id) then
    raise exception 'Product not found';
  end if;

  insert into public.product_images(org_id, product_id, url, sort_order)
  values (v_user.org_id, p_product_id, trim(p_url), coalesce(p_sort_order, 0))
  returning id into v_id;

  -- The first photograph becomes the thumbnail the till shows, so a search
  -- result needs no extra round trip.
  update public.products
     set image_url = coalesce(image_url, trim(p_url)), updated_at = now()
   where id = p_product_id and org_id = v_user.org_id;

  return v_id;
end;
$$;

-- A price fixed at the shelf, by somebody entitled to fix prices.
--
-- Gated on manage_catalogue and NOT on shelf_capture — deliberately not
-- shelf_user(): the whole safety story of the shelf permission is that its
-- holder cannot change what the till charges. pos_admin_save_product is the
-- wrong tool from this screen because it writes every column it is passed,
-- and the shelf lookup deliberately does not carry them all.
create function public.pos_shelf_set_price(
  p_register_token text,
  p_pin text,
  p_product_id uuid,
  p_price_retail numeric
) returns numeric
language plpgsql security definer
set search_path = public, extensions as $$
declare v_user public.app_users; v_price numeric;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  if p_price_retail is null or p_price_retail < 0 then
    raise exception 'A retail price is required';
  end if;
  update public.products p
     set price_retail = p_price_retail, updated_at = now()
   where p.id = p_product_id and p.org_id = v_user.org_id
   returning p.price_retail into v_price;
  if v_price is null then raise exception 'Product not found'; end if;
  return v_price;
end;
$$;
grant execute on function public.pos_shelf_set_price(text, text, uuid, numeric)
  to anon, authenticated;
