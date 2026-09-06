-- 0073 — a line on an account opens the sale behind it.
--
-- "What did we actually buy on that invoice?" is the first question anybody
-- asks when a customer queries a statement, and the answer was three screens
-- away: leave Accounts, go to Manage, open Sales, find the invoice number.
--
-- The ledger already knows which sale each charge is. It just did not carry
-- enough of it to open one, so this adds the few fields the sale view needs.
-- Payments and the opening balance have no sale behind them and carry nulls,
-- which is what makes them un-openable on the screen rather than opening
-- something empty.

-- Return columns change, so the old signature goes first (CLAUDE.md).
drop function if exists public.pos_customer_ledger(text, uuid, int);

create function public.pos_customer_ledger(
  p_register_token text, p_customer_id uuid, p_limit int default 100
) returns table(kind text, entry_at timestamptz, ref text, detail text,
                charge numeric, payment numeric, balance numeric,
                entry_id uuid, voided boolean,
                cashier_name text, tax_amount numeric, status text,
                payment_method text)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_open numeric;
begin
  v_reg := public.register_by_token(p_register_token);

  select c.opening_balance into v_open from public.customers c
   where c.id = p_customer_id and c.org_id = v_reg.org_id;
  if not found then raise exception 'Unknown customer'; end if;

  return query
  with entries as (
    -- `seq` only breaks ties at an identical timestamp, so the running
    -- balance is deterministic: opening first, then charges, then payments.
    select 'opening'::text as kind, 0 as seq, c.created_at as entry_at,
           ''::text as ref, 'Opening balance'::text as detail,
           c.opening_balance as charge,
           0::numeric as payment, c.id as entry_id, false as voided,
           null::text as cashier_name, null::numeric as tax_amount,
           null::text as status, null::text as payment_method
      from public.customers c
     where c.id = p_customer_id and c.opening_balance <> 0
    union all
    select 'charge', 1, s.created_at, coalesce(s.doc_number, ''),
           coalesce(nullif(s.po_number, ''), 'Invoice'), s.total, 0, s.id, false,
           u.name, s.tax_amount, s.status::text, s.payment_method::text
      from public.sales s
      left join public.app_users u on u.id = s.cashier_id
     where s.customer_id = p_customer_id and s.org_id = v_reg.org_id
       and s.payment_method = 'account' and s.status = 'completed'
    union all
    select 'payment', 2, p.created_at, coalesce(p.reference, ''),
           initcap(p.method) || coalesce(' · ' || nullif(p.note, ''), ''),
           0, case when p.voided_at is null then p.amount else 0 end,
           p.id, p.voided_at is not null,
           null, null, null, null
      from public.customer_payments p
     where p.customer_id = p_customer_id and p.org_id = v_reg.org_id
  ),
  ordered as (
    select e.*, sum(e.charge - e.payment) over (order by e.entry_at, e.seq
             rows between unbounded preceding and current row) as running
      from entries e
  )
  select o.kind, o.entry_at, o.ref, o.detail, o.charge, o.payment,
         round(o.running, 2), o.entry_id, o.voided,
         o.cashier_name, o.tax_amount, o.status, o.payment_method
    from ordered o
   order by o.entry_at desc, o.seq desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

grant execute on function public.pos_customer_ledger(text, uuid, int)
  to anon, authenticated;
