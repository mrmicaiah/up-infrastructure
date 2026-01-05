// api-routes.ts - REST API endpoints for the Productivity Dashboard

interface Env {
  DB: D1Database;
  USER_ID: string;
  DASHBOARD_API_KEY?: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export function createApiRoutes(env: Env) {
  const db = env.DB;
  const userId = env.USER_ID;

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname.replace('/api', '');
      const method = request.method;

      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      try {
        // MORNING BRIEFING
        if (path === '/morning' && method === 'GET') {
          const now = new Date();
          const today = now.toISOString().split('T')[0];
          const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
          const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

          const allTasks = await db.prepare(`
            SELECT t.id, t.text, t.priority, t.due_date, t.category, t.project, 
                   t.is_active, t.objective_id, t.assigned_by,
                   o.statement as objective_statement
            FROM tasks t
            LEFT JOIN objectives o ON t.objective_id = o.id
            WHERE t.user_id = ? AND t.status = 'open'
            AND (t.snoozed_until IS NULL OR t.snoozed_until <= ?)
            ORDER BY t.priority DESC, t.due_date ASC NULLS LAST, t.created_at ASC
          `).bind(userId, today).all();

          const overdueTasks = await db.prepare(`
            SELECT id, text, priority, due_date, category FROM tasks 
            WHERE user_id = ? AND status = 'open' AND due_date < date('now')
            ORDER BY due_date ASC
          `).bind(userId).all();

          // Get current sprint
          let sprintData = null;
          try {
            const sprint = await db.prepare(`SELECT * FROM sprints WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).bind(userId).first();
            if (sprint) {
              const objectives = await db.prepare(`SELECT * FROM objectives WHERE sprint_id = ? ORDER BY sort_order ASC`).bind(sprint.id).all();
              const endDate = new Date(sprint.end_date as string);
              const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
              
              let workDays = 0;
              const tempDate = new Date(now);
              while (tempDate <= endDate) {
                const dow = tempDate.getDay();
                if (dow !== 0 && dow !== 6) workDays++;
                tempDate.setDate(tempDate.getDate() + 1);
              }

              const objectivesWithProgress = [];
              for (const obj of (objectives.results || []) as any[]) {
                const openCount = await db.prepare("SELECT COUNT(*) as c FROM tasks WHERE objective_id = ? AND status = 'open'").bind(obj.id).first();
                const doneCount = await db.prepare("SELECT COUNT(*) as c FROM tasks WHERE objective_id = ? AND status = 'done'").bind(obj.id).first();
                objectivesWithProgress.push({
                  id: obj.id,
                  statement: obj.statement,
                  openTasks: openCount?.c || 0,
                  doneTasks: doneCount?.c || 0,
                  totalTasks: (openCount?.c || 0) + (doneCount?.c || 0)
                });
              }

              sprintData = {
                id: sprint.id,
                name: sprint.name,
                endDate: sprint.end_date,
                daysRemaining,
                workDaysRemaining: workDays,
                objectives: objectivesWithProgress
              };
            }
          } catch (e) { console.error('Sprint fetch error:', e); }

          // Get incoming tasks (assigned by teammate) - tasks with assigned_by set
          let incomingTasks: any[] = [];
          try {
            const assigned = await db.prepare(`
              SELECT id, text, priority, due_date, category, assigned_by, created_at 
              FROM tasks 
              WHERE user_id = ? AND status = 'open' AND assigned_by IS NOT NULL
              ORDER BY created_at DESC
            `).bind(userId).all();
            incomingTasks = assigned.results || [];
          } catch (e) { console.error('Incoming tasks fetch error:', e); }

          // Get incoming handoffs (legacy - from handoff_suggestions table)
          let incomingHandoffs: any[] = [];
          try {
            const handoffs = await db.prepare(`SELECT h.*, t.text as task_text FROM handoff_suggestions h JOIN tasks t ON h.task_id = t.id WHERE h.to_user = ? AND h.status = 'pending'`).bind(userId).all();
            incomingHandoffs = handoffs.results || [];
          } catch (e) { console.error('Handoff fetch error:', e); }

          // Get unread messages count
          let unreadMessages = 0;
          try {
            const msgCount = await db.prepare(`SELECT COUNT(*) as count FROM messages WHERE to_user = ? AND read_at IS NULL`).bind(userId).first();
            unreadMessages = msgCount?.count || 0;
          } catch (e) { console.error('Message count error:', e); }

          // Get launches
          let launches: any[] = [];
          try {
            const launchResults = await db.prepare(`
              SELECT lp.*, 
                (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id AND completed = 1) as done_count,
                (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id) as total_count
              FROM launch_projects lp WHERE lp.user_id = ? AND lp.status != 'complete' ORDER BY lp.created_at DESC
            `).bind(userId).all();
            
            launches = (launchResults.results || []).map((l: any) => ({
              id: l.id, title: l.title, phase: l.current_phase,
              completed: l.done_count || 0, total: l.total_count || 0,
              progress: l.total_count > 0 ? Math.round((l.done_count / l.total_count) * 100) : 0,
              targetDate: l.target_launch_date
            }));
          } catch (e) { console.error('Launch fetch error:', e); }

          // Task categorization
          const activeTasks: any[] = [];
          const sprintTasks: any[] = [];
          const backlog: any[] = [];

          for (const t of (allTasks.results || []) as any[]) {
            if (t.is_active) { activeTasks.push(t); continue; }
            if (t.objective_id) { sprintTasks.push(t); continue; }
            if (t.assigned_by) { continue; } // Skip incoming tasks from backlog
            backlog.push(t);
          }

          const backlogByCategory: Record<string, any[]> = {};
          for (const task of backlog) {
            const cat = task.category || task.project || 'General';
            if (!backlogByCategory[cat]) backlogByCategory[cat] = [];
            backlogByCategory[cat].push(task);
          }

          return jsonResponse({
            greeting: { dayOfWeek, date: dateStr, time: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) },
            whereYouLeftOff: null,
            activeTasks,
            sprintTasks,
            overdueTasks: overdueTasks.results || [],
            todayTasks: [],
            sprint: sprintData,
            incoming: incomingTasks,        // Tasks assigned via add_task --for_user
            incomingHandoffs,               // Legacy handoff_suggestions
            incomingCount: incomingTasks.length + incomingHandoffs.length,
            unreadMessages,
            launches,
            backlogByCategory,
            stats: {
              totalTasks: (allTasks.results?.length || 0),
              activeTasks: activeTasks.length,
              sprintTasks: sprintTasks.length,
              overdue: overdueTasks.results?.length || 0
            }
          });
        }

        // MESSAGES - Get unread
        if (path === '/messages' && method === 'GET') {
          // Clean up expired messages
          await db.prepare("DELETE FROM messages WHERE expires_at < datetime('now')").run();
          
          const messages = await db.prepare(`
            SELECT * FROM messages 
            WHERE to_user = ? AND read_at IS NULL 
            ORDER BY created_at DESC
          `).bind(userId).all();
          
          return jsonResponse({ 
            messages: messages.results || [],
            count: messages.results?.length || 0
          });
        }

        // MESSAGES - Mark as read
        if (path === '/messages/read' && method === 'POST') {
          await db.prepare(`
            UPDATE messages SET read_at = datetime('now') 
            WHERE to_user = ? AND read_at IS NULL
          `).bind(userId).run();
          
          return jsonResponse({ success: true, message: 'Messages marked as read' });
        }

        // TASKS LIST
        if (path === '/tasks' && method === 'GET') {
          const status = url.searchParams.get('status') || 'open';
          let query = `SELECT * FROM tasks WHERE user_id = ?`;
          const params: any[] = [userId];
          if (status !== 'all') { query += ` AND status = ?`; params.push(status); }
          query += ` ORDER BY priority DESC, created_at ASC`;
          const tasks = await db.prepare(query).bind(...params).all();
          return jsonResponse({ tasks: tasks.results || [] });
        }

        // CREATE TASK
        if (path === '/tasks' && method === 'POST') {
          const body = await request.json() as any;
          const { text, category, priority, dueDate } = body;
          const id = crypto.randomUUID();
          await db.prepare(`INSERT INTO tasks (id, user_id, text, category, priority, due_date, status, created_at, last_touched) VALUES (?, ?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))`).bind(id, userId, text, category || 'General', priority || 3, dueDate || null).run();
          return jsonResponse({ success: true, id, message: 'Task created' });
        }

        // COMPLETE TASK
        const completeMatch = path.match(/^\/tasks\/([^/]+)\/complete$/);
        if (completeMatch && method === 'POST') {
          const taskId = completeMatch[1];
          const task = await db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').bind(taskId, userId).first();
          if (!task) return jsonResponse({ error: 'Task not found' }, 404);
          const completedAt = new Date().toISOString();
          await db.prepare(`UPDATE tasks SET status = 'done', completed_at = ?, is_active = 0 WHERE id = ? AND user_id = ?`).bind(completedAt, taskId, userId).run();
          return jsonResponse({ success: true, message: 'Task completed' });
        }

        // ACTIVATE TASK
        const activateMatch = path.match(/^\/tasks\/([^/]+)\/activate$/);
        if (activateMatch && method === 'POST') {
          const taskId = activateMatch[1];
          await db.prepare(`UPDATE tasks SET is_active = 1, last_touched = datetime('now') WHERE id = ? AND user_id = ?`).bind(taskId, userId).run();
          return jsonResponse({ success: true, message: 'Task activated' });
        }

        // DEACTIVATE TASK
        const deactivateMatch = path.match(/^\/tasks\/([^/]+)\/deactivate$/);
        if (deactivateMatch && method === 'POST') {
          const taskId = deactivateMatch[1];
          await db.prepare(`UPDATE tasks SET is_active = 0, last_touched = datetime('now') WHERE id = ? AND user_id = ?`).bind(taskId, userId).run();
          return jsonResponse({ success: true, message: 'Task deactivated' });
        }

        // CLAIM TASK - Accept an incoming task (clears assigned_by)
        const claimMatch = path.match(/^\/tasks\/([^/]+)\/claim$/);
        if (claimMatch && method === 'POST') {
          const taskId = claimMatch[1];
          await db.prepare(`UPDATE tasks SET assigned_by = NULL, last_touched = datetime('now') WHERE id = ? AND user_id = ?`).bind(taskId, userId).run();
          return jsonResponse({ success: true, message: 'Task claimed' });
        }

        // SPRINT
        if (path === '/sprint' && method === 'GET') {
          const sprint = await db.prepare(`SELECT * FROM sprints WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).bind(userId).first();
          if (!sprint) return jsonResponse({ sprint: null });
          const objectives = await db.prepare(`SELECT * FROM objectives WHERE sprint_id = ? ORDER BY sort_order ASC`).bind(sprint.id).all();
          return jsonResponse({ sprint: { ...sprint, objectives: objectives.results || [] } });
        }

        // LAUNCHES
        if (path === '/launches' && method === 'GET') {
          const launches = await db.prepare(`
            SELECT lp.*, 
              (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id AND completed = 1) as done_count,
              (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id) as total_count
            FROM launch_projects lp WHERE lp.user_id = ? AND lp.status != 'complete' ORDER BY lp.created_at DESC
          `).bind(userId).all();

          return jsonResponse({
            launches: (launches.results || []).map((l: any) => ({
              id: l.id, title: l.title, phase: l.current_phase, status: l.status,
              completed: l.done_count || 0, total: l.total_count || 0,
              progress: l.total_count > 0 ? Math.round((l.done_count / l.total_count) * 100) : 0,
              targetDate: l.target_launch_date
            }))
          });
        }

        // LAUNCH CHECKLIST
        const checklistMatch = path.match(/^\/launches\/([^/]+)\/checklist$/);
        if (checklistMatch && method === 'GET') {
          const projectId = checklistMatch[1];
          const items = await db.prepare(`SELECT * FROM launch_checklist WHERE project_id = ? ORDER BY phase, section, sort_order`).bind(projectId).all();
          return jsonResponse({ items: items.results || [] });
        }

        // COMPLETE CHECKLIST ITEM
        const checklistCompleteMatch = path.match(/^\/launches\/([^/]+)\/checklist\/([^/]+)\/complete$/);
        if (checklistCompleteMatch && method === 'POST') {
          const itemId = checklistCompleteMatch[2];
          await db.prepare(`UPDATE launch_checklist SET completed = 1, completed_at = datetime('now') WHERE id = ?`).bind(itemId).run();
          return jsonResponse({ success: true, message: 'Item completed' });
        }

        // JOURNAL
        if (path === '/journal' && method === 'POST') {
          const body = await request.json() as any;
          const { content, mood, energy, entryType } = body;
          const id = crypto.randomUUID();
          await db.prepare(`INSERT INTO journal_entries (id, user_id, content, mood, energy, entry_type, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).bind(id, userId, content, mood || null, energy || null, entryType || 'freeform').run();
          return jsonResponse({ success: true, id, message: 'Journal entry created' });
        }

        // IDEAS
        if (path === '/ideas' && method === 'POST') {
          const body = await request.json() as any;
          const { title, content, category } = body;
          const id = crypto.randomUUID();
          await db.prepare(`INSERT INTO incubation (id, user_id, title, content, category, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`).bind(id, userId, title, content || '', category || 'Unsorted').run();
          return jsonResponse({ success: true, id, message: 'Idea captured' });
        }

        return jsonResponse({ error: 'Not found' }, 404);

      } catch (err: any) {
        console.error('API Error:', err);
        return jsonResponse({ error: err.message || 'Internal error' }, 500);
      }
    }
  };
}
