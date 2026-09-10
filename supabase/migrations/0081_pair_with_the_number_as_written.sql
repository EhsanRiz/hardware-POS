-- Pairing takes the number the way people write it.
--
-- Enrolment and "Forgot your PIN?" accept 076 108 0024 and read it as
-- +27761080024; pairing compared what was typed to the stored +27 form
-- exactly, so the manager who had just set a PIN by SMS on that number was
-- told "Invalid phone or PIN" by the screen whose placeholder says
-- 082 123 4567. The number is now read the way the rest of the system
-- reads it: as typed if it already starts with +, otherwise as a South
-- African number, and failing that as a Lesotho one — the two countries
-- the request form offers. A number belongs to one person in the whole
-- system, so whichever reading finds someone is the person.

create or replace function public.pos_pair_register(p_phone text, p_pin text, p_name text)
returns table(register_id uuid, token text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_token text; v_id uuid; v_e164 text;
begin
  select u.* into v_user from public.app_users u
   where u.status = 'active' and u.pin_hash is not null
     and u.phone_e164 in (
       btrim(p_phone),
       public.normalize_phone(p_phone, '+27'),
       public.normalize_phone(p_phone, '+266'))
     and u.pin_hash = crypt(p_pin, u.pin_hash)
   limit 1;
  if v_user.id is null then raise exception 'Invalid phone or PIN'; end if;
  if not ('manage_settings' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted: manage_settings';
  end if;
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.registers(org_id, name, token_hash)
  values (v_user.org_id, coalesce(nullif(trim(p_name), ''), 'Till'),
          encode(digest(v_token, 'sha256'), 'hex'))
  returning id into v_id;
  return query select v_id, v_token;
end;
$$;
