-- Migration: Create handoff_tasks table
-- Date: 2026-01-28

CREATE TABLE IF NOT EXISTS handoff_tasks (
  id TEXT PRIMARY KEY,
  instruction TEXT NOT NULL,
  context TEXT,
  files_needed TEXT,                  -- JSON array
  priority TEXT DEFAULT 'normal',     -- 'low', 'normal', 'high', 'urgent'
  estimated_complexity TEXT DEFAULT 'moderate', -- 'simple', 'moderate', 'complex'
  project_name TEXT DEFAULT 'General',
  parent_task_id TEXT,
  status TEXT DEFAULT 'pending',      -- 'pending', 'claimed', 'in_progress', 'complete', 'blocked'
  blocked_reason TEXT,
  progress_notes TEXT,
  claimed_at TEXT,
  completed_at TEXT,
  output_summary TEXT,
  output_location TEXT,               -- 'github', 'drive', 'both', 'local'
  files_created TEXT,                 -- JSON array
  github_repo TEXT,
  github_paths TEXT,                  -- JSON array
  drive_folder_id TEXT,
  drive_file_ids TEXT,                -- JSON array
  worker_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handoff_tasks_status ON handoff_tasks(status);
CREATE INDEX IF NOT EXISTS idx_handoff_tasks_project ON handoff_tasks(project_name);
CREATE INDEX IF NOT EXISTS idx_handoff_tasks_priority ON handoff_tasks(priority);
