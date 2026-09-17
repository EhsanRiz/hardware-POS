-- What a helper starts with: nothing.
--
-- Separate from 0104 because the value has to be committed before a function
-- body may name it.
--
-- Note the shape of the old function. It read:
--
--   when 'admin' then ... when 'manager' then ... else array['take_payments','apply_discount']
--
-- so anything that was not admin or manager got the till. A new role added to
-- the enum would have fallen into that else and been handed the two
-- permissions it exists precisely to withhold — silently, with no error
-- anywhere. Every role is named now, and an unknown one gets nothing, which
-- is the safe direction for a list that will grow again.

create or replace function public.role_default_permissions(p_role user_role)
returns text[] language sql immutable
set search_path = public, extensions as $$
  select case p_role
    when 'admin' then array(select code from public.permissions)
    when 'manager' then array[
      'take_payments','apply_discount','approve_discount','void_refund',
      'manage_catalogue','manage_inventory','manage_purchasing',
      'manage_customers','manage_quotes','view_reports','view_cost_prices',
      'cash_management','shelf_capture'
    ]
    when 'employee' then array['take_payments','apply_discount']
    -- A helper, and anything added to the enum after it: nothing until
    -- somebody says otherwise.
    else array[]::text[]
  end;
$$;
