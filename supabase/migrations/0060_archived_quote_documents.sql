-- 0060 — the quotation as it was sent, kept.
--
-- A quote's lines and prices are already frozen: quote_items holds what was
-- promised, and rebuilding the PDF from them gives the same figures forever.
-- What is NOT frozen is everything around them — the shop's address, its
-- telephone number, its terms, its logo. Move premises and every old
-- quotation redownloads with the new address on it, which is not the document
-- the customer is holding.
--
-- So the file itself is kept, once, and never rewritten. Rebuilding stays the
-- fallback for a quote saved while the line was down.

alter table public.quotes add column if not exists pdf_path text;
comment on column public.quotes.pdf_path is
  'The archived PDF in the sale-documents bucket. Written once, never changed.';

-- Private: a quotation carries a customer''s name and what they were quoted.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sale-documents', 'sale-documents', false, 5242880,
        array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = 5242880,
      allowed_mime_types = array['application/pdf'];

/**
 * Record where a quote's document was stored.
 *
 * WRITE ONCE. A second call on a quote that already has one is a no-op that
 * returns the path it already had, not an overwrite — an archive that can be
 * replaced is not an archive. The edge function relies on this: it asks first,
 * and only uploads when the answer is null.
 */
create or replace function public.pos_quote_set_pdf(
  p_register_token text, p_quote_id uuid, p_path text
) returns text
language plpgsql security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_existing text;
begin
  v_reg := public.register_by_token(p_register_token);
  select q.pdf_path into v_existing from public.quotes q
   where q.id = p_quote_id and q.org_id = v_reg.org_id;
  if not found then raise exception 'Unknown quote'; end if;
  if v_existing is not null then return v_existing; end if;
  if p_path is null or btrim(p_path) = '' then
    raise exception 'A document needs a path';
  end if;
  update public.quotes set pdf_path = p_path where id = p_quote_id;
  return p_path;
end;
$$;

grant execute on function public.pos_quote_set_pdf(text, uuid, text)
  to anon, authenticated;

/** Where a quote's document is, or null. For the function that signs it. */
create or replace function public.pos_quote_pdf(
  p_register_token text, p_quote_id uuid
) returns text
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_path text;
begin
  v_reg := public.register_by_token(p_register_token);
  select q.pdf_path into v_path from public.quotes q
   where q.id = p_quote_id and q.org_id = v_reg.org_id;
  if not found then raise exception 'Unknown quote'; end if;
  return v_path;
end;
$$;

grant execute on function public.pos_quote_pdf(text, uuid) to anon, authenticated;

-- The list gains a column, so it is dropped and recreated rather than
-- replaced: changing a function's return columns in place is refused, and
-- `create or replace` with a new signature would leave the old one standing
-- beside it. (CLAUDE.md, migrations.)
drop function if exists public.pos_list_quotes(text, int);

/** Open quotes, newest first. Expiry is a fact the till presents, not a purge. */
create function public.pos_list_quotes(
  p_register_token text, p_limit int default 50
) returns table(id uuid, doc_number text, created_at timestamptz,
                cashier_name text, customer_id uuid, customer_name text,
                total numeric, valid_until date, expired boolean,
                item_count int, note text, pdf_path text)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select q.id, q.doc_number, q.created_at, q.cashier_name, q.customer_id,
           q.customer_name, q.total, q.valid_until, q.valid_until < current_date,
           (select count(*)::int from public.quote_items i where i.quote_id = q.id),
           q.note, q.pdf_path
      from public.quotes q
     where q.org_id = v_reg.org_id and q.status = 'open'
     order by q.created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

grant execute on function public.pos_list_quotes(text, int) to anon, authenticated;
