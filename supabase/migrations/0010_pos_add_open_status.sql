-- Open-order status (must be committed before use, so it's its own migration).
alter type sale_status add value if not exists 'open';
