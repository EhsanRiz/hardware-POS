/*
 * A padlock rung up after a length of pipe was written down as a length of pipe
 *
 * Found reading 0107 line by line before putting it on the shop's database,
 * which is the only reason it was found at all: every test in that commit
 * sells ONE line, and a one-line sale cannot tell "this line's mode" apart
 * from "the last mode anybody worked out".
 *
 * pos_create_sale walks the items three times. The first loop validates and
 * works out v_sold_as and v_pack per line. The third loop writes the lines —
 * and it re-reads the product, the quantity, the price and the discount from
 * v_item, but not the mode. So v_sold_as arrived still holding the LAST item's
 * value, and every line of the sale was written with it.
 *
 * WHAT THAT COSTS, and it is not cosmetic. Sell a padlock and then a 6 m
 * length: the padlock is stored sold_as 'pack' with pack_size 6 and base_qty
 * twelve, so twelve padlocks come off a shelf that gave up two. Ring the same
 * two up the other way round and the pipe under-deducts instead. The money was
 * right either way — line_price reads v_item and was never wrong — so nothing
 * on the slip or the invoice would have looked odd while the stock quietly
 * went to pieces.
 *
 * WHY THIS IS 0108 AND NOT AN EDIT TO 0107. 0107 is already on main and
 * applied to a test cluster on every CI run. Migrations are applied in order
 * and never rewritten, so the fix has to arrive as its own step or an
 * environment that already has 0107 never gets it.
 *
 * Guard broken: it IS the broken guard — the test in this commit was written
 * first, run against 0107 as it stood, and failed with "the padlock is still a
 * padlock, whatever was rung up after it — got pack, wanted unit". It sells
 * both mixtures, in both orders, because the fault is order-dependent and a
 * test that only rings them up one way round proves half of it.
 */

-- Same signature; body only. A replace, so no old version is left standing.
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
    -- Worked out again for THIS line, which is the whole of the fix. Every
    -- other per-line value in this loop is re-derived from v_item; the mode
    -- was not, so it arrived holding whatever the validation loop finished on
    -- — the LAST line's mode, written onto every line of the sale.
    v_sold_as := public.line_sold_as(v_product, v_item);
    v_pack := case when v_sold_as = 'pack' then v_product.pack_size else null end;
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


/*
 * And the shelf tolerates a line with no base_qty.
 *
 * Found applying 0107 to the shop's database by hand. The migration is one
 * file but a hand-application is a sequence, and between "settle_stock_for_sale
 * reads base_qty" and "pos_create_sale writes it" there is a window where the
 * live till is writing lines the new stock function cannot read. NULL * -1 is
 * NULL, and apply_stock would have been handed nothing.
 *
 * Nobody sold anything in that window — checked, not assumed — but the fix
 * belongs in the repository permanently rather than only in the database,
 * because the two must agree and because the coalesce is simply correct: for
 * any row written before 0107, the quantity sold IS the quantity off the
 * shelf, and that is what base_qty was backfilled to.
 */
create or replace function public.settle_stock_for_sale(
  p_sale_id uuid, p_direction int, p_reason stock_reason, p_user public.app_users
) returns void language plpgsql set search_path = public, extensions as $$
declare r record;
begin
  for r in select product_id, base_qty, qty from public.sale_items
           where sale_id = p_sale_id and product_id is not null loop
    perform public.apply_stock(r.product_id,
                               p_direction * coalesce(r.base_qty, r.qty), p_reason,
                               'sales', p_sale_id, p_user, null);
  end loop;
end;
$$;


/*
 * And a pack item with no mode is a WHOLE one, not a cut one.
 *
 * 0107 made the absent mode mean 'unit' and said in its own comment that this
 * gave an un-updated till "exactly the behaviour it always had". That is true
 * of an ordinary item, where 'unit' is the only way to buy it, and false of a
 * pack item, where it is the difference between R180 and R38.
 *
 * The till that has not pressed Update is running code that knows one price
 * per product and shows price_retail — the LENGTH price. It sends no mode
 * because its version has never heard of one. Pricing that at the cut rate
 * charges a fifth of what the cashier just said out loud, and neither the slip
 * nor the screen would look wrong; it would surface as a hole in the takings
 * weeks later.
 *
 * lib/packs.ts defaultSoldAs() has always answered 'pack' here. Two
 * implementations of one rule, disagreeing exactly as 0107's own comment
 * warned they would.
 *
 * Found by exercising goods_price on the live database after applying 0107 by
 * hand — the four prices were right and the fifth column, the one nobody had
 * thought to ask for, was not.
 */
create or replace function public.line_sold_as(
  p_product public.products, p_item jsonb
) returns text language plpgsql immutable set search_path = public, extensions as $$
declare v_mode text;
begin
  v_mode := nullif(trim(coalesce(p_item->>'sold_as', '')), '');
  if v_mode is null then
    -- Whichever way this item is normally bought. For everything that is not
    -- sold two ways this is 'unit', which is what every line was before 0107.
    return case when coalesce(p_product.sold_in_packs, false) then 'pack' else 'unit' end;
  end if;
  if v_mode not in ('pack', 'unit') then
    raise exception 'A line is sold whole or cut, not "%"', v_mode;
  end if;
  if v_mode = 'pack' and not coalesce(p_product.sold_in_packs, false) then
    raise exception '% is not sold as a whole pack', p_product.name;
  end if;
  return v_mode;
end;
$$;

revoke execute on function public.line_sold_as(public.products, jsonb)
  from anon, authenticated, public;
