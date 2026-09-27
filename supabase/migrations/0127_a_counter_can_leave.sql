-- 0127 — a counter can leave a count.
--
-- A phone on a count stays on it until the count ends or the shop takes it
-- off (0114). Right for somebody's own phone; wrong for the shop's tablets,
-- which IE Test Shop lent to its trial count and then wanted for 5 Star's —
-- and had no way to step off without somebody at the till.
--
-- So the counter can leave, from the phone. What they sent stays, exactly as
-- when the shop takes them off; the count stops waiting for them to say they
-- are done; and the phone's token stops working, so it can join another
-- count. The phone refuses to leave while anything is still on it, as it
-- refuses "I'm done" (the server cannot see the phone).
--
-- left_at tells the till's list "left" apart from "taken off".

alter table public.count_counters
  add column if not exists left_at timestamptz;

create function public.pos_count_leave(p_token text)
returns void
language plpgsql security definer
set search_path = public, extensions as $$
declare v_c public.count_counters;
begin
  v_c := public.count_counter_for(p_token);
  update public.count_counters
     set active = false, left_at = now(), last_seen_at = now()
   where id = v_c.id;
end;
$$;
grant execute on function public.pos_count_leave(text) to anon, authenticated;


-- The till's list, with left_at. Return columns change, so the old one goes
-- first (CLAUDE.md). 0115's body otherwise.
drop function if exists public.pos_count_job_counters(text, text, uuid);

create function public.pos_count_job_counters(
  p_register_token text, p_pin text, p_job_id uuid
) returns table(id uuid, name text, active boolean, joined_at timestamptz,
                last_seen_at timestamptz, captures int, finished_at timestamptz,
                left_at timestamptz)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  return query
    select k.id, k.name, k.active, k.joined_at, k.last_seen_at,
           (select count(*)::int from public.count_captures c
             where c.counter_id = k.id and c.voided_at is null),
           k.finished_at, k.left_at
      from public.count_counters k
      join public.count_jobs j on j.id = k.job_id
     where k.job_id = p_job_id and j.org_id = v_org
     order by k.joined_at;
end;
$$;
grant execute on function public.pos_count_job_counters(text, text, uuid)
  to anon, authenticated;
