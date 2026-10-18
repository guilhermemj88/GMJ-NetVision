-- PREPARED ONLY. Execute solely at approved Gate 2, never during audit.
-- Connect to netvision_fast_observe as DBA and supply reader_password securely.
-- Existing role => fail and review; this script never rotates an existing secret.
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE netvision_fast_api_reader LOGIN PASSWORD :'reader_password' CONNECTION LIMIT 3;
GRANT CONNECT ON DATABASE netvision_fast_observe TO netvision_fast_api_reader;
GRANT USAGE ON SCHEMA public TO netvision_fast_api_reader;
GRANT SELECT ON "MitigationTrafficObservation" TO netvision_fast_api_reader;
ALTER ROLE netvision_fast_api_reader IN DATABASE netvision_fast_observe SET default_transaction_read_only = on;
COMMIT;
-- Verify SHOW transaction_read_only = on through the new connection, SELECT
-- succeeds and INSERT/UPDATE/DELETE fail. No operational/vault grants required.
