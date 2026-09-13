-- A slip from a sale taken with the line down comes back to the counter.
--
-- The invoice number is issued here, at insert, so two tills never issue the
-- same one — which means a sale taken offline has none until it syncs, and
-- its slip carried "pending sync" and no barcode. Nothing to scan, nothing
-- to quote. The slip now prints a till reference: TR- and the first eight
-- hex digits of the sale's client_ref (receipt.ts, tillRef), as text and as
-- Code 128. Scanned back, this finds the invoice by that prefix, once the
-- sale is in. Same arguments and return as before, so create or replace.

create or replace function public.pos_sale_by_number(p_register_token text, p_doc_number text)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_row jsonb; v_want text; v_ref text;
begin
  v_reg := public.register_by_token(p_register_token);
  v_want := upper(trim(coalesce(p_doc_number, '')));
  if v_want ~ '^TR-?[0-9A-F]{8}$' then v_ref := right(v_want, 8); end if;
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
     and case when v_ref is null
              then upper(w.doc_number) = v_want
              else w.client_ref is not null
                   and upper(left(replace(w.client_ref::text, '-', ''), 8)) = v_ref
         end
   order by w.created_at desc
   limit 1;
  return v_row;
end;
$$;
