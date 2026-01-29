// api-routes.ts - REST API endpoints for the Productivity Dashboard

interface Env {
  DB: D1Database;
  USER_ID: string;
  TEAM?: string;
  DASHBOARD_API_KEY?: string;
  BETHANY_API_KEY?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-GitHub-Event, X-Hub-Signature-256, X-User-Id',
};

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API_URL = 'https://gmail.googleapis.com/gmail/v1';
const ANALYTICS_DATA_API = 'https://analyticsdata.googleapis.com/v1beta';

// Helper to get valid OAuth token
async function getValidToken(db: D1Database, userId: string, provider: string, env: Env): Promise<string | null> {
  const token = await db.prepare(
    'SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?'
  ).bind(userId, provider).first() as any;
  
  if (!token) return null;
  
  if (token.expires_at && new Date(token.expires_at) < new Date()) {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    
    if (!response.ok) return null;
    
    const data: any = await response.json();
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
    
    await db.prepare(
      'UPDATE oauth_tokens SET access_token = ?, expires_at = ? WHERE user_id = ? AND provider = ?'
    ).bind(data.access_token, expiresAt, userId, provider).run();
    
    return data.access_token;
  }
  
  return token.access_token;
}

export function createApiRoutes(env: Env) {
  const db = env.DB;
  const userId = env.USER_ID;

  // Helper to check Bethany API key
  function checkBethanyAuth(request: Request): boolean {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7);
    return token === env.BETHANY_API_KEY;
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname.replace('/api', '');
      const method = request.method;

      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      try {

        // ==================== TASK STATS (NEW) ====================
        
        // GET /api/tasks/stats - Dashboard statistics
        if (path === '/tasks/stats' && method === 'GET') {
          const today = new Date().toISOString().split('T')[0];
          const startOfWeek = new Date();
          startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
          const weekStart = startOfWeek.toISOString().split('T')[0];
          
          const openResult = await db.prepare(
            `SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = 'open'`
          ).bind(userId).first() as any;
          
          const activeResult = await db.prepare(
            `SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = 'open' AND (is_active = 1 OR objective_id IS NOT NULL)`
          ).bind(userId).first() as any;
          
          const doneTodayResult = await db.prepare(
            `SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = 'done' AND date(completed_at) = ?`
          ).bind(userId, today).first() as any;
          
          const doneWeekResult = await db.prepare(
            `SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = 'done' AND date(completed_at) >= ?`
          ).bind(userId, weekStart).first() as any;
          
          const overdueResult = await db.prepare(
            `SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = 'open' AND due_date < date('now')`
          ).bind(userId).first() as any;
          
          return jsonResponse({
            open_count: openResult?.count || 0,
            active_count: activeResult?.count || 0,
            done_today: doneTodayResult?.count || 0,
            done_this_week: doneWeekResult?.count || 0,
            overdue_count: overdueResult?.count || 0
          });
        }

        // ==================== SPRINTS/CURRENT (NEW) ====================
        
        // GET /api/sprints/current - Current sprint with objectives and task counts
        if (path === '/sprints/current' && method === 'GET') {
          const sprint = await db.prepare(`
            SELECT * FROM sprints WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1
          `).bind(userId).first() as any;
          
          if (!sprint) {
            return jsonResponse({ sprint: null });
          }
          
          const objectives = await db.prepare(`
            SELECT * FROM objectives WHERE sprint_id = ? ORDER BY sort_order ASC
          `).bind(sprint.id).all();
          
          const objectivesWithCounts = [];
          for (const obj of (objectives.results || []) as any[]) {
            const openCount = await db.prepare(
              "SELECT COUNT(*) as c FROM tasks WHERE objective_id = ? AND user_id = ? AND status = 'open'"
            ).bind(obj.id, userId).first() as any;
            
            const doneCount = await db.prepare(
              "SELECT COUNT(*) as c FROM tasks WHERE objective_id = ? AND user_id = ? AND status = 'done'"
            ).bind(obj.id, userId).first() as any;
            
            objectivesWithCounts.push({
              id: obj.id,
              statement: obj.statement,
              sort_order: obj.sort_order,
              open_tasks: openCount?.c || 0,
              done_tasks: doneCount?.c || 0,
              total_tasks: (openCount?.c || 0) + (doneCount?.c || 0)
            });
          }
          
          const now = new Date();
          const endDate = new Date(sprint.end_date);
          const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          
          let workDays = 0;
          const tempDate = new Date(now);
          while (tempDate <= endDate) {
            const dow = tempDate.getDay();
            if (dow !== 0 && dow !== 6) workDays++;
            tempDate.setDate(tempDate.getDate() + 1);
          }
          
          const totalOpen = objectivesWithCounts.reduce((sum, o) => sum + o.open_tasks, 0);
          const totalDone = objectivesWithCounts.reduce((sum, o) => sum + o.done_tasks, 0);
          const totalTasks = totalOpen + totalDone;
          const progress = totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0;
          
          return jsonResponse({
            sprint: {
              ...sprint,
              days_remaining: daysRemaining,
              work_days_remaining: workDays,
              progress,
              total_tasks: totalTasks,
              done_tasks: totalDone,
              objectives: objectivesWithCounts
            }
          });
        }

        // ==================== ROUTINES/TODAY (NEW) ====================
        
        // GET /api/routines/today - Today's recurring tasks
        if (path === '/routines/today' && method === 'GET') {
          const today = new Date();
          const dayOfWeek = today.getDay();
          const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
          const todayName = dayNames[dayOfWeek];
          const isWeekday = dayOfWeek !== 0 && dayOfWeek !== 6;
          const todayStr = today.toISOString().split('T')[0];
          
          const routines = await db.prepare(`
            SELECT * FROM tasks 
            WHERE user_id = ? AND status = 'open' AND recurrence IS NOT NULL
            AND (snoozed_until IS NULL OR snoozed_until <= date('now'))
            ORDER BY priority DESC, text ASC
          `).bind(userId).all();
          
          const todayRoutines = (routines.results || []).filter((task: any) => {
            const rec = task.recurrence?.toLowerCase() || '';
            if (rec === 'daily') return true;
            if (rec === 'weekdays' && isWeekday) return true;
            if (rec === 'weekly' || rec === 'biweekly' || rec === 'monthly' || rec === 'yearly') {
              if (!task.due_date) return true;
              return task.due_date === todayStr;
            }
            if (rec.includes(',') || dayNames.some(d => rec === d)) {
              const days = rec.split(',').map((d: string) => d.trim().toLowerCase());
              return days.includes(todayName);
            }
            return false;
          });
          
          return jsonResponse({ routines: todayRoutines });
        }

        // ==================== UPCOMING (NEW) ====================
        
        // GET /api/upcoming - Tasks due in next N days
        if (path === '/upcoming' && method === 'GET') {
          const days = parseInt(url.searchParams.get('days') || '7');
          const futureDate = new Date();
          futureDate.setDate(futureDate.getDate() + days);
          const futureDateStr = futureDate.toISOString().split('T')[0];
          
          const upcoming = await db.prepare(`
            SELECT t.*, o.statement as objective_statement
            FROM tasks t
            LEFT JOIN objectives o ON t.objective_id = o.id
            WHERE t.user_id = ? 
              AND t.status = 'open' 
              AND t.due_date IS NOT NULL 
              AND t.due_date <= ?
              AND t.due_date >= date('now')
              AND (t.snoozed_until IS NULL OR t.snoozed_until <= date('now'))
            ORDER BY t.due_date ASC, t.priority DESC
          `).bind(userId, futureDateStr).all();
          
          return jsonResponse({ tasks: upcoming.results || [] });
        }

        // ==================== ENHANCED TASKS LIST ====================
        
        // GET /api/tasks - Task list with enhanced filters
        if (path === '/tasks' && method === 'GET') {
          const status = url.searchParams.get('status') || 'open';
          const category = url.searchParams.get('category');
          const activeOnly = url.searchParams.get('active_only') === 'true';
          const includeSnoozed = url.searchParams.get('include_snoozed') === 'true';
          
          let query = `
            SELECT t.*, o.statement as objective_statement 
            FROM tasks t 
            LEFT JOIN objectives o ON t.objective_id = o.id 
            WHERE t.user_id = ?
          `;
          const params: any[] = [userId];
          
          if (status !== 'all') {
            query += ` AND t.status = ?`;
            params.push(status);
          }
          
          if (category) {
            query += ` AND t.category = ?`;
            params.push(category);
          }
          
          if (activeOnly) {
            query += ` AND (t.is_active = 1 OR t.objective_id IS NOT NULL)`;
          }
          
          if (!includeSnoozed) {
            query += ` AND (t.snoozed_until IS NULL OR t.snoozed_until <= date('now'))`;
          }
          
          query += ` ORDER BY t.priority DESC, t.due_date ASC NULLS LAST, t.created_at ASC`;
          
          const tasks = await db.prepare(query).bind(...params).all();
          return jsonResponse({ tasks: tasks.results || [] });
        }

        // ==================== ENHANCED COMPLETE TASK ====================
        
        // POST /api/tasks/:id/complete - Complete with recurring logic
        const completeMatch = path.match(/^\/tasks\/([^/]+)\/complete$/);
        if (completeMatch && method === 'POST') {
          const taskId = completeMatch[1];
          const task = await db.prepare(
            'SELECT * FROM tasks WHERE id = ? AND user_id = ?'
          ).bind(taskId, userId).first() as any;
          
          if (!task) return jsonResponse({ error: 'Task not found' }, 404);
          
          const completedAt = new Date().toISOString();
          
          // Handle recurring tasks
          if (task.recurrence) {
            let nextDate = new Date();
            const recurrence = task.recurrence.toLowerCase();
            
            if (recurrence === 'daily') {
              nextDate.setDate(nextDate.getDate() + 1);
            } else if (recurrence === 'weekdays') {
              do {
                nextDate.setDate(nextDate.getDate() + 1);
              } while (nextDate.getDay() === 0 || nextDate.getDay() === 6);
            } else if (recurrence === 'weekly') {
              nextDate.setDate(nextDate.getDate() + 7);
            } else if (recurrence === 'biweekly') {
              nextDate.setDate(nextDate.getDate() + 14);
            } else if (recurrence === 'monthly') {
              nextDate.setMonth(nextDate.getMonth() + 1);
            } else if (recurrence === 'yearly') {
              nextDate.setFullYear(nextDate.getFullYear() + 1);
            } else if (recurrence.includes(',')) {
              const days = recurrence.split(',').map((d: string) => d.trim().toLowerCase());
              const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
              const targetDays = days.map((d: string) => dayMap[d]).filter((d: number) => d !== undefined);
              
              if (targetDays.length > 0) {
                do {
                  nextDate.setDate(nextDate.getDate() + 1);
                } while (!targetDays.includes(nextDate.getDay()));
              }
            }
            
            await db.prepare(`
              UPDATE tasks SET due_date = ?, last_touched = ? WHERE id = ? AND user_id = ?
            `).bind(nextDate.toISOString().split('T')[0], completedAt, taskId, userId).run();
            
            try {
              await db.prepare(`
                INSERT INTO task_events (id, user_id, task_id, event_type, event_data, created_at)
                VALUES (?, ?, ?, 'recurring_completed', ?, ?)
              `).bind(crypto.randomUUID(), userId, taskId, JSON.stringify({ next_date: nextDate.toISOString().split('T')[0] }), completedAt).run();
            } catch (e) { /* ignore */ }
            
            return jsonResponse({ 
              success: true, 
              recurring: true,
              next_date: nextDate.toISOString().split('T')[0],
              message: 'Recurring task reset to next occurrence' 
            });
          }
          
          await db.prepare(`
            UPDATE tasks SET status = 'done', completed_at = ?, is_active = 0 WHERE id = ? AND user_id = ?
          `).bind(completedAt, taskId, userId).run();
          
          return jsonResponse({ success: true, recurring: false, message: 'Task completed' });
        }

        // ==================== CREATE TASK ====================
        
        if (path === '/tasks' && method === 'POST') {
          const body = await request.json() as any;
          const { text, category, priority, due_date, dueDate, project, notes, is_active } = body;
          
          if (!text?.trim()) {
            return jsonResponse({ error: 'text is required' }, 400);
          }
          
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          
          await db.prepare(`
            INSERT INTO tasks (id, user_id, text, category, priority, due_date, project, notes, is_active, status, created_at, last_touched) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
          `).bind(
            id, userId, text.trim(), 
            category || 'General', 
            priority || 3, 
            due_date || dueDate || null,
            project || null,
            notes || null,
            is_active ? 1 : 0,
            now, now
          ).run();
          
          return jsonResponse({ success: true, id, message: 'Task created' });
        }

        // ==================== TASK ACTIONS ====================
        
        // PUT /api/tasks/:id
        const updateTaskMatch = path.match(/^\/tasks\/([^/]+)$/);
        if (updateTaskMatch && method === 'PUT') {
          const taskId = updateTaskMatch[1];
          const body = await request.json() as any;
          const { text, category, priority, due_date, project, notes, is_active } = body;
          
          const updates: string[] = [];
          const params: any[] = [];
          
          if (text !== undefined) { updates.push('text = ?'); params.push(text); }
          if (category !== undefined) { updates.push('category = ?'); params.push(category); }
          if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
          if (due_date !== undefined) { updates.push('due_date = ?'); params.push(due_date); }
          if (project !== undefined) { updates.push('project = ?'); params.push(project); }
          if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
          if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
          
          if (updates.length === 0) {
            return jsonResponse({ error: 'No fields to update' }, 400);
          }
          
          updates.push("last_touched = datetime('now')");
          params.push(taskId, userId);
          
          await db.prepare(`
            UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND user_id = ?
          `).bind(...params).run();
          
          return jsonResponse({ success: true, message: 'Task updated' });
        }

        // DELETE /api/tasks/:id
        const deleteTaskMatch = path.match(/^\/tasks\/([^/]+)$/);
        if (deleteTaskMatch && method === 'DELETE') {
          const taskId = deleteTaskMatch[1];
          await db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').bind(taskId, userId).run();
          return jsonResponse({ success: true, message: 'Task deleted' });
        }

        // POST /api/tasks/:id/activate
        const activateMatch = path.match(/^\/tasks\/([^/]+)\/activate$/);
        if (activateMatch && method === 'POST') {
          const taskId = activateMatch[1];
          await db.prepare(`UPDATE tasks SET is_active = 1, last_touched = datetime('now') WHERE id = ? AND user_id = ?`).bind(taskId, userId).run();
          return jsonResponse({ success: true, message: 'Task activated' });
        }

        // POST /api/tasks/:id/deactivate
        const deactivateMatch = path.match(/^\/tasks\/([^/]+)\/deactivate$/);
        if (deactivateMatch && method === 'POST') {
          const taskId = deactivateMatch[1];
          await db.prepare(`UPDATE tasks SET is_active = 0, last_touched = datetime('now') WHERE id = ? AND user_id = ?`).bind(taskId, userId).run();
          return jsonResponse({ success: true, message: 'Task deactivated' });
        }

        // POST /api/tasks/:id/restore
        const restoreMatch = path.match(/^\/tasks\/([^/]+)\/restore$/);
        if (restoreMatch && method === 'POST') {
          const taskId = restoreMatch[1];
          await db.prepare(`UPDATE tasks SET status = 'open', completed_at = NULL, last_touched = datetime('now') WHERE id = ? AND user_id = ?`).bind(taskId, userId).run();
          return jsonResponse({ success: true, message: 'Task restored' });
        }

        // POST /api/tasks/:id/claim
        const claimMatch = path.match(/^\/tasks\/([^/]+)\/claim$/);
        if (claimMatch && method === 'POST') {
          const taskId = claimMatch[1];
          await db.prepare(`UPDATE tasks SET assigned_by = NULL, last_touched = datetime('now') WHERE id = ? AND user_id = ?`).bind(taskId, userId).run();
          return jsonResponse({ success: true, message: 'Task claimed' });
        }

        // ==================== SPRINT ENDPOINTS ====================
        
        // GET /api/sprint (legacy)
        if (path === '/sprint' && method === 'GET') {
          const sprint = await db.prepare(`SELECT * FROM sprints WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).bind(userId).first();
          if (!sprint) return jsonResponse({ sprint: null });
          const objectives = await db.prepare(`SELECT * FROM objectives WHERE sprint_id = ? ORDER BY sort_order ASC`).bind(sprint.id).all();
          return jsonResponse({ sprint: { ...sprint, objectives: objectives.results || [] } });
        }

        // GET /api/sprints
        if (path === '/sprints' && method === 'GET') {
          const status = url.searchParams.get('status');
          let query = 'SELECT * FROM sprints WHERE user_id = ?';
          const params: any[] = [userId];
          
          if (status && status !== 'all') {
            query += ' AND status = ?';
            params.push(status);
          }
          
          query += ' ORDER BY created_at DESC';
          
          const sprints = await db.prepare(query).bind(...params).all();
          return jsonResponse({ sprints: sprints.results || [] });
        }

        // POST /api/sprints
        if (path === '/sprints' && method === 'POST') {
          const body = await request.json() as any;
          const { name, end_date } = body;
          
          if (!name || !end_date) {
            return jsonResponse({ error: 'name and end_date required' }, 400);
          }
          
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          
          await db.prepare(`
            INSERT INTO sprints (id, user_id, name, end_date, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?)
          `).bind(id, userId, name, end_date, now, now).run();
          
          return jsonResponse({ success: true, id, message: 'Sprint created' });
        }

        // POST /api/sprints/:id/objectives
        const addObjectiveMatch = path.match(/^\/sprints\/([^/]+)\/objectives$/);
        if (addObjectiveMatch && method === 'POST') {
          const sprintId = addObjectiveMatch[1];
          const body = await request.json() as any;
          const { statement } = body;
          
          if (!statement?.trim()) {
            return jsonResponse({ error: 'statement required' }, 400);
          }
          
          const maxOrder = await db.prepare(
            'SELECT MAX(sort_order) as max_order FROM objectives WHERE sprint_id = ?'
          ).bind(sprintId).first() as any;
          
          const id = crypto.randomUUID();
          const sortOrder = (maxOrder?.max_order || 0) + 1;
          
          await db.prepare(`
            INSERT INTO objectives (id, sprint_id, user_id, statement, sort_order, created_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
          `).bind(id, sprintId, userId, statement.trim(), sortOrder).run();
          
          return jsonResponse({ success: true, id, message: 'Objective added' });
        }

        // POST /api/sprints/:id/tasks
        const addSprintTaskMatch = path.match(/^\/sprints\/([^/]+)\/tasks$/);
        if (addSprintTaskMatch && method === 'POST') {
          const body = await request.json() as any;
          const { taskId, objectiveId } = body;
          
          if (!taskId || !objectiveId) {
            return jsonResponse({ error: 'taskId and objectiveId required' }, 400);
          }
          
          const task = await db.prepare(
            'SELECT category FROM tasks WHERE id = ? AND user_id = ?'
          ).bind(taskId, userId).first() as any;
          
          await db.prepare(`
            UPDATE tasks SET objective_id = ?, original_category = ?, last_touched = datetime('now')
            WHERE id = ? AND user_id = ?
          `).bind(objectiveId, task?.category || null, taskId, userId).run();
          
          return jsonResponse({ success: true, message: 'Task added to sprint' });
        }

        // DELETE /api/sprints/:id/tasks/:taskId
        const removeSprintTaskMatch = path.match(/^\/sprints\/([^/]+)\/tasks\/([^/]+)$/);
        if (removeSprintTaskMatch && method === 'DELETE') {
          const taskId = removeSprintTaskMatch[2];
          
          const task = await db.prepare(
            'SELECT original_category FROM tasks WHERE id = ? AND user_id = ?'
          ).bind(taskId, userId).first() as any;
          
          await db.prepare(`
            UPDATE tasks SET objective_id = NULL, category = COALESCE(?, category), original_category = NULL, last_touched = datetime('now')
            WHERE id = ? AND user_id = ?
          `).bind(task?.original_category, taskId, userId).run();
          
          return jsonResponse({ success: true, message: 'Task removed from sprint' });
        }

        // POST /api/sprints/:id/end
        const endSprintMatch = path.match(/^\/sprints\/([^/]+)\/end$/);
        if (endSprintMatch && method === 'POST') {
          const sprintId = endSprintMatch[1];
          const body = await request.json() as any;
          const status = body.status || 'completed';
          
          await db.prepare(`
            UPDATE sprints SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?
          `).bind(status, sprintId, userId).run();
          
          return jsonResponse({ success: true, message: `Sprint ${status}` });
        }

        // ==================== ANALYTICS API ====================
        
        if (path === '/analytics/properties' && method === 'GET') {
          const token = await getValidToken(db, userId, 'google_analytics', env);
          if (!token) {
            return jsonResponse({ connected: false, properties: [] });
          }
          
          const properties = await db.prepare(
            'SELECT * FROM analytics_properties WHERE user_id = ? ORDER BY name'
          ).bind(userId).all();
          
          return jsonResponse({ 
            connected: true, 
            properties: properties.results || [] 
          });
        }

        if (path === '/analytics/report' && method === 'GET') {
          const propertyId = url.searchParams.get('property_id');
          const days = parseInt(url.searchParams.get('days') || '7');
          
          if (!propertyId) return jsonResponse({ error: 'property_id required' }, 400);
          
          const token = await getValidToken(db, userId, 'google_analytics', env);
          if (!token) return jsonResponse({ error: 'Not connected' }, 401);
          
          const response = await fetch(`${ANALYTICS_DATA_API}/properties/${propertyId}:runReport`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
              dimensions: [{ name: 'date' }],
              metrics: [
                { name: 'screenPageViews' },
                { name: 'sessions' },
                { name: 'activeUsers' },
                { name: 'bounceRate' },
                { name: 'averageSessionDuration' }
              ],
              orderBys: [{ dimension: { orderType: 'ALPHANUMERIC', dimensionName: 'date' } }]
            })
          });
          
          if (!response.ok) {
            const error = await response.text();
            return jsonResponse({ error: `Analytics API error: ${error}` }, 500);
          }
          
          const data: any = await response.json();
          
          const totals = { pageViews: 0, sessions: 0, activeUsers: 0, bounceRate: 0, avgSessionDuration: 0 };
          const daily: any[] = [];
          
          if (data.rows) {
            for (const row of data.rows) {
              const dateStr = row.dimensionValues[0].value;
              const formattedDate = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
              const pageViews = parseFloat(row.metricValues[0].value) || 0;
              const sessions = parseFloat(row.metricValues[1].value) || 0;
              const users = parseFloat(row.metricValues[2].value) || 0;
              const bounceRate = parseFloat(row.metricValues[3].value) || 0;
              const duration = parseFloat(row.metricValues[4].value) || 0;
              
              daily.push({ date: formattedDate, pageViews, sessions, users, bounceRate: bounceRate * 100, duration });
              
              totals.pageViews += pageViews;
              totals.sessions += sessions;
              totals.activeUsers += users;
              totals.bounceRate += bounceRate * 100;
              totals.avgSessionDuration += duration;
            }
            
            if (data.rows.length > 0) {
              totals.bounceRate = totals.bounceRate / data.rows.length;
              totals.avgSessionDuration = totals.avgSessionDuration / data.rows.length;
            }
          }
          
          return jsonResponse({ totals, daily });
        }

        if (path === '/analytics/top-content' && method === 'GET') {
          const propertyId = url.searchParams.get('property_id');
          const days = parseInt(url.searchParams.get('days') || '30');
          const limit = parseInt(url.searchParams.get('limit') || '10');
          
          if (!propertyId) return jsonResponse({ error: 'property_id required' }, 400);
          
          const token = await getValidToken(db, userId, 'google_analytics', env);
          if (!token) return jsonResponse({ error: 'Not connected' }, 401);
          
          const response = await fetch(`${ANALYTICS_DATA_API}/properties/${propertyId}:runReport`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
              dimensions: [{ name: 'pageTitle' }, { name: 'pagePath' }],
              metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'averageSessionDuration' }],
              orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
              limit
            })
          });
          
          if (!response.ok) {
            const error = await response.text();
            return jsonResponse({ error: `Analytics API error: ${error}` }, 500);
          }
          
          const data: any = await response.json();
          const pages = (data.rows || []).map((row: any) => ({
            title: row.dimensionValues[0].value || 'Untitled',
            path: row.dimensionValues[1].value,
            views: Math.round(parseFloat(row.metricValues[0].value)),
            users: Math.round(parseFloat(row.metricValues[1].value)),
            duration: parseFloat(row.metricValues[2].value)
          }));
          
          return jsonResponse({ pages });
        }

        if (path === '/analytics/sources' && method === 'GET') {
          const propertyId = url.searchParams.get('property_id');
          const days = parseInt(url.searchParams.get('days') || '30');
          
          if (!propertyId) return jsonResponse({ error: 'property_id required' }, 400);
          
          const token = await getValidToken(db, userId, 'google_analytics', env);
          if (!token) return jsonResponse({ error: 'Not connected' }, 401);
          
          const response = await fetch(`${ANALYTICS_DATA_API}/properties/${propertyId}:runReport`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
              dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
              metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'bounceRate' }],
              orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
              limit: 15
            })
          });
          
          if (!response.ok) {
            const error = await response.text();
            return jsonResponse({ error: `Analytics API error: ${error}` }, 500);
          }
          
          const data: any = await response.json();
          const sources = (data.rows || []).map((row: any) => ({
            source: row.dimensionValues[0].value || '(direct)',
            medium: row.dimensionValues[1].value || '(none)',
            sessions: Math.round(parseFloat(row.metricValues[0].value)),
            users: Math.round(parseFloat(row.metricValues[1].value)),
            bounceRate: (parseFloat(row.metricValues[2].value) * 100).toFixed(1)
          }));
          
          return jsonResponse({ sources });
        }

        if (path === '/analytics/geography' && method === 'GET') {
          const propertyId = url.searchParams.get('property_id');
          const days = parseInt(url.searchParams.get('days') || '30');
          
          if (!propertyId) return jsonResponse({ error: 'property_id required' }, 400);
          
          const token = await getValidToken(db, userId, 'google_analytics', env);
          if (!token) return jsonResponse({ error: 'Not connected' }, 401);
          
          const response = await fetch(`${ANALYTICS_DATA_API}/properties/${propertyId}:runReport`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
              dimensions: [{ name: 'country' }],
              metrics: [{ name: 'activeUsers' }, { name: 'sessions' }],
              orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
              limit: 20
            })
          });
          
          if (!response.ok) {
            const error = await response.text();
            return jsonResponse({ error: `Analytics API error: ${error}` }, 500);
          }
          
          const data: any = await response.json();
          const countries = (data.rows || []).map((row: any) => ({
            country: row.dimensionValues[0].value || 'Unknown',
            users: Math.round(parseFloat(row.metricValues[0].value)),
            sessions: Math.round(parseFloat(row.metricValues[1].value))
          }));
          
          return jsonResponse({ countries });
        }

        if (path === '/analytics/realtime' && method === 'GET') {
          const propertyId = url.searchParams.get('property_id');
          
          if (!propertyId) return jsonResponse({ error: 'property_id required' }, 400);
          
          const token = await getValidToken(db, userId, 'google_analytics', env);
          if (!token) return jsonResponse({ error: 'Not connected' }, 401);
          
          const response = await fetch(`${ANALYTICS_DATA_API}/properties/${propertyId}:runRealtimeReport`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              dimensions: [{ name: 'country' }],
              metrics: [{ name: 'activeUsers' }]
            })
          });
          
          if (!response.ok) {
            const error = await response.text();
            return jsonResponse({ error: `Analytics API error: ${error}` }, 500);
          }
          
          const data: any = await response.json();
          
          let activeUsers = 0;
          const byCountry: any[] = [];
          
          if (data.rows) {
            for (const row of data.rows) {
              const users = parseInt(row.metricValues[0].value);
              activeUsers += users;
              byCountry.push({
                country: row.dimensionValues[0].value,
                users
              });
            }
          }
          
          return jsonResponse({ activeUsers, byCountry });
        }

        // ==================== ACTIVITY / THREAD ====================
        
        if (path === '/activity' && method === 'GET') {
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const userFilter = url.searchParams.get('user');
          const typeFilter = url.searchParams.get('type');
          
          const activities: any[] = [];
          
          if (!typeFilter || typeFilter === 'checkin') {
            let query = 'SELECT *, "checkin" as activity_type FROM check_ins';
            const params: any[] = [];
            if (userFilter) {
              query += ' WHERE user_id = ?';
              params.push(userFilter);
            }
            query += ' ORDER BY created_at DESC LIMIT ?';
            params.push(limit);
            
            const checkins = await db.prepare(query).bind(...params).all();
            activities.push(...(checkins.results || []));
          }
          
          if (!typeFilter || typeFilter === 'completion') {
            let query = `SELECT id, user_id, text, completed_at as created_at, 'completion' as activity_type FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL`;
            const params: any[] = [];
            if (userFilter) {
              query += ' AND user_id = ?';
              params.push(userFilter);
            }
            query += ' ORDER BY completed_at DESC LIMIT ?';
            params.push(limit);
            
            const completions = await db.prepare(query).bind(...params).all();
            activities.push(...(completions.results || []));
          }
          
          if (!typeFilter || typeFilter === 'message') {
            let query = `SELECT *, 'message' as activity_type FROM messages`;
            const params: any[] = [];
            if (userFilter) {
              query += ' WHERE from_user = ? OR to_user = ?';
              params.push(userFilter, userFilter);
            }
            query += ' ORDER BY created_at DESC LIMIT ?';
            params.push(limit);
            
            const messages = await db.prepare(query).bind(...params).all();
            activities.push(...(messages.results || []));
          }
          
          activities.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
          
          return jsonResponse({ activities: activities.slice(0, limit) });
        }

        // ==================== CHECKINS ====================
        
        if (path === '/checkins' && method === 'GET') {
          const limit = parseInt(url.searchParams.get('limit') || '20');
          const userFilter = url.searchParams.get('user');
          
          let query = `SELECT * FROM check_ins`;
          const params: any[] = [];
          
          if (userFilter) {
            query += ` WHERE user_id = ?`;
            params.push(userFilter);
          }
          
          query += ` ORDER BY created_at DESC LIMIT ?`;
          params.push(limit);
          
          const checkins = await db.prepare(query).bind(...params).all();
          return jsonResponse({ checkins: checkins.results || [] });
        }

        const checkinMatch = path.match(/^\/checkins\/([^/]+)$/);
        if (checkinMatch && method === 'GET') {
          const checkinId = checkinMatch[1];
          
          const checkin = await db.prepare(`SELECT * FROM check_ins WHERE id = ?`).bind(checkinId).first();
          if (!checkin) return jsonResponse({ error: 'Checkin not found' }, 404);
          
          const comments = await db.prepare(`
            SELECT * FROM checkin_comments 
            WHERE check_in_id = ? 
            ORDER BY created_at ASC
          `).bind(checkinId).all();
          
          return jsonResponse({ 
            checkin, 
            comments: comments.results || [] 
          });
        }

        if (path === '/checkins' && method === 'POST') {
          const body = await request.json() as any;
          const { thread_summary, full_recap, project_name } = body;
          
          if (!thread_summary || !full_recap) {
            return jsonResponse({ error: 'thread_summary and full_recap required' }, 400);
          }
          
          const id = crypto.randomUUID();
          await db.prepare(`
            INSERT INTO check_ins (id, user_id, thread_summary, full_recap, project_name, created_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
          `).bind(id, userId, thread_summary, full_recap, project_name || null).run();
          
          return jsonResponse({ success: true, id, message: 'Check-in created' });
        }

        const checkinCommentMatch = path.match(/^\/checkins\/([^/]+)\/comments$/);
        if (checkinCommentMatch && method === 'POST') {
          const checkinId = checkinCommentMatch[1];
          const body = await request.json() as any;
          const { content } = body;
          
          if (!content?.trim()) return jsonResponse({ error: 'Content required' }, 400);
          
          const id = crypto.randomUUID();
          await db.prepare(`
            INSERT INTO checkin_comments (id, check_in_id, user_id, content, created_at) 
            VALUES (?, ?, ?, ?, datetime('now'))
          `).bind(id, checkinId, userId, content.trim()).run();
          
          return jsonResponse({ success: true, id, message: 'Comment added' });
        }

        // ==================== MESSAGES ====================
        
        if (path === '/messages' && method === 'GET') {
          await db.prepare("DELETE FROM messages WHERE expires_at < datetime('now')").run();
          
          const includeRead = url.searchParams.get('include_read') === 'true';
          let query = `SELECT * FROM messages WHERE to_user = ?`;
          if (!includeRead) {
            query += ` AND read_at IS NULL`;
          }
          query += ` ORDER BY created_at DESC`;
          
          const messages = await db.prepare(query).bind(userId).all();
          
          return jsonResponse({ 
            messages: messages.results || [],
            count: messages.results?.length || 0
          });
        }

        if (path === '/messages/unread-count' && method === 'GET') {
          const result = await db.prepare(
            `SELECT COUNT(*) as count FROM messages WHERE to_user = ? AND read_at IS NULL`
          ).bind(userId).first() as any;
          
          return jsonResponse({ count: result?.count || 0 });
        }

        if (path === '/messages' && method === 'POST') {
          const body = await request.json() as any;
          const { to, message } = body;
          
          if (!to || !message?.trim()) {
            return jsonResponse({ error: 'to and message required' }, 400);
          }
          
          const id = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
          
          await db.prepare(`
            INSERT INTO messages (id, from_user, to_user, content, created_at, expires_at)
            VALUES (?, ?, ?, ?, datetime('now'), ?)
          `).bind(id, userId, to, message.trim(), expiresAt).run();
          
          return jsonResponse({ success: true, id, message: 'Message sent' });
        }

        const readMessageMatch = path.match(/^\/messages\/([^/]+)\/read$/);
        if (readMessageMatch && method === 'POST') {
          const messageId = readMessageMatch[1];
          await db.prepare(`
            UPDATE messages SET read_at = datetime('now') WHERE id = ? AND to_user = ?
          `).bind(messageId, userId).run();
          return jsonResponse({ success: true, message: 'Message marked as read' });
        }

        if (path === '/messages/read' && method === 'POST') {
          await db.prepare(`
            UPDATE messages SET read_at = datetime('now') WHERE to_user = ? AND read_at IS NULL
          `).bind(userId).run();
          return jsonResponse({ success: true, message: 'Messages marked as read' });
        }

        if (path === '/messages/read-all' && method === 'POST') {
          await db.prepare(`
            UPDATE messages SET read_at = datetime('now') WHERE to_user = ? AND read_at IS NULL
          `).bind(userId).run();
          return jsonResponse({ success: true, message: 'All messages marked as read' });
        }

        // ==================== TEAM ====================
        
        if (path === '/team/summary' && method === 'GET') {
          const team = env.TEAM || 'micaiah,irene';
          const teammates = team.split(',').map(t => t.trim()).filter(t => t !== userId);
          
          const summary: any = { teammates: [] };
          
          for (const teammate of teammates) {
            const recentCheckin = await db.prepare(`
              SELECT * FROM check_ins WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
            `).bind(teammate).first();
            
            const taskCount = await db.prepare(`
              SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = 'open' AND (is_active = 1 OR objective_id IS NOT NULL)
            `).bind(teammate).first() as any;
            
            summary.teammates.push({
              id: teammate,
              name: teammate.charAt(0).toUpperCase() + teammate.slice(1),
              active_tasks: taskCount?.count || 0,
              last_checkin: recentCheckin || null
            });
          }
          
          return jsonResponse(summary);
        }

        // ==================== HANDOFF SYSTEM ====================
        
        if (path === '/handoff/queue' && method === 'GET') {
          const status = url.searchParams.get('status');
          const project = url.searchParams.get('project');
          const priority = url.searchParams.get('priority');
          const limit = parseInt(url.searchParams.get('limit') || '20');
          
          let query = 'SELECT * FROM handoff_queue WHERE 1=1';
          const params: any[] = [];
          
          if (status) {
            query += ' AND status = ?';
            params.push(status);
          }
          if (project) {
            query += ' AND project_name = ?';
            params.push(project);
          }
          if (priority) {
            query += ' AND priority = ?';
            params.push(priority);
          }
          
          query += ' ORDER BY CASE priority WHEN "urgent" THEN 1 WHEN "high" THEN 2 WHEN "normal" THEN 3 WHEN "low" THEN 4 END, created_at ASC LIMIT ?';
          params.push(limit);
          
          try {
            const tasks = await db.prepare(query).bind(...params).all();
            return jsonResponse({ tasks: tasks.results || [] });
          } catch (e) {
            return jsonResponse({ tasks: [], error: 'Handoff table may not exist' });
          }
        }

        const handoffGetMatch = path.match(/^\/handoff\/tasks\/([^/]+)$/);
        if (handoffGetMatch && method === 'GET') {
          const taskId = handoffGetMatch[1];
          try {
            const task = await db.prepare('SELECT * FROM handoff_queue WHERE id = ?').bind(taskId).first();
            if (!task) return jsonResponse({ error: 'Task not found' }, 404);
            return jsonResponse({ task });
          } catch (e) {
            return jsonResponse({ error: 'Handoff table may not exist' }, 500);
          }
        }

        const handoffClaimMatch = path.match(/^\/handoff\/tasks\/([^/]+)\/claim$/);
        if (handoffClaimMatch && method === 'POST') {
          const taskId = handoffClaimMatch[1];
          try {
            await db.prepare(`
              UPDATE handoff_queue SET status = 'claimed', claimed_by = ?, claimed_at = datetime('now')
              WHERE id = ? AND status = 'pending'
            `).bind(userId, taskId).run();
            return jsonResponse({ success: true, message: 'Task claimed' });
          } catch (e) {
            return jsonResponse({ error: 'Failed to claim task' }, 500);
          }
        }

        const handoffProjectMatch = path.match(/^\/handoff\/projects\/([^/]+)$/);
        if (handoffProjectMatch && method === 'GET') {
          const project = decodeURIComponent(handoffProjectMatch[1]);
          try {
            const stats = await db.prepare(`
              SELECT status, COUNT(*) as count FROM handoff_queue 
              WHERE project_name = ? GROUP BY status
            `).bind(project).all();
            
            const statusCounts: Record<string, number> = {};
            for (const row of (stats.results || []) as any[]) {
              statusCounts[row.status] = row.count;
            }
            
            const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
            const complete = statusCounts['complete'] || 0;
            const progress = total > 0 ? Math.round((complete / total) * 100) : 0;
            
            return jsonResponse({
              project_name: project,
              pending: statusCounts['pending'] || 0,
              claimed: statusCounts['claimed'] || 0,
              in_progress: statusCounts['in_progress'] || 0,
              complete: complete,
              blocked: statusCounts['blocked'] || 0,
              total,
              progress
            });
          } catch (e) {
            return jsonResponse({ error: 'Failed to get project status' }, 500);
          }
        }

        // ==================== CONNECTIONS ====================
        
        if (path === '/connections/status' && method === 'GET') {
          const services = [
            'google_drive', 'gmail_personal', 'gmail_company', 
            'blogger_personal', 'blogger_company',
            'google_contacts_personal', 'google_contacts_company',
            'google_analytics', 'github'
          ];
          
          const status: Record<string, boolean> = {};
          
          for (const service of services) {
            const token = await db.prepare(
              'SELECT id FROM oauth_tokens WHERE user_id = ? AND provider = ?'
            ).bind(userId, service).first();
            status[service] = !!token;
          }
          
          return jsonResponse({ connected: status });
        }

        // ==================== JOURNAL ====================
        
        if (path === '/journal' && method === 'GET') {
          const days = parseInt(url.searchParams.get('days') || '7');
          const entryType = url.searchParams.get('entry_type');
          const mood = url.searchParams.get('mood');
          
          let query = `SELECT * FROM journal_entries WHERE user_id = ? AND created_at >= datetime('now', '-${days} days')`;
          const params: any[] = [userId];
          
          if (entryType) {
            query += ' AND entry_type = ?';
            params.push(entryType);
          }
          if (mood) {
            query += ' AND mood = ?';
            params.push(mood);
          }
          
          query += ' ORDER BY created_at DESC';
          
          const entries = await db.prepare(query).bind(...params).all();
          return jsonResponse({ entries: entries.results || [] });
        }

        if (path === '/journal' && method === 'POST') {
          const body = await request.json() as any;
          const { content, mood, energy, entry_type } = body;
          
          if (!content?.trim()) {
            return jsonResponse({ error: 'content required' }, 400);
          }
          
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          const entryDate = now.split('T')[0];
          
          await db.prepare(`
            INSERT INTO journal_entries (id, user_id, entry_date, entry_type, content, mood, energy_level, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(id, userId, entryDate, entry_type || 'freeform', content.trim(), mood || null, energy || null, now, now).run();
          
          return jsonResponse({ success: true, id, message: 'Journal entry created' });
        }

        if (path === '/journal/streak' && method === 'GET') {
          const entries = await db.prepare(`
            SELECT DISTINCT date(created_at) as entry_date FROM journal_entries 
            WHERE user_id = ? ORDER BY entry_date DESC LIMIT 30
          `).bind(userId).all();
          
          let streak = 0;
          const today = new Date().toISOString().split('T')[0];
          let checkDate = new Date(today);
          
          for (const entry of (entries.results || []) as any[]) {
            const entryDate = entry.entry_date;
            const expectedDate = checkDate.toISOString().split('T')[0];
            
            if (entryDate === expectedDate) {
              streak++;
              checkDate.setDate(checkDate.getDate() - 1);
            } else if (entryDate < expectedDate) {
              break;
            }
          }
          
          return jsonResponse({ streak, last_entry: (entries.results?.[0] as any)?.entry_date || null });
        }

        // ==================== WORK SESSIONS ====================
        
        if (path === '/work-sessions/current' && method === 'GET') {
          const today = new Date().toISOString().split('T')[0];
          const session = await db.prepare(`
            SELECT * FROM work_sessions WHERE user_id = ? AND session_date = ? ORDER BY created_at DESC LIMIT 1
          `).bind(userId, today).first();
          
          return jsonResponse({ session: session || null });
        }

        // ==================== MORNING BRIEFING ====================
        
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
                const openCount = await db.prepare("SELECT COUNT(*) as c FROM tasks WHERE objective_id = ? AND user_id = ? AND status = 'open'").bind(obj.id, userId).first();
                const doneCount = await db.prepare("SELECT COUNT(*) as c FROM tasks WHERE objective_id = ? AND user_id = ? AND status = 'done'").bind(obj.id, userId).first();
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

          let incomingHandoffs: any[] = [];
          try {
            const handoffs = await db.prepare(`SELECT h.*, t.text as task_text FROM handoff_suggestions h JOIN tasks t ON h.task_id = t.id WHERE h.to_user = ? AND h.status = 'pending'`).bind(userId).all();
            incomingHandoffs = handoffs.results || [];
          } catch (e) { console.error('Handoff fetch error:', e); }

          let unreadMessages = 0;
          try {
            const msgCount = await db.prepare(`SELECT COUNT(*) as count FROM messages WHERE to_user = ? AND read_at IS NULL`).bind(userId).first();
            unreadMessages = msgCount?.count || 0;
          } catch (e) { console.error('Message count error:', e); }

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

          const activeTasks: any[] = [];
          const sprintTasks: any[] = [];
          const backlog: any[] = [];

          for (const t of (allTasks.results || []) as any[]) {
            if (t.is_active) { activeTasks.push(t); continue; }
            if (t.objective_id) { sprintTasks.push(t); continue; }
            if (t.assigned_by) { continue; }
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
            incoming: incomingTasks,
            incomingHandoffs,
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

        // ==================== EMAIL API (for Bethany) ====================
        
        if (path === '/email/inbox' && method === 'GET') {
          if (!checkBethanyAuth(request)) {
            return jsonResponse({ error: 'Unauthorized' }, 401);
          }
          
          const account = url.searchParams.get('account') || 'personal';
          const maxResults = parseInt(url.searchParams.get('max_results') || '10');
          
          const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
          const token = await getValidToken(db, userId, provider, env);
          
          if (!token) {
            return jsonResponse({ error: `${account} email not connected`, needs_auth: true }, 401);
          }
          
          const resp = await fetch(`${GMAIL_API_URL}/users/me/messages?maxResults=${maxResults}&q=is:unread`, {
            headers: { Authorization: 'Bearer ' + token }
          });
          
          if (!resp.ok) {
            return jsonResponse({ error: 'Failed to fetch emails' }, 500);
          }
          
          const data: any = await resp.json();
          
          if (!data.messages?.length) {
            return jsonResponse({ messages: [], count: 0 });
          }
          
          const messages: any[] = [];
          for (const msg of data.messages.slice(0, maxResults)) {
            const msgResp = await fetch(`${GMAIL_API_URL}/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
              headers: { Authorization: 'Bearer ' + token }
            });
            
            if (msgResp.ok) {
              const msgData: any = await msgResp.json();
              const headers = msgData.payload?.headers || [];
              messages.push({
                id: msg.id,
                from: headers.find((h: any) => h.name === 'From')?.value || 'Unknown',
                subject: headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)',
                date: headers.find((h: any) => h.name === 'Date')?.value || '',
                snippet: msgData.snippet || ''
              });
            }
          }
          
          return jsonResponse({ messages, count: messages.length, account });
        }

        if (path === '/email/read' && method === 'GET') {
          if (!checkBethanyAuth(request)) {
            return jsonResponse({ error: 'Unauthorized' }, 401);
          }
          
          const account = url.searchParams.get('account') || 'personal';
          const messageId = url.searchParams.get('message_id');
          
          if (!messageId) {
            return jsonResponse({ error: 'message_id required' }, 400);
          }
          
          const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
          const token = await getValidToken(db, userId, provider, env);
          
          if (!token) {
            return jsonResponse({ error: `${account} email not connected`, needs_auth: true }, 401);
          }
          
          const resp = await fetch(`${GMAIL_API_URL}/users/me/messages/${messageId}?format=full`, {
            headers: { Authorization: 'Bearer ' + token }
          });
          
          if (!resp.ok) {
            return jsonResponse({ error: 'Failed to fetch email' }, 500);
          }
          
          const data: any = await resp.json();
          const headers = data.payload?.headers || [];
          
          let body = '';
          if (data.payload?.body?.data) {
            body = atob(data.payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
          } else if (data.payload?.parts) {
            const textPart = data.payload.parts.find((p: any) => p.mimeType === 'text/plain');
            if (textPart?.body?.data) {
              body = atob(textPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
            }
          }
          
          return jsonResponse({
            id: messageId,
            from: headers.find((h: any) => h.name === 'From')?.value || 'Unknown',
            to: headers.find((h: any) => h.name === 'To')?.value || 'Unknown',
            subject: headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)',
            date: headers.find((h: any) => h.name === 'Date')?.value || '',
            body: body.slice(0, 5000),
            truncated: body.length > 5000
          });
        }

        if (path === '/email/send' && method === 'POST') {
          if (!checkBethanyAuth(request)) {
            return jsonResponse({ error: 'Unauthorized' }, 401);
          }
          
          const body = await request.json() as any;
          const { account, to, subject, body: emailBody } = body;
          
          if (!to || !subject || !emailBody) {
            return jsonResponse({ error: 'to, subject, and body required' }, 400);
          }
          
          const provider = (account || 'personal') === 'personal' ? 'gmail_personal' : 'gmail_company';
          const token = await getValidToken(db, userId, provider, env);
          
          if (!token) {
            return jsonResponse({ error: `${account || 'personal'} email not connected`, needs_auth: true }, 401);
          }
          
          const email = [
            `To: ${to}`,
            `Subject: ${subject}`,
            'Content-Type: text/plain; charset=utf-8',
            '',
            emailBody
          ].join('\r\n');
          
          const encodedEmail = btoa(email).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          
          const resp = await fetch(`${GMAIL_API_URL}/users/me/messages/send`, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ raw: encodedEmail })
          });
          
          if (!resp.ok) {
            const error = await resp.text();
            return jsonResponse({ error: `Failed to send: ${error}` }, 500);
          }
          
          const result: any = await resp.json();
          return jsonResponse({ success: true, message_id: result.id, sent_to: to });
        }

        if (path === '/email/search' && method === 'GET') {
          if (!checkBethanyAuth(request)) {
            return jsonResponse({ error: 'Unauthorized' }, 401);
          }
          
          const account = url.searchParams.get('account') || 'personal';
          const query = url.searchParams.get('query');
          const maxResults = parseInt(url.searchParams.get('max_results') || '10');
          
          if (!query) {
            return jsonResponse({ error: 'query required' }, 400);
          }
          
          const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
          const token = await getValidToken(db, userId, provider, env);
          
          if (!token) {
            return jsonResponse({ error: `${account} email not connected`, needs_auth: true }, 401);
          }
          
          const resp = await fetch(`${GMAIL_API_URL}/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`, {
            headers: { Authorization: 'Bearer ' + token }
          });
          
          if (!resp.ok) {
            return jsonResponse({ error: 'Failed to search emails' }, 500);
          }
          
          const data: any = await resp.json();
          
          if (!data.messages?.length) {
            return jsonResponse({ messages: [], count: 0, query });
          }
          
          const messages: any[] = [];
          for (const msg of data.messages.slice(0, maxResults)) {
            const msgResp = await fetch(`${GMAIL_API_URL}/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
              headers: { Authorization: 'Bearer ' + token }
            });
            
            if (msgResp.ok) {
              const msgData: any = await msgResp.json();
              const headers = msgData.payload?.headers || [];
              messages.push({
                id: msg.id,
                from: headers.find((h: any) => h.name === 'From')?.value || 'Unknown',
                subject: headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)',
                date: headers.find((h: any) => h.name === 'Date')?.value || '',
                snippet: msgData.snippet || ''
              });
            }
          }
          
          return jsonResponse({ messages, count: messages.length, query, account });
        }

        // ==================== GITHUB WEBHOOK ====================
        
        if (path === '/github-webhook' && method === 'POST') {
          const event = request.headers.get('X-GitHub-Event');
          
          if (event !== 'workflow_run') {
            return jsonResponse({ message: 'Event ignored', event });
          }
          
          try {
            const payload = await request.json() as any;
            const { action, workflow_run, repository } = payload;
            
            if (!['completed', 'requested', 'in_progress'].includes(action)) {
              return jsonResponse({ message: 'Action ignored', action });
            }
            
            const id = crypto.randomUUID();
            const ts = new Date().toISOString();
            
            const repoName = repository?.full_name || repository?.name || 'unknown';
            const workflowName = workflow_run?.name || 'unknown';
            const runId = workflow_run?.id?.toString() || null;
            const branch = workflow_run?.head_branch || null;
            const commitSha = workflow_run?.head_sha || null;
            const commitMessage = workflow_run?.head_commit?.message?.split('\n')[0] || null;
            const triggeredBy = workflow_run?.actor?.login || null;
            const startedAt = workflow_run?.created_at || null;
            const completedAt = workflow_run?.updated_at || null;
            
            let status = 'in_progress';
            let errorMessage = null;
            let durationSeconds = null;
            
            if (action === 'completed') {
              status = workflow_run?.conclusion || 'unknown';
              if (startedAt && completedAt) {
                durationSeconds = Math.round(
                  (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
                );
              }
              if (status === 'failure') {
                errorMessage = 'Workflow failed - check GitHub Actions for details';
              }
            }
            
            await db.prepare(`
              INSERT INTO deploys (id, repo, workflow, run_id, status, branch, commit_sha, commit_message, triggered_by, started_at, completed_at, duration_seconds, error_message, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              id, repoName, workflowName, runId, status, branch, commitSha, commitMessage,
              triggeredBy, startedAt, completedAt, durationSeconds, errorMessage, ts
            ).run();
            
            return jsonResponse({ 
              success: true, 
              message: 'Deploy recorded',
              deploy: { id, repo: repoName, workflow: workflowName, status }
            });
            
          } catch (e: any) {
            console.error('Webhook error:', e);
            return jsonResponse({ error: e.message || 'Webhook processing failed' }, 500);
          }
        }

        // ==================== DEPLOYS ====================
        
        if (path === '/deploys' && method === 'GET') {
          const repo = url.searchParams.get('repo');
          const limit = parseInt(url.searchParams.get('limit') || '10');
          
          let query = 'SELECT * FROM deploys';
          const params: any[] = [];
          
          if (repo) {
            query += ' WHERE repo = ?';
            params.push(repo);
          }
          query += ' ORDER BY created_at DESC LIMIT ?';
          params.push(limit);
          
          try {
            const deploys = await db.prepare(query).bind(...params).all();
            return jsonResponse({ deploys: deploys.results || [] });
          } catch (e) {
            return jsonResponse({ deploys: [], error: 'Table not initialized' });
          }
        }

        if (path === '/deploys/latest' && method === 'GET') {
          const repo = url.searchParams.get('repo');
          if (!repo) return jsonResponse({ error: 'repo parameter required' }, 400);
          
          try {
            const deploy = await db.prepare(
              'SELECT * FROM deploys WHERE repo = ? ORDER BY created_at DESC LIMIT 1'
            ).bind(repo).first();
            
            return jsonResponse({ deploy: deploy || null });
          } catch (e) {
            return jsonResponse({ deploy: null, error: 'Table not initialized' });
          }
        }

        // ==================== SCRATCHPAD ====================
        
        if (path === '/scratchpad' && method === 'GET') {
          const items = await db.prepare(`
            SELECT * FROM scratchpad WHERE user_id = ? ORDER BY created_at DESC
          `).bind(userId).all();
          
          return jsonResponse({ items: items.results || [] });
        }

        if (path === '/scratchpad' && method === 'POST') {
          const body = await request.json() as any;
          const { text } = body;
          if (!text?.trim()) return jsonResponse({ error: 'Text required' }, 400);
          
          const id = crypto.randomUUID();
          await db.prepare(`
            INSERT INTO scratchpad (id, user_id, text, created_at) VALUES (?, ?, ?, datetime('now'))
          `).bind(id, userId, text.trim()).run();
          
          return jsonResponse({ success: true, id });
        }

        const scratchProcessMatch = path.match(/^\/scratchpad\/([^/]+)\/process$/);
        if (scratchProcessMatch && method === 'POST') {
          const itemId = scratchProcessMatch[1];
          const body = await request.json() as any;
          const { action } = body;
          
          const item = await db.prepare('SELECT * FROM scratchpad WHERE id = ? AND user_id = ?').bind(itemId, userId).first();
          if (!item) return jsonResponse({ error: 'Item not found' }, 404);
          
          if (action === 'delete') {
            await db.prepare('DELETE FROM scratchpad WHERE id = ?').bind(itemId).run();
            return jsonResponse({ success: true, message: 'Deleted' });
          }
          
          const taskId = crypto.randomUUID();
          await db.prepare(`
            INSERT INTO tasks (id, user_id, text, category, priority, status, is_active, created_at, last_touched) 
            VALUES (?, ?, ?, 'General', 3, 'open', ?, datetime('now'), datetime('now'))
          `).bind(taskId, userId, item.text, action === 'activate' ? 1 : 0).run();
          
          await db.prepare('DELETE FROM scratchpad WHERE id = ?').bind(itemId).run();
          
          return jsonResponse({ success: true, taskId, message: action === 'activate' ? 'Task activated' : 'Task created' });
        }

        // ==================== NOTES ====================
        
        if (path === '/notes' && method === 'GET') {
          const notes = await db.prepare(`
            SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC
          `).bind(userId).all();
          
          return jsonResponse({ notes: notes.results || [] });
        }

        if (path === '/notes' && method === 'POST') {
          const body = await request.json() as any;
          const { title, content, category } = body;
          if (!title?.trim()) return jsonResponse({ error: 'Title required' }, 400);
          
          const id = crypto.randomUUID();
          await db.prepare(`
            INSERT INTO notes (id, user_id, title, content, category, created_at) 
            VALUES (?, ?, ?, ?, ?, datetime('now'))
          `).bind(id, userId, title.trim(), content || '', category || 'General').run();
          
          return jsonResponse({ success: true, id });
        }

        const noteDeleteMatch = path.match(/^\/notes\/([^/]+)$/);
        if (noteDeleteMatch && method === 'DELETE') {
          const noteId = noteDeleteMatch[1];
          await db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').bind(noteId, userId).run();
          return jsonResponse({ success: true, message: 'Note deleted' });
        }

        // ==================== ORPHANS ====================
        
        if (path === '/orphans' && method === 'GET') {
          const orphans = await db.prepare(`
            SELECT * FROM tasks 
            WHERE user_id = ? 
              AND status = 'open' 
              AND is_active = 0
              AND objective_id IS NULL
              AND assigned_by IS NULL
              AND (category IS NULL OR category = '' OR category = 'General')
              AND (project IS NULL OR project = '')
            ORDER BY created_at DESC
            LIMIT 20
          `).bind(userId).all();
          
          return jsonResponse({ tasks: orphans.results || [] });
        }

        // ==================== LAUNCHES ====================
        
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

        const checklistMatch = path.match(/^\/launches\/([^/]+)\/checklist$/);
        if (checklistMatch && method === 'GET') {
          const projectId = checklistMatch[1];
          const items = await db.prepare(`SELECT * FROM launch_checklist WHERE project_id = ? ORDER BY phase, section, sort_order`).bind(projectId).all();
          return jsonResponse({ items: items.results || [] });
        }

        const checklistCompleteMatch = path.match(/^\/launches\/([^/]+)\/checklist\/([^/]+)\/complete$/);
        if (checklistCompleteMatch && method === 'POST') {
          const itemId = checklistCompleteMatch[2];
          await db.prepare(`UPDATE launch_checklist SET completed = 1, completed_at = datetime('now') WHERE id = ?`).bind(itemId).run();
          return jsonResponse({ success: true, message: 'Item completed' });
        }

        // ==================== IDEAS ====================
        
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
