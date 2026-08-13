-- Cashing up: the drawer count at the end of a day.
--
-- 0003 and 0004 both gave their tables a session_id "set when the payment is
-- banked as part of a till session, so cash-up can account for account
-- settlements taken over the counter". Neither column was ever written, because
-- the table they point at was never created. This is that table.
--
-- The number that matters here is the variance. A day's takings tell a manager
-- what was sold; only expected-versus-counted tells them whether the money that
-- should be in the drawer is in the drawer. A closing report without it is a
-- sales total wearing a different hat, so opening float, pay-ins, pay-outs and
-- the counted cash are all first-class here.
--
-- ATTRIBUTION. A sale belongs to a session by register and time, not by a
-- foreign key written when it is rung up. That is deliberate: this till sells
-- offline, and a sale made at 15:40 and synced at 18:00 carries its true
-- created_at, so a window puts it in the session it actually happened in — where
-- stamping it on arrival would file it under whatever session was open when the
-- signal came back. Closing a session stamps session_id across its window, so
-- the record is durable afterwards and anything that lands late is visibly
-- unstamped rather than silently merged.
--
-- The one case this cannot fix: a sale that syncs after its own session has been
-- closed is not in the stored variance, because the drawer was counted without
-- it. The till warns before closing while anything is still queued, which is the
-- only moment anyone can do something about it.

create table public.cash_sessions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  register_id   uuid references public.registers(id),
  opened_by     uuid references public.app_users(id),
  opened_by_name text not null,
  opened_at     timestamptz not null default now(),
  opening_float numeric(12,2) not null default 0 check (opening_float >= 0),
  closed_by     uuid references public.app_users(id),
  closed_by_name text,
  closed_at     timestamptz,
  counted_cash  numeric(12,2),
  -- Snapshotted at close, not recomputed on every read: the variance is a
  -- statement about what was in the drawer when somebody counted it, and a
  -- figure that quietly changes afterwards is not evidence of anything.
  expected_cash numeric(12,2),
  variance      numeric(12,2),
  note          text,
  created_at    timestamptz not null default now()
);

-- One open session per till. Two would mean two drawers' worth of takings
-- landing in the same window with no way to tell them apart.
create unique index cash_sessions_one_open_per_register
  on public.cash_sessions (register_id) where closed_at is null;
create index cash_sessions_org_idx on public.cash_sessions (org_id, opened_at desc);

-- Money in or out of the drawer that is not a sale: a float top-up, petty cash
-- for a delivery, the banking run. Without these every such movement reads as a
-- shortfall at close, and a variance nobody believes is a variance nobody reads.
create table public.cash_movements (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  session_id  uuid not null references public.cash_sessions(id) on delete cascade,
  kind        text not null check (kind in ('pay_in','pay_out')),
  amount      numeric(12,2) not null check (amount > 0),
  reason      text not null,
  by_user     uuid references public.app_users(id),
  by_name     text,
  created_at  timestamptz not null default now()
);
create index cash_movements_session_idx on public.cash_movements (session_id, created_at);

alter table public.cash_sessions  enable row level security;
alter table public.cash_movements enable row level security;

-- Reached only through the RPCs below, as with every other till table.
revoke all on public.cash_sessions  from anon, authenticated;
revoke all on public.cash_movements from anon, authenticated;

-- The figures for one session, computed from its window.
--
-- Cash into the drawer is the cash APPLIED to sales, not the notes handed over:
-- a R200 note against a R115 sale puts R200 in and takes R85 out, and the drawer
-- is R115 up either way. Account settlements paid in cash count too — a builder
-- paying R5 000 off their account over the counter is drawer money like any
-- other, which is exactly what customer_payments.session_id was reserved for.
create function public.cash_session_figures(p_session public.cash_sessions)
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
    select coalesce(sum(cp.amount), 0) as cash
      from public.customer_payments cp, win
     where cp.org_id = p_session.org_id
       and cp.created_at >= win.from_at and cp.created_at <= win.to_at
       and cp.method = 'cash'
       and cp.voided_at is null
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
    'account_cash',   (select cash from acct),
    'pay_in',         (select pay_in from mv),
    'pay_out',        (select pay_out from mv),
    'expected_cash',  p_session.opening_float
                        + coalesce((select amount from tender where method = 'cash'), 0)
                        + (select cash from acct)
                        + (select pay_in from mv)
                        - (select pay_out from mv)
  );
$$;

-- Open the drawer for the day, with whatever float is being put in it.
create function public.pos_cash_session_open(
  p_register_token text, p_pin text, p_opening_float numeric default 0
) returns public.cash_sessions
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_reg public.registers; v_row public.cash_sessions;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'cash_management');
  v_reg  := public.register_by_token(p_register_token);

  if exists (select 1 from public.cash_sessions cs
              where cs.register_id = v_reg.id and cs.closed_at is null) then
    raise exception 'This till already has a session open';
  end if;
  if coalesce(p_opening_float, 0) < 0 then
    raise exception 'The opening float cannot be negative';
  end if;

  insert into public.cash_sessions
    (org_id, register_id, opened_by, opened_by_name, opening_float)
  values (v_user.org_id, v_reg.id, v_user.id, v_user.name, coalesce(p_opening_float, 0))
  returning * into v_row;
  return v_row;
end;
$$;

-- The open session on this till, with its running figures. Null when the drawer
-- has not been opened, which is how the till knows to offer opening it.
create function public.pos_cash_session_current(p_register_token text, p_pin text)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_reg public.registers; v_row public.cash_sessions;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'cash_management');
  v_reg  := public.register_by_token(p_register_token);

  select * into v_row from public.cash_sessions cs
   where cs.register_id = v_reg.id and cs.closed_at is null;
  if v_row.id is null then return null; end if;

  return to_jsonb(v_row) || jsonb_build_object(
    'figures', public.cash_session_figures(v_row),
    'movements', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.created_at)
        from public.cash_movements m where m.session_id = v_row.id), '[]'::jsonb)
  );
end;
$$;

-- A float top-up or a payout, against the open session.
create function public.pos_cash_movement(
  p_register_token text, p_pin text, p_kind text, p_amount numeric, p_reason text
) returns public.cash_movements
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_reg public.registers;
        v_session public.cash_sessions; v_row public.cash_movements;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'cash_management');
  v_reg  := public.register_by_token(p_register_token);

  select * into v_session from public.cash_sessions cs
   where cs.register_id = v_reg.id and cs.closed_at is null;
  if v_session.id is null then raise exception 'No session is open on this till'; end if;
  if p_kind not in ('pay_in','pay_out') then raise exception 'Unknown movement'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'An amount is required'; end if;
  -- A movement nobody can explain is the one that hides a shortfall.
  if trim(coalesce(p_reason, '')) = '' then raise exception 'A reason is required'; end if;

  insert into public.cash_movements
    (org_id, session_id, kind, amount, reason, by_user, by_name)
  values (v_session.org_id, v_session.id, p_kind, p_amount, trim(p_reason), v_user.id, v_user.name)
  returning * into v_row;
  return v_row;
end;
$$;

-- Count the drawer and close.
--
-- The variance is stored rather than left to be recomputed, and the session's
-- sales are stamped on the way out so the window it was measured over stays
-- reconstructable even if a later sale lands in the same span.
create function public.pos_cash_session_close(
  p_register_token text, p_pin text, p_counted_cash numeric, p_note text default null
) returns jsonb
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_reg public.registers;
        v_session public.cash_sessions; v_fig jsonb; v_expected numeric;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'cash_management');
  v_reg  := public.register_by_token(p_register_token);

  select * into v_session from public.cash_sessions cs
   where cs.register_id = v_reg.id and cs.closed_at is null;
  if v_session.id is null then raise exception 'No session is open on this till'; end if;
  if p_counted_cash is null or p_counted_cash < 0 then
    raise exception 'Count the drawer first';
  end if;

  v_session.closed_at := now();
  v_fig := public.cash_session_figures(v_session);
  v_expected := (v_fig->>'expected_cash')::numeric;

  update public.cash_sessions cs set
    closed_at = v_session.closed_at,
    closed_by = v_user.id,
    closed_by_name = v_user.name,
    counted_cash = p_counted_cash,
    expected_cash = v_expected,
    variance = round(p_counted_cash - v_expected, 2),
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

-- Closed sessions, most recent first, so a manager can reprint yesterday's.
create function public.pos_cash_sessions(
  p_register_token text, p_pin text, p_limit int default 30
) returns jsonb
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'cash_management');
  return coalesce((
    select jsonb_agg(to_jsonb(cs) || jsonb_build_object(
             'figures', public.cash_session_figures(cs))
           order by cs.opened_at desc)
      from (select * from public.cash_sessions c
             where c.org_id = v_user.org_id and c.closed_at is not null
             order by c.opened_at desc
             limit greatest(1, least(coalesce(p_limit, 30), 200))) cs
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.cash_session_figures(public.cash_sessions)
  from anon, authenticated, public;
grant execute on function public.pos_cash_session_open(text, text, numeric) to anon, authenticated;
grant execute on function public.pos_cash_session_current(text, text)       to anon, authenticated;
grant execute on function public.pos_cash_movement(text, text, text, numeric, text) to anon, authenticated;
grant execute on function public.pos_cash_session_close(text, text, numeric, text)  to anon, authenticated;
grant execute on function public.pos_cash_sessions(text, text, int)         to anon, authenticated;
