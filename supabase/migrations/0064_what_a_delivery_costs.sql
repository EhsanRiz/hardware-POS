-- 0064 — what a delivery costs the shop.
--
-- Delivery showed at a hundred percent margin, which is honest gross profit
-- and a lie about the business: a delivery costs fuel and an hour of
-- somebody's time, and the shop was recording neither. A carriage line that
-- looks like the most profitable thing in the shop is worse than no figure at
-- all, because somebody will price against it.
--
-- WHERE THE FIGURE LIVES. On the delivery product's `cost`, and nowhere else.
-- pos_create_sale already copies a product's cost onto every line it writes
-- (cost_at_sale), and every report downstream — departments, items, the
-- export — already reads that. So one number in one place makes all of them
-- truthful at once, with no new plumbing and nothing that can drift out of
-- step with anything else.
--
-- It is a flat per-trip figure rather than a rate per kilometre, because a
-- flat figure is one a shop can actually produce and maintain: fuel there and
-- back, plus what the driver's hour is worth. A shop that wants it exact can
-- change it whenever the diesel price moves.

-- The settings screen has to be able to read it back, so pos_org_settings
-- gains a column — dropped and recreated rather than replaced, because
-- changing a function's return columns in place is refused and a `create or
-- replace` with a new signature would leave the old one standing beside it.
-- (CLAUDE.md, migrations.)
drop function if exists public.pos_org_settings(text);

create function public.pos_org_settings(p_register_token text)
returns table(shop_name text, address_line1 text, address_line2 text,
              phone text, vat_number text, currency text,
              registration_number text, email text,
              bank_name text, bank_account_name text,
              bank_account_number text, bank_branch_code text,
              vat_rate numeric, quote_show_line_prices boolean,
              receipt_terms text, quote_terms text, logo_url text,
              delivery_cost numeric)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query select o.name, o.address_line1, o.address_line2, o.phone,
                      o.vat_number, o.currency, o.registration_number,
                      o.email, o.bank_name, o.bank_account_name,
                      o.bank_account_number, o.bank_branch_code,
                      coalesce(public.tax_rate_at('standard', current_date), 0),
                      o.quote_show_line_prices,
                      o.receipt_terms, o.quote_terms, o.logo_url,
                      -- Read off the delivery line itself, which is the only
                      -- place it is kept. Null until a shop has said.
                      (select p.cost from public.products p
                        where p.org_id = o.id and p.kind = 'delivery'
                        order by p.created_at limit 1)
    from public.organizations o where o.id = v_reg.org_id;
end;
$$;
grant execute on function public.pos_org_settings(text) to anon, authenticated;

/**
 * Set what a trip costs.
 *
 * Separate from pos_admin_save_settings because it does not write to
 * organizations at all: it writes to the delivery product, making it first if
 * the shop has never charged for a delivery. Folding it into the settings
 * save would have meant that function knowing about the catalogue.
 */
create or replace function public.pos_admin_set_delivery_cost(
  p_register_token text, p_pin text, p_cost numeric
) returns numeric
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid; v_product public.products;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_settings');
  if p_cost is null or p_cost < 0 then
    raise exception 'A delivery cannot cost less than nothing';
  end if;
  v_product := public.delivery_product(v_org);
  update public.products set cost = round(p_cost, 2) where id = v_product.id;
  return round(p_cost, 2);
end;
$$;

grant execute on function public.pos_admin_set_delivery_cost(text, text, numeric)
  to anon, authenticated;

-- The report says what the carriage earned and what it cost, so the number an
-- owner actually wants — what delivering is worth after paying for it — is on
-- the page rather than in their head.
create or replace function public.pos_deliveries_report(
  p_register_token text, p_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_totals jsonb; v_rows jsonb;
        v_net numeric; v_cost numeric;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  if p_from is null or p_to is null then raise exception 'A date range is required'; end if;
  if p_to < p_from then raise exception 'Those dates are the wrong way round'; end if;

  -- Earned and cost come from the same lines, walked once: the invoice is
  -- what the books believe, and cost_at_sale is what the trip was worth when
  -- it was made rather than what the figure happens to be today.
  select coalesce(sum(si.line_total - si.tax_amount), 0),
         coalesce(sum(si.cost_at_sale * si.qty), 0)
    into v_net, v_cost
    from public.sale_items si
    join public.sales sa on sa.id = si.sale_id
    join public.products p on p.id = si.product_id
   where sa.org_id = v_user.org_id and sa.status = 'completed'
     and coalesce(p.kind, 'goods') = 'delivery'
     and sa.created_at >= p_from and sa.created_at < p_to;

  with d as (
    select * from public.deliveries
     where org_id = v_user.org_id
       and created_at >= p_from and created_at < p_to
  )
  select jsonb_build_object(
    'count',        (select count(*) from d),
    'delivered',    (select count(*) filter (where status = 'delivered') from d),
    'outstanding',  (select count(*) filter (where status = 'pending') from d),
    -- Promised for a day that has passed and still not signed for. Counted
    -- across the whole book, not only this window: a note from three weeks ago
    -- that never went out is exactly the one nobody is looking at.
    'late',         (select count(*) from public.deliveries
                      where org_id = v_user.org_id and status = 'pending'
                        and deliver_on < current_date),
    'carriage',     (select coalesce(sum(charge), 0) from d),
    'carriage_free',(select count(*) filter (where charge = 0) from d),
    'carriage_net', v_net,
    'carriage_cost', v_cost,
    -- What delivering is actually worth. It can be negative, and a shop that
    -- delivers free to keep a builder happy should be able to see what that
    -- decision costs rather than assume it is free.
    'carriage_margin', round(v_net - v_cost, 2)
  ) into v_totals;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'doc_number', x.doc_number, 'customer_name', x.customer_name,
           'address', x.address, 'deliver_on', x.deliver_on, 'deliver_at', x.deliver_at,
           'charge', x.charge, 'sale_number', x.sale_number, 'cashier_name', x.cashier_name,
           'days_late', greatest(0, current_date - x.deliver_on)
         ) order by x.deliver_on, x.created_at), '[]'::jsonb)
    into v_rows
    from (
      select d.*, s.doc_number as sale_number
        from public.deliveries d
        join public.sales s on s.id = d.sale_id
       where d.org_id = v_user.org_id and d.status = 'pending'
       limit 200
    ) x;

  return jsonb_build_object('totals', v_totals, 'outstanding', v_rows);
end;
$$;

grant execute on function public.pos_deliveries_report(text, text, timestamptz, timestamptz)
  to anon, authenticated;
