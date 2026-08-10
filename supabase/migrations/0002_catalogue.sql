-- Hardware POS — catalogue: units, tax rates, categories, products, suppliers.
--
-- The biggest departure from the cafe build is here. A cafe sells whole items
-- from a list of forty; a hardware shop sells 2.5 m of chain out of a range of
-- several thousand, and finds it by scanning a barcode rather than tapping a
-- photo. So: units of measure, fractional quantities, SKUs and barcodes are
-- part of the product model rather than bolted on later.

-- Units of measure -----------------------------------------------------------

-- allows_fraction is the important column. Chain and timber sell by the metre
-- and 2.5 is legitimate; taps and padlocks sell each and 2.5 is a mistake. The
-- sale RPC enforces this, so a bad quantity is rejected rather than rounded.
create table public.units_of_measure (
  code           text primary key,
  name           text not null,
  allows_fraction boolean not null default false,
  sort_order     int not null default 0
);

insert into public.units_of_measure (code, name, allows_fraction, sort_order) values
  ('ea',    'Each',          false, 10),
  ('m',     'Metre',         true,  20),
  ('m2',    'Square metre',  true,  30),
  ('m3',    'Cubic metre',   true,  40),
  ('kg',    'Kilogram',      true,  50),
  ('t',     'Tonne',         true,  60),
  ('L',     'Litre',         true,  70),
  ('bag',   'Bag',           false, 80),
  ('box',   'Box',           false, 90),
  ('pack',  'Pack',          false, 100),
  ('roll',  'Roll',          false, 110),
  ('sheet', 'Sheet',         false, 120),
  ('length','Length',        false, 130),
  ('pair',  'Pair',          false, 140),
  ('set',   'Set',           false, 150);

-- Tax ------------------------------------------------------------------------

-- Rates are versioned by effective_from rather than edited in place, so a sale
-- from before a rate change can still be explained. The cafe build read a
-- single rate from an env var at print time, which meant reprinting an old
-- invoice silently restated its VAT at today's rate.
create table public.tax_rates (
  code           text not null,
  rate           numeric(6,4) not null check (rate >= 0 and rate < 1),
  description    text not null,
  effective_from date not null default '2000-01-01',
  primary key (code, effective_from)
);

insert into public.tax_rates (code, rate, description) values
  ('standard', 0.1500, 'Standard rated (15%)'),
  ('zero',     0.0000, 'Zero rated'),
  ('exempt',   0.0000, 'Exempt');

-- The rate for a tax code on a given date. Sale lines resolve this once, at the
-- moment of sale, and store the result.
create function public.tax_rate_at(p_code text, p_on date default current_date)
returns numeric language sql stable as $$
  select t.rate from public.tax_rates t
  where t.code = p_code and t.effective_from <= p_on
  order by t.effective_from desc
  limit 1;
$$;

-- Categories -----------------------------------------------------------------

-- A real table rather than the cafe's free-text column: a hardware shop has
-- departments that outlive any one product, and reporting by department is a
-- question the owner will ask on day one.
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort_order int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Suppliers ------------------------------------------------------------------

create table public.suppliers (
  id           uuid primary key default gen_random_uuid(),
  code         text unique,
  name         text not null,
  contact_name text,
  phone        text,
  email        text,
  address      text,
  vat_number   text,
  terms_days   int not null default 30,
  active       boolean not null default true,
  notes        text,
  created_at   timestamptz not null default now()
);

-- Products -------------------------------------------------------------------

create table public.products (
  id            uuid primary key default gen_random_uuid(),
  sku           text not null unique,
  -- Scanned at the till. Nullable: loose stock and cut-to-length goods have no
  -- barcode. Unique when present so a scan can never be ambiguous.
  barcode       text unique,
  name          text not null,
  description   text,
  category_id   uuid references public.categories(id) on delete set null,
  unit_code     text not null default 'ea' references public.units_of_measure(code),

  -- Both prices are VAT-inclusive, which is how they appear on the shelf.
  -- The VAT portion is derived and stored per line at the time of sale.
  price_retail  numeric(12,2) not null check (price_retail >= 0),
  -- Contractor price. Null means trade customers pay retail for this line.
  price_trade   numeric(12,2) check (price_trade >= 0),
  -- Four decimals: a single screw can cost a fraction of a cent.
  cost          numeric(12,4) check (cost >= 0),
  tax_code      text not null default 'standard',

  -- numeric, not int: stock of cut goods is fractional too.
  stock_qty     numeric(14,3),          -- null = not tracked
  reorder_level numeric(14,3),          -- null = no reorder alert
  preferred_supplier_id uuid references public.suppliers(id) on delete set null,

  image_url     text,
  active        boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Search: a hardware till is driven by typing a few characters of a name or a
-- SKU, so these three lookups need to stay fast as the range grows.
create index products_barcode_idx  on public.products (barcode) where barcode is not null;
create index products_sku_idx      on public.products (lower(sku));
create index products_name_idx     on public.products using gin (to_tsvector('simple', name));
create index products_category_idx on public.products (category_id) where active;

create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- The price a given customer pays. One place, so the till, quotes and reports
-- can never disagree about what "trade price" means.
create function public.price_for(p_product public.products, p_trade boolean)
returns numeric language sql immutable as $$
  select case
    when p_trade and p_product.price_trade is not null then p_product.price_trade
    else p_product.price_retail
  end;
$$;

-- RLS ------------------------------------------------------------------------

alter table public.units_of_measure enable row level security;
alter table public.tax_rates        enable row level security;
alter table public.categories       enable row level security;
alter table public.products         enable row level security;
alter table public.suppliers        enable row level security;

-- The till needs the catalogue offline, so active products and their lookups
-- are readable with the anon key. Cost prices are the one thing worth hiding.
--
-- NOTE: the SECURITY DEFINER view below is replaced in 0006 by an RLS policy
-- plus column-level grants. Left here so the migration history reads truthfully;
-- 0006 is the current state.
create policy categories_read on public.categories
  for select to anon, authenticated using (active);
create policy units_read on public.units_of_measure
  for select to anon, authenticated using (true);
create policy tax_rates_read on public.tax_rates
  for select to anon, authenticated using (true);

-- Suppliers and the products table itself stay closed; the till reads the view.
create view public.catalogue with (security_invoker = off) as
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
