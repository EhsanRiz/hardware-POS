-- A shop's own stock codes, and the two ways they could go wrong.
--
-- 5 Star keep their own codes for some lines — CEM50 for a bag of cement —
-- and want to type them in rather than live with SKU-000284. The field for
-- that already exists: products.sku is the SHOP's code, as distinct from
-- barcode (the manufacturer's) and supplier_product_codes (the supplier's).
-- The editor already accepts a typed one, and lib/search's exactMatch already
-- falls back to it, so a printed Code 128 of their own code scans today.
--
-- Two faults stood in the way, neither of which anybody had met because the
-- shop had exactly one hand-typed code in 326 products. Both reproduced on a
-- database built from these migrations before this one was written.
--
-- ONE: A DUPLICATE SHOWED A DATABASE ERROR. Saving a second product with a
-- code already in use raised
--
--   duplicate key value violates unique constraint "products_org_sku_key"
--
-- at the counter. There IS a sentence for this — "That SKU already exists" —
-- but it lives only in the browser suite's hand-written fake, so the server
-- has never said it and no test could tell. The same shape as 0111: the fake
-- was kinder than the server, and a green suite reported nothing.
--
-- TWO, AND THIS IS THE ONE THAT SELLS THE WRONG ITEM: the unique index was on
-- (org_id, sku), which is case-SENSITIVE, while exactMatch compares with
-- lower() on both sides. So cem50 was accepted alongside CEM50 — two products
-- the scanner cannot tell apart. A scan then resolves to whichever row the
-- lookup reaches first, which is catalogue order and therefore arbitrary. The
-- counter scans a bag of cement and rings up whatever else took that code,
-- at that other thing's price, with nothing on screen suggesting a problem.
--
-- Latent while nobody typed codes. A certainty the week two people do, because
-- one writes CEM50 and the other cem50.
--
-- Checked before changing anything: no case-variant pairs exist in any shop
-- today, so the new index builds on clean data. That window is open precisely
-- because they have not started yet.

-- The index, case-folded. Same name, because a name that changes is a name
-- something else was using. It is a bare index rather than a constraint
-- (checked), so this is a plain swap, and at 404 rows the exclusive lock is
-- a few milliseconds — a sale arriving inside it waits rather than fails.
drop index if exists public.products_org_sku_key;
create unique index products_org_sku_key
  on public.products (org_id, lower(sku));


-- The sentence, on the server where it belongs.
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
  v_packs boolean; v_label text; v_taken text;
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


-- The spreadsheet import, which the case-folded index would otherwise break.
--
-- It upper-cases every code it reads and then looks the row up with
-- p.sku = v_sku, exactly. That was already wrong and merely invisible: given
-- an item saved through the editor as "cem50", a CSV row for cem50 upper-cased
-- to CEM50, matched nothing, and INSERTED A SECOND PRODUCT — the very
-- collision the new index exists to prevent.
--
-- With the index in place that insert is refused instead, which is safer and
-- still wrong: the row comes back "rejected" with a constraint name in it, and
-- the update the shop wanted never happens. A price list that silently skips
-- lines is worse than one that duplicates them, because nobody re-reads 4,000
-- rows of "updated".
--
-- So the lookup folds case too. The upper-casing stays for codes it CREATES —
-- normalising new codes is reasonable — but an existing row is found however
-- it was spelt, and keeps its own spelling.
create or replace function public.pos_admin_import_products(
  p_register_token text, p_pin text, p_rows jsonb)
returns table(row_no integer, sku text, outcome text, detail text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_user public.app_users; v_row jsonb; v_i int := 0; v_sku text;
  v_cat uuid; v_id uuid;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_sku := upper(trim(coalesce(v_row->>'sku', '')));
    begin
      if v_sku = '' then raise exception 'Missing SKU'; end if;
      v_cat := null;
      if coalesce(trim(v_row->>'category'), '') <> '' then
        select c.id into v_cat from public.categories c
          where c.org_id = v_user.org_id
            and lower(c.name) = lower(trim(v_row->>'category'));
        if v_cat is null then
          insert into public.categories(org_id, name)
            values (v_user.org_id, trim(v_row->>'category'))
            returning id into v_cat;
        end if;
      end if;
      -- Case-folded, to match the index and the scanner. This is the line.
      select p.id into v_id from public.products p
        where p.org_id = v_user.org_id and lower(p.sku) = lower(v_sku);
      if v_id is not null then
        update public.products p set
          name = coalesce(nullif(trim(v_row->>'name'),''), p.name),
          barcode = coalesce(nullif(trim(v_row->>'barcode'),''), p.barcode),
          category_id = coalesce(v_cat, p.category_id),
          unit_code = coalesce(nullif(trim(v_row->>'unit'),''), p.unit_code),
          price_retail = coalesce((v_row->>'price')::numeric, p.price_retail),
          price_trade = coalesce((v_row->>'trade')::numeric, p.price_trade),
          cost = coalesce((v_row->>'cost')::numeric, p.cost),
          reorder_level = coalesce((v_row->>'reorder')::numeric, p.reorder_level)
        where p.id = v_id;
        return query select v_i, v_sku, 'updated'::text, null::text;
      else
        insert into public.products(org_id, sku, barcode, name, category_id,
          unit_code, price_retail, price_trade, cost, stock_qty, reorder_level)
        values (v_user.org_id, v_sku, nullif(trim(v_row->>'barcode'),''),
          nullif(trim(v_row->>'name'),''), v_cat,
          coalesce(nullif(trim(v_row->>'unit'),''), 'ea'),
          (v_row->>'price')::numeric, (v_row->>'trade')::numeric,
          (v_row->>'cost')::numeric, (v_row->>'stock')::numeric,
          (v_row->>'reorder')::numeric)
        returning id into v_id;
        if (v_row->>'stock') is not null then
          insert into public.stock_movements(org_id, product_id, qty_delta,
            qty_after, reason, by_user_id, by_name, note)
          values (v_user.org_id, v_id, (v_row->>'stock')::numeric,
            (v_row->>'stock')::numeric, 'opening', v_user.id, v_user.name,
            'Imported opening stock');
        end if;
        return query select v_i, v_sku, 'created'::text, null::text;
      end if;
    exception when others then
      return query select v_i, v_sku, 'rejected'::text, sqlerrm;
    end;
  end loop;
end;
$function$;

grant execute on function
  public.pos_admin_import_products(text, text, jsonb) to anon, authenticated;
