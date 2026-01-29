-- Protected repos table
-- Prevents accidental writes to critical repositories

CREATE TABLE IF NOT EXISTS protected_repos (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL UNIQUE,           -- Full repo path (e.g., 'mrmicaiah/courier')
  protected_by TEXT NOT NULL,          -- User who protected it
  protected_at TEXT NOT NULL,
  reason TEXT                           -- Optional reason for protection
);

CREATE INDEX idx_protected_repos_repo ON protected_repos(repo);
