-- 0057: the rest of the letterhead — where they are, and where the money goes.
--
-- The Jasbro quotation prints 25 Birmingham Road, Benoni South, and at the
-- foot of it FNB, account 62399227258, branch 250655. That is exactly what a
-- shop needs when it comes to pay the invoice, and exactly what somebody
-- otherwise types off a piece of paper into a form. It is read now.
--
-- The rule for an EXISTING supplier is fill the blanks, never overwrite. What
-- a person typed is a decision; what a model read off a photograph is a
-- suggestion, and a suggestion must not quietly replace a decision. So a
-- missing branch code gets filled in from the page and a different account
-- number does not — a supplier's banking changing is a phone call to make,
-- not a field to silently update from a scan.

alter table public.suppliers
  add column if not exists bank_name           text,
  add column if not exists bank_account_name   text,
  add column if not exists bank_account_number text,
  add column if not exists bank_branch_code    text;

drop function if exists public.pos_purchasing_suppliers(text, text);
create function public.pos_purchasing_suppliers(p_register_token text, p_pin text)
returns table(id uuid, code text, name text, contact_name text, phone text,
              email text, address text, vat_number text, notes text,
              bank_name text, bank_account_name text, bank_account_number text,
              bank_branch_code text, active boolean, document_count int)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  return query
    select s.id, s.code, s.name, s.contact_name, s.phone, s.email, s.address,
           s.vat_number, s.notes, s.bank_name, s.bank_account_name,
           s.bank_account_number, s.bank_branch_code, s.active,
           (select count(*)::int from public.supplier_documents d where d.supplier_id = s.id)
      from public.suppliers s
     where s.org_id = v_user.org_id and s.active
     order by s.name;
end;
$$;
grant execute on function public.pos_purchasing_suppliers(text, text) to anon, authenticated;

-- New arguments make a new signature, so the old one goes first (CLAUDE.md).
drop function if exists public.pos_purchasing_save_supplier(
  text, text, uuid, text, text, text, text, text, text);
create function public.pos_purchasing_save_supplier(
  p_register_token text, p_pin text, p_id uuid, p_name text,
  p_contact_name text default null, p_phone text default null,
  p_email text default null, p_vat_number text default null,
  p_notes text default null, p_address text default null,
  p_bank_name text default null, p_bank_account_name text default null,
  p_bank_account_number text default null, p_bank_branch_code text default null
) returns public.suppliers
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_row public.suppliers;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  if trim(coalesce(p_name, '')) = '' then raise exception 'A supplier needs a name'; end if;
  if p_id is null then
    insert into public.suppliers(org_id, name, contact_name, phone, email, address,
      vat_number, notes, bank_name, bank_account_name, bank_account_number, bank_branch_code)
    values (v_user.org_id, trim(p_name),
            nullif(trim(coalesce(p_contact_name, '')), ''),
            nullif(trim(coalesce(p_phone, '')), ''),
            nullif(trim(coalesce(p_email, '')), ''),
            nullif(trim(coalesce(p_address, '')), ''),
            nullif(trim(coalesce(p_vat_number, '')), ''),
            nullif(trim(coalesce(p_notes, '')), ''),
            nullif(trim(coalesce(p_bank_name, '')), ''),
            nullif(trim(coalesce(p_bank_account_name, '')), ''),
            nullif(trim(coalesce(p_bank_account_number, '')), ''),
            nullif(trim(coalesce(p_bank_branch_code, '')), ''))
    returning * into v_row;
  else
    -- A person editing the form is the authority: what they left blank is
    -- meant to be blank.
    update public.suppliers s set
      name = trim(p_name),
      contact_name = nullif(trim(coalesce(p_contact_name, '')), ''),
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      email = nullif(trim(coalesce(p_email, '')), ''),
      address = nullif(trim(coalesce(p_address, '')), ''),
      vat_number = nullif(trim(coalesce(p_vat_number, '')), ''),
      notes = nullif(trim(coalesce(p_notes, '')), ''),
      bank_name = nullif(trim(coalesce(p_bank_name, '')), ''),
      bank_account_name = nullif(trim(coalesce(p_bank_account_name, '')), ''),
      bank_account_number = nullif(trim(coalesce(p_bank_account_number, '')), ''),
      bank_branch_code = nullif(trim(coalesce(p_bank_branch_code, '')), '')
    where s.id = p_id and s.org_id = v_user.org_id
    returning * into v_row;
    if not found then raise exception 'Supplier not found'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.pos_purchasing_save_supplier(
  text, text, uuid, text, text, text, text, text, text, text, text, text, text, text)
  to anon, authenticated;

drop function if exists public.pos_purchasing_file_document(
  text, text, uuid, text, text, text, text, text, text, date,
  numeric, numeric, numeric, text, jsonb, boolean);
create function public.pos_purchasing_file_document(
  p_register_token text, p_pin text,
  p_supplier_id uuid,
  p_supplier_name text, p_supplier_vat text, p_supplier_phone text,
  p_supplier_email text,
  p_kind text, p_doc_number text, p_doc_date date,
  p_subtotal numeric, p_tax_total numeric, p_total numeric,
  p_note text,
  p_lines jsonb,
  p_read boolean default true,
  -- The rest of the letterhead, and the foot of the page.
  p_supplier_address text default null,
  p_bank_name text default null, p_bank_account_name text default null,
  p_bank_account_number text default null, p_bank_branch_code text default null
) returns table(document_id uuid, supplier_id uuid, supplier_name text,
                supplier_created boolean, details_filled int)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user public.app_users; v_sup public.suppliers; v_made boolean := false;
  v_doc uuid; v_line jsonb; v_no int := 0; v_desc text; v_filled int := 0;
  v_after public.suppliers;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');

  if p_kind not in ('quote','invoice','delivery_note','statement','other') then
    raise exception 'Say what kind of document it is';
  end if;
  if p_lines is not null and jsonb_array_length(p_lines) > 500 then
    raise exception 'Too many lines for one document';
  end if;

  if p_supplier_id is not null then
    select * into v_sup from public.suppliers s
     where s.id = p_supplier_id and s.org_id = v_user.org_id;
    if not found then raise exception 'Supplier not found'; end if;
  else
    v_sup := public.supplier_match(v_user.org_id, p_supplier_vat, p_supplier_name);
    if v_sup.id is null then
      if trim(coalesce(p_supplier_name, '')) = '' then
        raise exception 'A supplier needs a name';
      end if;
      insert into public.suppliers(org_id, name, phone, email, vat_number, address,
        bank_name, bank_account_name, bank_account_number, bank_branch_code)
      values (v_user.org_id, trim(p_supplier_name),
              nullif(trim(coalesce(p_supplier_phone, '')), ''),
              nullif(trim(coalesce(p_supplier_email, '')), ''),
              nullif(trim(coalesce(p_supplier_vat, '')), ''),
              nullif(trim(coalesce(p_supplier_address, '')), ''),
              nullif(trim(coalesce(p_bank_name, '')), ''),
              nullif(trim(coalesce(p_bank_account_name, '')), ''),
              nullif(trim(coalesce(p_bank_account_number, '')), ''),
              nullif(trim(coalesce(p_bank_branch_code, '')), ''))
      returning * into v_sup;
      v_made := true;
    end if;
  end if;

  -- Fill the blanks on a supplier we already had. Never overwrite: a changed
  -- account number is a phone call, not a silent update from a photograph.
  if not v_made then
    update public.suppliers s set
      phone = coalesce(s.phone, nullif(trim(coalesce(p_supplier_phone, '')), '')),
      email = coalesce(s.email, nullif(trim(coalesce(p_supplier_email, '')), '')),
      address = coalesce(s.address, nullif(trim(coalesce(p_supplier_address, '')), '')),
      vat_number = coalesce(s.vat_number, nullif(trim(coalesce(p_supplier_vat, '')), '')),
      bank_name = coalesce(s.bank_name, nullif(trim(coalesce(p_bank_name, '')), '')),
      bank_account_name = coalesce(s.bank_account_name, nullif(trim(coalesce(p_bank_account_name, '')), '')),
      bank_account_number = coalesce(s.bank_account_number, nullif(trim(coalesce(p_bank_account_number, '')), '')),
      bank_branch_code = coalesce(s.bank_branch_code, nullif(trim(coalesce(p_bank_branch_code, '')), ''))
    where s.id = v_sup.id
    returning * into v_after;

    -- How many were actually learnt, so the till can say so rather than
    -- changing the record behind the manager's back.
    v_filled :=
      (case when v_sup.phone is null and v_after.phone is not null then 1 else 0 end) +
      (case when v_sup.email is null and v_after.email is not null then 1 else 0 end) +
      (case when v_sup.address is null and v_after.address is not null then 1 else 0 end) +
      (case when v_sup.vat_number is null and v_after.vat_number is not null then 1 else 0 end) +
      (case when v_sup.bank_name is null and v_after.bank_name is not null then 1 else 0 end) +
      (case when v_sup.bank_account_name is null and v_after.bank_account_name is not null then 1 else 0 end) +
      (case when v_sup.bank_account_number is null and v_after.bank_account_number is not null then 1 else 0 end) +
      (case when v_sup.bank_branch_code is null and v_after.bank_branch_code is not null then 1 else 0 end);
    v_sup := v_after;
  end if;

  insert into public.supplier_documents(org_id, supplier_id, kind, doc_number, doc_date,
    subtotal, tax_total, total, note, status, read_at, created_by)
  values (v_user.org_id, v_sup.id, p_kind,
          nullif(trim(coalesce(p_doc_number, '')), ''), p_doc_date,
          p_subtotal, p_tax_total, p_total,
          nullif(trim(coalesce(p_note, '')), ''),
          case when p_read then 'read' else 'stored' end,
          case when p_read then now() else null end,
          v_user.id)
  returning id into v_doc;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_desc := nullif(trim(coalesce(v_line->>'description', '')), '');
    continue when v_desc is null;
    v_no := v_no + 1;
    insert into public.supplier_document_lines(document_id, line_no, supplier_code,
      description, qty, unit_price, line_total)
    values (v_doc, v_no,
            nullif(trim(coalesce(v_line->>'supplier_code', '')), ''),
            left(v_desc, 300),
            nullif(v_line->>'qty', '')::numeric,
            nullif(v_line->>'unit_price', '')::numeric,
            nullif(v_line->>'line_total', '')::numeric);
  end loop;

  return query select v_doc, v_sup.id, v_sup.name, v_made, v_filled;
end;
$$;
grant execute on function public.pos_purchasing_file_document(
  text, text, uuid, text, text, text, text, text, text, date,
  numeric, numeric, numeric, text, jsonb, boolean, text, text, text, text, text)
  to anon, authenticated;
