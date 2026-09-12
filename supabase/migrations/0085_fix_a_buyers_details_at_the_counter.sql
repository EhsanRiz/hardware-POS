-- 0085: fix a buyer's details at the counter.
--
-- A wrong digit in a phone number, a misspelt name, a new address: the
-- cashier is the one who hears about it, standing in front of the person,
-- and until now could only pass it to the back office. So the same right
-- that lets them record a buyer (take_payments) lets them put these three
-- things right. Nothing about money moves here: credit limit, trade price,
-- account code and VAT number stay exactly as the back office set them.
--
-- A number must stay unique within the shop: it is the key a buyer is found
-- under, and two records on one number would be found by chance.

create function public.pos_customer_fix_details(
  p_register_token text, p_cashier_id uuid, p_customer_id uuid,
  p_name text, p_phone text, p_address text default null
) returns table(id uuid, code text, name text, phone text, is_trade boolean,
                credit_limit numeric, balance numeric, available numeric,
                vat_number text, address text)
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users;
  v_phone text; v_name text; v_other text;
begin
  v_reg := public.register_by_token(p_register_token);

  select * into v_user from public.app_users
   where app_users.id = p_cashier_id and org_id = v_reg.org_id
     and active and status = 'active';
  if not found then raise exception 'Unknown cashier'; end if;
  if not ('take_payments' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted to take payments';
  end if;

  if not exists (select 1 from public.customers c
                  where c.id = p_customer_id and c.org_id = v_reg.org_id) then
    raise exception 'No such customer';
  end if;

  v_name := nullif(trim(coalesce(p_name, '')), '');
  if v_name is null then raise exception 'A name is needed'; end if;

  v_phone := public.normalize_phone(
    p_phone, (select o.dial_code from public.organizations o where o.id = v_reg.org_id));
  if v_phone is null then
    raise exception 'That does not look like a phone number';
  end if;

  select c.name into v_other from public.customers c
   where c.org_id = v_reg.org_id and c.phone_e164 = v_phone and c.id <> p_customer_id;
  if v_other is not null then
    raise exception 'That number is already on file for %', v_other;
  end if;

  update public.customers c set
    name    = v_name,
    phone   = trim(p_phone),
    address = nullif(trim(coalesce(p_address, '')), '')
   where c.id = p_customer_id;

  return query
    select c.id, c.code, c.name, c.phone, c.is_trade, c.credit_limit,
           public.customer_balance(c.id), public.customer_available_credit(c.id),
           c.vat_number, c.address
    from public.customers c where c.id = p_customer_id;
end;
$$;

grant execute on function public.pos_customer_fix_details(text, uuid, uuid, text, text, text)
  to anon, authenticated;
