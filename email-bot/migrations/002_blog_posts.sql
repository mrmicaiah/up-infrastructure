-- =====================================================
-- MIGRATION: Add blog_posts table
-- Run with: wrangler d1 execute email-bot-db --file=./migrations/002_blog_posts.sql
-- =====================================================

-- Blog posts table (multi-site support)
CREATE TABLE IF NOT EXISTS blog_posts (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL DEFAULT 'micaiah-bussey',
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT,
  content_md TEXT NOT NULL,
  content_html TEXT NOT NULL,
  category TEXT,
  tags TEXT,
  featured_image TEXT,
  author TEXT DEFAULT 'Micaiah Bussey',
  status TEXT DEFAULT 'draft',
  published_at TEXT,
  scheduled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(site, slug)
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_site ON blog_posts(site);
CREATE INDEX IF NOT EXISTS idx_blog_posts_slug ON blog_posts(slug);
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published ON blog_posts(published_at);
CREATE INDEX IF NOT EXISTS idx_blog_posts_scheduled ON blog_posts(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON blog_posts(category);
