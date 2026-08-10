-- Hardware POS — lock down the API surface.
--
-- Supabase exposes every function in `public` over PostgREST, so a helper that
-- was only ever meant to be called from inside another function is reachable at
-- /rest/v1/rpc/<name> with nothing but the anon key that ships in the PWA.
-- Two consequences, both found by the database linter on the first run:
--
--   * user_by_pin returns the whole app_users row, pin_hash included. Anyone
--     with the anon key could guess a PIN and be handed the bcrypt hash to
--     crack offline at their leisure. That is strictly worse than the cafe
--     build's known PIN-brute-force exposure, and it is fixed here.
--   * A mutable search_path on a SECURITY DEFINER function lets a caller who
--     can create objects shadow the tables the function references.
--
-- The rule this establishes: only the pos_* entry points are callable from the
-- device. Everything else is internal and runs as the owner from inside them.

-- 1. Pin down search_path on everything ---------------------------------------

alter function public.role_default_permissions(user_role)     set search_path = public, extensions;
alter function public.effective_permissions(public.app_users) set search_path = public, extensions;
alter function public.next_doc_number(text)                   set search_path = public, extensions;
alter function public.tax_rate_at(text, date)                 set search_path = public, extensions;
alter function public.touch_updated_at()                      set search_path = public, extensions;
alter function public.price_for(public.products, boolean)     set search_path = public, extensions;
alter function public.customer_balance(uuid)                  set search_path = public, extensions;
alter function public.customer_available_credit(uuid)         set search_path = public, extensions;
alter function public.apply_stock(uuid, numeric, stock_reason, text, uuid, public.app_users, text)
  set search_path = public, extensions;
alter function public.settle_stock_for_sale(uuid, int, stock_reason, public.app_users)
  set search_path = public, extensions;

-- 2. Internal helpers must not be callable from the device --------------------

revoke execute on function public.user_by_pin(text)            from anon, authenticated, public;
revoke execute on function public.user_with_perm(text, text)   from anon, authenticated, public;
revoke execute on function public.effective_permissions(public.app_users) from anon, authenticated, public;
revoke execute on function public.role_default_permissions(user_role)    from anon, authenticated, public;
revoke execute on function public.next_doc_number(text)        from anon, authenticated, public;
revoke execute on function public.apply_stock(uuid, numeric, stock_reason, text, uuid, public.app_users, text)
  from anon, authenticated, public;
revoke execute on function public.settle_stock_for_sale(uuid, int, stock_reason, public.app_users)
  from anon, authenticated, public;
revoke execute on function public.customer_balance(uuid)              from anon, authenticated, public;
revoke execute on function public.customer_available_credit(uuid)     from anon, authenticated, public;
revoke execute on function public.price_for(public.products, boolean) from anon, authenticated, public;

-- The till's entry points stay open by design: the PIN is the credential and it
-- is verified inside each one.
grant execute on function public.pos_login(text)                 to anon, authenticated;
grant execute on function public.pos_create_sale(text, jsonb, uuid, text, numeric, text, numeric, numeric, numeric, uuid, text)
  to anon, authenticated;
grant execute on function public.pos_approve_sale(uuid, text)    to anon, authenticated;
grant execute on function public.pos_void_sale(uuid, text, text) to anon, authenticated;
grant execute on function public.tax_rate_at(text, date)         to anon, authenticated;

-- 3. Catalogue: a safe projection without a SECURITY DEFINER view -------------

-- The view created in 0002 was SECURITY DEFINER, which bypasses the caller's
-- RLS entirely — more power than reading a price list needs. Instead: let the
-- device read active products under RLS, but withhold `cost` at the grant level
-- so margins stay private even if someone queries the table directly.
drop view if exists public.catalogue;

create policy products_read on public.products
  for select to anon, authenticated using (active);

revoke select on public.products from anon, authenticated;
grant select (id, sku, barcode, name, description, category_id, unit_code,
              price_retail, price_trade, tax_code, stock_qty, reorder_level,
              image_url, active, sort_order)
  on public.products to anon, authenticated;

create view public.catalogue with (security_invoker = on) as
  select p.id, p.sku, p.barcode, p.name, p.description,
         p.category_id, c.name as category_name,
         p.unit_code, u.name as unit_name, u.allows_fraction,
         p.price_retail, p.price_trade, p.tax_code,
         p.stock_qty, p.reorder_level, p.image_url, p.sort_order
  from public.products p
  left join public.categories c on c.id = p.category_id
  join public.units_of_measure u on u.code = p.unit_code
  where p.active;

grant select on public.catalogue to anon, authenticated;
