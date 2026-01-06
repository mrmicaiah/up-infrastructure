-- ======================================================
-- EMAIL PLATFORM REBUILD - PHASE 1 MIGRATION
-- Creates: lists, subscriptions, sequences, sequence_steps,
--          sequence_enrollments, templates
-- Migrates: existing leads to default list subscription
-- ======================================================

-- =====================
-- STEP 1: Add missing columns to leads table
-- =====================

-- Add unsubscribed_at if it doesn't exist
ALTER TABLE leads ADD COLUMN unsubscribed_at TEXT;

-- Add bounce_count if it doesn't exist  
ALTER TABLE leads ADD COLUMN bounce_count INTEGER DEFAULT 0;

-- =====================
-- STEP 2: Create new tables
-- =====================

-- LISTS
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

-- SUBSCRIPTIONS (lead <-> list join table)
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

-- SEQUENCES (automation series)
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

-- SEQUENCE STEPS (emails in a sequence)
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

-- SEQUENCE ENROLLMENTS (who's going through what sequence)
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

-- TEMPLATES (reusable email templates)
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
-- STEP 3: Create emails table if it doesn't exist
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
-- STEP 4: Create email_sends table if it doesn't exist
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
-- STEP 5: Create email_clicks table if it doesn't exist
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
-- STEP 6: Create default list for existing data
-- =====================

INSERT OR IGNORE INTO lists (id, name, slug, description, from_name, from_email, status, created_at, updated_at)
VALUES (
  'default-list',
  'Untitled Publishers',
  'untitled-publishers',
  'Default list for all subscribers',
  'Untitled Publishers',
  'no-reply@untitledpublishers.com',
  'active',
  datetime('now'),
  datetime('now')
);

-- =====================
-- STEP 7: Migrate existing leads to subscriptions
-- =====================

INSERT OR IGNORE INTO subscriptions (id, lead_id, list_id, status, source, funnel, subscribed_at, created_at)
SELECT 
  'sub-' || id,
  id,
  'default-list',
  CASE WHEN unsubscribed_at IS NOT NULL THEN 'unsubscribed' ELSE 'active' END,
  source,
  funnel,
  created_at,
  datetime('now')
FROM leads;

-- =====================
-- STEP 8: Update existing emails to reference default list
-- =====================

UPDATE emails SET list_id = 'default-list' WHERE list_id IS NULL;

-- =====================
-- STEP 9: Update email_sends with subscription_id
-- =====================

UPDATE email_sends 
SET subscription_id = 'sub-' || lead_id
WHERE subscription_id IS NULL;
