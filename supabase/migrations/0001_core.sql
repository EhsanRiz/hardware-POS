-- Hardware POS — core: staff, roles, permissions, shop settings, document numbers.
--
-- Design note carried over from the cafe build and kept deliberately: the PWA
-- ships a public anon key, so no table is directly writable. Everything that
-- matters goes through SECURITY DEFINER functions that verify a PIN server-side,
-- and RLS is enabled with no policies on anything sensitive.

create extension if not exists pgcrypto with schema extensions;

-- Staff ----------------------------------------------------------------------

create type user_role as enum ('admin', 'manager', 'employee');

create table public.app_users (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  role        user_role not null default 'employee',
  pin_hash    text not null,
  phone       text,
  email       text,
  -- Explicit grants layered on top of the role defaults below.
  permissions text[] not null default '{}',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Every permission the system understands. Referenced by name in the RPCs, so
-- a typo fails loudly at grant time rather than silently allowing an action.
create table public.permissions (
  code        text primary key,
  description text not null
);

insert into public.permissions (code, description) values
  ('take_payments',     'Ring up and take payment for a sale'),
  ('apply_discount',    'Apply a discount (manager approval may be required)'),
  ('approve_discount',  'Approve a discount applied by someone else'),
  ('void_refund',       'Void or refund a completed sale'),
  ('manage_catalogue',  'Add and edit products, prices and categories'),
  ('manage_inventory',  'Adjust stock, receive goods, run stocktakes'),
  ('manage_purchasing', 'Manage suppliers and purchase orders'),
  ('manage_customers',  'Manage customer accounts and credit limits'),
  ('manage_quotes',     'Create and convert quotes'),
  ('view_reports',      'View sales, margin and stock reports'),
  ('view_cost_prices',  'See cost prices and margins'),
  ('cash_management',   'Open and close the drawer, record pay-ins and pay-outs'),
  ('manage_staff',      'Create staff and set roles, PINs and permissions'),
  ('manage_settings',   'Change shop settings');

-- Role defaults. A user's effective permission set is this plus their own
-- explicit grants, so promoting someone widens access without re-ticking boxes.
create function public.role_default_permissions(p_role user_role)
returns text[] language sql immutable as $$
  select case p_role
    when 'admin' then array(select code from public.permissions)
    when 'manager' then array[
      'take_payments','apply_discount','approve_discount','void_refund',
      'manage_catalogue','manage_inventory','manage_purchasing',
      'manage_customers','manage_quotes','view_reports','view_cost_prices',
      'cash_management'
    ]
    else array['take_payments','apply_discount']
  end;
$$;

create function public.effective_permissions(p_user public.app_users)
returns text[] language sql stable as $$
  select array(
    select distinct unnest(
      public.role_default_permissions(p_user.role) || p_user.permissions
    )
  );
$$;

-- Shop settings --------------------------------------------------------------

-- Kept in the database rather than build-time env vars so the shop can change
-- its address or VAT number without a redeploy. Readable by the anon key: all
-- of it is printed on receipts anyway.
create table public.settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

insert into public.settings (key, value) values
  ('shop_name',    'Hardware Shop'),
  ('address_line1',''),
  ('address_line2',''),
  ('phone',        ''),
  ('vat_number',   ''),
  ('currency',     'R'),
  ('registration_number', '');

-- Document numbering ---------------------------------------------------------

-- Sequential, gapless-per-type document numbers. SARS expects tax invoices to
-- carry a sequential number, which a truncated UUID is not.
--
-- Offline note: a sale created on the tablet while offline gets its number here
-- at sync time, not on the device. Two tills (or one tablet replaying a queue)
-- therefore cannot mint the same number, and the sequence stays dense.
create table public.doc_sequences (
  doc_type    text primary key,
  prefix      text not null,
  next_number bigint not null default 1,
  pad_width   int not null default 6
);

insert into public.doc_sequences (doc_type, prefix) values
  ('sale',    'INV-'),
  ('quote',   'QUO-'),
  ('grv',     'GRV-'),
  ('credit',  'CRN-');

create function public.next_doc_number(p_doc_type text)
returns text language plpgsql as $$
declare v_seq public.doc_sequences;
begin
  -- FOR UPDATE serialises concurrent callers so two sales can't take one number.
  select * into v_seq from public.doc_sequences
    where doc_type = p_doc_type for update;
  if not found then raise exception 'Unknown document type: %', p_doc_type; end if;

  update public.doc_sequences set next_number = next_number + 1
    where doc_type = p_doc_type;

  return v_seq.prefix || lpad(v_seq.next_number::text, v_seq.pad_width, '0');
end;
$$;

-- Auth helpers ---------------------------------------------------------------

-- Resolve a PIN to a user, or null. Used by every PIN-gated RPC.
create function public.user_by_pin(p_pin text)
returns public.app_users language sql stable security definer
set search_path = public, extensions as $$
  select u.* from public.app_users u
  where u.active and u.pin_hash = crypt(p_pin, u.pin_hash)
  limit 1;
$$;

-- Resolve a PIN and assert a permission in one step. Raises if either fails,
-- so callers can treat a returned row as fully authorised.
create function public.user_with_perm(p_pin text, p_perm text)
returns public.app_users language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_by_pin(p_pin);
  if v_user.id is null then raise exception 'Invalid PIN'; end if;
  if not (p_perm = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted: %', p_perm;
  end if;
  return v_user;
end;
$$;

-- Login. Returns the user plus their effective permissions for UI gating.
-- The UI hides what you can't do; the RPCs are what actually enforce it.
create function public.pos_login(p_pin text)
returns table(id uuid, name text, role user_role, phone text, email text,
              permissions text[])
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_by_pin(p_pin);
  if v_user.id is null then return; end if;
  return query select v_user.id, v_user.name, v_user.role, v_user.phone,
                      v_user.email, public.effective_permissions(v_user);
end;
$$;

-- RLS ------------------------------------------------------------------------

alter table public.app_users     enable row level security;
alter table public.permissions   enable row level security;
alter table public.settings      enable row level security;
alter table public.doc_sequences enable row level security;

-- Settings and the permission catalogue are safe to read on the device.
-- app_users (PIN hashes) and doc_sequences are reachable only via functions.
create policy settings_read on public.settings
  for select to anon, authenticated using (true);
create policy permissions_read on public.permissions
  for select to anon, authenticated using (true);
