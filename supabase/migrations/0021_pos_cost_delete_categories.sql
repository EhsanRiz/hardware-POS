-- ---------------------------------------------------------------------------
-- Item cost (for markup), product deletion, and category management.
-- ---------------------------------------------------------------------------

-- Optional cost price on products and variants (markup is shown in the admin UI).
alter table public.products         add column if not exists cost numeric(10,2);
alter table public.product_variants add column if not exists cost numeric(10,2);

-- Allow deleting a product even if it has sales history: keep the line items
-- (their name/price snapshot stands) but null out the product link.
alter table public.sale_items drop constraint if exists sale_items_product_id_fkey;
alter table public.sale_items
  add constraint sale_items_product_id_fkey
  foreign key (product_id) references public.products(id) on delete set null;

-- Delete a product (its variants cascade; sale history is preserved).
create or replace function public.pos_manager_delete_product(p_manager_pin text, p_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'manage_menu');
  if v_actor.id is null then raise exception 'Not permitted to manage the menu'; end if;
  delete from public.products where id = p_id;
  if not found then raise exception 'Product not found'; end if;
end;
$$;
revoke all on function public.pos_manager_delete_product(text, uuid) from public;
grant execute on function public.pos_manager_delete_product(text, uuid) to anon, authenticated;

-- Rename a category (moves every product in it). Doubles as a merge when the
-- new name already exists.
create or replace function public.pos_manager_rename_category(
  p_manager_pin text, p_old text, p_new text
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_new text := nullif(trim(p_new), '');
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'manage_menu');
  if v_actor.id is null then raise exception 'Not permitted to manage the menu'; end if;
  if v_new is null then raise exception 'Category name is required'; end if;
  update public.products set category = v_new where category = p_old;
end;
$$;
revoke all on function public.pos_manager_rename_category(text, text, text) from public;
grant execute on function public.pos_manager_rename_category(text, text, text) to anon, authenticated;

-- Delete a category by moving its products to another one (default 'Other').
create or replace function public.pos_manager_delete_category(
  p_manager_pin text, p_name text, p_reassign_to text default 'Other'
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_to text := coalesce(nullif(trim(p_reassign_to), ''), 'Other');
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'manage_menu');
  if v_actor.id is null then raise exception 'Not permitted to manage the menu'; end if;
  update public.products set category = v_to where category = p_name;
end;
$$;
revoke all on function public.pos_manager_delete_category(text, text, text) from public;
grant execute on function public.pos_manager_delete_category(text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Manager list + save now carry `cost` on products and variants.
-- ---------------------------------------------------------------------------
drop function if exists public.pos_manager_list_products(text);
create function public.pos_manager_list_products(p_manager_pin text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_out jsonb;
begin
  select * into v_user from public.app_users u
    where u.active and u.pin_hash = crypt(p_manager_pin, u.pin_hash)
      and (u.role='admin' or 'manage_menu' = any(u.permissions)
           or 'manage_inventory' = any(u.permissions))
    limit 1;
  if not found then raise exception 'Not permitted'; end if;

  select coalesce(jsonb_agg(obj order by cat, so, nm), '[]'::jsonb)
    into v_out
  from (
    select p.category cat, p.sort_order so, p.name nm,
      jsonb_build_object(
        'id', p.id, 'name', p.name, 'category', p.category, 'price', p.price,
        'cost', p.cost, 'image_url', p.image_url, 'active', p.active,
        'sort_order', p.sort_order, 'stock_qty', p.stock_qty,
        'variants', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', v.id, 'name', v.name, 'size', v.size, 'price', v.price,
            'cost', v.cost, 'stock_qty', v.stock_qty, 'active', v.active,
            'sort_order', v.sort_order)
            order by v.sort_order, v.price), '[]'::jsonb)
          from public.product_variants v where v.product_id = p.id)
      ) obj
    from public.products p
  ) t;
  return v_out;
end;
$$;
revoke all on function public.pos_manager_list_products(text) from public;
grant execute on function public.pos_manager_list_products(text) to anon, authenticated;

drop function if exists public.pos_manager_save_product(text,uuid,text,text,numeric,text,boolean,int,int,jsonb);
create function public.pos_manager_save_product(
  p_manager_pin text, p_id uuid, p_name text, p_category text, p_price numeric,
  p_cost numeric, p_image_url text, p_active boolean, p_sort_order int, p_stock_qty int,
  p_variants jsonb
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_actor public.app_users; v_prod public.products;
  v_item jsonb; v_keep uuid[] := array[]::uuid[]; v_vid uuid;
begin
  v_actor := public.pos_user_with_perm(p_manager_pin, 'manage_menu');
  if v_actor.id is null then raise exception 'Not permitted to manage the menu'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Name is required'; end if;
  if p_price is null or p_price < 0 then raise exception 'Price must be 0 or more'; end if;

  if p_id is null then
    insert into public.products(name, category, price, cost, image_url, active, sort_order, stock_qty)
    values (trim(p_name), coalesce(nullif(trim(p_category), ''), 'Other'), p_price, p_cost,
            nullif(trim(p_image_url), ''), coalesce(p_active, true),
            coalesce(p_sort_order, 0), p_stock_qty)
    returning * into v_prod;
  else
    update public.products set
      name = trim(p_name), category = coalesce(nullif(trim(p_category), ''), 'Other'),
      price = p_price, cost = p_cost, image_url = nullif(trim(p_image_url), ''),
      active = coalesce(p_active, active), sort_order = coalesce(p_sort_order, sort_order),
      stock_qty = p_stock_qty
    where id = p_id returning * into v_prod;
    if not found then raise exception 'Product not found'; end if;
  end if;

  if p_variants is not null then
    for v_item in select * from jsonb_array_elements(p_variants) loop
      if coalesce(nullif(v_item->>'price', ''), '') = '' then
        raise exception 'Each variant needs a price';
      end if;
      if coalesce(nullif(v_item->>'id', ''), '') = '' then
        insert into public.product_variants(product_id, name, size, price, cost, stock_qty, active, sort_order)
        values (v_prod.id, nullif(trim(v_item->>'name'), ''), nullif(trim(v_item->>'size'), ''),
                (v_item->>'price')::numeric, nullif(v_item->>'cost', '')::numeric,
                nullif(v_item->>'stock_qty', '')::int,
                coalesce((v_item->>'active')::boolean, true),
                coalesce((v_item->>'sort_order')::int, 0))
        returning id into v_vid;
      else
        v_vid := (v_item->>'id')::uuid;
        update public.product_variants set
          name = nullif(trim(v_item->>'name'), ''), size = nullif(trim(v_item->>'size'), ''),
          price = (v_item->>'price')::numeric, cost = nullif(v_item->>'cost', '')::numeric,
          stock_qty = nullif(v_item->>'stock_qty', '')::int,
          active = coalesce((v_item->>'active')::boolean, true),
          sort_order = coalesce((v_item->>'sort_order')::int, 0)
        where id = v_vid and product_id = v_prod.id;
      end if;
      v_keep := array_append(v_keep, v_vid);
    end loop;
    delete from public.product_variants where product_id = v_prod.id and not (id = any(v_keep));
  end if;

  return jsonb_build_object(
    'id', v_prod.id, 'name', v_prod.name, 'category', v_prod.category, 'price', v_prod.price,
    'cost', v_prod.cost, 'image_url', v_prod.image_url, 'active', v_prod.active,
    'sort_order', v_prod.sort_order, 'stock_qty', v_prod.stock_qty,
    'variants', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', v.id, 'name', v.name, 'size', v.size, 'price', v.price, 'cost', v.cost,
        'stock_qty', v.stock_qty, 'active', v.active, 'sort_order', v.sort_order)
        order by v.sort_order, v.price), '[]'::jsonb)
      from public.product_variants v where v.product_id = v_prod.id));
end;
$$;
revoke all on function public.pos_manager_save_product(text,uuid,text,text,numeric,numeric,text,boolean,int,int,jsonb) from public;
grant execute on function public.pos_manager_save_product(text,uuid,text,text,numeric,numeric,text,boolean,int,int,jsonb) to anon, authenticated;
