-- What went wrong on a till, reported by the till.
--
-- Until now nothing a till hit at the counter reached anybody: a render
-- crash showed the recovery screen and was gone with the reload, and a
-- failed promise went to a console nobody was looking at. This is the
-- small report the till now sends — kind, message, stack, where — and the
-- table it lands in. It is written through a token-only RPC, because a
-- crash needs no PIN to be worth knowing about, and read by nobody through
-- the API: the anon key can neither read a shop's errors nor its own. The
-- nightly digest (supabase/functions/error-digest) reads it with the
-- service role and tells InnovaEarth.
--
-- Two guards live in the RPC rather than the client. A till in a crash
-- loop must not fill the table, so after sixty reports in an hour from one
-- till the rest are dropped on the floor. And the sizes are capped here,
-- because the client is exactly the thing that is misbehaving.

create table public.client_errors (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id),
  register_id uuid not null references public.registers(id),
  at          timestamptz not null default now(),
  kind        text not null,
  message     text not null,
  stack       text,
  url         text,
  user_agent  text,
  app_version text
);

create index client_errors_org_at on public.client_errors (org_id, at desc);
create index client_errors_register_at on public.client_errors (register_id, at desc);

alter table public.client_errors enable row level security;

create function public.pos_report_error(
  p_register_token text,
  p_kind text,
  p_message text,
  p_stack text default null,
  p_url text default null,
  p_user_agent text default null,
  p_version text default null
) returns void
language plpgsql volatile security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers; v_n bigint;
begin
  v_reg := public.register_by_token(p_register_token);
  if coalesce(btrim(p_message), '') = '' then return; end if;
  select count(*) into v_n from public.client_errors
   where register_id = v_reg.id and at > now() - interval '1 hour';
  if v_n >= 60 then return; end if;
  insert into public.client_errors
    (org_id, register_id, kind, message, stack, url, user_agent, app_version)
  values
    (v_reg.org_id, v_reg.id,
     left(coalesce(nullif(btrim(p_kind), ''), 'error'), 40),
     left(btrim(p_message), 500),
     left(p_stack, 4000), left(p_url, 300), left(p_user_agent, 300), left(p_version, 40));
end;
$$;

grant execute on function public.pos_report_error(text, text, text, text, text, text, text)
  to anon, authenticated;

-- The digest's own memory: when it last went out, so that whoever calls the
-- function (a cron, a curious stranger with the public key) cannot make it
-- send twice in a day.
create table public.ops_digests (
  id      uuid primary key default gen_random_uuid(),
  kind    text not null,
  sent_at timestamptz not null default now(),
  detail  jsonb
);
create index ops_digests_kind_sent on public.ops_digests (kind, sent_at desc);
alter table public.ops_digests enable row level security;
