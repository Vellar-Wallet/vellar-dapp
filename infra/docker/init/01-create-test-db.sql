-- Dedicated database for integration tests (TEST_DATABASE_URL) so test
-- truncation can never touch dev data in the `vela` database.
CREATE DATABASE vela_test;
