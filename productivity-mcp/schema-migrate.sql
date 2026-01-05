CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'micaiah',
  title TEXT NOT NULL,
  content TEXT,
  category TEXT DEFAULT 'General',
  tags TEXT,
  created_at TEXT NOT NULL,
  archived INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS progress_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  logged_at TEXT NOT NULL,
  task_id TEXT,
  task_text TEXT,
  description TEXT,
  minutes_spent INTEGER,
  project TEXT,
  category TEXT,
  was_planned INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS weekly_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  available_days INTEGER DEFAULT 5,
  available_hours_per_day INTEGER DEFAULT 8,
  focus_level TEXT DEFAULT 'normal',
  main_projects TEXT,
  constraints TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoff_suggestions (
  id TEXT PRIMARY KEY,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  task_id TEXT NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL,
  responded_at TEXT
);