-- 0070 — a loss nobody can value is not a loss of nothing.
--
-- 0068 had two states: the cost was on the movement, or it was taken from the
-- product today and flagged as an estimate. A real till has a third. A product
-- with no cost recorded ANYWHERE came out as "R 0.00, estimated", which reads
-- as "worth nothing" rather than "we do not know" — and quietly understates
-- the total, which is the one direction an owner must not be misled in.
--
-- The stock value report has said this properly since 0063: it counts the
-- lines it cannot value and says so rather than folding them into a figure.
-- This does the same.

create or replace function public.pos_shrinkage(
  p_register_token text, p_pin text, p_from date, p_to date
) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_rows jsonb; v_totals jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  if p_from > p_to then
    raise exception 'A report cannot end before it starts';
  end if;

  with m as (
    select coalesce(c.name, '—') as department,
           pr.name as item, pr.sku, m.reason::text as reason,
           m.qty_delta,
           coalesce(m.unit_cost, pr.cost) as unit_cost,
           -- Three states, not two: what it cost on the day, what it costs
           -- today, and no idea.
           (m.unit_cost is null and pr.cost is not null) as estimated,
           coalesce(m.unit_cost, pr.cost) is null as uncosted
      from public.stock_movements m
      join public.products pr on pr.id = m.product_id
      left join public.categories c on c.id = pr.category_id
     where m.org_id = v_user.org_id
       and m.reason in ('stocktake', 'adjustment')
       and m.qty_delta < 0
       and m.created_at >= p_from
       and m.created_at < (p_to + 1)
  ),
  g as (
    select department, item, sku, reason,
           -sum(qty_delta) as qty,
           round(sum(-qty_delta * coalesce(unit_cost, 0)), 2) as at_cost,
           bool_or(estimated) as estimated,
           bool_or(uncosted) as uncosted
      from m
     group by department, item, sku, reason
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'department', department, 'item', item, 'sku', sku,
           'reason', reason, 'qty', qty, 'at_cost', at_cost,
           'estimated', estimated, 'uncosted', uncosted) order by at_cost desc),
         '[]'::jsonb),
         jsonb_build_object(
           'at_cost', coalesce(round(sum(at_cost), 2), 0),
           'counted_short', coalesce(round(sum(
             case when reason = 'stocktake' then at_cost else 0 end), 2), 0),
           'written_off', coalesce(round(sum(
             case when reason = 'adjustment' then at_cost else 0 end), 2), 0),
           'lines', count(*),
           'any_estimated', coalesce(bool_or(estimated), false),
           -- Counted, not valued. Folding them in at zero would make the
           -- total look better than the shop's actual position.
           'uncosted_lines', count(*) filter (where uncosted),
           'uncosted_units', coalesce(sum(qty) filter (where uncosted), 0))
    into v_rows, v_totals
    from g;

  return jsonb_build_object('rows', v_rows, 'totals', v_totals,
                            'from', p_from, 'to', p_to);
end;
$$;

grant execute on function public.pos_shrinkage(text, text, date, date)
  to anon, authenticated;
