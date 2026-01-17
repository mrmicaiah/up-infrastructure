// api-routes.ts - REST API endpoints for the Productivity Dashboard

interface Env {
  DB: D1Database;
  USER_ID: string;
  DASHBOARD_API_KEY?: string;
  BETHANY_API_KEY?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-GitHub-Event, X-Hub-Signature-256',
};

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API_URL = 'https://gmail.googleapis.com/gmail/v1';

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
        // ==================== EMAIL API (for Bethany) ====================
        
        // Check inbox
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
          
          // Fetch details for each message
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

        // Read specific email
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
          
          // Extract body
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

        // Send email
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
          
          // Build the email
          const email = [
            `To: ${to}`,
            `Subject: ${subject}`,
            'Content-Type: text/plain; charset=utf-8',
            '',
            emailBody
          ].join('\r\n');
          
          // Base64 encode
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

        // Search email
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
        
        // GITHUB WEBHOOK - receives workflow_run events
        if (path === '/github-webhook' && method === 'POST') {
          const event = request.headers.get('X-GitHub-Event');
          
          // Only process workflow_run events
          if (event !== 'workflow_run') {
            return jsonResponse({ message: 'Event ignored', event });
          }
          
          try {
            const payload = await request.json() as any;
            const { action, workflow_run, repository } = payload;
            
            // We care about 'completed' and 'requested' actions
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

        // ==================== DEPLOYS API ====================
        
        // GET recent deploys
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
            // Table might not exist yet
            return jsonResponse({ deploys: [], error: 'Table not initialized - run migration' });
          }
        }

        // GET latest deploy for a repo
        if (path === '/deploys/latest' && method === 'GET') {
          const repo = url.searchParams.get('repo');
          if (!repo) return jsonResponse({ error: 'repo parameter required' }, 400);
          
          try {
            const deploy = await db.prepare(
              'SELECT * FROM deploys WHERE repo = ? ORDER BY created_at DESC LIMIT 1'
            ).bind(repo).first();
            
            return jsonResponse({ deploy: deploy || null });
          } catch (e) {
            return jsonResponse({ deploy: null, error: 'Table not initialized - run migration' });
          }
        }

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

        // ==================== SCRATCHPAD ====================
        
        // GET scratchpad items
        if (path === '/scratchpad' && method === 'GET') {
          const items = await db.prepare(`
            SELECT * FROM scratchpad 
            WHERE user_id = ? 
            ORDER BY created_at DESC
          `).bind(userId).all();
          
          return jsonResponse({ items: items.results || [] });
        }

        // POST to scratchpad
        if (path === '/scratchpad' && method === 'POST') {
          const body = await request.json() as any;
          const { text } = body;
          if (!text?.trim()) return jsonResponse({ error: 'Text required' }, 400);
          
          const id = crypto.randomUUID();
          await db.prepare(`
            INSERT INTO scratchpad (id, user_id, text, created_at) 
            VALUES (?, ?, ?, datetime('now'))
          `).bind(id, userId, text.trim()).run();
          
          return jsonResponse({ success: true, id });
        }

        // Process scratchpad item
        const scratchProcessMatch = path.match(/^\/scratchpad\/([^/]+)\/process$/);
        if (scratchProcessMatch && method === 'POST') {
          const itemId = scratchProcessMatch[1];
          const body = await request.json() as any;
          const { action } = body; // 'activate', 'task', or 'delete'
          
          const item = await db.prepare('SELECT * FROM scratchpad WHERE id = ? AND user_id = ?').bind(itemId, userId).first();
          if (!item) return jsonResponse({ error: 'Item not found' }, 404);
          
          if (action === 'delete') {
            await db.prepare('DELETE FROM scratchpad WHERE id = ?').bind(itemId).run();
            return jsonResponse({ success: true, message: 'Deleted' });
          }
          
          // Create task from scratchpad item
          const taskId = crypto.randomUUID();
          await db.prepare(`
            INSERT INTO tasks (id, user_id, text, category, priority, status, is_active, created_at, last_touched) 
            VALUES (?, ?, ?, 'General', 3, 'open', ?, datetime('now'), datetime('now'))
          `).bind(taskId, userId, item.text, action === 'activate' ? 1 : 0).run();
          
          // Delete from scratchpad
          await db.prepare('DELETE FROM scratchpad WHERE id = ?').bind(itemId).run();
          
          return jsonResponse({ success: true, taskId, message: action === 'activate' ? 'Task activated' : 'Task created' });
        }

        // ==================== NOTES ====================
        
        // GET notes
        if (path === '/notes' && method === 'GET') {
          const notes = await db.prepare(`
            SELECT * FROM notes 
            WHERE user_id = ? 
            ORDER BY created_at DESC
          `).bind(userId).all();
          
          return jsonResponse({ notes: notes.results || [] });
        }

        // POST note
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

        // DELETE note
        const noteDeleteMatch = path.match(/^\/notes\/([^/]+)$/);
        if (noteDeleteMatch && method === 'DELETE') {
          const noteId = noteDeleteMatch[1];
          await db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').bind(noteId, userId).run();
          return jsonResponse({ success: true, message: 'Note deleted' });
        }

        // ==================== ORPHANS ====================
        
        // GET orphans (tasks without category, project, objective, not active)
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

        // RESTORE TASK (from completed)
        const restoreMatch = path.match(/^\/tasks\/([^/]+)\/restore$/);
        if (restoreMatch && method === 'POST') {
          const taskId = restoreMatch[1];
          await db.prepare(`UPDATE tasks SET status = 'open', completed_at = NULL, last_touched = datetime('now') WHERE id = ? AND user_id = ?`).bind(taskId, userId).run();
          return jsonResponse({ success: true, message: 'Task restored' });
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
