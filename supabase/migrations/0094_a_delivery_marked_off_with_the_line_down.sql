-- A delivery marked off with the line down keeps the time it was marked.
--
-- The driver's phone has no signal at the site, which is where the page is
-- signed. The phone now queues "delivered" and sends it when the line is
-- back (src/lib/queue.ts, as a sale is), so the server takes the time the
-- phone says, within reason — clamped as a sale's own time is (0089) —
-- rather than stamping the moment the queue happened to drain.
--
-- A defaulted argument is a NEW signature: the old one is dropped first or
-- every caller that names no optional arguments becomes ambiguous.

drop function if exists public.pos_mark_delivered(text, uuid, uuid, text);

create function public.pos_mark_delivered(
  p_register_token text, p_user_id uuid, p_delivery_id uuid,
  p_note text default null, p_delivered_at timestamptz default null
) returns public.deliveries
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_reg public.registers; v_user public.app_users; v_row public.deliveries; v_at timestamptz;
begin
  v_reg := public.register_by_token(p_register_token);
  -- Anybody who can sign in may mark a delivery off — no permission on it,
  -- deliberately — but "can sign in" means enrolled, not merely on the list.
  select * into v_user from public.app_users
   where id = p_user_id and org_id = v_reg.org_id
     and active and status = 'active';
  if not found then raise exception 'Unknown user'; end if;

  select * into v_row from public.deliveries
   where id = p_delivery_id and org_id = v_reg.org_id;
  if not found then raise exception 'Unknown delivery'; end if;
  if v_row.status = 'delivered' then
    raise exception 'That delivery is already marked as delivered';
  end if;

  v_at := coalesce(p_delivered_at, now());
  if v_at > now() + interval '5 minutes' or v_at < now() - interval '30 days' then
    v_at := now();
  end if;

  update public.deliveries
     set status = 'delivered', delivered_at = v_at,
         delivered_by = v_user.id, delivered_by_name = v_user.name,
         note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note)
   where id = p_delivery_id
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.pos_mark_delivered(text, uuid, uuid, text, timestamptz)
  to anon, authenticated;
