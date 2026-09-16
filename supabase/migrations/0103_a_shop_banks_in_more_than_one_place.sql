-- Where to pay, when there is more than one answer.
--
-- The four banking fields have been columns on the organisation since 0038,
-- which lets a shop record exactly one account. Shops keep more than one, and
-- here that is not a filing preference: an EFT within a bank clears the same
-- day and between banks it does not, so a customer who can see their own bank
-- on the invoice pays the shop sooner. A shop that lists only one is asking
-- half its customers to wait two days and then chase them for it.
--
-- So accounts become rows. Each carries a switch for whether it appears on
-- documents, which is the other half of the same problem: a second account
-- often exists for the shop's own reasons and has no business on a customer's
-- invoice. Everything switched on prints; a shop wanting customers to choose
-- turns both on, a shop with a private second account leaves it off.
--
-- The four columns go. Two places to write the same fact is how one of them
-- ends up stale, and the one that prints would not be the one anybody edited.

create table if not exists public.bank_accounts (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  bank_name      text not null default '',
  account_name   text not null default '',
  account_number text not null default '',
  branch_code    text not null default '',
  -- Whether a customer sees it. Default true: an account somebody troubled to
  -- type into the shop's settings is there to be paid into unless they say
  -- otherwise.
  on_documents   boolean not null default true,
  -- The order they were entered in, which is the order they print in. A shop
  -- puts its main account first and means it.
  position       int not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists bank_accounts_org_idx
  on public.bank_accounts (org_id, position);

alter table public.bank_accounts enable row level security;
-- No policy: reached only through the security-definer functions below.

-- What every shop already has, as its first row. Only where something was
-- actually filled in — a shop that never set banking details does not gain an
-- empty account that prints an empty heading.
insert into public.bank_accounts
  (org_id, bank_name, account_name, account_number, branch_code, position)
select o.id,
       coalesce(o.bank_name, ''), coalesce(o.bank_account_name, ''),
       coalesce(o.bank_account_number, ''), coalesce(o.bank_branch_code, ''), 0
  from public.organizations o
 where coalesce(o.bank_name, '') <> ''
    or coalesce(o.bank_account_name, '') <> ''
    or coalesce(o.bank_account_number, '') <> ''
    or coalesce(o.bank_branch_code, '') <> '';

alter table public.organizations
  drop column if exists bank_name,
  drop column if exists bank_account_name,
  drop column if exists bank_account_number,
  drop column if exists bank_branch_code;

/**
 * The shop's details, with its accounts as a list.
 *
 * Changing what a function returns needs the old one dropped first, same as
 * adding an argument (CLAUDE.md), and this one loses four columns and gains
 * one. Only the accounts meant for documents come back: the till has no
 * reason to hold an account the shop keeps to itself, and what a device never
 * receives cannot be printed by accident.
 */
drop function if exists public.pos_org_settings(text);

create function public.pos_org_settings(p_register_token text)
returns table(shop_name text, address_line1 text, address_line2 text,
              phone text, vat_number text, currency text,
              registration_number text, email text,
              bank_accounts jsonb,
              vat_rate numeric, quote_show_line_prices boolean,
              receipt_terms text, quote_terms text, logo_url text,
              delivery_cost numeric)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query select o.name, o.address_line1, o.address_line2, o.phone,
                      o.vat_number, o.currency, o.registration_number,
                      o.email,
                      coalesce((
                        select jsonb_agg(jsonb_build_object(
                                 'bank_name', b.bank_name,
                                 'account_name', b.account_name,
                                 'account_number', b.account_number,
                                 'branch_code', b.branch_code)
                               order by b.position, b.created_at)
                          from public.bank_accounts b
                         where b.org_id = o.id and b.on_documents), '[]'::jsonb),
                      coalesce(public.tax_rate_at('standard', current_date), 0),
                      o.quote_show_line_prices,
                      o.receipt_terms, o.quote_terms, o.logo_url,
                      (select p.cost from public.products p
                        where p.org_id = o.id and p.kind = 'delivery'
                        order by p.created_at limit 1)
    from public.organizations o where o.id = v_reg.org_id;
end;
$$;
grant execute on function public.pos_org_settings(text) to anon, authenticated;

-- Same payload, minus four keys it can no longer write. Same signature, so
-- replaced in place rather than dropped.
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

/**
 * The shop's accounts, as the settings screen sees them — every one of them,
 * including the ones kept off documents, which is the only place they are
 * visible at all.
 */
create function public.pos_admin_bank_accounts(p_register_token text, p_pin text)
returns table(id uuid, bank_name text, account_name text,
              account_number text, branch_code text, on_documents boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_settings');
  return query
    select b.id, b.bank_name, b.account_name, b.account_number,
           b.branch_code, b.on_documents
      from public.bank_accounts b
     where b.org_id = v_user.org_id
     order by b.position, b.created_at;
end;
$$;
grant execute on function public.pos_admin_bank_accounts(text, text)
  to anon, authenticated;

/**
 * Write the whole list at once.
 *
 * The screen edits rows and then saves, so the list it holds IS the answer —
 * sending it whole means a row deleted on screen is a row deleted here, with
 * no separate call to forget and no way for the two to disagree halfway
 * through. Rows arrive in the order they should print.
 *
 * An account with nothing in it is dropped rather than stored: an empty row
 * left behind by somebody who pressed Add and changed their mind would
 * otherwise print a heading with nothing under it.
 */
create function public.pos_admin_save_bank_accounts(
  p_register_token text, p_pin text, p_accounts jsonb
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_settings');
  delete from public.bank_accounts where org_id = v_user.org_id;
  insert into public.bank_accounts
    (org_id, bank_name, account_name, account_number, branch_code,
     on_documents, position)
  select v_user.org_id,
         coalesce(a->>'bank_name', ''), coalesce(a->>'account_name', ''),
         coalesce(a->>'account_number', ''), coalesce(a->>'branch_code', ''),
         coalesce((a->>'on_documents')::boolean, true),
         (n - 1)::int
    from jsonb_array_elements(coalesce(p_accounts, '[]'::jsonb))
           with ordinality as t(a, n)
   where coalesce(a->>'bank_name', '') <> ''
      or coalesce(a->>'account_name', '') <> ''
      or coalesce(a->>'account_number', '') <> ''
      or coalesce(a->>'branch_code', '') <> '';
end;
$$;
grant execute on function public.pos_admin_save_bank_accounts(text, text, jsonb)
  to anon, authenticated;
