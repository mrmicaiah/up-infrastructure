-- Handoff Queue Migration
-- Creates table for task delegation between Claude instances

CREATE TABLE IF NOT EXISTS handoff_queue (
  id TEXT PRIMARY KEY,
  instruction TEXT NOT NULL,
  context TEXT,
  files_needed TEXT, -- JSON array
  priority TEXT DEFAULT 'normal', -- low, normal, high, urgent
  estimated_complexity TEXT DEFAULT 'moderate', -- simple, moderate, complex
  project_name TEXT,
  parent_task_id TEXT,
  status TEXT DEFAULT 'pending', -- pending, claimed, in_progress, complete, blocked
  created_at TEXT DEFAULT (datetime('now')),
  claimed_at TEXT,
  completed_at TEXT,
  output_summary TEXT,
  output_location TEXT, -- github, drive, both, local
  files_created TEXT, -- JSON array
  github_repo TEXT,
  github_paths TEXT, -- JSON array
  drive_folder_id TEXT,
  drive_file_ids TEXT, -- JSON array
  worker_notes TEXT,
  blocked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_handoff_status ON handoff_queue(status);
CREATE INDEX IF NOT EXISTS idx_handoff_priority ON handoff_queue(priority);
CREATE INDEX IF NOT EXISTS idx_handoff_project ON handoff_queue(project_name);
CREATE INDEX IF NOT EXISTS idx_handoff_created ON handoff_queue(created_at);
