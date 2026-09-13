-- Nobody hands out a right they do not hold, and nobody edits their own.
--
-- pos_admin_update_user guards the role column three ways — not your own,
-- not an admin's unless you are one, never the last admin — and guarded
-- the permissions column not at all. Every privileged RPC gates on a
-- permission string, not on the role, and effective_permissions is the
-- union of the role's defaults and this array. So a manager given
-- manage_staff (whose whole purpose is delegating the staff screen) could
-- write array['manage_settings', 'view_cost_prices', ...] onto their own
-- row and hold everything an admin holds, manage_settings included, which
-- is the right that pairs a till. pos_admin_invite_user wrote p_permissions
-- verbatim too.
--
-- Two rules now, in both:
--   1. You cannot change your own permissions. An admin holds everything by
--      role, so for them the array is decoration; for anybody else it is
--      the escalation.
--   2. You cannot give anybody a permission you do not hold yourself. Said
--      with the permission's own description, since the screen shows those.
-- Same signatures, so create or replace keeps the grants.

create or replace function public.pos_admin_update_user(
  p_register_token text,
  p_pin text,
  p_user_id uuid,
  p_name text default null,
  p_role user_role default null,
  p_permissions text[] default null,
  p_active boolean default null,
  p_discount_limit_percent numeric default null,
  p_discount_limit_amount numeric default null
) returns table(id uuid, name text, phone text, role user_role, status text,
                active boolean, permissions text[],
                discount_limit_percent numeric, discount_limit_amount numeric)
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_admin public.app_users; v_target public.app_users; v_admins int;
        v_perm text; v_held text[];
begin
  v_admin := public.user_with_perm(p_register_token, p_pin, 'manage_staff');

  select * into v_target from public.app_users u
   where u.id = p_user_id and u.org_id = v_admin.org_id;
  if v_target.id is null then raise exception 'No such staff member'; end if;

  if v_target.id = v_admin.id
     and (p_active is false or (p_role is not null and p_role <> v_target.role)) then
    raise exception 'You cannot change your own role or sign yourself out';
  end if;

  if p_permissions is not null then
    -- The same set in any order is "unchanged": the screen sends the extras
    -- back on every save, name changes included.
    if v_target.id = v_admin.id
       and not (p_permissions <@ v_target.permissions and v_target.permissions <@ p_permissions) then
      raise exception 'You cannot change your own permissions';
    end if;
    v_held := public.effective_permissions(v_admin);
    foreach v_perm in array p_permissions loop
      if not (v_perm = any(v_held)) then
        raise exception 'You cannot give somebody "%" — you do not have it yourself',
          coalesce((select p.description from public.permissions p where p.code = v_perm), v_perm);
      end if;
    end loop;
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

  if p_discount_limit_percent is not null
     and (p_discount_limit_percent < 0 or p_discount_limit_percent > 100) then
    raise exception 'A discount limit is a percentage between 0 and 100';
  end if;
  if p_discount_limit_amount is not null and p_discount_limit_amount < 0 then
    raise exception 'A discount limit cannot be negative';
  end if;

  update public.app_users u set
    name        = coalesce(nullif(trim(p_name), ''), u.name),
    role        = coalesce(p_role, u.role),
    permissions = coalesce(p_permissions, u.permissions),
    active      = coalesce(p_active, u.active),
    discount_limit_percent = case
      when p_discount_limit_percent is null then u.discount_limit_percent
      when p_discount_limit_percent = 0 then null
      else p_discount_limit_percent end,
    discount_limit_amount = case
      when p_discount_limit_amount is null then u.discount_limit_amount
      when p_discount_limit_amount = 0 then null
      else p_discount_limit_amount end
  where u.id = p_user_id;

  return query
    select u.id, u.name, u.phone_e164, u.role, u.status, u.active, u.permissions,
           u.discount_limit_percent, u.discount_limit_amount
      from public.app_users u where u.id = p_user_id;
end;
$$;

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
        v_perm text; v_held text[];
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
  -- And nobody hands out a right they do not hold.
  v_held := public.effective_permissions(v_admin);
  foreach v_perm in array coalesce(p_permissions, '{}') loop
    if not (v_perm = any(v_held)) then
      raise exception 'You cannot give somebody "%" — you do not have it yourself',
        coalesce((select p.description from public.permissions p where p.code = v_perm), v_perm);
    end if;
  end loop;
  insert into public.app_users (org_id, name, role, phone_e164, status, pin_hash, permissions)
  values (v_admin.org_id, trim(p_name), p_role, v_phone, 'invited', null,
          coalesce(p_permissions, '{}'))
  returning * into v_row;
  return query select v_row.id, v_row.name, v_row.phone_e164, v_row.role, v_row.status;
end;
$$;
