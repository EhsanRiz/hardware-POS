-- A barcode on two products, and a reorder level that could never fire.
--
-- The tail of 0112. That one gave the stock code a sentence instead of a
-- constraint name; the barcode beside it had no check at all, so a second
-- product carrying a barcode already in use still showed the counter
--
--   duplicate key value violates unique constraint "products_org_barcode_key"
--
-- Worth having for the same reason and worse consequences: two rows sharing a
-- barcode is the wrong-item-sold fault again, and this is the field a scanner
-- actually reads. It names the item that already has it.
--
-- Compared EXACTLY, unlike the stock code. A barcode is digits off a
-- manufacturer's label rather than something a person types in whichever case
-- they feel like, and lib/search matches it exactly too — folding case here
-- would invent a rule the scanner does not follow.
--
-- The barcode is also trimmed once now, into v_barcode, and the check and both
-- writes read that. Before, the insert and the update each trimmed it inline,
-- which is exactly how a guard comes to test something other than what gets
-- stored.

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
  v_packs boolean; v_label text; v_taken text; v_barcode text;
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
  v_barcode := nullif(trim(coalesce(p_barcode, '')), '');

  -- The code, if one was typed. Compared case-folded, like the index below it
  -- and like the scanner above it, and it NAMES what already holds the code —
  -- "already used by Cement 50kg" is something a person can act on, where a
  -- constraint name is something they photograph and send to me.
  --
  -- Excluding this product is the case that matters most and is easiest to
  -- miss: saving a price on an item keeps its own code, and a check that did
  -- not exclude p_id would refuse every ordinary edit in the catalogue.
  if v_sku is not null then
    select p.name into v_taken from public.products p
     where p.org_id = v_user.org_id
       and lower(p.sku) = lower(v_sku)
       and (p_id is null or p.id <> p_id)
     limit 1;
    if v_taken is not null then
      raise exception 'The code % is already used by %', v_sku, v_taken;
    end if;
  end if;

  -- And the same for the barcode, which had no check at all and so still
  -- showed the counter products_org_barcode_key. Compared EXACTLY, unlike the
  -- stock code: a barcode is digits off a manufacturer's label, not something
  -- a person types in whatever case they feel like, and folding case here
  -- would be inventing a rule the scanner does not follow.
  if v_barcode is not null then
    select p.name into v_taken from public.products p
     where p.org_id = v_user.org_id
       and p.barcode = v_barcode
       and (p_id is null or p.id <> p_id)
     limit 1;
    if v_taken is not null then
      raise exception 'That barcode is already on %', v_taken;
    end if;
  end if;

  if p_id is null then
    -- Opening stock. A brand-new product has no movements to contradict, and
    -- the field says "Opening stock" on the screen for exactly this reason.
    insert into public.products(org_id, sku, barcode, name, description,
      category_id, unit_code, price_retail, price_trade, cost, tax_code,
      stock_qty, reorder_level, active, image_url, bin,
      max_discount_percent, max_discount_amount,
      sold_in_packs, pack_size, pack_label, price_cut_retail, price_cut_trade)
    values (v_user.org_id, coalesce(v_sku, public.next_sku(v_user.org_id)),
      v_barcode,
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
      sku = coalesce(v_sku, p.sku), barcode = v_barcode,
      name = trim(p_name), description = p_description, category_id = p_category_id,
      unit_code = p_unit_code, price_retail = p_price_retail,
      price_trade = p_price_trade, cost = p_cost,
      tax_code = coalesce(p_tax_code,'standard'),
      -- stock_qty is DELIBERATELY ABSENT (0111). p_stock_qty is still accepted
      -- so every caller keeps working, and is ignored here: an existing
      -- balance moves through apply_stock, which writes the movement that
      -- explains it. This line, when it was here, cost a shop twenty lengths
      -- of steel it thought it had.
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
