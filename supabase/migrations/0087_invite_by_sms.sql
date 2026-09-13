-- The invitation goes by SMS, and the shop can see whether it went.
--
-- Adding somebody used to send them nothing, and the staff screen said so
-- and showed the manager a message to pass on by hand. In the shop that
-- meant the manager reading a web address off the till to a colleague, or
-- typing it into their own phone to forward, every time somebody joined.
-- The shop asked for the message to go to the colleague's phone directly.
--
-- Sending happens in the auth edge function, which is where the BulkSMS
-- secret already lives (it sends the enrolment codes). Nothing here sends.
-- These two RPCs are the function's permission to send and its record of
-- what happened, and both are gated on the manager's register token and PIN
-- exactly as every other staff RPC is — so the function is a relay only for
-- somebody who could already add staff, never for a caller with the anon key.
--
-- The message is the enrolment instructions, addressed to the number the
-- person was added with. It carries no code and no PIN; the code they type is
-- still the one they ask for themselves on the enrolment page, and the PIN is
-- still their own. Only the delivery of the instructions changed.

alter table public.app_users
  add column invite_tried_at   timestamptz,             -- the last attempt, sent or not
  add column invite_sent_at    timestamptz,             -- the provider took it
  add column invite_send_error text,                    -- or why it would not
  add column invite_sms_count  int not null default 0;  -- messages that went

comment on column public.app_users.invite_send_error is
  'Short, safe reason the invitation SMS did not go, for the staff screen. '
  'Provider detail stays in the auth function log.';

-- Whether an invitation may go to this person now, and to which number.
--
-- Refuses rather than returns nothing, so the manager reads the reason on
-- the dialog: the person can already sign in, or was signed out, or has had
-- the message five times already (SMSes cost money, and after five the
-- manager passes it on by hand), or had one less than a minute ago.
--
-- The minute counts every attempt, sent or not, and is claimed here before
-- the number is handed over: a provider that is down must not turn "try
-- again" into a loop against it. The cap of five counts only what went,
-- because a message that never went cost nothing.
create function public.pos_admin_invite_to_send(
  p_register_token text,
  p_pin text,
  p_user_id uuid
) returns table(id uuid, name text, phone text)
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_admin public.app_users; v_target public.app_users;
begin
  v_admin := public.user_with_perm(p_register_token, p_pin, 'manage_staff');

  select * into v_target from public.app_users u
   where u.id = p_user_id and u.org_id = v_admin.org_id;
  if v_target.id is null then raise exception 'No such staff member'; end if;
  if not v_target.active then
    raise exception '% has been signed out', v_target.name;
  end if;
  if v_target.status <> 'invited' then
    raise exception '% can already sign in', v_target.name;
  end if;
  if v_target.invite_sms_count >= 5 then
    raise exception '% has been sent the invitation five times already. Pass the message on yourself.',
      v_target.name;
  end if;
  if v_target.invite_tried_at > now() - interval '60 seconds' then
    raise exception 'An invitation went to % less than a minute ago', v_target.name;
  end if;

  update public.app_users u set invite_tried_at = now() where u.id = v_target.id;
  return query select v_target.id, v_target.name, v_target.phone_e164;
end;
$$;
grant execute on function public.pos_admin_invite_to_send(text, text, uuid)
  to anon, authenticated;

-- What the provider said, written where the staff screen reads it.
--
-- Null error means it went: the timestamp is set, the count goes up and any
-- earlier failure is cleared. An error means it did not, and says why; the
-- count is untouched because a message that never went cost nothing and must
-- not use up one of the five.
create function public.pos_admin_invite_sms_outcome(
  p_register_token text,
  p_pin text,
  p_user_id uuid,
  p_error text
) returns void
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_admin public.app_users; v_n int;
begin
  v_admin := public.user_with_perm(p_register_token, p_pin, 'manage_staff');
  if p_error is null then
    update public.app_users u
       set invite_sent_at = now(), invite_send_error = null,
           invite_sms_count = u.invite_sms_count + 1
     where u.id = p_user_id and u.org_id = v_admin.org_id;
  else
    update public.app_users u
       set invite_send_error = left(p_error, 120)
     where u.id = p_user_id and u.org_id = v_admin.org_id;
  end if;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'No such staff member'; end if;
end;
$$;
grant execute on function public.pos_admin_invite_sms_outcome(text, text, uuid, text)
  to anon, authenticated;

-- The roster carries the outcome, next to the code outcome it already
-- carries (0043). Return columns change, so drop and recreate.
drop function if exists public.pos_admin_list_users(text, text);
create function public.pos_admin_list_users(
  p_register_token text,
  p_pin text
) returns table(id uuid, name text, phone text, role user_role, status text,
                active boolean, permissions text[],
                discount_limit_percent numeric, discount_limit_amount numeric,
                last_code_error text,
                invite_sent_at timestamptz, invite_send_error text)
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_admin public.app_users;
begin
  v_admin := public.user_with_perm(p_register_token, p_pin, 'manage_staff');
  return query
    select u.id, u.name, u.phone_e164, u.role, u.status, u.active, u.permissions,
           u.discount_limit_percent, u.discount_limit_amount,
           last_code.send_error,
           u.invite_sent_at, u.invite_send_error
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
