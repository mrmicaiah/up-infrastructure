-- Migration: Add messages table for team messaging system
-- Date: 2026-01-03

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_to_user ON messages(to_user);
CREATE INDEX IF NOT EXISTS idx_messages_from_user ON messages(from_user);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
