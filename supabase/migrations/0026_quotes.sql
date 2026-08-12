-- Quotes that survive the walk to the bakkie.
--
-- The till has always been able to PRINT a quote, but printed was all it was:
-- nothing saved, so when the builder came back on Thursday waving the slip,
-- the whole order had to be rung up again from paper. A quote is only worth
-- giving if the shop can pick it up again by its number.
--
-- Prices are SNAPSHOTTED onto the quote, exactly as sale_items snapshots them
-- onto an invoice. What the shop promised is a fact about Tuesday, not a
-- pointer into the price list. On recall the till compares the snapshot with
-- today's prices and says so if anything moved — within the validity window
-- honouring the promise is the shop's decision to make, and it can only make
-- it if it can see the difference.

create table public.quotes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  doc_number    text,
  cashier_id    uuid,
  cashier_name  text not null,
  customer_id   uuid references public.customers(id),
  customer_name text,
  trade_pricing boolean not null default false,
  subtotal      numeric(12,2) not null,
  total         numeric(12,2) not null,
  status        text not null default 'open'
                check (status in ('open','converted','cancelled')),
  valid_until   date not null,
  note          text,
  -- Set when the quote becomes a sale, so the paper trail joins up.
  sale_id       uuid references public.sales(id),
  created_at    timestamptz not null default now()
);

create unique index quotes_org_doc_number_key
  on public.quotes (org_id, doc_number) where doc_number is not null;
create index quotes_org_open_idx
  on public.quotes (org_id, created_at desc) where status = 'open';

create table public.quote_items (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  product_id  uuid references public.products(id),
  sku         text,
  name        text not null,
  unit_code   text not null,
  qty         numeric(14,3) not null,
  unit_price  numeric(12,2) not null,
  line_total  numeric(12,2) not null
);

create index quote_items_quote_idx on public.quote_items (quote_id);

alter table public.quotes enable row level security;
alter table public.quote_items enable row level security;

/**
 * Save a quote. Anyone who can sell can quote — a quote is a sale that has
 * not happened yet, and gating it behind a manager would just mean it stays
 * on paper.
 */
create or replace function public.pos_save_quote(
  p_register_token text, p_cashier_id uuid, p_items jsonb,
  p_customer_id uuid default null, p_valid_days int default 14,
  p_note text default null
) returns table(quote_id uuid, doc_number text, valid_until date, total numeric)
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_customer public.customers;
  v_trade boolean := false; v_item jsonb; v_product public.products;
  v_qty numeric; v_price numeric; v_line numeric; v_subtotal numeric := 0;
  v_quote public.quotes;
begin
  v_reg := public.register_by_token(p_register_token);

  select * into v_user from public.app_users
   where id = p_cashier_id and org_id = v_reg.org_id and active and status = 'active';
  if not found then raise exception 'Unknown cashier'; end if;
  if not ('take_payments' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted to take payments';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'An empty quote is not a quote';
  end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers
     where id = p_customer_id and org_id = v_reg.org_id and active;
    if not found then raise exception 'Unknown customer'; end if;
    v_trade := v_customer.is_trade;
  end if;

  insert into public.quotes(org_id, doc_number, cashier_id, cashier_name,
    customer_id, customer_name, trade_pricing, subtotal, total, valid_until, note)
  values (v_reg.org_id, public.next_doc_number(v_reg.org_id, 'quote'),
    v_user.id, v_user.name, p_customer_id, v_customer.name, v_trade, 0, 0,
    current_date + greatest(1, least(coalesce(p_valid_days, 14), 90)),
    nullif(trim(coalesce(p_note, '')), ''))
  returning * into v_quote;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
     where id = (v_item->>'product_id')::uuid
       and org_id = v_reg.org_id and active;
    if not found then raise exception 'Unknown product on the quote'; end if;

    v_qty := round((v_item->>'qty')::numeric, 3);
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every line needs a quantity above zero';
    end if;

    v_price := public.price_for(v_product, v_trade);
    v_line := round(v_price * v_qty, 2);
    v_subtotal := v_subtotal + v_line;

    insert into public.quote_items(quote_id, product_id, sku, name, unit_code,
                                   qty, unit_price, line_total)
    values (v_quote.id, v_product.id, v_product.sku, v_product.name,
            v_product.unit_code, v_qty, v_price, v_line);
  end loop;

  update public.quotes set subtotal = v_subtotal, total = v_subtotal
   where id = v_quote.id returning * into v_quote;

  return query select v_quote.id, v_quote.doc_number, v_quote.valid_until,
                      v_quote.total;
end;
$$;

grant execute on function public.pos_save_quote(text, uuid, jsonb, uuid, int, text)
  to anon, authenticated;

/** Open quotes, newest first. Expiry is a fact the till presents, not a purge. */
create or replace function public.pos_list_quotes(
  p_register_token text, p_limit int default 50
) returns table(id uuid, doc_number text, created_at timestamptz,
                cashier_name text, customer_id uuid, customer_name text,
                total numeric, valid_until date, expired boolean,
                item_count int, note text)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select q.id, q.doc_number, q.created_at, q.cashier_name, q.customer_id,
           q.customer_name, q.total, q.valid_until, q.valid_until < current_date,
           (select count(*)::int from public.quote_items i where i.quote_id = q.id),
           q.note
      from public.quotes q
     where q.org_id = v_reg.org_id and q.status = 'open'
     order by q.created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

grant execute on function public.pos_list_quotes(text, int) to anon, authenticated;

/** One quote's lines, with today's price beside the promised one. */
create or replace function public.pos_quote_items(
  p_register_token text, p_quote_id uuid
) returns table(product_id uuid, sku text, name text, unit_code text,
                qty numeric, unit_price numeric, line_total numeric,
                price_now numeric, still_sold boolean)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_quote public.quotes;
begin
  v_reg := public.register_by_token(p_register_token);
  select * into v_quote from public.quotes
   where id = p_quote_id and org_id = v_reg.org_id;
  if not found then raise exception 'Unknown quote'; end if;

  return query
    select i.product_id, i.sku, i.name, i.unit_code, i.qty, i.unit_price,
           i.line_total,
           case when p.id is not null
                then public.price_for(p, v_quote.trade_pricing) end,
           p.id is not null and p.active
      from public.quote_items i
      left join public.products p on p.id = i.product_id
     where i.quote_id = p_quote_id
     order by i.name;
end;
$$;

grant execute on function public.pos_quote_items(text, uuid) to anon, authenticated;

/**
 * Close a quote: converted (with the sale it became) or cancelled.
 *
 * Converting is the cashier's ordinary act of ringing the sale; no extra
 * permission. The link to the sale is what makes the paper trail answer
 * "did that quote ever come back?"
 */
create or replace function public.pos_close_quote(
  p_register_token text, p_cashier_id uuid, p_quote_id uuid,
  p_status text, p_sale_id uuid default null
) returns void
language plpgsql security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_user public.app_users;
begin
  v_reg := public.register_by_token(p_register_token);

  select * into v_user from public.app_users
   where id = p_cashier_id and org_id = v_reg.org_id and active and status = 'active';
  if not found then raise exception 'Unknown cashier'; end if;

  if p_status not in ('converted','cancelled') then
    raise exception 'A quote closes as converted or cancelled';
  end if;
  if p_status = 'converted' and p_sale_id is null then
    raise exception 'A converted quote needs its sale';
  end if;

  update public.quotes
     set status = p_status, sale_id = p_sale_id
   where id = p_quote_id and org_id = v_reg.org_id and status = 'open';
  if not found then raise exception 'Quote already closed or unknown'; end if;
end;
$$;

grant execute on function public.pos_close_quote(text, uuid, uuid, text, uuid)
  to anon, authenticated;
