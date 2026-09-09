-- TillAI's log: every question a shop asked it, and what it looked at.
--
-- TillAI is the assistant in the corner of the till, answering questions
-- about the shop from the shop's own records through the token-only RPCs
-- (supabase/functions/tillai). This table is written by that function alone,
-- with the service role, and it does two jobs: it is the counter behind the
-- daily cap per shop — Gemini is cheap, not free, and a shop's line is a
-- shop's bill — and it is the shop's own record of what was asked, which is
-- worth having for the day a manager wonders what their staff ask a till.
--
-- Closed to the API: no policy, no grant. The anon key that ships in every
-- browser can neither read another shop's questions nor its own; the answer
-- was already shown on screen, and the log is for the server and for
-- InnovaEarth's support, not for a till to page through.

create table public.tillai_questions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id),
  register_id uuid not null references public.registers(id),
  asked_at    timestamptz not null default now(),
  question    text not null,
  tools       text[] not null default '{}',
  answer      text,
  model       text
);

create index tillai_questions_org_day on public.tillai_questions (org_id, asked_at desc);

alter table public.tillai_questions enable row level security;
