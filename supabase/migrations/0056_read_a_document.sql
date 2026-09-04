-- 0056: filing a supplier's document by reading it, not by typing it.
--
-- The Jasbro quotation carries the supplier's name, VAT number, phone and
-- email on the letterhead, its own number and date, thirteen priced lines and
-- three totals. Every one of those was being typed into a form by somebody
-- holding the piece of paper that already said it. Now the pages are read
-- (by the read-document edge function, which is where the vision model lives)
-- and the manager confirms one screen.
--
-- Two things this adds: the LINES, so a document is data and not only an
-- image; and filing in one step, which matches the supplier by VAT number —
-- names are written three ways, VAT numbers are not — or creates it from the
-- letterhead.
--
-- What it deliberately does NOT do is touch stock or cost prices. A quote is
-- a promise, an invoice is a purchase, and neither is goods on the shelf.
-- That is the receive step, and it is the manager's decision.

alter table public.supplier_documents
  add column if not exists subtotal   numeric(12,2),
  add column if not exists tax_total  numeric(12,2),
  add column if not exists read_at    timestamptz;

create table public.supplier_document_lines (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.supplier_documents(id) on delete cascade,
  line_no       int not null,
  -- The supplier's own code for it: "PL 0065". The bridge to our catalogue,
  -- remembered per supplier once a person has confirmed the pairing.
  supplier_code text,
  description   text not null,
  qty           numeric(14,3),
  -- Four decimals: a supplier prices a washer at 1.1050 and the shop buys a
  -- thousand of them.
  unit_price    numeric(12,4),
  line_total    numeric(12,2),
  -- Filled in at the receive step, not here.
  product_id    uuid references public.products(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (document_id, line_no)
);
create index supplier_document_lines_doc_idx on public.supplier_document_lines (document_id, line_no);
alter table public.supplier_document_lines enable row level security;

-- The supplier this letterhead belongs to, if the shop already knows it.
-- VAT number first and digits only, because "4370229645" and "4370 229 645"
-- are the same registration and "Jasbro Plumbing" and "JASBRO PLUMBING (PTY)
-- LTD" are the same shop under two spellings.
create function public.supplier_match(p_org uuid, p_vat text, p_name text)
returns public.suppliers
language plpgsql stable set search_path = public, extensions as $$
declare v_row public.suppliers; v_vat text; v_name text;
begin
  v_vat := nullif(regexp_replace(coalesce(p_vat, ''), '\D', '', 'g'), '');
  v_name := nullif(lower(trim(coalesce(p_name, ''))), '');

  if v_vat is not null then
    select * into v_row from public.suppliers s
     where s.org_id = p_org and s.active
       and nullif(regexp_replace(coalesce(s.vat_number, ''), '\D', '', 'g'), '') = v_vat
     limit 1;
    if found then return v_row; end if;
  end if;

  if v_name is not null then
    select * into v_row from public.suppliers s
     where s.org_id = p_org and s.active and lower(trim(s.name)) = v_name
     limit 1;
    if found then return v_row; end if;
  end if;

  return null;
end;
$$;
revoke execute on function public.supplier_match(uuid, text, text) from public, anon, authenticated;

-- What the review screen shows before anything is written: does this
-- letterhead belong to somebody we already buy from?
create function public.pos_purchasing_match_supplier(
  p_register_token text, p_pin text, p_vat_number text, p_name text
) returns table(id uuid, name text, vat_number text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_row public.suppliers;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  v_row := public.supplier_match(v_user.org_id, p_vat_number, p_name);
  if v_row.id is null then return; end if;
  return query select v_row.id, v_row.name, v_row.vat_number;
end;
$$;
grant execute on function public.pos_purchasing_match_supplier(text, text, text, text)
  to anon, authenticated;

-- File a document that has been read: the supplier (matched, chosen or made),
-- the header, and every line, in one transaction. A half-filed document is a
-- document somebody has to work out the state of.
create function public.pos_purchasing_file_document(
  p_register_token text, p_pin text,
  -- Chosen on the review screen. Null means "the letterhead's supplier",
  -- matched by VAT number or created from the details below.
  p_supplier_id uuid,
  p_supplier_name text, p_supplier_vat text, p_supplier_phone text,
  p_supplier_email text,
  p_kind text, p_doc_number text, p_doc_date date,
  p_subtotal numeric, p_tax_total numeric, p_total numeric,
  p_note text,
  -- [{ "supplier_code": "PL 0065", "description": "COMP ELBOW 15MM",
  --    "qty": 20, "unit_price": 16.85, "line_total": 337.00 }, …]
  p_lines jsonb,
  p_read boolean default true
) returns table(document_id uuid, supplier_id uuid, supplier_name text, supplier_created boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user public.app_users; v_sup public.suppliers; v_made boolean := false;
  v_doc uuid; v_line jsonb; v_no int := 0; v_desc text;
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
    -- Even when the screen said "new", match once more here: two tills
    -- filing the same delivery note must not make two Jasbros.
    v_sup := public.supplier_match(v_user.org_id, p_supplier_vat, p_supplier_name);
    if v_sup.id is null then
      if trim(coalesce(p_supplier_name, '')) = '' then
        raise exception 'A supplier needs a name';
      end if;
      insert into public.suppliers(org_id, name, phone, email, vat_number)
      values (v_user.org_id, trim(p_supplier_name),
              nullif(trim(coalesce(p_supplier_phone, '')), ''),
              nullif(trim(coalesce(p_supplier_email, '')), ''),
              nullif(trim(coalesce(p_supplier_vat, '')), ''))
      returning * into v_sup;
      v_made := true;
    end if;
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
    -- A line with no description is a misread of a rule or a blank row, not
    -- a thing that was bought. Dropped rather than stored as a puzzle.
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

  return query select v_doc, v_sup.id, v_sup.name, v_made;
end;
$$;
grant execute on function public.pos_purchasing_file_document(
  text, text, uuid, text, text, text, text, text, text, date,
  numeric, numeric, numeric, text, jsonb, boolean) to anon, authenticated;

create function public.pos_purchasing_document_lines(
  p_register_token text, p_pin text, p_document_id uuid
) returns table(line_no int, supplier_code text, description text,
                qty numeric, unit_price numeric, line_total numeric,
                product_id uuid, product_name text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  return query
    select l.line_no, l.supplier_code, l.description, l.qty, l.unit_price,
           l.line_total, l.product_id, p.name
      from public.supplier_document_lines l
      join public.supplier_documents d on d.id = l.document_id
      left join public.products p on p.id = l.product_id
     where d.id = p_document_id and d.org_id = v_user.org_id
     order by l.line_no;
end;
$$;
grant execute on function public.pos_purchasing_document_lines(text, text, uuid)
  to anon, authenticated;

-- The list gains the line count, so a read document is visibly different from
-- a filed photograph.
drop function if exists public.pos_purchasing_documents(text, text, uuid, int);
create function public.pos_purchasing_documents(
  p_register_token text, p_pin text, p_supplier_id uuid default null, p_limit int default 100
) returns table(id uuid, supplier_id uuid, supplier_name text, kind text,
                doc_number text, doc_date date, total numeric, note text,
                status text, pages int, lines int, created_at timestamptz,
                created_by_name text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  return query
    select d.id, d.supplier_id, s.name, d.kind, d.doc_number, d.doc_date, d.total,
           d.note, d.status,
           (select count(*)::int from public.supplier_document_pages p where p.document_id = d.id),
           (select count(*)::int from public.supplier_document_lines l where l.document_id = d.id),
           d.created_at, u.name
      from public.supplier_documents d
      join public.suppliers s on s.id = d.supplier_id
      left join public.app_users u on u.id = d.created_by
     where d.org_id = v_user.org_id
       and (p_supplier_id is null or d.supplier_id = p_supplier_id)
     order by d.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;
grant execute on function public.pos_purchasing_documents(text, text, uuid, int)
  to anon, authenticated;

-- Removing a wrong filing now has lines to take with it (the cascade does it)
-- and must also cover a document that was read, not only one merely stored.
create or replace function public.pos_purchasing_delete_document(
  p_register_token text, p_pin text, p_document_id uuid
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  delete from public.supplier_documents d
   where d.id = p_document_id and d.org_id = v_user.org_id
     and d.status in ('stored', 'read');
  if not found then
    raise exception 'Document not found, or it has already been booked in';
  end if;
end;
$$;
