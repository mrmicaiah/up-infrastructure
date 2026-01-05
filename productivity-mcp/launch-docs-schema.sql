-- Launch Docs Schema Migration
-- Run these commands via wrangler d1 execute

-- Master documents (engines, playbooks)
CREATE TABLE IF NOT EXISTS launch_docs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  description TEXT,
  content TEXT,
  version TEXT DEFAULT '1.0',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Active launch projects
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

-- Checklist items extracted from documents
CREATE TABLE IF NOT EXISTS launch_checklist (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  section TEXT,
  item_text TEXT NOT NULL,
  sort_order INTEGER,
  tags TEXT,
  due_offset INTEGER,
  is_recurring TEXT,
  completed INTEGER DEFAULT 0,
  completed_at TEXT,
  task_id TEXT,
  notes TEXT,
  FOREIGN KEY (project_id) REFERENCES launch_projects(id)
);

-- Metrics tracking
CREATE TABLE IF NOT EXISTS launch_metrics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  recorded_date TEXT NOT NULL,
  metric_type TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  value REAL,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES launch_projects(id)
);

-- Weekly check-ins
CREATE TABLE IF NOT EXISTS launch_checkins (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  week_number INTEGER,
  checkin_date TEXT NOT NULL,
  wins TEXT,
  struggles TEXT,
  patterns TEXT,
  next_week_focus TEXT,
  metrics_snapshot TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES launch_projects(id)
);

-- Content batch tracking
CREATE TABLE IF NOT EXISTS content_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  batch_date TEXT NOT NULL,
  platform TEXT DEFAULT 'tiktok',
  videos_scripted INTEGER DEFAULT 0,
  videos_filmed INTEGER DEFAULT 0,
  videos_edited INTEGER DEFAULT 0,
  videos_scheduled INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES launch_projects(id)
);

-- Posting log for streaks
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

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_launch_checklist_project ON launch_checklist(project_id);
CREATE INDEX IF NOT EXISTS idx_launch_checklist_task ON launch_checklist(task_id);
CREATE INDEX IF NOT EXISTS idx_launch_metrics_project ON launch_metrics(project_id, recorded_date);
CREATE INDEX IF NOT EXISTS idx_posting_log_project ON posting_log(project_id, post_date);
CREATE INDEX IF NOT EXISTS idx_launch_projects_user ON launch_projects(user_id, status);
