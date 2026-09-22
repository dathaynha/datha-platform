#!/bin/bash
# Creates additional databases on first Postgres container start.
# This script runs automatically via /docker-entrypoint-initdb.d/ only when
# the data volume is empty (i.e. first `docker compose up`).
#
# If Postgres is already running, create the database manually instead:
#   docker exec -it datha_platform_db createdb -U postgres file_service_db
#   docker exec -it datha_platform_db createdb -U postgres event_store_db
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  SELECT 'CREATE DATABASE file_service_db'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'file_service_db')\gexec
  SELECT 'CREATE DATABASE event_store_db'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'event_store_db')\gexec
  SELECT 'CREATE DATABASE accounts_service_db'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'accounts_service_db')\gexec
EOSQL
