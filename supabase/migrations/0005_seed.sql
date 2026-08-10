-- Hardware POS — starter data: staff, departments and a representative range.
--
-- The products are chosen to cover the cases the cafe build could not express:
-- goods sold by the metre and by weight, trade pricing, and untracked stock.
-- Replace them with the shop's real price list before go-live.

insert into public.app_users (name, role, pin_hash) values
  ('Manager', 'admin',    crypt('1234', gen_salt('bf'))),
  ('Sam',     'employee', crypt('5678', gen_salt('bf')));

insert into public.categories (name, sort_order) values
  ('Building',   10),
  ('Fasteners',  20),
  ('Plumbing',   30),
  ('Electrical', 40),
  ('Paint',      50),
  ('Tools',      60),
  ('Garden',     70);

insert into public.products
  (sku, barcode, name, category_id, unit_code, price_retail, price_trade,
   cost, stock_qty, reorder_level)
select v.sku, v.barcode, v.name,
       (select id from public.categories where name = v.cat),
       v.unit, v.retail, v.trade, v.cost, v.stock, v.reorder
from (values
  -- Sold whole, by the bag: fractions are rejected at the till.
  ('CEM-425-50', '6001234000015', 'Cement 42.5N 50kg',      'Building',  'bag', 115.00,  108.00,  92.5000,  240,  40),
  ('BRK-NFP',    null,            'Brick Plaster NFP',      'Building',  'ea',    3.20,    2.85,   2.4000, 8400, 2000),
  -- Sold by the cubic metre: fractional quantities are the normal case.
  ('SND-RIV',    null,            'River Sand',             'Building',  'm3',  420.00,  385.00, 310.0000,   18,   4),
  ('STN-19',     null,            'Stone 19mm',             'Building',  'm3',  455.00,  420.00, 340.0000,   12,   4),
  -- Cut to length off a roll.
  ('CHN-06',     null,            'Chain 6mm Galvanised',   'Building',  'm',    35.00,   31.50,  24.0000,  120,  30),
  ('WIR-FEN',    null,            'Fencing Wire 2.5mm',     'Garden',    'm',     8.50,    7.60,   5.9000,  600, 150),
  -- Loose, by weight.
  ('NAL-100',    null,            'Wire Nails 100mm loose', 'Fasteners', 'kg',   42.00,   38.00,  29.5000,   85,  20),
  -- Packaged, scanned at the till.
  ('SCR-440',    '6001234000022', 'Wood Screw 4x40 (100)',  'Fasteners', 'box',  68.00,   61.00,  47.0000,   64,  15),
  ('PPE-20',     '6001234000039', 'Poly Pipe 20mm x 25m',   'Plumbing',  'roll', 289.00,  262.00, 210.0000,   22,   5),
  ('PNT-WHT-20', '6001234000046', 'PVA White 20L',          'Paint',     'ea',  749.00,  689.00, 570.0000,   16,   4),
  ('CBL-25-100', '6001234000053', 'Twin & Earth 2.5mm 100m','Electrical','roll',1450.00, 1330.00,1120.0000,    9,   3),
  ('PDL-50',     '6001234000060', 'Padlock 50mm Brass',     'Tools',     'ea',   89.00,   80.00,  62.0000,   45,  10),
  -- Untracked: consumables nobody wants to count.
  ('SAW-BLD',    null,            'Hacksaw Blade',          'Tools',     'ea',   26.00,   23.00,  17.5000, null, null)
) as v(sku, barcode, name, cat, unit, retail, trade, cost, stock, reorder);

-- Record the opening stock so the movement log explains every unit on hand from
-- the first day rather than starting from an unexplained balance.
insert into public.stock_movements (product_id, qty_delta, qty_after, reason, note)
select id, stock_qty, stock_qty, 'opening', 'Opening stock'
from public.products where stock_qty is not null;

insert into public.customers (code, name, phone, is_trade, credit_limit, vat_number) values
  ('TRD-001', 'Mokoena Building Contractors', '051 924 0000', true,  25000.00, '4001234567'),
  ('TRD-002', 'Free State Plumbing CC',       '051 924 0001', true,  10000.00, '4007654321'),
  ('CSH-001', 'Cash Customer',                null,           false,     null, null);

insert into public.suppliers (code, name, contact_name, terms_days) values
  ('PPC',   'PPC Cement',          'Sales Desk', 30),
  ('CASH',  'Cashbuild Wholesale', null,          0);
