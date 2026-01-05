-- Migration: Create launch system tables
-- Run this before migration_add_handoff.sql

-- Launch document templates
CREATE TABLE IF NOT EXISTS launch_docs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  version TEXT DEFAULT '1.0',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Launch projects (instances of launches)
CREATE TABLE IF NOT EXISTS launch_projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  genre TEXT,
  launch_doc_ids TEXT,
  target_launch_date TEXT,
  status TEXT DEFAULT 'setup',
  current_phase TEXT,
  shared INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Launch checklist items
CREATE TABLE IF NOT EXISTS launch_checklist (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  doc_id TEXT,
  phase TEXT NOT NULL,
  section TEXT,
  item_text TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  tags TEXT,
  due_offset INTEGER,
  is_recurring INTEGER DEFAULT 0,
  completed INTEGER DEFAULT 0,
  completed_at TEXT,
  task_id TEXT,
  handed_to TEXT,
  handed_at TEXT,
  FOREIGN KEY (project_id) REFERENCES launch_projects(id)
);

-- Launch metrics
CREATE TABLE IF NOT EXISTS launch_metrics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  recorded_date TEXT NOT NULL,
  metric_type TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  value REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES launch_projects(id)
);

-- Content batches
CREATE TABLE IF NOT EXISTS content_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  batch_date TEXT NOT NULL,
  platform TEXT NOT NULL,
  videos_scripted INTEGER DEFAULT 0,
  videos_filmed INTEGER DEFAULT 0,
  videos_edited INTEGER DEFAULT 0,
  videos_scheduled INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES launch_projects(id)
);

-- Posting log
CREATE TABLE IF NOT EXISTS posting_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  post_date TEXT NOT NULL,
  platform TEXT NOT NULL,
  post_count INTEGER DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES launch_projects(id)
);

-- Launch check-ins
CREATE TABLE IF NOT EXISTS launch_checkins (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  week_number INTEGER NOT NULL,
  checkin_date TEXT NOT NULL,
  wins TEXT,
  struggles TEXT,
  patterns TEXT,
  next_week_focus TEXT,
  metrics_snapshot TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES launch_projects(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_launch_checklist_project ON launch_checklist(project_id);
CREATE INDEX IF NOT EXISTS idx_launch_checklist_phase ON launch_checklist(project_id, phase);
CREATE INDEX IF NOT EXISTS idx_launch_metrics_project ON launch_metrics(project_id, recorded_date);
CREATE INDEX IF NOT EXISTS idx_posting_log_project ON posting_log(project_id, platform, post_date);
