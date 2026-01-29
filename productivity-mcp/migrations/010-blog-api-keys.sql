-- Blog API keys storage for UP Blogs multi-tenant system
-- Allows storing API keys in D1 so they can be retrieved at runtime
-- without needing to set wrangler secrets for each blog

CREATE TABLE IF NOT EXISTS blog_api_keys (
  blog_id TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
