# Productivity MCP Server - Database Schema

> **⚠️ UPDATE THIS FILE FIRST when making database changes!**
> 
> This is the single source of truth for the D1 database structure.
> Both Micaiah and Irene's workers share this database (`productivity-brain`).

## Quick Reference

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `tasks` | Main task storage | id, user_id, text, status, recurrence, assigned_by, is_active, objective_id |
| `sprints` | Time-boxed work periods | user_id, name, end_date, status |
| `objectives` | "Pushing for" statements | sprint_id, statement, sort_order |
| `messages` | Team messaging | from_user, to_user, content, read_at |
| `check_ins` | Session recaps with thread summaries | user_id, thread_summary, full_recap, logged |
| `work_logs` | Synthesized work narratives | user_id, narrative, shipped, period_start |
| `check_in_comments` | Comments on check-ins | check_in_id, user_id, content, seen |
| `task_events` | Event logging for patterns | user_id, event_type, event_data |
| `daily_logs` | Daily completion stats | user_id, log_date, tasks_completed |
| `user_patterns` | Learned productivity patterns | user_id, pattern_type, pattern_data |
| `progress_logs` | Work progress entries | user_id, task_id, description |
| `work_sessions` | Daily work sessions | user_id, session_date, started_at |
| `checkpoints` | Work checkpoints | user_id, session_id, summary |
| `handoff_suggestions` | Team task handoffs | from_user, to_user, task_id |
| `skills` | Stored skill instructions | name, content, category |
| `plans` | **DEPRECATED** - use sprints | user_id, title, start_date |
| `plan_goals` | **DEPRECATED** - use objectives | plan_id, description |
| `launch_docs` | Launch document templates | name, doc_type, content |
| `launch_projects` | Active launch projects | user_id, title, current_phase |
| `launch_checklist` | Checklist items for launches | project_id, phase, item_text, handed_to |
| `launch_metrics` | Metrics tracking | project_id, metric_type, value |
| `launch_checkins` | Weekly accountability check-ins | project_id, week_number, wins |
| `content_batches` | Content creation tracking | project_id, videos_scripted |
| `posting_log` | Social posting log | project_id, platform, post_date |
| `journal_entries` | Journal entries | user_id, entry_date, content, mood |
| `journal_entities` | Extracted entities from journal | entry_id, entity_type, entity_value |
| `journal_patterns` | Journal-specific patterns | user_id, pattern_type, pattern_data |
| `notes` | Notes storage | user_id, title, content |
| `ideas` | Ideas storage | user_id, title, category |
| `oauth_tokens` | OAuth token storage | user_id, service, access_token |

---

## Full Schema

### tasks
Main task storage with support for recurring tasks, subtasks, team assignments, and sprint linking.

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  priority INTEGER DEFAULT 3,         -- 1-5, higher = more important
  due_date TEXT,                      -- YYYY-MM-DD format
  category TEXT,
  project TEXT,
  status TEXT DEFAULT 'open',         -- 'open' or 'done'
  created_at TEXT NOT NULL,
  completed_at TEXT,
  last_touched TEXT,
  needs_breakdown INTEGER DEFAULT 0,  -- 1 if task is too big
  is_vague INTEGER DEFAULT 0,         -- 1 if task needs clarification
  focus_level TEXT,                   -- 'low', 'medium', 'high'
  notes TEXT,
  recurrence TEXT,                    -- 'daily', 'weekdays', 'weekly', etc.
  snoozed_until TEXT,                 -- YYYY-MM-DD format
  parent_task_id TEXT,                -- For subtasks
  assigned_by TEXT,                   -- Who assigned this task (for Incoming inbox)
  is_active INTEGER DEFAULT 0,        -- 1 if task is in Active List
  objective_id TEXT,                  -- Links task to a sprint objective (Added 2026-01-03)
  original_category TEXT,             -- Preserved category for return after sprint (Added 2026-01-03)
  plan_goal_id TEXT                   -- **DEPRECATED** - use objective_id
);
```

**Used by:** `tasks.ts`, `bethany.ts`, `sprints.ts`

**Active List Logic:** Task appears in Active List if `is_active = 1` OR linked to an objective via `objective_id`.

**Sprint Logic:** When `objective_id IS NOT NULL`, task is part of a sprint. `original_category` stores where to return the task when sprint ends.

**Incoming Inbox Logic:** When `assigned_by IS NOT NULL`, the task appears in the user's Incoming section until claimed.

---

### sprints
Time-boxed work periods with defined end dates. Replaces the old `plans` table.

```sql
CREATE TABLE sprints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                 -- "January Sprint", "This Week", etc.
  end_date TEXT NOT NULL,             -- YYYY-MM-DD format
  status TEXT DEFAULT 'active',       -- 'active', 'completed', 'abandoned'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Used by:** `sprints.ts`, `bethany.ts`, `api-routes.ts`

**Status values:**
- `active` — Currently being worked on
- `completed` — Sprint ended successfully
- `abandoned` — Sprint ended early

---

### objectives
"Pushing for" statements that group tasks within a sprint. Replaces the old `plan_goals` table.

```sql
CREATE TABLE objectives (
  id TEXT PRIMARY KEY,
  sprint_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  statement TEXT NOT NULL,            -- "Two Proverbs Library books done"
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE
);
```

**Used by:** `sprints.ts`, `bethany.ts`, `api-routes.ts`

**Key difference from old goals:** No tracking metrics (target_count, completed_count, unit). Success is determined by completing all linked tasks.

---

### messages
Team messaging system for communication between teammates.

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_user TEXT NOT NULL,            -- Username of sender
  to_user TEXT NOT NULL,              -- Username of recipient
  content TEXT NOT NULL,              -- Message text
  created_at TEXT NOT NULL,           -- When message was sent
  read_at TEXT,                       -- When message was read (NULL = unread)
  expires_at TEXT                     -- Auto-cleanup after this date (60 days default)
);

CREATE INDEX idx_messages_to_user ON messages(to_user);
CREATE INDEX idx_messages_from_user ON messages(from_user);
CREATE INDEX idx_messages_expires ON messages(expires_at);
```

**Used by:** `team.ts`, `api-routes.ts`

**Tools:**
- `send_message` — Send a message to a teammate
- `check_messages` — View unread messages (marks them as read)
- `message_history` — View conversation history with a teammate

**Dashboard Integration:** Messages appear in the dashboard header badge and can be viewed/dismissed from the message banner.

**Auto-cleanup:** Expired messages are deleted when any message operation runs.

---

### check_ins
Session recaps with fun thread summaries for the activity feed.

```sql
CREATE TABLE check_ins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  thread_summary TEXT NOT NULL,       -- ~280 chars, fun/sarcastic tone
  full_recap TEXT NOT NULL,           -- Detailed markdown recap
  project_name TEXT,                  -- Optional context
  logged INTEGER DEFAULT 0,           -- 0=unlogged, 1=claimed by work_log
  work_log_id TEXT                    -- FK to work_logs (null if unclaimed)
);

CREATE INDEX idx_check_ins_user ON check_ins(user_id);
CREATE INDEX idx_check_ins_logged ON check_ins(logged);
```

**Used by:** `checkins.ts`

**Tools:**
- `add_checkin` — Create a new check-in (called by session-recap skill)
- `list_checkins` — List check-ins, optionally filtered by user or logged status
- `get_checkin` — View full check-in with comments

**Thread summary examples:**
- "Finally wrestled that navbar into submission. Only took 3 hours and my sanity."
- "Blue River Gutters is LIVE. Cloudinary saves the day after GitHub Pages threw a tantrum."

---

### work_logs
Synthesized narratives from multiple check-ins.

```sql
CREATE TABLE work_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  period_start DATETIME,              -- Earliest check_in in this log
  period_end DATETIME,                -- Latest check_in in this log
  narrative TEXT NOT NULL,            -- Synthesized story
  shipped TEXT                        -- JSON array of concrete outputs
);

CREATE INDEX idx_work_logs_user ON work_logs(user_id);
```

**Used by:** `checkins.ts`

**Tools:**
- `create_work_log` — Pull unlogged check-ins for synthesis
- `save_work_log` — Save synthesized narrative and mark check-ins as logged
- `list_work_logs` — List work logs
- `get_work_log` — View full work log

**Workflow:** User says "log my work" → `create_work_log` returns unlogged check-ins → Claude synthesizes → `save_work_log` saves and links

---

### check_in_comments
Comments on check-ins for team interaction.

```sql
CREATE TABLE check_in_comments (
  id TEXT PRIMARY KEY,
  check_in_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  content TEXT NOT NULL,
  seen INTEGER DEFAULT 0              -- For future notification system
);

CREATE INDEX idx_comments_checkin ON check_in_comments(check_in_id);
```

**Used by:** `checkins.ts`

**Tools:**
- `add_checkin_comment` — Add a comment to any check-in
- `list_checkin_comments` — List comments on a check-in

---

### task_events
Event logging for pattern analysis.

```sql
CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  task_id TEXT,
  event_type TEXT NOT NULL,           -- 'created', 'completed', 'deleted', etc.
  event_data TEXT,                    -- JSON with day, time, etc.
  created_at TEXT NOT NULL
);
```

**Used by:** `helpers/intelligence.ts`

---

### daily_logs
Daily statistics for tracking.

```sql
CREATE TABLE daily_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  log_date TEXT NOT NULL,             -- YYYY-MM-DD format
  tasks_completed INTEGER DEFAULT 0,
  tasks_created INTEGER DEFAULT 0
);
```

**Used by:** `helpers/intelligence.ts`, `tasks.ts`

---

### user_patterns
Learned productivity patterns from task analysis.

```sql
CREATE TABLE user_patterns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pattern_type TEXT NOT NULL,         -- 'peak_time', 'peak_day', 'avg_completion_days', etc.
  pattern_data TEXT,                  -- JSON with pattern details
  confidence REAL,
  updated_at TEXT
);
```

**Used by:** `helpers/intelligence.ts`, `bethany.ts`

---

### progress_logs
Manual work progress entries.

```sql
CREATE TABLE progress_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  logged_at TEXT NOT NULL,
  task_id TEXT,
  description TEXT,
  minutes_spent INTEGER,
  was_planned INTEGER DEFAULT 0
);
```

**Used by:** `tasks.ts`

---

### work_sessions
Daily work session tracking (Bethany system).

```sql
CREATE TABLE work_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_date TEXT NOT NULL,         -- YYYY-MM-DD format
  started_at TEXT,
  ended_at TEXT,
  total_minutes INTEGER,
  end_of_day_summary TEXT,
  created_at TEXT NOT NULL
);
```

**Used by:** `bethany.ts`

---

### checkpoints
Work checkpoints within a session.

```sql
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  checkpoint_time TEXT NOT NULL,
  trigger_type TEXT,                  -- 'morning', 'night', 'task_added', 'manual', etc.
  summary TEXT,
  topics TEXT,                        -- JSON array
  discoveries TEXT,
  task_ids TEXT,                      -- JSON array
  created_at TEXT NOT NULL
);
```

**Used by:** `bethany.ts`, `helpers/intelligence.ts`

---

### handoff_suggestions
Team task handoff requests.

```sql
CREATE TABLE handoff_suggestions (
  id TEXT PRIMARY KEY,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  task_id TEXT NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'pending',      -- 'pending', 'accepted', 'declined'
  created_at TEXT NOT NULL
);
```

**Used by:** `team.ts`

---

### skills
Stored skill instructions for Claude to fetch and follow.

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  content TEXT NOT NULL,              -- The actual skill instructions/prompts
  category TEXT,                      -- 'planning', 'launch', 'content', etc.
  version TEXT DEFAULT '1.0',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Used by:** `skills.ts`

---

### plans (DEPRECATED)
> ⚠️ **DEPRECATED** - Use `sprints` table instead. Kept for historical data.

```sql
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  work_days_per_week INTEGER DEFAULT 5,
  status TEXT DEFAULT 'active',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

### plan_goals (DEPRECATED)
> ⚠️ **DEPRECATED** - Use `objectives` table instead. Kept for historical data.

```sql
CREATE TABLE plan_goals (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  description TEXT NOT NULL,
  target_count INTEGER DEFAULT 1,
  completed_count INTEGER DEFAULT 0,
  unit TEXT,
  deadline TEXT,
  status TEXT DEFAULT 'active',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

### launch_docs
Launch document templates.

```sql
CREATE TABLE launch_docs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  doc_type TEXT NOT NULL,             -- 'engine', 'playbook', 'operations'
  description TEXT,
  content TEXT NOT NULL,              -- Markdown with phases and checklist items
  version TEXT DEFAULT '1.0',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Used by:** `launch.ts`

---

### launch_projects
Active launch projects instantiated from docs.

```sql
CREATE TABLE launch_projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  genre TEXT,
  launch_doc_ids TEXT,                -- JSON array of doc IDs
  target_launch_date TEXT,            -- YYYY-MM-DD format
  status TEXT DEFAULT 'setup',
  current_phase TEXT,
  shared INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Used by:** `launch.ts`, `bethany.ts`

---

### launch_checklist
Checklist items for launch projects.

```sql
CREATE TABLE launch_checklist (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  doc_id TEXT,
  phase TEXT NOT NULL,
  section TEXT,
  item_text TEXT NOT NULL,
  sort_order INTEGER,
  tags TEXT,                          -- JSON array
  due_offset INTEGER,
  is_recurring INTEGER DEFAULT 0,
  completed INTEGER DEFAULT 0,
  completed_at TEXT,
  task_id TEXT,                       -- Link to tasks table
  handed_to TEXT,                     -- Username of person item is handed to
  handed_at TEXT                      -- Timestamp of handoff
);
```

**Used by:** `launch.ts`, `bethany.ts`

---

### launch_metrics
Metrics tracking for launches.

```sql
CREATE TABLE launch_metrics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  recorded_date TEXT NOT NULL,
  metric_type TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  value REAL,
  created_at TEXT NOT NULL
);
```

**Used by:** `launch.ts`

---

### launch_checkins
Weekly accountability check-ins.

```sql
CREATE TABLE launch_checkins (
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
  created_at TEXT NOT NULL
);
```

**Used by:** `launch.ts`

---

### content_batches
Content creation batch tracking.

```sql
CREATE TABLE content_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  batch_date TEXT NOT NULL,
  platform TEXT,
  videos_scripted INTEGER DEFAULT 0,
  videos_filmed INTEGER DEFAULT 0,
  videos_edited INTEGER DEFAULT 0,
  videos_scheduled INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);
```

**Used by:** `launch.ts`

---

### posting_log
Social media posting log.

```sql
CREATE TABLE posting_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  post_date TEXT NOT NULL,
  platform TEXT NOT NULL,
  post_count INTEGER DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL
);
```

**Used by:** `launch.ts`

---

### journal_entries
Journal entries with mood and energy tracking.

```sql
CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  entry_type TEXT DEFAULT 'freeform',
  content TEXT NOT NULL,
  mood TEXT,
  energy_level INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Used by:** `journal.ts`

---

### journal_entities
Extracted entities from journal entries.

```sql
CREATE TABLE journal_entities (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_value TEXT NOT NULL,
  sentiment TEXT,
  created_at TEXT NOT NULL
);
```

**Used by:** `journal.ts`

---

### journal_patterns
Journal-specific learned patterns.

```sql
CREATE TABLE journal_patterns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pattern_type TEXT NOT NULL,
  pattern_data TEXT,
  confidence REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Used by:** `helpers/intelligence.ts`

---

### notes
Simple notes storage.

```sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  category TEXT DEFAULT 'General',
  created_at TEXT NOT NULL
);
```

**Used by:** `notes.ts`

---

### ideas
Ideas storage with categorization.

```sql
CREATE TABLE ideas (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  category TEXT DEFAULT 'Unsorted',
  created_at TEXT NOT NULL
);
```

**Used by:** `notes.ts`

---

### oauth_tokens
OAuth token storage for external services.

```sql
CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, provider)
);
```

**Valid `provider` values:** `google_drive`, `gmail_personal`, `gmail_company`, `blogger`, `blogger_personal`, `blogger_company`, `google_contacts_personal`, `google_contacts_company`, `github`

**Used by:** `oauth/index.ts`, `connections.ts`

---

## Migration History

| Date | Change | Migration Command |
|------|--------|-------------------|
| 2025-12-29 | Added `handed_to` and `handed_at` to `launch_checklist` | `ALTER TABLE launch_checklist ADD COLUMN handed_to TEXT;` |
| 2025-12-30 | Added `blogger_personal` and `blogger_company` services | No migration needed |
| 2025-12-31 | Added `skills` table | See migration file |
| 2025-12-31 | Added `assigned_by` to `tasks` | `ALTER TABLE tasks ADD COLUMN assigned_by TEXT;` |
| 2025-12-31 | Added `plans` and `plan_goals` tables | See migration file |
| 2025-12-31 | Added `is_active` and `plan_goal_id` to `tasks` | See migration file |
| 2026-01-03 | Added `sprints` and `objectives` tables | See `migration_sprint_system.sql` |
| 2026-01-03 | Added `objective_id` and `original_category` to `tasks` | See `migration_sprint_system.sql` |
| 2026-01-03 | Added `messages` table for team messaging | See `migration_messages.sql` |
| **2026-01-14** | **Added `check_ins`, `work_logs`, `check_in_comments` tables** | See `migration_checkins.sql` |

---

## Running Migrations

```powershell
cd "C:\Users\mrmic\My Drive\Untitled Publishers\BethaneK\productivity-mcp-server"

# Single command
npx wrangler d1 execute productivity-brain --remote --command "YOUR SQL HERE;"

# From file
npx wrangler d1 execute productivity-brain --remote --file=migration_NAME.sql
```

**Note:** SQLite doesn't support multiple ALTER TABLE statements in one command. Run each separately.
