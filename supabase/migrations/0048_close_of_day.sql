-- 0048: closing the day, not only counting the drawer.
--
-- The cash-up measured one thing — cash counted against cash expected — and
-- that is still the figure that matters most. But a reconciliation has three
-- more questions the slip could not answer:
--
--   * Does the card machine's batch total agree with what the till says went
--     through it? The slip printed the till's card figure; there was nowhere
--     to write the machine's, so the comparison happened on a scrap of paper
--     or not at all. The same for EFTs against the bank statement.
--   * How much was banked, and how much stayed in the drawer as tomorrow's
--     float? Neither was recorded, so the next morning's float was retyped
--     from memory.
--   * What is tomorrow's float? Now the answer is on file: the amount kept.
--
-- All three are snapshotted at close, like the cash variance: a statement
-- about a moment, not a figure that drifts when read later. Every new
-- argument is optional — a shop with no card machine closes exactly as
-- before.
--
-- Adding defaulted arguments is a NEW signature, so the 0029 close is
-- dropped first (see CLAUDE.md).

alter table public.cash_sessions
  add column if not exists card_counted  numeric(12,2) check (card_counted >= 0),
  add column if not exists card_expected numeric(12,2),
  add column if not exists card_variance numeric(12,2),
  add column if not exists eft_counted   numeric(12,2) check (eft_counted >= 0),
  add column if not exists eft_expected  numeric(12,2),
  add column if not exists eft_variance  numeric(12,2),
  add column if not exists banked        numeric(12,2) check (banked >= 0),
  add column if not exists float_kept    numeric(12,2) check (float_kept >= 0);

-- The till's card and EFT figures are sales by that tender plus account
-- settlements by that tender: the machine does not know a sale from a debtor
-- paying up, so neither may the figure it is checked against.
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
    'card_expected',  coalesce((select amount from tender where method = 'card'), 0)
                        + coalesce((select amount from acct where method = 'card'), 0),
    'eft_expected',   coalesce((select amount from tender where method = 'eft'), 0)
                        + coalesce((select amount from acct where method = 'eft'), 0),
    'pay_in',         (select pay_in from mv),
    'pay_out',        (select pay_out from mv),
    'expected_cash',  p_session.opening_float
                        + coalesce((select amount from tender where method = 'cash'), 0)
                        + coalesce((select amount from acct where method = 'cash'), 0)
                        + (select pay_in from mv)
                        - (select pay_out from mv)
  );
$$;

drop function if exists public.pos_cash_session_close(text, text, numeric, text);

create function public.pos_cash_session_close(
  p_register_token text, p_pin text, p_counted_cash numeric, p_note text default null,
  p_card_counted numeric default null, p_eft_counted numeric default null,
  p_banked numeric default null
) returns jsonb
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_reg public.registers;
        v_session public.cash_sessions; v_fig jsonb; v_expected numeric;
        v_card_exp numeric; v_eft_exp numeric;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'cash_management');
  v_reg  := public.register_by_token(p_register_token);

  select * into v_session from public.cash_sessions cs
   where cs.register_id = v_reg.id and cs.closed_at is null;
  if v_session.id is null then raise exception 'No session is open on this till'; end if;
  if p_counted_cash is null or p_counted_cash < 0 then
    raise exception 'Count the drawer first';
  end if;
  if p_card_counted < 0 or p_eft_counted < 0 or p_banked < 0 then
    raise exception 'A total cannot be negative';
  end if;
  if p_banked > p_counted_cash then
    raise exception 'More cannot be banked than was counted';
  end if;

  v_session.closed_at := now();
  v_fig := public.cash_session_figures(v_session);
  v_expected := (v_fig->>'expected_cash')::numeric;
  v_card_exp := (v_fig->>'card_expected')::numeric;
  v_eft_exp  := (v_fig->>'eft_expected')::numeric;

  update public.cash_sessions cs set
    closed_at = v_session.closed_at,
    closed_by = v_user.id,
    closed_by_name = v_user.name,
    counted_cash = p_counted_cash,
    expected_cash = v_expected,
    variance = round(p_counted_cash - v_expected, 2),
    card_counted = p_card_counted,
    card_expected = case when p_card_counted is null then null else v_card_exp end,
    card_variance = case when p_card_counted is null then null else round(p_card_counted - v_card_exp, 2) end,
    eft_counted = p_eft_counted,
    eft_expected = case when p_eft_counted is null then null else v_eft_exp end,
    eft_variance = case when p_eft_counted is null then null else round(p_eft_counted - v_eft_exp, 2) end,
    banked = p_banked,
    float_kept = case when p_banked is null then null else round(p_counted_cash - p_banked, 2) end,
    note = nullif(trim(coalesce(p_note, '')), '')
   where cs.id = v_session.id
   returning * into v_session;

  update public.sales sa set session_id = v_session.id
   where sa.org_id = v_session.org_id
     and sa.register_id is not distinct from v_session.register_id
     and sa.created_at >= v_session.opened_at and sa.created_at <= v_session.closed_at
     and sa.session_id is null;

  update public.customer_payments cp set session_id = v_session.id
   where cp.org_id = v_session.org_id
     and cp.created_at >= v_session.opened_at and cp.created_at <= v_session.closed_at
     and cp.session_id is null;

  return to_jsonb(v_session) || jsonb_build_object('figures', v_fig);
end;
$$;
grant execute on function public.pos_cash_session_close(text, text, numeric, text, numeric, numeric, numeric)
  to anon, authenticated;

-- Tomorrow's float is what was kept last night. Asked by the open form so the
-- figure is offered rather than retyped from memory; null when the last close
-- did not say, or there has never been one.
create function public.pos_cash_session_suggested_float(p_register_token text, p_pin text)
returns numeric
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_reg public.registers; v_kept numeric;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'cash_management');
  v_reg  := public.register_by_token(p_register_token);
  select cs.float_kept into v_kept from public.cash_sessions cs
   where cs.register_id = v_reg.id and cs.closed_at is not null
   order by cs.closed_at desc limit 1;
  return v_kept;
end;
$$;
grant execute on function public.pos_cash_session_suggested_float(text, text) to anon, authenticated;
