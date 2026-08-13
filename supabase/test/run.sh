#!/usr/bin/env bash
#
# Apply every migration to a throwaway Postgres and run the database tests
# against it.
#
# The browser suite drives the till against a hand-written fake of the server.
# This drives the server itself, so a migration that would not apply — or an RPC
# that only works in the fake — fails here rather than in a shop.
#
# Needs a Postgres 16 client and server on PATH, or at the usual Debian
# location. Point it at an existing cluster with PGHOST/PGPORT/PGUSER; with
# nothing set it starts its own on a scratch directory and tears it down after.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

export PATH="/usr/lib/postgresql/16/bin:$PATH"
export PGDATABASE="${PGDATABASE:-pos_test}"

own_cluster=0
if [ -z "${PGHOST:-}" ]; then
  own_cluster=1
  dir="$(mktemp -d)"
  export PGHOST="$dir/sock"
  export PGPORT="${PGPORT:-54329}"
  export PGUSER=postgres
  mkdir -p "$PGHOST"

  # initdb refuses to run as root, which is what CI and most containers are.
  runner=""
  if [ "$(id -u)" = "0" ]; then
    runner="$(id -u postgres >/dev/null 2>&1 && echo postgres || echo nobody)"
    chown -R "$runner" "$dir"
  fi
  # su resets PATH, so it is carried across explicitly rather than assumed.
  run() {
    if [ -n "$runner" ]; then
      su "$runner" -s /bin/bash -c "export PATH='$PATH'; $1"
    else
      bash -c "$1"
    fi
  }

  run "initdb -D '$dir/data' -U postgres --auth=trust" >/dev/null
  run "pg_ctl -D '$dir/data' -o '-p $PGPORT -k \"$PGHOST\"' -l '$dir/pg.log' -w start" >/dev/null

  cleanup() {
    run "pg_ctl -D '$dir/data' -m immediate stop" >/dev/null 2>&1 || true
    rm -rf "$dir"
  }
  trap cleanup EXIT
fi

psql -q -d postgres -c "drop database if exists $PGDATABASE" >/dev/null
psql -q -d postgres -c "create database $PGDATABASE" >/dev/null
# Supabase puts extensions on the search path; crypt() and gen_salt() are
# reached unqualified throughout the migrations.
psql -q -d postgres -c "alter database $PGDATABASE set search_path = public, extensions" >/dev/null

psql -q -v ON_ERROR_STOP=1 -f "$here/bootstrap.sql" >/dev/null

# In order, every one of them. A migration that does not apply is a deploy that
# does not happen, and that is worth finding here.
for f in "$root"/supabase/migrations/*.sql; do
  if ! out="$(psql -q -v ON_ERROR_STOP=1 -f "$f" 2>&1)"; then
    echo "migration failed: $(basename "$f")" >&2
    echo "$out" >&2
    exit 1
  fi
done
echo "applied $(ls "$root"/supabase/migrations/*.sql | wc -l | tr -d ' ') migrations"

psql -q -v ON_ERROR_STOP=1 -f "$here/schema.test.sql"

if [ "$own_cluster" = "1" ]; then echo "(threw the cluster away)"; fi
