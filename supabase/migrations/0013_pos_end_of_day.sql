-- End-of-day report. Any active staff member can run and print it (no special
-- permission needed), so each person can close out their own day. Returns the
-- day's totals plus a per-staff breakdown of cash / card / tips / discounts.

-- Verify a PIN belongs to any active user (no permission requirement).
create or replace function public.pos_active_user(p_pin text)
returns public.app_users
language sql stable security definer set search_path = public, extensions as $$
  select u.* from public.app_users u
  where u.active and u.pin_hash = crypt(p_pin, u.pin_hash)
  limit 1;
$$;
revoke all on function public.pos_active_user(text) from public;

create or replace function public.pos_end_of_day(
  p_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_actor public.app_users; v_out jsonb;
begin
  v_actor := public.pos_active_user(p_pin);
  if v_actor.id is null then raise exception 'Not signed in'; end if;

  select jsonb_build_object(
    'sales_count', count(*),
    'gross', coalesce(sum(subtotal),0),
    'discount', coalesce(sum(discount_amount),0),
    'tips', coalesce(sum(tip_amount),0),
    'net', coalesce(sum(total),0),
    'cash', coalesce(sum(total) filter (where payment_method = 'cash'),0),
    'card', coalesce(sum(total) filter (where payment_method = 'card'),0),
    'other', coalesce(sum(total) filter (where payment_method is null),0)
  ) into v_out from public.sales
  where status = 'completed' and created_at >= p_from and created_at < p_to;

  v_out := v_out || jsonb_build_object('by_cashier', (
    select coalesce(jsonb_agg(c), '[]'::jsonb) from (
      select cashier_name as name,
             count(*)::int as sales,
             coalesce(sum(total),0) as net,
             coalesce(sum(total) filter (where payment_method = 'cash'),0) as cash,
             coalesce(sum(total) filter (where payment_method = 'card'),0) as card,
             coalesce(sum(total) filter (where payment_method is null),0) as other,
             coalesce(sum(tip_amount),0) as tips,
             coalesce(sum(discount_amount),0) as discount
      from public.sales
      where status = 'completed' and created_at >= p_from and created_at < p_to
      group by cashier_name
      order by sum(total) desc) c));

  return v_out;
end;
$$;
revoke all on function public.pos_end_of_day(text, timestamptz, timestamptz) from public;
grant execute on function public.pos_end_of_day(text, timestamptz, timestamptz) to anon, authenticated;
