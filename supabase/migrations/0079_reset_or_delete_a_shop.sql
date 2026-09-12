-- An operator wipes a shop clean, or deletes it.
--
-- A shop that was used for testing before it opened — every sale a test
-- sale, every cash-up a rehearsal, the staff list the tester's friends —
-- has to start its books at invoice number 1 on the day the real owner
-- takes it on. Doing that by hand across thirty tables leaves orphans, or
-- worse, a sequence that carries on from the tests. So the two things an
-- operator may do to a whole shop are functions, run from the SQL editor
-- the way innova_create_org is, and never from a till:
--
--   innova_reset_org   wipes the books and the people, unpairs every
--                      device, restarts the document numbers, and invites
--                      the real manager by phone so they enrol with the
--                      OTP and choose a PIN exactly as a new shop would.
--                      The catalogue (products, categories, suppliers,
--                      product images and supplier codes) is kept unless
--                      told otherwise, with stock on hand set to nothing —
--                      the test stock figures were never real.
--   innova_delete_org  the same, then the catalogue and the shop itself.
--
-- Both take the shop's name as well as its id and refuse when they do not
-- match: the one way to be sure a paste of the wrong id wipes nothing.
-- Both are revoked from every API role. Files in storage (product photos,
-- scanned supplier documents) are not touched by either; delete those
-- from the dashboard if they matter.

create function public.innova_reset_org(
  p_org_id uuid, p_org_name text, p_manager_name text, p_manager_phone text,
  p_keep_catalogue boolean default true
) returns uuid
language plpgsql security definer
set search_path = public, extensions as $$
declare v_org public.organizations; v_mgr uuid;
begin
  select * into v_org from public.organizations where id = p_org_id;
  if v_org.id is null then raise exception 'No such shop'; end if;
  if lower(btrim(p_org_name)) is distinct from lower(btrim(v_org.name)) then
    raise exception 'The name does not match the shop with that id (%): nothing was touched', v_org.name;
  end if;
  if p_manager_phone !~ '^\+\d{9,15}$' then
    raise exception 'Manager phone must be E.164, e.g. +27821234567';
  end if;

  -- The books: children before parents, in the order the foreign keys
  -- demand.
  delete from public.approval_attempts
   where register_id in (select id from public.registers where org_id = p_org_id);
  delete from public.approval_codes where org_id = p_org_id;
  delete from public.return_items
   where return_id in (select id from public.returns where org_id = p_org_id);
  delete from public.returns where org_id = p_org_id;
  delete from public.deliveries where org_id = p_org_id;
  delete from public.quote_items
   where quote_id in (select id from public.quotes where org_id = p_org_id);
  delete from public.quotes where org_id = p_org_id;
  delete from public.sale_payments where org_id = p_org_id;
  delete from public.sale_items
   where sale_id in (select id from public.sales where org_id = p_org_id);
  delete from public.sales where org_id = p_org_id;
  delete from public.customer_payments where org_id = p_org_id;
  delete from public.customers where org_id = p_org_id;
  delete from public.cash_movements where org_id = p_org_id;
  delete from public.cash_sessions where org_id = p_org_id;
  delete from public.stock_count_lines
   where count_id in (select id from public.stock_counts where org_id = p_org_id);
  delete from public.stock_counts where org_id = p_org_id;
  delete from public.purchase_order_lines
   where po_id in (select id from public.purchase_orders where org_id = p_org_id);
  delete from public.purchase_orders where org_id = p_org_id;
  delete from public.supplier_document_lines
   where document_id in (select id from public.supplier_documents where org_id = p_org_id);
  delete from public.supplier_document_pages
   where document_id in (select id from public.supplier_documents where org_id = p_org_id);
  delete from public.supplier_documents where org_id = p_org_id;
  delete from public.stock_movements where org_id = p_org_id;
  delete from public.tillai_questions where org_id = p_org_id;
  delete from public.client_errors where org_id = p_org_id;
  delete from public.login_attempts where org_id = p_org_id;

  -- Devices and people. Every till and phone goes back to the front door;
  -- every PIN, code and token is gone with the person it belonged to.
  delete from public.device_enrolments where org_id = p_org_id;
  delete from public.registers where org_id = p_org_id;
  delete from public.auth_otps
   where phone_e164 in (select phone_e164 from public.app_users where org_id = p_org_id);
  delete from public.auth_setpin_tokens
   where phone_e164 in (select phone_e164 from public.app_users where org_id = p_org_id);
  delete from public.app_users where org_id = p_org_id;

  if p_keep_catalogue then
    update public.products set stock_qty = 0 where org_id = p_org_id;
  else
    delete from public.product_images where org_id = p_org_id;
    delete from public.supplier_product_codes where org_id = p_org_id;
    delete from public.products where org_id = p_org_id;
    delete from public.categories where org_id = p_org_id;
    delete from public.suppliers where org_id = p_org_id;
  end if;

  -- The first real invoice is number 1.
  update public.doc_sequences set next_number = 1 where org_id = p_org_id;

  -- The real manager, invited as innova_create_org invites one: they prove
  -- the phone by OTP and choose their PIN; nothing is set for them.
  insert into public.app_users (org_id, name, role, phone_e164, status, pin_hash)
  values (p_org_id, btrim(p_manager_name), 'admin', p_manager_phone, 'invited', null)
  returning id into v_mgr;
  return v_mgr;
end;
$$;
revoke execute on function public.innova_reset_org(uuid, text, text, text, boolean)
  from anon, authenticated, public;

create function public.innova_delete_org(p_org_id uuid, p_org_name text)
returns void
language plpgsql security definer
set search_path = public, extensions as $$
begin
  -- The reset does the checking and the emptying; the placeholder manager
  -- it invites goes with the shop.
  perform public.innova_reset_org(p_org_id, p_org_name, 'gone', '+000000000000', false);
  delete from public.app_users where org_id = p_org_id;
  delete from public.doc_sequences where org_id = p_org_id;
  delete from public.organizations where id = p_org_id;
end;
$$;
revoke execute on function public.innova_delete_org(uuid, text)
  from anon, authenticated, public;
