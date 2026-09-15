-- Whose shop the buzz is about.
--
-- 0101 deliberately kept the shop's name out of a push, reasoning that a lock
-- screen is readable over a shoulder. That reasoning was right about the
-- takings and wrong about the name: the name is painted over the door. What
-- it actually cost was the one thing a person needs when a phone goes off in
-- their pocket — WHICH shop — and anybody helping at more than one had no way
-- to tell.
--
-- Changing what a function returns needs the old one dropped first, same as
-- adding an argument (CLAUDE.md), and push_due is a table function.

drop function if exists public.push_due(date);

create function public.push_due(p_today date default null)
returns table(
  id uuid, endpoint text, p256dh text, auth text, shop text,
  approvals int, deliveries_late int, last_sent text)
language sql stable security definer set search_path = public, extensions as $$
  select s.id, s.endpoint, s.p256dh, s.auth, o.name,
         case when 'approve_discount' = any(public.effective_permissions(u))
              then (select count(*)::int from public.sales x
                     where x.org_id = s.org_id and x.status = 'pending_approval')
              else 0 end,
         (select count(*)::int from public.deliveries d
           where d.org_id = s.org_id and d.status = 'pending'
             and d.deliver_on < coalesce(p_today, current_date)),
         s.last_sent
    from public.push_subscriptions s
    join public.app_users u on u.id = s.user_id
    join public.organizations o on o.id = s.org_id
   where u.active and u.status = 'active';
$$;

revoke execute on function public.push_due(date) from public, anon, authenticated;
