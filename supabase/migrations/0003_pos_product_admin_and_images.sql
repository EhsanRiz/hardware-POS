-- Item photos + manager-managed menu

alter table public.products add column if not exists image_url text;

-- Manager-gated: list ALL products (incl. inactive) for the admin screen.
create or replace function public.pos_manager_list_products(p_manager_pin text)
returns setof public.products
language plpgsql security definer set search_path = public, extensions as $$
declare v_mgr public.app_users;
begin
  select * into v_mgr from public.app_users
    where role = 'manager' and active and pin_hash = crypt(p_manager_pin, pin_hash) limit 1;
  if not found then raise exception 'Invalid manager PIN'; end if;
  return query select * from public.products order by category, sort_order, name;
end;
$$;

-- Manager-gated: create (p_id null) or update a product.
create or replace function public.pos_manager_upsert_product(
  p_manager_pin text,
  p_id         uuid,
  p_name       text,
  p_category   text,
  p_price      numeric,
  p_image_url  text,
  p_active     boolean,
  p_sort_order int
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_mgr  public.app_users;
  v_prod public.products;
begin
  select * into v_mgr from public.app_users
    where role = 'manager' and active and pin_hash = crypt(p_manager_pin, pin_hash) limit 1;
  if not found then raise exception 'Invalid manager PIN'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Name is required'; end if;
  if p_price is null or p_price < 0 then raise exception 'Price must be 0 or more'; end if;

  if p_id is null then
    insert into public.products(name, category, price, image_url, active, sort_order)
    values (trim(p_name), coalesce(nullif(trim(p_category), ''), 'Other'),
            p_price, nullif(trim(p_image_url), ''), coalesce(p_active, true),
            coalesce(p_sort_order, 0))
    returning * into v_prod;
  else
    update public.products set
      name       = trim(p_name),
      category   = coalesce(nullif(trim(p_category), ''), 'Other'),
      price      = p_price,
      image_url  = nullif(trim(p_image_url), ''),
      active     = coalesce(p_active, active),
      sort_order = coalesce(p_sort_order, sort_order)
    where id = p_id
    returning * into v_prod;
    if not found then raise exception 'Product not found'; end if;
  end if;
  return v_prod;
end;
$$;

revoke all on function public.pos_manager_list_products(text) from public;
revoke all on function public.pos_manager_upsert_product(text, uuid, text, text, numeric, text, boolean, int) from public;
grant execute on function public.pos_manager_list_products(text) to anon, authenticated;
grant execute on function public.pos_manager_upsert_product(text, uuid, text, text, numeric, text, boolean, int) to anon, authenticated;

-- Public bucket for item photos.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- Public read; the in-shop device (anon key) may upload/replace within this bucket.
drop policy if exists product_images_read on storage.objects;
drop policy if exists product_images_write on storage.objects;
drop policy if exists product_images_update on storage.objects;
create policy product_images_read on storage.objects
  for select using (bucket_id = 'product-images');
create policy product_images_write on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'product-images');
create policy product_images_update on storage.objects
  for update to anon, authenticated using (bucket_id = 'product-images');
