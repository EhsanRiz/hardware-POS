-- What the review found in the database, the smaller items, in one place.
--
-- 1. A void reads a PIN the way every other RPC does. pos_void_sale matched
--    PINs itself with `limit 1` — the ambiguity 0033 and 0036 removed
--    everywhere else — and answered "Not permitted: void_refund" for a real
--    PIN without the right and "not a code we recognise" for anything else,
--    which told a guesser which six digits were somebody's. One refusal now.
-- 2. delivery_product and delivery_category are security definer, take a
--    caller-chosen org id, insert rows and return a products row with its
--    cost, and were never revoked from the anon key. They are now.
-- 3. Phone enrolment's throttle is per caller, not per platform — and it
--    counts. As written in 0074 it raised after inserting the attempt, which
--    rolled the attempt back, so no number of wrong codes was ever counted.
--    Had it worked, twenty wrong codes would have locked every shop out of
--    enrolling a phone for fifteen minutes. The caller's address comes from
--    the gateway's headers.
-- 4. Approval codes and enrolment codes come from the cryptographic
--    generator, not random(), which is seeded once per backend and shared.
-- 5. Default privileges no longer hand a new function to the anon key. The
--    schema's safety rested on every migration remembering the revoke; item
--    2 is that failing once. Every till entry point is granted by name, and
--    the test suite now checks both directions.
-- 6. innova_reset_org clears parked sales, which arrived after it.

-- 5 first, so nothing below inherits a grant it should not have. Postgres
-- hands every new function to PUBLIC, and that built-in default is global:
-- a per-schema entry cannot take it away, only add to it. Supabase's
-- bootstrap adds a per-schema grant to anon and authenticated on top. Both
-- are taken away for functions the postgres role creates from here on;
-- existing ones keep what they have, and service_role keeps its own grant,
-- which is how the edge functions reach the RPCs they call.
alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

-- 2. And register_touch, which the test written for this migration found
-- the same way: definer, reachable, never revoked.
revoke execute on function public.delivery_product(uuid) from anon, authenticated, public;
revoke execute on function public.delivery_category(uuid) from anon, authenticated, public;
revoke execute on function public.register_touch(uuid) from anon, authenticated, public;

-- The caller's address, as PostgREST passes it. Null-safe: outside the
-- gateway (a test, the SQL editor) there are no headers and the bucket is
-- 'unknown', which is one shared bucket rather than no throttle.
create function public.request_ip() returns text
language plpgsql stable as $$
declare v_headers json;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null;
  end;
  return coalesce(
    nullif(btrim(split_part(coalesce(v_headers->>'cf-connecting-ip', ''), ',', 1)), ''),
    nullif(btrim(split_part(coalesce(v_headers->>'x-forwarded-for', ''), ',', 1)), ''),
    'unknown');
end;
$$;
revoke execute on function public.request_ip() from anon, authenticated, public;

-- n decimal digits from gen_random_bytes, by rejection so every code is as
-- likely as every other. Four bytes are 2^32 draws; anything at or above the
-- largest multiple of 10^n below that is thrown back.
create function public.random_digits(p_n int) returns text
language plpgsql volatile as $$
declare v_bytes bytea; v_draw bigint; v_space bigint := (10 ^ p_n)::bigint;
        v_limit bigint := (4294967296 / (10 ^ p_n)::bigint) * (10 ^ p_n)::bigint;
begin
  loop
    v_bytes := gen_random_bytes(4);
    v_draw := get_byte(v_bytes, 0)::bigint * 16777216 + get_byte(v_bytes, 1) * 65536
            + get_byte(v_bytes, 2) * 256 + get_byte(v_bytes, 3);
    exit when v_draw < v_limit;
  end loop;
  return lpad((v_draw % v_space)::text, p_n, '0');
end;
$$;
revoke execute on function public.random_digits(int) from anon, authenticated, public;

-- 3.
alter table public.enrolment_attempts add column ip text not null default 'unknown';
create index enrolment_attempts_ip_at_idx on public.enrolment_attempts (ip, at desc);

-- 1.
create or replace function public.pos_void_sale(
  p_sale_id uuid, p_register_token text, p_pin text, p_reason text default null,
  -- Who is at the till. Needed only when a code is used, to record who spent it.
  p_cashier_id uuid default null
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_reg public.registers; v_by_pin public.app_users; v_approver public.app_users;
  v_sale public.sales; v_code public.approval_codes; v_recent int;
begin
  v_reg := public.register_by_token(p_register_token);

  select * into v_sale from public.sales
   where id = p_sale_id and org_id = v_reg.org_id for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status = 'voided' then raise exception 'Already voided'; end if;
  -- A sale with a credit note against it has money already gone back on
  -- paper; voiding the rest would double it. The return screen does the rest.
  if exists (select 1 from public.returns r where r.sale_id = p_sale_id) then
    raise exception 'Part of this sale has been returned — return the rest instead of cancelling';
  end if;

  -- First reading of the digits: a manager's PIN, proved the way every other
  -- RPC proves one — through user_with_perm, which refuses a PIN two people
  -- share rather than picking one (0033, 0036) — and read as "not a PIN"
  -- whatever it said, so that the second reading's refusal is the only
  -- word that gets out: a PIN that is real but not a manager's used to be
  -- told apart from one that is not real, which made this an oracle.
  begin
    v_approver := public.user_with_perm(p_register_token, p_pin, 'void_refund');
  exception when others then
    v_approver := null;
  end;
  if v_approver.id is null then
    -- Second reading: a code a manager issued. Rate-limited per till, as
    -- pos_check_approval_code is, because this too is an oracle.
    select count(*) into v_recent from public.approval_attempts a
     where a.register_id = v_reg.id and a.at > now() - interval '15 minutes';
    if v_recent >= 10 then
      raise exception 'Too many wrong codes on this till. Try again in 15 minutes.';
    end if;

    select * into v_code from public.approval_codes c
     where c.org_id = v_reg.org_id and c.used_at is null and c.expires_at > now()
       and c.code_hash = crypt(coalesce(p_pin, ''), c.code_hash)
     limit 1
     for update;

    if v_code.id is null then
      insert into public.approval_attempts(register_id) values (v_reg.id);
      raise exception
        'Not a manager''s PIN, and not a code we recognise. A code may have expired or already been used.';
    end if;
    if v_code.max_amount is not null and v_sale.total > v_code.max_amount + 0.005 then
      raise exception 'That code covers up to %, and this sale is %.',
        to_char(v_code.max_amount, 'FM999999990.00'),
        to_char(v_sale.total, 'FM999999990.00');
    end if;
    if p_cashier_id is null or not exists (
      select 1 from public.app_users u
       where u.id = p_cashier_id and u.org_id = v_reg.org_id and u.active) then
      raise exception 'A code has to be used by a signed-in cashier';
    end if;

    delete from public.approval_attempts a where a.register_id = v_reg.id;
    update public.approval_codes
       set used_at = now(), used_by = p_cashier_id, used_on_sale = p_sale_id
     where id = v_code.id;
    select * into v_approver from public.app_users where id = v_code.issued_by;
  end if;

  if v_sale.status = 'completed' then
    perform public.settle_stock_for_sale(p_sale_id, 1, 'void', v_approver);
  end if;
  update public.sales
     set status = 'voided', voided_by = v_approver.id, voided_at = now(),
         void_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_sale_id returning * into v_sale;
  return v_sale;
end;
$$;

-- 3.
create or replace function public.pos_enrol_device(
  p_code text, p_device_name text
) returns table(register_id uuid, token text, user_id uuid, user_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_enrol public.device_enrolments; v_user public.app_users;
  v_token text; v_id uuid; v_recent int; v_ip text;
begin
  -- Counted per caller, not per platform: twenty wrong codes used to lock
  -- every shop's phone enrolment for a quarter of an hour, at no cost to
  -- whoever sent them. The caller's address comes from the gateway's
  -- headers; where there are none (a test) the bucket is 'unknown'.
  v_ip := public.request_ip();
  select count(*) into v_recent from public.enrolment_attempts
   where ip = v_ip and at > now() - interval '15 minutes';
  if v_recent >= 20 then
    raise exception 'Too many wrong codes. Try again in 15 minutes.';
  end if;

  select * into v_enrol from public.device_enrolments
   where code_hash = encode(digest(upper(btrim(coalesce(p_code, ''))), 'sha256'), 'hex')
     and used_at is null and expires_at > now()
   limit 1;
  -- A wrong code is recorded and then refused as NO ROW, not as an error:
  -- an exception rolls back the insert with it, which is why the throttle
  -- here never counted anything from 0074 until now. The app turns an empty
  -- reply into "That code is not valid".
  if not found then
    insert into public.enrolment_attempts (ip) values (v_ip);
    return;
  end if;

  select * into v_user from public.app_users
   where id = v_enrol.app_user_id and active and status = 'active';
  if not found then
    raise exception 'That person is no longer on the staff';
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.registers (org_id, name, token_hash, kind, assigned_to)
  values (v_enrol.org_id,
          coalesce(nullif(btrim(coalesce(p_device_name, '')), ''),
                   v_user.name || '''s phone'),
          encode(digest(v_token, 'sha256'), 'hex'), 'personal', v_user.id)
  returning id into v_id;

  update public.device_enrolments
     set used_at = now(), used_register_id = v_id
   where id = v_enrol.id;
  delete from public.enrolment_attempts where at < now() - interval '1 day';

  return query select v_id, v_token, v_user.id, v_user.name;
end;
$$;

-- 4.
create or replace function public.pos_issue_approval_code(
  p_register_token text,
  p_pin text,
  p_minutes int default 10,
  p_max_amount numeric default null,
  p_reason text default null
) returns table(code text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.app_users; v_code text; v_expires timestamptz;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'approve_discount');

  if p_minutes is null or p_minutes < 1 or p_minutes > 120 then
    raise exception 'A code lasts between 1 and 120 minutes';
  end if;
  if p_max_amount is not null and p_max_amount <= 0 then
    raise exception 'A ceiling of nothing is not a ceiling';
  end if;

  -- Six digits from the cryptographic generator, uniformly drawn (0092).
  -- random() is seeded once per backend and shared by every caller on that
  -- connection; a manager who could mint codes could, in principle, read
  -- the stream and predict another shop's next one. lpad because a leading
  -- zero is a digit and dropping it would quietly shrink the space by a
  -- tenth.
  v_code := public.random_digits(6);
  v_expires := now() + make_interval(mins => p_minutes);

  insert into public.approval_codes(
    org_id, code_hash, issued_by, issued_by_name, max_amount, reason, expires_at)
  values (v_user.org_id, crypt(v_code, gen_salt('bf')), v_user.id, v_user.name,
          p_max_amount, nullif(trim(coalesce(p_reason, '')), ''), v_expires);

  return query select v_code, v_expires;
end;
$$;

create or replace function public.pos_staff_enrolment_code(
  p_register_token text, p_pin text, p_app_user_id uuid
) returns table(code text, expires_at timestamptz, staff_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid; v_by public.app_users; v_target public.app_users;
  v_code text; v_expires timestamptz;
  -- No I, O, 0 or 1: these are read aloud and typed by somebody in a hurry.
  v_alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  i int;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_staff');
  select * into v_by from public.app_users
   where org_id = v_org and pin_hash = crypt(p_pin, pin_hash) and active limit 1;

  select * into v_target from public.app_users
   where id = p_app_user_id and org_id = v_org and active and status = 'active';
  if not found then raise exception 'Unknown or inactive staff member'; end if;
  if v_target.pin_hash is null then
    raise exception '% has no PIN yet, so cannot sign in on a phone', v_target.name;
  end if;

  -- Eight characters from the cryptographic generator (0092): 256 is a
  -- multiple of 32, so a byte modulo the alphabet's length is uniform.
  v_code := '';
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet,
      1 + get_byte(gen_random_bytes(8), i) % length(v_alphabet), 1);
  end loop;
  v_expires := now() + interval '15 minutes';

  -- One live code per person: issuing a new one kills the old, so a code read
  -- out an hour ago and forgotten cannot still enrol a device tomorrow.
  -- Qualified: `expires_at` and `code` are also OUT parameters of this
  -- function, and an unqualified reference means the parameter.
  update public.device_enrolments d set expires_at = now()
   where d.app_user_id = p_app_user_id and d.used_at is null
     and d.expires_at > now();

  insert into public.device_enrolments
    (org_id, app_user_id, code_hash, created_by, created_by_name, expires_at)
  values (v_org, p_app_user_id, encode(digest(v_code, 'sha256'), 'hex'),
          v_by.id, v_by.name, v_expires);

  return query select v_code, v_expires, v_target.name;
end;
$$;

-- 6.
create or replace function public.innova_reset_org(
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
  -- 0086 came after this function and was never added to it: a wiped test
  -- shop handed its successor the tester's parked baskets.
  delete from public.parked_sales where org_id = p_org_id;
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
