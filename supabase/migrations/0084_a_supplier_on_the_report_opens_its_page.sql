-- 0084: a supplier on the spend report opens its page.
--
-- The report named each supplier and stopped there; a person reading a
-- figure they did not expect had to go to Suppliers and find the name again.
-- Each row now carries the supplier's id, so the row can be clicked through.
-- Grouped by id rather than name, so two suppliers who happen to share a
-- name are two rows, as they are two suppliers.
--
-- Same signature, same return type (jsonb): create or replace is safe here.
-- Only the shape inside the jsonb changes.

create or replace function public.pos_purchases_by_supplier(
  p_register_token text, p_pin text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_rows jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  if p_from is null or p_to is null then raise exception 'A date range is required'; end if;
  if p_to < p_from then raise exception 'Those dates are the wrong way round'; end if;

  select coalesce(jsonb_agg(row order by (row->>'total')::numeric desc nulls last), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'supplier_id', su.id,
        'supplier', su.name,
        'documents', count(*),
        -- A quotation is not a purchase. Only what was invoiced or delivered
        -- counts as money the shop owes or has paid.
        'received', count(*) filter (where sd.status = 'received'),
        'total', sum(sd.total) filter (where sd.kind in ('invoice', 'delivery_note')),
        'quoted', sum(sd.total) filter (where sd.kind = 'quote'),
        'last_document', max(coalesce(sd.doc_date, sd.created_at::date))
      ) as row
      from public.supplier_documents sd
      join public.suppliers su on su.id = sd.supplier_id
     where sd.org_id = v_user.org_id
       and coalesce(sd.doc_date, sd.created_at::date)
           between p_from::date and (p_to::date - 1)
     group by su.id, su.name
    ) t;
  return v_rows;
end;
$$;
