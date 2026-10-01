-- 0129 — a badge instead of a PIN, at the till.
--
-- 5 Star asked for it: staff scan a card to sign in and to come back to a
-- locked till, instead of typing six digits each time.
--
-- What a badge is, and what it is not:
--
--   * A long random code, printed as a Code 128 barcode. "STAFF-" and fourteen
--     characters from a 32-letter alphabet: 70 bits. Fourteen, not more,
--     because the barcode has to fit the counter's 80mm slip printer at a
--     width a scanner reads (the whole code, twenty characters, is 255
--     modules: 510 of its 576 dots). The server keeps only the SHA-256, and
--     the code itself is shown exactly once, when it is printed. A guess is
--     hopeless, so unlike a PIN it needs no lockout.
--
--   * Something you HOLD, not something you know. A photo or a photocopy scans
--     as well as the card. So a badge opens the till and the lock screen, where
--     the worst a borrowed card does is put sales under the wrong name — and
--     never a manager's approval or the back office, which still take a PIN.
--     Those RPCs take p_pin and never see a badge, so that is enforced here by
--     construction rather than by a check somebody could forget.
--
--   * One live badge per person. Printing a new one cancels the old; a lost
--     card is a reprint, and somebody leaving is a cancel (or simply making
--     them inactive, which every function below already respects).
--
-- WITH THE LINE DOWN. Several shops, 5 Star among them, lose the internet for
-- hours. So every till holds the hashes of its shop's live badges
-- (pos_staff_badges_for_till), refreshed whenever it reaches the server, and
-- checks a scan against them offline. Shipping the hashes is safe for the same
-- reason the lockout is unnecessary: 70 random bits do not fall to guessing,
-- the way a six-digit PIN's hash does. A cancelled card keeps working on a till
-- that has not reconnected since; the till stops all offline sign-in after
-- seven days without the server, which bounds that.

create table public.staff_badges (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  app_user_id     uuid not null references public.app_users(id) on delete cascade,
  code_hash       text not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references public.app_users(id) on delete set null,
  created_by_name text,
  revoked_at      timestamptz
);
-- A hash names one badge, and a person holds at most one live one.
create unique index staff_badges_hash_idx on public.staff_badges (code_hash);
create unique index staff_badges_live_idx on public.staff_badges (app_user_id)
  where revoked_at is null;
alter table public.staff_badges enable row level security;
revoke all on public.staff_badges from anon, authenticated;


-- Print a badge for somebody. Cancels whatever badge they held before.
create function public.pos_staff_badge_issue(
  p_register_token text, p_pin text, p_app_user_id uuid
) returns table(code text, staff_name text)
language plpgsql volatile security definer
set search_path = public, extensions as $$
declare
  v_org uuid; v_by public.app_users; v_target public.app_users; v_code text;
  v_alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_bytes bytea;
  i int;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_staff');
  select * into v_by from public.app_users
   where org_id = v_org and pin_hash = crypt(p_pin, pin_hash) and active limit 1;

  select * into v_target from public.app_users
   where id = p_app_user_id and org_id = v_org and active and status = 'active';
  if not found then raise exception 'Unknown or inactive staff member'; end if;
  -- A badge stands in for typing a PIN; somebody with none has not finished
  -- joining, and the back office would still need one from them.
  if v_target.pin_hash is null then
    raise exception '% has no PIN yet, so cannot have a badge', v_target.name;
  end if;

  -- 256 is a multiple of 32, so a byte modulo the alphabet is uniform.
  v_bytes := gen_random_bytes(14);
  v_code := 'STAFF-';
  for i in 0..13 loop
    v_code := v_code || substr(v_alphabet, 1 + get_byte(v_bytes, i) % 32, 1);
  end loop;

  update public.staff_badges b set revoked_at = now()
   where b.app_user_id = v_target.id and b.revoked_at is null;
  insert into public.staff_badges
    (org_id, app_user_id, code_hash, created_by, created_by_name)
  values (v_org, v_target.id, encode(digest(v_code, 'sha256'), 'hex'),
          v_by.id, v_by.name);

  return query select v_code, v_target.name;
end;
$$;

-- Cancel somebody's badge without printing another.
create function public.pos_staff_badge_revoke(
  p_register_token text, p_pin text, p_app_user_id uuid
) returns void
language plpgsql volatile security definer
set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_staff');
  update public.staff_badges b set revoked_at = now()
   where b.app_user_id = p_app_user_id and b.org_id = v_org
     and b.revoked_at is null;
end;
$$;

-- Who holds a live badge, and since when — for the staff list.
create function public.pos_staff_badges(p_register_token text, p_pin text)
returns table(app_user_id uuid, issued_at timestamptz)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_staff');
  return query
    select b.app_user_id, b.created_at from public.staff_badges b
     where b.org_id = v_org and b.revoked_at is null;
end;
$$;

-- Sign in by badge. The same row pos_login returns, so the till cannot tell
-- the two apart once somebody is in — and the same refusals: an inactive
-- person, a person with no PIN, somebody else's phone.
create function public.pos_badge_login(p_register_token text, p_code text)
returns table(id uuid, name text, role user_role, phone text, email text,
              permissions text[], discount_limit_percent numeric,
              discount_limit_amount numeric)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_user public.app_users;
begin
  v_reg := public.register_by_token(p_register_token);

  select u.* into v_user
    from public.staff_badges b join public.app_users u on u.id = b.app_user_id
   where b.code_hash = encode(digest(upper(trim(p_code)), 'sha256'), 'hex')
     and b.revoked_at is null and b.org_id = v_reg.org_id
     and u.org_id = v_reg.org_id and u.active and u.status = 'active'
     and u.pin_hash is not null;
  if v_user.id is null then return; end if;

  if v_reg.kind = 'personal' and v_user.id <> v_reg.assigned_to then
    raise exception 'This phone is not yours to sign in on';
  end if;

  return query select v_user.id, v_user.name, v_user.role, v_user.phone_e164,
                      v_user.email, public.effective_permissions(v_user),
                      v_user.discount_limit_percent, v_user.discount_limit_amount;
end;
$$;

-- What a till needs to check a badge with the line down: the hash, and the
-- person it signs in as. Exactly the people pos_staff_for_login offers, and on
-- a personal device only its owner. Phone and email are left out — the till
-- does not need them to sign somebody in, and this list is handed over before
-- anybody has proved anything.
create function public.pos_staff_badges_for_till(p_register_token text)
returns table(code_hash text, id uuid, name text, role user_role,
              permissions text[], discount_limit_percent numeric,
              discount_limit_amount numeric)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select b.code_hash, u.id, u.name, u.role, public.effective_permissions(u),
           u.discount_limit_percent, u.discount_limit_amount
      from public.staff_badges b join public.app_users u on u.id = b.app_user_id
     where b.org_id = v_reg.org_id and b.revoked_at is null
       and u.org_id = v_reg.org_id and u.active and u.status = 'active'
       and u.pin_hash is not null
       and (v_reg.kind <> 'personal' or u.id = v_reg.assigned_to);
end;
$$;

grant execute on function public.pos_staff_badge_issue(text, text, uuid) to anon, authenticated;
grant execute on function public.pos_staff_badge_revoke(text, text, uuid) to anon, authenticated;
grant execute on function public.pos_staff_badges(text, text) to anon, authenticated;
grant execute on function public.pos_badge_login(text, text) to anon, authenticated;
grant execute on function public.pos_staff_badges_for_till(text) to anon, authenticated;


-- A manager's PIN at the discount prompt, on a till that has never seen it.
--
-- The prompt proves a manager's PIN against the till's cached copy, and that
-- copy is written only when the manager signs in on that till WITH the PIN.
-- Badges make that rarer: a manager who badges in every morning would find
-- their PIN "not recognised" at the very prompt the badge leaves to the PIN.
-- Online, this answers instead, and the till caches what it is told.
--
-- Both readings of the six digits in one call — a manager's PIN, then a code
-- a manager issued (0039) — so that a wrong entry counts once against the
-- till's limit, as it did when the code was the only thing asked about. The
-- PIN reading goes through user_with_perm like every other, which refuses a
-- PIN two people share; any refusal there reads as "not a PIN", so the only
-- word that gets out is the code reading's.
create function public.pos_discount_approver(p_register_token text, p_entered text)
returns table(kind text, id uuid, name text, role user_role, phone text,
              email text, permissions text[], discount_limit_percent numeric,
              discount_limit_amount numeric, max_amount numeric)
language plpgsql volatile security definer
set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_code public.approval_codes;
  v_recent int;
begin
  v_reg := public.register_by_token(p_register_token);

  select count(*) into v_recent from public.approval_attempts a
   where a.register_id = v_reg.id and a.at > now() - interval '15 minutes';
  if v_recent >= 10 then
    raise exception 'Too many wrong codes on this till. Try again in 15 minutes.';
  end if;

  begin
    v_user := public.user_with_perm(p_register_token, p_entered, 'approve_discount');
  exception when others then
    v_user := null;
  end;
  if v_user.id is not null then
    delete from public.approval_attempts a where a.register_id = v_reg.id;
    return query select 'pin'::text, v_user.id, v_user.name, v_user.role,
                        v_user.phone_e164, v_user.email,
                        public.effective_permissions(v_user),
                        v_user.discount_limit_percent, v_user.discount_limit_amount,
                        null::numeric;
    return;
  end if;

  select * into v_code from public.approval_codes c
   where c.org_id = v_reg.org_id and c.used_at is null and c.expires_at > now()
     and c.code_hash = crypt(coalesce(p_entered, ''), c.code_hash)
   limit 1;
  if v_code.id is null then
    insert into public.approval_attempts(register_id) values (v_reg.id);
    return;
  end if;

  delete from public.approval_attempts a where a.register_id = v_reg.id;
  return query select 'code'::text, null::uuid, v_code.issued_by_name, null::user_role,
                      null::text, null::text, null::text[], null::numeric,
                      null::numeric, v_code.max_amount;
end;
$$;
grant execute on function public.pos_discount_approver(text, text) to anon, authenticated;
