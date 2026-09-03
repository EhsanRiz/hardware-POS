-- 0050: money knows which till it crossed.
--
-- Account settlements and credit notes carried no register. The cash-up's
-- figures therefore counted every cash settlement in every open drawer, and
-- every account refund on every till: with two tills, R500 paid in at the
-- front counter made the yard's drawer expect R500 it never saw. One till
-- never noticed; the demo week with two did, the moment a stored expected
-- figure was compared with a recomputed one.
--
-- Both now record the register they were taken on, the figures filter by it,
-- and existing rows are backfilled from the session they were stamped with.
-- A row with no register at all (older than this and never stamped) keeps
-- counting everywhere, which is what it did before — visibly wrong beats
-- silently vanished.

alter table public.customer_payments
  add column if not exists register_id uuid references public.registers(id) on delete set null;
alter table public.returns
  add column if not exists register_id uuid references public.registers(id) on delete set null;

update public.customer_payments cp set register_id = cs.register_id
  from public.cash_sessions cs
 where cp.session_id = cs.id and cp.register_id is null;
update public.returns r set register_id = cs.register_id
  from public.cash_sessions cs
 where r.cash_session_id = cs.id and r.register_id is null;

-- Same signature as 0024: replaced in place. The one change is the register.
create or replace function public.pos_take_account_payment(
  p_register_token text, p_cashier_id uuid, p_customer_id uuid,
  p_amount numeric, p_method text default 'cash',
  p_reference text default null, p_note text default null,
  p_client_ref uuid default null
) returns table(payment_id uuid, balance numeric, available numeric)
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users;
  v_cust public.customers; v_id uuid; v_amount numeric;
begin
  v_reg := public.register_by_token(p_register_token);

  select * into v_user from public.app_users
   where app_users.id = p_cashier_id and org_id = v_reg.org_id
     and active and status = 'active';
  if not found then raise exception 'Unknown cashier'; end if;
  if not ('take_payments' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted to take payments';
  end if;

  select * into v_cust from public.customers
   where customers.id = p_customer_id and org_id = v_reg.org_id and active;
  if not found then raise exception 'Unknown customer'; end if;

  if p_client_ref is not null then
    select cp.id into v_id from public.customer_payments cp
     where cp.client_ref = p_client_ref and cp.org_id = v_reg.org_id;
    if found then
      return query select v_id, public.customer_balance(p_customer_id),
                          public.customer_available_credit(p_customer_id);
      return;
    end if;
  end if;

  v_amount := round(coalesce(p_amount, 0), 2);
  if v_amount <= 0 then raise exception 'A payment must be more than nothing'; end if;

  if p_method not in ('cash','card','eft','zapper') then
    raise exception 'Unknown payment method';
  end if;

  insert into public.customer_payments(org_id, customer_id, amount, method,
    reference, note, taken_by, taken_by_name, client_ref, register_id)
  values (v_reg.org_id, p_customer_id, v_amount, p_method,
    nullif(trim(coalesce(p_reference, '')), ''),
    nullif(trim(coalesce(p_note, '')), ''),
    v_user.id, v_user.name, p_client_ref, v_reg.id)
  returning customer_payments.id into v_id;

  return query select v_id, public.customer_balance(p_customer_id),
                      public.customer_available_credit(p_customer_id);
end;
$$;

-- Same signature as 0045: replaced in place, recording the register.
create or replace function public.pos_return_sale(
  p_register_token text,
  p_pin text,
  p_sale_id uuid,
  p_items jsonb,
  p_reason text
) returns table(return_id uuid, doc_number text, refund_method text,
                total numeric, tax_total numeric)
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_user public.app_users;
  v_reg public.registers;
  v_sale public.sales;
  v_method text;
  v_session_id uuid;
  v_item jsonb;
  v_line public.sale_items;
  v_qty numeric;
  v_restock boolean;
  v_prev_qty numeric;
  v_prev_total numeric;
  v_prev_tax numeric;
  v_line_refund numeric;
  v_line_tax numeric;
  v_total numeric := 0;
  v_tax numeric := 0;
  v_ret public.returns;
  v_frac boolean;
  v_seen uuid[] := '{}';
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'void_refund');
  v_reg := public.register_by_token(p_register_token);

  -- The lock serialises concurrent returns against the same sale, so the
  -- already-returned sums below cannot be read stale by two tills at once.
  select * into v_sale from public.sales s
   where s.id = p_sale_id and s.org_id = v_user.org_id for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status = 'voided' then
    raise exception 'This sale was voided — there is nothing left to return';
  end if;
  if v_sale.status <> 'completed' then
    raise exception 'Only a completed sale can take a return';
  end if;

  if trim(coalesce(p_reason, '')) = '' then
    raise exception 'A reason is required — it goes on the credit note';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Nothing to return';
  end if;

  -- How the money goes back is decided by how it came in.
  if v_sale.payment_method = 'account' then
    if v_sale.customer_id is null then
      raise exception 'This account sale has no customer to credit';
    end if;
    v_method := 'account';
  else
    v_method := 'cash';
    select cs.id into v_session_id from public.cash_sessions cs
     where cs.register_id = v_reg.id and cs.closed_at is null;
    if v_session_id is null then
      raise exception 'A cash refund needs the till session open — money cannot leave a drawer nobody is counting';
    end if;
  end if;

  -- Pass one: validate every line and total the refund. Nothing written yet.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_line from public.sale_items si
     where si.id = (v_item->>'sale_item_id')::uuid and si.sale_id = p_sale_id;
    if not found then raise exception 'That line is not on this sale'; end if;
    if v_line.id = any(v_seen) then
      raise exception '% appears twice on this return', v_line.name;
    end if;
    v_seen := v_seen || v_line.id;

    v_qty := (v_item->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'A returned quantity must be more than nothing';
    end if;

    select coalesce(u.allows_fraction, false) into v_frac
      from public.units_of_measure u where u.code = v_line.unit_code;
    if not v_frac and v_qty <> trunc(v_qty) then
      raise exception '% is sold whole and comes back whole', v_line.name;
    end if;

    select coalesce(sum(ri.qty), 0)
      into v_prev_qty
      from public.return_items ri
     where ri.sale_item_id = v_line.id;
    if v_qty > v_line.qty - v_prev_qty then
      raise exception 'Only % of % % left to return on %',
        v_line.qty - v_prev_qty, v_line.qty, v_line.unit_code, v_line.name;
    end if;

    if v_qty = v_line.qty - v_prev_qty then
      select v_line.line_total - coalesce(sum(ri.line_total), 0),
             v_line.tax_amount - coalesce(sum(ri.tax_amount), 0)
        into v_line_refund, v_line_tax
        from public.return_items ri
       where ri.sale_item_id = v_line.id;
    else
      v_line_refund := round(v_line.line_total * v_qty / v_line.qty, 2);
      v_line_tax    := round(v_line.tax_amount * v_qty / v_line.qty, 2);
    end if;

    v_total := v_total + v_line_refund;
    v_tax := v_tax + v_line_tax;
  end loop;

  if v_total <= 0 then
    raise exception 'This return refunds nothing';
  end if;

  -- The header first — the credit note the lines belong to.
  insert into public.returns
    (org_id, sale_id, customer_id, doc_number, reason, refund_method,
     total, tax_total, cash_session_id, register_id, by_user, by_name)
  values
    (v_user.org_id, p_sale_id, v_sale.customer_id,
     public.next_doc_number(v_user.org_id, 'credit'), trim(p_reason), v_method,
     v_total, v_tax, v_session_id, v_reg.id, v_user.id, v_user.name)
  returning * into v_ret;

  -- Pass two: the lines, and the shelf. Same arithmetic as pass one — the
  -- duplicate guard above is what makes that a fact rather than a hope,
  -- since nothing from THIS credit note is in the already-returned sums
  -- until the row that would double-count it is refused.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_line from public.sale_items si
     where si.id = (v_item->>'sale_item_id')::uuid and si.sale_id = p_sale_id;

    v_qty := (v_item->>'qty')::numeric;
    v_restock := coalesce((v_item->>'restock')::boolean, true);

    select coalesce(sum(ri.qty), 0), coalesce(sum(ri.line_total), 0),
           coalesce(sum(ri.tax_amount), 0)
      into v_prev_qty, v_prev_total, v_prev_tax
      from public.return_items ri
     where ri.sale_item_id = v_line.id
       and ri.return_id <> v_ret.id;

    if v_qty = v_line.qty - v_prev_qty then
      v_line_refund := v_line.line_total - v_prev_total;
      v_line_tax    := v_line.tax_amount - v_prev_tax;
    else
      v_line_refund := round(v_line.line_total * v_qty / v_line.qty, 2);
      v_line_tax    := round(v_line.tax_amount * v_qty / v_line.qty, 2);
    end if;

    insert into public.return_items
      (return_id, sale_item_id, product_id, sku, name, unit_code, qty,
       line_total, tax_amount, restock)
    values
      (v_ret.id, v_line.id, v_line.product_id, v_line.sku, v_line.name,
       v_line.unit_code, v_qty, v_line_refund, v_line_tax, v_restock);

    -- Back on the shelf only if it is fit to sell again; damaged goods are
    -- on the credit note but never in the count.
    if v_restock and v_line.product_id is not null then
      perform public.apply_stock(v_line.product_id, v_qty, 'return',
        'returns', v_ret.id, v_user, null);
    end if;
  end loop;

  -- Cash leaves the drawer through the same door as every other pay-out, so
  -- cash-up already knows how to count it.
  if v_method = 'cash' then
    insert into public.cash_movements
      (org_id, session_id, kind, amount, reason, by_user, by_name)
    values
      (v_user.org_id, v_session_id, 'pay_out', v_total,
       'Refund ' || v_ret.doc_number || ' (' || coalesce(v_sale.doc_number, 'no invoice') || ')',
       v_user.id, v_user.name);
  end if;

  return query select v_ret.id, v_ret.doc_number, v_ret.refund_method,
                      v_ret.total, v_ret.tax_total;
end;
$$;


-- The figures, filtered by register. Everything else as 0048 left it.
create or replace function public.cash_session_figures(p_session public.cash_sessions)
returns jsonb
language sql stable
set search_path to 'public', 'extensions'
as $$
  with win as (
    select p_session.opened_at as from_at,
           coalesce(p_session.closed_at, now()) as to_at
  ),
  s as (
    select sa.id, sa.total, sa.tax_amount, sa.discount_amount
      from public.sales sa, win
     where sa.org_id = p_session.org_id
       and sa.register_id is not distinct from p_session.register_id
       and sa.created_at >= win.from_at and sa.created_at <= win.to_at
       and sa.status = 'completed'
  ),
  tender as (
    select sp.method::text as method, sum(sp.amount) as amount
      from public.sale_payments sp join s on s.id = sp.sale_id
     group by 1
  ),
  acct as (
    select cp.method as method, sum(cp.amount) as amount
      from public.customer_payments cp, win
     where cp.org_id = p_session.org_id
       and cp.created_at >= win.from_at and cp.created_at <= win.to_at
       and cp.voided_at is null
       and (cp.register_id = p_session.register_id or cp.register_id is null)
     group by 1
  ),
  ret as (
    select count(*) as n, coalesce(sum(r.total), 0) as total
      from public.returns r, win
     where r.org_id = p_session.org_id
       and r.created_at >= win.from_at and r.created_at <= win.to_at
       and (r.register_id = p_session.register_id
            or (r.register_id is null
                and (r.cash_session_id = p_session.id or r.cash_session_id is null)))
  ),
  mv as (
    select coalesce(sum(amount) filter (where kind = 'pay_in'), 0)  as pay_in,
           coalesce(sum(amount) filter (where kind = 'pay_out'), 0) as pay_out
      from public.cash_movements where session_id = p_session.id
  )
  select jsonb_build_object(
    'sales_count',    (select count(*) from s),
    'sales_total',    (select coalesce(sum(total), 0) from s),
    'vat_total',      (select coalesce(sum(tax_amount), 0) from s),
    'discount_total', (select coalesce(sum(discount_amount), 0) from s),
    'tenders',        (select coalesce(jsonb_object_agg(method, amount), '{}'::jsonb) from tender),
    'cash_sales',     (select coalesce((select amount from tender where method = 'cash'), 0)),
    'account_cash',   (select coalesce((select amount from acct where method = 'cash'), 0)),
    'account_payments', (select coalesce(jsonb_object_agg(method, amount), '{}'::jsonb) from acct),
    'refunds_count',  (select n from ret),
    'refunds_total',  (select total from ret),
    'card_expected',  coalesce((select amount from tender where method = 'card'), 0)
                        + coalesce((select amount from acct where method = 'card'), 0),
    'eft_expected',   coalesce((select amount from tender where method = 'eft'), 0)
                        + coalesce((select amount from acct where method = 'eft'), 0),
    'pay_in',         (select pay_in from mv),
    'pay_out',        (select pay_out from mv),
    'expected_cash',  p_session.opening_float
                        + coalesce((select amount from tender where method = 'cash'), 0)
                        + coalesce((select amount from acct where method = 'cash'), 0)
                        + (select pay_in from mv)
                        - (select pay_out from mv)
  );
$$;
