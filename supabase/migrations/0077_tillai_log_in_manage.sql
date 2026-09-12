-- TillAI's log, readable in Manage.
--
-- 0075 kept every question a shop asked TillAI, closed to the API, for the
-- server and for support. It turns out to be the best product research a
-- shop has: the questions the till cannot answer yet are the next things to
-- build, and a manager wondering what their staff ask a till deserves the
-- answer. So the log opens to whoever may see reports — the same right that
-- opens takings — through the same PIN-checked door as every report, and
-- scoped by the till's token to its own shop, as everything is.
--
-- Read-only: nothing here writes. The PIN itself was never stored (0076), so
-- there is nothing in a row a manager should not see.

create function public.pos_tillai_questions(
  p_register_token text, p_pin text, p_limit int default 200
) returns jsonb
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', q.id,
             'asked_at', q.asked_at,
             'register_name', r.name,
             'question', q.question,
             'answer', q.answer,
             'tools', to_jsonb(q.tools),
             'unlocked', q.unlocked)
           order by q.asked_at desc)
      from (select * from public.tillai_questions t
             where t.org_id = v_user.org_id
             order by t.asked_at desc
             limit greatest(1, least(coalesce(p_limit, 200), 1000))) q
      join public.registers r on r.id = q.register_id
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.pos_tillai_questions(text, text, int) to anon, authenticated;
