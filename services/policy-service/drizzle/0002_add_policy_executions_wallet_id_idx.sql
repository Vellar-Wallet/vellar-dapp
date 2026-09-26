CREATE TABLE IF NOT EXISTS policy_executions (
    id text PRIMARY KEY NOT NULL,
    policy_id text NOT NULL,
    wallet_id text NOT NULL,
    status text NOT NULL,
    executed_at timestamp with time zone NOT NULL,
    metadata jsonb
);

CREATE INDEX IF NOT EXISTS idx_policy_executions_wallet_id ON policy_executions(wallet_id);
