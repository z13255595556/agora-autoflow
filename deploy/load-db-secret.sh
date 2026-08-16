#!/bin/sh
set -eu

secret_file="${PGPASSWORD_FILE:-/run/secrets/pg_password}"
if [ ! -r "$secret_file" ]; then
  echo "database password secret is missing: $secret_file" >&2
  exit 1
fi

# libpq and node-postgres both understand the standard PG* variables.
export PGPASSWORD="$(cat "$secret_file")"
unset PGPASSWORD_FILE

exec "$@"
