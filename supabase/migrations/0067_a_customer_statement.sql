-- 0067 — the statement a customer is sent at the end of the month.
--
-- The ledger (0024) answers "what has happened on this account", newest first,
-- forever. That is the right screen for a counter hand settling a payment and
-- the wrong document to post to a builder. A STATEMENT is a period: what was
-- owed when it opened, what was bought and paid inside it, what is owed now,
-- and how old that money is. It is the document that gets a shop paid, and
-- the shop has not had one.
--
-- Two rules it has to keep, both learned from paper statements that caused
-- arguments:
--
--   1. THE OPENING BALANCE IS EVERYTHING BEFORE THE WINDOW, not the balance
--      of the first line shown. A statement whose lines do not add up from
--      its own opening figure to its own closing figure is worse than none.
--   2. A REVERSED PAYMENT STAYS ON IT, marked, and pays nothing. Dropping it
--      leaves a customer looking for a payment they know they made.

/**
 * Every movement on one account, ever: the opening balance as a charge, each
 * account sale, each payment. Shared by the statement and (from here on)
 * anything else that needs to reason about an account over time.
 *
 * Internal — it takes an org rather than checking one, so it must never be
 * callable from a device.
 */
create or replace function public.customer_entries(p_org uuid, p_customer_id uuid)
returns table(kind text, seq int, at timestamptz, ref text, detail text,
              charge numeric, payment numeric, voided boolean)
language sql stable set search_path = public, extensions as $$
  select 'opening'::text, 0, c.created_at, ''::text, 'Opening balance'::text,
         c.opening_balance, 0::numeric, false
    from public.customers c
   where c.id = p_customer_id and c.org_id = p_org and c.opening_balance <> 0
  union all
  select 'charge', 1, s.created_at, coalesce(s.doc_number, ''),
         coalesce(nullif(s.po_number, ''), 'Invoice'), s.total, 0, false
    from public.sales s
   where s.customer_id = p_customer_id and s.org_id = p_org
     and s.payment_method = 'account' and s.status = 'completed'
  union all
  -- A reversed payment is shown and pays nothing.
  select 'payment', 2, p.created_at, coalesce(p.reference, ''),
         initcap(p.method) || coalesce(' · ' || nullif(p.note, ''), '')
           || case when p.voided_at is not null then ' (reversed)' else '' end,
         0, case when p.voided_at is null then p.amount else 0 end,
         p.voided_at is not null
    from public.customer_payments p
   where p.customer_id = p_customer_id and p.org_id = p_org;
$$;

revoke execute on function public.customer_entries(uuid, uuid)
  from anon, authenticated, public;

/**
 * One customer's statement for a period.
 *
 * Authorised by the register token alone, as the ledger is: a builder standing
 * at the counter asking what they owe is answered by whoever is on the till,
 * and refusing that would send them to phone the office instead.
 *
 * The ageing is as at TODAY, not as at the end of the window, because that is
 * what the person chasing the money needs and what the customer will be asked
 * about on the telephone.
 */
create or replace function public.pos_customer_statement(
  p_register_token text, p_customer_id uuid,
  p_from date default null, p_to date default null
) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_reg public.registers; v_cust public.customers;
  v_from date; v_to date; v_open numeric; v_lines jsonb;
  v_charges numeric; v_payments numeric; v_age record;
begin
  v_reg := public.register_by_token(p_register_token);
  select * into v_cust from public.customers
   where id = p_customer_id and org_id = v_reg.org_id;
  if not found then raise exception 'Unknown customer'; end if;

  v_to := coalesce(p_to, current_date);
  v_from := coalesce(p_from, (date_trunc('month', v_to::timestamp))::date);
  if v_from > v_to then
    raise exception 'A statement cannot end before it starts';
  end if;

  -- RULE 1: the opening balance is everything that happened before the window,
  -- whether or not any of it is shown below.
  select coalesce(sum(e.charge - e.payment), 0) into v_open
    from public.customer_entries(v_reg.org_id, p_customer_id) e
   where e.at::date < v_from;
  v_open := round(v_open, 2);

  select coalesce(jsonb_agg(jsonb_build_object(
           'at', t.at, 'kind', t.kind, 'ref', t.ref, 'detail', t.detail,
           'charge', t.charge, 'payment', t.payment, 'voided', t.voided,
           'balance', round(v_open + t.running, 2)
         ) order by t.at, t.seq), '[]'::jsonb),
         coalesce(sum(t.charge), 0), coalesce(sum(t.payment), 0)
    into v_lines, v_charges, v_payments
    from (
      select e.*, sum(e.charge - e.payment) over (order by e.at, e.seq
               rows between unbounded preceding and current row) as running
        from public.customer_entries(v_reg.org_id, p_customer_id) e
       where e.at::date between v_from and v_to
    ) t;

  select * into v_age from public.customer_aging(p_customer_id);

  return jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_cust.id, 'name', v_cust.name, 'phone', v_cust.phone,
      'address', v_cust.address, 'vat_number', v_cust.vat_number,
      'credit_limit', v_cust.credit_limit),
    'from', v_from, 'to', v_to,
    -- Deterministic, so the same statement asked for twice is the same
    -- document, and no sequence is burnt on something regenerated on a whim.
    'reference', 'STM-' || to_char(v_to, 'YYYYMMDD') || '-'
                 || upper(left(replace(v_cust.id::text, '-', ''), 6)),
    'opening', v_open,
    'lines', v_lines,
    'charges', round(v_charges, 2),
    'payments', round(v_payments, 2),
    'closing', round(v_open + v_charges - v_payments, 2),
    'ageing', jsonb_build_object(
      'current', v_age.current_due, 'days30', v_age.days30,
      'days60', v_age.days60, 'days90', v_age.days90,
      'total', v_age.total_due, 'oldest_unpaid', v_age.oldest_unpaid),
    'as_at', now()
  );
end;
$$;

grant execute on function public.pos_customer_statement(text, uuid, date, date)
  to anon, authenticated;
