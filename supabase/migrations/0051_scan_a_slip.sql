-- 0051: a slip comes back to the counter.
--
-- Every tax invoice, quote and credit note now prints its number as a Code
-- 128 barcode. A customer back at the counter hands the paper over, the
-- cashier scans it into the same box that scans products, and the till opens
-- the document: an invoice for a reprint or a return, a quote to recall onto
-- the till. These two functions are what the scan asks. Register token only,
-- like the reprint list: what they return is what is already on the paper.

-- The same row the Sales screen lists, so the window that opens can reprint
-- the invoice exactly as stored — every figure a tax invoice carries.
create function public.pos_sale_by_number(p_register_token text, p_doc_number text)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_row jsonb;
begin
  v_reg := public.register_by_token(p_register_token);
  select jsonb_build_object(
      'id', w.id, 'doc_number', w.doc_number, 'created_at', w.created_at,
      'cashier_name', w.cashier_name, 'customer_name', w.customer_name,
      'customer_phone', w.customer_phone, 'customer_address', w.customer_address,
      'trade_pricing', w.trade_pricing, 'subtotal', w.subtotal, 'total', w.total,
      'tax_amount', w.tax_amount, 'discount_amount', w.discount_amount,
      'discount_reason', w.discount_reason, 'paid_cash', w.paid_cash,
      'paid_card', w.paid_card, 'status', w.status, 'payment_method', w.payment_method,
      'amount_tendered', w.amount_tendered, 'change_due', w.change_due,
      'rounding', w.rounding, 'po_number', w.po_number,
      'customer_vat_number', w.customer_vat_number,
      'approved_by_name', w.approved_by_name,
      'approved_by_code', exists (select 1 from public.approval_codes c where c.used_on_sale = w.id),
      'item_count', (select count(*) from public.sale_items si where si.sale_id = w.id))
    into v_row
    from public.sales w
   where w.org_id = v_reg.org_id
     and upper(w.doc_number) = upper(trim(coalesce(p_doc_number, '')))
   limit 1;
  return v_row;
end;
$$;
grant execute on function public.pos_sale_by_number(text, text) to anon, authenticated;

create function public.pos_quote_by_number(p_register_token text, p_doc_number text)
returns table(id uuid, doc_number text, created_at timestamptz,
              cashier_name text, customer_id uuid, customer_name text,
              total numeric, valid_until date, expired boolean,
              item_count int, note text, status text)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select q.id, q.doc_number, q.created_at, q.cashier_name, q.customer_id,
           q.customer_name, q.total, q.valid_until, q.valid_until < current_date,
           (select count(*)::int from public.quote_items i where i.quote_id = q.id),
           q.note, q.status::text
      from public.quotes q
     where q.org_id = v_reg.org_id
       and upper(q.doc_number) = upper(trim(coalesce(p_doc_number, '')))
     limit 1;
end;
$$;
grant execute on function public.pos_quote_by_number(text, text) to anon, authenticated;
