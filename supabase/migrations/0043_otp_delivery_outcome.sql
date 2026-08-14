-- Whether a code actually went out, and a way for the shop to find out.
--
-- The auth edge function handed each code to BulkSMS and threw the answer away.
-- A missing secret logged a line and carried on; a 401 from an expired SMS
-- account logged a line and carried on; a network error threw out of the
-- sender entirely. All three produced the same reply the happy path produces —
-- "If that number is registered, a code has been sent" — because that reply is
-- deliberately uniform, and must stay uniform, or the endpoint becomes a
-- directory of who works where.
--
-- Uniform to the caller is right. Uniform to *everyone* was not: nobody in the
-- shop could tell "the code has not arrived yet" from "no code will ever
-- arrive", and the only trace was an edge-function log that a manager behind a
-- counter has no way to read. So the outcome is recorded against the attempt,
-- and the back office is given it — the news travels to the people entitled to
-- it instead of to the person asking whether a number is registered.

alter table public.auth_otps
  add column sent_at    timestamptz,           -- the provider took it
  add column send_error text;                  -- or why it would not

comment on column public.auth_otps.send_error is
  'Short, safe reason the message did not go. Provider detail stays in the '
  'function log; this is shown to a manager in the back office.';

-- The roster says who cannot be reached, and why.
--
-- Carried on the staff list rather than exposed as its own screen: the question
-- "why has this person still not enrolled?" is asked while looking at that
-- person, and an answer anywhere else is an answer nobody finds. It reads the
-- most recent attempt for the number, so a code that later goes through clears
-- a failure rather than leaving it to nag for ever.
drop function if exists public.pos_admin_list_users(text, text);
create function public.pos_admin_list_users(
  p_register_token text,
  p_pin text
) returns table(id uuid, name text, phone text, role user_role, status text,
                active boolean, permissions text[],
                discount_limit_percent numeric, discount_limit_amount numeric,
                last_code_error text)
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_admin public.app_users;
begin
  v_admin := public.user_with_perm(p_register_token, p_pin, 'manage_staff');
  return query
    select u.id, u.name, u.phone_e164, u.role, u.status, u.active, u.permissions,
           u.discount_limit_percent, u.discount_limit_amount,
           last_code.send_error
    from public.app_users u
    left join lateral (
      select o.send_error
        from public.auth_otps o
       where o.phone_e164 = u.phone_e164
       order by o.created_at desc
       limit 1
    ) last_code on true
    where u.org_id = v_admin.org_id
    order by u.role, u.name;
end;
$$;
grant execute on function public.pos_admin_list_users(text, text)
  to anon, authenticated;
