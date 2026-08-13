-- Editing and removing staff.
--
-- 0015 gave the back office a way to invite people and a way to list them, and
-- stopped there. So a shop could add a till operator but never rename one after
-- a marriage, never take Sales off somebody moved to the yard, and never shut
-- out a person who had walked off — the only lever was inviting a replacement.
-- These are the other three.
--
-- Everything here re-checks manage_staff server-side and stays inside the
-- caller's org: the PIN names the manager, the register token names the shop,
-- and a manager of one shop must never see, let alone edit, another's staff.

-- Update a staff member: name, role, explicit grants, and whether they may
-- still sign in.
--
-- The guards are about not locking the shop out of itself, which is the way
-- this goes wrong in practice:
--   * you cannot disable or demote yourself — the manager holding the PIN is
--     the one person who cannot afford to be shut out mid-shift;
--   * only an admin may create, edit or unmake an admin, so a manager cannot
--     promote themselves by editing the owner;
--   * the last active admin cannot be disabled or demoted, or the shop's
--     settings and staff become unreachable by anyone.
create function public.pos_admin_update_user(
  p_register_token text,
  p_pin text,
  p_user_id uuid,
  p_name text default null,
  p_role user_role default null,
  p_permissions text[] default null,
  p_active boolean default null
) returns table(id uuid, name text, phone text, role user_role, status text,
                active boolean, permissions text[])
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_admin public.app_users; v_target public.app_users; v_admins int;
begin
  v_admin := public.user_with_perm(p_register_token, p_pin, 'manage_staff');

  select * into v_target from public.app_users u
   where u.id = p_user_id and u.org_id = v_admin.org_id;
  if v_target.id is null then raise exception 'No such staff member'; end if;

  if v_target.id = v_admin.id
     and (p_active is false or (p_role is not null and p_role <> v_target.role)) then
    raise exception 'You cannot change your own role or sign yourself out';
  end if;

  if (v_target.role = 'admin' or p_role = 'admin') and v_admin.role <> 'admin' then
    raise exception 'Only an admin can change an admin';
  end if;

  if v_target.role = 'admin'
     and (p_active is false or (p_role is not null and p_role <> 'admin')) then
    select count(*) into v_admins from public.app_users u
     where u.org_id = v_admin.org_id and u.role = 'admin' and u.active;
    if v_admins <= 1 then
      raise exception 'This is the only admin left — promote someone else first';
    end if;
  end if;

  if p_name is not null and trim(p_name) = '' then
    raise exception 'A name is required';
  end if;

  update public.app_users u set
    name        = coalesce(nullif(trim(p_name), ''), u.name),
    role        = coalesce(p_role, u.role),
    permissions = coalesce(p_permissions, u.permissions),
    active      = coalesce(p_active, u.active),
    -- A disabled user keeps their PIN but cannot sign in; re-enabling one who
    -- never set a PIN puts them back where the invite left them.
    status      = case
                    when p_active is false then 'disabled'
                    when p_active and u.pin_hash is null then 'invited'
                    when p_active then 'active'
                    else u.status
                  end
   where u.id = p_user_id
   returning * into v_target;

  return query select v_target.id, v_target.name, v_target.phone_e164,
                      v_target.role, v_target.status, v_target.active,
                      v_target.permissions;
end;
$$;

-- Remove a staff member.
--
-- Same rule the catalogue already follows: anybody whose name is on an invoice
-- is disabled rather than deleted, because a sale that cannot say who rang it
-- up is a worse record than a staff list with a leaver on it. Only someone who
-- never traded is actually removed. The outcome says which happened, so the
-- back office can tell the manager rather than quietly doing the other thing.
create function public.pos_admin_delete_user(
  p_register_token text,
  p_pin text,
  p_user_id uuid
) returns text
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_admin public.app_users; v_target public.app_users; v_admins int; v_sold boolean;
begin
  v_admin := public.user_with_perm(p_register_token, p_pin, 'manage_staff');

  select * into v_target from public.app_users u
   where u.id = p_user_id and u.org_id = v_admin.org_id;
  if v_target.id is null then raise exception 'No such staff member'; end if;
  if v_target.id = v_admin.id then
    raise exception 'You cannot remove yourself';
  end if;
  if v_target.role = 'admin' and v_admin.role <> 'admin' then
    raise exception 'Only an admin can remove an admin';
  end if;
  if v_target.role = 'admin' then
    select count(*) into v_admins from public.app_users u
     where u.org_id = v_admin.org_id and u.role = 'admin' and u.active;
    if v_admins <= 1 then
      raise exception 'This is the only admin left — promote someone else first';
    end if;
  end if;

  select exists (select 1 from public.sales s where s.cashier_id = p_user_id)
    into v_sold;

  if v_sold then
    update public.app_users u
       set active = false, status = 'disabled'
     where u.id = p_user_id;
    return 'disabled';
  end if;

  delete from public.app_users u where u.id = p_user_id;
  return 'deleted';
end;
$$;

grant execute on function public.pos_admin_update_user(text, text, uuid, text, user_role, text[], boolean)
  to anon, authenticated;
grant execute on function public.pos_admin_delete_user(text, text, uuid)
  to anon, authenticated;
