-- What Supabase provides and a bare Postgres does not.
--
-- The migrations are written for a Supabase database, so a plain cluster is
-- missing the few things they lean on. This supplies exactly those and nothing
-- else: stub anything more and the tests stop testing the migrations.
--
--   * the `extensions` schema, where Supabase installs pgcrypto — crypt() and
--     gen_salt() hash every PIN in the system;
--   * the anon / authenticated / service_role roles, which every `grant execute`
--     in the migrations names;
--   * storage.buckets, which 0020 inserts the product-image bucket into. The
--     image path is not under test here; without the table the migration simply
--     will not apply.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

create schema if not exists storage;
create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);
create table if not exists storage.objects (
  id       uuid primary key default extensions.gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name     text,
  owner    uuid,
  metadata jsonb
);
