-- 0074 — the phone is a personal device, and a personal device is not a till.
--
-- The counter is a 17" touch screen. A phone is for the work that happens away
-- from it: photographing a supplier's quotation, approving a discount down the
-- line, deciding what to buy. Until now every device had to pair as a register,
-- so a phone became a till — it appeared in the till list, it could take money,
-- and money taken on it belonged to a drawer that does not exist.
--
-- Four rules, all enforced here rather than by hiding buttons:
--
--   1. A personal device belongs to exactly one person, and only that person
--      can sign in on it. Otherwise a shelf hand's phone plus the owner's PIN
--      is an owner's device, off the premises, with nobody the wiser.
--   2. A personal device cannot take money. Not hidden — refused.
--   3. Removing the person, or revoking the device, ends it.
--   4. An enrolment code is single use and short lived.

alter table public.registers
  add column if not exists kind text not null default 'till',
  -- Cascade on purpose: a person deleted takes their phones with them.
  add column if not exists assigned_to uuid references public.app_users(id) on delete cascade;

alter table public.registers drop constraint if exists registers_kind_check;
alter table public.registers add constraint registers_kind_check
  check (kind in ('till', 'personal'));

-- A personal device has an owner and a till has none: the two states cannot
-- drift apart, so neither can be set without the other.
alter table public.registers drop constraint if exists registers_personal_has_owner;
alter table public.registers add constraint registers_personal_has_owner
  check ((kind = 'personal') = (assigned_to is not null));

create index if not exists registers_assigned_idx
  on public.registers (assigned_to) where assigned_to is not null;

-- --------------------------------------------------------------------------
-- RULE 2. Money is refused at the table, not at the door.
-- --------------------------------------------------------------------------
--
-- Every one of these rows already records which device it came from (0050),
-- so one trigger covers all of them and pos_create_sale — rebuilt twice
-- already, for the org and for deliveries — is not touched a third time.
--
-- The point of putting it here rather than in each RPC is that a money
-- function written NEXT YEAR is covered without anybody remembering to check.

create or replace function public.refuse_personal_device()
returns trigger language plpgsql set search_path = public, extensions as $$
declare v_kind text; v_who text;
begin
  if new.register_id is null then return new; end if;
  select r.kind, coalesce(u.name, r.name) into v_kind, v_who
    from public.registers r
    left join public.app_users u on u.id = r.assigned_to
   where r.id = new.register_id;
  if v_kind = 'personal' then
    raise exception
      'A phone is not a till: money cannot be taken on %''s personal device', v_who;
  end if;
  return new;
end;
$$;

drop trigger if exists sales_not_on_a_phone on public.sales;
create trigger sales_not_on_a_phone before insert on public.sales
  for each row execute function public.refuse_personal_device();

drop trigger if exists cash_sessions_not_on_a_phone on public.cash_sessions;
create trigger cash_sessions_not_on_a_phone before insert on public.cash_sessions
  for each row execute function public.refuse_personal_device();

drop trigger if exists customer_payments_not_on_a_phone on public.customer_payments;
create trigger customer_payments_not_on_a_phone before insert on public.customer_payments
  for each row execute function public.refuse_personal_device();

drop trigger if exists returns_not_on_a_phone on public.returns;
create trigger returns_not_on_a_phone before insert on public.returns
  for each row execute function public.refuse_personal_device();

-- --------------------------------------------------------------------------
-- RULE 4. Enrolment.
-- --------------------------------------------------------------------------

create table if not exists public.device_enrolments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  app_user_id  uuid not null references public.app_users(id) on delete cascade,
  -- sha256, as the register token is. The plaintext is shown once.
  code_hash    text not null,
  created_at   timestamptz not null default now(),
  created_by   uuid references public.app_users(id),
  created_by_name text,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  used_register_id uuid references public.registers(id) on delete set null
);
create index if not exists device_enrolments_live_idx
  on public.device_enrolments (code_hash) where used_at is null;
alter table public.device_enrolments enable row level security;

-- Wrong codes, counted. pos_enrol_device is callable by anybody with no token
-- at all — it has to be, the phone has nothing yet — so the one thing standing
-- between a stranger and a device is the code. Eight characters from an
-- unambiguous alphabet is a trillion of them; this stops the hammering.
create table if not exists public.enrolment_attempts (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now()
);
create index if not exists enrolment_attempts_at_idx on public.enrolment_attempts (at desc);
alter table public.enrolment_attempts enable row level security;

/**
 * A code to put a named person's phone on the shop.
 *
 * Read down the phone or sent by message. It is not the owner's PIN typed into
 * somebody else's handset, which is how staff learn to watch the master PIN
 * being entered.
 */
create or replace function public.pos_staff_enrolment_code(
  p_register_token text, p_pin text, p_app_user_id uuid
) returns table(code text, expires_at timestamptz, staff_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid; v_by public.app_users; v_target public.app_users;
  v_code text; v_expires timestamptz;
  -- No I, O, 0 or 1: these are read aloud and typed by somebody in a hurry.
  v_alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  i int;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_staff');
  select * into v_by from public.app_users
   where org_id = v_org and pin_hash = crypt(p_pin, pin_hash) and active limit 1;

  select * into v_target from public.app_users
   where id = p_app_user_id and org_id = v_org and active and status = 'active';
  if not found then raise exception 'Unknown or inactive staff member'; end if;
  if v_target.pin_hash is null then
    raise exception '% has no PIN yet, so cannot sign in on a phone', v_target.name;
  end if;

  v_code := '';
  for i in 1..8 loop
    v_code := v_code || substr(v_alphabet,
      1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  v_expires := now() + interval '15 minutes';

  -- One live code per person: issuing a new one kills the old, so a code read
  -- out an hour ago and forgotten cannot still enrol a device tomorrow.
  -- Qualified: `expires_at` and `code` are also OUT parameters of this
  -- function, and an unqualified reference means the parameter.
  update public.device_enrolments d set expires_at = now()
   where d.app_user_id = p_app_user_id and d.used_at is null
     and d.expires_at > now();

  insert into public.device_enrolments
    (org_id, app_user_id, code_hash, created_by, created_by_name, expires_at)
  values (v_org, p_app_user_id, encode(digest(v_code, 'sha256'), 'hex'),
          v_by.id, v_by.name, v_expires);

  return query select v_code, v_expires, v_target.name;
end;
$$;

grant execute on function public.pos_staff_enrolment_code(text, text, uuid)
  to anon, authenticated;

/**
 * Put this phone on the shop, as the person the code was issued to.
 *
 * Callable with no token, because the phone has none yet. The code is the
 * whole credential, so it is single use, short lived, and wrong guesses are
 * counted and throttled.
 */
create or replace function public.pos_enrol_device(
  p_code text, p_device_name text
) returns table(register_id uuid, token text, user_id uuid, user_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_enrol public.device_enrolments; v_user public.app_users;
  v_token text; v_id uuid; v_recent int;
begin
  select count(*) into v_recent from public.enrolment_attempts
   where at > now() - interval '15 minutes';
  if v_recent >= 20 then
    raise exception 'Too many wrong codes. Try again in 15 minutes.';
  end if;

  select * into v_enrol from public.device_enrolments
   where code_hash = encode(digest(upper(btrim(coalesce(p_code, ''))), 'sha256'), 'hex')
     and used_at is null and expires_at > now()
   limit 1;
  if not found then
    insert into public.enrolment_attempts default values;
    raise exception 'That code is not valid. Ask for a new one.';
  end if;

  select * into v_user from public.app_users
   where id = v_enrol.app_user_id and active and status = 'active';
  if not found then
    raise exception 'That person is no longer on the staff';
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.registers (org_id, name, token_hash, kind, assigned_to)
  values (v_enrol.org_id,
          coalesce(nullif(btrim(coalesce(p_device_name, '')), ''),
                   v_user.name || '''s phone'),
          encode(digest(v_token, 'sha256'), 'hex'), 'personal', v_user.id)
  returning id into v_id;

  update public.device_enrolments
     set used_at = now(), used_register_id = v_id
   where id = v_enrol.id;
  delete from public.enrolment_attempts where at < now() - interval '1 day';

  return query select v_id, v_token, v_user.id, v_user.name;
end;
$$;

grant execute on function public.pos_enrol_device(text, text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- RULE 1. Only its owner signs in on a personal device.
-- --------------------------------------------------------------------------
--
-- Both sign-in functions, because the list is what the screen offers and the
-- login is what actually lets somebody in. Hiding the name without refusing
-- the PIN would be theatre.

create or replace function public.pos_staff_for_login(p_register_token text)
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
       -- A personal device offers exactly one name: its owner's.
       and (v_reg.kind <> 'personal' or u.id = v_reg.assigned_to)
     order by u.name;
end;
$$;

create or replace function public.pos_login(
  p_register_token text, p_user_id uuid, p_pin text
) returns table(id uuid, name text, role user_role, phone text, email text,
                permissions text[], discount_limit_percent numeric,
                discount_limit_amount numeric)
language plpgsql volatile security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers; v_user public.app_users; v_recent int;
begin
  v_reg := public.register_by_token(p_register_token);

  -- A phone belongs to one person. Somebody else's PIN on it — the owner's
  -- most of all — would turn a shelf hand's handset into an owner's device,
  -- off the premises, with nobody the wiser.
  if v_reg.kind = 'personal' and p_user_id <> v_reg.assigned_to then
    raise exception 'This phone is not yours to sign in on';
  end if;

  select * into v_user from public.app_users u
   where u.id = p_user_id and u.org_id = v_reg.org_id
     and u.active and u.status = 'active' and u.pin_hash is not null;
  if v_user.id is null then return; end if;

  select count(*) into v_recent from public.login_attempts la
   where la.user_id = v_user.id and la.at > now() - interval '15 minutes';
  if v_recent >= 5 then
    raise exception 'Too many wrong PINs for %. Try again in 15 minutes.', v_user.name;
  end if;

  if v_user.pin_hash <> crypt(p_pin, v_user.pin_hash) then
    insert into public.login_attempts (org_id, user_id) values (v_user.org_id, v_user.id);
    return;
  end if;

  delete from public.login_attempts la where la.user_id = v_user.id;
  return query select v_user.id, v_user.name, v_user.role, v_user.phone_e164,
                      v_user.email, public.effective_permissions(v_user),
                      v_user.discount_limit_percent, v_user.discount_limit_amount;
end;
$$;

grant execute on function public.pos_staff_for_login(text) to anon, authenticated;
grant execute on function public.pos_login(text, uuid, text) to anon, authenticated;

/** What kind of device is this, and whose? The screen shape follows. */
create or replace function public.pos_device_info(p_register_token text)
returns table(register_id uuid, name text, kind text,
              assigned_to uuid, assigned_name text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select v_reg.id, v_reg.name, v_reg.kind, v_reg.assigned_to,
           (select u.name from public.app_users u where u.id = v_reg.assigned_to);
end;
$$;

grant execute on function public.pos_device_info(text) to anon, authenticated;
