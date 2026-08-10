-- Add the 'admin' super-role. Must be committed before it can be used,
-- so it lives in its own migration.
alter type user_role add value if not exists 'admin';
