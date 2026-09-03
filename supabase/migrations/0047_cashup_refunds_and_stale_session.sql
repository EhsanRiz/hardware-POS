-- 0047: two lines the cash-up slip was missing, and a till that knows its
-- own drawer has been open since yesterday.
--
-- REFUNDS. A cash refund leaves the drawer as a pay-out (0045), so the
-- drawer maths was right — but TAKINGS printed sales gross, and the only
-- trace of the money going back was a line under IN AND OUT. Refunds are
-- now a figure of their own, so "Sales" less "Refunds" is what the shop
-- actually took.
--
-- ACCOUNT PAYMENTS BY CARD OR EFT. The slip listed account settlements paid
-- in cash (drawer money) and nothing else. A settlement taken on the card
-- machine appeared nowhere, which broke the one check the tender breakdown
-- exists for: the card machine's batch total against the slip. Every
-- method is listed now; cash stays in the drawer working as before.
--
-- Both, like account_cash, are shop-wide within the window rather than per
-- register: returns and settlements carry no register. A cash refund on
-- another till is excluded by its session stamp.
--
-- STALE SESSION. Nothing told anyone that a session had been open since
-- yesterday, and one left open swallows several days' sales into a single
-- window. pos_cash_session_status answers the till itself — by register
-- token, no PIN — with when the drawer was opened and by whom, and nothing
-- else, so the sign-in screen can say so before the first sale of the day.

create or replace function public.cash_session_figures(p_session public.cash_sessions)
returns jsonb
language sql stable
set search_path to 'public', 'extensions'
as $$
  with win as (
    select p_session.opened_at as from_at,
           coalesce(p_session.closed_at, now()) as to_at
  ),
  s as (
    select sa.id, sa.total, sa.tax_amount, sa.discount_amount
      from public.sales sa, win
     where sa.org_id = p_session.org_id
       and sa.register_id is not distinct from p_session.register_id
       and sa.created_at >= win.from_at and sa.created_at <= win.to_at
       and sa.status = 'completed'
  ),
  tender as (
    select sp.method::text as method, sum(sp.amount) as amount
      from public.sale_payments sp join s on s.id = sp.sale_id
     group by 1
  ),
  acct as (
    select cp.method as method, sum(cp.amount) as amount
      from public.customer_payments cp, win
     where cp.org_id = p_session.org_id
       and cp.created_at >= win.from_at and cp.created_at <= win.to_at
       and cp.voided_at is null
     group by 1
  ),
  ret as (
    select count(*) as n, coalesce(sum(r.total), 0) as total
      from public.returns r, win
     where r.org_id = p_session.org_id
       and r.created_at >= win.from_at and r.created_at <= win.to_at
       and (r.cash_session_id = p_session.id or r.cash_session_id is null)
  ),
  mv as (
    select coalesce(sum(amount) filter (where kind = 'pay_in'), 0)  as pay_in,
           coalesce(sum(amount) filter (where kind = 'pay_out'), 0) as pay_out
      from public.cash_movements where session_id = p_session.id
  )
  select jsonb_build_object(
    'sales_count',    (select count(*) from s),
    'sales_total',    (select coalesce(sum(total), 0) from s),
    'vat_total',      (select coalesce(sum(tax_amount), 0) from s),
    'discount_total', (select coalesce(sum(discount_amount), 0) from s),
    'tenders',        (select coalesce(jsonb_object_agg(method, amount), '{}'::jsonb) from tender),
    'cash_sales',     (select coalesce((select amount from tender where method = 'cash'), 0)),
    'account_cash',   (select coalesce((select amount from acct where method = 'cash'), 0)),
    'account_payments', (select coalesce(jsonb_object_agg(method, amount), '{}'::jsonb) from acct),
    'refunds_count',  (select n from ret),
    'refunds_total',  (select total from ret),
    'pay_in',         (select pay_in from mv),
    'pay_out',        (select pay_out from mv),
    'expected_cash',  p_session.opening_float
                        + coalesce((select amount from tender where method = 'cash'), 0)
                        + coalesce((select amount from acct where method = 'cash'), 0)
                        + (select pay_in from mv)
                        - (select pay_out from mv)
  );
$$;

-- The till's own question: is a drawer open here, and since when. Register
-- token only — the answer names a time and a person, never a figure.
create function public.pos_cash_session_status(p_register_token text)
returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers; v_s public.cash_sessions;
begin
  v_reg := public.register_by_token(p_register_token);
  select * into v_s from public.cash_sessions cs
   where cs.register_id = v_reg.id and cs.closed_at is null;
  if v_s.id is null then return null; end if;
  return jsonb_build_object(
    'id', v_s.id,
    'opened_at', v_s.opened_at,
    'opened_by_name', v_s.opened_by_name,
    'hours_open', round(extract(epoch from (now() - v_s.opened_at)) / 3600, 1));
end;
$$;
grant execute on function public.pos_cash_session_status(text) to anon, authenticated;
