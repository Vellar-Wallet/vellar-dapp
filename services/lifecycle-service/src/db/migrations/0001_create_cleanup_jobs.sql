-- Create cleanup_jobs table for Issue #293: Per-account ordered cleanup job queue
CREATE TABLE IF NOT EXISTS cleanup_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead_letter')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  record JSONB NOT NULL,
  CONSTRAINT valid_record CHECK (record IS NOT NULL AND jsonb_typeof(record) = 'object')
);

-- Indexes for efficient claiming and queries
CREATE INDEX IF NOT EXISTS cleanup_jobs_account_idx ON cleanup_jobs (account_id);
CREATE INDEX IF NOT EXISTS cleanup_jobs_status_idx ON cleanup_jobs (status);
-- Per-account FIFO ordering index for worker's claim query
CREATE INDEX IF NOT EXISTS cleanup_jobs_account_created_idx ON cleanup_jobs (account_id, created_at ASC);
