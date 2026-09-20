/*
 * Pipe is sold as a 6 m length AND cut to size, at different money.
 *
 * From the counter at 5 Star Hardware: a length of 20 mm pipe goes out whole
 * at one price, and cut to 2.4 m at another — dearer per metre, because of the
 * labour and the offcut. Wire is the same story off a drum: a 25 m bundle, a
 * 50 m bundle, or however many metres somebody asks for.
 *
 * WHAT ONE PRICE MEANS, WHICH IS THE WHOLE DESIGN. `price_retail` and
 * `price_trade` keep the meaning they have always had for an ordinary item:
 * the price of ONE of whatever the item is. For an item sold in packs, one of
 * it IS the pack — one 6 m length — so those two columns need no migration and
 * no reinterpretation. What is new is the pair beside them, `price_cut_retail`
 * and `price_cut_trade`, which are per BASE unit (per metre). Four prices,
 * which is only the two this shop already had, twice: retail and trade, whole
 * and cut. price_cut_for() mirrors price_for() exactly so the two can never
 * drift apart on what "trade" means.
 *
 * WHY qty STAYS IN THE UNIT SOLD, and this is the part that looked wrong at
 * first and is not. The tempting model is to hold every line in metres: a 6 m
 * length becomes qty 6 at the per-metre rate. It breaks on money. A length at
 * R181 is R30.1666… per metre, which rounds to R30.17, and six of those is
 * R181.02 — the shop would overcharge two cents on a price it never set. So a
 * pack line is qty 2, unit_price R181, line_total R362, exact. The invoice
 * also then reads the way the sale happened: "2 x 6 m length", not "12 m".
 *
 * Which leaves stock, which genuinely is metres, and that is what `base_qty`
 * is for: qty x pack_size, written once at sale time and used by every stock
 * path afterwards. Money reads qty; the shelf reads base_qty. Neither has to
 * know how the other counts.
 *
 * STOCK IS COUNTED IN THE BASE UNIT for an item sold in packs — metres of
 * pipe, not lengths — because one pool has to serve both ways of selling. This
 * migration does NOT convert anybody's existing stock figure: a product with
 * stock_qty 20 that becomes a pack item still reads 20, and whether that meant
 * twenty lengths or twenty metres is not something a migration can know. The
 * editor says so on screen when the box is ticked and a human fixes it.
 * Silently multiplying a shop's stock by six is the kind of helpfulness that
 * loses somebody a day of counting.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: let the till name a price. The mode
 * travels on the line — 'pack' or 'unit' — and the server looks the price up
 * from the catalogue, exactly as it did before. 0061's rule stands: only a
 * 'delivery' line may carry a price the counter typed, and an ordinary goods
 * line still cannot be repriced from a till. A feature that let a cashier
 * choose a price for cut goods would have been half the work and would have
 * put every cut sale beyond audit.
 *
 * THE OFFCUT, said plainly because the shop should decide it rather than
 * discover it: cutting 2.4 m off a 6 m length leaves 3.6 m that this model
 * counts as still being in stock. For wire off a drum that is true. For rigid
 * pipe it is true only if the offcut goes back on the rack and gets sold. If
 * offcuts are scrapped, the shop is losing that length and stock will read
 * high until a count corrects it. Tracking individual offcuts is a different
 * and much larger feature, and no small shop I know of does it.
 */

-- 1. The catalogue ------------------------------------------------------------

alter table public.products
  add column if not exists sold_in_packs boolean not null default false,
  -- How many base units in one pack: 6 for a 6 m length, 25 for a bundle.
  add column if not exists pack_size numeric(14,3),
  -- What one pack is CALLED at the counter and on the slip. "6 m length" reads
  -- like the shop talks; "1 pack (6 m)" does not.
  add column if not exists pack_label text,
  -- Per base unit, when the thing is cut rather than sold whole.
  add column if not exists price_cut_retail numeric(12,2),
  add column if not exists price_cut_trade numeric(12,2);

alter table public.products
  add constraint products_pack_shape check (
    not sold_in_packs
    or (pack_size is not null and pack_size > 0
        and nullif(trim(coalesce(pack_label, '')), '') is not null
        and price_cut_retail is not null and price_cut_retail >= 0)
  );

alter table public.products
  add constraint products_cut_prices_nonneg check (
    (price_cut_retail is null or price_cut_retail >= 0)
    and (price_cut_trade is null or price_cut_trade >= 0)
  );

-- 2. What a line remembers ----------------------------------------------------
--
-- Copied onto the line, not joined, for the reason the name and SKU already
-- are (0004): the invoice must still read correctly after somebody renames the
-- product or changes its pack size next season.

alter table public.sale_items
  add column if not exists sold_as text not null default 'unit'
    check (sold_as in ('unit', 'pack')),
  add column if not exists pack_size numeric(14,3),
  add column if not exists pack_label text,
  -- What the shelf gives up. Null only until the backfill below runs.
  add column if not exists base_qty numeric(14,3);

update public.sale_items set base_qty = qty where base_qty is null;
alter table public.sale_items alter column base_qty set not null;

alter table public.quote_items
  add column if not exists sold_as text not null default 'unit'
    check (sold_as in ('unit', 'pack')),
  add column if not exists pack_size numeric(14,3),
  add column if not exists pack_label text;

-- 3. The price of a cut ------------------------------------------------------
--
-- Deliberately shaped like price_for (0002): one place that decides what a
-- trade customer pays, so the till, a quote and a report cannot disagree.

create or replace function public.price_cut_for(
  p_product public.products, p_trade boolean
) returns numeric language sql immutable as $$
  select case
    when p_trade and p_product.price_cut_trade is not null then p_product.price_cut_trade
    else p_product.price_cut_retail
  end;
$$;

revoke execute on function public.price_cut_for(public.products, boolean)
  from anon, authenticated, public;

/**
 * How a line is sold: 'pack' or 'unit'.
 *
 * Absent means 'unit', which is what every line in the database was before
 * this migration and what every ordinary product still is. So an old till that
 * has not been updated yet sends no mode and gets exactly the behaviour it
 * always had — this is additive at the wire, not a flag day.
 */
create or replace function public.line_sold_as(
  p_product public.products, p_item jsonb
) returns text language plpgsql immutable set search_path = public, extensions as $$
declare v_mode text;
begin
  v_mode := nullif(trim(coalesce(p_item->>'sold_as', '')), '');
  if v_mode is null then return 'unit'; end if;
  if v_mode not in ('pack', 'unit') then
    raise exception 'A line is sold whole or cut, not "%"', v_mode;
  end if;
  -- Asking for a pack of something that does not come in packs is a till and a
  -- catalogue that disagree, and the sale must stop rather than guess which is
  -- right. Guessing here would price a length at the per-metre rate.
  if v_mode = 'pack' and not coalesce(p_product.sold_in_packs, false) then
    raise exception '% is not sold as a whole pack', p_product.name;
  end if;
  return v_mode;
end;
$$;

revoke execute on function public.line_sold_as(public.products, jsonb)
  from anon, authenticated, public;

/**
 * What one of this line costs: whole, or cut.
 *
 * Its own function because a sale is not the only thing that prices a line — a
 * QUOTE does too, and prices through price_for directly rather than through
 * line_price (0052). Left alone, a quote would have offered cut pipe at the
 * length price and the customer would have arrived expecting it. Putting the
 * whole-or-cut decision in one place is the same rule price_for was written
 * for in 0002: "One place, so the till, quotes and reports can never disagree
 * about what trade price means."
 *
 * Deliveries are not this function's business. They are priced by the counter
 * and that is line_price's branch, above this one.
 */
create or replace function public.goods_price(
  p_product public.products, p_trade boolean, p_item jsonb
) returns numeric
language plpgsql stable set search_path = public, extensions as $$
declare v_price numeric;
begin
  if public.line_sold_as(p_product, p_item) = 'unit'
     and coalesce(p_product.sold_in_packs, false) then
    v_price := public.price_cut_for(p_product, p_trade);
    -- The catalogue constraint makes this unreachable for a well-formed
    -- product, and it stays because "unreachable" is a claim about today's
    -- constraints. A null here would otherwise become a free line.
    if v_price is null then
      raise exception '% has no cut price set', p_product.name;
    end if;
    return v_price;
  end if;

  -- A whole pack, or an ordinary item: the price of one of it, as always.
  return public.price_for(p_product, p_trade);
end;
$$;

revoke execute on function public.goods_price(public.products, boolean, jsonb)
  from anon, authenticated, public;

/**
 * Rebuilt from 0061. Same signature — the mode rides on the line JSON the
 * function already receives, so nothing about who may call this changes.
 *
 * The order matters: a delivery line still gets to name its price, and that
 * check comes first so this cannot become a second way to reprice goods.
 */
create or replace function public.line_price(
  p_product public.products, p_trade boolean, p_item jsonb
) returns numeric
language plpgsql stable set search_path = public, extensions as $$
declare v_asked numeric;
begin
  if coalesce(p_product.kind, 'goods') <> 'goods' then
    v_asked := nullif(p_item->>'unit_price', '')::numeric;
    if v_asked is null then return public.price_for(p_product, p_trade); end if;
    if v_asked < 0 then raise exception 'A price cannot be negative'; end if;
    return round(v_asked, 2);
  end if;
  return public.goods_price(p_product, p_trade, p_item);
end;
$$;

-- 4. Stock moves in base units ------------------------------------------------
--
-- Same signature, body only: the shelf gives up metres whether the counter
-- sold a length or a cut, and base_qty is the line's own record of how many.

create or replace function public.settle_stock_for_sale(
  p_sale_id uuid, p_direction int, p_reason stock_reason, p_user public.app_users
) returns void language plpgsql set search_path = public, extensions as $$
declare r record;
begin
  for r in select product_id, base_qty from public.sale_items
           where sale_id = p_sale_id and product_id is not null loop
    perform public.apply_stock(r.product_id, p_direction * r.base_qty, p_reason,
                               'sales', p_sale_id, p_user, null);
  end loop;
end;
$$;

-- 5. The sale ----------------------------------------------------------------
--
-- Rebuilt verbatim from 0096 with three changes and nothing else touched: the
-- mode is read once per line, quantity and stock are judged against it, and
-- the line records how it was sold. Same signature, so this is a replace and
-- no old version is left standing beside it.
--
-- The discount walk below re-derives the price through line_price and works in
-- units-sold, which is the same arithmetic it always did: a pack line is 2 at
-- the pack price, a cut line 2.4 at the per-metre price. Only stock cares
-- about base units, and only settle_stock_for_sale reads them.

create or replace function public.pos_create_sale(
  p_register_token text, p_cashier_id uuid, p_items jsonb,
  p_customer_id uuid default null, p_payment_method text default 'cash',
  p_discount_amount numeric default 0, p_discount_reason text default null,
  p_approved_by uuid default null, p_amount_tendered numeric default null,
  p_paid_cash numeric default null, p_paid_card numeric default null,
  p_client_ref uuid default null, p_created_at timestamptz default null,
  p_note text default null, p_payments jsonb default null,
  p_po_number text default null, p_customer_vat_number text default null,
  p_approval_code text default null, p_doc_number text default null
) returns public.sales
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_approver public.app_users;
  v_customer public.customers; v_trade boolean := false; v_item jsonb;
  v_product public.products; v_unit public.units_of_measure;
  v_qty numeric(14,3); v_price numeric(12,2); v_subtotal numeric(12,2) := 0;
  v_total numeric(12,2); v_tax_total numeric(12,2) := 0; v_status sale_status;
  v_sale public.sales; v_line numeric(12,2); v_share numeric(12,2);
  v_rate numeric(6,4); v_existing public.sales; v_available numeric;
  v_at timestamptz; v_payments jsonb; v_pay jsonb;
  v_cash numeric(12,2) := 0; v_non_cash numeric(12,2) := 0;
  v_account numeric(12,2) := 0; v_paid numeric(12,2) := 0;
  v_rounding numeric(12,2) := 0; v_methods text[]; v_summary text;
  v_line_disc numeric(12,2); v_line_pct numeric(6,3);
  v_items_disc numeric(12,2) := 0; v_net_subtotal numeric(12,2) := 0;
  v_all_disc numeric(12,2);
  v_cap numeric(12,2); v_taken numeric(12,2);
  v_within boolean;
  v_code public.approval_codes;
  v_line_reason text;
  v_doc text;
  v_sold_as text; v_base numeric(14,3); v_pack numeric(14,3);
begin
  v_reg := public.register_by_token(p_register_token);
  perform public.register_touch(v_reg.id);

  if p_client_ref is not null then
    -- Scoped to the shop: the constraint is (org_id, client_ref) since 0013,
    -- so the same ref can legitimately exist in two shops, and without this
    -- clause a matching ref handed back another shop's whole sale row.
    select * into v_existing from public.sales
     where client_ref = p_client_ref and org_id = v_reg.org_id;
    if found then return v_existing; end if;
  end if;

  -- 0096: a number the till gave itself, from a block reserved here. It has
  -- to be this till's and unspent, or the slip in the customer's hand names
  -- an invoice the shop never issued.
  v_doc := public.claim_doc_number(v_reg, 'sale', p_doc_number);

  -- Somebody who can sign in AND may take payments. Both were here in 0012
  -- and 0019 and went missing in 0039, so a register token alone could post
  -- a numbered, stock-moving invoice under any name on the roster —
  -- somebody who never enrolled included.
  select * into v_user from public.app_users
   where id = p_cashier_id and org_id = v_reg.org_id
     and active and status = 'active';
  if not found then raise exception 'Unknown cashier'; end if;
  if not ('take_payments' = any(public.effective_permissions(v_user))) then
    raise exception 'Not permitted: take_payments';
  end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers
     where id = p_customer_id and org_id = v_reg.org_id;
    if not found then raise exception 'Unknown customer'; end if;
    v_trade := v_customer.is_trade;
  end if;

  -- The till's own clock, for a sale taken offline and replayed later — but
  -- bounded, as 0012 and 0019 had it before 0039 dropped the clamp: a
  -- caller could otherwise file a sale into a closed cash-up or VAT month,
  -- or a future one, and stretch the approval-code window with it.
  v_at := coalesce(p_created_at, now());
  if v_at > now() + interval '5 minutes' or v_at < now() - interval '30 days' then
    v_at := now();
  end if;

  v_payments := p_payments;
  if v_payments is null or jsonb_array_length(v_payments) = 0 then
    if coalesce(p_paid_cash, 0) > 0 or coalesce(p_paid_card, 0) > 0 then
      v_payments := '[]'::jsonb;
      if coalesce(p_paid_cash, 0) > 0 then
        v_payments := v_payments || jsonb_build_array(
          jsonb_build_object('method', 'cash', 'amount', p_paid_cash));
      end if;
      if coalesce(p_paid_card, 0) > 0 then
        v_payments := v_payments || jsonb_build_array(
          jsonb_build_object('method', 'card', 'amount', p_paid_card));
      end if;
    else
      v_payments := jsonb_build_array(
        jsonb_build_object('method', coalesce(p_payment_method, 'cash'), 'amount', null));
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
     where id = (v_item->>'product_id')::uuid and org_id = v_reg.org_id and active
     for update;
    if not found then raise exception 'Product not available'; end if;
    select * into v_unit from public.units_of_measure where code = v_product.unit_code;
    v_qty := (v_item->>'qty')::numeric;
    if v_qty <= 0 then raise exception 'Invalid quantity for %', v_product.name; end if;

    -- Whole or cut, and what the shelf gives up either way. 0107.
    v_sold_as := public.line_sold_as(v_product, v_item);
    v_pack := case when v_sold_as = 'pack' then v_product.pack_size else null end;
    v_base := v_qty * coalesce(v_pack, 1);

    -- A pack is the thing that cannot be split, whatever its base unit allows:
    -- pipe is measured in metres and metres divide, but two and a half 6 m
    -- LENGTHS is not an order anybody can pick off a rack. For a cut line, and
    -- for every ordinary item, the unit decides exactly as it did before.
    if v_sold_as = 'pack' then
      if v_qty <> trunc(v_qty) then
        raise exception '% is sold as a % and cannot be split',
          v_product.name, coalesce(v_product.pack_label, 'whole pack');
      end if;
    elsif not v_unit.allows_fraction and v_qty <> trunc(v_qty) then
      raise exception '% is sold per % and cannot be split', v_product.name, v_unit.name;
    end if;

    -- Stock is counted in the base unit, so the comparison has to be too: two
    -- 6 m lengths is twelve metres off the shelf, and checking the 2 would sell
    -- stock the shop has not got.
    if v_product.stock_qty is not null and v_product.stock_qty < v_base then
      raise exception 'Not enough stock for % (% % on hand)',
        v_product.name, v_product.stock_qty, v_product.unit_code;
    end if;
    v_price := public.line_price(v_product, v_trade, v_item);
    v_line := round(v_price * v_qty, 2);

    v_line_pct := nullif(v_item->>'discount_percent', '')::numeric;
    if v_line_pct is not null then
      if v_line_pct <= 0 or v_line_pct > 100 then
        raise exception 'A line discount of %%% is not a discount', v_line_pct;
      end if;
      v_line_disc := round(v_line * v_line_pct / 100, 2);
    else
      v_line_disc := round(coalesce(nullif(v_item->>'discount_amount', '')::numeric, 0), 2);
    end if;
    if v_line_disc < 0 then raise exception 'A discount cannot be negative'; end if;
    if v_line_disc > v_line then
      raise exception 'Discount on % is more than the line comes to', v_product.name;
    end if;

    v_subtotal := v_subtotal + v_line;
    v_items_disc := v_items_disc + v_line_disc;
  end loop;

  if v_subtotal <= 0 then raise exception 'Empty sale'; end if;

  v_net_subtotal := v_subtotal - v_items_disc;
  if p_discount_amount > v_net_subtotal then
    raise exception 'Discount exceeds the sale total';
  end if;

  v_all_disc := round(v_items_disc + p_discount_amount, 2);
  v_total := v_subtotal - v_all_disc;

  -- Both ceilings walk the lines together: the item cap refuses whoever asks,
  -- the percent limit only decides whether a manager is fetched.
  v_within := v_user.discount_limit_percent is not null
           or v_user.discount_limit_amount is not null;

  if v_user.discount_limit_amount is not null
     and v_all_disc > v_user.discount_limit_amount + 0.005 then
    v_within := false;
  end if;

  if v_all_disc > 0 then
    for v_item in select * from jsonb_array_elements(p_items) loop
      select * into v_product from public.products
       where id = (v_item->>'product_id')::uuid;

      v_qty := (v_item->>'qty')::numeric;
      v_line := round(public.line_price(v_product, v_trade, v_item) * v_qty, 2);
      v_line_pct := nullif(v_item->>'discount_percent', '')::numeric;
      if v_line_pct is not null then
        v_line_disc := round(v_line * v_line_pct / 100, 2);
      else
        v_line_disc := round(coalesce(nullif(v_item->>'discount_amount', '')::numeric, 0), 2);
      end if;
      v_share := case
        when v_net_subtotal > 0
          then round((v_line - v_line_disc) * v_total / v_net_subtotal, 2)
        else 0 end;
      v_taken := v_line - v_share;

      if v_within and v_user.discount_limit_percent is not null
         and v_taken > round(v_line * v_user.discount_limit_percent / 100, 2) + 0.005
      then
        v_within := false;
      end if;

      if v_product.max_discount_percent is null
         and v_product.max_discount_amount is null then
        continue;
      end if;

      v_cap := least(
        case when v_product.max_discount_percent is not null
             then round(v_line * v_product.max_discount_percent / 100, 2) end,
        case when v_product.max_discount_amount is not null
             then round(v_product.max_discount_amount * v_qty, 2) end);

      -- Checked before any approval is considered, so no code can lift it.
      if v_taken > v_cap + 0.005 then
        raise exception
          '% is capped at % off and this sale takes % off it. Lower the discount.',
          v_product.name, to_char(v_cap, 'FM999999990.00'),
          to_char(v_taken, 'FM999999990.00');
      end if;
    end loop;
  end if;

  -- Who says this discount may happen. Four ways, in the order they are looked
  -- for: the cashier approves their own; a manager stood at the till and typed
  -- a PIN; a manager issued a code and read it over the phone; or it is inside
  -- the cashier's standing limit and nobody was asked at all.
  v_status := 'completed';
  if v_all_disc > 0 then
    if 'approve_discount' = any(public.effective_permissions(v_user)) then
      v_approver := v_user;
    elsif p_approved_by is not null then
      select * into v_approver from public.app_users
       where id = p_approved_by and org_id = v_reg.org_id and active;
      if not found
         or not ('approve_discount' = any(public.effective_permissions(v_approver)))
      then v_approver := null; end if;
    end if;

    if v_approver.id is null and p_approval_code is not null then
      -- Locked, because two tills racing on the same overheard code must not
      -- both win: the second finds it used and is refused.
      select * into v_code from public.approval_codes c
       where c.org_id = v_reg.org_id and c.used_at is null
         and c.expires_at >= v_at
         and v_at > now() - interval '1 day'
         and c.code_hash = crypt(p_approval_code, c.code_hash)
       limit 1
       for update;

      if v_code.id is null then
        raise exception
          'That approval code was not accepted. It may have expired or already been used.';
      end if;
      if v_code.max_amount is not null and v_all_disc > v_code.max_amount + 0.005 then
        raise exception 'That code releases up to %, and this discount is %.',
          to_char(v_code.max_amount, 'FM999999990.00'),
          to_char(v_all_disc, 'FM999999990.00');
      end if;

      -- The approver is the manager who ISSUED the code, not the cashier who
      -- typed it. Anything else would put the counter hand's name against a
      -- decision they did not make.
      select * into v_approver from public.app_users where id = v_code.issued_by;
    end if;

    if v_approver.id is null and not v_within then
      v_status := 'pending_approval';
    end if;
  end if;

  for v_pay in select * from jsonb_array_elements(v_payments) loop
    if (v_pay->>'amount') is null then continue; end if;
    if (v_pay->>'method') = 'cash' then
      v_cash := v_cash + (v_pay->>'amount')::numeric;
    else
      v_non_cash := v_non_cash + (v_pay->>'amount')::numeric;
      if (v_pay->>'method') = 'account' then
        v_account := v_account + (v_pay->>'amount')::numeric;
      end if;
    end if;
  end loop;
  v_paid := v_cash + v_non_cash;

  if exists (select 1 from jsonb_array_elements(v_payments) e
              where e->>'method' = 'cash')
  then
    v_rounding := public.cash_rounding(v_total - v_non_cash);
  end if;

  if v_status = 'completed' and v_paid > 0
     and abs(v_paid - (v_total + v_rounding)) > 0.005 then
    raise exception 'Payments of % do not settle % (rounding %)',
      v_paid, v_total, v_rounding;
  end if;

  if v_account > 0 and v_status = 'completed' then
    if p_customer_id is null then raise exception 'An account sale needs a customer'; end if;
    v_available := public.customer_available_credit(p_customer_id);
    if v_available is not null and v_account > v_available then
      raise exception 'Over credit limit: % available', round(v_available, 2);
    end if;
  end if;
  if p_payment_method = 'account' and p_customer_id is null then
    raise exception 'An account sale needs a customer';
  end if;

  select array_agg(distinct e->>'method') into v_methods
    from jsonb_array_elements(v_payments) e;
  v_summary := case
    when v_methods is null or array_length(v_methods, 1) = 0 then coalesce(p_payment_method, 'cash')
    when array_length(v_methods, 1) = 1 then v_methods[1]
    else 'mixed' end;

  insert into public.sales(
    org_id, doc_number, cashier_id, cashier_name, customer_id, customer_name,
    trade_pricing, subtotal, discount_amount, discount_reason, tax_amount,
    total, status, payment_method, amount_tendered, change_due, paid_cash,
    paid_card, client_ref, note, register_id, created_at, approved_by,
    approved_by_name, po_number, customer_vat_number, customer_address, rounding)
  values (
    v_reg.org_id,
    case when v_status = 'completed'
         then coalesce(v_doc, public.next_doc_number(v_reg.org_id, 'sale')) end,
    v_user.id, v_user.name, p_customer_id, v_customer.name, v_trade,
    v_subtotal, v_all_disc, p_discount_reason, 0, v_total, v_status,
    v_summary::payment_method, p_amount_tendered,
    case when p_amount_tendered is not null
         then greatest(p_amount_tendered - greatest(v_cash, 0), 0) end,
    nullif(v_cash, 0), nullif(v_non_cash, 0), p_client_ref, p_note, v_reg.id, v_at,
    v_approver.id, v_approver.name,
    nullif(trim(coalesce(p_po_number, '')), ''),
    coalesce(nullif(trim(coalesce(p_customer_vat_number, '')), ''), v_customer.vat_number),
    v_customer.address,
    v_rounding)
  returning * into v_sale;

  -- Spent, and pointed at the sale it released.
  if v_code.id is not null then
    update public.approval_codes
       set used_at = now(), used_by = v_user.id, used_on_sale = v_sale.id
     where id = v_code.id;
  end if;

  for v_pay in select * from jsonb_array_elements(v_payments) loop
    if (v_pay->>'amount') is null then continue; end if;
    if round((v_pay->>'amount')::numeric, 2) = 0 then continue; end if;
    insert into public.sale_payments(org_id, sale_id, method, amount, reference)
    values (v_reg.org_id, v_sale.id, (v_pay->>'method')::payment_method,
            round((v_pay->>'amount')::numeric, 2), v_pay->>'reference');
  end loop;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
     where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::numeric;
    v_price := public.line_price(v_product, v_trade, v_item);
    v_line := round(v_price * v_qty, 2);

    v_line_pct := nullif(v_item->>'discount_percent', '')::numeric;
    if v_line_pct is not null then
      v_line_disc := round(v_line * v_line_pct / 100, 2);
    else
      v_line_disc := round(coalesce(nullif(v_item->>'discount_amount', '')::numeric, 0), 2);
    end if;

    -- Bounded, because this is free text off a till and nothing downstream
    -- wants a paragraph. Kept only where there is a discount for it to explain:
    -- a reason attached to a line that was never marked down is a note about
    -- nothing, and it would read on a reprint as though money had come off.
    v_line_reason := nullif(trim(coalesce(left(v_item->>'discount_reason', 200), '')), '');
    if v_line_disc <= 0 then v_line_reason := null; end if;

    v_share := case
      when v_net_subtotal > 0
        then round((v_line - v_line_disc) * v_total / v_net_subtotal, 2)
      else 0 end;

    v_rate := coalesce(public.tax_rate_at(v_product.tax_code, v_at::date), 0);
    insert into public.sale_items(sale_id, product_id, sku, name, unit_code,
      qty, unit_price, line_total, tax_code, tax_rate, tax_amount, cost_at_sale,
      discount_amount, discount_percent, discount_reason,
      sold_as, pack_size, pack_label, base_qty)
    values (v_sale.id, v_product.id, v_product.sku, v_product.name,
      v_product.unit_code, v_qty, v_price, v_share, v_product.tax_code, v_rate,
      round(v_share - (v_share / (1 + v_rate)), 2), v_product.cost,
      v_line_disc, v_line_pct, v_line_reason,
      v_sold_as, v_pack,
      case when v_sold_as = 'pack' then v_product.pack_label else null end,
      v_qty * coalesce(v_pack, 1));
  end loop;

  select coalesce(sum(tax_amount), 0) into v_tax_total
    from public.sale_items where sale_id = v_sale.id;
  update public.sales set tax_amount = v_tax_total where id = v_sale.id
    returning * into v_sale;

  if v_status = 'completed' then
    perform public.settle_stock_for_sale(v_sale.id, -1, 'sale', v_user);
  end if;
  return v_sale;
end;
$$;

-- 6. A quote quotes the same two ways ----------------------------------------
--
-- Same signature: the mode rides on p_items, as it does for a sale. The one
-- real change is that pricing now goes through goods_price rather than
-- price_for — see the note on that function for why a quote had to move.

create or replace function public.pos_save_quote(
  p_register_token text, p_cashier_id uuid, p_items jsonb,
  p_customer_id uuid default null, p_valid_days int default 14,
  p_note text default null, p_customer_name text default null
) returns table(quote_id uuid, doc_number text, valid_until date, total numeric)
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_customer public.customers;
  v_trade boolean := false; v_item jsonb; v_product public.products;
  v_qty numeric; v_price numeric; v_line numeric; v_subtotal numeric := 0;
  v_quote public.quotes; v_name text; v_sold_as text; v_pack numeric(14,3);
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

  -- The account's name when there is an account; otherwise whatever the
  -- counter was told. An account customer's quote keeps the account's name so
  -- the list, the statement and the paper agree on who this is.
  v_name := nullif(left(trim(coalesce(p_customer_name, '')), 120), '');
  if p_customer_id is not null then
    select * into v_customer from public.customers
     where id = p_customer_id and org_id = v_reg.org_id and active;
    if not found then raise exception 'Unknown customer'; end if;
    v_trade := v_customer.is_trade;
    v_name := v_customer.name;
  end if;

  insert into public.quotes(org_id, doc_number, cashier_id, cashier_name,
    customer_id, customer_name, trade_pricing, subtotal, total, valid_until, note)
  values (v_reg.org_id, public.next_doc_number(v_reg.org_id, 'quote'),
    v_user.id, v_user.name, p_customer_id, v_name, v_trade, 0, 0,
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

    v_sold_as := public.line_sold_as(v_product, v_item);
    v_pack := case when v_sold_as = 'pack' then v_product.pack_size else null end;
    v_price := public.goods_price(v_product, v_trade, v_item);
    v_line := round(v_price * v_qty, 2);
    v_subtotal := v_subtotal + v_line;

    if v_sold_as = 'pack' and v_qty <> trunc(v_qty) then
      raise exception '% is quoted as a % and cannot be split',
        v_product.name, coalesce(v_product.pack_label, 'whole pack');
    end if;
    insert into public.quote_items(quote_id, product_id, sku, name, unit_code,
                                   qty, unit_price, line_total,
                                   sold_as, pack_size, pack_label)
    values (v_quote.id, v_product.id, v_product.sku, v_product.name,
            v_product.unit_code, v_qty, v_price, v_line,
            v_sold_as, v_pack,
            case when v_sold_as = 'pack' then v_product.pack_label else null end);
  end loop;

  update public.quotes set subtotal = v_subtotal, total = v_subtotal
   where id = v_quote.id returning * into v_quote;

  return query select v_quote.id, v_quote.doc_number, v_quote.valid_until,
                      v_quote.total;
end;
$$;

-- 7. A return puts back what the sale took -----------------------------------
--
-- Refunds were already right and are untouched: a return is priced pro-rata
-- from the ORIGINAL line (line_total * qty / qty), so it inherits whichever
-- price that sale used without having to know which it was. Stock was not
-- right — apply_stock was handed the units sold — and a returned length would
-- have put one metre back for every six it took.

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
    -- A length went out whole and comes back whole. The unit would allow a
    -- fraction here — pipe is metres and metres divide — but half a 6 m length
    -- is not a thing anybody can hand back over a counter. 0107.
    if v_line.sold_as = 'pack' and v_qty <> trunc(v_qty) then
      raise exception '% went out as a % and comes back whole or not at all',
        v_line.name, coalesce(v_line.pack_label, 'whole pack');
    end if;
    if v_line.sold_as <> 'pack' and not v_frac and v_qty <> trunc(v_qty) then
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
      -- Base units, as the sale gave up: putting back one 6 m length is
      -- twelve metres onto the shelf, not two. 0107.
      perform public.apply_stock(v_line.product_id,
                                 v_qty * coalesce(v_line.pack_size, 1), 'return',
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

-- 8. Reads and writes that gained columns ------------------------------------
--
-- Every one of these is a DROP and recreate, not a replace, because each gains
-- either return columns or arguments. CLAUDE.md is blunt about why and it has
-- bitten this repo twice: `create or replace` leaves the old signature
-- standing beside the new one, and every existing caller that names no
-- optional argument becomes ambiguous and fails outright.
--
-- And dropping takes the GRANTS with it. 0106 learned that the hard way — the
-- database suite went red on "every pos_* entry point is granted to anon"
-- after a drop-and-recreate that rebuilt the function and not its grant. Each
-- one below is re-granted immediately underneath itself for that reason.

drop function if exists public.pos_catalogue(text);

create function public.pos_catalogue(p_register_token text)
returns table(id uuid, sku text, barcode text, name text, description text,
              category_id uuid, category_name text, unit_code text, unit_name text,
              allows_fraction boolean, price_retail numeric, price_trade numeric,
              tax_code text, stock_qty numeric, reorder_level numeric,
              image_url text, sort_order integer, bin text, image_count integer,
              max_discount_percent numeric, max_discount_amount numeric,
              sold_in_packs boolean, pack_size numeric, pack_label text,
              price_cut_retail numeric, price_cut_trade numeric)
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select p.id, p.sku, p.barcode, p.name, p.description, p.category_id,
           c.name, p.unit_code, u.name, u.allows_fraction, p.price_retail,
           p.price_trade, p.tax_code, p.stock_qty, p.reorder_level,
           p.image_url, p.sort_order, p.bin,
           (select count(*)::int from public.product_images i
             where i.product_id = p.id),
           p.max_discount_percent, p.max_discount_amount,
           p.sold_in_packs, p.pack_size, p.pack_label,
           p.price_cut_retail, p.price_cut_trade
    from public.products p
    left join public.categories c on c.id = p.category_id
    join public.units_of_measure u on u.code = p.unit_code
    where p.org_id = v_reg.org_id and p.active
    order by p.sort_order, p.name;
end;
$$;
grant execute on function public.pos_catalogue(text) to anon, authenticated;

drop function if exists public.pos_admin_list_products(text, text);

create function public.pos_admin_list_products(p_register_token text, p_pin text)
returns table(id uuid, sku text, barcode text, name text, description text,
  category_id uuid, category_name text, unit_code text, price_retail numeric,
  price_trade numeric, cost numeric, tax_code text, stock_qty numeric,
  reorder_level numeric, active boolean, image_url text, bin text,
  max_discount_percent numeric, max_discount_amount numeric,
  sold_in_packs boolean, pack_size numeric, pack_label text,
  price_cut_retail numeric, price_cut_trade numeric)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  return query
    select p.id, p.sku, p.barcode, p.name, p.description, p.category_id, c.name,
           p.unit_code, p.price_retail, p.price_trade, p.cost, p.tax_code,
           p.stock_qty, p.reorder_level, p.active, p.image_url, p.bin,
           p.max_discount_percent, p.max_discount_amount,
           p.sold_in_packs, p.pack_size, p.pack_label,
           p.price_cut_retail, p.price_cut_trade
    from public.products p
    left join public.categories c on c.id = p.category_id
    where p.org_id = v_user.org_id
    order by p.name;
end;
$$;
grant execute on function public.pos_admin_list_products(text, text)
  to anon, authenticated;

-- The old twenty-argument signature, named in full so the drop is exact.
drop function if exists public.pos_admin_save_product(
  text, text, uuid, text, text, text, text, uuid, text, numeric, numeric,
  numeric, text, numeric, numeric, boolean, text, text, numeric, numeric);

create function public.pos_admin_save_product(
  p_register_token text, p_pin text, p_id uuid, p_sku text, p_barcode text,
  p_name text, p_description text, p_category_id uuid, p_unit_code text,
  p_price_retail numeric, p_price_trade numeric, p_cost numeric,
  p_tax_code text, p_stock_qty numeric, p_reorder_level numeric,
  p_active boolean, p_image_url text default null, p_bin text default null,
  p_max_discount_percent numeric default null,
  p_max_discount_amount numeric default null,
  p_sold_in_packs boolean default false, p_pack_size numeric default null,
  p_pack_label text default null, p_price_cut_retail numeric default null,
  p_price_cut_trade numeric default null
) returns public.products
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user public.app_users; v_row public.products; v_sku text;
  v_packs boolean; v_label text;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, 'manage_catalogue');
  if trim(coalesce(p_name, '')) = '' then raise exception 'A name is required'; end if;
  if p_price_retail is null or p_price_retail < 0 then
    raise exception 'A retail price is required';
  end if;
  if p_max_discount_percent is not null
     and (p_max_discount_percent < 0 or p_max_discount_percent > 100) then
    raise exception 'A discount cap is a percentage between 0 and 100';
  end if;
  if p_max_discount_amount is not null and p_max_discount_amount < 0 then
    raise exception 'A discount cap cannot be negative';
  end if;

  -- Whole-and-cut, checked here rather than left to the table constraint, so
  -- the counter gets a sentence it can act on instead of a constraint name.
  v_packs := coalesce(p_sold_in_packs, false);
  v_label := nullif(trim(coalesce(p_pack_label, '')), '');
  if v_packs then
    if p_pack_size is null or p_pack_size <= 0 then
      raise exception 'Say how much is in one — a 6 m length is 6';
    end if;
    if v_label is null then
      raise exception 'Give the whole one a name, as the counter says it: "6 m length"';
    end if;
    if p_price_cut_retail is null or p_price_cut_retail < 0 then
      raise exception 'An item sold cut needs a cut price';
    end if;
  end if;
  if p_price_cut_trade is not null and p_price_cut_trade < 0 then
    raise exception 'A cut price cannot be negative';
  end if;

  v_sku := nullif(trim(coalesce(p_sku, '')), '');

  if p_id is null then
    insert into public.products(org_id, sku, barcode, name, description,
      category_id, unit_code, price_retail, price_trade, cost, tax_code,
      stock_qty, reorder_level, active, image_url, bin,
      max_discount_percent, max_discount_amount,
      sold_in_packs, pack_size, pack_label, price_cut_retail, price_cut_trade)
    values (v_user.org_id, coalesce(v_sku, public.next_sku(v_user.org_id)),
      nullif(trim(coalesce(p_barcode,'')),''),
      trim(p_name), p_description, p_category_id, p_unit_code, p_price_retail,
      p_price_trade, p_cost, coalesce(p_tax_code,'standard'), p_stock_qty,
      p_reorder_level, coalesce(p_active, true),
      nullif(trim(coalesce(p_image_url, '')), ''),
      nullif(trim(coalesce(p_bin,'')),''),
      p_max_discount_percent, p_max_discount_amount,
      v_packs,
      case when v_packs then p_pack_size else null end,
      case when v_packs then v_label else null end,
      case when v_packs then p_price_cut_retail else null end,
      case when v_packs then p_price_cut_trade else null end)
    returning * into v_row;
  else
    update public.products p set
      -- A blank box on an existing product keeps the code it has; a product
      -- does not lose its number because somebody cleared a field.
      sku = coalesce(v_sku, p.sku), barcode = nullif(trim(coalesce(p_barcode,'')),''),
      name = trim(p_name), description = p_description, category_id = p_category_id,
      unit_code = p_unit_code, price_retail = p_price_retail,
      price_trade = p_price_trade, cost = p_cost,
      tax_code = coalesce(p_tax_code,'standard'), stock_qty = p_stock_qty,
      reorder_level = p_reorder_level, active = coalesce(p_active, true),
      -- See the three-way rule at the top of 0027.
      image_url = case
                    when p_image_url is null then p.image_url
                    when trim(p_image_url) = '' then null
                    else p_image_url
                  end,
      bin = nullif(trim(coalesce(p_bin,'')),''),
      max_discount_percent = p_max_discount_percent,
      max_discount_amount = p_max_discount_amount,
      -- Unticking the box clears the lot rather than leaving a cut price on an
      -- item nothing can sell cut: a stale price is one somebody restores the
      -- tick over and trusts.
      sold_in_packs = v_packs,
      pack_size        = case when v_packs then p_pack_size        else null end,
      pack_label       = case when v_packs then v_label            else null end,
      price_cut_retail = case when v_packs then p_price_cut_retail else null end,
      price_cut_trade  = case when v_packs then p_price_cut_trade  else null end,
      updated_at = now()
    where p.id = p_id and p.org_id = v_user.org_id
    returning * into v_row;
    if not found then raise exception 'Product not found'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.pos_admin_save_product(
  text, text, uuid, text, text, text, text, uuid, text, numeric, numeric,
  numeric, text, numeric, numeric, boolean, text, text, numeric, numeric,
  boolean, numeric, text, numeric, numeric) to anon, authenticated;

-- 9. Reading a quote back -----------------------------------------------------
--
-- `price_now` is what the till compares against to tell a cashier the price has
-- moved since the quote went out. It asked price_for, which for a cut line is
-- the LENGTH price — so recalling a quote for 2.4 m of pipe would have claimed
-- the price had jumped from the per-metre rate to the per-length one, every
-- time, on a quote that was perfectly current. Asking goods_price with the
-- line's own mode is the fix, and it is the same function the sale prices
-- through.

drop function if exists public.pos_quote_items(text, uuid);

create function public.pos_quote_items(
  p_register_token text, p_quote_id uuid
) returns table(product_id uuid, sku text, name text, unit_code text,
                qty numeric, unit_price numeric, line_total numeric,
                price_now numeric, still_sold boolean,
                sold_as text, pack_size numeric, pack_label text)
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
                then public.goods_price(p, v_quote.trade_pricing,
                       jsonb_build_object('sold_as', i.sold_as)) end,
           p.id is not null and p.active,
           i.sold_as, i.pack_size, i.pack_label
      from public.quote_items i
      left join public.products p on p.id = i.product_id
     where i.quote_id = p_quote_id
     order by i.name;
end;
$$;
grant execute on function public.pos_quote_items(text, uuid) to anon, authenticated;
