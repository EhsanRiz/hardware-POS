-- 0052: the small print, and whose quote it is.
--
-- Every hardware slip in the country ends with the same paragraph — bring it
-- back within so many days with the slip and the packaging, special orders and
-- tinted paint are yours once mixed, the manufacturer's warranty is the
-- manufacturer's — and ours ended with "Thank you". The customer who wants to
-- return a special-order basin on day twelve reads the slip, not the sign
-- behind the counter, so the policy goes on the slip.
--
-- Two texts, not one: what is printed on an invoice is a returns policy, what
-- is printed on a quote is about validity and stock. Both are the shop's own
-- words, edited under Manage → Shop, and seeded here with wording a shop can
-- print as it stands.
--
-- Quotes also learn whose they are. A quote for "Walk-in" is a quote for
-- nobody: the builder who phones on Thursday asking for "my quote" cannot be
-- found by name, and the paper he was handed does not say who it was for. A
-- name can now be given without opening an account, and is printed on the
-- quote.

alter table public.organizations
  add column if not exists receipt_terms text,
  add column if not exists quote_terms text;

update public.organizations set receipt_terms =
  'Returns within 10 days with this invoice and the original packaging, unused and in resaleable condition. '
  || 'No returns on special orders, cut lengths or tinted paint. '
  || 'Goods carry the manufacturer''s warranty only. '
  || 'Deliveries are checked and signed for on receipt; claims after signature are not accepted.'
  where receipt_terms is null;

update public.organizations set quote_terms =
  'Prices are subject to stock availability and may change without notice after the date shown. '
  || 'Special orders and tinted paint are paid in full when ordered and cannot be returned.'
  where quote_terms is null;

-- Return columns changed: drop and recreate, as 0042 did.
drop function if exists public.pos_org_settings(text);
create function public.pos_org_settings(p_register_token text)
returns table(shop_name text, address_line1 text, address_line2 text,
              phone text, vat_number text, currency text,
              registration_number text, email text,
              bank_name text, bank_account_name text,
              bank_account_number text, bank_branch_code text,
              vat_rate numeric, quote_show_line_prices boolean,
              receipt_terms text, quote_terms text)
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
                      o.receipt_terms, o.quote_terms
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
    quote_show_line_prices = coalesce(
      (p_settings->>'quote_show_line_prices')::boolean, quote_show_line_prices),
    -- An empty string is a decision — a shop that wants no small print clears
    -- the box — and is kept, unlike a payload that never mentioned the field.
    receipt_terms = coalesce(p_settings->>'receipt_terms', receipt_terms),
    quote_terms = coalesce(p_settings->>'quote_terms', quote_terms)
  where id = v_user.org_id;
end;
$$;
grant execute on function public.pos_admin_save_settings(text, text, jsonb)
  to anon, authenticated;

-- A new defaulted argument is a new signature. The old one goes first or every
-- caller that names no optional argument becomes ambiguous (CLAUDE.md).
drop function if exists public.pos_save_quote(text, uuid, jsonb, uuid, int, text);
create function public.pos_save_quote(
  p_register_token text, p_cashier_id uuid, p_items jsonb,
  p_customer_id uuid default null, p_valid_days int default 14,
  p_note text default null, p_customer_name text default null
) returns table(quote_id uuid, doc_number text, valid_until date, total numeric)
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_customer public.customers;
  v_trade boolean := false; v_item jsonb; v_product public.products;
  v_qty numeric; v_price numeric; v_line numeric; v_subtotal numeric := 0;
  v_quote public.quotes; v_name text;
begin
  v_reg := public.register_by_token(p_register_token);

  select * into v_user from public.app_users
   where id = p_cashier_id and org_id = v_reg.org_id and active and status = 'active';
  if not found then raise exception 'Unknown cashier'; end if;
  if not ('take_payments' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted to take payments';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'An empty quote is not a quote';
  end if;

  -- The account's name when there is an account; otherwise whatever the
  -- counter was told. An account customer's quote keeps the account's name so
  -- the list, the statement and the paper agree on who this is.
  v_name := nullif(left(trim(coalesce(p_customer_name, '')), 120), '');
  if p_customer_id is not null then
    select * into v_customer from public.customers
     where id = p_customer_id and org_id = v_reg.org_id and active;
    if not found then raise exception 'Unknown customer'; end if;
    v_trade := v_customer.is_trade;
    v_name := v_customer.name;
  end if;

  insert into public.quotes(org_id, doc_number, cashier_id, cashier_name,
    customer_id, customer_name, trade_pricing, subtotal, total, valid_until, note)
  values (v_reg.org_id, public.next_doc_number(v_reg.org_id, 'quote'),
    v_user.id, v_user.name, p_customer_id, v_name, v_trade, 0, 0,
    current_date + greatest(1, least(coalesce(p_valid_days, 14), 90)),
    nullif(trim(coalesce(p_note, '')), ''))
  returning * into v_quote;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
     where id = (v_item->>'product_id')::uuid
       and org_id = v_reg.org_id and active;
    if not found then raise exception 'Unknown product on the quote'; end if;

    v_qty := round((v_item->>'qty')::numeric, 3);
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every line needs a quantity above zero';
    end if;

    v_price := public.price_for(v_product, v_trade);
    v_line := round(v_price * v_qty, 2);
    v_subtotal := v_subtotal + v_line;

    insert into public.quote_items(quote_id, product_id, sku, name, unit_code,
                                   qty, unit_price, line_total)
    values (v_quote.id, v_product.id, v_product.sku, v_product.name,
            v_product.unit_code, v_qty, v_price, v_line);
  end loop;

  update public.quotes set subtotal = v_subtotal, total = v_subtotal
   where id = v_quote.id returning * into v_quote;

  return query select v_quote.id, v_quote.doc_number, v_quote.valid_until,
                      v_quote.total;
end;
$$;
grant execute on function public.pos_save_quote(text, uuid, jsonb, uuid, int, text, text)
  to anon, authenticated;
