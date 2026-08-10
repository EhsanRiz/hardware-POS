-- Demo staff. PINs: Manager = 1234, Employee (Sam) = 5678. Change before go-live.
insert into public.app_users(name, role, pin_hash) values
  ('Manager', 'manager',  crypt('1234', gen_salt('bf'))),
  ('Sam',     'employee', crypt('5678', gen_salt('bf')));

-- Starter menu
insert into public.products(name, category, price, sort_order) values
  ('Espresso',        'Coffee', 18.00, 1),
  ('Americano',       'Coffee', 20.00, 2),
  ('Cappuccino',      'Coffee', 25.00, 3),
  ('Latte',           'Coffee', 26.00, 4),
  ('Flat White',      'Coffee', 26.00, 5),
  ('Mocha',           'Coffee', 28.00, 6),
  ('Hot Chocolate',   'Coffee', 24.00, 7),
  ('Iced Coffee',     'Cold',   28.00, 1),
  ('Iced Latte',      'Cold',   30.00, 2),
  ('Milkshake',       'Cold',   35.00, 3),
  ('Chocolate Cake',  'Cakes',  35.00, 1),
  ('Carrot Cake',     'Cakes',  35.00, 2),
  ('Cheesecake',      'Cakes',  38.00, 3),
  ('Muffin',          'Cakes',  20.00, 4),
  ('Croissant',       'Pastry', 22.00, 1),
  ('Scone',           'Pastry', 18.00, 2),
  ('Sandwich',        'Food',   45.00, 1),
  ('Toastie',         'Food',   40.00, 2);
