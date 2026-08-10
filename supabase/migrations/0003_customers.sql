-- Hardware POS — customers, credit accounts and the receivables ledger.
--
-- Carried over from the cafe build largely intact, because it was already the
-- right shape: a balance derived from movements rather than a mutable number.
-- Two hardware-specific additions: an is_trade flag that drives pricing, and a
-- VAT number, because a contractor claiming input VAT needs it on the invoice.

create table public.customers (
  id              uuid primary key default gen_random_uuid(),
  code            text unique,
  name            text not null,
  phone           text,
  email           text,
  address         text,
  -- Printed on the tax invoice so the customer can claim the input VAT.
  vat_number      text,
  -- Drives price_for(): trade customers get price_trade where one is set.
  is_trade        boolean not null default false,
  -- null = no limit. Enforced server-side when charging to the account.
  credit_limit    numeric(12,2) check (credit_limit >= 0),
  opening_balance numeric(12,2) not null default 0,
  active          boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now()
);

create index customers_name_idx on public.customers (lower(name));
create index customers_trade_idx on public.customers (is_trade) where active;

-- Payments received against an account. Charges live in `sales`; this table is
-- only the money coming back, so the two can never double-count.
create table public.customer_payments (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  method      text not null default 'cash',
  reference   text,
  note        text,
  taken_by    uuid references public.app_users(id),
  taken_by_name text,
  -- Set when the payment is banked as part of a till session, so cash-up can
  -- account for account settlements taken over the counter.
  session_id  uuid,
  created_at  timestamptz not null default now()
);

create index customer_payments_customer_idx
  on public.customer_payments (customer_id, created_at desc);

alter table public.customers         enable row level security;
alter table public.customer_payments enable row level security;
