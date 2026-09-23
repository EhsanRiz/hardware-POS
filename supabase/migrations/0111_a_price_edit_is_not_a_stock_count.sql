-- Saving a product could silently rewrite the shelf.
--
-- pos_admin_save_product took p_stock_qty and wrote it on UPDATE as well as
-- INSERT. The product editor captures its form once, when the dialog opens,
-- and the stock-count Apply button moves stock through the ledger WITHOUT
-- touching that captured form. So:
--
--   open an item at 8 on hand   -> the form remembers 8
--   Apply a count of 10          -> apply_stock writes a movement, balance 10
--   press Save (to fix a price)  -> stock_qty = 8, and no movement at all
--
-- The balance and the ledger now disagree and nothing says so. Worse, Save is
-- not optional: the counter is in that dialog to set a price, so the revert is
-- on the main path rather than down some corner of it.
--
-- IT HAS HAPPENED. Two products at the shop that opened this week, found by
-- walking each product's movements and checking every qty_after against the
-- one before it plus its own delta:
--
--   BOW SAW 530MM HEAVY DUTY
--     09:22 receipt     +8  -> 8      as written
--     09:25 adjustment  +2  -> 10     as written
--     09:30 receipt     +2  -> 10     impossible unless it was 8 again
--   Shelf says 10. The ledger says 12.
--
--   LEN 25X 25X 2 EQUAL ANGLE X 6M
--     20th 11:31 adjustment -20 -> 20 as written
--     22nd 09:03 receipt    +34 -> 74 impossible unless it was 40 again
--   Shelf says 74. The ledger says 54 — twenty lengths of steel that are not
--   in the yard.
--
-- Both restored values the form was holding. That is the fingerprint.
--
-- So stock leaves this function on UPDATE. It stays on INSERT, where the field
-- is labelled "Opening stock" and there is no ledger yet to disagree with. An
-- existing product's balance moves through apply_stock and nowhere else, which
-- is the rule the editor already prints on the screen — it was simply not one
-- the server made anybody keep.
--
-- Note there is no signature change here, so create-or-replace is enough; the
-- drop-first rule in CLAUDE.md is about adding a defaulted argument, which
-- would leave the old signature standing beside the new one.

create or replace function public.pos_admin_save_product(
  p_register_token text, p_pin text, p_id uuid, p_sku text, p_barcode text,
  p_name text, p_description text, p_category_id uuid, p_unit_code text,
  p_price_retail numeric, p_price_trade numeric, p_cost numeric,
  p_tax_code text, p_stock_qty numeric, p_reorder_level numeric,
  p_active boolean, p_image_url text default null, p_bin text default null,
  p_max_discount_percent numeric default null,
  p_max_discount_amount numeric default null,
  p_sold_in_packs boolean default false, p_pack_size numeric default null,
  p_pack_label text default null, p_price_cut_retail numeric default null,
  p_price_cut_trade numeric default null)
returns public.products
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_user public.app_users; v_row public.products; v_sku text;
  v_packs boolean; v_label text;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  if trim(coalesce(p_name, '')) = '' then raise exception 'A name is required'; end if;
  if p_price_retail is null or p_price_retail < 0 then
    raise exception 'A retail price is required';
  end if;
  if p_max_discount_percent is not null
     and (p_max_discount_percent < 0 or p_max_discount_percent > 100) then
    raise exception 'A discount cap is a percentage between 0 and 100';
  end if;
  if p_max_discount_amount is not null and p_max_discount_amount < 0 then
    raise exception 'A discount cap cannot be negative';
  end if;

  -- Whole-and-cut, checked here rather than left to the table constraint, so
  -- the counter gets a sentence it can act on instead of a constraint name.
  v_packs := coalesce(p_sold_in_packs, false);
  v_label := nullif(trim(coalesce(p_pack_label, '')), '');
  if v_packs then
    if p_pack_size is null or p_pack_size <= 0 then
      raise exception 'Say how much is in one — a 6 m length is 6';
    end if;
    if v_label is null then
      raise exception 'Give the whole one a name, as the counter says it: "6 m length"';
    end if;
    if p_price_cut_retail is null or p_price_cut_retail < 0 then
      raise exception 'An item sold cut needs a cut price';
    end if;
  end if;
  if p_price_cut_trade is not null and p_price_cut_trade < 0 then
    raise exception 'A cut price cannot be negative';
  end if;

  v_sku := nullif(trim(coalesce(p_sku, '')), '');

  if p_id is null then
    -- Opening stock. A brand-new product has no movements to contradict, and
    -- the field says "Opening stock" on the screen for exactly this reason.
    insert into public.products(org_id, sku, barcode, name, description,
      category_id, unit_code, price_retail, price_trade, cost, tax_code,
      stock_qty, reorder_level, active, image_url, bin,
      max_discount_percent, max_discount_amount,
      sold_in_packs, pack_size, pack_label, price_cut_retail, price_cut_trade)
    values (v_user.org_id, coalesce(v_sku, public.next_sku(v_user.org_id)),
      nullif(trim(coalesce(p_barcode,'')),''),
      trim(p_name), p_description, p_category_id, p_unit_code, p_price_retail,
      p_price_trade, p_cost, coalesce(p_tax_code,'standard'), p_stock_qty,
      p_reorder_level, coalesce(p_active, true),
      nullif(trim(coalesce(p_image_url, '')), ''),
      nullif(trim(coalesce(p_bin,'')),''),
      p_max_discount_percent, p_max_discount_amount,
      v_packs,
      case when v_packs then p_pack_size else null end,
      case when v_packs then v_label else null end,
      case when v_packs then p_price_cut_retail else null end,
      case when v_packs then p_price_cut_trade else null end)
    returning * into v_row;
  else
    update public.products p set
      -- A blank box on an existing product keeps the code it has; a product
      -- does not lose its number because somebody cleared a field.
      sku = coalesce(v_sku, p.sku), barcode = nullif(trim(coalesce(p_barcode,'')),''),
      name = trim(p_name), description = p_description, category_id = p_category_id,
      unit_code = p_unit_code, price_retail = p_price_retail,
      price_trade = p_price_trade, cost = p_cost,
      tax_code = coalesce(p_tax_code,'standard'),
      -- stock_qty is DELIBERATELY ABSENT. p_stock_qty is still accepted so
      -- every caller keeps working, and is ignored here: an existing balance
      -- moves through apply_stock, which writes the movement that explains it.
      -- See the header — this line, when it was here, cost a shop twenty
      -- lengths of steel it thought it had.
      reorder_level = p_reorder_level, active = coalesce(p_active, true),
      -- See the three-way rule at the top of 0027.
      image_url = case
                    when p_image_url is null then p.image_url
                    when trim(p_image_url) = '' then null
                    else p_image_url
                  end,
      bin = nullif(trim(coalesce(p_bin,'')),''),
      max_discount_percent = p_max_discount_percent,
      max_discount_amount = p_max_discount_amount,
      -- Unticking the box clears the lot rather than leaving a cut price on an
      -- item nothing can sell cut: a stale price is one somebody restores the
      -- tick over and trusts.
      sold_in_packs = v_packs,
      pack_size        = case when v_packs then p_pack_size        else null end,
      pack_label       = case when v_packs then v_label            else null end,
      price_cut_retail = case when v_packs then p_price_cut_retail else null end,
      price_cut_trade  = case when v_packs then p_price_cut_trade  else null end,
      updated_at = now()
    where p.id = p_id and p.org_id = v_user.org_id
    returning * into v_row;
    if not found then raise exception 'Product not found'; end if;
  end if;
  return v_row;
end;
$function$;

grant execute on function public.pos_admin_save_product(
  text, text, uuid, text, text, text, text, uuid, text, numeric, numeric,
  numeric, text, numeric, numeric, boolean, text, text, numeric, numeric,
  boolean, numeric, text, numeric, numeric) to anon, authenticated;


-- Starting to count something that was never counted.
--
-- A product photographed onto the shelf from the phone (pos_shelf_add_item)
-- arrives with stock_qty null, which in this schema means NOT TRACKED, not
-- zero. That state is real and wanted — a delivery fee has no shelf — but the
-- shelf camera puts PHYSICAL things into it, and an untracked thing is
-- invisible to the whole inventory side: it never runs out, never warns, never
-- reorders, cannot be stocktaken and has no value.
--
-- The only door out was Stock -> Receive a delivery, with pos_receive_stock's
-- p_start_tracking flag. That door is shut to precisely the items that need
-- it: pos_receive_stock requires p.active, and an item waiting to be priced is
-- inactive by definition. So the manager standing at the shelf holding six of
-- the thing was told to go and receive a delivery that never arrived, on a
-- screen that would then refuse the item.
--
-- Hence this: the first count, from the editor, where the person and the thing
-- already are. Deliberately NOT a second way to adjust stock — it refuses the
-- moment there is a balance, because correcting one is what the stock count is
-- for and two doors onto the same job is how they drift apart.
drop function if exists public.pos_product_start_count(text, text, uuid, numeric, text);

create function public.pos_product_start_count(
  p_register_token text, p_pin text, p_product_id uuid, p_qty numeric,
  p_note text default null)
returns public.products
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare v_user public.app_users; v_prod public.products;
begin
  -- The same permission the stock count asks for. Counting shelves is the
  -- stock room's work, and this is a count however it is spelt.
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_inventory');

  if p_qty is null or p_qty < 0 then
    raise exception 'A first count cannot be negative';
  end if;

  -- No p.active here, and that is the point of the function existing.
  select * into v_prod from public.products
    where id = p_product_id and org_id = v_user.org_id for update;
  if not found then raise exception 'Product not found'; end if;

  if v_prod.stock_qty is not null then
    raise exception '% is already counted — use the stock count instead',
      v_prod.name;
  end if;

  -- Zero first, so the movement about to be written says the shelf went from
  -- nothing to what was counted. apply_stock skips a null on purpose (0058),
  -- so without this the count would book in silently and move nothing — the
  -- same trap pos_receive_stock documents.
  update public.products set stock_qty = 0, updated_at = now()
   where id = p_product_id and org_id = v_user.org_id;

  -- Counted none is a legitimate answer: it starts the tracking without
  -- inventing a receipt for goods nobody has.
  if p_qty > 0 then
    perform public.apply_stock(p_product_id, round(p_qty, 3), 'receipt',
      null, null, v_user,
      coalesce(nullif(trim(coalesce(p_note, '')), ''), 'First count'));
  end if;

  select * into v_prod from public.products where id = p_product_id;
  return v_prod;
end;
$function$;

grant execute on function
  public.pos_product_start_count(text, text, uuid, numeric, text)
  to anon, authenticated;
