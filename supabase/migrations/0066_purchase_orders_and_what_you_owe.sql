-- 0066 — ordering from a supplier, and what is owed for it.
--
-- The purchasing side has had both ends since 0055-0058: a supplier's
-- paperwork can be scanned and read, and goods can be booked in against it.
-- The middle was missing. A shop that wants to ORDER something has had
-- nowhere to say so, which means the order lives on a phone call and nobody
-- can answer "what is on its way?".
--
-- And the money went one way. Suppliers appear in reports as what was spent;
-- nothing said what is still owed, or when it is due.

create table if not exists public.purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  doc_number   text not null,
  supplier_id  uuid not null references public.suppliers(id) on delete restrict,
  -- draft: being built. sent: the supplier has it. part: some of it arrived.
  -- received: all of it did. cancelled: it is not coming.
  status       text not null default 'draft',
  expected_on  date,
  note         text,
  created_at   timestamptz not null default now(),
  created_by   uuid references public.app_users(id),
  created_by_name text,
  sent_at      timestamptz,
  constraint purchase_orders_status_check
    check (status in ('draft', 'sent', 'part', 'received', 'cancelled')),
  constraint purchase_orders_number_unique unique (org_id, doc_number)
);
create index if not exists purchase_orders_org_idx
  on public.purchase_orders (org_id, status, created_at desc);
alter table public.purchase_orders enable row level security;

create table if not exists public.purchase_order_lines (
  id          uuid primary key default gen_random_uuid(),
  po_id       uuid not null references public.purchase_orders(id) on delete cascade,
  product_id  uuid references public.products(id) on delete set null,
  -- Copied, so an order still reads correctly if a product is renamed or
  -- retired between ordering and delivery.
  sku         text,
  name        text not null,
  unit_code   text not null,
  qty         numeric(14,3) not null check (qty > 0),
  unit_cost   numeric(12,4),
  received_qty numeric(14,3) not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists purchase_order_lines_po_idx
  on public.purchase_order_lines (po_id);
-- One line per product per order. Lines for something not in the catalogue
-- (product_id null) are not covered: there is nothing to be the same as.
create unique index if not exists purchase_order_lines_one_per_product
  on public.purchase_order_lines (po_id, product_id) where product_id is not null;
alter table public.purchase_order_lines enable row level security;

/** A new order, empty, for one supplier. */
create or replace function public.pos_po_create(
  p_register_token text, p_pin text, p_supplier_id uuid,
  p_expected_on date default null, p_note text default null
) returns public.purchase_orders
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid; v_user public.app_users; v_row public.purchase_orders;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  select * into v_user from public.app_users
   where org_id = v_org and pin_hash = crypt(p_pin, pin_hash) and active limit 1;
  if not exists (select 1 from public.suppliers
                  where id = p_supplier_id and org_id = v_org) then
    raise exception 'Unknown supplier';
  end if;

  insert into public.purchase_orders (org_id, doc_number, supplier_id,
    expected_on, note, created_by, created_by_name)
  values (v_org, public.next_doc_number(v_org, 'po'), p_supplier_id,
          p_expected_on, nullif(btrim(coalesce(p_note, '')), ''),
          v_user.id, v_user.name)
  returning * into v_row;
  return v_row;
end;
$$;

grant execute on function public.pos_po_create(text, text, uuid, date, text)
  to anon, authenticated;

/**
 * Put a line on an order, or change one that is already on it.
 *
 * Only while it is a draft or has been sent: an order that has started
 * arriving is a record of what was agreed, and editing it after the fact
 * would make the received quantities meaningless.
 */
create or replace function public.pos_po_set_line(
  p_register_token text, p_pin text, p_po_id uuid, p_product_id uuid,
  p_qty numeric, p_unit_cost numeric default null
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid; v_status text; v_p public.products;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  select status into v_status from public.purchase_orders
   where id = p_po_id and org_id = v_org;
  if not found then raise exception 'Unknown order'; end if;
  if v_status not in ('draft', 'sent') then
    raise exception 'That order is % and cannot be changed', v_status;
  end if;

  select * into v_p from public.products where id = p_product_id and org_id = v_org;
  if not found then raise exception 'Unknown product'; end if;

  if p_qty is null or p_qty <= 0 then
    delete from public.purchase_order_lines
     where po_id = p_po_id and product_id = p_product_id;
    return;
  end if;

  -- Change the line if it is already there, add it if it is not. `on conflict`
  -- would need a constraint to bite on, and without one the insert fires every
  -- time: the same product ends up on the order twice.
  update public.purchase_order_lines
     set qty = p_qty,
         unit_cost = coalesce(p_unit_cost, unit_cost, v_p.cost)
   where po_id = p_po_id and product_id = p_product_id;
  if not found then
    insert into public.purchase_order_lines
      (po_id, product_id, sku, name, unit_code, qty, unit_cost)
    values (p_po_id, v_p.id, v_p.sku, v_p.name, v_p.unit_code, p_qty,
            coalesce(p_unit_cost, v_p.cost));
  end if;
end;
$$;

grant execute on function public.pos_po_set_line(text, text, uuid, uuid, numeric, numeric)
  to anon, authenticated;

/**
 * Everything under its reorder level, as an order.
 *
 * This is the point of the reorder list: it answers "what do I need" and this
 * turns that answer into the document that gets it. Quantity ordered is the
 * shortfall plus what has sold in the last month, rounded up — a shop that
 * orders exactly the shortfall is back on the list the same week.
 */
create or replace function public.pos_po_from_reorder(
  p_register_token text, p_pin text, p_supplier_id uuid,
  p_expected_on date default null
) returns public.purchase_orders
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid; v_row public.purchase_orders;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  v_row := public.pos_po_create(p_register_token, p_pin, p_supplier_id,
                                p_expected_on, 'From the reorder list');

  insert into public.purchase_order_lines
    (po_id, product_id, sku, name, unit_code, qty, unit_cost)
  select v_row.id, p.id, p.sku, p.name, p.unit_code,
         ceil(greatest(p.reorder_level - p.stock_qty, 0)
              + coalesce((select sum(si.qty) from public.sale_items si
                            join public.sales sa on sa.id = si.sale_id
                           where si.product_id = p.id and sa.status = 'completed'
                             and sa.created_at >= now() - interval '30 days'), 0)),
         p.cost
    from public.products p
   where p.org_id = v_org and p.active
     and p.stock_qty is not null and p.reorder_level is not null
     and p.stock_qty <= p.reorder_level;

  return v_row;
end;
$$;

grant execute on function public.pos_po_from_reorder(text, text, uuid, date)
  to anon, authenticated;

/** The orders, with what is still to come. */
create or replace function public.pos_po_list(
  p_register_token text, p_pin text, p_limit int default 50
) returns table(id uuid, doc_number text, supplier text, supplier_id uuid,
                status text, expected_on date, note text,
                created_at timestamptz, created_by_name text, sent_at timestamptz,
                lines int, total numeric, outstanding_lines int)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  return query
    select o.id, o.doc_number, s.name, o.supplier_id, o.status, o.expected_on,
           o.note, o.created_at, o.created_by_name, o.sent_at,
           (select count(*)::int from public.purchase_order_lines l where l.po_id = o.id),
           (select coalesce(sum(l.qty * coalesce(l.unit_cost, 0)), 0)
              from public.purchase_order_lines l where l.po_id = o.id),
           (select count(*)::int from public.purchase_order_lines l
             where l.po_id = o.id and l.received_qty < l.qty)
      from public.purchase_orders o
      join public.suppliers s on s.id = o.supplier_id
     where o.org_id = v_org
     -- What is still coming first: that is what somebody is chasing.
     order by (o.status in ('draft', 'sent', 'part')) desc, o.created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

grant execute on function public.pos_po_list(text, text, int) to anon, authenticated;

/** One order's lines, with what has already arrived against each. */
create or replace function public.pos_po_lines(
  p_register_token text, p_pin text, p_po_id uuid
) returns table(id uuid, product_id uuid, sku text, name text, unit_code text,
                qty numeric, unit_cost numeric, received_qty numeric,
                outstanding numeric, on_hand numeric)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  return query
    select l.id, l.product_id, l.sku, l.name, l.unit_code, l.qty, l.unit_cost,
           l.received_qty, greatest(l.qty - l.received_qty, 0), p.stock_qty
      from public.purchase_order_lines l
      join public.purchase_orders o on o.id = l.po_id
      left join public.products p on p.id = l.product_id
     where l.po_id = p_po_id and o.org_id = v_org
     order by l.name;
end;
$$;

grant execute on function public.pos_po_lines(text, text, uuid) to anon, authenticated;

/** The supplier has it. */
create or replace function public.pos_po_send(
  p_register_token text, p_pin text, p_po_id uuid
) returns public.purchase_orders
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid; v_row public.purchase_orders;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  select * into v_row from public.purchase_orders
   where id = p_po_id and org_id = v_org;
  if not found then raise exception 'Unknown order'; end if;
  if v_row.status <> 'draft' then
    raise exception 'That order has already been %', v_row.status;
  end if;
  if not exists (select 1 from public.purchase_order_lines where po_id = p_po_id) then
    raise exception 'An order with nothing on it is not an order';
  end if;

  update public.purchase_orders set status = 'sent', sent_at = now()
   where id = p_po_id returning * into v_row;
  return v_row;
end;
$$;

grant execute on function public.pos_po_send(text, text, uuid) to anon, authenticated;

/**
 * What actually turned up.
 *
 * Booking in against the order rather than against a scanned invoice, which
 * is the other door (0058) and stays open. Stock moves, cost is recorded on
 * the movement, and the order tells you what is still outstanding — a
 * part delivery is the normal case, not an error.
 */
create or replace function public.pos_po_receive(
  p_register_token text, p_pin text, p_po_id uuid, p_lines jsonb
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid; v_user public.app_users; v_row public.purchase_orders;
  v_item jsonb; v_line public.purchase_order_lines; v_qty numeric;
  v_cost numeric; v_moved int := 0; v_left int;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  select * into v_user from public.app_users
   where org_id = v_org and pin_hash = crypt(p_pin, pin_hash) and active limit 1;

  select * into v_row from public.purchase_orders
   where id = p_po_id and org_id = v_org for update;
  if not found then raise exception 'Unknown order'; end if;
  if v_row.status in ('cancelled', 'received') then
    raise exception 'That order is %', v_row.status;
  end if;

  for v_item in select * from jsonb_array_elements(p_lines) loop
    select * into v_line from public.purchase_order_lines
     where id = (v_item->>'line_id')::uuid and po_id = p_po_id;
    if not found then raise exception 'That line is not on this order'; end if;

    v_qty := (v_item->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    v_cost := nullif(v_item->>'unit_cost', '')::numeric;

    perform public.apply_stock(
      v_line.product_id, v_qty, 'receipt', 'purchase_orders', p_po_id, v_user,
      format('%s line %s', v_row.doc_number, v_line.name),
      coalesce(v_cost, v_line.unit_cost));

    -- Cost is a fact and is recorded; retail is a decision and is never
    -- moved automatically. Same rule as 0058.
    if v_cost is not null and v_line.product_id is not null then
      update public.products set cost = v_cost where id = v_line.product_id;
    end if;

    update public.purchase_order_lines
       set received_qty = received_qty + v_qty,
           unit_cost = coalesce(v_cost, unit_cost)
     where id = v_line.id;
    v_moved := v_moved + 1;
  end loop;

  select count(*)::int into v_left from public.purchase_order_lines
   where po_id = p_po_id and received_qty < qty;

  -- Only if something actually turned up. A receive with nothing on it must
  -- not move an order that is still fully outstanding to 'part'.
  if v_moved > 0 then
    update public.purchase_orders
       set status = case when v_left = 0 then 'received' else 'part' end
     where id = p_po_id;
  end if;

  return jsonb_build_object('lines_received', v_moved, 'lines_outstanding', v_left);
end;
$$;

grant execute on function public.pos_po_receive(text, text, uuid, jsonb)
  to anon, authenticated;

/** It is not coming. */
create or replace function public.pos_po_cancel(
  p_register_token text, p_pin text, p_po_id uuid, p_reason text default null
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  update public.purchase_orders
     set status = 'cancelled',
         note = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), note)
   where id = p_po_id and org_id = v_org and status in ('draft', 'sent');
  if not found then raise exception 'That order cannot be cancelled now'; end if;
end;
$$;

grant execute on function public.pos_po_cancel(text, text, uuid, text)
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- What the shop owes.
-- --------------------------------------------------------------------------

alter table public.supplier_documents
  add column if not exists due_date date,
  add column if not exists paid_at timestamptz,
  add column if not exists paid_amount numeric(12,2),
  add column if not exists paid_by_name text;

/**
 * Pay a supplier's invoice, in part or in full.
 *
 * A part payment is NOT a paid invoice. Payments accumulate, and the bill
 * only leaves the payables list once they cover it — otherwise handing over
 * R1000 against R4300 would make the remaining R3300 disappear, which is the
 * one number the shop most needs to still be able to see.
 */
create or replace function public.pos_supplier_mark_paid(
  p_register_token text, p_pin text, p_document_id uuid,
  p_amount numeric default null, p_due date default null
) returns public.supplier_documents
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid; v_user public.app_users; v_row public.supplier_documents;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  select * into v_user from public.app_users
   where org_id = v_org and pin_hash = crypt(p_pin, pin_hash) and active limit 1;

  select * into v_row from public.supplier_documents
   where id = p_document_id and org_id = v_org;
  if not found then raise exception 'Unknown document'; end if;
  if v_row.kind not in ('invoice', 'statement') then
    raise exception 'A % is not something the shop owes money against', v_row.kind;
  end if;

  if p_amount is not null and p_amount <= 0 then
    raise exception 'A payment has to be for something';
  end if;

  update public.supplier_documents
     set paid_amount = coalesce(paid_amount, 0)
                     + coalesce(p_amount,
                                coalesce(v_row.total, 0) - coalesce(paid_amount, 0)),
         paid_by_name = v_user.name,
         due_date = coalesce(p_due, due_date),
         paid_at = case
           when coalesce(paid_amount, 0)
              + coalesce(p_amount,
                         coalesce(v_row.total, 0) - coalesce(paid_amount, 0))
              >= coalesce(v_row.total, 0) then now() end
   where id = p_document_id
   returning * into v_row;
  return v_row;
end;
$$;

grant execute on function public.pos_supplier_mark_paid(text, text, uuid, numeric, date)
  to anon, authenticated;

/** When it is due. Set from the invoice, or from the supplier's terms. */
create or replace function public.pos_supplier_set_due(
  p_register_token text, p_pin text, p_document_id uuid, p_due date
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_org uuid;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');
  update public.supplier_documents set due_date = p_due
   where id = p_document_id and org_id = v_org;
  if not found then raise exception 'Unknown document'; end if;
end;
$$;

grant execute on function public.pos_supplier_set_due(text, text, uuid, date)
  to anon, authenticated;

/**
 * What is owed, and how late it is.
 *
 * The mirror of the debtors report. An invoice with no due date is still
 * owed — it is listed as undated rather than dropped, because a bill nobody
 * put a date on is exactly the one that gets forgotten. What is owed is the
 * total less anything already paid against it, not the total.
 */
create or replace function public.pos_supplier_payables(
  p_register_token text, p_pin text
) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_org uuid; v_rows jsonb; v_totals jsonb;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_purchasing');

  select coalesce(jsonb_agg(row order by (row->>'days_late')::int desc nulls last,
                            (row->>'outstanding')::numeric desc), '[]'::jsonb),
         jsonb_build_object(
           'total', coalesce(sum((row->>'outstanding')::numeric), 0),
           'overdue', coalesce(sum(case when (row->>'days_late')::int > 0
                                        then (row->>'outstanding')::numeric
                                        else 0 end), 0),
           'undated', count(*) filter (where row->>'due_date' is null),
           'documents', count(*))
    into v_rows, v_totals
    from (
      select jsonb_build_object(
        'id', d.id, 'supplier', s.name, 'supplier_id', s.id,
        'doc_number', d.doc_number, 'doc_date', d.doc_date,
        'due_date', d.due_date, 'total', coalesce(d.total, 0),
        'paid', coalesce(d.paid_amount, 0),
        'outstanding', coalesce(d.total, 0) - coalesce(d.paid_amount, 0),
        'days_late', case when d.due_date is null then null
                          else greatest(0, current_date - d.due_date) end,
        'status', d.status
      ) as row
      from public.supplier_documents d
      join public.suppliers s on s.id = d.supplier_id
     where d.org_id = v_org and d.kind = 'invoice' and d.paid_at is null
    ) t;

  return jsonb_build_object('rows', v_rows, 'totals', v_totals);
end;
$$;

grant execute on function public.pos_supplier_payables(text, text) to anon, authenticated;

-- PO-000001.
create or replace function public.next_doc_number(p_org uuid, p_doc_type text)
returns text language plpgsql set search_path = public, extensions as $$
declare v_seq public.doc_sequences;
begin
  -- New orgs get their sequences lazily.
  insert into public.doc_sequences (org_id, doc_type, prefix)
  values (p_org, p_doc_type,
          case p_doc_type when 'sale' then 'INV-' when 'quote' then 'QUO-'
                          when 'grv' then 'GRV-' when 'sku' then 'SKU-'
                          when 'delivery' then 'DEL-' when 'count' then 'CNT-'
                          when 'po' then 'PO-'
                          else 'CRN-' end)
  on conflict (org_id, doc_type) do nothing;

  select * into v_seq from public.doc_sequences
    where org_id = p_org and doc_type = p_doc_type for update;
  update public.doc_sequences set next_number = next_number + 1
    where org_id = p_org and doc_type = p_doc_type;
  return v_seq.prefix || lpad(v_seq.next_number::text, v_seq.pad_width, '0');
end;
$$;
