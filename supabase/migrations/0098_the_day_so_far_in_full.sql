-- The day so far, in full.
--
-- 0097 put three figures over the phone's tiles. The tiles are going: the
-- phone opens on the figures and everything else is behind one menu, so the
-- figures have to be the whole answer to "how is the shop" rather than a
-- taste of it. What is added here, and why each is somebody's business and
-- not everybody's:
--
--   waiting_approval  a sale parked for a manager is a customer standing at
--                     the counter, so it is the first thing on the screen.
--                     approve_discount, because that is who can clear it.
--   drawers           each open till by name and the cash it should hold.
--     cash_management, and computed by cash_session_figures — the same
--     function the cash-up screen reads — so the two can never disagree.
--   owed              what the shop is owed, view_reports.
--   the split         cash against card, view_reports.
--   low_names         the first two names, so "2" is a fact and not a hunt.
--   today / late      a delivery due today and one a week overdue are not
--                     the same news, and neither is the pile behind them.
--
-- p_today is new: the day a delivery is "due today" on is the SHOP's day,
-- and the server's date is an hour or two ahead of it. The device sends its
-- own. Adding it makes a new signature, so the old one is dropped first or
-- every caller naming no optional argument becomes ambiguous.

drop function if exists public.pos_phone_summary(text, timestamptz, timestamptz);

create function public.pos_phone_summary(
  p_register_token text, p_from timestamptz default null,
  p_to timestamptz default null, p_today date default null
) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_perms text[];
  v_from timestamptz; v_to timestamptz; v_today date;
  v_count int; v_taken numeric; v_cash numeric; v_card numeric; v_owed numeric;
  v_waiting int; v_low int; v_names text[];
  v_out int; v_today_out int; v_late int;
  v_drawers jsonb;
begin
  v_reg := public.register_by_token(p_register_token);
  if v_reg.kind <> 'personal' or v_reg.assigned_to is null then
    raise exception 'This is not a personal device';
  end if;
  select * into v_user from public.app_users
   where id = v_reg.assigned_to and active and status = 'active';
  if not found then raise exception 'That person is no longer on the staff'; end if;
  v_perms := public.effective_permissions(v_user);

  v_from := coalesce(p_from, date_trunc('day', now()));
  v_to := coalesce(p_to, now());
  v_today := coalesce(p_today, current_date);
  if v_to <= v_from or v_to - v_from > interval '2 days' then
    raise exception 'That is not a day';
  end if;

  -- The takings, and how they were paid, for whoever may read reports.
  if 'view_reports' = any(v_perms) then
    select count(*)::int, coalesce(sum(s.total), 0) into v_count, v_taken
      from public.sales s
     where s.org_id = v_reg.org_id and s.status = 'completed'
       and s.created_at >= v_from and s.created_at < v_to;
    select coalesce(sum(sp.amount) filter (where sp.method = 'cash'), 0),
           coalesce(sum(sp.amount) filter (where sp.method <> 'cash'), 0)
      into v_cash, v_card
      from public.sale_payments sp
      join public.sales s on s.id = sp.sale_id
     where s.org_id = v_reg.org_id and s.status = 'completed'
       and s.created_at >= v_from and s.created_at < v_to;
    -- What the shop is owed, over every account that owes anything.
    select coalesce(sum(b), 0) into v_owed from (
      select public.customer_balance(c.id) as b
        from public.customers c where c.org_id = v_reg.org_id
    ) q where q.b > 0;
  end if;

  -- A customer waiting on a manager.
  if 'approve_discount' = any(v_perms) then
    select count(*)::int into v_waiting
      from public.sales s
     where s.org_id = v_reg.org_id and s.status = 'pending_approval';
  end if;

  -- What each open drawer should be holding, by the till's own name.
  if 'cash_management' = any(v_perms) then
    select coalesce(jsonb_agg(jsonb_build_object(
             'till', coalesce(r.name, 'This till'),
             'opened_at', cs.opened_at,
             'opened_by', cs.opened_by_name,
             'expected', (public.cash_session_figures(cs)->>'expected_cash')::numeric)
             order by cs.opened_at), '[]'::jsonb)
      into v_drawers
      from public.cash_sessions cs
      left join public.registers r on r.id = cs.register_id
     where cs.org_id = v_reg.org_id and cs.closed_at is null;
  end if;

  -- What wants ordering, and the first two of them by name.
  if 'manage_inventory' = any(v_perms) or 'manage_purchasing' = any(v_perms) then
    select count(*)::int into v_low
      from public.products p
     where p.org_id = v_reg.org_id and p.active
       and p.stock_qty is not null and p.reorder_level is not null
       and p.stock_qty <= p.reorder_level;
    select array_agg(n) into v_names from (
      select p.name as n
        from public.products p
       where p.org_id = v_reg.org_id and p.active
         and p.stock_qty is not null and p.reorder_level is not null
         and p.stock_qty <= p.reorder_level
       order by p.stock_qty - p.reorder_level, p.name
       limit 2
    ) q;
  end if;

  -- What is still to go out, and what should already have gone. No
  -- permission on either, exactly as the Deliveries screen has none.
  select count(*)::int,
         count(*) filter (where d.deliver_on = v_today)::int,
         count(*) filter (where d.deliver_on < v_today)::int
    into v_out, v_today_out, v_late
    from public.deliveries d
   where d.org_id = v_reg.org_id and d.status = 'pending';

  return jsonb_build_object(
    'sales_count', v_count, 'taken', v_taken,
    'cash_taken', v_cash, 'card_taken', v_card, 'owed', v_owed,
    'waiting_approval', v_waiting, 'drawers', v_drawers,
    'low_stock', v_low, 'low_names', to_jsonb(coalesce(v_names, array[]::text[])),
    'deliveries_out', v_out, 'deliveries_today', v_today_out,
    'deliveries_late', v_late);
end;
$$;
grant execute on function public.pos_phone_summary(text, timestamptz, timestamptz, date)
  to anon, authenticated;
