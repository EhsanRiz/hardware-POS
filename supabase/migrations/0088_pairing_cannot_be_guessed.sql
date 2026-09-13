-- Pairing a till cannot be guessed, and the login that skipped the lockout
-- is gone.
--
-- pos_pair_register is the one entry point that takes no register token —
-- it is what mints one — so it is callable by anybody holding the anon key,
-- which ships in the app. It compared a six-digit PIN with no throttle, and
-- told the caller which of three things was wrong. With an owner's mobile
-- number off an invoice, a script could try a million PINs and walk away
-- with a permanent till token for that shop; along the way it learned which
-- numbers belong to real staff. The README's accepted tradeoff was about
-- pos_login, which at least needs a token first; this was worse, and
-- unlisted.
--
-- Now: the failures land in the same login_attempts table pos_login uses,
-- so five wrong PINs in fifteen minutes lock pairing for that person (and
-- their till sign-in, which is right: it is the same PIN); an unknown
-- number, a wrong PIN and a locked account all come back as NO ROW, which
-- the app turns into one sentence, so a probe learns nothing from the
-- reply. A failed attempt has to be recorded and then refused, and a raised
-- exception would roll the record back — which is why refusal is an empty
-- result rather than an error, exactly as in pos_login. Only a CORRECT PIN
-- without the right to pair is told so: that caller has proved the PIN and
-- is staff. Somebody signed out (active = false) can no longer pair, which
-- every other credential path already refused.
--
-- The two-argument pos_login(token, pin) is dropped. It was kept in 0033
-- for a till still on the previous build; every till has updated since,
-- and it had neither the lockout nor the rule that only a phone's owner
-- signs in on it — so it was the way around both.

create or replace function public.pos_pair_register(p_phone text, p_pin text, p_name text)
returns table(register_id uuid, token text)
language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_token text; v_id uuid; v_recent int;
begin
  select u.* into v_user from public.app_users u
   where u.active and u.status = 'active' and u.pin_hash is not null
     and u.phone_e164 in (
       btrim(p_phone),
       public.normalize_phone(p_phone, '+27'),
       public.normalize_phone(p_phone, '+266'))
   limit 1;
  if v_user.id is null then return; end if;

  select count(*) into v_recent from public.login_attempts la
   where la.user_id = v_user.id and la.at > now() - interval '15 minutes';
  if v_recent >= 5 then return; end if;

  if v_user.pin_hash <> crypt(coalesce(p_pin, ''), v_user.pin_hash) then
    insert into public.login_attempts (org_id, user_id) values (v_user.org_id, v_user.id);
    return;
  end if;

  if not ('manage_settings' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted: manage_settings';
  end if;

  delete from public.login_attempts la where la.user_id = v_user.id;
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.registers(org_id, name, token_hash)
  values (v_user.org_id, coalesce(nullif(trim(p_name), ''), 'Till'),
          encode(digest(v_token, 'sha256'), 'hex'))
  returning id into v_id;
  return query select v_id, v_token;
end;
$$;

drop function if exists public.pos_login(text, text);
