# /src/tools - Tool Registration

> Quick reference for all MCP tools. Check dependencies before making changes.

## Tool Files

| File | Purpose | Tables Used | Depends On |
|------|---------|-------------|------------|
| `tasks.ts` | Task CRUD, recurring tasks, stats, patterns | `tasks`, `task_events`, `daily_logs`, `progress_logs`, `user_patterns`, `launch_checklist` | `helpers/utils`, `helpers/intelligence` |
| `team.ts` | Team collaboration, handoffs | `tasks`, `handoff_suggestions` | - |
| `launch.ts` | Launch docs, projects, checklists, metrics | `launch_docs`, `launch_projects`, `launch_checklist`, `launch_metrics`, `launch_checkins`, `content_batches`, `posting_log`, `tasks` | `helpers/launch-parser`, `helpers/utils` |
| `bethany.ts` | Work sessions, good_morning/good_night, checkpoints | `work_sessions`, `checkpoints`, `tasks`, `user_patterns`, `launch_projects`, `launch_checklist`, `handoff_suggestions` | - |
| `journal.ts` | Journaling, mood tracking, entity extraction | `journal_entries`, `journal_entities`, `journal_patterns` | `helpers/intelligence` (for pattern analysis) |
| `notes.ts` | Notes and ideas storage | `notes`, `ideas` | - |
| `connections.ts` | Service connect/disconnect, status | `oauth_tokens` | `oauth/index.ts` |
| `drive.ts` | Google Drive operations | - (uses Google API) | `oauth/index.ts` |
| `email.ts` | Gmail operations | - (uses Google API) | `oauth/index.ts` |
| `contacts.ts` | Google Contacts operations | - (uses Google API) | `oauth/index.ts` |
| `blogger.ts` | Blogger operations | - (uses Google API) | `oauth/index.ts` |
| `github.ts` | GitHub operations | - (uses GitHub API) | `oauth/index.ts` |

---

## Tool Registration Pattern

All tools follow this pattern:

```typescript
import { z } from "zod";
import type { ToolContext } from '../types';

export function registerXXXTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool("tool_name", {
    param: z.string(),
  }, async ({ param }) => {
    const userId = getCurrentUser(); // Always use this, never hardcode
    
    // Database operations use env.DB
    const result = await env.DB.prepare("SELECT * FROM table WHERE user_id = ?")
      .bind(userId)
      .all();
    
    return { content: [{ type: "text", text: "Result" }] };
  });
}
```

---

## Key Patterns

### User Isolation
Always filter by `user_id`:
```typescript
const userId = getCurrentUser();
// ✅ Correct
await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ?").bind(userId)
// ❌ Wrong - exposes other users' data
await env.DB.prepare("SELECT * FROM tasks")
```

### Graceful Fallback for Optional Tables
Wrap queries for tables that might not exist yet:
```typescript
let patterns: any[] = [];
try {
  const result = await env.DB.prepare(
    'SELECT * FROM user_patterns WHERE user_id = ?'
  ).bind(userId).all();
  patterns = result.results;
} catch {
  // Table might not exist yet - that's fine
}
```

### Returning Results
Always return content array:
```typescript
return { content: [{ type: "text", text: output }] };
```

---

## High-Risk Dependencies

These files affect multiple tools. **Test broadly after changes:**

| If you change... | Also test... |
|------------------|--------------|
| `oauth/index.ts` | ALL service connections (Drive, Gmail, GitHub, etc.) |
| `helpers/intelligence.ts` | `tasks.ts`, `bethany.ts`, `journal.ts` |
| `helpers/utils.ts` | `tasks.ts`, `launch.ts`, `bethany.ts` |
| `helpers/launch-parser.ts` | `launch.ts` (add_launch_doc, create_launch) |
| `types.ts` | Everything |

---

## Adding a New Tool

1. Create file or add to existing category file
2. Follow the registration pattern above
3. Import and register in `index.ts`:
   ```typescript
   import { registerNewTools } from './newfile';
   // In registerAllTools():
   registerNewTools(ctx);
   ```
4. If adding new tables, update `SCHEMA.md` FIRST
5. Deploy both workers: `npm run deploy && npx wrangler deploy --config wrangler-irene.jsonc`
6. Update this README with the new file

---

## Tool Count by Category

| Category | Count | Tools |
|----------|-------|-------|
| Tasks | 14 | list_tasks, add_task, complete_task, update_task, delete_task, snooze_task, break_down_task, log_progress, get_daily_summary, weekly_recap, plan_week, get_stats, get_challenges, analyze_patterns, get_insights, end_of_day_recap |
| Team | 5 | team_summary, view_teammate_tasks, suggest_handoff, check_handoffs, accept_handoff, who_am_i |
| Launch | 18 | add_launch_doc, list_launch_docs, view_launch_doc, update_launch_doc, create_launch, launch_status, launch_overview, launch_health, advance_launch_phase, complete_launch, reset_launch, list_checklist, add_checklist_item, complete_checklist_item, hand_off_checklist_item, reclaim_checklist_item, surface_launch_tasks, log_launch_metrics, launch_metrics_history, log_content_batch, log_post, posting_streak, launch_checkin, checkin_history |
| Bethany | 4 | good_morning, good_night, checkpoint, work_history |
| Journal | 8 | add_journal_entry, list_journal_entries, view_journal_entry, update_journal_entry, delete_journal_entry, search_journal, journal_insights, journal_streak, link_journal_entry, configure_journal |
| Notes | 4 | add_note, add_idea, list_ideas |
| Connections | 3 | connect_service, disconnect_service, connection_status |
| Drive | 6 | drive_status, search_drive, read_from_drive, save_to_drive, update_drive_file, list_drive_folders, get_folder_id |
| Email | 5 | check_inbox, read_email, search_email, send_email, email_to_task |
| Contacts | 1 | search_contacts |
| Blogger | 7 | list_blogs, list_blog_posts, get_blog_post, create_blog_post, update_blog_post, delete_blog_post, publish_blog_post, get_blog_stats |
| GitHub | 6 | github_status, github_list_repos, github_list_files, github_get_file, github_push_file, github_push_files, github_enable_pages |
