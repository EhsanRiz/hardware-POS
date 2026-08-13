-- Stop two people choosing the same PIN, rather than catching it later.
--
-- 0033 made a shared PIN refuse instead of silently signing the second person
-- in as the first. That was the right failure, and it happened for real within
-- hours: a new counter hand picked the owner's six digits at enrolment, and the
-- next thing anybody touched said "that PIN belongs to more than one person".
--
-- Refusing at the point of use is correct but late. By then two people have
-- working credentials that do not work, the back office is shut to whoever
-- holds the second one, and the only way out is for somebody to re-enrol —
-- which is a strange thing to discover from a screen that was only trying to
-- open a stock report.
--
-- So the collision is refused where it is created. auth_set_pin is the one and
-- only place a PIN is ever set: enrolment and reset both go through it, so
-- there is nowhere else for a duplicate to come from.
--
-- A note on what this tells the caller. Refusing says "this PIN is taken here",
-- which somebody already enrolled could use to probe which PINs are in use. To
-- reach it at all they must first hold a phone that receives the OTP for an
-- account at this shop, and the alternative — two staff sharing a credential,
-- with sales filed under whoever the planner reached first — is far worse than
-- that. Uniqueness is per shop, because two different shops sharing six digits
-- costs nothing: a PIN only ever resolves against the org its till belongs to.
create or replace function public.auth_set_pin(p_phone text, p_pin text)
returns void language plpgsql security definer
set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  if p_pin !~ '^\d{6}$' then raise exception 'PIN must be 6 digits'; end if;

  select * into v_user from public.app_users
   where phone_e164 = p_phone and status <> 'disabled';
  if not found then raise exception 'No such user'; end if;

  if exists (
    select 1 from public.app_users u
     where u.org_id = v_user.org_id
       and u.id <> v_user.id
       and u.active and u.pin_hash is not null
       and u.pin_hash = crypt(p_pin, u.pin_hash)
  ) then
    raise exception 'Somebody here already uses that PIN. Please choose another.';
  end if;

  update public.app_users
     set pin_hash = crypt(p_pin, gen_salt('bf')), status = 'active'
   where id = v_user.id;
end;
$$;

-- The messages the collision produces, made into instructions.
--
-- "That PIN belongs to more than one person" is true and leaves the reader
-- stuck. The way out is a reset, which is behind the same "Forgot your PIN?"
-- link on the sign-in screen, so the message says so.
create or replace function public.user_with_perm(
  p_register_token text, p_pin text, p_perm text
) returns public.app_users
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers; v_user public.app_users; v_matches int;
begin
  v_reg := public.register_by_token(p_register_token);

  select count(*) into v_matches from public.app_users u
   where u.org_id = v_reg.org_id and u.status = 'active' and u.active
     and u.pin_hash is not null and u.pin_hash = crypt(p_pin, u.pin_hash);
  if v_matches > 1 then
    raise exception
      'That PIN belongs to more than one person. One of you needs a different one — use "Forgot your PIN?" on the sign-in screen to set it.';
  end if;

  select * into v_user from public.app_users u
   where u.org_id = v_reg.org_id and u.status = 'active' and u.active
     and u.pin_hash is not null and u.pin_hash = crypt(p_pin, u.pin_hash);
  if v_user.id is null then raise exception 'Invalid PIN'; end if;
  if not (p_perm = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted: %', p_perm;
  end if;
  return v_user;
end;
$$;

revoke execute on function public.user_with_perm(text, text, text)
  from anon, authenticated, public;
