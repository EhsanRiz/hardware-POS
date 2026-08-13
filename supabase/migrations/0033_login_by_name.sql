-- Signing in as yourself, rather than as whoever owns that PIN.
--
-- pos_login found a person by PIN alone:
--
--   where u.org_id = ... and u.pin_hash = crypt(p_pin, u.pin_hash) limit 1
--
-- and nothing anywhere requires a PIN to be unique — auth_set_pin does not
-- check, and there is no constraint on pin_hash. So two people choosing the
-- same six digits is all it takes: LIMIT 1 with no ORDER BY returns whichever
-- row the planner reaches first, and the second person silently signs in AS THE
-- FIRST. Their sales are filed under somebody else's name, and if the first is
-- an owner the second quietly has the run of the place.
--
-- That last part is the reason this matters more than a tidier screen. The
-- whole argument for a PIN nobody else sets is that a cashier can never say
-- "somebody else must have used my PIN" — and that defence is only as good as
-- the assumption that PINs are unique, which nothing enforces.
--
-- So the till asks who you are first, and the PIN proves it. A shared PIN
-- becomes harmless: it no longer decides identity, it only confirms one.
--
-- Naming people on the sign-in screen does mean an attacker can pick their
-- target instead of landing on whoever owns a guessed PIN, so the lockout below
-- is part of this change rather than a later refinement.

-- Failed sign-ins, per person. Successes clear the slate; only failures are
-- kept, and only long enough to matter.
create table public.login_attempts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references public.app_users(id) on delete cascade,
  at         timestamptz not null default now()
);
create index login_attempts_user_idx on public.login_attempts (user_id, at desc);
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;

-- Who may sign in at this till.
--
-- Names and roles only. Not phone numbers, not permissions, not a hint about
-- PINs: this is the one list the app shows before anybody has proved anything,
-- so it carries the least that will do. Staff who have never set a PIN are left
-- out — offering a name that cannot yet sign in only invites the cashier to
-- stand there trying.
create function public.pos_staff_for_login(p_register_token text)
returns table(id uuid, name text, role user_role)
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select u.id, u.name, u.role
      from public.app_users u
     where u.org_id = v_reg.org_id
       and u.active and u.status = 'active' and u.pin_hash is not null
     order by u.name;
end;
$$;

-- Sign in as a named person.
--
-- VOLATILE on purpose, and 0017 is why that is worth saying out loud: this
-- function writes, so it must not be marked STABLE and then quietly fail inside
-- PostgREST's read-only transaction. Recording a failed attempt is the write,
-- and it is the point rather than a side effect.
create function public.pos_login(
  p_register_token text, p_user_id uuid, p_pin text
) returns table(id uuid, name text, role user_role, phone text, email text,
                permissions text[])
language plpgsql volatile security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers; v_user public.app_users; v_recent int;
begin
  v_reg := public.register_by_token(p_register_token);

  select * into v_user from public.app_users u
   where u.id = p_user_id and u.org_id = v_reg.org_id
     and u.active and u.status = 'active' and u.pin_hash is not null;
  -- An unknown id is treated exactly like a wrong PIN. The roster is already
  -- public to whoever holds the till, but there is no reason to confirm it here
  -- as well.
  if v_user.id is null then return; end if;

  select count(*) into v_recent from public.login_attempts la
   where la.user_id = v_user.id and la.at > now() - interval '15 minutes';
  if v_recent >= 5 then
    -- Said plainly rather than hidden behind a wrong-PIN message: the person is
    -- standing at a counter with a queue, and "wrong PIN" would have them try
    -- the same six digits again for fifteen minutes.
    raise exception 'Too many wrong PINs for %. Try again in 15 minutes.', v_user.name;
  end if;

  if v_user.pin_hash <> crypt(p_pin, v_user.pin_hash) then
    insert into public.login_attempts (org_id, user_id) values (v_user.org_id, v_user.id);
    return;
  end if;

  delete from public.login_attempts la where la.user_id = v_user.id;
  return query select v_user.id, v_user.name, v_user.role, v_user.phone_e164,
                      v_user.email, public.effective_permissions(v_user);
end;
$$;

-- The old two-argument form, kept alive for a till still running the previous
-- build, but no longer willing to guess.
--
-- A PIN that matches more than one person now signs nobody in. Refusing is the
-- right direction to fail: a cashier who cannot sign in says so immediately and
-- somebody changes a PIN, where the old behaviour filed a day's sales under the
-- wrong name and nobody noticed at all.
create or replace function public.pos_login(p_register_token text, p_pin text)
returns table(id uuid, name text, role user_role, phone text, email text,
              permissions text[])
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers; v_user public.app_users; v_matches int;
begin
  v_reg := public.register_by_token(p_register_token);

  select count(*) into v_matches from public.app_users u
   where u.org_id = v_reg.org_id and u.status = 'active' and u.active
     and u.pin_hash is not null and u.pin_hash = crypt(p_pin, u.pin_hash);
  if v_matches <> 1 then return; end if;

  select * into v_user from public.app_users u
   where u.org_id = v_reg.org_id and u.status = 'active' and u.active
     and u.pin_hash is not null and u.pin_hash = crypt(p_pin, u.pin_hash);
  return query select v_user.id, v_user.name, v_user.role, v_user.phone_e164,
                      v_user.email, public.effective_permissions(v_user);
end;
$$;

-- The same flaw, and a wider blast radius.
--
-- user_with_perm resolves a PIN the same way pos_login did, and it is what
-- stands in front of every privileged RPC in the system: staff, settings,
-- cash-up, stock adjustments, voids, discount approvals. A shared PIN there
-- does not merely mislabel a shift — it performs privileged work under the
-- wrong person's name, and the audit trail says they did it.
--
-- Unlike sign-in there is no name to pick: a manager leans over a colleague's
-- till and types a PIN, and asking them to find themselves in a list first
-- would slow down the one interaction that has a customer waiting through it.
-- So this one refuses instead. Ambiguity is rare, loud when it happens, and
-- fixed by changing a PIN.
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
      'That PIN belongs to more than one person. Change one of them before using it.';
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

grant execute on function public.pos_staff_for_login(text)        to anon, authenticated;
grant execute on function public.pos_login(text, uuid, text)      to anon, authenticated;
grant execute on function public.pos_login(text, text)            to anon, authenticated;
