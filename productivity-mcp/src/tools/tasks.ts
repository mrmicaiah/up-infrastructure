// Task management tools

import { z } from "zod";
import type { ToolContext } from '../types';
import { 
  needsBreakdown, 
  isVagueTask, 
  inferFocusLevel, 
  getDayOfWeek,
  normalizeUser,
  getNextDueDate
} from '../helpers/utils';
import { 
  logEvent, 
  updateDailyLog, 
  getPatterns, 
  generateNudges, 
  analyzeAndStorePatterns,
  autoCheckpoint 
} from '../helpers/intelligence';

export function registerTaskTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool("list_tasks", {
    status: z.enum(["open", "done", "all"]).optional().default("open"),
    category: z.string().optional(),
    project: z.string().optional(),
    include_teammate: z.boolean().optional().default(false),
  }, async ({ status, category, project, include_teammate }) => {
    let query = "SELECT t.*, o.statement as objective_statement FROM tasks t LEFT JOIN objectives o ON t.objective_id = o.id WHERE 1=1";
    const bindings: any[] = [];
    
    if (!include_teammate) {
      query += " AND t.user_id = ?";
      bindings.push(getCurrentUser());
    }
    if (status !== "all") {
      query += " AND t.status = ?";
      bindings.push(status);
    }
    if (category) {
      query += " AND t.category = ?";
      bindings.push(category);
    }
    if (project) {
      query += " AND t.project = ?";
      bindings.push(project);
    }
    query += " ORDER BY t.priority DESC, t.created_at ASC";
    
    const result = await env.DB.prepare(query).bind(...bindings).all();
    const tasks = result.results.map((t: any) => ({
      ...t,
      days_old: Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86400000),
    }));
    
    if (tasks.length === 0) {
      return { content: [{ type: "text", text: "No tasks found.\n\n💬 What have you been working on?" }] };
    }
    
    let output = 'Found ' + tasks.length + ' tasks:\n\n';
    tasks.forEach((t: any, index: number) => {
      const p = t.priority >= 4 ? "🔴" : t.priority === 3 ? "🟡" : "⚪";
      let line = (index + 1) + '. ' + p + ' ' + t.text;
      if (t.category) line += ' [' + t.category + ']';
      if (t.due_date) line += ' (due: ' + t.due_date + ')';
      if (t.recurrence) line += ' 🔄' + t.recurrence;
      if (t.assigned_by) line += ' 📥 from ' + t.assigned_by;
      if (t.is_active) line += ' 🎯';
      if (t.objective_statement) line += ' → ' + t.objective_statement;
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
    for_user: z.string().optional().describe("Username to assign task to (e.g., 'micaiah' or 'irene'). Defaults to current user."),
    recurrence: z.string().optional().describe("daily, weekdays, weekly, biweekly, monthly, yearly, or specific days like 'mon,thu' or 'fri'"),
    is_active: z.boolean().optional().describe("Add directly to Active list"),
  }, async ({ text, priority, due_date, category, project, notes, for_user, recurrence, is_active }) => {
    const targetUser = normalizeUser(for_user || getCurrentUser());
    const assignedBy = (for_user && normalizeUser(for_user) !== getCurrentUser()) ? getCurrentUser() : null;
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    const focusLevel = inferFocusLevel(text);
    
    const effectiveDueDate = due_date || (recurrence ? new Date().toISOString().split('T')[0] : null);
    
    await env.DB.prepare(
      'INSERT INTO tasks (id, user_id, text, priority, due_date, category, project, status, created_at, last_touched, needs_breakdown, is_vague, focus_level, notes, recurrence, assigned_by, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, targetUser, text, priority, effectiveDueDate, category || null, project || null, 'open', ts, ts, needsBreakdown(text) ? 1 : 0, isVagueTask(text) ? 1 : 0, focusLevel, notes || null, recurrence || null, assignedBy, is_active ? 1 : 0).run();
    
    await logEvent(env, targetUser, 'created', id, { text, priority, category, focusLevel, recurrence, assignedBy });
    await updateDailyLog(env, targetUser, 'tasks_created');
    await autoCheckpoint(env, targetUser, 'task_added', `Added task: ${text}`, [category || project || 'general'], id);
    
    let resp = 'Added: "' + text + '"';
    if (for_user && normalizeUser(for_user) !== getCurrentUser()) resp += ' (assigned to ' + targetUser + ' — will appear in their Incoming)';
    if (priority >= 4) resp += " 🔴";
    if (effectiveDueDate) resp += ' - due ' + effectiveDueDate;
    if (recurrence) resp += ' 🔄 ' + recurrence;
    if (is_active) resp += ' 🎯 (active)';
    
    if (needsBreakdown(text)) resp += '\n\n💡 This looks like a big task. Want to break it down?';
    if (isVagueTask(text)) resp += '\n\n💭 This seems a bit vague. Can you make it more specific?';
    
    return { content: [{ type: "text", text: resp }] };
  });

  server.tool("claim_task", {
    task_id: z.string().optional(),
    search: z.string().optional(),
    category: z.string().optional().describe("Move to this category when claiming"),
    activate: z.boolean().optional().describe("Also add to Active list"),
  }, async ({ task_id, search, category, activate }) => {
    let task: any = null;
    
    if (task_id) {
      task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?").bind(task_id, getCurrentUser()).first();
    } else if (search) {
      const results = await env.DB.prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND assigned_by IS NOT NULL AND text LIKE ? LIMIT 5"
      ).bind(getCurrentUser(), '%' + search + '%').all();
      
      if (results.results.length === 0) return { content: [{ type: "text", text: 'No incoming task found matching "' + search + '"' }] };
      if (results.results.length === 1) task = results.results[0];
      else {
        let out = 'Multiple matches:\n';
        results.results.forEach((t: any, i: number) => { out += (i+1) + '. ' + t.text + ' (from ' + t.assigned_by + ')\n'; });
        return { content: [{ type: "text", text: out }] };
      }
    } else {
      return { content: [{ type: "text", text: "Need task_id or search text" }] };
    }
    
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    if (!task.assigned_by) return { content: [{ type: "text", text: "This task is not in your Incoming (no assigned_by)" }] };
    
    const ts = new Date().toISOString();
    const updates = ['assigned_by = NULL', 'last_touched = ?'];
    const bindings: any[] = [ts];
    
    if (category) { updates.push('category = ?'); bindings.push(category); }
    if (activate) { updates.push('is_active = 1'); }
    bindings.push(task.id);
    
    await env.DB.prepare('UPDATE tasks SET ' + updates.join(', ') + ' WHERE id = ?').bind(...bindings).run();
    
    let resp = '✅ Claimed: "' + task.text + '"';
    if (category) resp += ' → moved to [' + category + ']';
    if (activate) resp += ' 🎯 (activated)';
    resp += '\n\nTask removed from Incoming and added to your list.';
    
    return { content: [{ type: "text", text: resp }] };
  });

  server.tool("complete_task", {
    task_id: z.string().optional(),
    search: z.string().optional(),
    position: z.number().optional().describe("Task number from list (e.g., 3 to complete the 3rd task)"),
  }, async ({ task_id, search, position }) => {
    let task: any = null;
    
    if (position) {
      const results = await env.DB.prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND status = 'open' ORDER BY priority DESC, created_at ASC"
      ).bind(getCurrentUser()).all();
      
      if (position < 1 || position > results.results.length) {
        return { content: [{ type: "text", text: `Invalid position. You have ${results.results.length} open tasks.` }] };
      }
      task = results.results[position - 1];
    } else if (task_id) {
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
      return { content: [{ type: "text", text: "Need task_id, search text, or position number" }] };
    }
    
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    
    const completedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE tasks SET status = 'done', completed_at = ?, is_active = 0 WHERE id = ?").bind(completedAt, task.id).run();
    
    // Check if linked to launch checklist
    const checklistItem = await env.DB.prepare("SELECT * FROM launch_checklist WHERE task_id = ?").bind(task.id).first();
    if (checklistItem) {
      await env.DB.prepare("UPDATE launch_checklist SET completed = 1, completed_at = ? WHERE id = ?").bind(completedAt, checklistItem.id).run();
    }
    
    const daysToComplete = Math.round((Date.now() - new Date(task.created_at).getTime()) / 86400000);
    await logEvent(env, getCurrentUser(), 'completed', task.id, { text: task.text, daysToComplete, focusLevel: task.focus_level, category: task.category });
    await updateDailyLog(env, getCurrentUser(), 'tasks_completed');
    await autoCheckpoint(env, getCurrentUser(), 'task_completed', `Completed: ${task.text}`, [task.category || task.project || 'general'], task.id);
    
    let resp = '✅ Completed: "' + task.text + '"';
    if (daysToComplete === 0) resp += '\n⚡ Same-day completion!';
    else if (daysToComplete <= 1) resp += '\n🎯 Quick turnaround!';
    if (checklistItem) resp += '\n📋 Launch checklist item also marked complete';
    
    // Handle recurring task
    if (task.recurrence) {
      const nextDue = getNextDueDate(task.due_date, task.recurrence);
      const newId = crypto.randomUUID();
      const ts = new Date().toISOString();
      
      await env.DB.prepare(
        'INSERT INTO tasks (id, user_id, text, priority, due_date, category, project, status, created_at, last_touched, focus_level, notes, recurrence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(newId, task.user_id, task.text, task.priority, nextDue, task.category, task.project, 'open', ts, ts, task.focus_level, task.notes, task.recurrence).run();
      
      await logEvent(env, task.user_id, 'created', newId, { text: task.text, recurrence: task.recurrence, source: 'recurring' });
      resp += '\n🔄 Next occurrence created for ' + nextDue;
    }
    
    return { content: [{ type: "text", text: resp }] };
  });

  server.tool("log_progress", {
    description: z.string(),
    task_id: z.string().optional(),
    minutes_spent: z.number().optional(),
  }, async ({ description, task_id, minutes_spent }) => {
    await env.DB.prepare(
      'INSERT INTO progress_logs (id, user_id, logged_at, task_id, description, minutes_spent, was_planned) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), getCurrentUser(), new Date().toISOString(), task_id || null, description, minutes_spent || null, task_id ? 1 : 0).run();
    
    await logEvent(env, getCurrentUser(), 'progress', task_id || null, { description, minutes_spent });
    return { content: [{ type: "text", text: '📝 Logged: ' + description }] };
  });

  server.tool("get_daily_summary", {}, async () => {
    const today = new Date().toISOString().split('T')[0];
    
    const open = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open'").bind(getCurrentUser()).all();
    const done = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'done' AND DATE(completed_at) = ?").bind(getCurrentUser(), today).first();
    const progress = await env.DB.prepare("SELECT COUNT(*) as c FROM progress_logs WHERE user_id = ? AND DATE(logged_at) = ?").bind(getCurrentUser(), today).first();
    
    const patterns = await getPatterns(env, getCurrentUser());
    const nudges = generateNudges(patterns, open.results);
    
    const upcoming = open.results.filter((t: any) => t.due_date).sort((a: any, b: any) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
    const highPriority = open.results.filter((t: any) => t.priority >= 4);
    const activeTasks = open.results.filter((t: any) => t.is_active || t.objective_id);
    const suggestedTask = activeTasks[0] || upcoming[0] || highPriority[0] || open.results[0];
    
    const activeSprint = await env.DB.prepare("SELECT * FROM sprints WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").bind(getCurrentUser()).first();
    const activeLaunch = await env.DB.prepare("SELECT * FROM launch_projects WHERE user_id = ? AND status != 'complete' ORDER BY updated_at DESC LIMIT 1").bind(getCurrentUser()).first();
    
    const recurringCount = open.results.filter((t: any) => t.recurrence).length;
    const incomingCount = open.results.filter((t: any) => t.assigned_by).length;
    const activeCount = open.results.filter((t: any) => t.is_active || t.objective_id).length;
    
    let output = '📋 **Daily Summary - ' + getDayOfWeek().charAt(0).toUpperCase() + getDayOfWeek().slice(1) + '**\n\n';
    output += '✅ Completed today: ' + (done?.c || 0) + '\n';
    output += '📝 Progress logged: ' + (progress?.c || 0) + ' entries\n';
    output += '📬 Open tasks: ' + open.results.length;
    if (activeCount > 0) output += ' (🎯 ' + activeCount + ' active)';
    if (recurringCount > 0) output += ' (' + recurringCount + ' recurring)';
    if (incomingCount > 0) output += ' (📥 ' + incomingCount + ' incoming)';
    output += '\n';
    
    if (activeSprint) {
      const daysRemaining = Math.ceil((new Date(activeSprint.end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      output += '\n📋 **Active Sprint:** ' + activeSprint.name + ' (' + daysRemaining + ' days remaining)\n';
    }
    
    if (activeLaunch) {
      const daysToLaunch = activeLaunch.target_launch_date ? Math.ceil((new Date(activeLaunch.target_launch_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;
      output += '\n🚀 **Active Launch:** ' + activeLaunch.title;
      if (daysToLaunch !== null) output += ' (' + daysToLaunch + ' days)';
      output += '\n   Phase: ' + activeLaunch.current_phase;
    }
    
    if (nudges.length > 0) {
      output += '\n\n**💡 Nudges:**\n';
      nudges.forEach(n => { output += n + '\n'; });
    }
    
    if (suggestedTask) {
      output += '\n**Suggested focus:** ' + suggestedTask.text;
      if (suggestedTask.due_date) output += ' (due ' + suggestedTask.due_date + ')';
      if (suggestedTask.recurrence) output += ' 🔄';
      if (suggestedTask.is_active || suggestedTask.objective_id) output += ' 🎯';
    }
    
    return { content: [{ type: "text", text: output }] };
  });

  server.tool("analyze_patterns", {}, async () => {
    const insights = await analyzeAndStorePatterns(env, getCurrentUser());
    if (insights.length === 0) return { content: [{ type: "text", text: "📊 Not enough data yet. Keep using the system and check back in a week!" }] };
    
    let output = '📊 **Your Productivity Patterns**\n\n';
    insights.forEach(i => { output += '• ' + i + '\n'; });
    return { content: [{ type: "text", text: output }] };
  });

  server.tool("get_insights", {}, async () => {
    const patterns = await getPatterns(env, getCurrentUser());
    const open = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open'").bind(getCurrentUser()).all();
    
    if (patterns.length === 0) return { content: [{ type: "text", text: "💡 No patterns learned yet. Run analyze_patterns after a week of use!" }] };
    
    let output = '💡 **Insights**\n\n';
    for (const pattern of patterns) {
      const data = JSON.parse(pattern.pattern_data);
      switch (pattern.pattern_type) {
        case 'peak_time': output += '⏰ You\'re most productive in the ' + data.time + '\n'; break;
        case 'peak_day': output += '📅 ' + data.day.charAt(0).toUpperCase() + data.day.slice(1) + 's are your power days\n'; break;
        case 'avg_completion_days': output += '⏱️ You complete tasks in ' + data.days + ' days on average\n'; break;
        case 'avoidance_category': output += '⚠️ You tend to delay ' + data.category + ' tasks\n'; break;
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
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    const session = await env.DB.prepare('SELECT * FROM work_sessions WHERE user_id = ? AND session_date = ?').bind(getCurrentUser(), today).first();
    const checkpoints = await env.DB.prepare('SELECT * FROM checkpoints WHERE user_id = ? AND DATE(checkpoint_time) = ? ORDER BY checkpoint_time ASC').bind(getCurrentUser(), today).all();
    const completed = await env.DB.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = \'done\' AND DATE(completed_at) = ? ORDER BY completed_at ASC').bind(getCurrentUser(), today).all();
    const added = await env.DB.prepare('SELECT * FROM tasks WHERE user_id = ? AND DATE(created_at) = ?').bind(getCurrentUser(), today).all();
    const progressLogs = await env.DB.prepare('SELECT * FROM progress_logs WHERE user_id = ? AND DATE(logged_at) = ?').bind(getCurrentUser(), today).all();
    
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const yesterdayCompleted = await env.DB.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = \'done\' AND DATE(completed_at) = ?').bind(getCurrentUser(), yesterday).first();
    
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const weekStats = await env.DB.prepare('SELECT COUNT(*) as total, COUNT(DISTINCT DATE(completed_at)) as days FROM tasks WHERE user_id = ? AND status = \'done\' AND DATE(completed_at) >= ?').bind(getCurrentUser(), weekAgo).first();
    const weeklyAvg = weekStats?.days > 0 ? Math.round(weekStats.total / weekStats.days) : 0;
    
    let out = '📊 **End of Day Recap**\n\n';
    
    if (session) {
      const startTime = new Date(session.started_at);
      const endTime = session.ended_at ? new Date(session.ended_at) : now;
      const totalMinutes = Math.round((endTime.getTime() - startTime.getTime()) / (1000 * 60));
      const hours = Math.floor(totalMinutes / 60);
      const mins = totalMinutes % 60;
      out += '⏱️ **Time:** ' + hours + 'h ' + mins + 'm (' + startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      out += session.ended_at ? ' → ' + endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ')' : ' → now)';
      out += '\n\n';
    }
    
    const nonMorningCheckpoints = (checkpoints.results as any[]).filter(c => c.trigger_type !== 'morning' && c.trigger_type !== 'night');
    if (nonMorningCheckpoints.length > 0) {
      out += '**Today\'s Flow:**\n';
      out += nonMorningCheckpoints.map((c: any) => c.summary).join(' → ') + '\n\n';
    }
    
    out += '**Stats:**\n• ✅ Completed: ' + completed.results.length;
    if (yesterdayCompleted?.count !== undefined) {
      const diff = completed.results.length - yesterdayCompleted.count;
      if (diff > 0) out += ' (+' + diff + ' vs yesterday)';
      else if (diff < 0) out += ' (' + diff + ' vs yesterday)';
    }
    out += '\n• ➕ Added: ' + added.results.length + '\n• 📍 Checkpoints: ' + checkpoints.results.length + '\n';
    
    if (progressLogs.results.length > 0) {
      const totalLoggedMinutes = (progressLogs.results as any[]).reduce((sum, p) => sum + (p.minutes_spent || 0), 0);
      if (totalLoggedMinutes > 0) out += '• 📝 Logged work: ' + Math.round(totalLoggedMinutes / 60) + 'h ' + (totalLoggedMinutes % 60) + 'm\n';
    }
    
    const net = completed.results.length - added.results.length;
    if (net > 0) out += '\n📈 **Net: +' + net + '** — Burned down the list!\n';
    else if (net < 0) out += '\n📊 **Net: ' + net + '** — Expanded scope today\n';
    else if (completed.results.length > 0) out += '\n📊 **Net: 0** — Balanced day\n';
    
    if (weeklyAvg > 0) {
      const vsAvg = completed.results.length - weeklyAvg;
      if (vsAvg > 0) out += 'Above your weekly average (+' + vsAvg + ')\n';
      else if (vsAvg < 0) out += 'Below your weekly average (' + vsAvg + ')\n';
    }
    
    const allTopics = new Set<string>();
    for (const c of checkpoints.results as any[]) {
      JSON.parse(c.topics || '[]').forEach((t: string) => { if (t !== 'day_start') allTopics.add(t); });
    }
    if (allTopics.size > 0) out += '\n**Topics:** ' + Array.from(allTopics).join(', ') + '\n';
    
    const categories: Record<string, number> = {};
    for (const t of completed.results as any[]) { const cat = t.category || 'Uncategorized'; categories[cat] = (categories[cat] || 0) + 1; }
    if (Object.keys(categories).length > 1) {
      out += '\n**By category:**\n';
      for (const [cat, count] of Object.entries(categories)) out += '• ' + cat + ': ' + count + '\n';
    }
    
    if (completed.results.length > 0) {
      out += '\n**Completed:**\n';
      for (const t of completed.results as any[]) {
        let line = '• ' + t.text;
        if (t.recurrence) line += ' 🔄';
        out += line + '\n';
      }
    }
    
    const discoveries = (checkpoints.results as any[]).filter(c => c.discoveries).map(c => c.discoveries);
    if (discoveries.length > 0) {
      out += '\n**Discoveries:**\n';
      discoveries.forEach(d => { out += '• ' + d + '\n'; });
    }
    
    const dueSoon = await env.DB.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = \'open\' AND due_date IS NOT NULL AND due_date <= date(\'now\', \'+3 days\') ORDER BY due_date ASC').bind(getCurrentUser()).all();
    if (dueSoon.results.length > 0) {
      out += '\n**⚠️ Due soon:**\n';
      for (const t of dueSoon.results.slice(0, 3) as any[]) out += '• ' + t.text + ' (' + t.due_date + ')' + (t.recurrence ? ' 🔄' : '') + '\n';
    }
    
    if (completed.results.length === 0 && checkpoints.results.length === 0 && progressLogs.results.length === 0) {
      out = '📊 **End of Day Recap**\n\nNo activity tracked today.\n\n💡 Start tomorrow with "good morning" to track your work day!';
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("weekly_recap", {}, async () => {
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - now.getDay() + 1);
    monday.setHours(0,0,0,0);
    
    const done = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at >= ?").bind(getCurrentUser(), monday.toISOString()).first();
    const added = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND created_at >= ?").bind(getCurrentUser(), monday.toISOString()).first();
    const dailyStats = await env.DB.prepare('SELECT log_date, tasks_completed, tasks_created FROM daily_logs WHERE user_id = ? AND log_date >= ? ORDER BY log_date').bind(getCurrentUser(), monday.toISOString().split('T')[0]).all();
    
    let recap = '📊 Weekly Recap\n\n✅ Completed: ' + (done?.c || 0) + '\n➕ Added: ' + (added?.c || 0);
    if (dailyStats.results.length > 0) {
      recap += '\n\n**By day:**\n';
      dailyStats.results.forEach((d: any) => { recap += d.log_date + ': ' + d.tasks_completed + ' done, ' + d.tasks_created + ' added\n'; });
    }
    
    return { content: [{ type: "text", text: recap }] };
  });

  server.tool("plan_week", {
    focus_level: z.enum(["high", "normal", "low"]).optional().default("normal"),
    constraints: z.string().optional(),
  }, async ({ focus_level, constraints }) => {
    const tasks = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open' ORDER BY priority DESC, due_date ASC").bind(getCurrentUser()).all();
    const patterns = await getPatterns(env, getCurrentUser());
    
    let plan = '📅 Week Plan\n\nFocus level: ' + focus_level + '\n';
    if (constraints) plan += 'Constraints: ' + constraints + '\n';
    
    const peakDayPattern = patterns.find(p => p.pattern_type === 'peak_day');
    if (peakDayPattern) plan += '\n💪 Your power day: ' + JSON.parse(peakDayPattern.pattern_data).day + '\n';
    
    plan += '\n**Open tasks:** ' + tasks.results.length + '\n';
    
    const recurringTasks = tasks.results.filter((t: any) => t.recurrence);
    if (recurringTasks.length > 0) plan += '**Recurring:** ' + recurringTasks.length + ' tasks\n';
    
    const activeTasks = tasks.results.filter((t: any) => t.is_active || t.objective_id);
    if (activeTasks.length > 0) plan += '**Active:** ' + activeTasks.length + ' tasks 🎯\n';
    
    const now = new Date();
    const urgent = tasks.results.filter((t: any) => {
      if (!t.due_date) return t.priority >= 4;
      return (new Date(t.due_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24) <= 3;
    });
    
    if (urgent.length > 0) {
      plan += '\n🔴 **Urgent this week:**\n';
      urgent.slice(0, 5).forEach((t: any) => { 
        plan += '• ' + t.text;
        if (t.due_date) plan += ' (due ' + t.due_date + ')';
        if (t.recurrence) plan += ' 🔄';
        plan += '\n';
      });
    }
    
    const activeSprint = await env.DB.prepare("SELECT * FROM sprints WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").bind(getCurrentUser()).first();
    if (activeSprint) {
      plan += '\n📋 **Active Sprint:** ' + activeSprint.name + '\n   Ends: ' + activeSprint.end_date + '\n';
    }
    
    const activeLaunches = await env.DB.prepare("SELECT * FROM launch_projects WHERE user_id = ? AND status != 'complete'").bind(getCurrentUser()).all();
    if (activeLaunches.results.length > 0) {
      plan += '\n🚀 **Active Launches:**\n';
      for (const launch of activeLaunches.results as any[]) {
        const daysToLaunch = launch.target_launch_date ? Math.ceil((new Date(launch.target_launch_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : null;
        plan += '• ' + launch.title + ' - Phase: ' + launch.current_phase;
        if (daysToLaunch !== null) plan += ' (' + daysToLaunch + ' days)';
        plan += '\n';
      }
    }
    
    if (focus_level === 'low') {
      plan += '\n⚠️ Low focus week - stick to quick wins and essentials only';
      const quickWins = tasks.results.filter((t: any) => t.focus_level === 'low');
      if (quickWins.length > 0) {
        plan += '\n\n**Quick wins available:**\n';
        quickWins.slice(0, 3).forEach((t: any) => { plan += '• ' + t.text + '\n'; });
      }
    }
    
    return { content: [{ type: "text", text: plan }] };
  });

  server.tool("break_down_task", {
    task_id: z.string(),
    subtasks: z.array(z.string()),
  }, async ({ task_id, subtasks }) => {
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
    
    await env.DB.prepare("UPDATE tasks SET needs_breakdown = 0 WHERE id = ?").bind(task_id).run();
    await logEvent(env, parent.user_id, 'broken_down', task_id, { subtaskCount: subtasks.length });
    
    return { content: [{ type: "text", text: 'Broke down into ' + subtasks.length + ' subtasks' }] };
  });

  server.tool("delete_task", { task_id: z.string() }, async ({ task_id }) => {
    const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(task_id).first();
    if (!task) return { content: [{ type: "text", text: "Not found" }] };
    
    await logEvent(env, getCurrentUser(), 'deleted', task_id, { text: task.text });
    await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(task_id).run();
    
    return { content: [{ type: "text", text: '🗑️ Deleted: "' + task.text + '"' }] };
  });

  server.tool("update_task", {
    task_id: z.string(),
    priority: z.number().min(1).max(5).optional(),
    due_date: z.string().optional(),
    category: z.string().optional(),
    notes: z.string().optional(),
    recurrence: z.string().optional().describe("daily, weekdays, weekly, biweekly, monthly, yearly, or specific days like 'mon,thu'. Set to empty string to remove recurrence."),
  }, async ({ task_id, priority, due_date, category, notes, recurrence }) => {
    const updates: string[] = [];
    const bindings: any[] = [];
    const changes: any = {};
    
    if (priority !== undefined) { updates.push("priority = ?"); bindings.push(priority); changes.priority = priority; }
    if (due_date !== undefined) { updates.push("due_date = ?"); bindings.push(due_date); changes.due_date = due_date; }
    if (category !== undefined) { updates.push("category = ?"); bindings.push(category); changes.category = category; }
    if (notes !== undefined) { updates.push("notes = ?"); bindings.push(notes); changes.notes = notes; }
    if (recurrence !== undefined) { updates.push("recurrence = ?"); bindings.push(recurrence === '' ? null : recurrence); changes.recurrence = recurrence; }
    
    if (updates.length === 0) return { content: [{ type: "text", text: "No updates" }] };
    
    updates.push("last_touched = ?");
    bindings.push(new Date().toISOString());
    bindings.push(task_id);
    
    await env.DB.prepare('UPDATE tasks SET ' + updates.join(', ') + ' WHERE id = ?').bind(...bindings).run();
    await logEvent(env, getCurrentUser(), 'updated', task_id, changes);
    
    let resp = "✏️ Updated";
    if (recurrence !== undefined) resp += recurrence ? ' (now recurring: ' + recurrence + ')' : ' (recurrence removed)';
    
    return { content: [{ type: "text", text: resp }] };
  });

  server.tool("snooze_task", {
    task_id: z.string(),
    until: z.string().optional(),
    days: z.number().optional(),
  }, async ({ task_id, until, days }) => {
    const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(task_id).first();
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    
    let snoozeUntil: string;
    if (until) snoozeUntil = until;
    else if (days) { const d = new Date(); d.setDate(d.getDate() + days); snoozeUntil = d.toISOString().split('T')[0]; }
    else { const d = new Date(); d.setDate(d.getDate() + 1); snoozeUntil = d.toISOString().split('T')[0]; }
    
    await env.DB.prepare("UPDATE tasks SET snoozed_until = ?, last_touched = ? WHERE id = ?").bind(snoozeUntil, new Date().toISOString(), task_id).run();
    await logEvent(env, getCurrentUser(), 'snoozed', task_id, { until: snoozeUntil });
    
    return { content: [{ type: "text", text: '😴 Snoozed until ' + snoozeUntil + ': "' + task.text + '"' }] };
  });

  server.tool("get_stats", {}, async () => {
    const total = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ?").bind(getCurrentUser()).first();
    const open = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'open'").bind(getCurrentUser()).first();
    const done = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'done'").bind(getCurrentUser()).first();
    const recurring = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'open' AND recurrence IS NOT NULL").bind(getCurrentUser()).first();
    const active = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'open' AND (is_active = 1 OR objective_id IS NOT NULL)").bind(getCurrentUser()).first();
    
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekDone = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at >= ?").bind(getCurrentUser(), weekAgo).first();
    
    let stats = '📊 Stats\n\nTotal: ' + (total?.c || 0) + '\nOpen: ' + (open?.c || 0) + '\nActive: ' + (active?.c || 0) + ' 🎯\nDone: ' + (done?.c || 0) + '\nRecurring: ' + (recurring?.c || 0) + ' 🔄\n\nLast 7 days: ' + (weekDone?.c || 0) + ' completed';
    if (total?.c > 0) stats += '\nCompletion rate: ' + Math.round((done?.c || 0) / total.c * 100) + '%';
    
    return { content: [{ type: "text", text: stats }] };
  });

  server.tool("get_challenges", {}, async () => {
    const cold = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND julianday('now') - julianday(created_at) >= 7").bind(getCurrentUser()).all();
    const vague = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND is_vague = 1").bind(getCurrentUser()).all();
    const needsBreaking = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND needs_breakdown = 1").bind(getCurrentUser()).all();
    
    let out = '🎯 **Challenges**\n\n';
    
    if (cold.results.length > 0) {
      out += '❄️ **Cold Tasks** (' + cold.results.length + '):\n';
      cold.results.slice(0, 5).forEach((t: any) => { out += '• ' + t.text + '\n'; });
      out += '\n';
    }
    
    if (vague.results.length > 0) {
      out += '💭 **Vague Tasks** (' + vague.results.length + '):\n';
      vague.results.slice(0, 5).forEach((t: any) => { out += '• ' + t.text + '\n'; });
      out += '\n';
    }
    
    if (needsBreaking.results.length > 0) {
      out += '🔨 **Needs Breakdown** (' + needsBreaking.results.length + '):\n';
      needsBreaking.results.slice(0, 5).forEach((t: any) => { out += '• ' + t.text + '\n'; });
    }
    
    if (cold.results.length === 0 && vague.results.length === 0 && needsBreaking.results.length === 0) {
      out = '🎉 No challenges right now! Your task list is in good shape.';
    }
    
    return { content: [{ type: "text", text: out }] };
  });
}
