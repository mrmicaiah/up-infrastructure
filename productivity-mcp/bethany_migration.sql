-- ==================
-- BETHANY: Work Day Tracking
-- ==================

-- Work sessions (morning to night)
CREATE TABLE IF NOT EXISTS work_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  total_minutes INTEGER,
  morning_plan TEXT,
  end_of_day_summary TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, session_date)
);

-- Checkpoints throughout the day
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  checkpoint_time TEXT NOT NULL,
  trigger_type TEXT NOT NULL, -- 'morning', 'night', 'task_added', 'task_completed', 'topic_shift', 'manual', 'auto'
  summary TEXT NOT NULL,
  topics TEXT, -- JSON array of topic strings
  discoveries TEXT, -- What was learned/figured out
  task_ids TEXT, -- JSON array of related task IDs
  chat_context TEXT, -- Brief context of what conversation was about
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES work_sessions(id)
);

-- Index for fast daily queries
CREATE INDEX IF NOT EXISTS idx_checkpoints_user_date ON checkpoints(user_id, checkpoint_time);
CREATE INDEX IF NOT EXISTS idx_work_sessions_user_date ON work_sessions(user_id, session_date);
