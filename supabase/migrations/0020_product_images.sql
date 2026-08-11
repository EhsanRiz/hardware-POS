-- More than one photograph per product.
--
-- Watching a real counter made the case: their hose sets run HHOSEG001 to
-- HHOSEG008 and differ only by length and colour. A cashier reading eight
-- near-identical descriptions under time pressure will eventually ring up the
-- 15m instead of the 30m. A picture settles it in a glance — which is why the
-- image belongs in the SEARCH RESULT, not only on a product-detail page.
--
-- products.image_url stays as the primary image so nothing that reads it
-- breaks; this table holds that one and any others, in display order.
--
-- The files live in the public 'product-images' storage bucket, written only
-- by the product-image edge function, which holds the service role and checks
-- the till's token and the manager's PIN before it stores anything. A bucket
-- writable with the anon key would be a bucket anyone on the internet can fill.

create table if not exists public.product_images (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  -- A storage PATH, not a URL: the client resolves it through its own origin,
  -- so a shop's network filter never sees a third-party image request.
  url        text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists product_images_product_idx
  on public.product_images(product_id, sort_order);

alter table public.product_images enable row level security;

create or replace function public.pos_product_images(
  p_register_token text, p_product_id uuid
) returns table(id uuid, url text, sort_order int)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select i.id, i.url, i.sort_order
    from public.product_images i
    where i.product_id = p_product_id and i.org_id = v_reg.org_id
    order by i.sort_order, i.created_at;
end;
$$;
grant execute on function public.pos_product_images(text, uuid) to anon, authenticated;

create or replace function public.pos_admin_add_product_image(
  p_register_token text, p_pin text, p_product_id uuid, p_url text,
  p_sort_order int default 0
) returns uuid
language plpgsql security definer
set search_path = public, extensions as $$
declare v_user public.app_users; v_id uuid;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
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
grant execute on function public.pos_admin_add_product_image(text, text, uuid, text, int)
  to anon, authenticated;

create or replace function public.pos_admin_remove_product_image(
  p_register_token text, p_pin text, p_image_id uuid
) returns void
language plpgsql security definer
set search_path = public, extensions as $$
declare v_user public.app_users; v_product uuid;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  delete from public.product_images
   where id = p_image_id and org_id = v_user.org_id
   returning product_id into v_product;
  if v_product is null then raise exception 'Image not found'; end if;

  -- If that was the primary, promote whatever is left rather than leaving the
  -- till pointing at a deleted file.
  update public.products p
     set image_url = (select i.url from public.product_images i
                       where i.product_id = v_product
                       order by i.sort_order, i.created_at limit 1),
         updated_at = now()
   where p.id = v_product and p.org_id = v_user.org_id;
end;
$$;
grant execute on function public.pos_admin_remove_product_image(text, text, uuid)
  to anon, authenticated;

-- The bucket itself. Public read; writes only ever come from the edge function.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg','image/png','image/webp'];
