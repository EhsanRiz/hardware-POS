-- Whether a printed quote prices each line, or only the job.
--
-- A hardware counter quoting a build gives the customer a piece of paper that
-- competitors read. Itemised, it is a shopping list: the customer takes it down
-- the road, gets the cement matched, and comes back for the two lines nobody
-- else stocks — or does not come back at all. Quoting a total instead is the
-- ordinary practice in the trade, and a shop that cannot do it will either not
-- quote on paper or keep the pad it was trying to replace.
--
-- The scope still prints. What goes is the money against each line, not the
-- line: a quote that does not say what is included is not a quote, it is a
-- number. The customer sees everything they are buying and one price for it.
--
-- A shop setting rather than a per-quote tick. The shops that want this want it
-- every time, and a choice made afresh at every counter is a choice that will
-- eventually be forgotten with a contractor standing there. Default true, so
-- nothing changes for anybody who has not asked for it.
--
-- Deliberately NOT applied to the invoice. A tax invoice must itemise — that is
-- SARS's requirement and not the shop's preference — so this touches the quote
-- and nothing else.

alter table public.organizations
  add column if not exists quote_show_line_prices boolean not null default true;

comment on column public.organizations.quote_show_line_prices is
  'Whether a printed QUOTE prices each line. False prints the scope and one '
  'total. Never applies to a tax invoice, which must itemise by law.';

-- Dropped and recreated: the return columns change.
drop function if exists public.pos_org_settings(text);
create function public.pos_org_settings(p_register_token text)
returns table(shop_name text, address_line1 text, address_line2 text,
              phone text, vat_number text, currency text,
              registration_number text, email text,
              bank_name text, bank_account_name text,
              bank_account_number text, bank_branch_code text,
              vat_rate numeric, quote_show_line_prices boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query select o.name, o.address_line1, o.address_line2, o.phone,
                      o.vat_number, o.currency, o.registration_number,
                      o.email, o.bank_name, o.bank_account_name,
                      o.bank_account_number, o.bank_branch_code,
                      -- The standard rate as it stands today, from the same
                      -- table pos_create_sale reads. The till displays this
                      -- rather than a figure compiled into the build, so the
                      -- number on screen cannot outlive the number charged.
                      coalesce(public.tax_rate_at('standard', current_date), 0),
                      o.quote_show_line_prices
    from public.organizations o where o.id = v_reg.org_id;
end;
$$;
grant execute on function public.pos_org_settings(text) to anon, authenticated;

create or replace function public.pos_admin_save_settings(
  p_register_token text, p_pin text, p_settings jsonb
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_settings');
  update public.organizations set
    name = coalesce(p_settings->>'shop_name', name),
    address_line1 = coalesce(p_settings->>'address_line1', address_line1),
    address_line2 = coalesce(p_settings->>'address_line2', address_line2),
    phone = coalesce(p_settings->>'phone', phone),
    vat_number = coalesce(p_settings->>'vat_number', vat_number),
    currency = coalesce(p_settings->>'currency', currency),
    registration_number = coalesce(p_settings->>'registration_number', registration_number),
    email = coalesce(p_settings->>'email', email),
    bank_name = coalesce(p_settings->>'bank_name', bank_name),
    bank_account_name = coalesce(p_settings->>'bank_account_name', bank_account_name),
    bank_account_number = coalesce(p_settings->>'bank_account_number', bank_account_number),
    bank_branch_code = coalesce(p_settings->>'bank_branch_code', bank_branch_code),
    -- Read through ->> and cast, like every other field here, so a settings
    -- payload that omits it leaves the shop's choice alone. A jsonb `false`
    -- must still be able to turn it off, which `coalesce` on the CAST does and
    -- a truthiness test would not.
    quote_show_line_prices = coalesce(
      (p_settings->>'quote_show_line_prices')::boolean, quote_show_line_prices)
  where id = v_user.org_id;
end;
$$;
grant execute on function public.pos_admin_save_settings(text, text, jsonb)
  to anon, authenticated;
