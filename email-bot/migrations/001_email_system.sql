-- Email System Migration
-- Run with: npx wrangler d1 execute email-bot-db --remote --file=migrations/001_email_system.sql

-- Email campaigns table
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  title TEXT,
  subject TEXT NOT NULL,
  preview_text TEXT,
  body_html TEXT NOT NULL,
  body_text TEXT,
  segment TEXT DEFAULT 'all',
  status TEXT DEFAULT 'draft',
  scheduled_at TEXT,
  sent_at TEXT,
  sent_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Individual send records
CREATE TABLE IF NOT EXISTS email_sends (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  lead_id INTEGER NOT NULL,
  ses_message_id TEXT,
  status TEXT DEFAULT 'queued',
  opened_at TEXT,
  clicked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (email_id) REFERENCES emails(id),
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

-- Click tracking
CREATE TABLE IF NOT EXISTS email_clicks (
  id TEXT PRIMARY KEY,
  send_id TEXT NOT NULL,
  url TEXT NOT NULL,
  clicked_at TEXT NOT NULL,
  FOREIGN KEY (send_id) REFERENCES email_sends(id)
);

-- Add columns to existing leads table
ALTER TABLE leads ADD COLUMN unsubscribed_at TEXT;
ALTER TABLE leads ADD COLUMN bounce_count INTEGER DEFAULT 0;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_scheduled ON emails(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_email_sends_email ON email_sends(email_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_lead ON email_sends(lead_id);
CREATE INDEX IF NOT EXISTS idx_email_clicks_send ON email_clicks(send_id);
