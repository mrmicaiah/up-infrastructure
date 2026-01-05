-- Email Bot Server Database Schema
-- Cloudflare D1

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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  source TEXT,
  funnel TEXT,
  touched_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_funnel ON leads(funnel);
CREATE INDEX IF NOT EXISTS idx_leads_segment ON leads(segment);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_touches_lead ON touches(lead_id);
CREATE INDEX IF NOT EXISTS idx_touches_date ON touches(touched_at);