-- Reads must not write.
--
-- register_by_token resolved a till AND stamped last_seen_at on it. Six
-- read-only functions call it — pos_login, pos_catalogue, pos_categories,
-- pos_org_settings, pos_search_products and user_with_perm — and all six are
-- STABLE. PostgREST runs a STABLE function inside a READ ONLY transaction, so
-- that hidden UPDATE raised SQLSTATE 25006, which PostgREST reports as
-- HTTP 405 Method Not Allowed.
--
-- The effect in the shop: nobody could sign in and no catalogue would load,
-- with a status code that points at the HTTP method rather than the cause.
--
-- Three things hid it. The e2e suite fakes the backend, so no Postgres ran.
-- The multi-tenant boundary tests called these functions over a direct SQL
-- session, which is read-write. And when I probed the live REST endpoint, I
-- used a deliberately invalid token — so it raised "Register not paired or
-- revoked" and returned before ever reaching the UPDATE. A test that only ever
-- exercises the failure path proves nothing about the success path.
--
-- The fix is the rule in the title: resolving a token is a read, and a read
-- gets no side effects. Recording that a till is alive is a separate, explicit
-- act performed by the paths that are already writing anyway.

-- 1. The resolver becomes a pure lookup, and is marked STABLE so the planner
--    and PostgREST both know it.
create or replace function public.register_by_token(p_token text)
returns public.registers
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  select * into v_reg from public.registers
   where active and token_hash = encode(digest(p_token, 'sha256'), 'hex');
  if v_reg.id is null then raise exception 'Register not paired or revoked'; end if;
  return v_reg;
end;
$$;

-- 2. "This till is alive" becomes its own explicit, volatile statement.
create or replace function public.register_touch(p_register_id uuid)
returns void
language sql volatile security definer
set search_path = public, extensions as $$
  update public.registers set last_seen_at = now() where id = p_register_id;
$$;

revoke execute on function public.register_touch(uuid) from anon, authenticated;

-- 3. Sign-in is the one read-shaped call worth recording, so it becomes
--    VOLATILE and does the touching. Everything else that writes — taking a
--    sale — already runs read-write and is stamped below.
create or replace function public.pos_login(p_register_token text, p_pin text)
returns table(id uuid, name text, role user_role, phone text, email text,
              permissions text[])
language plpgsql volatile security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_user public.app_users;
begin
  v_reg := public.register_by_token(p_register_token);
  perform public.register_touch(v_reg.id);
  select * into v_user from public.app_users u
   where u.org_id = v_reg.org_id and u.status = 'active' and u.active
     and u.pin_hash is not null and u.pin_hash = crypt(p_pin, u.pin_hash)
   limit 1;
  if v_user.id is null then return; end if;
  return query select v_user.id, v_user.name, v_user.role, v_user.phone_e164,
                      v_user.email, public.effective_permissions(v_user);
end;
$$;

grant execute on function public.pos_login(text, text) to anon, authenticated;
