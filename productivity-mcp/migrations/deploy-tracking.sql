-- Deploy tracking table for GitHub webhook events
CREATE TABLE IF NOT EXISTS deploys (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  workflow TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL,  -- 'success', 'failure', 'in_progress'
  branch TEXT,
  commit_sha TEXT,
  commit_message TEXT,
  triggered_by TEXT,
  started_at TEXT,
  completed_at TEXT,
  duration_seconds INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deploys_repo ON deploys(repo);
CREATE INDEX IF NOT EXISTS idx_deploys_status ON deploys(status);
CREATE INDEX IF NOT EXISTS idx_deploys_created ON deploys(created_at DESC);
