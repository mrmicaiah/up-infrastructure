import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// ==================
// HELPER FUNCTIONS
// ==================

function needsBreakdown(text: string): boolean {
  const bigTaskIndicators = [
    /^(build|create|develop|design|write|edit|launch|implement|complete)\s+(a|the|my|our)\s+\w+/i,
    /entire|whole|full|complete/i,
    /project|system|platform|application|book|novel|course|program/i,
  ];
  const isShort = text.split(' ').length <= 5;
  if (isShort) return false;
  return bigTaskIndicators.some(pattern => pattern.test(text));
}

function isVagueTask(text: string): boolean {
  const vagueIndicators = [
    /^(think about|consider|look into|explore|research|figure out|work on)/i,
    /^(need to|should|want to|have to)\s+(build|create|make|do|start)/i,
  ];
  const clearTaskIndicators = [
    /^(check|send|email|call|reply|review|read|fix|update|schedule|book|buy|pay)/i,
  ];
  if (clearTaskIndicators.some(p => p.test(text))) return false;
  return vagueIndicators.some(p => p.test(text));
}

function inferFocusLevel(text: string): string {
  const highFocus = [/edit|write|develop|build|design|create|analyze|plan|debug|refactor/i];
  const lowFocus = [/check|send|email|call|reply|schedule|book|buy|pay|remind|look|find/i];
  if (lowFocus.some(p => p.test(text))) return 'low';
  if (highFocus.some(p => p.test(text))) return 'high';
  return 'medium';
}

function getDayOfWeek(): string {
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date().getDay()];
}

function getTimeOfDay(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

function normalizeUser(user: string): string {
  return user.toLowerCase().trim();
}

function getPreviousDate(dateStr: string): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() - 1);
  return date.toISOString().split('T')[0];
}

// ==================
// LAUNCH DOCS PARSER
// ==================

interface ParsedItem {
  phase: string;
  section: string;
  item_text: string;
  sort_order: number;
  tags: string[];
  due_offset: number | null;
  is_recurring: string | null;
}

function parseLaunchDocument(content: string): { phases: string[], items: ParsedItem[] } {
  const lines = content.split('\n');
  const phases: string[] = [];
  const items: ParsedItem[] = [];
  
  let currentPhase = '';
  let currentSection = '';
  let sortOrder = 0;
  
  for (const line of lines) {
    // Match phase headers: # PHASE 1: SETUP or # SETUP
    const phaseMatch = line.match(/^#\s+(?:PHASE\s*\d*:?\s*)?(.+)$/i);
    if (phaseMatch && !line.startsWith('##')) {
      currentPhase = phaseMatch[1].trim();
      if (!phases.includes(currentPhase)) {
        phases.push(currentPhase);
      }
      currentSection = '';
      continue;
    }
    
    // Match section headers: ## 1.1 Title or ## Title
    const sectionMatch = line.match(/^##\s+(?:\d+\.\d+\s+)?(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }
    
    // Match checklist items: - [ ] Item text [TAGS]
    const itemMatch = line.match(/^-\s*\[\s*\]\s*(.+)$/);
    if (itemMatch && currentPhase) {
      let itemText = itemMatch[1].trim();
      const tags: string[] = [];
      let dueOffset: number | null = null;
      let isRecurring: string | null = null;
      
      // Extract tags
      const tagMatches = itemText.matchAll(/\[([^\]]+)\]/g);
      for (const match of tagMatches) {
        const tag = match[1];
        
        // Parse due offset: [DUE:LAUNCH-14] or [DUE:LAUNCH+7]
        const dueMatch = tag.match(/^DUE:LAUNCH([+-]\d+)$/i);
        if (dueMatch) {
          dueOffset = parseInt(dueMatch[1]);
          continue;
        }
        
        // Parse recurring: [DAILY] or [WEEKLY]
        if (tag.toUpperCase() === 'DAILY') {
          isRecurring = 'daily';
          continue;
        }
        if (tag.toUpperCase() === 'WEEKLY') {
          isRecurring = 'weekly';
          continue;
        }
        
        // All other tags
        tags.push(tag.toUpperCase());
      }
      
      // Clean item text (remove tags)
      itemText = itemText.replace(/\s*\[[^\]]+\]/g, '').trim();
      
      items.push({
        phase: currentPhase,
        section: currentSection,
        item_text: itemText,
        sort_order: sortOrder++,
        tags,
        due_offset: dueOffset,
        is_recurring: isRecurring,
      });
    }
  }
  
  return { phases, items };
}

// ==================
// INTELLIGENCE HELPERS
// ==================

async function logEvent(env: any, userId: string, eventType: string, taskId: string | null, eventData: any = {}) {
  await env.DB.prepare(
    'INSERT INTO task_events (id, user_id, task_id, event_type, event_data, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    crypto.randomUUID(),
    userId,
    taskId,
    eventType,
    JSON.stringify({ ...eventData, day: getDayOfWeek(), time: getTimeOfDay() }),
    new Date().toISOString()
  ).run();
}

async function updateDailyLog(env: any, userId: string, field: 'tasks_completed' | 'tasks_created', increment: number = 1) {
  const today = new Date().toISOString().split('T')[0];
  
  // Try to update existing row
  const result = await env.DB.prepare(
    `UPDATE daily_logs SET ${field} = ${field} + ? WHERE user_id = ? AND log_date = ?`
  ).bind(increment, userId, today).run();
  
  // If no row existed, insert one
  if (result.meta.changes === 0) {
    const values = { tasks_completed: 0, tasks_created: 0 };
    values[field] = increment;
    await env.DB.prepare(
      'INSERT INTO daily_logs (id, user_id, log_date, tasks_completed, tasks_created) VALUES (?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), userId, today, values.tasks_completed, values.tasks_created).run();
  }
}

async function getPatterns(env: any, userId: string): Promise<any[]> {
  try {
    const result = await env.DB.prepare(
      'SELECT * FROM user_patterns WHERE user_id = ? ORDER BY confidence DESC'
    ).bind(userId).all();
    return result.results || [];
  } catch {
    return [];
  }
}

async function analyzeAndStorePatterns(env: any, userId: string): Promise<string[]> {
  const insights: string[] = [];
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  
  // 1. Peak productivity hours
  const completionsByTime = await env.DB.prepare(`
    SELECT 
      json_extract(event_data, '$.time') as time_of_day,
      COUNT(*) as count
    FROM task_events 
    WHERE user_id = ? AND event_type = 'completed' AND created_at >= ?
    GROUP BY time_of_day
    ORDER BY count DESC
  `).bind(userId, thirtyDaysAgo).all();
  
  if (completionsByTime.results.length > 0) {
    const peak = completionsByTime.results[0];
    if (peak.count >= 3) {
      insights.push(`Most productive in the ${peak.time_of_day}`);
      await upsertPattern(env, userId, 'peak_time', { time: peak.time_of_day, count: peak.count }, peak.count / 10);
    }
  }
  
  // 2. Peak productivity days
  const completionsByDay = await env.DB.prepare(`
    SELECT 
      json_extract(event_data, '$.day') as day_of_week,
      COUNT(*) as count
    FROM task_events 
    WHERE user_id = ? AND event_type = 'completed' AND created_at >= ?
    GROUP BY day_of_week
    ORDER BY count DESC
  `).bind(userId, thirtyDaysAgo).all();
  
  if (completionsByDay.results.length > 0) {
    const peak = completionsByDay.results[0];
    if (peak.count >= 3) {
      insights.push(`Most productive on ${peak.day_of_week}s`);
      await upsertPattern(env, userId, 'peak_day', { day: peak.day_of_week, count: peak.count }, peak.count / 10);
    }
  }
  
  // 3. Completion rate by focus level
  const focusStats = await env.DB.prepare(`
    SELECT 
      focus_level,
      COUNT(CASE WHEN status = 'done' THEN 1 END) as completed,
      COUNT(*) as total
    FROM tasks 
    WHERE user_id = ? AND created_at >= ?
    GROUP BY focus_level
  `).bind(userId, thirtyDaysAgo).all();
  
  for (const stat of focusStats.results) {
    const rate = stat.total > 0 ? stat.completed / stat.total : 0;
    if (stat.total >= 5) {
      if (rate < 0.3) {
        insights.push(`Struggling with ${stat.focus_level}-focus tasks (${Math.round(rate * 100)}% completion)`);
      } else if (rate > 0.7) {
        insights.push(`Great at ${stat.focus_level}-focus tasks (${Math.round(rate * 100)}% completion)`);
      }
      await upsertPattern(env, userId, `completion_rate_${stat.focus_level}`, { rate, total: stat.total }, rate);
    }
  }
  
  // 4. Average time to complete tasks
  const avgCompletion = await env.DB.prepare(`
    SELECT 
      AVG(julianday(completed_at) - julianday(created_at)) as avg_days
    FROM tasks 
    WHERE user_id = ? AND status = 'done' AND completed_at IS NOT NULL AND created_at >= ?
  `).bind(userId, thirtyDaysAgo).first();
  
  if (avgCompletion?.avg_days) {
    const days = Math.round(avgCompletion.avg_days * 10) / 10;
    insights.push(`Average task completion: ${days} days`);
    await upsertPattern(env, userId, 'avg_completion_days', { days }, 0.8);
  }
  
  // 5. Avoidance patterns (tasks that sit open > 7 days)
  const stuckTasks = await env.DB.prepare(`
    SELECT category, COUNT(*) as count
    FROM tasks 
    WHERE user_id = ? AND status = 'open' AND julianday('now') - julianday(created_at) >= 7
    GROUP BY category
    ORDER BY count DESC
  `).bind(userId).all();
  
  if (stuckTasks.results.length > 0 && stuckTasks.results[0].count >= 2) {
    const category = stuckTasks.results[0].category || 'uncategorized';
    insights.push(`Tends to delay ${category} tasks`);
    await upsertPattern(env, userId, 'avoidance_category', { category, count: stuckTasks.results[0].count }, 0.7);
  }
  
  return insights;
}

async function upsertPattern(env: any, userId: string, patternType: string, data: any, confidence: number) {
  const existing = await env.DB.prepare(
    'SELECT id FROM user_patterns WHERE user_id = ? AND pattern_type = ?'
  ).bind(userId, patternType).first();
  
  if (existing) {
    await env.DB.prepare(
      'UPDATE user_patterns SET pattern_data = ?, confidence = ?, updated_at = ? WHERE id = ?'
    ).bind(JSON.stringify(data), confidence, new Date().toISOString(), existing.id).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO user_patterns (id, user_id, pattern_type, pattern_data, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), userId, patternType, JSON.stringify(data), confidence, new Date().toISOString()).run();
  }
}

function generateNudges(patterns: any[], openTasks: any[]): string[] {
  const nudges: string[] = [];
  const now = new Date();
  const currentTime = getTimeOfDay();
  const currentDay = getDayOfWeek();
  
  for (const pattern of patterns) {
    const data = JSON.parse(pattern.pattern_data);
    
    switch (pattern.pattern_type) {
      case 'peak_time':
        if (data.time === currentTime) {
          nudges.push(`ðŸ”¥ It's your peak time (${currentTime}) - tackle something important!`);
        }
        break;
      case 'peak_day':
        if (data.day === currentDay) {
          nudges.push(`ðŸ“ˆ ${currentDay}s are your most productive day - make it count!`);
        }
        break;
      case 'avoidance_category':
        const avoidedTasks = openTasks.filter(t => t.category === data.category);
        if (avoidedTasks.length > 0) {
          nudges.push(`âš ï¸ You have ${avoidedTasks.length} ${data.category} tasks piling up`);
        }
        break;
      case 'completion_rate_high':
        if (data.rate < 0.4) {
          nudges.push(`ðŸ’¡ Try breaking down high-focus tasks - you complete ${Math.round(data.rate * 100)}% of them`);
        }
        break;
    }
  }
  
  // Check for tasks due soon
  const upcoming = openTasks.filter(t => {
    if (!t.due_date) return false;
    const due = new Date(t.due_date);
    const daysUntil = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return daysUntil <= 3 && daysUntil >= 0;
  });
  
  if (upcoming.length > 0) {
    nudges.push(`ðŸ—“ï¸ ${upcoming.length} task(s) due in the next 3 days`);
  }
  
  // Check for cold tasks
  const coldTasks = openTasks.filter(t => {
    const created = new Date(t.created_at);
    const daysOld = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
    return daysOld >= 7;
  });
  
  if (coldTasks.length >= 3) {
    nudges.push(`â„ï¸ ${coldTasks.length} tasks are over a week old`);
  }
  
  return nudges;
}

// ==================
// AUTO-CHECKPOINT HELPER
// ==================

async function autoCheckpoint(
  env: any, 
  userId: string, 
  trigger: string, 
  summary: string, 
  topics: string[] = [],
  taskId: string | null = null
) {
  try {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const ts = now.toISOString();
    
    // Get or create today's session
    let session = await env.DB.prepare(
      'SELECT * FROM work_sessions WHERE user_id = ? AND session_date = ?'
    ).bind(userId, today).first();
    
    let sessionId: string;
    if (!session) {
      // Auto-create session if none exists
      sessionId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO work_sessions (id, user_id, session_date, started_at, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(sessionId, userId, today, ts, ts).run();
    } else {
      sessionId = session.id;
    }
    
    // Create checkpoint
    await env.DB.prepare(
      'INSERT INTO checkpoints (id, user_id, session_id, checkpoint_time, trigger_type, summary, topics, task_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(),
      userId,
      sessionId,
      ts,
      trigger,
      summary,
      JSON.stringify(topics),
      taskId ? JSON.stringify([taskId]) : '[]',
      ts
    ).run();
  } catch (e) {
    // Silently fail - checkpointing shouldn't break task operations
    console.error('Auto-checkpoint failed:', e);
  }
}

// ==================
// GOOGLE API HELPERS
// ==================

const GOOGLE_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API_URL = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3';
const GMAIL_API_URL = 'https://gmail.googleapis.com/gmail/v1';
const BLOGGER_API_URL = 'https://www.googleapis.com/blogger/v3';

// GitHub API
const GITHUB_OAUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_URL = 'https://api.github.com';

// OAuth scopes by provider
const OAUTH_SCOPES: Record<string, string> = {
  'google_drive': 'https://www.googleapis.com/auth/drive',
  'gmail_personal': 'https://www.googleapis.com/auth/gmail.modify',
  'gmail_company': 'https://www.googleapis.com/auth/gmail.modify',
  'blogger': 'https://www.googleapis.com/auth/blogger',
  'github': 'repo,read:user',
};

async function getValidToken(env: any, userId: string, provider: string = 'google_drive'): Promise<string | null> {
  const token = await env.DB.prepare(
    'SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?'
  ).bind(userId, provider).first();
  
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
    
    await env.DB.prepare(
      'UPDATE oauth_tokens SET access_token = ?, expires_at = ? WHERE user_id = ? AND provider = ?'
    ).bind(data.access_token, expiresAt, userId, provider).run();
    
    return data.access_token;
  }
  
  return token.access_token;
}

function buildOAuthUrl(env: any, userId: string, provider: string, workerUrl: string): string {
  const scope = OAUTH_SCOPES[provider] || OAUTH_SCOPES['google_drive'];
  const state = userId + ':' + provider; // Encode both user and provider in state
  
  return GOOGLE_OAUTH_URL + '?' + new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: workerUrl + '/oauth/callback',
    response_type: 'code',
    scope: scope,
    access_type: 'offline',
    prompt: 'consent',
    state: state,
  }).toString();
}

async function findOrCreateFolderPath(token: string, path: string): Promise<{ id: string; name: string } | null> {
  const parts = path.split('/').filter(p => p.trim());
  let parentId = 'root';
  let currentFolder = { id: 'root', name: 'My Drive' };
  
  for (const folderName of parts) {
    const query = parentId + ' in parents and name = "' + folderName.replace(/"/g, '\\"') + '" and mimeType = "application/vnd.google-apps.folder" and trashed = false';
    
    const response = await fetch(DRIVE_API_URL + '/files?q=' + encodeURIComponent(query) + '&fields=files(id,name)', {
      headers: { Authorization: 'Bearer ' + token },
    });
    
    if (!response.ok) return null;
    
    const data: any = await response.json();
    
    if (data.files.length > 0) {
      currentFolder = data.files[0];
      parentId = currentFolder.id;
    } else {
      const createResponse = await fetch(DRIVE_API_URL + '/files?fields=id,name', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId],
        }),
      });
      
      if (!createResponse.ok) return null;
      
      currentFolder = await createResponse.json();
      parentId = currentFolder.id;
    }
  }
  
  return currentFolder;
}

// GitHub token helper
async function getGitHubToken(env: any, userId: string): Promise<string | null> {
  const token = await env.DB.prepare(
    'SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?'
  ).bind(userId, 'github').first();
  if (!token) return null;
  return token.access_token;
}

function buildGitHubOAuthUrl(env: any, userId: string, workerUrl: string): string {
  return GITHUB_OAUTH_URL + '?' + new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: workerUrl + '/oauth/callback',
    scope: 'repo read:user',
    state: userId + ':github',
  }).toString();
}

// ==================
// TOOL REGISTRATION
// ==================

function registerTools(server: McpServer, agent: McpAgent, userId: string) {
  const env = agent.env as any;
  const getCurrentUser = () => userId;
  
  // Support multiple teammates via TEAM env var
  const getTeammates = (): string[] => {
    const team = env.TEAM || 'micaiah,irene';
    return team.split(',').map((t: string) => t.trim()).filter((t: string) => t !== userId);
  };
  
  // For backward compatibility - returns first teammate
  const getTeammate = () => getTeammates()[0] || 'unknown';

  server.tool("list_tasks", {
    status: z.enum(["open", "done", "all"]).optional().default("open"),
    category: z.string().optional(),
    project: z.string().optional(),
    include_teammate: z.boolean().optional().default(false),
  }, async ({ status, category, project, include_teammate }) => {
    const env = agent.env as any;
    let query = "SELECT * FROM tasks WHERE 1=1";
    const bindings: any[] = [];
    
    if (!include_teammate) {
      query += " AND user_id = ?";
      bindings.push(getCurrentUser());
    }
    if (status !== "all") {
      query += " AND status = ?";
      bindings.push(status);
    }
    if (category) {
      query += " AND category = ?";
      bindings.push(category);
    }
    if (project) {
      query += " AND project = ?";
      bindings.push(project);
    }
    query += " ORDER BY priority DESC, created_at ASC";
    
    const result = await env.DB.prepare(query).bind(...bindings).all();
    const tasks = result.results.map((t: any) => ({
      ...t,
      days_old: Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86400000),
    }));
    
    if (tasks.length === 0) {
      return { content: [{ type: "text", text: "No tasks found.\n\nðŸ’¬ What have you been working on?" }] };
    }
    
    let output = 'Found ' + tasks.length + ' tasks:\n\n';
    tasks.forEach((t: any) => {
      const p = t.priority >= 4 ? "ðŸ”´" : t.priority === 3 ? "ðŸŸ¡" : "âšª";
      let line = p + ' ' + t.text;
      if (t.category) line += ' [' + t.category + ']';
      if (t.due_date) line += ' (due: ' + t.due_date + ')';
      output += line + '\n   ID: ' + t.id + '\n';
    });
    
    return { content: [{ type: "text", text: output }] };
  });

  server.tool("add_task", {
    text: z.string(),
    priority: z.number().min(1).max(5).optional().default(3),
    due_date: z.string().optional(),
    category: z.string().optional(),
    project: z.string().optional(),
    notes: z.string().optional(),
    for_user: z.string().optional(),
  }, async ({ text, priority, due_date, category, project, notes, for_user }) => {
    const env = agent.env as any;
    const targetUser = normalizeUser(for_user || getCurrentUser());
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    const focusLevel = inferFocusLevel(text);
    
    await env.DB.prepare(
      'INSERT INTO tasks (id, user_id, text, priority, due_date, category, project, status, created_at, last_touched, needs_breakdown, is_vague, focus_level, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, targetUser, text, priority, due_date || null, category || null, project || null, 'open', ts, ts, needsBreakdown(text) ? 1 : 0, isVagueTask(text) ? 1 : 0, focusLevel, notes || null).run();
    
    // Log the event
    await logEvent(env, targetUser, 'created', id, { text, priority, category, focusLevel });
    await updateDailyLog(env, targetUser, 'tasks_created');
    
    // Auto-checkpoint
    await autoCheckpoint(env, targetUser, 'task_added', `Added task: ${text}`, [category || project || 'general'], id);
    
    let resp = 'Added: "' + text + '"';
    if (for_user && normalizeUser(for_user) !== getCurrentUser()) resp += ' (assigned to ' + targetUser + ')';
    if (priority >= 4) resp += " ðŸ”´";
    if (due_date) resp += ' - due ' + due_date;
    
    // Smart suggestions
    if (needsBreakdown(text)) {
      resp += '\n\nðŸ’¡ This looks like a big task. Want to break it down?';
    }
    if (isVagueTask(text)) {
      resp += '\n\nðŸ’­ This seems a bit vague. Can you make it more specific?';
    }
    
    return { content: [{ type: "text", text: resp }] };
  });

  server.tool("complete_task", {
    task_id: z.string().optional(),
    search: z.string().optional(),
  }, async ({ task_id, search }) => {
    const env = agent.env as any;
    let task: any = null;
    
    if (task_id) {
      task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(task_id).first();
    } else if (search) {
      const results = await env.DB.prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND text LIKE ? LIMIT 5"
      ).bind(getCurrentUser(), '%' + search + '%').all();
      
      if (results.results.length === 0) return { content: [{ type: "text", text: 'No task found matching "' + search + '"' }] };
      if (results.results.length === 1) task = results.results[0];
      else {
        let out = 'Multiple matches:\n';
        results.results.forEach((t: any, i: number) => { out += (i+1) + '. ' + t.text + ' (ID: ' + t.id + ')\n'; });
        return { content: [{ type: "text", text: out }] };
      }
    } else {
      return { content: [{ type: "text", text: "Need task_id or search text" }] };
    }
    
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    
    const completedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?").bind(completedAt, task.id).run();
    
    // Check if this task is linked to a launch checklist item
    const checklistItem = await env.DB.prepare(
      "SELECT * FROM launch_checklist WHERE task_id = ?"
    ).bind(task.id).first();
    
    if (checklistItem) {
      await env.DB.prepare(
        "UPDATE launch_checklist SET completed = 1, completed_at = ? WHERE id = ?"
      ).bind(completedAt, checklistItem.id).run();
    }
    
    // Log the event and update daily stats
    const daysToComplete = Math.round((Date.now() - new Date(task.created_at).getTime()) / 86400000);
    await logEvent(env, getCurrentUser(), 'completed', task.id, { 
      text: task.text, 
      daysToComplete,
      focusLevel: task.focus_level,
      category: task.category 
    });
    await updateDailyLog(env, getCurrentUser(), 'tasks_completed');
    
    // Auto-checkpoint
    await autoCheckpoint(env, getCurrentUser(), 'task_completed', `Completed: ${task.text}`, [task.category || task.project || 'general'], task.id);
    
    let resp = '✅ Completed: "' + task.text + '"';
    
    // Encouragement based on patterns
    if (daysToComplete === 0) {
      resp += '\nâš¡ Same-day completion!';
    } else if (daysToComplete <= 1) {
      resp += '\nðŸŽ¯ Quick turnaround!';
    }
    
    if (checklistItem) {
      resp += '\nðŸ“‹ Launch checklist item also marked complete';
    }
    
    return { content: [{ type: "text", text: resp }] };
  });

  server.tool("log_progress", {
    description: z.string(),
    task_id: z.string().optional(),
    minutes_spent: z.number().optional(),
  }, async ({ description, task_id, minutes_spent }) => {
    const env = agent.env as any;
    await env.DB.prepare(
      'INSERT INTO progress_logs (id, user_id, logged_at, task_id, description, minutes_spent, was_planned) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), getCurrentUser(), new Date().toISOString(), task_id || null, description, minutes_spent || null, task_id ? 1 : 0).run();
    
    // Log the event
    await logEvent(env, getCurrentUser(), 'progress', task_id, { description, minutes_spent });
    
    return { content: [{ type: "text", text: 'ðŸ“ Logged: ' + description }] };
  });

  server.tool("get_daily_summary", {}, async () => {
    const env = agent.env as any;
    const today = new Date().toISOString().split('T')[0];
    
    const open = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open'").bind(getCurrentUser()).all();
    const done = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'done' AND DATE(completed_at) = ?").bind(getCurrentUser(), today).first();
    const progress = await env.DB.prepare("SELECT COUNT(*) as c FROM progress_logs WHERE user_id = ? AND DATE(logged_at) = ?").bind(getCurrentUser(), today).first();
    
    // Get patterns and generate nudges
    const patterns = await getPatterns(env, getCurrentUser());
    const nudges = generateNudges(patterns, open.results);
    
    // Find suggested focus task
    const upcoming = open.results.filter((t: any) => t.due_date).sort((a: any, b: any) => 
      new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
    );
    const highPriority = open.results.filter((t: any) => t.priority >= 4);
    const suggestedTask = upcoming[0] || highPriority[0] || open.results[0];
    
    // Check for active launch projects
    const activeLaunch = await env.DB.prepare(
      "SELECT * FROM launch_projects WHERE user_id = ? AND status != 'complete' ORDER BY updated_at DESC LIMIT 1"
    ).bind(getCurrentUser()).first();
    
    let output = 'ðŸ“‹ **Daily Summary - ' + getDayOfWeek().charAt(0).toUpperCase() + getDayOfWeek().slice(1) + '**\n\n';
    output += 'âœ… Completed today: ' + (done?.c || 0) + '\n';
    output += 'ðŸ“ Progress logged: ' + (progress?.c || 0) + ' entries\n';
    output += 'ðŸ“¬ Open tasks: ' + open.results.length + '\n';
    
    if (activeLaunch) {
      const daysToLaunch = activeLaunch.target_launch_date 
        ? Math.ceil((new Date(activeLaunch.target_launch_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null;
      output += `\nðŸš€ **Active Launch:** ${activeLaunch.title}`;
      if (daysToLaunch !== null) output += ` (${daysToLaunch} days)`;
      output += `\n   Phase: ${activeLaunch.current_phase}`;
    }
    
    if (nudges.length > 0) {
      output += '\n\n**ðŸ’¡ Nudges:**\n';
      nudges.forEach(n => { output += n + '\n'; });
    }
    
    if (suggestedTask) {
      output += '\n**Suggested focus:** ' + suggestedTask.text;
      if (suggestedTask.due_date) output += ' (due ' + suggestedTask.due_date + ')';
    }
    
    return { content: [{ type: "text", text: output }] };
  });

  server.tool("analyze_patterns", {}, async () => {
    const env = agent.env as any;
    
    const insights = await analyzeAndStorePatterns(env, getCurrentUser());
    
    if (insights.length === 0) {
      return { content: [{ type: "text", text: "ðŸ“Š Not enough data yet. Keep using the system and check back in a week!" }] };
    }
    
    let output = 'ðŸ“Š **Your Productivity Patterns**\n\n';
    insights.forEach(i => { output += 'â€¢ ' + i + '\n'; });
    
    return { content: [{ type: "text", text: output }] };
  });

  server.tool("get_insights", {}, async () => {
    const env = agent.env as any;
    
    const patterns = await getPatterns(env, getCurrentUser());
    const open = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open'").bind(getCurrentUser()).all();
    
    if (patterns.length === 0) {
      return { content: [{ type: "text", text: "ðŸ’¡ No patterns learned yet. Run analyze_patterns after a week of use!" }] };
    }
    
    let output = 'ðŸ’¡ **Insights**\n\n';
    
    for (const pattern of patterns) {
      const data = JSON.parse(pattern.pattern_data);
      switch (pattern.pattern_type) {
        case 'peak_time':
          output += `â° You're most productive in the ${data.time}\n`;
          break;
        case 'peak_day':
          output += `ðŸ“… ${data.day.charAt(0).toUpperCase() + data.day.slice(1)}s are your power days\n`;
          break;
        case 'avg_completion_days':
          output += `â±ï¸ You complete tasks in ${data.days} days on average\n`;
          break;
        case 'avoidance_category':
          output += `âš ï¸ You tend to delay ${data.category} tasks\n`;
          break;
      }
    }
    
    const nudges = generateNudges(patterns, open.results);
    if (nudges.length > 0) {
      output += '\n**Right now:**\n';
      nudges.forEach(n => { output += n + '\n'; });
    }
    
    return { content: [{ type: "text", text: output }] };
  });

  server.tool("end_of_day_recap", {}, async () => {
    const env = agent.env as any;
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    // Get today's session
    const session = await env.DB.prepare(
      'SELECT * FROM work_sessions WHERE user_id = ? AND session_date = ?'
    ).bind(getCurrentUser(), today).first();
    
    // Get checkpoints
    const checkpoints = await env.DB.prepare(`
      SELECT * FROM checkpoints 
      WHERE user_id = ? AND DATE(checkpoint_time) = ?
      ORDER BY checkpoint_time ASC
    `).bind(getCurrentUser(), today).all();
    
    // Get tasks completed today
    const completed = await env.DB.prepare(`
      SELECT * FROM tasks 
      WHERE user_id = ? AND status = 'done' AND DATE(completed_at) = ?
      ORDER BY completed_at ASC
    `).bind(getCurrentUser(), today).all();
    
    // Get tasks added today
    const added = await env.DB.prepare(`
      SELECT * FROM tasks 
      WHERE user_id = ? AND DATE(created_at) = ?
    `).bind(getCurrentUser(), today).all();
    
    // Get progress logs
    const progressLogs = await env.DB.prepare(`
      SELECT * FROM progress_logs 
      WHERE user_id = ? AND DATE(logged_at) = ?
    `).bind(getCurrentUser(), today).all();
    
    // Get yesterday's stats for comparison
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const yesterdayCompleted = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM tasks 
      WHERE user_id = ? AND status = 'done' AND DATE(completed_at) = ?
    `).bind(getCurrentUser(), yesterday).first();
    
    // Get weekly average
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const weekStats = await env.DB.prepare(`
      SELECT 
        COUNT(*) as total,
        COUNT(DISTINCT DATE(completed_at)) as days
      FROM tasks 
      WHERE user_id = ? AND status = 'done' AND DATE(completed_at) >= ?
    `).bind(getCurrentUser(), weekAgo).first();
    const weeklyAvg = weekStats?.days > 0 ? Math.round(weekStats.total / weekStats.days) : 0;
    
    // Build the recap
    let out = `📊 **End of Day Recap**\n\n`;
    
    // Time tracking (if session exists)
    if (session) {
      const startTime = new Date(session.started_at);
      const endTime = session.ended_at ? new Date(session.ended_at) : now;
      const totalMinutes = Math.round((endTime.getTime() - startTime.getTime()) / (1000 * 60));
      const hours = Math.floor(totalMinutes / 60);
      const mins = totalMinutes % 60;
      
      out += `⏱️ **Time:** ${hours}h ${mins}m`;
      out += ` (${startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      out += session.ended_at ? ` → ${endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})` : ` → now)`;
      out += '\n\n';
    }
    
    // Build narrative from checkpoints
    const nonMorningCheckpoints = (checkpoints.results as any[]).filter(c => 
      c.trigger_type !== 'morning' && c.trigger_type !== 'night'
    );
    
    if (nonMorningCheckpoints.length > 0) {
      out += `**Today's Flow:**\n`;
      const narrative = nonMorningCheckpoints.map((c: any) => c.summary).join(' → ');
      out += narrative + '\n\n';
    }
    
    // Stats section
    out += `**Stats:**\n`;
    out += `• ✅ Completed: ${completed.results.length}`;
    
    // Comparison to yesterday
    if (yesterdayCompleted?.count !== undefined) {
      const diff = completed.results.length - yesterdayCompleted.count;
      if (diff > 0) out += ` (+${diff} vs yesterday)`;
      else if (diff < 0) out += ` (${diff} vs yesterday)`;
    }
    out += '\n';
    
    out += `• ➕ Added: ${added.results.length}\n`;
    out += `• 📍 Checkpoints: ${checkpoints.results.length}\n`;
    
    // Progress time
    if (progressLogs.results.length > 0) {
      const totalLoggedMinutes = (progressLogs.results as any[]).reduce((sum, p) => sum + (p.minutes_spent || 0), 0);
      if (totalLoggedMinutes > 0) {
        out += `• 📝 Logged work: ${Math.round(totalLoggedMinutes / 60)}h ${totalLoggedMinutes % 60}m\n`;
      }
    }
    
    // Net productivity
    const net = completed.results.length - added.results.length;
    if (net > 0) {
      out += `\n📈 **Net: +${net}** — Burned down the list!\n`;
    } else if (net < 0) {
      out += `\n📊 **Net: ${net}** — Expanded scope today\n`;
    } else if (completed.results.length > 0) {
      out += `\n📊 **Net: 0** — Balanced day\n`;
    }
    
    // Weekly context
    if (weeklyAvg > 0) {
      const vsAvg = completed.results.length - weeklyAvg;
      if (vsAvg > 0) {
        out += `Above your weekly average (+${vsAvg})\n`;
      } else if (vsAvg < 0) {
        out += `Below your weekly average (${vsAvg})\n`;
      }
    }
    
    // Collect topics
    const allTopics = new Set<string>();
    for (const c of checkpoints.results as any[]) {
      const topics = JSON.parse(c.topics || '[]');
      topics.forEach((t: string) => {
        if (t !== 'day_start') allTopics.add(t);
      });
    }
    if (allTopics.size > 0) {
      out += `\n**Topics:** ${Array.from(allTopics).join(', ')}\n`;
    }
    
    // Category breakdown from completed tasks
    const categories: Record<string, number> = {};
    for (const t of completed.results as any[]) {
      const cat = t.category || 'Uncategorized';
      categories[cat] = (categories[cat] || 0) + 1;
    }
    if (Object.keys(categories).length > 1) {
      out += `\n**By category:**\n`;
      for (const [cat, count] of Object.entries(categories)) {
        out += `• ${cat}: ${count}\n`;
      }
    }
    
    // Focus level breakdown
    const focusLevels: Record<string, number> = {};
    for (const t of completed.results as any[]) {
      const level = t.focus_level || 'medium';
      focusLevels[level] = (focusLevels[level] || 0) + 1;
    }
    if (completed.results.length > 0) {
      out += `\n**Focus levels completed:**\n`;
      for (const level of ['high', 'medium', 'low']) {
        if (focusLevels[level]) {
          const icon = level === 'high' ? '🔴' : level === 'medium' ? '🟡' : '⚪';
          out += `${icon} ${level}: ${focusLevels[level]}\n`;
        }
      }
    }
    
    // What got done (list)
    if (completed.results.length > 0) {
      out += `\n**Completed:**\n`;
      for (const t of completed.results as any[]) {
        out += `• ${t.text}\n`;
      }
    }
    
    // Discoveries from checkpoints
    const discoveries = (checkpoints.results as any[])
      .filter(c => c.discoveries)
      .map(c => c.discoveries);
    if (discoveries.length > 0) {
      out += `\n**Discoveries:**\n`;
      discoveries.forEach(d => { out += `• ${d}\n`; });
    }
    
    // What's still open and due soon
    const dueSoon = await env.DB.prepare(`
      SELECT * FROM tasks 
      WHERE user_id = ? AND status = 'open' AND due_date IS NOT NULL AND due_date <= date('now', '+3 days')
      ORDER BY due_date ASC
    `).bind(getCurrentUser()).all();
    
    if (dueSoon.results.length > 0) {
      out += `\n**⚠️ Due soon:**\n`;
      for (const t of dueSoon.results.slice(0, 3) as any[]) {
        out += `• ${t.text} (${t.due_date})\n`;
      }
    }
    
    // If no activity at all
    if (completed.results.length === 0 && checkpoints.results.length === 0 && progressLogs.results.length === 0) {
      out = `📊 **End of Day Recap**\n\n`;
      out += `No activity tracked today.\n\n`;
      out += `💡 Start tomorrow with "good morning" to track your work day!`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("weekly_recap", {}, async () => {
    const env = agent.env as any;
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - now.getDay() + 1);
    monday.setHours(0,0,0,0);
    
    const done = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at >= ?").bind(getCurrentUser(), monday.toISOString()).first();
    const added = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND created_at >= ?").bind(getCurrentUser(), monday.toISOString()).first();
    
    // Get daily breakdown
    const dailyStats = await env.DB.prepare(`
      SELECT log_date, tasks_completed, tasks_created 
      FROM daily_logs 
      WHERE user_id = ? AND log_date >= ?
      ORDER BY log_date
    `).bind(getCurrentUser(), monday.toISOString().split('T')[0]).all();
    
    let recap = 'ðŸ“Š Weekly Recap\n\nâœ… Completed: ' + (done?.c || 0) + '\nâž• Added: ' + (added?.c || 0);
    
    if (dailyStats.results.length > 0) {
      recap += '\n\n**By day:**\n';
      dailyStats.results.forEach((d: any) => {
        recap += d.log_date + ': ' + d.tasks_completed + ' done, ' + d.tasks_created + ' added\n';
      });
    }
    
    return { content: [{ type: "text", text: recap }] };
  });

  server.tool("plan_week", {
    focus_level: z.enum(["high", "normal", "low"]).optional().default("normal"),
    constraints: z.string().optional(),
  }, async ({ focus_level, constraints }) => {
    const env = agent.env as any;
    const tasks = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open' ORDER BY priority DESC, due_date ASC").bind(getCurrentUser()).all();
    const patterns = await getPatterns(env, getCurrentUser());
    
    let plan = 'ðŸ“… Week Plan\n\nFocus level: ' + focus_level + '\n';
    if (constraints) plan += 'Constraints: ' + constraints + '\n';
    
    // Get peak day from patterns
    const peakDayPattern = patterns.find(p => p.pattern_type === 'peak_day');
    if (peakDayPattern) {
      const data = JSON.parse(peakDayPattern.pattern_data);
      plan += '\nðŸ’ª Your power day: ' + data.day + '\n';
    }
    
    plan += '\n**Open tasks:** ' + tasks.results.length + '\n';
    
    // Categorize by urgency
    const now = new Date();
    const urgent = tasks.results.filter((t: any) => {
      if (!t.due_date) return t.priority >= 4;
      const daysUntil = (new Date(t.due_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      return daysUntil <= 3;
    });
    
    if (urgent.length > 0) {
      plan += '\nðŸ”´ **Urgent this week:**\n';
      urgent.slice(0, 5).forEach((t: any) => { 
        plan += 'â€¢ ' + t.text;
        if (t.due_date) plan += ' (due ' + t.due_date + ')';
        plan += '\n';
      });
    }
    
    // Check for active launches and surface items
    const activeLaunches = await env.DB.prepare(
      "SELECT * FROM launch_projects WHERE user_id = ? AND status != 'complete'"
    ).bind(getCurrentUser()).all();
    
    if (activeLaunches.results.length > 0) {
      plan += '\nðŸš€ **Active Launches:**\n';
      for (const launch of activeLaunches.results as any[]) {
        const daysToLaunch = launch.target_launch_date
          ? Math.ceil((new Date(launch.target_launch_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          : null;
        plan += `â€¢ ${launch.title} - Phase: ${launch.current_phase}`;
        if (daysToLaunch !== null) plan += ` (${daysToLaunch} days)`;
        plan += '\n';
      }
    }
    
    if (focus_level === 'low') {
      plan += '\nâš ï¸ Low focus week - stick to quick wins and essentials only';
      const quickWins = tasks.results.filter((t: any) => t.focus_level === 'low');
      if (quickWins.length > 0) {
        plan += '\n\n**Quick wins available:**\n';
        quickWins.slice(0, 3).forEach((t: any) => { plan += 'â€¢ ' + t.text + '\n'; });
      }
    }
    
    return { content: [{ type: "text", text: plan }] };
  });

  server.tool("break_down_task", {
    task_id: z.string(),
    subtasks: z.array(z.string()),
  }, async ({ task_id, subtasks }) => {
    const env = agent.env as any;
    const parent = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(task_id).first();
    if (!parent) return { content: [{ type: "text", text: "Task not found" }] };
    
    const ts = new Date().toISOString();
    for (const sub of subtasks) {
      const subId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO tasks (id, user_id, text, priority, category, project, status, created_at, last_touched, parent_task_id, focus_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(subId, parent.user_id, sub, parent.priority, parent.category, parent.project, 'open', ts, ts, task_id, inferFocusLevel(sub)).run();
      
      await logEvent(env, parent.user_id, 'created', subId, { text: sub, parentTask: task_id });
    }
    
    // Mark parent as broken down
    await env.DB.prepare("UPDATE tasks SET needs_breakdown = 0 WHERE id = ?").bind(task_id).run();
    await logEvent(env, parent.user_id, 'broken_down', task_id, { subtaskCount: subtasks.length });
    
    return { content: [{ type: "text", text: 'Broke down into ' + subtasks.length + ' subtasks' }] };
  });

  server.tool("delete_task", { task_id: z.string() }, async ({ task_id }) => {
    const env = agent.env as any;
    const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(task_id).first();
    if (!task) return { content: [{ type: "text", text: "Not found" }] };
    
    await logEvent(env, getCurrentUser(), 'deleted', task_id, { text: task.text });
    await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(task_id).run();
    
    return { content: [{ type: "text", text: 'ðŸ—‘ï¸ Deleted: "' + task.text + '"' }] };
  });

  server.tool("update_task", {
    task_id: z.string(),
    priority: z.number().min(1).max(5).optional(),
    due_date: z.string().optional(),
    category: z.string().optional(),
    notes: z.string().optional(),
  }, async ({ task_id, priority, due_date, category, notes }) => {
    const env = agent.env as any;
    const updates: string[] = [];
    const bindings: any[] = [];
    const changes: any = {};
    
    if (priority !== undefined) { updates.push("priority = ?"); bindings.push(priority); changes.priority = priority; }
    if (due_date !== undefined) { updates.push("due_date = ?"); bindings.push(due_date); changes.due_date = due_date; }
    if (category !== undefined) { updates.push("category = ?"); bindings.push(category); changes.category = category; }
    if (notes !== undefined) { updates.push("notes = ?"); bindings.push(notes); changes.notes = notes; }
    
    if (updates.length === 0) return { content: [{ type: "text", text: "No updates" }] };
    
    updates.push("last_touched = ?");
    bindings.push(new Date().toISOString());
    bindings.push(task_id);
    
    await env.DB.prepare('UPDATE tasks SET ' + updates.join(', ') + ' WHERE id = ?').bind(...bindings).run();
    await logEvent(env, getCurrentUser(), 'updated', task_id, changes);
    
    return { content: [{ type: "text", text: "âœï¸ Updated" }] };
  });

  server.tool("snooze_task", {
    task_id: z.string(),
    until: z.string().optional(),
    days: z.number().optional(),
  }, async ({ task_id, until, days }) => {
    const env = agent.env as any;
    const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(task_id).first();
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    
    let snoozeUntil: string;
    if (until) {
      snoozeUntil = until;
    } else if (days) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      snoozeUntil = d.toISOString().split('T')[0];
    } else {
      // Default: snooze until tomorrow
      const d = new Date();
      d.setDate(d.getDate() + 1);
      snoozeUntil = d.toISOString().split('T')[0];
    }
    
    await env.DB.prepare("UPDATE tasks SET snoozed_until = ?, last_touched = ? WHERE id = ?")
      .bind(snoozeUntil, new Date().toISOString(), task_id).run();
    
    await logEvent(env, getCurrentUser(), 'snoozed', task_id, { until: snoozeUntil });
    
    return { content: [{ type: "text", text: 'ðŸ˜´ Snoozed until ' + snoozeUntil + ': "' + task.text + '"' }] };
  });

  server.tool("get_stats", {}, async () => {
    const env = agent.env as any;
    const total = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ?").bind(getCurrentUser()).first();
    const open = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'open'").bind(getCurrentUser()).first();
    const done = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'done'").bind(getCurrentUser()).first();
    
    // Get 7-day completion stats
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekDone = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at >= ?").bind(getCurrentUser(), weekAgo).first();
    
    let stats = 'ðŸ“Š Stats\n\n';
    stats += 'Total: ' + (total?.c || 0) + '\n';
    stats += 'Open: ' + (open?.c || 0) + '\n';
    stats += 'Done: ' + (done?.c || 0) + '\n';
    stats += '\nLast 7 days: ' + (weekDone?.c || 0) + ' completed';
    
    if (total?.c > 0) {
      const completionRate = Math.round((done?.c || 0) / total.c * 100);
      stats += '\nCompletion rate: ' + completionRate + '%';
    }
    
    return { content: [{ type: "text", text: stats }] };
  });

  server.tool("get_challenges", {}, async () => {
    const env = agent.env as any;
    const cold = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND julianday('now') - julianday(created_at) >= 7").bind(getCurrentUser()).all();
    const vague = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND is_vague = 1").bind(getCurrentUser()).all();
    const needsBreaking = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND needs_breakdown = 1").bind(getCurrentUser()).all();
    
    let out = 'ðŸŽ¯ **Challenges**\n\n';
    
    if (cold.results.length > 0) {
      out += 'â„ï¸ **Cold Tasks** (' + cold.results.length + '):\n';
      cold.results.slice(0, 5).forEach((t: any) => { out += 'â€¢ ' + t.text + '\n'; });
      out += '\n';
    }
    
    if (vague.results.length > 0) {
      out += 'ðŸ’­ **Vague Tasks** (' + vague.results.length + '):\n';
      vague.results.slice(0, 5).forEach((t: any) => { out += 'â€¢ ' + t.text + '\n'; });
      out += '\n';
    }
    
    if (needsBreaking.results.length > 0) {
      out += 'ðŸ”¨ **Needs Breakdown** (' + needsBreaking.results.length + '):\n';
      needsBreaking.results.slice(0, 5).forEach((t: any) => { out += 'â€¢ ' + t.text + '\n'; });
    }
    
    if (cold.results.length === 0 && vague.results.length === 0 && needsBreaking.results.length === 0) {
      out = 'ðŸŽ‰ No challenges right now! Your task list is in good shape.';
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("team_summary", {}, async () => {
    const env = agent.env as any;
    const team = env.TEAM || 'micaiah,irene';
    const members = team.split(',').map((t: string) => t.trim());
    
    let summary = 'ðŸ‘¥ **Untitled Publishers Team**\n\n';
    
    for (const member of members) {
      const stats = await env.DB.prepare(`
        SELECT 
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
          SUM(CASE WHEN status = 'done' AND DATE(completed_at) = DATE('now') THEN 1 ELSE 0 END) as today
        FROM tasks WHERE user_id = ?
      `).bind(member).first();
      
      const isYou = member === getCurrentUser() ? ' (you)' : '';
      summary += `**${member}**${isYou}: ${stats?.open || 0} open, ${stats?.today || 0} done today\n`;
    }
    
    return { content: [{ type: "text", text: summary }] };
  });

  server.tool("view_teammate_tasks", { 
    teammate: z.string().optional().describe("Which teammate to view - leave empty to see all teammates"),
    category: z.string().optional() 
  }, async ({ teammate, category }) => {
    const env = agent.env as any;
    const teammates = teammate ? [teammate] : getTeammates();
    
    if (teammates.length === 0) {
      return { content: [{ type: "text", text: "No teammates found" }] };
    }
    
    let out = '';
    
    for (const tm of teammates) {
      let q = "SELECT * FROM tasks WHERE user_id = ? AND status = 'open'";
      const b: any[] = [tm];
      if (category) { q += " AND category = ?"; b.push(category); }
      q += " ORDER BY priority DESC";
      
      const r = await env.DB.prepare(q).bind(...b).all();
      
      out += `ðŸ“‹ **${tm}'s tasks** (${r.results.length}):\n`;
      if (r.results.length === 0) {
        out += '  No open tasks\n';
      } else {
        r.results.forEach((t: any) => {
          const p = t.priority >= 4 ? 'ðŸ”´' : t.priority === 3 ? 'ðŸŸ¡' : 'âšª';
          out += `  ${p} ${t.text}\n`;
        });
      }
      out += '\n';
    }
    
    return { content: [{ type: "text", text: out.trim() }] };
  });

  server.tool("add_note", { title: z.string(), content: z.string().optional(), category: z.string().optional().default("General") }, async ({ title, content, category }) => {
    const env = agent.env as any;
    await env.DB.prepare('INSERT INTO notes (id, user_id, title, content, category, created_at, archived) VALUES (?, ?, ?, ?, ?, ?, 0)').bind(crypto.randomUUID(), getCurrentUser(), title, content || null, category, new Date().toISOString()).run();
    return { content: [{ type: "text", text: 'ðŸ“ Note saved: "' + title + '"' }] };
  });

  server.tool("add_idea", { title: z.string(), content: z.string().optional(), category: z.enum(["Writing Ideas", "Business Ideas", "Tech Ideas", "Content Ideas", "Unsorted"]).optional().default("Unsorted") }, async ({ title, content, category }) => {
    const env = agent.env as any;
    await env.DB.prepare('INSERT INTO incubation (id, user_id, title, content, category, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), getCurrentUser(), title, content || null, category, new Date().toISOString()).run();
    return { content: [{ type: "text", text: 'ðŸ’¡ Idea: "' + title + '"' }] };
  });

  server.tool("list_ideas", { category: z.string().optional() }, async ({ category }) => {
    const env = agent.env as any;
    let q = "SELECT * FROM incubation WHERE user_id = ?";
    const b: any[] = [getCurrentUser()];
    if (category) { q += " AND category = ?"; b.push(category); }
    const r = await env.DB.prepare(q).bind(...b).all();
    if (r.results.length === 0) return { content: [{ type: "text", text: "No ideas yet" }] };
    let out = 'ðŸ’¡ Ideas:\n';
    r.results.forEach((i: any) => { out += 'â€¢ ' + i.title + '\n'; });
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("suggest_handoff", { 
    task_id: z.string(), 
    to_teammate: z.string().optional().describe("Which teammate to suggest to - defaults to first teammate"),
    reason: z.string().optional() 
  }, async ({ task_id, to_teammate, reason }) => {
    const env = agent.env as any;
    const task = await env.DB.prepare("SELECT text FROM tasks WHERE id = ?").bind(task_id).first();
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    
    const targetTeammate = to_teammate || getTeammate();
    const teammates = getTeammates();
    
    if (!teammates.includes(targetTeammate) && targetTeammate !== getTeammate()) {
      return { content: [{ type: "text", text: `"${targetTeammate}" is not on your team. Teammates: ${teammates.join(', ')}` }] };
    }
    
    await env.DB.prepare('INSERT INTO handoff_suggestions (id, from_user, to_user, task_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), getCurrentUser(), targetTeammate, task_id, reason || null, 'pending', new Date().toISOString()).run();
    return { content: [{ type: "text", text: 'ðŸ“¤ Suggested to ' + targetTeammate + ': "' + task.text + '"' }] };
  });

  server.tool("check_handoffs", {}, async () => {
    const env = agent.env as any;
    const r = await env.DB.prepare("SELECT h.*, t.text as task_text FROM handoff_suggestions h JOIN tasks t ON h.task_id = t.id WHERE h.to_user = ? AND h.status = 'pending'").bind(getCurrentUser()).all();
    if (r.results.length === 0) return { content: [{ type: "text", text: "No pending handoffs" }] };
    let out = 'ðŸ“¥ Handoffs:\n';
    r.results.forEach((s: any) => { out += 'From ' + s.from_user + ': "' + s.task_text + '" (ID: ' + s.task_id + ')\n'; });
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("accept_handoff", { task_id: z.string() }, async ({ task_id }) => {
    const env = agent.env as any;
    await env.DB.prepare("UPDATE tasks SET user_id = ? WHERE id = ?").bind(getCurrentUser(), task_id).run();
    await env.DB.prepare("UPDATE handoff_suggestions SET status = 'accepted' WHERE task_id = ?").bind(task_id).run();
    return { content: [{ type: "text", text: "âœ… Accepted" }] };
  });

  // ==================
  // CONNECTION STATUS
  // ==================
  server.tool("connection_status", {}, async () => {
    const env = agent.env as any;
    const driveToken = await getValidToken(env, getCurrentUser(), 'google_drive');
    const personalEmailToken = await getValidToken(env, getCurrentUser(), 'gmail_personal');
    const companyEmailToken = await getValidToken(env, getCurrentUser(), 'gmail_company');
    const bloggerToken = await getValidToken(env, getCurrentUser(), 'blogger');
    const githubToken = await getGitHubToken(env, getCurrentUser());
    
    let status = 'ðŸ”Œ **Connection Status**\n\n';
    status += driveToken ? 'âœ… Google Drive: Connected\n' : 'âŒ Google Drive: Not connected\n';
    status += personalEmailToken ? 'âœ… Personal Email: Connected\n' : 'âŒ Personal Email: Not connected\n';
    status += companyEmailToken ? 'âœ… Company Email: Connected\n' : 'âŒ Company Email: Not connected\n';
    status += bloggerToken ? 'âœ… Blogger: Connected\n' : 'âŒ Blogger: Not connected\n';
    
    return { content: [{ type: "text", text: status }] };
  });

  server.tool("connect_service", { 
    service: z.enum(['google_drive', 'gmail_personal', 'gmail_company', 'blogger', 'github']).describe("Service to connect")
  }, async ({ service }) => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), service);
    
    if (token) {
      return { content: [{ type: "text", text: `âœ… ${service} is already connected!` }] };
    }
    
    const workerName = env.WORKER_NAME || `productivity-${env.USER_ID === 'micaiah' ? 'mcp-server' : env.USER_ID}`;
    const workerUrl = `https://${workerName}.micaiah-tasks.workers.dev`;
    
    const url = service === 'github' ? buildGitHubOAuthUrl(env, getCurrentUser(), workerUrl) : buildOAuthUrl(env, getCurrentUser(), service, workerUrl);
    
    const serviceNames: Record<string, string> = {
      'google_drive': 'Google Drive',
      'gmail_personal': 'Personal Gmail (private - only you can see)',
      'gmail_company': 'Company Gmail (shared with team)',
      'blogger': 'Blogger',
    };
    
    return { content: [{ type: "text", text: `ðŸ”— Connect ${serviceNames[service]}:\n\n${url}` }] };
  });

  server.tool("disconnect_service", { 
    service: z.enum(['google_drive', 'gmail_personal', 'gmail_company', 'blogger', 'github']).describe("Service to disconnect")
  }, async ({ service }) => {
    const env = agent.env as any;
    const userId = getCurrentUser();
    
    // Check if connected first
    const token = await getValidToken(env, userId, service);
    
    if (!token) {
      return { content: [{ type: "text", text: `âš ï¸ ${service} is not connected.` }] };
    }
    
    // Delete the token
    await env.DB.prepare(
      'DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?'
    ).bind(userId, service).run();
    
    const serviceNames: Record<string, string> = {
      'google_drive': 'Google Drive',
      'gmail_personal': 'Personal Gmail',
      'gmail_company': 'Company Gmail',
      'blogger': 'Blogger',
    };
    
    return { content: [{ type: "text", text: `ðŸ”Œ Disconnected ${serviceNames[service]}.\n\nTo reconnect with a different account, run:\n\`connect_service ${service}\`\n\n**Tip:** Open the OAuth link in an incognito window to ensure you sign in with the correct account.` }] };
  });


  // ==================
  // GITHUB TOOLS
  // ==================
  
  server.tool("github_status", {}, async () => {
    const env = agent.env as any;
    const token = await getGitHubToken(env, getCurrentUser());
    if (!token) {
      const workerName = env.WORKER_NAME || `productivity-${env.USER_ID === 'micaiah' ? 'mcp-server' : env.USER_ID}`;
      const workerUrl = `https://${workerName}.micaiah-tasks.workers.dev`;
      const url = buildGitHubOAuthUrl(env, getCurrentUser(), workerUrl);
      return { content: [{ type: "text", text: "GitHub not connected. Connect here:\n" + url }] };
    }
    const resp = await fetch(GITHUB_API_URL + "/user", {
      headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json" }
    });
    if (!resp.ok) return { content: [{ type: "text", text: "GitHub token invalid. Please reconnect." }] };
    const user: any = await resp.json();
    return { content: [{ type: "text", text: "GitHub connected as " + user.login + "\nProfile: " + user.html_url }] };
  });

  server.tool("github_list_repos", { visibility: z.enum(["all", "public", "private"]).optional().default("all") }, async ({ visibility }) => {
    const env = agent.env as any;
    const token = await getGitHubToken(env, getCurrentUser());
    if (!token) return { content: [{ type: "text", text: "GitHub not connected. Run: connect_service github" }] };
    const resp = await fetch(GITHUB_API_URL + "/user/repos?visibility=" + visibility + "&sort=updated&per_page=20", {
      headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json" }
    });
    if (!resp.ok) return { content: [{ type: "text", text: "Error fetching repos" }] };
    const repos: any[] = await resp.json();
    if (repos.length === 0) return { content: [{ type: "text", text: "No repositories found" }] };
    let out = "Your Repositories:\n\n";
    repos.forEach((repo: any) => { out += (repo.private ? "[private] " : "[public] ") + repo.name + "\n  " + repo.html_url + "\n\n"; });
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("github_push_file", {
    repo: z.string().describe("Repository name"),
    path: z.string().describe("File path in repo"),
    content: z.string().describe("File content"),
    message: z.string().optional().default("Update via MCP"),
    branch: z.string().optional().default("main"),
  }, async ({ repo, path, content, message, branch }) => {
    const env = agent.env as any;
    const token = await getGitHubToken(env, getCurrentUser());
    if (!token) return { content: [{ type: "text", text: "GitHub not connected" }] };
    let fullRepo = repo;
    if (!repo.includes("/")) {
      const userResp = await fetch(GITHUB_API_URL + "/user", { headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP" } });
      const user: any = await userResp.json();
      fullRepo = user.login + "/" + repo;
    }
    let sha: string | undefined;
    const existingResp = await fetch(GITHUB_API_URL + "/repos/" + fullRepo + "/contents/" + path + "?ref=" + branch, {
      headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json" }
    });
    if (existingResp.ok) { const existing: any = await existingResp.json(); sha = existing.sha; }
    const encodedContent = btoa(unescape(encodeURIComponent(content)));
    const body: any = { message, content: encodedContent, branch };
    if (sha) body.sha = sha;
    const resp = await fetch(GITHUB_API_URL + "/repos/" + fullRepo + "/contents/" + path, {
      method: "PUT",
      headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!resp.ok) { const error = await resp.text(); return { content: [{ type: "text", text: "Error: " + error }] }; }
    const result: any = await resp.json();
    return { content: [{ type: "text", text: (sha ? "Updated" : "Created") + ": " + path + "\n" + result.content.html_url }] };
  });

  server.tool("github_push_files", {
    repo: z.string(),
    files: z.array(z.object({ path: z.string(), content: z.string() })),
    message: z.string().optional().default("Update via MCP"),
    branch: z.string().optional().default("main"),
  }, async ({ repo, files, message, branch }) => {
    const env = agent.env as any;
    const token = await getGitHubToken(env, getCurrentUser());
    if (!token) return { content: [{ type: "text", text: "GitHub not connected" }] };
    let fullRepo = repo;
    if (!repo.includes("/")) {
      const userResp = await fetch(GITHUB_API_URL + "/user", { headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP" } });
      const user: any = await userResp.json();
      fullRepo = user.login + "/" + repo;
    }
    const results: string[] = [];
    for (const file of files) {
      let sha: string | undefined;
      const existingResp = await fetch(GITHUB_API_URL + "/repos/" + fullRepo + "/contents/" + file.path + "?ref=" + branch, {
        headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json" }
      });
      if (existingResp.ok) { const existing: any = await existingResp.json(); sha = existing.sha; }
      const encodedContent = btoa(unescape(encodeURIComponent(file.content)));
      const body: any = { message: message + " - " + file.path, content: encodedContent, branch };
      if (sha) body.sha = sha;
      const resp = await fetch(GITHUB_API_URL + "/repos/" + fullRepo + "/contents/" + file.path, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      results.push(resp.ok ? "[OK] " + file.path : "[FAIL] " + file.path);
    }
    return { content: [{ type: "text", text: "Push Results:\n" + results.join("\n") + "\n\nhttps://github.com/" + fullRepo }] };
  });

  server.tool("github_enable_pages", {
    repo: z.string(),
    branch: z.string().optional().default("main"),
  }, async ({ repo, branch }) => {
    const env = agent.env as any;
    const token = await getGitHubToken(env, getCurrentUser());
    if (!token) return { content: [{ type: "text", text: "GitHub not connected" }] };
    let fullRepo = repo;
    if (!repo.includes("/")) {
      const userResp = await fetch(GITHUB_API_URL + "/user", { headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP" } });
      const user: any = await userResp.json();
      fullRepo = user.login + "/" + repo;
    }
    const resp = await fetch(GITHUB_API_URL + "/repos/" + fullRepo + "/pages", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
      body: JSON.stringify({ source: { branch, path: "/" } })
    });
    if (!resp.ok) {
      const error = await resp.text();
      if (error.includes("already")) return { content: [{ type: "text", text: "GitHub Pages already enabled" }] };
      return { content: [{ type: "text", text: "Error: " + error }] };
    }
    const parts = fullRepo.split("/");
    return { content: [{ type: "text", text: "GitHub Pages enabled!\n\nSite: https://" + parts[0] + ".github.io/" + parts[1] }] };
  });

  // Keep drive_status for backward compatibility
  server.tool("drive_status", {}, async () => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) {
      const workerName = env.WORKER_NAME || `productivity-${env.USER_ID === 'micaiah' ? 'mcp-server' : env.USER_ID}`;
      const workerUrl = `https://${workerName}.micaiah-tasks.workers.dev`;
      const url = buildOAuthUrl(env, getCurrentUser(), 'google_drive', workerUrl);
      return { content: [{ type: "text", text: 'ðŸ”— Not connected. Click:\n' + url }] };
    }
    return { content: [{ type: "text", text: "âœ… Google Drive connected" }] };
  });

  server.tool("list_drive_folders", { parent_id: z.string().optional() }, async ({ parent_id }) => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) return { content: [{ type: "text", text: "âŒ Not connected. Run: connect_service google_drive" }] };
    const q = parent_id ? "'" + parent_id + "' in parents" : "'root' in parents";
    const resp = await fetch(DRIVE_API_URL + '/files?q=' + encodeURIComponent(q + " and mimeType = 'application/vnd.google-apps.folder' and trashed = false") + '&fields=files(id,name)', { headers: { Authorization: 'Bearer ' + token } });
    const data: any = await resp.json();
    if (!data.files?.length) return { content: [{ type: "text", text: "No folders" }] };
    let out = 'ðŸ“ Folders:\n';
    data.files.forEach((f: any) => { out += 'â€¢ ' + f.name + ' (ID: ' + f.id + ')\n'; });
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("save_to_drive", { filename: z.string(), content: z.string(), folder_id: z.string().optional(), folder_path: z.string().optional() }, async ({ filename, content, folder_id, folder_path }) => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) return { content: [{ type: "text", text: "âŒ Not connected. Run: connect_service google_drive" }] };
    
    let targetId = folder_id;
    if (!targetId && folder_path) {
      const folder = await findOrCreateFolderPath(token, folder_path);
      if (folder) targetId = folder.id;
    }
    
    const ext = filename.split('.').pop()?.toLowerCase() || 'txt';
    const mimeTypes: Record<string,string> = { txt: 'text/plain', md: 'text/markdown', html: 'text/html', json: 'application/json' };
    const mime = mimeTypes[ext] || 'text/plain';
    
    const meta: any = { name: filename, mimeType: mime };
    if (targetId) meta.parents = [targetId];
    
    const boundary = '---b';
    const body = '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n' + content + '\r\n--' + boundary + '--';
    
    const resp = await fetch(DRIVE_UPLOAD_URL + '/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: body
    });
    
    if (!resp.ok) return { content: [{ type: "text", text: "âŒ Error" }] };
    const file: any = await resp.json();
    return { content: [{ type: "text", text: 'âœ… Saved: ' + file.name + '\n' + file.webViewLink }] };
  });

  server.tool("who_am_i", {}, async () => {
    const teammates = getTeammates();
    return { content: [{ type: "text", text: `You are: ${getCurrentUser()}\nTeammates: ${teammates.join(', ')}` }] };
  });

  server.tool("search_drive", { query: z.string() }, async ({ query }) => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) return { content: [{ type: "text", text: "âŒ Not connected. Run: connect_service google_drive" }] };
    const resp = await fetch(DRIVE_API_URL + '/files?q=' + encodeURIComponent("name contains '" + query + "' and trashed = false") + '&fields=files(id,name,webViewLink)&pageSize=10', { headers: { Authorization: 'Bearer ' + token } });
    const data: any = await resp.json();
    if (!data.files?.length) return { content: [{ type: "text", text: 'No results for "' + query + '"' }] };
    let out = 'ðŸ” Results:\n';
    data.files.forEach((f: any) => { out += 'â€¢ ' + f.name + '\n  ' + f.webViewLink + '\n'; });
    return { content: [{ type: "text", text: out }] };
  });

  // ==================
  // EMAIL TOOLS
  // ==================
  server.tool("check_inbox", {
    account: z.enum(['personal', 'company']).describe("Which email account to check"),
    max_results: z.number().optional().default(10),
  }, async ({ account, max_results }) => {
    const env = agent.env as any;
    const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
    const token = await getValidToken(env, getCurrentUser(), provider);
    
    if (!token) {
      return { content: [{ type: "text", text: `âŒ ${account} email not connected. Run: connect_service ${provider}` }] };
    }
    
    const resp = await fetch(`${GMAIL_API_URL}/users/me/messages?maxResults=${max_results}&q=is:unread`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "âŒ Error fetching emails" }] };
    }
    
    const data: any = await resp.json();
    
    if (!data.messages?.length) {
      return { content: [{ type: "text", text: `ðŸ“­ No unread emails in ${account} inbox` }] };
    }
    
    let out = `ðŸ“¬ **${account.charAt(0).toUpperCase() + account.slice(1)} Inbox** (${data.messages.length} unread):\n\n`;
    
    // Fetch details for each message
    for (const msg of data.messages.slice(0, max_results)) {
      const msgResp = await fetch(`${GMAIL_API_URL}/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, {
        headers: { Authorization: 'Bearer ' + token }
      });
      
      if (msgResp.ok) {
        const msgData: any = await msgResp.json();
        const headers = msgData.payload?.headers || [];
        const from = headers.find((h: any) => h.name === 'From')?.value || 'Unknown';
        const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)';
        out += `â€¢ **${subject}**\n  From: ${from}\n  ID: ${msg.id}\n\n`;
      }
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("read_email", {
    account: z.enum(['personal', 'company']),
    message_id: z.string().describe("Email message ID"),
  }, async ({ account, message_id }) => {
    const env = agent.env as any;
    const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
    const token = await getValidToken(env, getCurrentUser(), provider);
    
    if (!token) {
      return { content: [{ type: "text", text: `âŒ ${account} email not connected` }] };
    }
    
    const resp = await fetch(`${GMAIL_API_URL}/users/me/messages/${message_id}?format=full`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "âŒ Error fetching email" }] };
    }
    
    const data: any = await resp.json();
    const headers = data.payload?.headers || [];
    const from = headers.find((h: any) => h.name === 'From')?.value || 'Unknown';
    const to = headers.find((h: any) => h.name === 'To')?.value || 'Unknown';
    const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)';
    const date = headers.find((h: any) => h.name === 'Date')?.value || '';
    
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
    
    let out = `ðŸ“§ **${subject}**\n\n`;
    out += `From: ${from}\n`;
    out += `To: ${to}\n`;
    out += `Date: ${date}\n\n`;
    out += `---\n\n${body.slice(0, 2000)}`;
    if (body.length > 2000) out += '\n\n... (truncated)';
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("search_email", {
    account: z.enum(['personal', 'company']),
    query: z.string().describe("Search query (Gmail search syntax)"),
    max_results: z.number().optional().default(10),
  }, async ({ account, query, max_results }) => {
    const env = agent.env as any;
    const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
    const token = await getValidToken(env, getCurrentUser(), provider);
    
    if (!token) {
      return { content: [{ type: "text", text: `âŒ ${account} email not connected` }] };
    }
    
    const resp = await fetch(`${GMAIL_API_URL}/users/me/messages?maxResults=${max_results}&q=${encodeURIComponent(query)}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "âŒ Error searching emails" }] };
    }
    
    const data: any = await resp.json();
    
    if (!data.messages?.length) {
      return { content: [{ type: "text", text: `No emails found for "${query}"` }] };
    }
    
    let out = `ðŸ” **Search results for "${query}"** (${data.messages.length}):\n\n`;
    
    for (const msg of data.messages.slice(0, max_results)) {
      const msgResp = await fetch(`${GMAIL_API_URL}/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
        headers: { Authorization: 'Bearer ' + token }
      });
      
      if (msgResp.ok) {
        const msgData: any = await msgResp.json();
        const headers = msgData.payload?.headers || [];
        const from = headers.find((h: any) => h.name === 'From')?.value || 'Unknown';
        const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)';
        out += `â€¢ **${subject}**\n  From: ${from}\n  ID: ${msg.id}\n\n`;
      }
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("send_email", {
    account: z.enum(['personal', 'company']),
    to: z.string().describe("Recipient email address"),
    subject: z.string(),
    body: z.string(),
  }, async ({ account, to, subject, body }) => {
    const env = agent.env as any;
    const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
    const token = await getValidToken(env, getCurrentUser(), provider);
    
    if (!token) {
      return { content: [{ type: "text", text: `âŒ ${account} email not connected` }] };
    }
    
    // Build the email
    const email = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body
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
      return { content: [{ type: "text", text: `âŒ Error sending email: ${error}` }] };
    }
    
    return { content: [{ type: "text", text: `âœ… Email sent to ${to}` }] };
  });

  server.tool("email_to_task", {
    account: z.enum(['personal', 'company']),
    message_id: z.string(),
    priority: z.number().min(1).max(5).optional().default(3),
  }, async ({ account, message_id, priority }) => {
    const env = agent.env as any;
    const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
    const token = await getValidToken(env, getCurrentUser(), provider);
    
    if (!token) {
      return { content: [{ type: "text", text: `âŒ ${account} email not connected` }] };
    }
    
    // Fetch the email
    const resp = await fetch(`${GMAIL_API_URL}/users/me/messages/${message_id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "âŒ Error fetching email" }] };
    }
    
    const data: any = await resp.json();
    const headers = data.payload?.headers || [];
    const from = headers.find((h: any) => h.name === 'From')?.value || 'Unknown';
    const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)';
    
    // Create task
    const taskId = crypto.randomUUID();
    const ts = new Date().toISOString();
    const taskText = `Reply to: ${subject}`;
    const notes = `From: ${from}\nEmail ID: ${message_id}\nAccount: ${account}`;
    
    await env.DB.prepare(
      'INSERT INTO tasks (id, user_id, text, priority, category, status, created_at, last_touched, notes, focus_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(taskId, getCurrentUser(), taskText, priority, 'Email', 'open', ts, ts, notes, 'low').run();
    
    await logEvent(env, getCurrentUser(), 'created', taskId, { text: taskText, source: 'email', priority });
    await updateDailyLog(env, getCurrentUser(), 'tasks_created');
    
    return { content: [{ type: "text", text: `âœ… Created task: "${taskText}"\n\nFrom: ${from}` }] };
  });

  // ==================
  // BLOGGER TOOLS
  // ==================
  server.tool("list_blogs", {}, async () => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), 'blogger');
    
    if (!token) {
      return { content: [{ type: "text", text: "âŒ Blogger not connected. Run: connect_service blogger" }] };
    }
    
    const resp = await fetch(`${BLOGGER_API_URL}/users/self/blogs`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "âŒ Error fetching blogs" }] };
    }
    
    const data: any = await resp.json();
    
    if (!data.items?.length) {
      return { content: [{ type: "text", text: "ðŸ“ No blogs found. Create one at blogger.com first." }] };
    }
    
    let out = 'ðŸ“ **Your Blogs**\n\n';
    data.items.forEach((blog: any) => {
      out += `â€¢ **${blog.name}**\n  ID: ${blog.id}\n  URL: ${blog.url}\n  Posts: ${blog.posts?.totalItems || 0}\n\n`;
    });
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("list_blog_posts", {
    blog_id: z.string().describe("Blog ID from list_blogs"),
    status: z.enum(['live', 'draft', 'scheduled']).optional().default('live'),
    max_results: z.number().optional().default(10),
  }, async ({ blog_id, status, max_results }) => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), 'blogger');
    
    if (!token) {
      return { content: [{ type: "text", text: "âŒ Blogger not connected" }] };
    }
    
    const endpoint = status === 'live' 
      ? `${BLOGGER_API_URL}/blogs/${blog_id}/posts?maxResults=${max_results}`
      : `${BLOGGER_API_URL}/blogs/${blog_id}/posts?status=${status}&maxResults=${max_results}`;
    
    const resp = await fetch(endpoint, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "âŒ Error fetching posts" }] };
    }
    
    const data: any = await resp.json();
    
    if (!data.items?.length) {
      return { content: [{ type: "text", text: `No ${status} posts found` }] };
    }
    
    let out = `ðŸ“„ **${status.charAt(0).toUpperCase() + status.slice(1)} Posts** (${data.items.length}):\n\n`;
    data.items.forEach((post: any) => {
      const date = new Date(post.published || post.updated).toLocaleDateString();
      out += `â€¢ **${post.title}**\n  ID: ${post.id}\n  Date: ${date}\n  URL: ${post.url || 'draft'}\n\n`;
    });
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("get_blog_post", {
    blog_id: z.string(),
    post_id: z.string(),
  }, async ({ blog_id, post_id }) => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), 'blogger');
    
    if (!token) {
      return { content: [{ type: "text", text: "âŒ Blogger not connected" }] };
    }
    
    const resp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/posts/${post_id}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "âŒ Error fetching post" }] };
    }
    
    const post: any = await resp.json();
    
    let out = `ðŸ“„ **${post.title}**\n\n`;
    out += `Status: ${post.status || 'live'}\n`;
    out += `Published: ${post.published || 'not yet'}\n`;
    out += `URL: ${post.url || 'draft'}\n`;
    out += `Labels: ${post.labels?.join(', ') || 'none'}\n\n`;
    out += `---\n\n${post.content?.slice(0, 3000) || '(empty)'}`;
    if (post.content?.length > 3000) out += '\n\n... (truncated)';
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("create_blog_post", {
    blog_id: z.string().describe("Blog ID from list_blogs"),
    title: z.string(),
    content: z.string().describe("HTML content of the post"),
    labels: z.array(z.string()).optional().describe("Tags/categories"),
    is_draft: z.boolean().optional().default(true).describe("Save as draft (true) or publish immediately (false)"),
  }, async ({ blog_id, title, content, labels, is_draft }) => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), 'blogger');
    
    if (!token) {
      return { content: [{ type: "text", text: "âŒ Blogger not connected" }] };
    }
    
    const postData: any = { title, content };
    if (labels?.length) postData.labels = labels;
    
    const endpoint = is_draft
      ? `${BLOGGER_API_URL}/blogs/${blog_id}/posts?isDraft=true`
      : `${BLOGGER_API_URL}/blogs/${blog_id}/posts`;
    
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(postData)
    });
    
    if (!resp.ok) {
      const error = await resp.text();
      return { content: [{ type: "text", text: `âŒ Error creating post: ${error}` }] };
    }
    
    const post: any = await resp.json();
    
    const status = is_draft ? 'Draft saved' : 'Published';
    return { content: [{ type: "text", text: `âœ… ${status}: "${post.title}"\n\nPost ID: ${post.id}\nURL: ${post.url || 'will be available after publishing'}` }] };
  });

  server.tool("update_blog_post", {
    blog_id: z.string(),
    post_id: z.string(),
    title: z.string().optional(),
    content: z.string().optional().describe("HTML content"),
    labels: z.array(z.string()).optional(),
  }, async ({ blog_id, post_id, title, content, labels }) => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), 'blogger');
    
    if (!token) {
      return { content: [{ type: "text", text: "âŒ Blogger not connected" }] };
    }
    
    // First get the existing post
    const getResp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/posts/${post_id}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!getResp.ok) {
      return { content: [{ type: "text", text: "âŒ Post not found" }] };
    }
    
    const existing: any = await getResp.json();
    
    // Merge updates
    const postData: any = {
      title: title || existing.title,
      content: content || existing.content,
    };
    if (labels) postData.labels = labels;
    
    const resp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/posts/${post_id}`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(postData)
    });
    
    if (!resp.ok) {
      const error = await resp.text();
      return { content: [{ type: "text", text: `âŒ Error updating post: ${error}` }] };
    }
    
    const post: any = await resp.json();
    return { content: [{ type: "text", text: `âœ… Updated: "${post.title}"\n\nURL: ${post.url}` }] };
  });

  server.tool("publish_blog_post", {
    blog_id: z.string(),
    post_id: z.string(),
  }, async ({ blog_id, post_id }) => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), 'blogger');
    
    if (!token) {
      return { content: [{ type: "text", text: "âŒ Blogger not connected" }] };
    }
    
    const resp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/posts/${post_id}/publish`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      const error = await resp.text();
      return { content: [{ type: "text", text: `âŒ Error publishing: ${error}` }] };
    }
    
    const post: any = await resp.json();
    return { content: [{ type: "text", text: `âœ… Published: "${post.title}"\n\nLive at: ${post.url}` }] };
  });

  server.tool("delete_blog_post", {
    blog_id: z.string(),
    post_id: z.string(),
  }, async ({ blog_id, post_id }) => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), 'blogger');
    
    if (!token) {
      return { content: [{ type: "text", text: "âŒ Blogger not connected" }] };
    }
    
    const resp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/posts/${post_id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      const error = await resp.text();
      return { content: [{ type: "text", text: `âŒ Error deleting: ${error}` }] };
    }
    
    return { content: [{ type: "text", text: `âœ… Post deleted` }] };
  });

  server.tool("get_blog_stats", {
    blog_id: z.string().describe("Blog ID from list_blogs"),
    range: z.enum(['7DAYS', '30DAYS', 'ALL']).optional().default('30DAYS'),
  }, async ({ blog_id, range }) => {
    const env = agent.env as any;
    const token = await getValidToken(env, getCurrentUser(), 'blogger');
    
    if (!token) {
      return { content: [{ type: "text", text: "âŒ Blogger not connected" }] };
    }
    
    // Get blog info
    const blogResp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!blogResp.ok) {
      return { content: [{ type: "text", text: "âŒ Blog not found" }] };
    }
    
    const blog: any = await blogResp.json();
    
    // Get pageviews
    const statsResp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/pageviews?range=${range}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    let pageviews = 'N/A';
    if (statsResp.ok) {
      const statsData: any = await statsResp.json();
      if (statsData.counts?.length) {
        const total = statsData.counts.reduce((sum: number, c: any) => sum + parseInt(c.count || 0), 0);
        pageviews = total.toLocaleString();
      }
    }
    
    // Get recent posts for top performers
    const postsResp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/posts?maxResults=10&fetchBodies=false`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    let recentPosts = '';
    if (postsResp.ok) {
      const postsData: any = await postsResp.json();
      if (postsData.items?.length) {
        recentPosts = '\n**Recent Posts:**\n';
        postsData.items.slice(0, 5).forEach((post: any) => {
          const date = new Date(post.published).toLocaleDateString();
          recentPosts += `â€¢ ${post.title} (${date})\n`;
        });
      }
    }
    
    const rangeLabel = range === '7DAYS' ? 'Last 7 days' : range === '30DAYS' ? 'Last 30 days' : 'All time';
    
    let out = `ðŸ“Š **${blog.name} Stats**\n\n`;
    out += `**Overview:**\n`;
    out += `â€¢ Total Posts: ${blog.posts?.totalItems || 0}\n`;
    out += `â€¢ Total Pages: ${blog.pages?.totalItems || 0}\n`;
    out += `â€¢ Page Views (${rangeLabel}): ${pageviews}\n`;
    out += `â€¢ URL: ${blog.url}\n`;
    out += recentPosts;
    
    return { content: [{ type: "text", text: out }] };
  });

  // ==================
  // LAUNCH DOCS TOOLS
  // ==================

  // --- DOCUMENT MANAGEMENT ---
  
  server.tool("add_launch_doc", {
    name: z.string(),
    doc_type: z.enum(['engine', 'playbook', 'operations']),
    description: z.string().optional(),
    content: z.string().describe("Markdown content with phases and checklist items"),
  }, async ({ name, doc_type, description, content }) => {
    const env = agent.env as any;
    const { phases, items } = parseLaunchDocument(content);
    
    if (phases.length === 0) {
      return { content: [{ type: "text", text: "âŒ No phases found. Use # PHASE 1: NAME format." }] };
    }
    
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    
    await env.DB.prepare(
      'INSERT INTO launch_docs (id, name, doc_type, description, content, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, name, doc_type, description || null, content, '1.0', ts, ts).run();
    
    return { content: [{ type: "text", text: `âœ… Created: ${name}\n\nType: ${doc_type}\nPhases: ${phases.join(' â†’ ')}\nChecklist items: ${items.length}\nDoc ID: ${id}` }] };
  });

  server.tool("list_launch_docs", {
    doc_type: z.enum(['engine', 'playbook', 'operations']).optional(),
  }, async ({ doc_type }) => {
    const env = agent.env as any;
    let query = 'SELECT id, name, doc_type, description, version, updated_at FROM launch_docs';
    const params: any[] = [];
    
    if (doc_type) {
      query += ' WHERE doc_type = ?';
      params.push(doc_type);
    }
    query += ' ORDER BY name';
    
    const r = await env.DB.prepare(query).bind(...params).all();
    
    if (r.results.length === 0) {
      return { content: [{ type: "text", text: "ðŸ“„ No launch documents found" }] };
    }
    
    let out = 'ðŸ“„ **Launch Documents**\n\n';
    r.results.forEach((doc: any) => {
      out += `â€¢ **${doc.name}** (${doc.doc_type})\n  ID: ${doc.id}\n  v${doc.version} | Updated: ${doc.updated_at.split('T')[0]}\n\n`;
    });
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("view_launch_doc", {
    doc_id: z.string().optional(),
    name: z.string().optional(),
  }, async ({ doc_id, name }) => {
    const env = agent.env as any;
    
    let doc;
    if (doc_id) {
      doc = await env.DB.prepare('SELECT * FROM launch_docs WHERE id = ?').bind(doc_id).first();
    } else if (name) {
      doc = await env.DB.prepare('SELECT * FROM launch_docs WHERE name LIKE ?').bind('%' + name + '%').first();
    }
    
    if (!doc) {
      return { content: [{ type: "text", text: "âŒ Document not found" }] };
    }
    
    const { phases, items } = parseLaunchDocument(doc.content);
    
    let out = `ðŸ“„ **${doc.name}**\n\n`;
    out += `Type: ${doc.doc_type} | Version: ${doc.version}\n`;
    out += `Phases: ${phases.join(' â†’ ')}\n`;
    out += `Items: ${items.length}\n\n`;
    out += `---\n\n${doc.content.slice(0, 5000)}`;
    if (doc.content.length > 5000) out += '\n\n... (truncated)';
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("update_launch_doc", {
    doc_id: z.string(),
    content: z.string(),
    version: z.string().optional(),
  }, async ({ doc_id, content, version }) => {
    const env = agent.env as any;
    
    const existing = await env.DB.prepare('SELECT * FROM launch_docs WHERE id = ?').bind(doc_id).first();
    if (!existing) {
      return { content: [{ type: "text", text: "âŒ Document not found" }] };
    }
    
    const { phases, items } = parseLaunchDocument(content);
    const newVersion = version || (parseFloat(existing.version) + 0.1).toFixed(1);
    const ts = new Date().toISOString();
    
    await env.DB.prepare(
      'UPDATE launch_docs SET content = ?, version = ?, updated_at = ? WHERE id = ?'
    ).bind(content, newVersion, ts, doc_id).run();
    
    return { content: [{ type: "text", text: `âœ… Updated: ${existing.name}\n\nVersion: ${newVersion}\nPhases: ${phases.join(' â†’ ')}\nItems: ${items.length}` }] };
  });

  // --- PROJECT MANAGEMENT ---

  server.tool("create_launch", {
    title: z.string(),
    launch_doc_ids: z.array(z.string()).describe("Array of document IDs to use"),
    target_launch_date: z.string().optional().describe("YYYY-MM-DD format"),
    genre: z.string().optional(),
    shared: z.boolean().optional().default(false),
  }, async ({ title, launch_doc_ids, target_launch_date, genre, shared }) => {
    const env = agent.env as any;
    const projectId = crypto.randomUUID();
    const ts = new Date().toISOString();
    
    // Validate documents exist
    const docs: any[] = [];
    for (const docId of launch_doc_ids) {
      const doc = await env.DB.prepare('SELECT * FROM launch_docs WHERE id = ?').bind(docId).first();
      if (!doc) {
        return { content: [{ type: "text", text: `âŒ Document not found: ${docId}` }] };
      }
      docs.push(doc);
    }
    
    // Parse all documents and collect items
    let allItems: any[] = [];
    let allPhases: string[] = [];
    
    for (const doc of docs) {
      const { phases, items } = parseLaunchDocument(doc.content);
      
      // Add doc_id to each item
      const itemsWithDoc = items.map(item => ({
        ...item,
        doc_id: doc.id,
      }));
      
      allItems = allItems.concat(itemsWithDoc);
      phases.forEach(p => {
        if (!allPhases.includes(p)) allPhases.push(p);
      });
    }
    
    // Re-sort items by phase order then original sort_order
    const phaseOrder: Record<string, number> = {};
    allPhases.forEach((p, i) => phaseOrder[p] = i);
    allItems.sort((a, b) => {
      const phaseDiff = (phaseOrder[a.phase] || 0) - (phaseOrder[b.phase] || 0);
      if (phaseDiff !== 0) return phaseDiff;
      return a.sort_order - b.sort_order;
    });
    
    // Create project
    await env.DB.prepare(
      'INSERT INTO launch_projects (id, user_id, title, genre, launch_doc_ids, target_launch_date, status, current_phase, shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      projectId, getCurrentUser(), title, genre || null, 
      JSON.stringify(launch_doc_ids), target_launch_date || null,
      'setup', allPhases[0] || 'Setup', shared ? 1 : 0, ts, ts
    ).run();
    
    // Insert all checklist items
    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];
      await env.DB.prepare(
        'INSERT INTO launch_checklist (id, project_id, doc_id, phase, section, item_text, sort_order, tags, due_offset, is_recurring, completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)'
      ).bind(
        crypto.randomUUID(), projectId, item.doc_id,
        item.phase, item.section || null, item.item_text, i,
        JSON.stringify(item.tags), item.due_offset, item.is_recurring
      ).run();
    }
    
    let out = `âœ… Created launch: **${title}**\n\n`;
    out += `Documents: ${docs.map(d => d.name).join(', ')}\n`;
    out += `Total checklist items: ${allItems.length}\n`;
    out += `Phases: ${allPhases.join(' â†’ ')}\n`;
    if (target_launch_date) {
      const days = Math.ceil((new Date(target_launch_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      out += `Target: ${target_launch_date} (${days} days)\n`;
    } else {
      out += `Target: Not set\n`;
    }
    out += `\nProject ID: ${projectId}`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("launch_status", {
    project_id: z.string().optional(),
    title: z.string().optional(),
  }, async ({ project_id, title }) => {
    const env = agent.env as any;
    
    let project;
    if (project_id) {
      project = await env.DB.prepare('SELECT * FROM launch_projects WHERE id = ?').bind(project_id).first();
    } else if (title) {
      project = await env.DB.prepare('SELECT * FROM launch_projects WHERE title LIKE ? AND user_id = ?').bind('%' + title + '%', getCurrentUser()).first();
    } else {
      // Get user's most recent active project
      project = await env.DB.prepare("SELECT * FROM launch_projects WHERE user_id = ? AND status != 'complete' ORDER BY updated_at DESC LIMIT 1").bind(getCurrentUser()).first();
    }
    
    if (!project) {
      return { content: [{ type: "text", text: "âŒ No launch project found" }] };
    }
    
    // Get completion stats by phase
    const phaseStats = await env.DB.prepare(`
      SELECT phase, 
        COUNT(*) as total,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as done
      FROM launch_checklist 
      WHERE project_id = ?
      GROUP BY phase
      ORDER BY MIN(sort_order)
    `).bind(project.id).all();
    
    // Get section stats for current phase
    const sectionStats = await env.DB.prepare(`
      SELECT section,
        COUNT(*) as total,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as done
      FROM launch_checklist
      WHERE project_id = ? AND phase = ?
      GROUP BY section
      ORDER BY MIN(sort_order)
    `).bind(project.id, project.current_phase).all();
    
    // Get active tasks from this launch
    const activeTasks = await env.DB.prepare(`
      SELECT lc.item_text, t.id as task_id
      FROM launch_checklist lc
      JOIN tasks t ON lc.task_id = t.id
      WHERE lc.project_id = ? AND lc.completed = 0 AND t.status = 'open'
      LIMIT 5
    `).bind(project.id).all();
    
    // Get recent metrics
    const recentMetrics = await env.DB.prepare(`
      SELECT metric_type, metric_name, value
      FROM launch_metrics
      WHERE project_id = ?
      ORDER BY recorded_date DESC
      LIMIT 10
    `).bind(project.id).all();
    
    // Calculate posting streak
    const streakResult = await env.DB.prepare(`
      SELECT post_date FROM posting_log
      WHERE project_id = ? AND platform = 'tiktok'
      ORDER BY post_date DESC
      LIMIT 30
    `).bind(project.id).all();
    
    let streak = 0;
    if (streakResult.results.length > 0) {
      const today = new Date().toISOString().split('T')[0];
      let checkDate = today;
      for (const row of streakResult.results as any[]) {
        if (row.post_date === checkDate || row.post_date === getPreviousDate(checkDate)) {
          streak++;
          checkDate = getPreviousDate(row.post_date);
        } else {
          break;
        }
      }
    }
    
    // Build output
    let out = `**${project.title.toUpperCase()}** - Launch Status\n\n`;
    out += `Phase: ${project.current_phase} (${phaseStats.results.findIndex((p: any) => p.phase === project.current_phase) + 1} of ${phaseStats.results.length})\n`;
    
    if (project.target_launch_date) {
      const days = Math.ceil((new Date(project.target_launch_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      out += `Target: ${project.target_launch_date} (${days} days)\n`;
    }
    
    const totalDone = phaseStats.results.reduce((sum: number, p: any) => sum + p.done, 0);
    const totalItems = phaseStats.results.reduce((sum: number, p: any) => sum + p.total, 0);
    const pct = totalItems > 0 ? Math.round((totalDone / totalItems) * 100) : 0;
    out += `Progress: ${totalDone}/${totalItems} complete (${pct}%)\n\n`;
    
    // Phase breakdown
    out += `**${project.current_phase.toUpperCase()} PHASE:**\n`;
    for (const section of sectionStats.results as any[]) {
      const icon = section.done === section.total ? 'âœ“' : section.done > 0 ? 'â—' : 'â—‹';
      const sectionName = section.section || 'General';
      out += `${icon} ${sectionName} (${section.done}/${section.total})\n`;
    }
    
    // Active tasks
    if (activeTasks.results.length > 0) {
      out += `\n**Active tasks from this launch:**\n`;
      for (const task of activeTasks.results as any[]) {
        out += `â€¢ ${task.item_text}\n`;
      }
    }
    
    // Metrics
    if (recentMetrics.results.length > 0) {
      out += `\n**Metrics (last recorded):**\n`;
      const seen = new Set();
      for (const m of recentMetrics.results as any[]) {
        const key = `${m.metric_type}:${m.metric_name}`;
        if (!seen.has(key)) {
          out += `â€¢ ${m.metric_type}/${m.metric_name}: ${m.value}\n`;
          seen.add(key);
        }
      }
    }
    
    out += `\nPosting streak: ${streak} days`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("launch_overview", {}, async () => {
    const env = agent.env as any;
    
    const projects = await env.DB.prepare(`
      SELECT lp.*, 
        (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id) as total_items,
        (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id AND completed = 1) as done_items
      FROM launch_projects lp
      WHERE lp.status != 'complete'
      ORDER BY lp.updated_at DESC
    `).all();
    
    if (projects.results.length === 0) {
      return { content: [{ type: "text", text: "ðŸ“‹ No active launch projects" }] };
    }
    
    let out = 'ðŸ“‹ **All Active Launches**\n\n';
    
    for (const p of projects.results as any[]) {
      const pct = p.total_items > 0 ? Math.round((p.done_items / p.total_items) * 100) : 0;
      let days = '';
      if (p.target_launch_date) {
        const d = Math.ceil((new Date(p.target_launch_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        days = ` | ${d} days`;
      }
      
      out += `**${p.title}** (${p.user_id})\n`;
      out += `  Phase: ${p.current_phase} | ${pct}% complete${days}\n`;
      out += `  Status: ${p.status}\n\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("advance_launch_phase", {
    project_id: z.string(),
  }, async ({ project_id }) => {
    const env = agent.env as any;
    
    const project = await env.DB.prepare('SELECT * FROM launch_projects WHERE id = ?').bind(project_id).first();
    if (!project) {
      return { content: [{ type: "text", text: "âŒ Project not found" }] };
    }
    
    // Check for incomplete CRITICAL items in current phase
    const criticalIncomplete = await env.DB.prepare(`
      SELECT item_text FROM launch_checklist
      WHERE project_id = ? AND phase = ? AND completed = 0 AND tags LIKE '%CRITICAL%'
    `).bind(project_id, project.current_phase).all();
    
    if (criticalIncomplete.results.length > 0) {
      let out = `âŒ Cannot advance. CRITICAL items incomplete:\n\n`;
      for (const item of criticalIncomplete.results as any[]) {
        out += `â€¢ ${item.item_text}\n`;
      }
      return { content: [{ type: "text", text: out }] };
    }
    
    // Get all phases in order
    const phases = await env.DB.prepare(`
      SELECT DISTINCT phase FROM launch_checklist
      WHERE project_id = ?
      ORDER BY MIN(sort_order)
    `).bind(project_id).all();
    
    const phaseList = (phases.results as any[]).map(p => p.phase);
    const currentIndex = phaseList.indexOf(project.current_phase);
    
    if (currentIndex >= phaseList.length - 1) {
      return { content: [{ type: "text", text: "âœ… Already on final phase. Use complete_launch when ready." }] };
    }
    
    const nextPhase = phaseList[currentIndex + 1];
    const ts = new Date().toISOString();
    
    await env.DB.prepare(
      'UPDATE launch_projects SET current_phase = ?, status = ?, updated_at = ? WHERE id = ?'
    ).bind(nextPhase, nextPhase.toLowerCase().replace(/\s+/g, '-'), ts, project_id).run();
    
    // Get stats for new phase
    const newPhaseStats = await env.DB.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as done
      FROM launch_checklist
      WHERE project_id = ? AND phase = ?
    `).bind(project_id, nextPhase).first();
    
    return { content: [{ type: "text", text: `âœ… Advanced to: **${nextPhase}**\n\nItems in this phase: ${newPhaseStats?.total || 0}\nAlready complete: ${newPhaseStats?.done || 0}` }] };
  });

  server.tool("complete_launch", {
    project_id: z.string(),
  }, async ({ project_id }) => {
    const env = agent.env as any;
    const ts = new Date().toISOString();
    
    await env.DB.prepare(
      "UPDATE launch_projects SET status = 'complete', updated_at = ? WHERE id = ?"
    ).bind(ts, project_id).run();
    
    const stats = await env.DB.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as done
      FROM launch_checklist WHERE project_id = ?
    `).bind(project_id).first();
    
    return { content: [{ type: "text", text: `ðŸŽ‰ Launch complete!\n\nFinal stats: ${stats?.done || 0}/${stats?.total || 0} items completed` }] };
  });

  server.tool("reset_launch", {
    project_id: z.string(),
    keep_metrics: z.boolean().optional().default(true),
  }, async ({ project_id, keep_metrics }) => {
    const env = agent.env as any;
    
    const project = await env.DB.prepare('SELECT * FROM launch_projects WHERE id = ?').bind(project_id).first();
    if (!project) {
      return { content: [{ type: "text", text: "âŒ Project not found" }] };
    }
    
    const ts = new Date().toISOString();
    
    // Reset checklist items
    await env.DB.prepare(
      'UPDATE launch_checklist SET completed = 0, completed_at = NULL, task_id = NULL WHERE project_id = ?'
    ).bind(project_id).run();
    
    // Get first phase
    const firstPhase = await env.DB.prepare(
      'SELECT phase FROM launch_checklist WHERE project_id = ? ORDER BY sort_order LIMIT 1'
    ).bind(project_id).first();
    
    // Reset project
    await env.DB.prepare(
      "UPDATE launch_projects SET status = 'setup', current_phase = ?, updated_at = ? WHERE id = ?"
    ).bind(firstPhase?.phase || 'Setup', ts, project_id).run();
    
    // Optionally clear metrics
    if (!keep_metrics) {
      await env.DB.prepare('DELETE FROM launch_metrics WHERE project_id = ?').bind(project_id).run();
      await env.DB.prepare('DELETE FROM content_batches WHERE project_id = ?').bind(project_id).run();
      await env.DB.prepare('DELETE FROM posting_log WHERE project_id = ?').bind(project_id).run();
      await env.DB.prepare('DELETE FROM launch_checkins WHERE project_id = ?').bind(project_id).run();
    }
    
    return { content: [{ type: "text", text: `âœ… Reset: ${project.title}\n\nAll checklist items unmarked.\nMetrics: ${keep_metrics ? 'kept' : 'cleared'}` }] };
  });

  // --- CHECKLIST MANAGEMENT ---

  server.tool("surface_launch_tasks", {
    project_id: z.string(),
    count: z.number().optional().default(5),
  }, async ({ project_id, count }) => {
    const env = agent.env as any;
    
    const project = await env.DB.prepare('SELECT * FROM launch_projects WHERE id = ?').bind(project_id).first();
    if (!project) {
      return { content: [{ type: "text", text: "âŒ Project not found" }] };
    }
    
    // Find items to surface:
    // - Current phase
    // - Not completed
    // - Not already surfaced (task_id is NULL)
    // - Order by: CRITICAL first, PRIORITY:HIGH second, sort_order
    const candidates = await env.DB.prepare(`
      SELECT * FROM launch_checklist
      WHERE project_id = ? AND phase = ? AND completed = 0 AND task_id IS NULL
      ORDER BY 
        CASE WHEN tags LIKE '%CRITICAL%' THEN 0 ELSE 1 END,
        CASE WHEN tags LIKE '%PRIORITY:HIGH%' THEN 0 ELSE 1 END,
        sort_order
      LIMIT ?
    `).bind(project_id, project.current_phase, count).all();
    
    if (candidates.results.length === 0) {
      return { content: [{ type: "text", text: "âœ… No items to surface. All current phase items are either complete or already on your task list." }] };
    }
    
    const ts = new Date().toISOString();
    const surfaced: string[] = [];
    
    for (const item of candidates.results as any[]) {
      // Create task
      const taskId = crypto.randomUUID();
      const tags = JSON.parse(item.tags || '[]');
      const priority = tags.includes('CRITICAL') ? 5 : tags.includes('PRIORITY:HIGH') ? 4 : 3;
      const notes = `From launch: ${project.title}\nPhase: ${item.phase}\nSection: ${item.section || 'General'}`;
      
      await env.DB.prepare(
        "INSERT INTO tasks (id, user_id, text, priority, category, project, status, created_at, last_touched, notes, focus_level) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 'medium')"
      ).bind(taskId, getCurrentUser(), item.item_text, priority, 'Launch', project.title, ts, ts, notes).run();
      
      // Link back to checklist
      await env.DB.prepare(
        'UPDATE launch_checklist SET task_id = ? WHERE id = ?'
      ).bind(taskId, item.id).run();
      
      const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
      surfaced.push(`â€¢ ${item.item_text}${tagStr}`);
    }
    
    return { content: [{ type: "text", text: `âœ… Surfaced ${surfaced.length} items to your task list:\n\n${surfaced.join('\n')}` }] };
  });

  server.tool("complete_checklist_item", {
    item_id: z.string().optional(),
    search: z.string().optional(),
  }, async ({ item_id, search }) => {
    const env = agent.env as any;
    
    let item;
    if (item_id) {
      item = await env.DB.prepare('SELECT * FROM launch_checklist WHERE id = ?').bind(item_id).first();
    } else if (search) {
      item = await env.DB.prepare('SELECT * FROM launch_checklist WHERE item_text LIKE ? AND completed = 0').bind('%' + search + '%').first();
    }
    
    if (!item) {
      return { content: [{ type: "text", text: "âŒ Item not found" }] };
    }
    
    const ts = new Date().toISOString();
    
    // Mark checklist item complete
    await env.DB.prepare(
      'UPDATE launch_checklist SET completed = 1, completed_at = ? WHERE id = ?'
    ).bind(ts, item.id).run();
    
    // If linked to a task, complete that too
    if (item.task_id) {
      await env.DB.prepare(
        "UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?"
      ).bind(ts, item.task_id).run();
    }
    
    return { content: [{ type: "text", text: `âœ… Completed: ${item.item_text}` }] };
  });

  server.tool("list_checklist", {
    project_id: z.string(),
    phase: z.string().optional(),
    section: z.string().optional(),
    status: z.enum(['all', 'open', 'done']).optional().default('all'),
  }, async ({ project_id, phase, section, status }) => {
    const env = agent.env as any;
    
    let query = 'SELECT * FROM launch_checklist WHERE project_id = ?';
    const params: any[] = [project_id];
    
    if (phase) {
      query += ' AND phase = ?';
      params.push(phase);
    }
    if (section) {
      query += ' AND section = ?';
      params.push(section);
    }
    if (status === 'open') {
      query += ' AND completed = 0';
    } else if (status === 'done') {
      query += ' AND completed = 1';
    }
    
    query += ' ORDER BY sort_order';
    
    const r = await env.DB.prepare(query).bind(...params).all();
    
    if (r.results.length === 0) {
      return { content: [{ type: "text", text: "No items found" }] };
    }
    
    let out = `ðŸ“‹ **Checklist** (${r.results.length} items)\n\n`;
    let currentPhase = '';
    let currentSection = '';
    
    for (const item of r.results as any[]) {
      if (item.phase !== currentPhase) {
        currentPhase = item.phase;
        out += `\n**${currentPhase}**\n`;
        currentSection = '';
      }
      if (item.section !== currentSection) {
        currentSection = item.section;
        if (currentSection) out += `\n_${currentSection}_\n`;
      }
      
      const check = item.completed ? 'âœ“' : 'â—‹';
      const tags = JSON.parse(item.tags || '[]');
      const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
      const onTask = item.task_id ? ' ðŸ“Œ' : '';
      out += `${check} ${item.item_text}${tagStr}${onTask}\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("add_checklist_item", {
    project_id: z.string(),
    phase: z.string(),
    section: z.string().optional(),
    item_text: z.string(),
    tags: z.array(z.string()).optional(),
  }, async ({ project_id, phase, section, item_text, tags }) => {
    const env = agent.env as any;
    
    // Get max sort_order for this phase
    const maxOrder = await env.DB.prepare(
      'SELECT MAX(sort_order) as max FROM launch_checklist WHERE project_id = ? AND phase = ?'
    ).bind(project_id, phase).first();
    
    const id = crypto.randomUUID();
    
    await env.DB.prepare(
      'INSERT INTO launch_checklist (id, project_id, doc_id, phase, section, item_text, sort_order, tags, completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)'
    ).bind(id, project_id, 'manual', phase, section || null, item_text, (maxOrder?.max || 0) + 1, JSON.stringify(tags || [])).run();
    
    return { content: [{ type: "text", text: `âœ… Added: ${item_text}` }] };
  });

  // --- METRICS & TRACKING ---

  server.tool("log_launch_metrics", {
    project_id: z.string(),
    metrics: z.record(z.record(z.number())).describe("{ type: { name: value } }"),
  }, async ({ project_id, metrics }) => {
    const env = agent.env as any;
    const ts = new Date().toISOString();
    const today = ts.split('T')[0];
    
    let logged: string[] = [];
    
    for (const [type, values] of Object.entries(metrics)) {
      for (const [name, value] of Object.entries(values as Record<string, number>)) {
        await env.DB.prepare(
          'INSERT INTO launch_metrics (id, project_id, user_id, recorded_date, metric_type, metric_name, value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), project_id, getCurrentUser(), today, type, name, value, ts).run();
        logged.push(`${type}/${name}: ${value}`);
      }
    }
    
    return { content: [{ type: "text", text: `âœ… Logged metrics:\n\n${logged.join('\n')}` }] };
  });

  server.tool("launch_metrics_history", {
    project_id: z.string(),
    metric_type: z.string().optional(),
    days: z.number().optional().default(30),
  }, async ({ project_id, metric_type, days }) => {
    const env = agent.env as any;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    let query = 'SELECT * FROM launch_metrics WHERE project_id = ? AND recorded_date >= ?';
    const params: any[] = [project_id, since];
    
    if (metric_type) {
      query += ' AND metric_type = ?';
      params.push(metric_type);
    }
    
    query += ' ORDER BY recorded_date DESC, metric_type, metric_name';
    
    const r = await env.DB.prepare(query).bind(...params).all();
    
    if (r.results.length === 0) {
      return { content: [{ type: "text", text: "No metrics recorded" }] };
    }
    
    let out = `ðŸ“Š **Metrics History** (${days} days)\n\n`;
    let currentDate = '';
    
    for (const m of r.results as any[]) {
      if (m.recorded_date !== currentDate) {
        currentDate = m.recorded_date;
        out += `\n**${currentDate}**\n`;
      }
      out += `  ${m.metric_type}/${m.metric_name}: ${m.value}\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("log_content_batch", {
    project_id: z.string(),
    scripted: z.number().optional().default(0),
    filmed: z.number().optional().default(0),
    edited: z.number().optional().default(0),
    scheduled: z.number().optional().default(0),
    platform: z.string().optional().default('tiktok'),
    notes: z.string().optional(),
  }, async ({ project_id, scripted, filmed, edited, scheduled, platform, notes }) => {
    const env = agent.env as any;
    const ts = new Date().toISOString();
    const today = ts.split('T')[0];
    
    await env.DB.prepare(
      'INSERT INTO content_batches (id, project_id, user_id, batch_date, platform, videos_scripted, videos_filmed, videos_edited, videos_scheduled, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), project_id, getCurrentUser(), today, platform, scripted, filmed, edited, scheduled, notes || null, ts).run();
    
    // Get buffer status
    const buffer = await env.DB.prepare(`
      SELECT 
        SUM(videos_scheduled) as total_scheduled,
        (SELECT COUNT(*) FROM posting_log WHERE project_id = ? AND platform = ?) as total_posted
      FROM content_batches
      WHERE project_id = ? AND platform = ?
    `).bind(project_id, platform, project_id, platform).first();
    
    const bufferDays = (buffer?.total_scheduled || 0) - (buffer?.total_posted || 0);
    
    return { content: [{ type: "text", text: `âœ… Logged batch:\n\nScripted: ${scripted}\nFilmed: ${filmed}\nEdited: ${edited}\nScheduled: ${scheduled}\n\nðŸ“¦ Content buffer: ~${bufferDays} days` }] };
  });

  server.tool("log_post", {
    project_id: z.string(),
    platform: z.enum(['tiktok', 'email', 'substack', 'instagram', 'youtube']),
    count: z.number().optional().default(1),
    notes: z.string().optional(),
  }, async ({ project_id, platform, count, notes }) => {
    const env = agent.env as any;
    const ts = new Date().toISOString();
    const today = ts.split('T')[0];
    
    await env.DB.prepare(
      'INSERT INTO posting_log (id, project_id, user_id, post_date, platform, post_count, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), project_id, getCurrentUser(), today, platform, count, notes || null, ts).run();
    
    // Calculate streak
    const streakResult = await env.DB.prepare(`
      SELECT DISTINCT post_date FROM posting_log
      WHERE project_id = ? AND platform = ?
      ORDER BY post_date DESC
      LIMIT 60
    `).bind(project_id, platform).all();
    
    let streak = 0;
    let checkDate = today;
    for (const row of streakResult.results as any[]) {
      if (row.post_date === checkDate) {
        streak++;
        checkDate = getPreviousDate(checkDate);
      } else if (row.post_date === getPreviousDate(checkDate)) {
        // Allow for checking yesterday if today not yet posted
        streak++;
        checkDate = getPreviousDate(row.post_date);
      } else {
        break;
      }
    }
    
    return { content: [{ type: "text", text: `âœ… Logged ${count} ${platform} post(s)\n\nðŸ”¥ Current streak: ${streak} days` }] };
  });

  server.tool("posting_streak", {
    project_id: z.string(),
    platform: z.string().optional(),
  }, async ({ project_id, platform }) => {
    const env = agent.env as any;
    
    const platforms = platform ? [platform] : ['tiktok', 'email', 'substack', 'instagram', 'youtube'];
    let out = 'ðŸ”¥ **Posting Streaks**\n\n';
    
    for (const p of platforms) {
      const streakResult = await env.DB.prepare(`
        SELECT DISTINCT post_date FROM posting_log
        WHERE project_id = ? AND platform = ?
        ORDER BY post_date DESC
        LIMIT 60
      `).bind(project_id, p).all();
      
      if (streakResult.results.length === 0) continue;
      
      let streak = 0;
      const today = new Date().toISOString().split('T')[0];
      let checkDate = today;
      
      for (const row of streakResult.results as any[]) {
        if (row.post_date === checkDate || row.post_date === getPreviousDate(checkDate)) {
          streak++;
          checkDate = getPreviousDate(row.post_date);
        } else {
          break;
        }
      }
      
      const total = await env.DB.prepare(
        'SELECT SUM(post_count) as total FROM posting_log WHERE project_id = ? AND platform = ?'
      ).bind(project_id, p).first();
      
      out += `**${p}**: ${streak} day streak (${total?.total || 0} total posts)\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  // --- ACCOUNTABILITY ---

  server.tool("launch_checkin", {
    project_id: z.string(),
    wins: z.string(),
    struggles: z.string(),
    patterns: z.string().optional(),
    next_week_focus: z.string(),
  }, async ({ project_id, wins, struggles, patterns, next_week_focus }) => {
    const env = agent.env as any;
    const ts = new Date().toISOString();
    const today = ts.split('T')[0];
    
    // Get week number
    const startOfYear = new Date(new Date().getFullYear(), 0, 1);
    const weekNumber = Math.ceil(((Date.now() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
    
    // Snapshot current metrics
    const metrics = await env.DB.prepare(`
      SELECT metric_type, metric_name, value
      FROM launch_metrics
      WHERE project_id = ? AND recorded_date = (
        SELECT MAX(recorded_date) FROM launch_metrics WHERE project_id = ?
      )
    `).bind(project_id, project_id).all();
    
    const metricsSnapshot = JSON.stringify(metrics.results);
    
    await env.DB.prepare(
      'INSERT INTO launch_checkins (id, project_id, user_id, week_number, checkin_date, wins, struggles, patterns, next_week_focus, metrics_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), project_id, getCurrentUser(), weekNumber, today, wins, struggles, patterns || null, next_week_focus, metricsSnapshot, ts).run();
    
    // Get streak count
    const checkinCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM launch_checkins WHERE project_id = ? AND user_id = ?'
    ).bind(project_id, getCurrentUser()).first();
    
    return { content: [{ type: "text", text: `âœ… Week ${weekNumber} check-in recorded!\n\nðŸ”¥ Check-in streak: ${checkinCount?.count || 1} weeks` }] };
  });

  server.tool("checkin_history", {
    project_id: z.string(),
    count: z.number().optional().default(4),
  }, async ({ project_id, count }) => {
    const env = agent.env as any;
    
    const r = await env.DB.prepare(
      'SELECT * FROM launch_checkins WHERE project_id = ? ORDER BY checkin_date DESC LIMIT ?'
    ).bind(project_id, count).all();
    
    if (r.results.length === 0) {
      return { content: [{ type: "text", text: "No check-ins recorded yet" }] };
    }
    
    let out = 'ðŸ“‹ **Check-in History**\n\n';
    
    for (const c of r.results as any[]) {
      out += `**Week ${c.week_number}** (${c.checkin_date})\n`;
      out += `Wins: ${c.wins}\n`;
      out += `Struggles: ${c.struggles}\n`;
      if (c.patterns) out += `Patterns: ${c.patterns}\n`;
      out += `Next focus: ${c.next_week_focus}\n\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  // ==================
  // BETHANY: Work Day Tracking Tools
  // ==================

  server.tool("good_morning", {
    notes: z.string().optional().describe("Any context about today - energy level, focus, constraints"),
  }, async ({ notes }) => {
    const env = agent.env as any;
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const ts = now.toISOString();
    
    // Check if session already exists today
    const existing = await env.DB.prepare(
      'SELECT * FROM work_sessions WHERE user_id = ? AND session_date = ?'
    ).bind(getCurrentUser(), today).first();
    
    let sessionId: string;
    
    if (existing) {
      sessionId = existing.id;
      // Update start time if re-starting
      await env.DB.prepare(
        'UPDATE work_sessions SET started_at = ? WHERE id = ?'
      ).bind(ts, sessionId).run();
    } else {
      sessionId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO work_sessions (id, user_id, session_date, started_at, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(sessionId, getCurrentUser(), today, ts, ts).run();
    }
    
    // Create morning checkpoint
    await env.DB.prepare(
      'INSERT INTO checkpoints (id, user_id, session_id, checkpoint_time, trigger_type, summary, topics, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(), getCurrentUser(), sessionId, ts, 'morning',
      notes || 'Started work day', JSON.stringify(['day_start']), ts
    ).run();
    
    // Gather context for the day
    // 1. Open tasks, prioritized
    const tasks = await env.DB.prepare(`
      SELECT * FROM tasks 
      WHERE user_id = ? AND status = 'open' 
      AND (snoozed_until IS NULL OR snoozed_until <= ?)
      ORDER BY priority DESC, due_date ASC NULLS LAST, created_at ASC
      LIMIT 10
    `).bind(getCurrentUser(), today).all();
    
    // 2. Tasks due soon
    const dueSoon = tasks.results.filter((t: any) => {
      if (!t.due_date) return false;
      const days = (new Date(t.due_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      return days <= 3;
    });
    
    // 3. Pending handoffs
    const handoffs = await env.DB.prepare(`
      SELECT h.*, t.text as task_text 
      FROM handoff_suggestions h 
      JOIN tasks t ON h.task_id = t.id 
      WHERE h.to_user = ? AND h.status = 'pending'
    `).bind(getCurrentUser()).all();
    
    // 4. Active launches
    const launches = await env.DB.prepare(`
      SELECT lp.*, 
        (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id AND completed = 0) as remaining
      FROM launch_projects lp
      WHERE lp.user_id = ? AND lp.status != 'complete'
      ORDER BY lp.target_launch_date ASC NULLS LAST
    `).bind(getCurrentUser()).all();
    
    // 5. Yesterday's momentum (what got done)
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const yesterdayDone = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM tasks 
      WHERE user_id = ? AND status = 'done' AND DATE(completed_at) = ?
    `).bind(getCurrentUser(), yesterday).first();
    
    // 6. Last checkpoint from previous session (where you left off)
    const lastCheckpoint = await env.DB.prepare(`
      SELECT * FROM checkpoints 
      WHERE user_id = ? AND trigger_type = 'night'
      ORDER BY checkpoint_time DESC LIMIT 1
    `).bind(getCurrentUser()).first();
    
    // Build the morning briefing
    let out = `☀️ **Good Morning!**\n\n`;
    out += `📍 Session started: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}\n`;
    
    if (lastCheckpoint) {
      out += `\n**Where you left off:**\n${lastCheckpoint.summary}\n`;
    }
    
    if (yesterdayDone?.count > 0) {
      out += `\n✅ Yesterday: ${yesterdayDone.count} tasks completed\n`;
    }
    
    // Handoffs first - need action
    if (handoffs.results.length > 0) {
      out += `\n📥 **Handoffs waiting:**\n`;
      for (const h of handoffs.results as any[]) {
        out += `• From ${h.from_user}: "${h.task_text}"\n`;
      }
    }
    
    // Due soon
    if (dueSoon.length > 0) {
      out += `\n🔴 **Due soon:**\n`;
      for (const t of dueSoon as any[]) {
        out += `• ${t.text} (${t.due_date})\n`;
      }
    }
    
    // Active launches
    if (launches.results.length > 0) {
      out += `\n🚀 **Active launches:**\n`;
      for (const l of launches.results as any[]) {
        let line = `• ${l.title} — ${l.current_phase}`;
        if (l.target_launch_date) {
          const days = Math.ceil((new Date(l.target_launch_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          line += ` (${days} days)`;
        }
        line += ` — ${l.remaining} items left`;
        out += line + '\n';
      }
    }
    
    // Today's suggested focus
    out += `\n📋 **Today's suggestions:**\n`;
    const highPriority = tasks.results.filter((t: any) => t.priority >= 4);
    const suggested = highPriority.length > 0 ? highPriority.slice(0, 3) : tasks.results.slice(0, 3);
    
    if (suggested.length === 0) {
      out += `• No open tasks! Time to plan or create.\n`;
    } else {
      for (const t of suggested as any[]) {
        const p = t.priority >= 4 ? '🔴' : t.priority === 3 ? '🟡' : '⚪';
        out += `${p} ${t.text}\n`;
      }
    }
    
    if (notes) {
      out += `\n💭 Your notes: ${notes}`;
    }
    
    out += `\n\n---\nSession ID: ${sessionId}`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("good_night", {
    notes: z.string().optional().describe("Any closing thoughts, what to pick up tomorrow"),
  }, async ({ notes }) => {
    const env = agent.env as any;
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const ts = now.toISOString();
    
    // Get today's session
    const session = await env.DB.prepare(
      'SELECT * FROM work_sessions WHERE user_id = ? AND session_date = ?'
    ).bind(getCurrentUser(), today).first();
    
    if (!session) {
      return { content: [{ type: "text", text: "🌙 No work session found for today. Did you forget to say good morning?" }] };
    }
    
    // Calculate total time
    const startTime = new Date(session.started_at);
    const totalMinutes = Math.round((now.getTime() - startTime.getTime()) / (1000 * 60));
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    
    // Get all checkpoints from today
    const checkpoints = await env.DB.prepare(`
      SELECT * FROM checkpoints 
      WHERE user_id = ? AND session_id = ?
      ORDER BY checkpoint_time ASC
    `).bind(getCurrentUser(), session.id).all();
    
    // Get tasks completed today
    const completed = await env.DB.prepare(`
      SELECT * FROM tasks 
      WHERE user_id = ? AND status = 'done' AND DATE(completed_at) = ?
      ORDER BY completed_at ASC
    `).bind(getCurrentUser(), today).all();
    
    // Get tasks added today
    const added = await env.DB.prepare(`
      SELECT * FROM tasks 
      WHERE user_id = ? AND DATE(created_at) = ?
      ORDER BY created_at ASC
    `).bind(getCurrentUser(), today).all();
    
    // Get progress logs
    const progressLogs = await env.DB.prepare(`
      SELECT * FROM progress_logs 
      WHERE user_id = ? AND DATE(logged_at) = ?
      ORDER BY logged_at ASC
    `).bind(getCurrentUser(), today).all();
    
    // Build the narrative summary from checkpoints
    let narrative = '';
    const nonMorningCheckpoints = (checkpoints.results as any[]).filter(c => c.trigger_type !== 'morning');
    
    if (nonMorningCheckpoints.length > 0) {
      const summaries = nonMorningCheckpoints.map((c: any) => c.summary);
      narrative = summaries.join(' → ');
    } else if (completed.results.length > 0) {
      narrative = `Completed ${completed.results.length} task(s): ${(completed.results as any[]).map(t => t.text).join(', ')}`;
    } else {
      narrative = 'No checkpoints recorded today.';
    }
    
    // Collect all topics mentioned
    const allTopics = new Set<string>();
    for (const c of checkpoints.results as any[]) {
      const topics = JSON.parse(c.topics || '[]');
      topics.forEach((t: string) => allTopics.add(t));
    }
    allTopics.delete('day_start');
    
    // Create night checkpoint
    const nightSummary = notes || `Wrapped up: ${narrative.slice(0, 200)}`;
    await env.DB.prepare(
      'INSERT INTO checkpoints (id, user_id, session_id, checkpoint_time, trigger_type, summary, topics, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(), getCurrentUser(), session.id, ts, 'night',
      nightSummary, JSON.stringify(Array.from(allTopics)), ts
    ).run();
    
    // Update session with end time and summary
    await env.DB.prepare(`
      UPDATE work_sessions 
      SET ended_at = ?, total_minutes = ?, end_of_day_summary = ?
      WHERE id = ?
    `).bind(ts, totalMinutes, narrative, session.id).run();
    
    // Build end of day report
    let out = `🌙 **End of Day Report**\n\n`;
    out += `⏱️ **Time:** ${hours}h ${mins}m (${startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} → ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})\n\n`;
    
    // The narrative
    out += `**Today's Flow:**\n${narrative}\n\n`;
    
    // Stats
    out += `**Stats:**\n`;
    out += `• ✅ Completed: ${completed.results.length}\n`;
    out += `• ➕ Added: ${added.results.length}\n`;
    out += `• 📍 Checkpoints: ${checkpoints.results.length}\n`;
    if (progressLogs.results.length > 0) {
      const totalLoggedMinutes = (progressLogs.results as any[]).reduce((sum, p) => sum + (p.minutes_spent || 0), 0);
      if (totalLoggedMinutes > 0) {
        out += `• 📝 Logged work: ${Math.round(totalLoggedMinutes / 60)}h ${totalLoggedMinutes % 60}m\n`;
      }
    }
    
    // Net productivity
    const net = completed.results.length - added.results.length;
    if (net > 0) {
      out += `\n📈 Net: +${net} (burned down the list!)\n`;
    } else if (net < 0) {
      out += `\n📊 Net: ${net} (expanded scope today)\n`;
    } else {
      out += `\n📊 Net: 0 (balanced day)\n`;
    }
    
    // Topics worked on
    if (allTopics.size > 0) {
      out += `\n**Topics:** ${Array.from(allTopics).join(', ')}\n`;
    }
    
    // What's completed
    if (completed.results.length > 0) {
      out += `\n**Completed:**\n`;
      for (const t of completed.results as any[]) {
        out += `• ${t.text}\n`;
      }
    }
    
    // What was discovered (from checkpoints)
    const discoveries = (checkpoints.results as any[])
      .filter(c => c.discoveries)
      .map(c => c.discoveries);
    if (discoveries.length > 0) {
      out += `\n**Discoveries:**\n`;
      discoveries.forEach(d => { out += `• ${d}\n`; });
    }
    
    if (notes) {
      out += `\n**Tomorrow:** ${notes}\n`;
    }
    
    out += `\n---\n🌟 Good work today!`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("checkpoint", {
    summary: z.string().describe("1-2 sentence summary of what's being worked on"),
    topics: z.array(z.string()).optional().describe("Topic areas touched"),
    discoveries: z.string().optional().describe("Anything learned or figured out"),
    task_ids: z.array(z.string()).optional().describe("Related task IDs"),
    trigger: z.enum(['task_added', 'task_completed', 'topic_shift', 'manual', 'auto']).optional().default('auto'),
  }, async ({ summary, topics, discoveries, task_ids, trigger }) => {
    const env = agent.env as any;
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const ts = now.toISOString();
    
    // Get or create today's session
    let session = await env.DB.prepare(
      'SELECT * FROM work_sessions WHERE user_id = ? AND session_date = ?'
    ).bind(getCurrentUser(), today).first();
    
    let sessionId: string;
    if (!session) {
      // Auto-create session if none exists
      sessionId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO work_sessions (id, user_id, session_date, started_at, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(sessionId, getCurrentUser(), today, ts, ts).run();
    } else {
      sessionId = session.id;
    }
    
    // Create checkpoint
    await env.DB.prepare(
      'INSERT INTO checkpoints (id, user_id, session_id, checkpoint_time, trigger_type, summary, topics, discoveries, task_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(),
      getCurrentUser(),
      sessionId,
      ts,
      trigger,
      summary,
      JSON.stringify(topics || []),
      discoveries || null,
      JSON.stringify(task_ids || []),
      ts
    ).run();
    
    // Count today's checkpoints
    const count = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM checkpoints WHERE user_id = ? AND session_id = ?'
    ).bind(getCurrentUser(), sessionId).first();
    
    // Silent confirmation - keep it minimal since this runs in background
    return { content: [{ type: "text", text: `📍 Checkpoint #${count?.c || 1}: ${summary.slice(0, 50)}${summary.length > 50 ? '...' : ''}` }] };
  });

  server.tool("work_history", {
    days: z.number().optional().default(7),
  }, async ({ days }) => {
    const env = agent.env as any;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const sessions = await env.DB.prepare(`
      SELECT ws.*, 
        (SELECT COUNT(*) FROM checkpoints WHERE session_id = ws.id) as checkpoint_count
      FROM work_sessions ws
      WHERE ws.user_id = ? AND ws.session_date >= ?
      ORDER BY ws.session_date DESC
    `).bind(getCurrentUser(), since).all();
    
    if (sessions.results.length === 0) {
      return { content: [{ type: "text", text: `No work sessions in the last ${days} days.` }] };
    }
    
    let out = `📅 **Work History** (${days} days)\n\n`;
    
    let totalMinutes = 0;
    for (const s of sessions.results as any[]) {
      const hours = s.total_minutes ? Math.floor(s.total_minutes / 60) : 0;
      const mins = s.total_minutes ? s.total_minutes % 60 : 0;
      totalMinutes += s.total_minutes || 0;
      
      out += `**${s.session_date}** — ${hours}h ${mins}m — ${s.checkpoint_count} checkpoints\n`;
      if (s.end_of_day_summary) {
        out += `  ${s.end_of_day_summary.slice(0, 100)}${s.end_of_day_summary.length > 100 ? '...' : ''}\n`;
      }
      out += '\n';
    }
    
    const avgMinutes = Math.round(totalMinutes / sessions.results.length);
    const avgHours = Math.floor(avgMinutes / 60);
    const avgMins = avgMinutes % 60;
    
    out += `---\n`;
    out += `Total: ${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m across ${sessions.results.length} days\n`;
    out += `Average: ${avgHours}h ${avgMins}m per day`;
    
    return { content: [{ type: "text", text: out }] };
  });
}

// ==================
// USER AGENTS
// ==================
export class ProductivityMCP extends McpAgent {
  server = new McpServer({ name: "Untitled Publishers Productivity", version: "5.1.0" });
  
  async init() { 
    const env = this.env as any;
    const userId = env.USER_ID || 'micaiah';
    registerTools(this.server, this, userId); 
  }
}

// Keep MyMCP as alias for backward compatibility
export { ProductivityMCP as MyMCP };
export { ProductivityMCP as MicaiahMCP };
export { ProductivityMCP as IreneMCP };

// ==================
// ROUTING
// ==================
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const userId = (env as any).USER_ID || 'micaiah';
    const workerName = (env as any).WORKER_NAME || `productivity-${userId === 'micaiah' ? 'mcp-server' : userId}`;
    const workerUrl = `https://${workerName}.micaiah-tasks.workers.dev`;
    
    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) return new Response('Missing params', { status: 400 });
      
      // Parse state: "userId:provider" format
      const [stateUserId, provider] = state.includes(':') 
        ? state.split(':') 
        : [state, 'google_drive']; // Backward compatibility
      
      // Handle GitHub OAuth
      if (provider === 'github') {
        const tokenResp = await fetch(GITHUB_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            client_id: (env as any).GITHUB_CLIENT_ID,
            client_secret: (env as any).GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: workerUrl + '/oauth/callback',
          }),
        });
        if (!tokenResp.ok) return new Response('GitHub token failed', { status: 500 });
        const tokens: any = await tokenResp.json();
        if (tokens.error) return new Response('GitHub error: ' + tokens.error_description, { status: 500 });
        await (env as any).DB.prepare(
          'INSERT INTO oauth_tokens (id, user_id, provider, access_token, refresh_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET access_token = ?'
        ).bind(crypto.randomUUID(), stateUserId, 'github', tokens.access_token, null, null, new Date().toISOString(), tokens.access_token).run();
        return new Response('<html><body style="font-family:system-ui;text-align:center;padding:50px"><h1>GitHub Connected!</h1><p>Close this window</p></body></html>', { headers: { 'Content-Type': 'text/html' } });
      }
      
      const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 
          code, 
          client_id: (env as any).GOOGLE_CLIENT_ID, 
          client_secret: (env as any).GOOGLE_CLIENT_SECRET, 
          redirect_uri: workerUrl + '/oauth/callback', 
          grant_type: 'authorization_code' 
        }),
      });
      
      if (!tokenResp.ok) {
        const err = await tokenResp.text();
        return new Response('Token failed: ' + err, { status: 500 });
      }
      const tokens: any = await tokenResp.json();
      const exp = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
      
      await (env as any).DB.prepare(
        'INSERT INTO oauth_tokens (id, user_id, provider, access_token, refresh_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?'
      ).bind(
        crypto.randomUUID(), 
        stateUserId, 
        provider, 
        tokens.access_token, 
        tokens.refresh_token, 
        exp, 
        new Date().toISOString(), 
        tokens.access_token, 
        tokens.refresh_token, 
        exp
      ).run();
      
      const serviceNames: Record<string, string> = {
        'google_drive': 'Google Drive',
        'gmail_personal': 'Personal Email',
        'gmail_company': 'Company Email',
        'blogger': 'Blogger',
      };
      
      return new Response(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh"><div style="text-align:center"><h1>âœ… ${serviceNames[provider] || provider} Connected!</h1><p>Close this window and return to Claude</p></div></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }
    
    // All SSE requests go to the same MCP class - user is determined by env
    if (url.pathname.startsWith("/sse")) {
      return ProductivityMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    
    return new Response(JSON.stringify({ status: "running", user: userId, version: "5.1.0" }), { headers: { "Content-Type": "application/json" } });
  },
};
