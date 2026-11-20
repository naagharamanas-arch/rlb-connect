#!/usr/bin/env bash
# Apply a (possibly multi-statement) SQL file to the CLI's local throw-away database.
#
# Why not `supabase db query --local --file`: it sends the file as ONE prepared
# statement, so any file with more than one command fails with "cannot insert
# multiple commands into a prepared statement". psql inside the database container
# uses the simple protocol and runs the whole file, stopping at the first error.
#
# Usage: supabase/ci/apply-sql.sh <file.sql>      (CI / local disposable DB only)
set -euo pipefail
file="${1:?usage: apply-sql.sh <file.sql>}"
db="$(docker ps --filter name=supabase_db_ --format '{{.Names}}' | head -n 1)"
[ -n "$db" ] || { echo "no supabase_db_* container is running" >&2; exit 1; }
docker exec -i "$db" psql -U postgres -v ON_ERROR_STOP=1 -q < "$file"
