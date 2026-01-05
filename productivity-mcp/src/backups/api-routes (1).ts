// api-routes.ts
// REST API endpoints for the Productivity Dashboard
// Location: src/api-routes.ts

interface Env {
  DB: D1Database;
  USER_ID: string;
  DASHBOARD_API_KEY?: string;
}

// CORS headers for all responses
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// JSON response helper with CORS
function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

// Create API handler
export function createApiRoutes(env: Env) {
  const db = env.DB;
  const userId = env.USER_ID;

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname.replace('/api', '');
      const method = request.method;

      // Handle preflight
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      try {
        // ============================================
        // MORNING BRIEFING
        // ============================================
        if (path === '/morning' && method === 'GET') {
          const now = new Date();
          const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
          const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

          // Get all open tasks
          const allTasks = await db.prepare(`
            SELECT id, text, priority, due_date, category, project
            FROM tasks 
            WHERE user_id = ? AND status = 'open'
            ORDER BY priority DESC, created_at ASC
          `).bind(userId).all();

          // Get overdue tasks
          const overdueTasks = await db.prepare(`
            SELECT id, text, priority, due_date, category
            FROM tasks 
            WHERE user_id = ? AND status = 'open' AND due_date < date('now')
            ORDER BY due_date ASC
          `).bind(userId).all();

          // Get current plan
          let planData = null;
          try {
            const plan = await db.prepare(`
              SELECT * FROM plans 
              WHERE user_id = ? AND status = 'active'
              ORDER BY created_at DESC LIMIT 1
            `).bind(userId).first();

            if (plan) {
              const goals = await db.prepare(`
                SELECT * FROM plan_goals WHERE plan_id = ?
              `).bind(plan.id).all();

              const endDate = new Date(plan.end_date as string);
              const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
              
              let workDays = 0;
              const tempDate = new Date(now);
              while (tempDate <= endDate) {
                const dow = tempDate.getDay();
                if (dow !== 0 && dow !== 6) workDays++;
                tempDate.setDate(tempDate.getDate() + 1);
              }

              planData = {
                id: plan.id,
                title: plan.title,
                startDate: plan.start_date,
                endDate: plan.end_date,
                daysRemaining,
                workDaysRemaining: workDays,
                goals: (goals.results || []).map((g: any) => ({
                  id: g.id,
                  description: g.description,
                  targetCount: g.target_count,
                  completedCount: g.completed_count,
                  unit: g.unit,
                  progress: g.target_count > 0 ? Math.round((g.completed_count / g.target_count) * 100) : 0
                }))
              };
            }
          } catch (e) {
            console.error('Plan fetch error:', e);
          }

          // Get incoming handoffs
          let incoming: any[] = [];
          try {
            const handoffs = await db.prepare(`
              SELECT h.*, t.text as task_text 
              FROM handoff_suggestions h 
              JOIN tasks t ON h.task_id = t.id 
              WHERE h.to_user = ? AND h.status = 'pending'
            `).bind(userId).all();
            incoming = handoffs.results || [];
          } catch (e) {
            console.error('Handoff fetch error:', e);
          }

          // Get launches
          let launches: any[] = [];
          try {
            const launchResults = await db.prepare(`
              SELECT lp.*, 
                (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id AND completed = 1) as done_count,
                (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id) as total_count
              FROM launch_projects lp
              WHERE lp.user_id = ? AND lp.status != 'complete'
              ORDER BY lp.created_at DESC
            `).bind(userId).all();
            
            launches = (launchResults.results || []).map((l: any) => ({
              id: l.id,
              title: l.title,
              phase: l.current_phase,
              completed: l.done_count || 0,
              total: l.total_count || 0,
              progress: l.total_count > 0 ? Math.round((l.done_count / l.total_count) * 100) : 0,
              targetDate: l.target_launch_date
            }));
          } catch (e) {
            console.error('Launch fetch error:', e);
          }

          // Split tasks into high priority and backlog
          const activeTasks = (allTasks.results || []).filter((t: any) => t.priority >= 4).slice(0, 10);
          const backlogTasks = (allTasks.results || []).filter((t: any) => t.priority < 4);

          // Group backlog by category
          const backlogByCategory: Record<string, any[]> = {};
          for (const task of backlogTasks as any[]) {
            const cat = task.category || 'General';
            if (!backlogByCategory[cat]) backlogByCategory[cat] = [];
            backlogByCategory[cat].push(task);
          }

          return jsonResponse({
            greeting: {
              dayOfWeek,
              date: dateStr,
              time: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
            },
            whereYouLeftOff: null,
            activeTasks: activeTasks,
            overdueTasks: overdueTasks.results || [],
            todayTasks: [],
            plan: planData,
            incoming: incoming,
            launches: launches,
            backlogByCategory,
            stats: {
              totalTasks: (allTasks.results?.length || 0),
              activeTasks: activeTasks.length,
              overdue: overdueTasks.results?.length || 0
            }
          });
        }

        // ============================================
        // TASKS
        // ============================================
        if (path === '/tasks' && method === 'GET') {
          const status = url.searchParams.get('status') || 'open';

          let query = `SELECT * FROM tasks WHERE user_id = ?`;
          const params: any[] = [userId];

          if (status !== 'all') {
            query += ` AND status = ?`;
            params.push(status);
          }

          query += ` ORDER BY priority DESC, created_at ASC`;

          const tasks = await db.prepare(query).bind(...params).all();
          return jsonResponse({ tasks: tasks.results || [] });
        }

        // Complete task
        const completeMatch = path.match(/^\/tasks\/([^/]+)\/complete$/);
        if (completeMatch && method === 'POST') {
          const taskId = completeMatch[1];

          await db.prepare(`
            UPDATE tasks SET status = 'done', completed_at = datetime('now')
            WHERE id = ? AND user_id = ?
          `).bind(taskId, userId).run();

          return jsonResponse({ success: true, message: 'Task completed' });
        }

        // Activate task
        const activateMatch = path.match(/^\/tasks\/([^/]+)\/activate$/);
        if (activateMatch && method === 'POST') {
          const taskId = activateMatch[1];

          await db.prepare(`
            UPDATE tasks SET priority = 4
            WHERE id = ? AND user_id = ?
          `).bind(taskId, userId).run();

          return jsonResponse({ success: true, message: 'Task activated' });
        }

        // Create task
        if (path === '/tasks' && method === 'POST') {
          const body = await request.json() as any;
          const { text, category, priority, dueDate } = body;

          const id = crypto.randomUUID();
          await db.prepare(`
            INSERT INTO tasks (id, user_id, text, category, priority, due_date, status, created_at, last_touched)
            VALUES (?, ?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))
          `).bind(id, userId, text, category || 'General', priority || 3, dueDate || null).run();

          return jsonResponse({ success: true, id, message: 'Task created' });
        }

        // ============================================
        // PLAN
        // ============================================
        if (path === '/plan' && method === 'GET') {
          const plan = await db.prepare(`
            SELECT * FROM plans 
            WHERE user_id = ? AND status = 'active'
            ORDER BY created_at DESC LIMIT 1
          `).bind(userId).first();

          if (!plan) {
            return jsonResponse({ plan: null });
          }

          const goals = await db.prepare(`
            SELECT * FROM plan_goals WHERE plan_id = ?
          `).bind(plan.id).all();

          return jsonResponse({
            plan: {
              ...plan,
              goals: goals.results || []
            }
          });
        }

        // Increment goal
        const goalMatch = path.match(/^\/plan\/goals\/([^/]+)\/increment$/);
        if (goalMatch && method === 'POST') {
          const goalId = goalMatch[1];
          const body = await request.json() as any;
          const amount = body.amount || 1;

          await db.prepare(`
            UPDATE plan_goals SET completed_count = completed_count + ?
            WHERE id = ?
          `).bind(amount, goalId).run();

          return jsonResponse({ success: true, message: 'Goal updated' });
        }

        // ============================================
        // LAUNCHES
        // ============================================
        if (path === '/launches' && method === 'GET') {
          const launches = await db.prepare(`
            SELECT lp.*, 
              (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id AND completed = 1) as done_count,
              (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id) as total_count
            FROM launch_projects lp
            WHERE lp.user_id = ? AND lp.status != 'complete'
            ORDER BY lp.created_at DESC
          `).bind(userId).all();

          return jsonResponse({
            launches: (launches.results || []).map((l: any) => ({
              id: l.id,
              title: l.title,
              phase: l.current_phase,
              status: l.status,
              completed: l.done_count || 0,
              total: l.total_count || 0,
              progress: l.total_count > 0 ? Math.round((l.done_count / l.total_count) * 100) : 0,
              targetDate: l.target_launch_date
            }))
          });
        }

        // Launch checklist
        const checklistMatch = path.match(/^\/launches\/([^/]+)\/checklist$/);
        if (checklistMatch && method === 'GET') {
          const projectId = checklistMatch[1];

          const items = await db.prepare(`
            SELECT * FROM launch_checklist 
            WHERE project_id = ? 
            ORDER BY phase, section, sort_order
          `).bind(projectId).all();

          return jsonResponse({ items: items.results || [] });
        }

        // Complete checklist item
        const checklistCompleteMatch = path.match(/^\/launches\/([^/]+)\/checklist\/([^/]+)\/complete$/);
        if (checklistCompleteMatch && method === 'POST') {
          const itemId = checklistCompleteMatch[2];

          await db.prepare(`
            UPDATE launch_checklist SET completed = 1, completed_at = datetime('now')
            WHERE id = ?
          `).bind(itemId).run();

          return jsonResponse({ success: true, message: 'Item completed' });
        }

        // ============================================
        // JOURNAL
        // ============================================
        if (path === '/journal' && method === 'POST') {
          const body = await request.json() as any;
          const { content, mood, energy, entryType } = body;

          const id = crypto.randomUUID();
          await db.prepare(`
            INSERT INTO journal_entries (id, user_id, content, mood, energy, entry_type, created_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
          `).bind(id, userId, content, mood || null, energy || null, entryType || 'freeform').run();

          return jsonResponse({ success: true, id, message: 'Journal entry created' });
        }

        // ============================================
        // IDEAS
        // ============================================
        if (path === '/ideas' && method === 'POST') {
          const body = await request.json() as any;
          const { title, content, category } = body;

          const id = crypto.randomUUID();
          await db.prepare(`
            INSERT INTO incubation (id, user_id, title, content, category, created_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
          `).bind(id, userId, title, content || '', category || 'Unsorted').run();

          return jsonResponse({ success: true, id, message: 'Idea captured' });
        }

        // Not found
        return jsonResponse({ error: 'Not found' }, 404);

      } catch (err: any) {
        console.error('API Error:', err);
        return jsonResponse({ error: err.message || 'Internal error' }, 500);
      }
    }
  };
}
