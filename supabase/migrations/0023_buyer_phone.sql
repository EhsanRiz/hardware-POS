-- The buyer's phone number, and what it is for.
--
-- A hardware shop sells grinders, drills and geysers, and those come back.
-- "I bought it here in March" is unanswerable today unless the customer kept
-- the slip. A phone number turns that into a three-second lookup, and it saves
-- a VAT-registered trade buyer from dictating their address and VAT number on
-- every visit.
--
-- Three rules are built into this migration rather than left to the UI:
--
--   1. A number is stored normalised, so 082 123 4567, +27 82 123 4567 and
--      0821234567 are one buyer and not three. Without this the whole feature
--      quietly fails: you get a new "repeat customer" every visit.
--
--   2. A number is unique WITHIN a shop, never across the platform. Staff
--      phones are globally unique — one person, one employer, one till. Buyers
--      are the opposite: the same contractor may buy at two shops running
--      InnovaPOS, and those must be two separate records. Under POPIA each shop
--      is its own responsible party, and one shop must never be able to see
--      another's customer list.
--
--   3. A cashier may record a buyer but never grant one credit. Quick capture
--      at the till always produces a contact with no credit limit and retail
--      pricing; turning that into a trade account stays a back-office decision.

-- --------------------------------------------------------------- normalising ---

-- Which country a bare local number belongs to. South Africa unless a shop says
-- otherwise — the Lesotho border is twenty minutes from Ladybrand, so this will
-- eventually matter.
alter table public.organizations
  add column if not exists dial_code text not null default '+27';

/**
 * A phone number as typed, reduced to one canonical E.164 form.
 *
 * Returns null for anything that cannot be read as a phone number, so callers
 * can treat null as "not a phone" rather than storing rubbish.
 */
create or replace function public.normalize_phone(
  p_phone text, p_dial_code text default '+27'
) returns text language plpgsql immutable as $$
declare
  v_in     text := trim(coalesce(p_phone, ''));
  v_cc     text := coalesce(nullif(trim(p_dial_code), ''), '+27');
  v_digits text;
  v_out    text;
begin
  if v_in = '' then return null; end if;
  v_digits := regexp_replace(v_in, '\D', '', 'g');
  if v_digits = '' then return null; end if;

  if left(v_in, 1) = '+' then
    -- Typed in full. Believe it, whatever country it belongs to.
    v_out := '+' || v_digits;
  elsif left(v_digits, 2) = '00' then
    -- The other way of writing '+'.
    v_out := '+' || substring(v_digits from 3);
  elsif left(v_digits, 1) = '0' then
    -- National trunk code: 082… is this country's 82…
    v_out := v_cc || substring(v_digits from 2);
  elsif left(v_digits, length(v_cc) - 1) = substring(v_cc from 2)
        and length(v_digits) > 9 then
    -- Carries the country code already, just without the plus.
    v_out := '+' || v_digits;
  else
    -- A bare subscriber number.
    v_out := v_cc || v_digits;
  end if;

  -- E.164 allows 15 digits. The floor of 9 is what keeps a mistyped '12345'
  -- from becoming a customer record: no country's number is that short once the
  -- dialling code is on the front, and a till is exactly where such a slip
  -- happens.
  if v_out !~ '^\+\d{9,15}$' then return null; end if;
  return v_out;
end;
$$;

-- ----------------------------------------------------------------- customers ---

alter table public.customers add column if not exists phone_e164 text;

-- Normalising in a trigger rather than at the call site means every route in —
-- the till, the back office, a CSV import written later — lands in the same
-- shape. There is no way to write a customer that skips it.
create or replace function public.customers_set_phone_e164()
returns trigger language plpgsql set search_path = public, extensions as $$
begin
  new.phone_e164 := public.normalize_phone(
    new.phone,
    (select o.dial_code from public.organizations o where o.id = new.org_id));
  return new;
end;
$$;

drop trigger if exists customers_phone_e164 on public.customers;
create trigger customers_phone_e164
  before insert or update of phone, org_id on public.customers
  for each row execute function public.customers_set_phone_e164();

-- Backfill the numbers already on file.
update public.customers set phone = phone where phone is not null;

-- Per shop, deliberately. See rule 2 at the top.
create unique index if not exists customers_org_phone_key
  on public.customers (org_id, phone_e164)
  where phone_e164 is not null;

create index if not exists customers_phone_lookup_idx
  on public.customers (org_id, phone_e164) where active;

-- --------------------------------------------------------------------- sales ---

-- Snapshotted onto the sale like the address and VAT number: what the invoice
-- said at the time, even if the customer record is edited afterwards.
alter table public.sales add column if not exists customer_phone text;

-- A trigger rather than another parameter on pos_create_sale, for two reasons:
-- that function is long enough already, and a till that queued a sale offline
-- before this release replays with the old argument list. This way those sales
-- still get the number.
create or replace function public.sales_snapshot_customer_phone()
returns trigger language plpgsql set search_path = public, extensions as $$
begin
  if new.customer_phone is null and new.customer_id is not null then
    select c.phone_e164 into new.customer_phone
      from public.customers c where c.id = new.customer_id;
  end if;
  return new;
end;
$$;

drop trigger if exists sales_customer_phone on public.sales;
create trigger sales_customer_phone
  before insert on public.sales
  for each row execute function public.sales_snapshot_customer_phone();

-- ---------------------------------------------------------------------- RPCs ---

/**
 * Find the buyer behind a phone number.
 *
 * Returns nothing rather than raising when the number is unreadable or unknown:
 * at a till, "no match" is an ordinary answer, not an error.
 */
create or replace function public.pos_customer_by_phone(
  p_register_token text, p_phone text
) returns table(id uuid, code text, name text, phone text, is_trade boolean,
                credit_limit numeric, balance numeric, available numeric,
                vat_number text, address text)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_phone text;
begin
  v_reg := public.register_by_token(p_register_token);
  v_phone := public.normalize_phone(
    p_phone, (select o.dial_code from public.organizations o where o.id = v_reg.org_id));
  if v_phone is null then return; end if;

  return query
    select c.id, c.code, c.name, c.phone, c.is_trade, c.credit_limit,
           public.customer_balance(c.id), public.customer_available_credit(c.id),
           c.vat_number, c.address
    from public.customers c
    where c.org_id = v_reg.org_id and c.active and c.phone_e164 = v_phone;
end;
$$;

grant execute on function public.pos_customer_by_phone(text, text)
  to anon, authenticated;

/**
 * Record a buyer at the counter, or return the one already on file.
 *
 * Authorised by the cashier's own permission to take payments — anyone who can
 * ring up a sale can note who bought it. That is deliberate: a flow that needed
 * a manager's PIN would simply never be used during a queue.
 *
 * What it will not do is create an account. No credit limit, no trade pricing.
 * A cashier can record a customer; only the back office can extend them money.
 */
create or replace function public.pos_quick_customer(
  p_register_token text, p_cashier_id uuid, p_phone text,
  p_name text default null, p_vat_number text default null,
  p_address text default null
) returns table(id uuid, code text, name text, phone text, is_trade boolean,
                credit_limit numeric, balance numeric, available numeric,
                vat_number text, address text)
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users;
  v_phone text; v_id uuid; v_name text;
begin
  v_reg := public.register_by_token(p_register_token);

  select * into v_user from public.app_users
   where app_users.id = p_cashier_id and org_id = v_reg.org_id
     and active and status = 'active';
  if not found then raise exception 'Unknown cashier'; end if;
  if not ('take_payments' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted to take payments';
  end if;

  v_phone := public.normalize_phone(
    p_phone, (select o.dial_code from public.organizations o where o.id = v_reg.org_id));
  if v_phone is null then
    raise exception 'That does not look like a phone number';
  end if;

  v_name := nullif(trim(coalesce(p_name, '')), '');

  select c.id into v_id from public.customers c
   where c.org_id = v_reg.org_id and c.phone_e164 = v_phone;

  if v_id is null then
    insert into public.customers(org_id, name, phone, vat_number, address,
                                 is_trade, credit_limit, opening_balance, active)
    values (v_reg.org_id, coalesce(v_name, v_phone), trim(p_phone),
            nullif(trim(coalesce(p_vat_number, '')), ''),
            nullif(trim(coalesce(p_address, '')), ''),
            false, 0, 0, true)
    returning customers.id into v_id;
  else
    -- Fill blanks; never overwrite what the back office curated. A name that is
    -- still just the phone number is a placeholder, so that one may be replaced.
    update public.customers c set
      name    = case when v_name is not null and (c.name is null or c.name = c.phone_e164)
                     then v_name else c.name end,
      vat_number = coalesce(c.vat_number, nullif(trim(coalesce(p_vat_number, '')), '')),
      address    = coalesce(c.address,    nullif(trim(coalesce(p_address, '')), '')),
      -- They are standing at the counter, so they are evidently still a customer.
      active  = true
     where c.id = v_id;
  end if;

  return query
    select c.id, c.code, c.name, c.phone, c.is_trade, c.credit_limit,
           public.customer_balance(c.id), public.customer_available_credit(c.id),
           c.vat_number, c.address
    from public.customers c where c.id = v_id;
end;
$$;

grant execute on function public.pos_quick_customer(text, uuid, text, text, text, text)
  to anon, authenticated;

/**
 * What this buyer has bought — the answer to "I got it here in March".
 *
 * Completed sales only: a parked or voided sale is not a purchase, and offering
 * one as proof at a returns counter would be worse than offering nothing.
 */
create or replace function public.pos_customer_history(
  p_register_token text, p_customer_id uuid, p_limit int default 20
) returns table(sale_id uuid, doc_number text, created_at timestamptz,
                total numeric, payment_method text, item_count int, summary text)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select s.id, s.doc_number, s.created_at, s.total, s.payment_method::text,
           (select count(*)::int from public.sale_items i where i.sale_id = s.id),
           (select left(string_agg(i.name, ', ' order by i.name), 160)
              from public.sale_items i where i.sale_id = s.id)
    from public.sales s
    where s.org_id = v_reg.org_id
      and s.customer_id = p_customer_id
      and s.status = 'completed'
    order by s.created_at desc
    limit greatest(1, least(coalesce(p_limit, 20), 100));
end;
$$;

grant execute on function public.pos_customer_history(text, uuid, int)
  to anon, authenticated;
