-- What needs somebody, right now.
--
-- A bell, and the question is what hangs off it. Two things get called
-- notifications and they are not the same: a LOG of what happened (14:02 Sam
-- discounted R80), and a list of what is STILL WAITING. The log is the one
-- everybody builds and nobody reads — two hundred lines, the one that mattered
-- three screens down — and this shop already keeps it properly anyway, on the
-- sale, in the movements, in the approvals list.
--
-- So this is the second kind: conditions, derived from the records themselves
-- each time they are asked for. Nothing is written when something happens,
-- there is no table to fall out of step, and a notice disappears the moment
-- the thing is dealt with, because it was never anything but the thing itself.
--
-- WHO SEES WHAT. A personal device is one person's, so it is gated by that
-- person's effective permissions, exactly as pos_phone_summary is. A till is
-- nobody's: it stands on the counter and whoever is serving uses it, so it
-- gets the counter's own work — a customer parked waiting for a manager, a
-- load that should have gone out, a drawer left open overnight — and none of
-- the back office's. No money figures anywhere in here at all, on either: a
-- COUNT of things waiting is not a takings figure, which is what makes it
-- safe on a shared screen.
--
-- Every count is null rather than 0 when it is not this device's business, so
-- "not for you" and "none of them" stay different answers.

create function public.pos_notices(
  p_register_token text,
  -- The shop's own date. A delivery is late against the day where the shop
  -- is standing, not where the server is (0098 learned this).
  p_today date default null
) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_perms text[];
  v_counter boolean; v_today date;
  v_approvals int; v_late int; v_due int; v_low int; v_drawer int;
  v_no_pin int; v_unpriced int; v_overdue int;
begin
  v_reg := public.register_by_token(p_register_token);
  v_today := coalesce(p_today, current_date);
  v_counter := v_reg.kind is distinct from 'personal';

  if not v_counter then
    if v_reg.assigned_to is null then
      raise exception 'This personal device has no owner';
    end if;
    select * into v_user from public.app_users
     where id = v_reg.assigned_to and active and status = 'active';
    if not found then raise exception 'That person is no longer on the staff'; end if;
    v_perms := public.effective_permissions(v_user);
  end if;

  -- A customer standing at the counter while somebody finds a manager. First
  -- on the list wherever it appears, and the counter's business by definition.
  if v_counter or 'approve_discount' = any(v_perms) then
    select count(*)::int into v_approvals
      from public.sales s
     where s.org_id = v_reg.org_id and s.status = 'pending_approval';
  end if;

  -- What should already have gone out, and what goes today. The Deliveries
  -- screen has no permission on it, so neither do these.
  select count(*) filter (where d.deliver_on < v_today)::int,
         count(*) filter (where d.deliver_on = v_today)::int
    into v_late, v_due
    from public.deliveries d
   where d.org_id = v_reg.org_id and d.status = 'pending';

  -- A drawer nobody closed. The same eighteen hours the till's own banner
  -- uses (lib/cashup), so the bell and the banner cannot disagree about what
  -- counts as "left open".
  if v_counter or 'cash_management' = any(v_perms) then
    select count(*)::int into v_drawer
      from public.cash_sessions cs
     where cs.org_id = v_reg.org_id and cs.closed_at is null
       and now() - cs.opened_at >= interval '18 hours';
  end if;

  -- The back office's own, and only on a device that belongs to somebody who
  -- holds the right. A till is shared; none of these are its work.
  if not v_counter then
    if 'manage_inventory' = any(v_perms) or 'manage_purchasing' = any(v_perms) then
      select count(*)::int into v_low
        from public.products p
       where p.org_id = v_reg.org_id and p.active
         and p.stock_qty is not null and p.reorder_level is not null
         and p.stock_qty <= p.reorder_level;
    end if;

    -- Somebody invited who still cannot sign in. They are waiting on the
    -- person who invited them and have no way to say so.
    if 'manage_staff' = any(v_perms) then
      select count(*)::int into v_no_pin
        from public.app_users u
       where u.org_id = v_reg.org_id and u.active and u.status = 'invited';
    end if;

    -- Photographed onto the shelf and never priced, so the till cannot sell
    -- it. Unpriced AND off the till: an item deliberately withdrawn has a
    -- price on it and is not this.
    if 'manage_catalogue' = any(v_perms) then
      select count(*)::int into v_unpriced
        from public.products p
       where p.org_id = v_reg.org_id and not p.active
         and coalesce(p.price_retail, 0) = 0;
    end if;

    -- An order the supplier has had since before it was due.
    if 'manage_purchasing' = any(v_perms) then
      select count(*)::int into v_overdue
        from public.purchase_orders po
       where po.org_id = v_reg.org_id and po.status in ('sent', 'part')
         and po.expected_on is not null and po.expected_on < v_today;
    end if;
  end if;

  return jsonb_build_object(
    'approvals', v_approvals,
    'deliveries_late', v_late,
    'deliveries_today', v_due,
    'drawer_open', v_drawer,
    'low_stock', v_low,
    'staff_no_pin', v_no_pin,
    'unpriced', v_unpriced,
    'orders_overdue', v_overdue);
end;
$$;

grant execute on function public.pos_notices(text, date) to anon, authenticated;
