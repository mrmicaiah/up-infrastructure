-- Journal System Tables

-- Core journal entries
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  entry_type TEXT NOT NULL DEFAULT 'freeform',
  title TEXT,
  raw_content TEXT NOT NULL,
  refined_content TEXT,
  mood TEXT,
  energy_level INTEGER,
  linked_to_penzu INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Extracted entities from journal entries
CREATE TABLE IF NOT EXISTS journal_entities (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_value TEXT NOT NULL,
  sentiment TEXT DEFAULT 'neutral',
  created_at TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES journal_entries(id)
);

-- Links between journal entries and other items
CREATE TABLE IF NOT EXISTS journal_entry_links (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  link_type TEXT NOT NULL,
  link_id TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES journal_entries(id)
);

-- Discovered patterns from journal analysis
CREATE TABLE IF NOT EXISTS journal_patterns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pattern_type TEXT NOT NULL,
  pattern_data TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- User journal settings
CREATE TABLE IF NOT EXISTS journal_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  penzu_email TEXT,
  default_type TEXT DEFAULT 'freeform',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_journal_entries_user_date ON journal_entries(user_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_mood ON journal_entries(user_id, mood);
CREATE INDEX IF NOT EXISTS idx_journal_entities_entry ON journal_entities(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_entities_value ON journal_entities(entity_value);
CREATE INDEX IF NOT EXISTS idx_journal_patterns_user ON journal_patterns(user_id, pattern_type);
