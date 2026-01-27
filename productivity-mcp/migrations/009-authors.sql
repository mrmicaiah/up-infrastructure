-- Migration: Add authors table
-- Date: 2026-01-27
-- Purpose: Foundation for blog author system. Authors are shared across all UP blogs.

CREATE TABLE IF NOT EXISTS authors (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  bio TEXT,
  photo_url TEXT,
  email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_authors_slug ON authors(slug);

-- Insert default author (Micaiah)
INSERT OR IGNORE INTO authors (id, name, slug, bio, email)
VALUES (
  'author-micaiah',
  'Micaiah Bussey',
  'micaiah-bussey',
  'Founder of Untitled Publishers',
  'micaiah@untitledpublishers.com'
);
