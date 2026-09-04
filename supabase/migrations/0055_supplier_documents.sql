-- 0055: suppliers, and the paper they send.
--
-- A quotation from Jasbro, an invoice from Cashbuild, a delivery note off the
-- back of a truck: today these live in a drawer, and the question "what did
-- we pay for that elbow last time?" is answered by going through the drawer.
-- Now the pages are photographed on the phone (or the emailed PDF uploaded)
-- and kept against the supplier, with the number, date and total typed in so
-- the list can be searched. Reading the lines off the page comes next (0056);
-- this is the filing.
--
-- Gated on manage_purchasing, which has existed since 0001 and is granted to
-- owners and managers by default. The files live in a PRIVATE bucket: a
-- supplier's price list is the shop's cost base, and product photographs
-- being public is no reason for these to be. Reading a page therefore goes
-- through the supplier-document edge function, which checks the PIN and signs
-- a short-lived URL.

create table public.supplier_documents (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  supplier_id  uuid not null references public.suppliers(id) on delete restrict,
  kind         text not null check (kind in ('quote','invoice','delivery_note','statement','other')),
  doc_number   text,
  doc_date     date,
  total        numeric(12,2),
  note         text,
  -- stored: filed. read: lines extracted (0056). received: booked in against.
  status       text not null default 'stored' check (status in ('stored','read','received')),
  created_by   uuid references public.app_users(id),
  created_at   timestamptz not null default now()
);
create index supplier_documents_org_idx on public.supplier_documents (org_id, created_at desc);
create index supplier_documents_supplier_idx on public.supplier_documents (supplier_id);

create table public.supplier_document_pages (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.supplier_documents(id) on delete cascade,
  page_no      int not null,
  -- A storage path in the supplier-documents bucket, never a URL.
  path         text not null,
  mime         text not null,
  created_at   timestamptz not null default now(),
  unique (document_id, page_no)
);

alter table public.supplier_documents      enable row level security;
alter table public.supplier_document_pages enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('supplier-documents', 'supplier-documents', false, 10485760,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = 10485760,
      allowed_mime_types = array['image/jpeg','image/png','image/webp','application/pdf'];

-- ---------------------------------------------------------------- suppliers --

create function public.pos_purchasing_suppliers(p_register_token text, p_pin text)
returns table(id uuid, code text, name text, contact_name text, phone text,
              email text, vat_number text, notes text, active boolean,
              document_count int)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  return query
    select s.id, s.code, s.name, s.contact_name, s.phone, s.email, s.vat_number,
           s.notes, s.active,
           (select count(*)::int from public.supplier_documents d where d.supplier_id = s.id)
      from public.suppliers s
     where s.org_id = v_user.org_id and s.active
     order by s.name;
end;
$$;
grant execute on function public.pos_purchasing_suppliers(text, text) to anon, authenticated;

create function public.pos_purchasing_save_supplier(
  p_register_token text, p_pin text, p_id uuid, p_name text,
  p_contact_name text default null, p_phone text default null,
  p_email text default null, p_vat_number text default null,
  p_notes text default null
) returns public.suppliers
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_row public.suppliers;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  if trim(coalesce(p_name, '')) = '' then raise exception 'A supplier needs a name'; end if;
  if p_id is null then
    insert into public.suppliers(org_id, name, contact_name, phone, email, vat_number, notes)
    values (v_user.org_id, trim(p_name),
            nullif(trim(coalesce(p_contact_name, '')), ''),
            nullif(trim(coalesce(p_phone, '')), ''),
            nullif(trim(coalesce(p_email, '')), ''),
            nullif(trim(coalesce(p_vat_number, '')), ''),
            nullif(trim(coalesce(p_notes, '')), ''))
    returning * into v_row;
  else
    update public.suppliers s set
      name = trim(p_name),
      contact_name = nullif(trim(coalesce(p_contact_name, '')), ''),
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      email = nullif(trim(coalesce(p_email, '')), ''),
      vat_number = nullif(trim(coalesce(p_vat_number, '')), ''),
      notes = nullif(trim(coalesce(p_notes, '')), '')
    where s.id = p_id and s.org_id = v_user.org_id
    returning * into v_row;
    if not found then raise exception 'Supplier not found'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.pos_purchasing_save_supplier(text, text, uuid, text, text, text, text, text, text)
  to anon, authenticated;

-- ---------------------------------------------------------------- documents --

create function public.pos_purchasing_add_document(
  p_register_token text, p_pin text, p_supplier_id uuid, p_kind text,
  p_doc_number text default null, p_doc_date date default null,
  p_total numeric default null, p_note text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_id uuid;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  if not exists (select 1 from public.suppliers s
                  where s.id = p_supplier_id and s.org_id = v_user.org_id) then
    raise exception 'Supplier not found';
  end if;
  if p_kind not in ('quote','invoice','delivery_note','statement','other') then
    raise exception 'Say what kind of document it is';
  end if;
  if p_total is not null and p_total < 0 then raise exception 'A total cannot be negative'; end if;
  insert into public.supplier_documents(org_id, supplier_id, kind, doc_number, doc_date,
                                        total, note, created_by)
  values (v_user.org_id, p_supplier_id, p_kind,
          nullif(trim(coalesce(p_doc_number, '')), ''), p_doc_date, p_total,
          nullif(trim(coalesce(p_note, '')), ''), v_user.id)
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.pos_purchasing_add_document(text, text, uuid, text, text, date, numeric, text)
  to anon, authenticated;

-- Called by the edge function after the file is in the bucket; re-checks the
-- PIN, as pos_admin_add_product_image does.
create function public.pos_purchasing_add_page(
  p_register_token text, p_pin text, p_document_id uuid, p_path text, p_mime text
) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_no int;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  if not exists (select 1 from public.supplier_documents d
                  where d.id = p_document_id and d.org_id = v_user.org_id) then
    raise exception 'Document not found';
  end if;
  if trim(coalesce(p_path, '')) = '' then raise exception 'A page needs a file'; end if;
  select coalesce(max(page_no), 0) + 1 into v_no
    from public.supplier_document_pages where document_id = p_document_id;
  insert into public.supplier_document_pages(document_id, page_no, path, mime)
  values (p_document_id, v_no, trim(p_path), p_mime);
  return v_no;
end;
$$;
grant execute on function public.pos_purchasing_add_page(text, text, uuid, text, text)
  to anon, authenticated;

create function public.pos_purchasing_documents(
  p_register_token text, p_pin text, p_supplier_id uuid default null, p_limit int default 100
) returns table(id uuid, supplier_id uuid, supplier_name text, kind text,
                doc_number text, doc_date date, total numeric, note text,
                status text, pages int, created_at timestamptz, created_by_name text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  return query
    select d.id, d.supplier_id, s.name, d.kind, d.doc_number, d.doc_date, d.total,
           d.note, d.status,
           (select count(*)::int from public.supplier_document_pages p where p.document_id = d.id),
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

create function public.pos_purchasing_document_pages(
  p_register_token text, p_pin text, p_document_id uuid
) returns table(page_no int, path text, mime text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  return query
    select p.page_no, p.path, p.mime
      from public.supplier_document_pages p
      join public.supplier_documents d on d.id = p.document_id
     where d.id = p_document_id and d.org_id = v_user.org_id
     order by p.page_no;
end;
$$;
grant execute on function public.pos_purchasing_document_pages(text, text, uuid)
  to anon, authenticated;

-- A wrong upload. The rows go; the files are left for the bucket's lifecycle
-- (they are unreachable without a row to sign from).
create function public.pos_purchasing_delete_document(
  p_register_token text, p_pin text, p_document_id uuid
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_purchasing');
  delete from public.supplier_documents d
   where d.id = p_document_id and d.org_id = v_user.org_id and d.status = 'stored';
  if not found then
    raise exception 'Document not found, or it has already been booked in';
  end if;
end;
$$;
grant execute on function public.pos_purchasing_delete_document(text, text, uuid)
  to anon, authenticated;
