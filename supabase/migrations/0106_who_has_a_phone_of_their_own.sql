-- Who has actually got the app on a phone.
--
-- Manage → Staff lists everybody the shop has hired and says nothing about
-- whether any of them can be reached on the thing the shop bought them for.
-- An invitation is an SMS; a person who never opened it, or opened it on a
-- phone that then went flat, looks identical in that list to somebody who
-- paired on the first try. So "did Thabo ever set his up?" is a question the
-- owner answers by walking over and asking him.
--
-- It is already knowable. A phone that has been paired is a register of its
-- own — kind 'personal', assigned_to that person, active until it is
-- unpaired — so this is a lookup, not new bookkeeping. `active` is in the
-- predicate on purpose: a device that was unpaired should stop showing a
-- phone against the name, which is the whole point of unpairing it.
--
-- Changing what a function returns needs the old one dropped first, same as
-- adding an argument (CLAUDE.md), and this is a table function.

drop function if exists public.pos_admin_list_users(text, text);

create function public.pos_admin_list_users(p_register_token text, p_pin text)
returns table(
  id uuid, name text, phone text, role user_role, status text, active boolean,
  permissions text[], discount_limit_percent numeric,
  discount_limit_amount numeric, last_code_error text,
  invite_sent_at timestamp with time zone, invite_send_error text,
  has_phone boolean)
language plpgsql stable security definer
set search_path = public, extensions as $function$
declare v_admin public.app_users;
begin
  v_admin := public.user_with_perm(p_register_token, p_pin, 'manage_staff');
  return query
    select u.id, u.name, u.phone_e164, u.role, u.status, u.active, u.permissions,
           u.discount_limit_percent, u.discount_limit_amount,
           last_code.send_error,
           u.invite_sent_at, u.invite_send_error,
           exists (
             select 1 from public.registers r
              where r.assigned_to = u.id
                and r.kind = 'personal'
                and r.active
           )
      from public.app_users u
      left join lateral (
        select o.send_error
          from public.auth_otps o
         where o.phone_e164 = u.phone_e164
         order by o.created_at desc
         limit 1
      ) last_code on true
     where u.org_id = v_admin.org_id
     order by u.role, u.name;
end;
$function$;

-- A dropped function takes its grants with it, and the entry point becomes
-- unreachable from the app while every test that calls it as a superuser
-- stays green. The database suite has a guard for exactly this — "every pos_*
-- entry point is granted to anon" — and it caught this one.
grant execute on function public.pos_admin_list_users(text, text)
  to anon, authenticated;
