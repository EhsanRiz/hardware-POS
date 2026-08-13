-- Which sales were released over the phone, and by whom.
--
-- The Approvals panel already lists every code and the invoice it released, so
-- the trail existed — but only from the code's end. A manager reading the day's
-- sales could not tell a discount approved by somebody standing at the till
-- from one approved down a phone line, and those are not the same event.
--
-- The approver's name goes in at the same time. The list showed neither, so
-- "who let this through?" could only be answered by opening another screen and
-- matching invoice numbers by eye.

create or replace function public.pos_sales_history(
  p_register_token text,
  p_pin text,
  p_from timestamptz,
  p_to timestamptz,
  p_limit int default 200
) returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_user public.app_users; v_rows jsonb; v_totals jsonb;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');

  if p_from is null or p_to is null then
    raise exception 'A date range is required';
  end if;
  if p_to < p_from then
    raise exception 'Those dates are the wrong way round';
  end if;

  with win as (
    select s.*
      from public.sales s
     where s.org_id = v_user.org_id
       and s.created_at >= p_from and s.created_at < p_to
     order by s.created_at desc
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', w.id,
      'doc_number', w.doc_number,
      'created_at', w.created_at,
      'cashier_name', w.cashier_name,
      'customer_name', w.customer_name,
      'customer_phone', w.customer_phone,
      'customer_address', w.customer_address,
      'trade_pricing', w.trade_pricing,
      -- Everything buildReceiptText reads. A reprint that quietly drops the
      -- subtotal or the cash/card split is not the same document, and a tax
      -- invoice has to reprint as what was actually charged.
      'subtotal', w.subtotal,
      'total', w.total,
      'tax_amount', w.tax_amount,
      'discount_amount', w.discount_amount,
      'discount_reason', w.discount_reason,
      'paid_cash', w.paid_cash,
      'paid_card', w.paid_card,
      'status', w.status,
      'payment_method', w.payment_method,
      'amount_tendered', w.amount_tendered,
      'change_due', w.change_due,
      'rounding', w.rounding,
      'po_number', w.po_number,
      'customer_vat_number', w.customer_vat_number,
      'approved_by_name', w.approved_by_name,
      -- Approved in person, or over the phone? Both record the manager as the
      -- approver, which is right — they made the decision either way — but they
      -- are not the same event to somebody reading the day back. A code was
      -- given down a line to a cashier the manager could not see, could not
      -- watch ring it up, and could not check the basket of.
      --
      -- Derived rather than stamped on the sale: approval_codes already points
      -- at the sale it released, so a column here would be a second copy of a
      -- fact that is already recorded, and free to drift from it.
      'approved_by_code', exists (
        select 1 from public.approval_codes c where c.used_on_sale = w.id),
      'item_count', (select count(*) from public.sale_items si where si.sale_id = w.id)
    ) order by w.created_at desc), '[]'::jsonb)
    into v_rows
    from win w;

  -- Totals over the WHOLE window, not just the rows returned. A capped list
  -- whose total only adds up the rows it happened to show is a number that
  -- looks authoritative and is wrong.
  select jsonb_build_object(
    'count',    count(*) filter (where s.status = 'completed'),
    'gross',    coalesce(sum(s.total) filter (where s.status = 'completed'), 0),
    'vat',      coalesce(sum(s.tax_amount) filter (where s.status = 'completed'), 0),
    'discount', coalesce(sum(s.discount_amount) filter (where s.status = 'completed'), 0),
    'voided',   count(*) filter (where s.status = 'voided'),
    'tenders',  coalesce((
      select jsonb_object_agg(t.method, t.amount) from (
        select sp.method::text as method, sum(sp.amount) as amount
          from public.sale_payments sp
          join public.sales s2 on s2.id = sp.sale_id
         where s2.org_id = v_user.org_id and s2.status = 'completed'
           and s2.created_at >= p_from and s2.created_at < p_to
         group by 1) t), '{}'::jsonb)
  ) into v_totals
  from public.sales s
  where s.org_id = v_user.org_id
    and s.created_at >= p_from and s.created_at < p_to;

  return jsonb_build_object('rows', v_rows, 'totals', v_totals);
end;
$$;
