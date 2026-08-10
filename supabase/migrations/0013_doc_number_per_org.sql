-- Uniqueness that was global must become per-organization.
--
-- Found by the multi-tenant boundary test, not by inspection: the second
-- org's very first sale failed because its INV-000001 collided with the first
-- org's. Invoice numbers are gapless PER SHOP (that is the SARS requirement);
-- across shops they repeat by design. Likewise client_ref — two tills in two
-- different shops can generate the same offline idempotency key without it
-- being a replay.

alter table public.sales drop constraint sales_doc_number_key;
create unique index sales_org_doc_number_key
  on public.sales (org_id, doc_number)
  where doc_number is not null;

alter table public.sales drop constraint sales_client_ref_key;
create unique index sales_org_client_ref_key
  on public.sales (org_id, client_ref)
  where client_ref is not null;
