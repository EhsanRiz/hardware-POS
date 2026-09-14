-- The bell, when the app is shut.
--
-- 0100 answers "what needs somebody" while somebody is looking at the app.
-- The whole point of a manager's phone, though, is that it is in a pocket:
-- a customer standing at the counter waiting for a discount to be approved is
-- not helped by a notice nobody opens the app to see.
--
-- So this is the subscription list, and the two facts a push is worth sending
-- for. Deliberately two, out of the eight the bell shows:
--
--   a sale parked for a manager   somebody is standing at a counter, now
--   a load that should have gone  a customer is waiting at a house, today
--
-- Everything else is work that can wait for the next time the app is opened,
-- and a phone that buzzes at nine at night to say four items are below their
-- reorder level is a phone whose owner turns notifications off — taking the
-- first two with them.
--
-- What is NOT here: any of the shop's figures. A push carries a count and a
-- line of English, no money, no customer, no invoice. It travels through
-- Google's and Apple's push services, and while the payload is encrypted end
-- to end (RFC 8291) the shop's takings have no business being in it at all.

create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  -- Whose phone. Permissions are read from this person at send time, so a
  -- counter hand who is later given approve_discount starts being told.
  user_id       uuid not null references public.app_users(id) on delete cascade,
  register_id   uuid references public.registers(id) on delete cascade,
  -- The push service's own URL for this device. Unique: a browser hands out
  -- one per subscription, and re-subscribing must replace rather than double.
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  created_at    timestamptz not null default now(),
  -- What was last sent, so the same news does not arrive twice a minute.
  last_sent     text,
  last_sent_at  timestamptz,
  -- A push service that says the subscription is dead gets it removed; this
  -- counts the softer failures on the way there.
  failures      int not null default 0
);

create index if not exists push_subscriptions_org_idx
  on public.push_subscriptions (org_id);

alter table public.push_subscriptions enable row level security;
-- No policy: nothing reaches this table except through the functions below
-- (security definer) and the sender, which holds the service role.

/**
 * This phone would like to be told.
 *
 * Personal devices only. A till is a shared machine on a counter that
 * somebody is already standing at; there is nobody to notify, and a
 * notification on a screen the customer can read is a worse idea still.
 */
create function public.pos_push_subscribe(
  p_register_token text, p_endpoint text, p_p256dh text, p_auth text
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_reg public.registers; v_user public.app_users;
begin
  v_reg := public.register_by_token(p_register_token);
  if v_reg.kind is distinct from 'personal' or v_reg.assigned_to is null then
    raise exception 'Only a personal device can be notified';
  end if;
  select * into v_user from public.app_users
   where id = v_reg.assigned_to and active and status = 'active';
  if not found then raise exception 'That person is no longer on the staff'; end if;

  if coalesce(trim(p_endpoint), '') = '' or coalesce(trim(p_p256dh), '') = ''
     or coalesce(trim(p_auth), '') = '' then
    raise exception 'That is not a subscription';
  end if;

  insert into public.push_subscriptions
    (org_id, user_id, register_id, endpoint, p256dh, auth)
  values (v_reg.org_id, v_user.id, v_reg.id, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set org_id = excluded.org_id,
        user_id = excluded.user_id,
        register_id = excluded.register_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        failures = 0,
        -- A device coming back is entitled to hear the current news once.
        last_sent = null;
end;
$$;

/** Turned off, or the browser replaced the subscription. */
create function public.pos_push_forget(
  p_register_token text, p_endpoint text
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  delete from public.push_subscriptions s
   where s.endpoint = p_endpoint and s.org_id = v_reg.org_id;
end;
$$;

grant execute on function public.pos_push_subscribe(text, text, text, text)
  to anon, authenticated;
grant execute on function public.pos_push_forget(text, text) to anon, authenticated;

/**
 * Every phone that is waiting to hear, and what there is to tell it.
 *
 * One row per subscription, with the two urgent counts computed for THAT
 * person's permissions — a counter hand with no approval right is told about
 * loads and never about approvals. last_sent travels back so the sender can
 * hold its tongue when nothing has changed.
 *
 * The sender holds the service role; nobody else may execute this, because
 * it returns the endpoints and keys of every phone in the shop.
 */
create function public.push_due(p_today date default null)
returns table(
  id uuid, endpoint text, p256dh text, auth text,
  approvals int, deliveries_late int, last_sent text)
language sql stable security definer set search_path = public, extensions as $$
  select s.id, s.endpoint, s.p256dh, s.auth,
         case when 'approve_discount' = any(public.effective_permissions(u))
              then (select count(*)::int from public.sales x
                     where x.org_id = s.org_id and x.status = 'pending_approval')
              else 0 end,
         (select count(*)::int from public.deliveries d
           where d.org_id = s.org_id and d.status = 'pending'
             and d.deliver_on < coalesce(p_today, current_date)),
         s.last_sent
    from public.push_subscriptions s
    join public.app_users u on u.id = s.user_id
   where u.active and u.status = 'active';
$$;

/**
 * Sent, refused, or gone. All three are the sender's to record.
 *
 * "Gone" is the push service saying the browser threw this subscription away
 * (404 or 410), which is final and means the row should go with it. A refusal
 * that is not final gets three chances first: a push service having a bad
 * minute must not cost somebody their notifications.
 */
create function public.push_sent(
  p_id uuid, p_signature text,
  p_failed boolean default false, p_gone boolean default false
) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_gone then
    delete from public.push_subscriptions where id = p_id;
  elsif p_failed then
    update public.push_subscriptions
       set failures = failures + 1
     where id = p_id;
    delete from public.push_subscriptions where id = p_id and failures >= 3;
  else
    update public.push_subscriptions
       set last_sent = p_signature, last_sent_at = now(), failures = 0
     where id = p_id;
  end if;
end;
$$;

revoke execute on function public.push_due(date) from public, anon, authenticated;
revoke execute on function public.push_sent(uuid, text, boolean, boolean)
  from public, anon, authenticated;
