-- The upload endpoint needs to know WHICH shop is uploading, before it writes
-- a file, so a rejected PIN never leaves an orphan in storage. It also gives
-- the storage path its tenant prefix.
--
-- Service-role only: this is called by the product-image edge function, which
-- holds the PIN the manager just typed. Nothing in the browser may call it.
create or replace function public.pos_admin_org_for(
  p_register_token text, p_pin text, p_perm text
) returns uuid
language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_user public.app_users;
begin
  v_user := public.user_with_perm(p_register_token, p_pin, p_perm);
  return v_user.org_id;
end;
$$;

revoke execute on function public.pos_admin_org_for(text, text, text) from public, anon, authenticated;

-- The catalogue and the search results both carry the primary thumbnail, so a
-- near-identical item is chosen from a picture rather than a description.
-- (Full definitions applied live in 0022; see pos_catalogue and
-- pos_search_products, which gain image_url, bin and image_count.)
