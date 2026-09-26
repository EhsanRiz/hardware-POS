-- 0125 — every shop sorts its deliveries, and every new shop starts that way.
--
-- 0117 put delivery sorting behind organizations.sort_deliveries, off by
-- default, so it could be tried on IE Test Shop before any real shop saw it.
-- It has been: two suppliers' invoices scanned on a phone, matched, costed
-- after discount and without VAT, their repeated name tails dropped, their
-- sizes read the same however printed, booked in on the till, a duplicate
-- delivery refused. The owner's decision is that this is how the app works,
-- for every shop that registers.
--
-- So the default is now on, and every shop already registered is switched
-- on. The column stays: it is still the one place a shop could be switched
-- back if ever it had to be.

alter table public.organizations alter column sort_deliveries set default true;
update public.organizations set sort_deliveries = true where not sort_deliveries;
