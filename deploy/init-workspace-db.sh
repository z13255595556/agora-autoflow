#!/usr/bin/env bash
set -euo pipefail

# Must be run once by a PostgreSQL administrator. It creates the isolated
# workspace database and an administrator role used only by the AutoFlow API.
# It never exposes PostgreSQL on the network.
: "${WORKSPACE_ADMIN_PASSWORD:?set a high-entropy password first}"

sudo -u postgres psql -v ON_ERROR_STOP=1 --set=workspace_password="$WORKSPACE_ADMIN_PASSWORD" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autoflow_workspace_admin') THEN
    CREATE ROLE autoflow_workspace_admin LOGIN NOINHERIT NOCREATEDB CREATEROLE NOSUPERUSER NOREPLICATION;
  END IF;
END $$;
ALTER ROLE autoflow_workspace_admin PASSWORD :'workspace_password';
ALTER ROLE autoflow_workspace_admin NOINHERIT NOCREATEDB CREATEROLE NOSUPERUSER NOREPLICATION;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='autoflow_workspace'" | grep -q 1; then
  sudo -u postgres createdb --owner=autoflow_workspace_admin autoflow_workspace
fi

sudo -u postgres psql -d autoflow_workspace -v ON_ERROR_STOP=1 <<'SQL'
REVOKE ALL ON DATABASE autoflow_workspace FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL

echo "Workspace database ready. Set WORKSPACE_ADMIN_DSN and WORKSPACE_ROLE_SECRET in deploy/app.env."
