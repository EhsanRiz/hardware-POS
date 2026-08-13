-- A stable description of the public schema, for comparing two databases.
--
-- The repository's migrations and the running database are two accounts of the
-- same schema, and they have drifted before: the live database gained an
-- 0018_payment_methods that the repo never recorded, so a build from the repo
-- had a payment_method enum missing three of the tenders the till offers, and
-- the test suite that runs on those migrations was quietly testing a schema
-- nobody uses.
--
-- This emits one row per thing worth agreeing on — columns, enums, constraints,
-- indexes, function signatures and bodies, RLS, grants — sorted, so two runs
-- can be diffed line by line. Seed rows are not schema and are left out.
--
-- Function bodies are hashed with comments and whitespace stripped: the repo
-- and the database will never agree on formatting, and a diff that shouts about
-- indentation is a diff nobody reads.

select item from (

  select format('column   %s.%s %s%s%s',
           c.table_name, c.column_name,
           c.data_type
             || coalesce('(' || c.character_maximum_length || ')', '')
             || coalesce('(' || c.numeric_precision || ',' || c.numeric_scale || ')', ''),
           case when c.is_nullable = 'NO' then ' NOT NULL' else '' end,
           coalesce(' DEFAULT ' || regexp_replace(c.column_default, '::[a-z ]+', '', 'g'), '')
         ) as item
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
   where c.table_schema = 'public' and t.table_type = 'BASE TABLE'

  union all
  select format('enum     %s = %s', t.typname,
           (select string_agg(e.enumlabel, ',' order by e.enumsortorder)
              from pg_enum e where e.enumtypid = t.oid))
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public' and t.typtype = 'e'

  union all
  select format('constr   %s %s', rel.relname, pg_get_constraintdef(con.oid))
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
   where n.nspname = 'public'

  union all
  select format('index    %s', regexp_replace(indexdef, ' USING ', ' USING ', 'g'))
    from pg_indexes where schemaname = 'public'

  union all
  select format('function %s(%s) -> %s',
           p.proname, pg_get_function_identity_arguments(p.oid),
           pg_get_function_result(p.oid))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'

  -- The body, normalised: comments out, whitespace collapsed, case folded. What
  -- survives is what the function actually does.
  union all
  select format('body     %s(%s) %s',
           p.proname, pg_get_function_identity_arguments(p.oid),
           md5(lower(regexp_replace(
                 regexp_replace(p.prosrc, '--[^\n]*', '', 'g'),
                 '\s+', ' ', 'g'))))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'

  union all
  select format('rls      %s %s', c.relname,
           case when c.relrowsecurity then 'enabled' else 'disabled' end)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'

  union all
  select format('policy   %s.%s %s', schemaname, tablename, policyname)
    from pg_policies where schemaname = 'public'

  -- Who may call what. A grant quietly missing from one side is a feature that
  -- works in testing and refuses in the shop.
  union all
  select distinct format('grant    %s to %s', p.proname, a.grantee)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral (
      select unnest(array['anon','authenticated']) as grantee
    ) a
   where n.nspname = 'public'
     and has_function_privilege(a.grantee, p.oid, 'execute')

) f
order by item;
