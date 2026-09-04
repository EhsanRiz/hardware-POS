-- 0053: a new product gets a stock code if nobody types one.
--
-- The catalogue editor insisted on a hand-typed code that had to be unique,
-- which on the thousandth product is a chore and a source of "SKU already
-- exists". The shelf already invents one ("SHELF-" and the barcode). Now the
-- editor may leave the box blank and the shop's own sequence fills it in —
-- SKU-000412, gapless per shop, from the same table that numbers invoices.
-- A typed code still wins, so a shop with its own numbering keeps it.

create or replace function public.next_doc_number(p_org uuid, p_doc_type text)
returns text language plpgsql set search_path = public, extensions as $$
declare v_seq public.doc_sequences;
begin
  -- New orgs get their sequences lazily.
  insert into public.doc_sequences (org_id, doc_type, prefix)
  values (p_org, p_doc_type,
          case p_doc_type when 'sale' then 'INV-' when 'quote' then 'QUO-'
                          when 'grv' then 'GRV-' when 'sku' then 'SKU-'
                          else 'CRN-' end)
  on conflict (org_id, doc_type) do nothing;

  select * into v_seq from public.doc_sequences
    where org_id = p_org and doc_type = p_doc_type for update;
  update public.doc_sequences set next_number = next_number + 1
    where org_id = p_org and doc_type = p_doc_type;
  return v_seq.prefix || lpad(v_seq.next_number::text, v_seq.pad_width, '0');
end;
$$;

-- The next free generated code. A shop may have typed "SKU-000003" by hand
-- once; the sequence steps past anything already taken rather than failing.
create or replace function public.next_sku(p_org uuid)
returns text language plpgsql set search_path = public, extensions as $$
declare v_code text;
begin
  loop
    v_code := public.next_doc_number(p_org, 'sku');
    exit when not exists (
      select 1 from public.products where org_id = p_org and sku = v_code);
  end loop;
  return v_code;
end;
$$;
revoke execute on function public.next_sku(uuid) from anon, authenticated, public;

-- Same signature as 0037: replaced in place.
create or replace function public.pos_admin_save_product(
  p_register_token text, p_pin text, p_id uuid, p_sku text, p_barcode text,
  p_name text, p_description text, p_category_id uuid, p_unit_code text,
  p_price_retail numeric, p_price_trade numeric, p_cost numeric,
  p_tax_code text, p_stock_qty numeric, p_reorder_level numeric,
  p_active boolean, p_image_url text default null, p_bin text default null,
  p_max_discount_percent numeric default null,
  p_max_discount_amount numeric default null
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_row public.products; v_sku text;
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

  v_sku := nullif(trim(coalesce(p_sku, '')), '');

  if p_id is null then
    insert into public.products(org_id, sku, barcode, name, description,
      category_id, unit_code, price_retail, price_trade, cost, tax_code,
      stock_qty, reorder_level, active, image_url, bin,
      max_discount_percent, max_discount_amount)
    values (v_user.org_id, coalesce(v_sku, public.next_sku(v_user.org_id)),
      nullif(trim(coalesce(p_barcode,'')),''),
      trim(p_name), p_description, p_category_id, p_unit_code, p_price_retail,
      p_price_trade, p_cost, coalesce(p_tax_code,'standard'), p_stock_qty,
      p_reorder_level, coalesce(p_active, true),
      nullif(trim(coalesce(p_image_url, '')), ''),
      nullif(trim(coalesce(p_bin,'')),''),
      p_max_discount_percent, p_max_discount_amount)
    returning * into v_row;
  else
    update public.products p set
      -- A blank box on an existing product keeps the code it has; a product
      -- does not lose its number because somebody cleared a field.
      sku = coalesce(v_sku, p.sku), barcode = nullif(trim(coalesce(p_barcode,'')),''),
      name = trim(p_name), description = p_description, category_id = p_category_id,
      unit_code = p_unit_code, price_retail = p_price_retail,
      price_trade = p_price_trade, cost = p_cost,
      tax_code = coalesce(p_tax_code,'standard'), stock_qty = p_stock_qty,
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
      updated_at = now()
    where p.id = p_id and p.org_id = v_user.org_id
    returning * into v_row;
    if not found then raise exception 'Product not found'; end if;
  end if;
  return v_row;
end;
$$;
