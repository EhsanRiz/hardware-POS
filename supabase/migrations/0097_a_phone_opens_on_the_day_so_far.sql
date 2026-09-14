-- What a phone shows before anything is tapped.
--
-- The phone's home was a launcher: nine tiles and no figures, so a manager
-- opening it in the evening had to guess which tile answered "how did today
-- go". The figures live here rather than on three separate calls because
-- the answer is one glance, and because each of them is somebody's business
-- and not everybody's.
--
-- Who is asking is settled by the TOKEN, not by a name the caller sends: a
-- personal register carries assigned_to (0074, and the check constraint that
-- a personal device has an owner), so the phone's own token names its owner,
-- and this returns only what that owner's permissions allow. A till's token
-- has no owner and is refused — a till has the whole back office one tap
-- away and does not need a summary of it.
--
-- No PIN, deliberately: this is the screen BEFORE the PIN, and everything it
-- returns is a count or a total that the same person may open in full a tap
-- later. Anything a PIN would unlock is not here.

create function public.pos_phone_summary(
  p_register_token text, p_from timestamptz default null, p_to timestamptz default null
) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_perms text[];
  v_from timestamptz; v_to timestamptz;
  v_count int; v_taken numeric; v_low int; v_out int;
begin
  v_reg := public.register_by_token(p_register_token);
  if v_reg.kind <> 'personal' or v_reg.assigned_to is null then
    raise exception 'This is not a personal device';
  end if;
  select * into v_user from public.app_users
   where id = v_reg.assigned_to and active and status = 'active';
  if not found then raise exception 'That person is no longer on the staff'; end if;
  v_perms := public.effective_permissions(v_user);

  -- The device decides where its own day begins, as every other report does
  -- (rangeBounds in sales.ts). Bounded to a couple of days all the same:
  -- this is the panel above the tiles, not a way to total a year.
  v_from := coalesce(p_from, date_trunc('day', now()));
  v_to := coalesce(p_to, now());
  if v_to <= v_from or v_to - v_from > interval '2 days' then
    raise exception 'That is not a day';
  end if;

  -- The takings, for whoever may read reports at all.
  if 'view_reports' = any(v_perms) then
    select count(*)::int, coalesce(sum(s.total), 0) into v_count, v_taken
      from public.sales s
     where s.org_id = v_reg.org_id and s.status = 'completed'
       and s.created_at >= v_from and s.created_at < v_to;
  end if;

  -- What wants ordering, for whoever orders or keeps the shelves.
  if 'manage_inventory' = any(v_perms) or 'manage_purchasing' = any(v_perms) then
    select count(*)::int into v_low
      from public.products p
     where p.org_id = v_reg.org_id and p.active
       and p.stock_qty is not null and p.reorder_level is not null
       and p.stock_qty <= p.reorder_level;
  end if;

  -- What is still to go out. No permission on it, exactly as the Deliveries
  -- tile has none: anybody who can sign in may load a bakkie.
  select count(*)::int into v_out
    from public.deliveries d
   where d.org_id = v_reg.org_id and d.status = 'pending';

  return jsonb_build_object(
    'sales_count', v_count, 'taken', v_taken,
    'low_stock', v_low, 'deliveries_out', v_out);
end;
$$;
grant execute on function public.pos_phone_summary(text, timestamptz, timestamptz)
  to anon, authenticated;
