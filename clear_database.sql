-- =====================================================
-- EasyOpenAPI - Clear Database Script
-- =====================================================
-- This script drops all tables and indexes used by EasyOpenAPI
-- Use this to completely reset the database before running create_tables.sql

-- Drop indexes first (to avoid dependency issues)
DROP INDEX IF EXISTS idx_value_sets_config_endpoint;
DROP INDEX IF EXISTS idx_value_sets_unique_name;
DROP INDEX IF EXISTS idx_value_sets_created_at;
DROP INDEX IF EXISTS idx_value_sets_user_account;

DROP INDEX IF EXISTS idx_test_results_config_endpoint;
DROP INDEX IF EXISTS idx_test_results_unique_name;
DROP INDEX IF EXISTS idx_test_results_timestamp;
DROP INDEX IF EXISTS idx_test_results_user_account;

DROP INDEX IF EXISTS idx_custom_endpoints_config_id;
DROP INDEX IF EXISTS idx_custom_endpoints_unique;

DROP INDEX IF EXISTS idx_configurations_url;

-- Drop tables
DROP TABLE IF EXISTS value_sets;
DROP TABLE IF EXISTS test_results;
DROP TABLE IF EXISTS custom_endpoints;
DROP TABLE IF EXISTS configurations;

-- Note: This script does not drop the schema itself to avoid affecting other tables
-- If you want to drop the entire schema, use:
-- DROP SCHEMA IF EXISTS public CASCADE;
-- CREATE SCHEMA public;
