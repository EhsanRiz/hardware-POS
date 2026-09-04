-- 0054: cancelling a sale at the counter, with the manager on the phone.
--
-- The customer changes their mind at the moment the cash is in the drawer and
-- the slip is printing. The invoice already has a number and numbering is
-- gapless, so it cannot be erased: it is VOIDED — stock goes back, the cash
-- goes back across the counter, the day close counts it as voided rather than
-- as money expected in the drawer. The RPC for that has existed since 0004 and
-- the till never showed it; now it does, from the receipt popup, the banner
-- after a sale, and the sale popup a scanned slip opens.
--
-- A void needs a manager, as a return does. When the manager is at the bank,
-- the same one-time code 0039 issues for a discount now approves a void too:
-- single use, minutes long, capped (a code for R80 cannot cancel an R800
-- sale), and attributed to the manager who ISSUED it, not the cashier who
-- typed it. The PIN and the code arrive in the same argument: the till cannot
-- tell which the cashier was read over the phone, and should not have to.

drop function if exists public.pos_void_sale(uuid, text, text, text);
create function public.pos_void_sale(
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

  -- First reading of the digits: a manager's PIN.
  select * into v_by_pin from public.app_users u
   where u.org_id = v_reg.org_id and u.status = 'active' and u.active
     and u.pin_hash is not null and u.pin_hash = crypt(coalesce(p_pin, ''), u.pin_hash)
   limit 1;
  if v_by_pin.id is not null
     and 'void_refund' = any(public.effective_permissions(v_by_pin)) then
    v_approver := v_by_pin;
  else
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
      if v_by_pin.id is not null then
        raise exception 'Not permitted: void_refund';
      end if;
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
grant execute on function public.pos_void_sale(uuid, text, text, text, uuid)
  to anon, authenticated;
