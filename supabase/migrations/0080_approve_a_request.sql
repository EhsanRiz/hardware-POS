-- Approving a request for InnovaPOS, from the email it arrives in.
--
-- The request form (pos.innovaearth.com/request) stored the enquiry and
-- emailed InnovaEarth a line of SQL to paste. That is a step nobody wants
-- at the moment they read the email. Now each request carries a random
-- token, the email carries an Approve link built on it, and this function
-- is what the link calls (through supabase/functions/pos-approve, with the
-- service role): it makes the shop with innova_create_org, invites the
-- contact as its manager by the number they gave, and marks the request
-- approved so the link cannot make a second shop. The manager's number is
-- put into E.164 by the country they chose; a number that cannot be read
-- is refused with a message rather than guessed.
--
-- Revoked from every API role: only the approve function, holding the
-- service role, may call it, and it only ever calls it with a token that
-- came out of InnovaEarth's own inbox.

alter table public.pos_requests
  add column approve_token      text not null default encode(gen_random_bytes(24), 'hex'),
  add column approved_at        timestamptz,
  add column org_id             uuid references public.organizations(id),
  add column manager_phone_e164 text;
create unique index pos_requests_approve_token on public.pos_requests (approve_token);

create function public.innova_approve_request(p_token text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions as $$
declare v_req public.pos_requests; v_phone text; v_dial text; v_org uuid;
begin
  select * into v_req from public.pos_requests where approve_token = p_token;
  if v_req.id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown', 'message', 'That link is not one we sent.');
  end if;
  if v_req.approved_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'org_id', v_req.org_id,
      'org_name', v_req.org_name, 'manager_phone', v_req.manager_phone_e164,
      'message', format('%s was already set up on %s.', v_req.org_name, to_char(v_req.approved_at, 'DD Mon YYYY')));
  end if;
  if v_req.created_at < now() - interval '30 days' then
    return jsonb_build_object('ok', false, 'reason', 'expired',
      'message', 'That request is more than thirty days old. Ask them to send it again.');
  end if;

  v_dial := case lower(coalesce(v_req.country, ''))
              when 'south africa' then '+27'
              when 'lesotho' then '+266'
              else null end;
  v_phone := public.normalize_phone(v_req.phone, v_dial);
  if v_phone is null then
    return jsonb_build_object('ok', false, 'reason', 'phone',
      'message', format('The number "%s" could not be read as a %s mobile number. Create the shop by hand with the right number.',
                        coalesce(v_req.phone, ''), coalesce(v_req.country, 'known')));
  end if;
  if exists (select 1 from public.app_users where phone_e164 = v_phone) then
    return jsonb_build_object('ok', false, 'reason', 'phone_taken',
      'message', format('%s already belongs to somebody on another shop.', v_phone));
  end if;

  v_org := public.innova_create_org(v_req.org_name, v_req.contact_name, v_phone, v_req.vertical);
  update public.pos_requests
     set approved_at = now(), org_id = v_org, manager_phone_e164 = v_phone, status = 'approved'
   where id = v_req.id;
  return jsonb_build_object('ok', true, 'already', false, 'org_id', v_org,
    'org_name', v_req.org_name, 'manager_name', v_req.contact_name,
    'manager_phone', v_phone, 'email', v_req.email);
end;
$$;
revoke execute on function public.innova_approve_request(text) from anon, authenticated, public;
