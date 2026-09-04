-- 0059: the shop's own mark, on the documents that leave the building.
--
-- A quotation for a R40 000 job and a tax invoice a bookkeeper files are the
-- two pieces of paper a customer judges the shop by, and both were going out
-- as a curl of till roll. They are A4 documents now, built in the browser and
-- printed or saved as PDF — and a shop that has a logo should see it on them
-- without anybody redeploying anything.
--
-- The file itself lives in the product-images bucket, which is already public
-- and already written only by an edge function holding the service role. A
-- logo is meant to be seen, so public is right; the path just says logo.

alter table public.organizations
  add column if not exists logo_url text;

-- Return columns change, so drop and recreate (CLAUDE.md).
drop function if exists public.pos_org_settings(text);
create function public.pos_org_settings(p_register_token text)
returns table(shop_name text, address_line1 text, address_line2 text,
              phone text, vat_number text, currency text,
              registration_number text, email text,
              bank_name text, bank_account_name text,
              bank_account_number text, bank_branch_code text,
              vat_rate numeric, quote_show_line_prices boolean,
              receipt_terms text, quote_terms text, logo_url text)
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
                      o.receipt_terms, o.quote_terms, o.logo_url
    from public.organizations o where o.id = v_reg.org_id;
end;
$$;
grant execute on function public.pos_org_settings(text) to anon, authenticated;

-- Same jsonb payload, one more field: no new signature, so replaced in place.
-- An empty string is a decision (the shop took its logo off) and is kept, as
-- the small print fields are.
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
    quote_show_line_prices = coalesce(
      (p_settings->>'quote_show_line_prices')::boolean, quote_show_line_prices),
    receipt_terms = coalesce(p_settings->>'receipt_terms', receipt_terms),
    quote_terms = coalesce(p_settings->>'quote_terms', quote_terms),
    logo_url = coalesce(p_settings->>'logo_url', logo_url)
  where id = v_user.org_id;
end;
$$;
grant execute on function public.pos_admin_save_settings(text, text, jsonb)
  to anon, authenticated;
