-- Reading a document that was filed without being read.
--
-- A scan can be filed with its pages and none of its lines: the reading
-- failed, or the person chose "File by hand", or the line was down. Until
-- now that document stayed a picture for ever — a manager who wanted its
-- lines had to scan it again. This is the other half: the till fetches the
-- filed pages, has them read (supabase/functions/read-document, as at scan
-- time), and hands the reading here, where it lands on the SAME document —
-- number, date, totals and lines — which then reads and receives like any
-- other. Only a stored document with no lines takes a reading, and only
-- once; nothing here touches stock. The kind the person chose when filing
-- stands: a reader that calls an invoice a quote must not take the receive
-- step away. Only a document filed as "other" takes the reading's kind.

create function public.pos_purchasing_read_filed_document(
  p_register_token text, p_pin text, p_document_id uuid,
  p_kind text, p_doc_number text, p_doc_date date,
  p_subtotal numeric, p_tax_total numeric, p_total numeric,
  p_lines jsonb
) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_doc public.supplier_documents; v_line jsonb; v_no int := 0; v_desc text;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  select * into v_doc from public.supplier_documents d
   where d.id = p_document_id and d.org_id = v_user.org_id;
  if v_doc.id is null then raise exception 'Document not found'; end if;
  if v_doc.status <> 'stored'
     or exists (select 1 from public.supplier_document_lines l where l.document_id = v_doc.id) then
    raise exception 'That document has already been read';
  end if;
  if p_lines is not null and jsonb_array_length(p_lines) > 500 then
    raise exception 'Too many lines for one document';
  end if;

  update public.supplier_documents
     set kind       = case when kind = 'other' and p_kind in ('quote','invoice','delivery_note','statement') then p_kind else kind end,
         doc_number = coalesce(nullif(trim(coalesce(p_doc_number, '')), ''), doc_number),
         doc_date   = coalesce(p_doc_date, doc_date),
         subtotal   = coalesce(p_subtotal, subtotal),
         tax_total  = coalesce(p_tax_total, tax_total),
         total      = coalesce(p_total, total),
         status     = 'read',
         read_at    = now()
   where id = v_doc.id;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_desc := nullif(trim(coalesce(v_line->>'description', '')), '');
    continue when v_desc is null;
    v_no := v_no + 1;
    insert into public.supplier_document_lines(document_id, line_no, supplier_code,
      description, qty, unit_price, line_total)
    values (v_doc.id, v_no,
            nullif(trim(coalesce(v_line->>'supplier_code', '')), ''),
            left(v_desc, 300),
            nullif(v_line->>'qty', '')::numeric,
            nullif(v_line->>'unit_price', '')::numeric,
            nullif(v_line->>'line_total', '')::numeric);
  end loop;
  return v_no;
end;
$$;
grant execute on function public.pos_purchasing_read_filed_document(
  text, text, uuid, text, text, date, numeric, numeric, numeric, jsonb) to anon, authenticated;
