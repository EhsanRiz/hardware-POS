-- Reprinting yesterday's cash-up lost the pay-ins and pay-outs.
--
-- pos_cash_session_current returns the open session WITH its movements, and the
-- slip builder prints them under "IN AND OUT". pos_cash_sessions — the list a
-- manager reprints a past day from — returned the figures but not the
-- movements, so a reprint came out silently missing the section.
--
-- That is the worst shape for this particular omission. The whole argument for
-- recording a payout is that a variance nobody can explain is a variance nobody
-- reads: R60 taken out for diesel is the difference between a drawer that is
-- short and a drawer that balances once you know where the money went. A
-- reprint that drops the explanation and keeps the shortfall hands somebody a
-- piece of paper accusing a cashier of being R60 down, with the answer removed.
--
-- Same shape as pos_cash_session_current, so the two agree about what a session
-- looks like and the client needs one type for both.
create or replace function public.pos_cash_sessions(
  p_register_token text, p_pin text, p_limit int default 30
) returns jsonb
language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'cash_management');
  return coalesce((
    select jsonb_agg(to_jsonb(cs)
             || jsonb_build_object(
                  'figures', public.cash_session_figures(cs),
                  'movements', coalesce((
                    select jsonb_agg(to_jsonb(m) order by m.created_at)
                      from public.cash_movements m where m.session_id = cs.id),
                    '[]'::jsonb))
           order by cs.opened_at desc)
      from (select * from public.cash_sessions c
             where c.org_id = v_user.org_id and c.closed_at is not null
             order by c.opened_at desc
             limit greatest(1, least(coalesce(p_limit, 30), 200))) cs
  ), '[]'::jsonb);
end;
$$;
