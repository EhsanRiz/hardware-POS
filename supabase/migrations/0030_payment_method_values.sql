-- payment_method never learned the tenders the till actually offers.
--
-- 0004 declared the enum as ('cash','card','account','split') and nothing has
-- touched it since. The till has offered EFT and Zapper for some time, and 0019
-- casts straight into this type in two places — once per payment row, and once
-- for the summary method, which it sets to 'mixed' whenever a sale is settled
-- by more than one tender. So an EFT sale, a Zapper sale and any split tender
-- all fail in the database with:
--
--   invalid input value for enum payment_method: "eft"
--
-- Found while building the cash-up, which groups the day's takings by this
-- column: a tender breakdown cannot report methods the type will not store.
--
-- 'split' stays, unused, because dropping a value from an enum means rewriting
-- the type and every column that references it, and an unused label costs
-- nothing. 'mixed' is what 0019 actually generates.
alter type payment_method add value if not exists 'eft';
alter type payment_method add value if not exists 'zapper';
alter type payment_method add value if not exists 'mixed';
