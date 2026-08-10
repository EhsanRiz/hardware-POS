-- Staff contact details (phone/email), self-service profile, login carries contact.

alter table public.app_users add column if not exists phone text;
alter table public.app_users add column if not exists email text;

drop function if exists public.pos_manager_list_users(text);
create function public.pos_manager_list_users(p_manager_pin text)
returns table(id uuid, name text, role user_role, active boolean,
              phone text, email text, created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare v_mgr public.app_users;
begin
  select * into v_mgr from public.app_users u
    where u.role='manager' and u.active and u.pin_hash = crypt(p_manager_pin, u.pin_hash) limit 1;
  if not found then raise exception 'Invalid manager PIN'; end if;
  return query select u.id, u.name, u.role, u.active, u.phone, u.email, u.created_at
    from public.app_users u order by u.role, u.name;
end;
$$;

drop function if exists public.pos_manager_upsert_user(text, uuid, text, user_role, text, boolean);
create function public.pos_manager_upsert_user(
  p_manager_pin text, p_id uuid, p_name text, p_role user_role,
  p_pin text, p_active boolean, p_phone text, p_email text
) returns table(id uuid, name text, role user_role, active boolean, phone text, email text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_mgr public.app_users; v_id uuid;
begin
  select * into v_mgr from public.app_users u
    where u.role='manager' and u.active and u.pin_hash = crypt(p_manager_pin, u.pin_hash) limit 1;
  if not found then raise exception 'Invalid manager PIN'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'Name is required'; end if;

  if p_pin is not null and p_pin <> '' then
    if length(p_pin) < 4 then raise exception 'PIN must be at least 4 digits'; end if;
    if exists (select 1 from public.app_users u
               where (p_id is null or u.id <> p_id) and u.active
                 and u.pin_hash = crypt(p_pin, u.pin_hash)) then
      raise exception 'That PIN is already in use';
    end if;
  end if;

  if p_id is null then
    if p_pin is null or p_pin = '' then raise exception 'A PIN is required for a new user'; end if;
    insert into public.app_users(name, role, pin_hash, active, phone, email)
    values (trim(p_name), p_role, crypt(p_pin, gen_salt('bf')), coalesce(p_active, true),
            nullif(trim(p_phone), ''), nullif(trim(p_email), ''))
    returning public.app_users.id into v_id;
  else
    update public.app_users set
      name = trim(p_name), role = p_role, active = coalesce(p_active, public.app_users.active),
      phone = nullif(trim(p_phone), ''), email = nullif(trim(p_email), ''),
      pin_hash = case when p_pin is not null and p_pin <> ''
                      then crypt(p_pin, gen_salt('bf')) else public.app_users.pin_hash end
    where public.app_users.id = p_id
    returning public.app_users.id into v_id;
    if v_id is null then raise exception 'User not found'; end if;
  end if;

  if not exists (select 1 from public.app_users a where a.role='manager' and a.active) then
    raise exception 'There must be at least one active manager';
  end if;

  return query select u.id, u.name, u.role, u.active, u.phone, u.email
    from public.app_users u where u.id = v_id;
end;
$$;

-- Self-service profile update, authenticated by the user's CURRENT pin.
create or replace function public.pos_update_profile(
  p_pin text, p_name text, p_phone text, p_email text, p_new_pin text
) returns table(id uuid, name text, role user_role, phone text, email text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  select * into v_user from public.app_users u
    where u.active and u.pin_hash = crypt(p_pin, u.pin_hash) limit 1;
  if not found then raise exception 'Incorrect current PIN'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'Name is required'; end if;

  if p_new_pin is not null and p_new_pin <> '' then
    if length(p_new_pin) < 4 then raise exception 'PIN must be at least 4 digits'; end if;
    if exists (select 1 from public.app_users u
               where u.id <> v_user.id and u.active
                 and u.pin_hash = crypt(p_new_pin, u.pin_hash)) then
      raise exception 'That PIN is already in use';
    end if;
  end if;

  update public.app_users set
    name = trim(p_name),
    phone = nullif(trim(p_phone), ''),
    email = nullif(trim(p_email), ''),
    pin_hash = case when p_new_pin is not null and p_new_pin <> ''
                    then crypt(p_new_pin, gen_salt('bf')) else public.app_users.pin_hash end
  where public.app_users.id = v_user.id;

  return query select u.id, u.name, u.role, u.phone, u.email
    from public.app_users u where u.id = v_user.id;
end;
$$;

-- Login now carries contact details too.
drop function if exists public.pos_login(text);
create function public.pos_login(p_pin text)
returns table(id uuid, name text, role user_role, phone text, email text)
language sql security definer set search_path = public, extensions as $$
  select u.id, u.name, u.role, u.phone, u.email
  from public.app_users u
  where u.active and u.pin_hash = crypt(p_pin, u.pin_hash)
  limit 1;
$$;

revoke all on function public.pos_login(text) from public;
revoke all on function public.pos_manager_list_users(text) from public;
revoke all on function public.pos_manager_upsert_user(text, uuid, text, user_role, text, boolean, text, text) from public;
revoke all on function public.pos_update_profile(text, text, text, text, text) from public;
grant execute on function public.pos_login(text) to anon, authenticated;
grant execute on function public.pos_manager_list_users(text) to anon, authenticated;
grant execute on function public.pos_manager_upsert_user(text, uuid, text, user_role, text, boolean, text, text) to anon, authenticated;
grant execute on function public.pos_update_profile(text, text, text, text, text) to anon, authenticated;
