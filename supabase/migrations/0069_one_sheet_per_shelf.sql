-- 0069 — one open sheet per shelf, and no sheet with nothing on it.
--
-- Two things the screen let a shop do, both visible on a real till after a
-- morning's use: eight sheets, several of them empty, and two open at once
-- over the same department.
--
-- THE SECOND ONE COSTS MONEY. Every line snapshots what was expected when the
-- sheet was OPENED, and posting applies the difference. Two sheets open over
-- the same shelves both snapshot 240. Count 237 on the first and post: stock
-- becomes 237 and a movement records three gone. Count 237 on the second — the
-- true figure, honestly counted — and post: it still believes 240 was
-- expected, applies another minus three, and the shelf reads 234. The shop
-- has written off six bags having lost three, and the losses report agrees
-- with the mistake. Nothing in the till would ever have caught it.
--
-- The fix is not cleverer arithmetic. It is refusing to open the second sheet.

create or replace function public.pos_stock_count_open(
  p_register_token text, p_pin text, p_category_id uuid default null,
  p_note text default null
) returns public.stock_counts
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid; v_user public.app_users; v_row public.stock_counts; v_clash text;
begin
  v_org := public.pos_admin_org_for(p_register_token, p_pin, 'manage_inventory');
  select * into v_user from public.app_users
   where org_id = v_org and pin_hash = crypt(p_pin, pin_hash) and active limit 1;

  -- Overlapping open sheets double-apply the same difference. A whole-shop
  -- sheet overlaps every department, and a department sheet overlaps a
  -- whole-shop one, so both directions are covered by the same test.
  select doc_number into v_clash from public.stock_counts
   where org_id = v_org and status = 'open'
     and (category_id is null or p_category_id is null
          or category_id = p_category_id)
   order by started_at limit 1;
  if found then
    raise exception
      'A count of these shelves is already open (%). Finish it or abandon it first.',
      v_clash;
  end if;

  -- A sheet with no lines is not a stock take. It filled the list with
  -- "0 of 0" rows nobody could act on and nobody could get rid of.
  if not exists (
    select 1 from public.products p
     where p.org_id = v_org and p.active and p.stock_qty is not null
       and (p_category_id is null or p.category_id = p_category_id)
  ) then
    raise exception 'There is nothing on a shelf in there to count';
  end if;

  insert into public.stock_counts (org_id, doc_number, category_id, note,
                                   started_by, started_by_name)
  values (v_org, public.next_doc_number(v_org, 'count'), p_category_id,
          nullif(btrim(coalesce(p_note, '')), ''), v_user.id, v_user.name)
  returning * into v_row;

  -- Untracked lines have no shelf to count: a delivery charge is not
  -- somewhere in aisle three.
  insert into public.stock_count_lines
    (count_id, product_id, sku, name, unit_code, expected_qty, unit_cost)
  select v_row.id, p.id, p.sku, p.name, p.unit_code, p.stock_qty, p.cost
    from public.products p
   where p.org_id = v_org and p.active and p.stock_qty is not null
     and (p_category_id is null or p.category_id = p_category_id);

  return v_row;
end;
$$;

grant execute on function public.pos_stock_count_open(text, text, uuid, text)
  to anon, authenticated;
