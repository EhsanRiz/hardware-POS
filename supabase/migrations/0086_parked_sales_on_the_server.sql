-- 0086: parked sales live on the server, so every till sees them.
--
-- A parked sale used to live in the device that parked it. A customer who
-- stepped away from the front counter and came back to the yard till found
-- nothing; a cashier who parked a basket and went off shift took it with
-- them. The list is now the shop's: parked on one till, picked up on any,
-- by anyone signed in.
--
-- The till keeps a device-only list for when the line is down and for the
-- basket it recovers after a refresh; those show as "on this till only".
--
-- Lines are kept as the till holds them (product, quantity, what came off
-- and why); the sale is repriced by the server when it is finally rung, as
-- every sale is. The total here is what the till showed, for the list.

create table public.parked_sales (
  id              uuid primary key,
  org_id          uuid not null references public.organizations(id) on delete cascade,
  register_id     uuid references public.registers(id) on delete set null,
  register_name   text not null,
  parked_by       uuid references public.app_users(id) on delete set null,
  parked_by_name  text not null,
  parked_at       timestamptz not null default now(),
  customer_id     uuid references public.customers(id) on delete set null,
  lines           jsonb not null,
  discount        numeric(14,2) not null default 0,
  discount_reason text,
  total           numeric(14,2) not null default 0
);
create index parked_sales_org_idx on public.parked_sales(org_id, parked_at);
alter table public.parked_sales enable row level security;

/** Park a sale, or put one back in its slot (same id, its original time). */
create function public.pos_park_sale(
  p_register_token text, p_cashier_id uuid, p_id uuid, p_lines jsonb,
  p_customer_id uuid, p_discount numeric, p_discount_reason text, p_total numeric,
  p_parked_at timestamptz default null
) returns public.parked_sales
language plpgsql security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_user public.app_users; v_row public.parked_sales;
begin
  v_reg := public.register_by_token(p_register_token);
  select * into v_user from public.app_users
   where app_users.id = p_cashier_id and org_id = v_reg.org_id and active and status = 'active';
  if not found then raise exception 'Unknown cashier'; end if;
  if p_id is null then raise exception 'A parked sale needs an id'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Nothing to park';
  end if;
  if p_customer_id is not null and not exists (
    select 1 from public.customers c where c.id = p_customer_id and c.org_id = v_reg.org_id) then
    raise exception 'No such customer';
  end if;

  insert into public.parked_sales
    (id, org_id, register_id, register_name, parked_by, parked_by_name, parked_at,
     customer_id, lines, discount, discount_reason, total)
  values
    (p_id, v_reg.org_id, v_reg.id, v_reg.name, v_user.id, v_user.name, coalesce(p_parked_at, now()),
     p_customer_id, p_lines, coalesce(p_discount, 0), nullif(trim(coalesce(p_discount_reason, '')), ''),
     coalesce(p_total, 0))
  on conflict (id) do update set
    register_id = excluded.register_id, register_name = excluded.register_name,
    parked_by = excluded.parked_by, parked_by_name = excluded.parked_by_name,
    -- The slot keeps its time: the 09:19 customer is still the 09:19 customer.
    parked_at = parked_sales.parked_at,
    customer_id = excluded.customer_id, lines = excluded.lines,
    discount = excluded.discount, discount_reason = excluded.discount_reason, total = excluded.total
  where parked_sales.org_id = v_reg.org_id
  returning * into v_row;
  if v_row.id is null then raise exception 'That id belongs to another shop'; end if;
  return v_row;
end;
$$;
grant execute on function public.pos_park_sale(text, uuid, uuid, jsonb, uuid, numeric, text, numeric, timestamptz)
  to anon, authenticated;

/** Every parked sale in the shop, oldest first, with what the list needs. */
create function public.pos_parked_sales(p_register_token text)
returns table(id uuid, parked_at timestamptz, register_name text, parked_by_name text,
              customer_id uuid, customer_name text, lines jsonb,
              discount numeric, discount_reason text, total numeric)
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_reg public.registers;
begin
  v_reg := public.register_by_token(p_register_token);
  return query
    select p.id, p.parked_at, p.register_name, p.parked_by_name,
           p.customer_id, c.name, p.lines, p.discount, p.discount_reason, p.total
      from public.parked_sales p
      left join public.customers c on c.id = p.customer_id
     where p.org_id = v_reg.org_id
     order by p.parked_at, p.id;
end;
$$;
grant execute on function public.pos_parked_sales(text) to anon, authenticated;

/** Take a parked sale onto this till. It leaves the list as it is taken, so two tills cannot both have it. */
create function public.pos_unpark_sale(p_register_token text, p_id uuid)
returns public.parked_sales
language plpgsql security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_row public.parked_sales;
begin
  v_reg := public.register_by_token(p_register_token);
  delete from public.parked_sales p where p.id = p_id and p.org_id = v_reg.org_id
    returning * into v_row;
  if v_row.id is null then
    raise exception 'That parked sale is not there any more; another till may have taken it';
  end if;
  return v_row;
end;
$$;
grant execute on function public.pos_unpark_sale(text, uuid) to anon, authenticated;

/** A parked sale nobody is coming back for. */
create function public.pos_delete_parked_sale(p_register_token text, p_id uuid)
returns void
language plpgsql security definer
set search_path = public, extensions as $$
declare v_reg public.registers; v_n int;
begin
  v_reg := public.register_by_token(p_register_token);
  delete from public.parked_sales p where p.id = p_id and p.org_id = v_reg.org_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'That parked sale is not there any more'; end if;
end;
$$;
grant execute on function public.pos_delete_parked_sale(text, uuid) to anon, authenticated;
