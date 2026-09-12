-- TillAI's log learns whether the question was asked with a PIN.
--
-- A manager asked TillAI for three days' takings and was sent to Manage,
-- because the server could only see a register token and a token says which
-- shop, not who. The till now asks the person for their PIN once, and the
-- edge function carries it to the same PIN-checked report RPCs Manage calls
-- (pos_day_close, pos_stock_value, pos_debtors_ageing, ...), which enforce
-- the rights themselves. This column records only that a PIN was given, so
-- the log can say which questions saw the reports. The PIN itself is never
-- stored.

alter table public.tillai_questions
  add column unlocked boolean not null default false;
