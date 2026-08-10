-- ---------------------------------------------------------------------------
-- Clear an account balance (write-off).
--
-- Lets an admin/manager zero an account's balance without a cash/card payment —
-- e.g. the owner's own house tab. It is recorded as an account_payment with a
-- new 'writeoff' method so:
--   * the balance drops to zero (the balance formula subtracts ALL payments),
--   * it leaves a dated, attributed entry in the ledger (full audit trail),
--   * it is EXCLUDED from the cash drawer and End-of-Day cash/card totals,
--     which only sum method in ('cash','card').
-- Note: on-account charges were already booked as revenue at sale time; a
-- write-off clears the receivable but does not reverse that revenue.
-- ---------------------------------------------------------------------------

-- Allow the new 'writeoff' method on repayments.
alter table public.account_payments
  drop constraint if exists account_payments_method_check;
alter table public.account_payments
  add constraint account_payments_method_check
  check (method in ('cash', 'card', 'writeoff'));

-- Admin: zero an account's outstanding balance (write-off). Requires the
-- manage_accounts permission (the admin's PIN).
create or replace function public.pos_manager_clear_account(
  p_pin text, p_account_id uuid, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_actor public.app_users; v_balance numeric(10,2); v_p public.account_payments;
begin
  v_actor := public.pos_user_with_perm(p_pin, 'manage_accounts');
  if v_actor.id is null then raise exception 'Not permitted to manage accounts'; end if;
  if not exists (select 1 from public.accounts where id = p_account_id) then
    raise exception 'Account not found';
  end if;

  v_balance := public.pos_account_balance(p_account_id);
  if v_balance <= 0 then raise exception 'Nothing to clear — balance is already zero'; end if;

  insert into public.account_payments(account_id, amount, method, received_by, received_by_name, note)
  values (p_account_id, v_balance, 'writeoff', v_actor.id, v_actor.name,
          coalesce(nullif(trim(p_note), ''), 'Balance cleared (write-off)'))
  returning * into v_p;

  return jsonb_build_object('id', v_p.id, 'amount', v_p.amount,
    'balance', public.pos_account_balance(p_account_id));
end; $$;

revoke all on function public.pos_manager_clear_account(text, uuid, text) from public;
grant execute on function public.pos_manager_clear_account(text, uuid, text) to anon, authenticated;
