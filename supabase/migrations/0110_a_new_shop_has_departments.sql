-- A new shop opened with no departments at all.
--
-- Found at 5 Star Hardware: one category, "Delivery", which is the system's
-- own and not a department anybody puts stock in. Every product they entered
-- went in uncategorised, so the catalogue has no sections, the search chips
-- have nothing to offer, and the back office cannot report by department —
-- for a shop that did nothing wrong.
--
-- innova_create_org made the organisation and its manager and stopped. The
-- eight departments on the demo shop were put there by hand once, long ago,
-- and nothing carried them to the shops that came after. So the thing being
-- demonstrated and the thing being delivered were different products.
--
-- WHY THESE EIGHT. They are the ones already on IE Test Shop, which is what
-- gets shown to a shopkeeper before they sign up — a new shop should look
-- like the one they were shown. They also happen to be a reasonable division
-- of a Southern African hardware store, and a shop that disagrees can rename,
-- deactivate or add to them from the back office in a few seconds. Guessing
-- eight sensible names is a far smaller imposition than an empty list.
--
-- sort_order 0 on all of them, which is the existing convention: the till
-- orders by sort_order then name, so 0 means alphabetical. Delivery sits at
-- 900 to stay at the bottom, and is not touched here.
create or replace function public.seed_departments(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions as $$
begin
  insert into public.categories (org_id, name, sort_order, active)
  select p_org, d, 0, true
  from unnest(array[
    'Building Materials',
    'Electrical',
    'Fasteners',
    'Garden & Outdoor',
    'Paint & Sundries',
    'Plumbing',
    'Timber & Board',
    'Tools'
  ]) as d
  -- Idempotent on the unique (org_id, name) index, so running this against a
  -- shop that already has some of them adds only what is missing and renames
  -- nothing. A shop that deleted "Tools" on purpose gets it back, which is
  -- the one cost of that; a shop that never had it is the case this exists
  -- for, and it is far commoner.
  on conflict (org_id, name) do nothing;
end $$;
-- Nobody's but the server's. A till has no business creating departments
-- wholesale, and 0092 is explicit that a new function is nobody's until
-- granted.
revoke execute on function public.seed_departments(uuid) from anon, authenticated, public;

-- The same arguments, so create or replace is safe here: this changes the
-- body alone. CLAUDE.md's drop-first rule is about a CHANGED signature, and
-- adding a defaulted argument here would leave the old one standing beside it
-- and make every existing caller ambiguous.
create or replace function public.innova_create_org(
  p_name text, p_manager_name text, p_manager_phone text,
  p_vertical text default 'hardware', p_vat_number text default '',
  p_address1 text default '', p_address2 text default '',
  p_phone text default ''
) returns uuid
language plpgsql security definer
set search_path = public, extensions as $$
declare v_org uuid;
begin
  if p_manager_phone !~ '^\+\d{9,15}$' then
    raise exception 'Manager phone must be E.164, e.g. +27821234567';
  end if;
  insert into public.organizations (name, vertical, vat_number, address_line1, address_line2, phone)
  values (trim(p_name), p_vertical, p_vat_number, p_address1, p_address2, p_phone)
  returning id into v_org;
  insert into public.app_users (org_id, name, role, phone_e164, status, pin_hash)
  values (v_org, trim(p_manager_name), 'admin', p_manager_phone, 'invited', null);

  -- Departments, so the shop can file its first product. Only for a hardware
  -- shop: the list is a hardware shop's, and handing "Timber & Board" to a
  -- vertical that sells something else would be worse than handing it
  -- nothing. Another vertical gets departments when somebody who knows that
  -- trade writes its list.
  if p_vertical = 'hardware' then
    perform public.seed_departments(v_org);
  end if;

  return v_org;
end $$;

-- And the shops already open with nothing.
--
-- Only those with no departments at all: a shop that has built its own set is
-- not improved by eight more appearing overnight, and "Delivery" is the
-- system's own rather than something a shopkeeper chose, so it does not count
-- as having departments.
do $$
declare r record;
begin
  for r in
    select o.id from public.organizations o
    where coalesce(o.vertical, 'hardware') = 'hardware'
      and not exists (
        select 1 from public.categories c
        where c.org_id = o.id and c.name <> 'Delivery'
      )
  loop
    perform public.seed_departments(r.id);
  end loop;
end $$;
