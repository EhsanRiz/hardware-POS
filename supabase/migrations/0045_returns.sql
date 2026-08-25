-- Return of sold goods, with a credit note to show for it.
--
-- A void reverses a whole sale and suits the same-shift mistake; a return is
-- the customer coming back — Tuesday, with the slip, with one burst bag out
-- of three. Different thing, different record: partial, repeatable up to what
-- was sold, and it moves money and stock in ways a void never did.
--
-- The rules, decided with the shop:
--   * void_refund takes returns, same right that voids — the manager called
--     to the counter, not a new permission.
--   * The refund method is decided by how the sale was paid, never chosen
--     off a menu. Cash, card and split sales refund CASH from the drawer —
--     the till cannot reverse a card — and that needs an open till session,
--     because money must not leave a drawer nobody is counting. Account
--     sales credit the account: the customer has not handed over cash, so
--     none can be handed back.
--   * Per line, the goods either go back to the shelf or are damaged.
--     Damaged is recorded on the credit note but never touches the count.
--   * No time limit. The manager holding the PIN is the policy; the credit
--     note records who and when, which is the accountability that matters.
--
-- The money is what was ACTUALLY paid: sale_items.line_total already carries
-- each line's share of every discount, so the refund reads off the invoice
-- rather than off today's price list. Cents cannot drift: a return of the
-- full remaining quantity refunds exactly what remains un-refunded on that
-- line, however the earlier partial refunds rounded.

alter type stock_reason add value if not exists 'return';

create table public.returns (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  sale_id       uuid not null references public.sales(id) on delete restrict,
  -- Copied from the sale so an account credit still knows its owner if the
  -- sale's customer link is ever edited.
  customer_id   uuid references public.customers(id) on delete set null,
  doc_number    text not null,
  reason        text not null,
  refund_method text not null check (refund_method in ('cash','account')),
  total         numeric(12,2) not null check (total > 0),
  tax_total     numeric(12,2) not null default 0,
  cash_session_id uuid references public.cash_sessions(id) on delete set null,
  by_user       uuid references public.app_users(id) on delete set null,
  by_name       text not null,
  created_at    timestamptz not null default now()
);
create index returns_sale_idx on public.returns (sale_id);
create index returns_org_idx  on public.returns (org_id, created_at desc);
create index returns_customer_idx on public.returns (customer_id)
  where customer_id is not null;

create table public.return_items (
  id            uuid primary key default gen_random_uuid(),
  return_id     uuid not null references public.returns(id) on delete cascade,
  sale_item_id  uuid not null references public.sale_items(id) on delete restrict,
  product_id    uuid references public.products(id) on delete set null,
  -- Copied like sale_items copies them: the credit note must still read
  -- correctly after the product is renamed or deleted.
  sku           text,
  name          text not null,
  unit_code     text not null default 'ea',
  qty           numeric(14,3) not null check (qty > 0),
  line_total    numeric(12,2) not null check (line_total >= 0),
  tax_amount    numeric(12,2) not null default 0,
  restock       boolean not null
);
create index return_items_return_idx on public.return_items (return_id);
create index return_items_sale_item_idx on public.return_items (sale_item_id);

alter table public.returns      enable row level security;
alter table public.return_items enable row level security;
-- No policies on purpose: reachable only through the functions below.

-- An account credit must reduce what the customer owes, and everything —
-- available credit, aging, the ledger — reads balance through this one
-- function, which is exactly why it is the one place the credit plugs in.
-- Same signature and return type: replace-in-place.
create or replace function public.customer_balance(p_customer_id uuid)
returns numeric language sql stable
set search_path = public, extensions as $$
  select round(
    coalesce((select opening_balance from public.customers
              where id = p_customer_id), 0)
    + coalesce((select sum(s.total)
                from public.sales s
                where s.customer_id = p_customer_id
                  and s.payment_method = 'account'
                  and s.status = 'completed'), 0)
    - coalesce((select sum(p.amount)
                from public.customer_payments p
                where p.customer_id = p_customer_id
                  and p.voided_at is null), 0)
    - coalesce((select sum(r.total)
                from public.returns r
                where r.customer_id = p_customer_id
                  and r.refund_method = 'account'), 0)
  , 2);
$$;

-- What has already gone back on this sale — the credit notes themselves for
-- reprinting, and per-line quantities so the screen can cap its steppers at
-- what remains. view_reports gates it: this is the sales screen's data, and
-- rendering the sheet must not require the right to act on it.
create function public.pos_sale_returns(
  p_register_token text,
  p_pin text,
  p_sale_id uuid
) returns table(id uuid, doc_number text, reason text, refund_method text,
                total numeric, tax_total numeric, by_name text,
                created_at timestamptz,
                sale_item_id uuid, item_name text, item_qty numeric,
                item_line_total numeric, item_restock boolean)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'view_reports');
  return query
    select r.id, r.doc_number, r.reason, r.refund_method, r.total, r.tax_total,
           r.by_name, r.created_at,
           i.sale_item_id, i.name, i.qty, i.line_total, i.restock
      from public.returns r
      join public.return_items i on i.return_id = r.id
     where r.sale_id = p_sale_id and r.org_id = v_user.org_id
     order by r.created_at, i.name;
end;
$$;
grant execute on function public.pos_sale_returns(text, text, uuid)
  to anon, authenticated;

-- The return itself. p_items: [{sale_item_id, qty, restock}].
--
-- Two passes on purpose: everything is validated and totalled before a row
-- is written, so the credit note header exists before its lines (the foreign
-- key insists) and a refusal on line three leaves nothing behind. The same
-- sale line may appear only once per return — besides being nonsense, a
-- duplicate would make the second pass disagree with the first.
create function public.pos_return_sale(
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
     total, tax_total, cash_session_id, by_user, by_name)
  values
    (v_user.org_id, p_sale_id, v_sale.customer_id,
     public.next_doc_number(v_user.org_id, 'credit'), trim(p_reason), v_method,
     v_total, v_tax, v_session_id, v_user.id, v_user.name)
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
grant execute on function public.pos_return_sale(text, text, uuid, jsonb, text)
  to anon, authenticated;

-- The return sheet points at sale LINES, so the lines need names — their ids.
-- Changed return columns, so drop-and-recreate (the rule this repo has been
-- bitten by twice). Clients read columns by name; the new id is one more key.
drop function public.pos_sale_items(text, uuid);
create function public.pos_sale_items(p_register_token text, p_sale_id uuid)
returns table(id uuid, name text, sku text, unit_code text, qty numeric,
              unit_price numeric, line_total numeric, tax_amount numeric,
              discount_amount numeric, discount_percent numeric,
              discount_reason text)
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select si.id, si.name, si.sku, si.unit_code, si.qty, si.unit_price,
           si.line_total, si.tax_amount, si.discount_amount,
           si.discount_percent, si.discount_reason
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
     where si.sale_id = p_sale_id and s.org_id = v_reg.org_id
     order by si.name;
end;
$$;
grant execute on function public.pos_sale_items(text, uuid) to anon, authenticated;
