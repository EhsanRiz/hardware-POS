-- Two counters the edge functions kept badly, or not at all.
--
-- 1. The enrolment code's attempt count was read into the auth function,
--    compared there, and written back as a number — so twenty guesses fired
--    together all read "attempts: 0", all passed the cap of five, and the
--    last write left it at one. A six-digit code inside its ten minutes was
--    open to a parallel run through the space. The count is now one
--    statement, here, and the function refuses on what it returns.
--    Service role only: nothing on the anon key may burn or read attempts.
--
-- 2. Reading a supplier document sends up to twelve pages to Gemini and
--    nothing counted it: a manage_purchasing PIN could run the bill up all
--    day with no record of which shop did. TillAI has a per-shop daily cap
--    counted from its own log; the document reader gets the same, from
--    this table.

create function public.auth_otp_attempt(p_otp_id uuid) returns int
language sql volatile security definer set search_path = public, extensions as $$
  update public.auth_otps set attempts = attempts + 1 where id = p_otp_id
  returning attempts;
$$;
revoke execute on function public.auth_otp_attempt(uuid) from anon, authenticated, public;

create table public.document_reads (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  pages  int not null,
  at     timestamptz not null default now()
);
create index document_reads_org_at on public.document_reads (org_id, at desc);
alter table public.document_reads enable row level security;
revoke all on public.document_reads from anon, authenticated, public;
