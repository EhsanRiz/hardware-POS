-- The last two pre-tenant RPCs: listing and revoking tills.
--
-- 0012 dropped the global user_with_perm(pin) helper these still called, so
-- both have been broken since — and worse, pos_list_registers had no org
-- filter, so fixing only the helper call would have shown every shop's tills
-- to every manager. Re-signed to the standard (token, pin) pair: the token
-- names the org, the PIN names the manager within it, and both queries stay
-- inside that org.

drop function if exists public.pos_list_registers(text);
drop function if exists public.pos_revoke_register(text, uuid);

create function public.pos_list_registers(p_register_token text, p_pin text)
returns table(id uuid, name text, active boolean, last_seen_at timestamptz,
              created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_settings');
  return query select r.id, r.name, r.active, r.last_seen_at, r.created_at
               from public.registers r
               where r.org_id = v_user.org_id
               order by r.created_at;
end;
$$;

create function public.pos_revoke_register(
  p_register_token text, p_pin text, p_register_id uuid
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_settings');
  update public.registers set active = false
   where id = p_register_id and org_id = v_user.org_id;
end;
$$;

grant execute on function public.pos_list_registers(text, text) to anon, authenticated;
grant execute on function public.pos_revoke_register(text, text, uuid) to anon, authenticated;
