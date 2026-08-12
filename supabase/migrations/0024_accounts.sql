-- Accounts: the other half of selling on credit.
--
-- The till has been able to charge a sale to a contractor's account since
-- migration 0003. What has never existed is any way to record them paying it
-- back: nothing in the codebase writes to customer_payments. So a balance could
-- only ever grow, `available credit` only ever shrank, and a shop trading on
-- credit would have hit a wall within a month of opening.
--
-- Two decisions worth stating, because they are what make this an accounts
-- screen rather than a list of numbers:
--
--   1. Payments are allocated to charges OLDEST FIRST. That is what a shop
--      means by "he still owes me from March", and it is the only way to age a
--      debt honestly. A single running balance cannot tell you whether R4 000
--      is last week's delivery or a year-old bad debt.
--
--   2. A payment is never deleted, only voided, and a voided payment stops
--      counting toward the balance while staying on the ledger. Money that
--      quietly vanishes from a customer's history is how disputes become
--      unwinnable.

-- --------------------------------------------------------------- payments ---

alter table public.customer_payments
  add column if not exists client_ref  uuid,
  add column if not exists voided_at   timestamptz,
  add column if not exists voided_by   uuid,
  add column if not exists void_reason text;

-- A tablet at a counter double-taps. Without this, the shop credits a customer
-- twice for one payment and only finds out when the account is queried.
create unique index if not exists customer_payments_client_ref_key
  on public.customer_payments (org_id, client_ref) where client_ref is not null;

create index if not exists customer_payments_customer_idx
  on public.customer_payments (customer_id, created_at desc);

-- A voided payment must stop reducing the balance. Everything downstream —
-- available credit, aging, the ledger — reads through this one function.
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
  , 2);
$$;

-- ------------------------------------------------------------------ aging ---

/**
 * How old the money owed actually is.
 *
 * Payments are consumed against charges oldest first, and whatever is left
 * unconsumed is bucketed by the age of the charge it belongs to. The formula
 * per charge is the standard FIFO one: with `cum` the running total of charges
 * up to and including this one, and `pool` everything paid,
 *
 *     unpaid = greatest(0, least(amount, cum - pool))
 *
 * A credit balance (they paid more than they owe) shows as a negative in
 * `current` rather than being spread backwards, because that is what it is:
 * money in hand, not an aged debt.
 */
create or replace function public.customer_aging(p_customer_id uuid)
returns table(current_due numeric, days30 numeric, days60 numeric, days90 numeric,
              total_due numeric, oldest_unpaid date)
language sql stable set search_path = public, extensions as $$
  with charges as (
    -- The opening balance is a charge dated when the account was opened.
    select c.created_at::date as charged_on, c.opening_balance as amount
      from public.customers c
     where c.id = p_customer_id and c.opening_balance <> 0
    union all
    select s.created_at::date, s.total
      from public.sales s
     where s.customer_id = p_customer_id
       and s.payment_method = 'account' and s.status = 'completed'
  ),
  pool as (
    select coalesce(sum(p.amount), 0) as paid
      from public.customer_payments p
     where p.customer_id = p_customer_id and p.voided_at is null
  ),
  running as (
    select ch.charged_on, ch.amount,
           sum(ch.amount) over (order by ch.charged_on, ch.amount
                                rows between unbounded preceding and current row) as cum
      from charges ch
  ),
  unpaid as (
    select r.charged_on,
           greatest(0, least(r.amount, r.cum - (select paid from pool))) as owing
      from running r
  ),
  buckets as (
    select
      coalesce(sum(u.owing) filter (where current_date - u.charged_on <  30), 0) as b_current,
      coalesce(sum(u.owing) filter (where current_date - u.charged_on >= 30
                                      and current_date - u.charged_on <  60), 0) as b30,
      coalesce(sum(u.owing) filter (where current_date - u.charged_on >= 60
                                      and current_date - u.charged_on <  90), 0) as b60,
      coalesce(sum(u.owing) filter (where current_date - u.charged_on >= 90), 0)  as b90,
      min(u.charged_on) filter (where u.owing > 0) as oldest
    from unpaid u
  )
  select
    -- Any credit balance lands here, as money in hand rather than an aged debt.
    round(b.b_current + least(0, public.customer_balance(p_customer_id)
                                 - (b.b_current + b.b30 + b.b60 + b.b90)), 2),
    round(b.b30, 2), round(b.b60, 2), round(b.b90, 2),
    public.customer_balance(p_customer_id),
    b.oldest
  from buckets b;
$$;

-- ------------------------------------------------------------------- RPCs ---

/**
 * Every account, with what is owed and how old it is.
 *
 * Only customers who actually have an account: someone recorded at the counter
 * for a warranty claim is not a debtor and should not pad this list.
 */
create or replace function public.pos_accounts_overview(p_register_token text)
returns table(id uuid, code text, name text, phone text, is_trade boolean,
              credit_limit numeric, balance numeric, available numeric,
              current_due numeric, days30 numeric, days60 numeric, days90 numeric,
              oldest_unpaid date, last_payment_at timestamptz)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select c.id, c.code, c.name, c.phone, c.is_trade, c.credit_limit,
           public.customer_balance(c.id), public.customer_available_credit(c.id),
           a.current_due, a.days30, a.days60, a.days90, a.oldest_unpaid,
           (select max(p.created_at) from public.customer_payments p
             where p.customer_id = c.id and p.voided_at is null)
      from public.customers c
      cross join lateral public.customer_aging(c.id) a
     where c.org_id = v_reg.org_id and c.active
       and (c.credit_limit is null or c.credit_limit > 0
            or public.customer_balance(c.id) <> 0)
     order by public.customer_balance(c.id) desc, c.name;
end;
$$;

grant execute on function public.pos_accounts_overview(text) to anon, authenticated;

/**
 * One customer's account history: what they were charged, what they paid.
 *
 * The running balance is computed here rather than in the client so that a
 * printed statement and the screen can never disagree.
 */
create or replace function public.pos_customer_ledger(
  p_register_token text, p_customer_id uuid, p_limit int default 100
) returns table(kind text, entry_at timestamptz, ref text, detail text,
                charge numeric, payment numeric, balance numeric,
                entry_id uuid, voided boolean)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_open numeric;
begin
  v_reg := public.register_by_token(p_register_token);

  select c.opening_balance into v_open from public.customers c
   where c.id = p_customer_id and c.org_id = v_reg.org_id;
  if not found then raise exception 'Unknown customer'; end if;

  return query
  with entries as (
    -- `seq` only breaks ties at an identical timestamp, so the running
    -- balance is deterministic: opening first, then charges, then payments.
    select 'opening'::text as kind, 0 as seq, c.created_at as entry_at,
           ''::text as ref, 'Opening balance'::text as detail,
           c.opening_balance as charge,
           0::numeric as payment, c.id as entry_id, false as voided
      from public.customers c
     where c.id = p_customer_id and c.opening_balance <> 0
    union all
    select 'charge', 1, s.created_at, coalesce(s.doc_number, ''),
           coalesce(nullif(s.po_number, ''), 'Invoice'), s.total, 0, s.id, false
      from public.sales s
     where s.customer_id = p_customer_id and s.org_id = v_reg.org_id
       and s.payment_method = 'account' and s.status = 'completed'
    union all
    select 'payment', 2, p.created_at, coalesce(p.reference, ''),
           initcap(p.method) || coalesce(' · ' || nullif(p.note, ''), ''),
           0, case when p.voided_at is null then p.amount else 0 end,
           p.id, p.voided_at is not null
      from public.customer_payments p
     where p.customer_id = p_customer_id and p.org_id = v_reg.org_id
  ),
  ordered as (
    select e.*, sum(e.charge - e.payment) over (order by e.entry_at, e.seq
             rows between unbounded preceding and current row) as running
      from entries e
  )
  select o.kind, o.entry_at, o.ref, o.detail, o.charge, o.payment,
         round(o.running, 2), o.entry_id, o.voided
    from ordered o
   order by o.entry_at desc, o.seq desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

grant execute on function public.pos_customer_ledger(text, uuid, int)
  to anon, authenticated;

/**
 * A contractor settling their account at the counter.
 *
 * Authorised by the cashier's right to take payments — the same right that lets
 * them accept money for a sale. Overpayment is allowed and becomes a credit
 * balance: a builder rounding R4 310.50 up to R4 500 is paying in advance, not
 * making a mistake, and refusing it would send them away with their money.
 */
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

  -- The replay guard, before anything is written.
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
    reference, note, taken_by, taken_by_name, client_ref)
  values (v_reg.org_id, p_customer_id, v_amount, p_method,
    nullif(trim(coalesce(p_reference, '')), ''),
    nullif(trim(coalesce(p_note, '')), ''),
    v_user.id, v_user.name, p_client_ref)
  returning customer_payments.id into v_id;

  return query select v_id, public.customer_balance(p_customer_id),
                      public.customer_available_credit(p_customer_id);
end;
$$;

grant execute on function public.pos_take_account_payment(
  text, uuid, uuid, numeric, text, text, text, uuid) to anon, authenticated;

/**
 * Undo a payment taken in error — a manager's job, and never a deletion.
 *
 * The entry stays on the ledger marked void, so a customer disputing their
 * balance can be shown what happened rather than an unexplained gap.
 */
create or replace function public.pos_void_account_payment(
  p_register_token text, p_pin text, p_payment_id uuid, p_reason text
) returns numeric
language plpgsql security definer
set search_path = public, extensions as $$
declare v_org uuid; v_cust uuid; v_user public.app_users;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'void_refund');

  select cp.customer_id into v_cust from public.customer_payments cp
   where cp.id = p_payment_id and cp.org_id = v_org and cp.voided_at is null;
  if not found then raise exception 'No such payment'; end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to void a payment';
  end if;

  select * into v_user from public.app_users
   where org_id = v_org and pin_hash is not null
     and pin_hash = crypt(p_pin, pin_hash) and active and status = 'active';

  update public.customer_payments
     set voided_at = now(), voided_by = v_user.id, void_reason = trim(p_reason)
   where id = p_payment_id;

  return public.customer_balance(v_cust);
end;
$$;

grant execute on function public.pos_void_account_payment(text, text, uuid, text)
  to anon, authenticated;
