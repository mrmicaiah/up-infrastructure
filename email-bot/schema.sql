-- ======================================================
-- EMAIL PLATFORM DATABASE SCHEMA
-- Cloudflare D1
-- 
-- Last Updated: Phase 2 - Blog posts support
-- ======================================================

-- =====================
-- LEADS (core subscriber data)
-- =====================
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  source TEXT DEFAULT 'direct',
  funnel TEXT,
  segment TEXT,
  quiz_result TEXT,
  tags TEXT,
  metadata TEXT,
  ip_country TEXT,
  esp_synced_at TEXT,
  esp_id TEXT,
  unsubscribed_at TEXT,
  bounce_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_funnel ON leads(funnel);
CREATE INDEX IF NOT EXISTS idx_leads_segment ON leads(segment);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);

-- =====================
-- TOUCHES (interaction history)
-- =====================
CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  source TEXT,
  funnel TEXT,
  touched_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_touches_lead ON touches(lead_id);
CREATE INDEX IF NOT EXISTS idx_touches_date ON touches(touched_at);

-- =====================
-- LISTS (email lists)
-- =====================
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  reply_to TEXT,
  welcome_sequence_id TEXT,
  double_optin INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lists_slug ON lists(slug);
CREATE INDEX IF NOT EXISTS idx_lists_status ON lists(status);

-- =====================
-- SUBSCRIPTIONS (lead <-> list relationship)
-- =====================
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  lead_id INTEGER NOT NULL,
  list_id TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  source TEXT,
  funnel TEXT,
  subscribed_at TEXT NOT NULL,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id),
  FOREIGN KEY (list_id) REFERENCES lists(id),
  UNIQUE(lead_id, list_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_lead ON subscriptions(lead_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_list ON subscriptions(list_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- =====================
-- SEQUENCES (automation series)
-- =====================
CREATE TABLE IF NOT EXISTS sequences (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT DEFAULT 'subscribe',
  trigger_value TEXT,
  status TEXT DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (list_id) REFERENCES lists(id)
);

CREATE INDEX IF NOT EXISTS idx_sequences_list ON sequences(list_id);
CREATE INDEX IF NOT EXISTS idx_sequences_status ON sequences(status);

-- =====================
-- SEQUENCE STEPS (emails in a sequence)
-- =====================
CREATE TABLE IF NOT EXISTS sequence_steps (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  delay_minutes INTEGER DEFAULT 0,
  subject TEXT NOT NULL,
  preview_text TEXT,
  body_html TEXT NOT NULL,
  body_text TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (sequence_id) REFERENCES sequences(id)
);

CREATE INDEX IF NOT EXISTS idx_sequence_steps_sequence ON sequence_steps(sequence_id);

-- =====================
-- SEQUENCE ENROLLMENTS (subscriber progress)
-- =====================
CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  sequence_id TEXT NOT NULL,
  current_step INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  enrolled_at TEXT NOT NULL,
  next_send_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id),
  FOREIGN KEY (sequence_id) REFERENCES sequences(id),
  UNIQUE(subscription_id, sequence_id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_next_send ON sequence_enrollments(next_send_at);
CREATE INDEX IF NOT EXISTS idx_enrollments_status ON sequence_enrollments(status);
CREATE INDEX IF NOT EXISTS idx_enrollments_subscription ON sequence_enrollments(subscription_id);

-- =====================
-- TEMPLATES (reusable email templates)
-- =====================
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  list_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  subject TEXT,
  body_html TEXT NOT NULL,
  body_text TEXT,
  category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (list_id) REFERENCES lists(id)
);

CREATE INDEX IF NOT EXISTS idx_templates_list ON templates(list_id);
CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);

-- =====================
-- EMAILS (campaigns)
-- =====================
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  list_id TEXT,
  title TEXT,
  subject TEXT NOT NULL,
  preview_text TEXT,
  body_html TEXT NOT NULL,
  body_text TEXT,
  segment TEXT,
  status TEXT DEFAULT 'draft',
  scheduled_at TEXT,
  sent_at TEXT,
  sent_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (list_id) REFERENCES lists(id)
);

CREATE INDEX IF NOT EXISTS idx_emails_list ON emails(list_id);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_scheduled ON emails(scheduled_at);

-- =====================
-- EMAIL SENDS (individual deliveries)
-- =====================
CREATE TABLE IF NOT EXISTS email_sends (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  lead_id INTEGER NOT NULL,
  subscription_id TEXT,
  ses_message_id TEXT,
  status TEXT DEFAULT 'pending',
  opened_at TEXT,
  clicked_at TEXT,
  bounced_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (email_id) REFERENCES emails(id),
  FOREIGN KEY (lead_id) REFERENCES leads(id),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);

CREATE INDEX IF NOT EXISTS idx_email_sends_email ON email_sends(email_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_lead ON email_sends(lead_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_subscription ON email_sends(subscription_id);

-- =====================
-- EMAIL CLICKS (click tracking)
-- =====================
CREATE TABLE IF NOT EXISTS email_clicks (
  id TEXT PRIMARY KEY,
  send_id TEXT NOT NULL,
  url TEXT NOT NULL,
  clicked_at TEXT NOT NULL,
  FOREIGN KEY (send_id) REFERENCES email_sends(id)
);

CREATE INDEX IF NOT EXISTS idx_email_clicks_send ON email_clicks(send_id);

-- =====================
-- BLOG POSTS (multi-site blog support)
-- =====================
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
