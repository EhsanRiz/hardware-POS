-- Saving a product must not throw its photograph away.
--
-- pos_admin_save_product assigned `image_url = p_image_url` on update, and the
-- back-office editor has never sent that argument — it edits names, prices and
-- stock, not pictures. So every save wrote NULL over whatever was there.
--
-- Invisible until the supplier catalogues were imported, because until then
-- almost nothing had a picture to lose. Now the ordinary act of pricing an
-- imported item — open it, type a price, tick "available to sell", save —
-- silently deleted the photograph that made it worth importing.
--
-- The three-way rule below is what the parameter should always have meant:
--
--   null   -> leave the existing picture alone   (the caller is not editing it)
--   ''     -> clear the picture                  (the caller means "none")
--   a path -> set it
--
-- Null-means-leave-alone is the right default because the only callers that
-- pass this argument are the ones that actually manage images; everything else
-- is editing something unrelated and should not have an opinion.

create or replace function public.pos_admin_save_product(
  p_register_token text, p_pin text, p_id uuid, p_sku text, p_barcode text,
  p_name text, p_description text, p_category_id uuid, p_unit_code text,
  p_price_retail numeric, p_price_trade numeric, p_cost numeric,
  p_tax_code text, p_stock_qty numeric, p_reorder_level numeric,
  p_active boolean, p_image_url text default null, p_bin text default null
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_row public.products;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  if trim(coalesce(p_sku, '')) = '' then raise exception 'A stock code is required'; end if;
  if trim(coalesce(p_name, '')) = '' then raise exception 'A name is required'; end if;
  if p_price_retail is null or p_price_retail < 0 then
    raise exception 'A retail price is required';
  end if;

  if p_id is null then
    insert into public.products(org_id, sku, barcode, name, description,
      category_id, unit_code, price_retail, price_trade, cost, tax_code,
      stock_qty, reorder_level, active, image_url, bin)
    values (v_user.org_id, trim(p_sku), nullif(trim(coalesce(p_barcode,'')),''),
      trim(p_name), p_description, p_category_id, p_unit_code, p_price_retail,
      p_price_trade, p_cost, coalesce(p_tax_code,'standard'), p_stock_qty,
      p_reorder_level, coalesce(p_active, true),
      nullif(trim(coalesce(p_image_url, '')), ''),
      nullif(trim(coalesce(p_bin,'')),''))
    returning * into v_row;
  else
    update public.products p set
      sku = trim(p_sku), barcode = nullif(trim(coalesce(p_barcode,'')),''),
      name = trim(p_name), description = p_description, category_id = p_category_id,
      unit_code = p_unit_code, price_retail = p_price_retail,
      price_trade = p_price_trade, cost = p_cost,
      tax_code = coalesce(p_tax_code,'standard'), stock_qty = p_stock_qty,
      reorder_level = p_reorder_level, active = coalesce(p_active, true),
      -- See the three-way rule at the top of this file.
      image_url = case
                    when p_image_url is null then p.image_url
                    when trim(p_image_url) = '' then null
                    else p_image_url
                  end,
      bin = nullif(trim(coalesce(p_bin,'')),''),
      updated_at = now()
    where p.id = p_id and p.org_id = v_user.org_id
    returning * into v_row;
    if not found then raise exception 'Product not found'; end if;
  end if;
  return v_row;
end;
$$;

grant execute on function public.pos_admin_save_product(text, text, uuid, text,
  text, text, text, uuid, text, numeric, numeric, numeric, text, numeric,
  numeric, boolean, text, text) to anon, authenticated;
