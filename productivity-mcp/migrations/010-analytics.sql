-- Migration: Add analytics_properties table for GA4 integration
-- Date: 2026-01-28

CREATE TABLE IF NOT EXISTS analytics_properties (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  property_id TEXT NOT NULL,           -- GA4 property ID (numeric, e.g., 123456789)
  name TEXT NOT NULL,                   -- Friendly name for the property
  blog_id TEXT,                         -- Optional link to Blogger blog ID
  created_at TEXT NOT NULL,
  UNIQUE(user_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_analytics_user ON analytics_properties(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_blog ON analytics_properties(blog_id);
