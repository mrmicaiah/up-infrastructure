-- Migration: Create deploys table for GitHub webhook tracking
-- Run with: npx wrangler d1 execute productivity-db --file=deploys-migration.sql

CREATE TABLE IF NOT EXISTS deploys (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  workflow TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress, success, failure, cancelled
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

-- Index for quick lookups by repo
CREATE INDEX IF NOT EXISTS idx_deploys_repo ON deploys(repo);

-- Index for recent deploys
CREATE INDEX IF NOT EXISTS idx_deploys_created ON deploys(created_at DESC);

-- Composite index for repo + status queries
CREATE INDEX IF NOT EXISTS idx_deploys_repo_status ON deploys(repo, status);
