-- Staff invitation, the manager's half of enrolment.
--
-- The flow: an admin/manager on a paired till invites a colleague by phone
-- number; the row is created 'invited' with NO pin. The colleague then proves
-- possession of that phone via OTP (the auth edge function) and chooses their
-- own PIN. Nobody — not the manager, not InnovaEarth — ever knows anyone
-- else's PIN, which is what makes the approval audit trail worth keeping.

create or replace function public.pos_admin_invite_user(
  p_register_token text,
  p_pin text,
  p_name text,
  p_phone text,
  p_role user_role default 'employee',
  p_permissions text[] default '{}'
) returns table(id uuid, name text, phone text, role user_role, status text)
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_admin public.app_users; v_phone text; v_row public.app_users;
begin
  v_admin := public.user_with_perm(p_register_token, p_pin, 'manage_staff');
  v_phone := regexp_replace(coalesce(p_phone,''), '[\s()-]', '', 'g');
  if v_phone ~ '^0\d{9}$' then v_phone := '+27' || substr(v_phone, 2);
  elsif v_phone ~ '^[5-6]\d{7}$' then v_phone := '+266' || v_phone;
  end if;
  if v_phone !~ '^\+\d{9,15}$' then
    raise exception 'Phone must be a valid number, e.g. 082 123 4567 or +266 5800 0000';
  end if;
  if trim(coalesce(p_name,'')) = '' then raise exception 'A name is required'; end if;
  -- Globally unique: a phone belongs to exactly one org, by design.
  if exists (select 1 from public.app_users u where u.phone_e164 = v_phone) then
    raise exception 'That phone number is already registered';
  end if;
  -- Only an admin may grant admin.
  if p_role = 'admin' and v_admin.role <> 'admin' then
    raise exception 'Only an admin can create another admin';
  end if;
  insert into public.app_users (org_id, name, role, phone_e164, status, pin_hash, permissions)
  values (v_admin.org_id, trim(p_name), p_role, v_phone, 'invited', null,
          coalesce(p_permissions, '{}'))
  returning * into v_row;
  return query select v_row.id, v_row.name, v_row.phone_e164, v_row.role, v_row.status;
end;
$$;

create or replace function public.pos_admin_list_users(
  p_register_token text,
  p_pin text
) returns table(id uuid, name text, phone text, role user_role, status text, active boolean, permissions text[])
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_admin public.app_users;
begin
  v_admin := public.user_with_perm(p_register_token, p_pin, 'manage_staff');
  return query
    select u.id, u.name, u.phone_e164, u.role, u.status, u.active, u.permissions
    from public.app_users u where u.org_id = v_admin.org_id
    order by u.role, u.name;
end;
$$;
