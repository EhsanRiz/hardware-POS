-- Cash-up: shift sessions, petty-cash movements, and cash/card reconciliation.

create table if not exists public.cash_sessions (
  id            uuid primary key default gen_random_uuid(),
  opened_by     uuid references public.app_users(id),
  opened_by_name text,
  opened_at     timestamptz not null default now(),
  opening_float numeric(10,2) not null default 0,
  status        text not null default 'open',
  closed_by     uuid references public.app_users(id),
  closed_by_name text,
  closed_at     timestamptz,
  cash_sales    numeric(10,2),
  card_sales    numeric(10,2),
  pay_ins       numeric(10,2),
  pay_outs      numeric(10,2),
  expected_cash numeric(10,2),
  counted_cash  numeric(10,2),
  cash_variance numeric(10,2),
  expected_card numeric(10,2),
  settled_card  numeric(10,2),
  card_variance numeric(10,2),
  notes         text
);

create table if not exists public.cash_movements (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.cash_sessions(id) on delete cascade,
  type       text not null check (type in ('pay_in','pay_out')),
  amount     numeric(10,2) not null check (amount > 0),
  reason     text,
  by_id      uuid references public.app_users(id),
  by_name    text,
  at         timestamptz not null default now()
);

alter table public.cash_sessions enable row level security;
alter table public.cash_movements enable row level security;

update public.app_users set permissions = array_append(permissions, 'cash_management')
  where role = 'manager' and not ('cash_management' = any(permissions));

create or replace function public.pos_open_cash_session(p_pin text, p_opening_float numeric)
returns public.cash_sessions
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_s public.cash_sessions;
begin
  v_actor := public.pos_user_with_perm(p_pin, 'cash_management');
  if v_actor.id is null then raise exception 'Not permitted to manage cash'; end if;
  if exists (select 1 from public.cash_sessions where status='open') then
    raise exception 'A shift is already open';
  end if;
  insert into public.cash_sessions(opened_by, opened_by_name, opening_float)
  values (v_actor.id, v_actor.name, coalesce(p_opening_float,0))
  returning * into v_s;
  return v_s;
end;
$$;

create or replace function public.pos_add_cash_movement(
  p_pin text, p_session_id uuid, p_type text, p_amount numeric, p_reason text
) returns public.cash_movements
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_m public.cash_movements;
begin
  v_actor := public.pos_user_with_perm(p_pin, 'cash_management');
  if v_actor.id is null then raise exception 'Not permitted to manage cash'; end if;
  if p_type not in ('pay_in','pay_out') then raise exception 'Invalid movement type'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if not exists (select 1 from public.cash_sessions where id=p_session_id and status='open') then
    raise exception 'Shift is not open';
  end if;
  insert into public.cash_movements(session_id, type, amount, reason, by_id, by_name)
  values (p_session_id, p_type, p_amount, nullif(trim(p_reason),''), v_actor.id, v_actor.name)
  returning * into v_m;
  return v_m;
end;
$$;

create or replace function public.pos_get_open_session(p_pin text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_actor public.app_users; v_s public.cash_sessions;
  v_cash numeric(10,2); v_card numeric(10,2); v_in numeric(10,2); v_out numeric(10,2);
begin
  v_actor := public.pos_user_with_perm(p_pin, 'cash_management');
  if v_actor.id is null then raise exception 'Not permitted to manage cash'; end if;

  select * into v_s from public.cash_sessions where status='open' limit 1;
  if not found then return null; end if;

  select coalesce(sum(total) filter (where payment_method='cash'),0),
         coalesce(sum(total) filter (where payment_method='card'),0)
    into v_cash, v_card
  from public.sales where status='completed' and created_at >= v_s.opened_at;

  select coalesce(sum(amount) filter (where type='pay_in'),0),
         coalesce(sum(amount) filter (where type='pay_out'),0)
    into v_in, v_out
  from public.cash_movements where session_id = v_s.id;

  return jsonb_build_object(
    'id', v_s.id, 'opened_by_name', v_s.opened_by_name, 'opened_at', v_s.opened_at,
    'opening_float', v_s.opening_float,
    'cash_sales', v_cash, 'card_sales', v_card, 'pay_ins', v_in, 'pay_outs', v_out,
    'expected_cash', v_s.opening_float + v_cash + v_in - v_out,
    'expected_card', v_card,
    'movements', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'type', m.type, 'amount', m.amount, 'reason', m.reason,
        'by_name', m.by_name, 'at', m.at) order by m.at desc), '[]'::jsonb)
      from public.cash_movements m where m.session_id = v_s.id)
  );
end;
$$;

create or replace function public.pos_close_cash_session(
  p_pin text, p_session_id uuid, p_counted_cash numeric,
  p_settled_card numeric, p_notes text
) returns public.cash_sessions
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_actor public.app_users; v_s public.cash_sessions;
  v_cash numeric(10,2); v_card numeric(10,2); v_in numeric(10,2); v_out numeric(10,2);
  v_exp_cash numeric(10,2);
begin
  v_actor := public.pos_user_with_perm(p_pin, 'cash_management');
  if v_actor.id is null then raise exception 'Not permitted to manage cash'; end if;
  select * into v_s from public.cash_sessions where id=p_session_id and status='open';
  if not found then raise exception 'Shift is not open'; end if;

  select coalesce(sum(total) filter (where payment_method='cash'),0),
         coalesce(sum(total) filter (where payment_method='card'),0)
    into v_cash, v_card
  from public.sales where status='completed'
    and created_at >= v_s.opened_at and created_at <= now();

  select coalesce(sum(amount) filter (where type='pay_in'),0),
         coalesce(sum(amount) filter (where type='pay_out'),0)
    into v_in, v_out
  from public.cash_movements where session_id = v_s.id;

  v_exp_cash := v_s.opening_float + v_cash + v_in - v_out;

  update public.cash_sessions set
    status='closed', closed_by=v_actor.id, closed_by_name=v_actor.name, closed_at=now(),
    cash_sales=v_cash, card_sales=v_card, pay_ins=v_in, pay_outs=v_out,
    expected_cash=v_exp_cash, counted_cash=p_counted_cash,
    cash_variance = case when p_counted_cash is not null then p_counted_cash - v_exp_cash end,
    expected_card=v_card, settled_card=p_settled_card,
    card_variance = case when p_settled_card is not null then p_settled_card - v_card end,
    notes=nullif(trim(p_notes),'')
  where id=p_session_id
  returning * into v_s;
  return v_s;
end;
$$;

create or replace function public.pos_list_cash_sessions(p_pin text)
returns setof public.cash_sessions
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users;
begin
  v_actor := public.pos_user_with_perm(p_pin, 'cash_management');
  if v_actor.id is null then raise exception 'Not permitted to manage cash'; end if;
  return query select * from public.cash_sessions order by opened_at desc limit 50;
end;
$$;

revoke all on function public.pos_open_cash_session(text, numeric) from public;
revoke all on function public.pos_add_cash_movement(text, uuid, text, numeric, text) from public;
revoke all on function public.pos_get_open_session(text) from public;
revoke all on function public.pos_close_cash_session(text, uuid, numeric, numeric, text) from public;
revoke all on function public.pos_list_cash_sessions(text) from public;
grant execute on function public.pos_open_cash_session(text, numeric) to anon, authenticated;
grant execute on function public.pos_add_cash_movement(text, uuid, text, numeric, text) to anon, authenticated;
grant execute on function public.pos_get_open_session(text) to anon, authenticated;
grant execute on function public.pos_close_cash_session(text, uuid, numeric, numeric, text) to anon, authenticated;
grant execute on function public.pos_list_cash_sessions(text) to anon, authenticated;
