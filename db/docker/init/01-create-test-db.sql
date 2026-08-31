-- Runs ONCE, on first initialisation of an empty Postgres data volume
-- (docker-entrypoint-initdb.d). Creates the separate database used by
-- `cd db && npm test`, which resets its schema on every run and must therefore
-- never point at the development database.
--
-- Re-running after the volume exists is a no-op — recreate the volume with
-- `docker compose down -v` if you need this to run again.
SELECT 'CREATE DATABASE veorec_test OWNER veorec'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'veorec_test')\gexec
