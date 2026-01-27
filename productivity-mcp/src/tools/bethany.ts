import { z } from "zod";
import { ToolContext } from '../types';
import { formatSprintHeader } from './sprints';

// Central Time helper
function formatCentralTime(date: Date, options?: Intl.DateTimeFormatOptions): string {
  return date.toLocaleString('en-US', { timeZone: 'America/Chicago', ...options });
}

function getCentralTime(date: Date): { time: string; date: string; dayName: string; dayShort: string } {
  return {
    time: formatCentralTime(date, { hour: 'numeric', minute: '2-digit', hour12: true }),
    date: formatCentralTime(date, { month: 'short', day: 'numeric' }),
    dayName: formatCentralTime(date, { weekday: 'long' }),
    dayShort: formatCentralTime(date, { weekday: 'short' }).toUpperCase().slice(0, 2),
  };
}

export function registerBethanyTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool("good_morning", {
    notes: z.string().optional().describe("Any context about today - energy level, focus, constraints"),
  }, async ({ notes }) => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const ts = now.toISOString();
    const central = getCentralTime(now);
    const dayOfWeek = now.getDay();
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    
    const existing = await env.DB.prepare('SELECT * FROM work_sessions WHERE user_id = ? AND session_date = ?').bind(getCurrentUser(), today).first();
    
    let sessionId: string;
    if (existing) {
      sessionId = existing.id;
      await env.DB.prepare('UPDATE work_sessions SET started_at = ? WHERE id = ?').bind(ts, sessionId).run();
    } else {
      sessionId = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO work_sessions (id, user_id, session_date, started_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(sessionId, getCurrentUser(), today, ts, ts).run();
    }
    
    await env.DB.prepare('INSERT INTO checkpoints (id, user_id, session_id, checkpoint_time, trigger_type, summary, topics, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), getCurrentUser(), sessionId, ts, 'morning', notes || 'Started work day', JSON.stringify(['day_start']), ts).run();
    
    const activeSprint = await env.DB.prepare("SELECT * FROM sprints WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").bind(getCurrentUser()).first();
    
    let sprintObjectives: any[] = [];
    let sprintTasks: Map<string, any[]> = new Map();
    if (activeSprint) {
      const objectives = await env.DB.prepare('SELECT * FROM objectives WHERE sprint_id = ? ORDER BY sort_order ASC').bind(activeSprint.id).all();
      sprintObjectives = objectives.results as any[];
      
      for (const obj of sprintObjectives) {
        const tasks = await env.DB.prepare("SELECT * FROM tasks WHERE objective_id = ? AND user_id = ? AND status = 'open' ORDER BY priority DESC, created_at ASC").bind(obj.id, getCurrentUser()).all();
        sprintTasks.set(obj.id, tasks.results as any[]);
      }
    }
    
    const allTasks = await env.DB.prepare(`SELECT t.*, o.statement as objective_statement FROM tasks t LEFT JOIN objectives o ON t.objective_id = o.id WHERE t.user_id = ? AND t.status = 'open' AND (t.snoozed_until IS NULL OR t.snoozed_until <= ?) ORDER BY t.priority DESC, t.due_date ASC NULLS LAST, t.created_at ASC`).bind(getCurrentUser(), today).all();
    
    const active: any[] = [], incoming: any[] = [], overdue: any[] = [], dueToday: any[] = [], routines: any[] = [], comingUp: any[] = [], backlog: any[] = [];
    
    for (const t of allTasks.results as any[]) {
      const dueDate = t.due_date ? t.due_date.split('T')[0] : null;
      const hasRecurrence = !!t.recurrence;
      const rec = (t.recurrence || '').toLowerCase();
      
      if (t.is_active || t.objective_id) { active.push(t); continue; }
      if (t.assigned_by) { incoming.push(t); continue; }
      
      let isRoutineToday = false;
      if (hasRecurrence) {
        if (rec === 'daily') isRoutineToday = true;
        else if (rec === 'weekdays' && isWeekday) isRoutineToday = true;
        else if (rec === 'weekly' && dueDate) { if (new Date(t.due_date).getDay() === dayOfWeek) isRoutineToday = true; }
        else if (rec.includes(central.dayShort.toLowerCase())) isRoutineToday = true;
      }
      
      if (dueDate && dueDate < today && !hasRecurrence) overdue.push(t);
      else if (dueDate === today && !hasRecurrence) dueToday.push(t);
      else if (isRoutineToday) routines.push(t);
      else if (dueDate && dueDate > today) {
        const daysUntil = Math.ceil((new Date(dueDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        if (daysUntil <= 7) comingUp.push({ ...t, daysUntil }); else backlog.push(t);
      } else backlog.push(t);
    }
    
    const backlogByCategory: Record<string, any[]> = {};
    for (const t of backlog) { const cat = t.category || t.project || 'General'; if (!backlogByCategory[cat]) backlogByCategory[cat] = []; backlogByCategory[cat].push(t); }
    
    const launches = await env.DB.prepare(`SELECT lp.*, (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id) as total_items, (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id AND completed = 1) as done_items, (SELECT MAX(completed_at) FROM launch_checklist WHERE project_id = lp.id AND completed = 1) as last_activity FROM launch_projects lp WHERE lp.user_id = ? AND lp.status != 'complete' ORDER BY lp.target_launch_date ASC NULLS LAST`).bind(getCurrentUser()).all();
    const handoffs = await env.DB.prepare(`SELECT h.*, t.text as task_text FROM handoff_suggestions h JOIN tasks t ON h.task_id = t.id WHERE h.to_user = ? AND h.status = 'pending'`).bind(getCurrentUser()).all();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const yesterdayDone = await env.DB.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = "done" AND DATE(completed_at) = ?').bind(getCurrentUser(), yesterday).first();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const recentCheckins = await env.DB.prepare('SELECT thread_summary, project_name, created_at FROM check_ins WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 5').bind(getCurrentUser(), twentyFourHoursAgo).all();
    const lastCheckpoint = await env.DB.prepare(`SELECT * FROM checkpoints WHERE user_id = ? AND trigger_type = 'night' ORDER BY checkpoint_time DESC LIMIT 1`).bind(getCurrentUser()).first();
    
    let out = `☀️ **Good Morning!** (${central.dayName}, ${central.date})\n⏰ Clocked in: ${central.time} Central\n`;
    if (notes) out += `💭 ${notes}\n`;
    
    if (recentCheckins.results.length > 0) {
      out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📍 WHERE YOU LEFT OFF (last 24h)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      for (const c of recentCheckins.results as any[]) {
        const timeStr = formatCentralTime(new Date(c.created_at), { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
        out += `**${timeStr}**${c.project_name ? ` • ${c.project_name}` : ''}\n${c.thread_summary}\n\n`;
      }
    } else if (lastCheckpoint) {
      out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📍 WHERE YOU LEFT OFF\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${(lastCheckpoint as any).summary}\n`;
    }
    
    out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎯 ACTIVE (${active.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (active.length === 0) out += `(none)\n💡 Use \`activate_task\` to add tasks here, or build a sprint.\n`;
    else for (const t of active) out += `${t.priority >= 4 ? '🔴' : t.priority === 3 ? '🟡' : '⚪'} ${t.text}${t.objective_statement ? ` → ${t.objective_statement}` : ''}\n`;
    
    if (activeSprint && sprintObjectives.length > 0) {
      out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📋 SPRINT: ${activeSprint.name}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      out += `⏳ ${Math.ceil((new Date(activeSprint.end_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))} days remaining (ends ${activeSprint.end_date})\n\n`;
      let totalTasks = 0, completedTasks = 0;
      for (const obj of sprintObjectives) {
        const objTasksOpen = sprintTasks.get(obj.id) || [];
        const objTasksDone = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE objective_id = ? AND user_id = ? AND status = 'done'").bind(obj.id, getCurrentUser()).first();
        const done = objTasksDone?.c || 0, total = objTasksOpen.length + done;
        totalTasks += total; completedTasks += done;
        out += `${done === total && total > 0 ? '✅' : done > 0 ? '◐' : '○'} ${obj.statement}${total > 0 ? ` (${done}/${total})` : ''}\n`;
      }
      out += `\n📊 Sprint progress: ${completedTasks}/${totalTasks} tasks (${totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0}%)\n`;
    } else if (!activeSprint) {
      out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📋 NO ACTIVE SPRINT\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Want to work more intentionally? Say "let's build a sprint"\n`;
    }
    
    if (incoming.length > 0) { out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📥 INCOMING (${incoming.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`; for (const t of incoming) out += `• ${t.text} (from ${t.assigned_by})\n`; out += `\n💡 Use \`claim_task\` to move these to your list.\n`; }
    
    out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🚨 OVERDUE (${overdue.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (overdue.length === 0) out += `(none)\n`; else for (const t of overdue) out += `• ${t.text} (was due ${t.due_date.split('T')[0]})${t.category ? ` [${t.category}]` : ''}\n`;
    
    out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📅 DUE TODAY (${dueToday.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (dueToday.length === 0) out += `(none)\n`; else for (const t of dueToday) out += `• ${t.text}${t.category ? ` [${t.category}]` : ''}\n`;
    
    out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔄 ROUTINES - ${central.dayName} (${routines.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (routines.length === 0) out += `(none)\n`; else for (const t of routines) out += `• ${t.text} (${t.recurrence})\n`;
    
    out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📆 COMING UP - next 7 days (${comingUp.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (comingUp.length === 0) out += `(none)\n`; else for (const t of comingUp) out += `• ${t.text} (${t.due_date.split('T')[0]})${t.category ? ` [${t.category}]` : ''}\n`;
    
    out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📋 BACKLOG (${backlog.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (backlog.length === 0) out += `(none)\n`;
    else { for (const [category, tasks] of Object.entries(backlogByCategory).sort((a, b) => b[1].length - a[1].length)) { out += `\n**[${category}]** (${tasks.length})\n`; for (const t of tasks) out += `${t.priority >= 4 ? '🔴' : t.priority === 3 ? '🟡' : ''}• ${t.text}\n`; } }
    
    out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🚀 LAUNCHES (${launches.results.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (launches.results.length === 0) out += `(none)\n`;
    else for (const lp of launches.results as any[]) { const pct = lp.total_items > 0 ? Math.round((lp.done_items / lp.total_items) * 100) : 0; const daysSince = lp.last_activity ? Math.floor((now.getTime() - new Date(lp.last_activity).getTime()) / (1000 * 60 * 60 * 24)) : 999; out += `• ${lp.title} — ${pct}% (${lp.done_items}/${lp.total_items})${daysSince >= 7 ? ' ⚠️ stalled' : daysSince >= 4 ? ' ⚠️ slowing' : ''}\n`; }
    
    if (handoffs.results.length > 0) { out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📬 HANDOFFS WAITING (${handoffs.results.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`; for (const h of handoffs.results as any[]) out += `• From ${h.from_user}: "${h.task_text}"\n`; }
    
    out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 ${allTasks.results.length} total tasks`;
    if (yesterdayDone?.count > 0) out += ` • Yesterday: ${yesterdayDone.count} completed`;
    if (active.length > 0) out += `\n\n💬 **Ready to continue with your active tasks?**`;
    else if (activeSprint) out += `\n\n💬 **What do you want to activate from your sprint today?**`;
    else out += `\n\n💬 **What do you want to focus on today?**`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("set_focus", { focus: z.string().describe("What you want to focus on - category, project, 'overdue', 'active', specific tasks, or description") }, async ({ focus }) => {
    const now = new Date(); const today = now.toISOString().split('T')[0]; const central = getCentralTime(now); const focusLower = focus.toLowerCase();
    const allTasks = await env.DB.prepare(`SELECT t.*, o.statement as objective_statement FROM tasks t LEFT JOIN objectives o ON t.objective_id = o.id WHERE t.user_id = ? AND t.status = 'open' AND (t.snoozed_until IS NULL OR t.snoozed_until <= ?) ORDER BY t.priority DESC, t.due_date ASC NULLS LAST, t.created_at ASC`).bind(getCurrentUser(), today).all();
    let focusedTasks: any[] = [], focusTitle = '';
    if (focusLower === 'active') { focusTitle = 'Active Tasks'; focusedTasks = (allTasks.results as any[]).filter(t => t.is_active || t.objective_id); }
    else if (focusLower === 'overdue') { focusTitle = 'Overdue Tasks'; focusedTasks = (allTasks.results as any[]).filter(t => t.due_date && t.due_date.split('T')[0] < today); }
    else if (focusLower === 'today' || focusLower === 'due today') { focusTitle = 'Due Today'; focusedTasks = (allTasks.results as any[]).filter(t => t.due_date && t.due_date.split('T')[0] === today); }
    else if (focusLower === 'incoming') { focusTitle = 'Incoming Tasks'; focusedTasks = (allTasks.results as any[]).filter(t => t.assigned_by); }
    else if (focusLower === 'routines' || focusLower === 'recurring') { focusTitle = 'Daily Routines'; const dow = now.getDay(), wd = dow >= 1 && dow <= 5; focusedTasks = (allTasks.results as any[]).filter(t => { if (!t.recurrence) return false; const r = t.recurrence.toLowerCase(); return r === 'daily' || (r === 'weekdays' && wd) || r.includes(central.dayShort.toLowerCase()); }); }
    else { focusTitle = focus; focusedTasks = (allTasks.results as any[]).filter(t => { const cat = (t.category || '').toLowerCase(), proj = (t.project || '').toLowerCase(), txt = (t.text || '').toLowerCase(); return cat.includes(focusLower) || proj.includes(focusLower) || txt.includes(focusLower) || focusLower.includes(cat) || focusLower.includes(proj); }); }
    if (focusedTasks.length === 0) return { content: [{ type: "text", text: `No tasks found matching "${focus}".\n\nTry: a category name, project name, "overdue", "today", "active", "incoming", or keywords from task text.` }] };
    focusedTasks.sort((a, b) => { const aO = a.due_date && a.due_date.split('T')[0] < today, bO = b.due_date && b.due_date.split('T')[0] < today; if (aO && !bO) return -1; if (!aO && bO) return 1; if (b.priority !== a.priority) return b.priority - a.priority; if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date); if (a.due_date) return -1; if (b.due_date) return 1; return a.created_at.localeCompare(b.created_at); });
    let out = `🎯 **TODAY'S FOCUS: ${focusTitle}**\n${central.dayName}, ${central.date}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n**Suggested Order:**\n\n`;
    let num = 1; for (const t of focusedTasks) { const pri = t.priority >= 4 ? '🔴' : t.priority === 3 ? '🟡' : '⚪'; let meta = ''; if (t.due_date) { const dd = t.due_date.split('T')[0]; if (dd < today) meta = ` ⚠️ overdue (${dd})`; else if (dd === today) meta = ` 📅 due today`; else meta = ` (due ${dd})`; } if (t.recurrence) meta += ` 🔄${t.recurrence}`; if (t.assigned_by) meta += ` 📥 from ${t.assigned_by}`; if (t.objective_statement) meta += ` → ${t.objective_statement}`; out += `${num}. ${pri} ${t.text}${meta}\n`; num++; }
    out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 ${focusedTasks.length} tasks in focus\n`;
    const hp = focusedTasks.filter(t => t.priority >= 4).length, oc = focusedTasks.filter(t => t.due_date && t.due_date.split('T')[0] < today).length;
    if (oc > 0) out += `\n💡 ${oc} overdue - tackle these first`; if (hp > 0 && hp !== oc) out += `\n💡 ${hp} high priority items`;
    out += `\n\n✅ Use \`complete_task\` as you finish each one!`;
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("good_night", { notes: z.string().optional().describe("Where you left off") }, async ({ notes }) => {
    const now = new Date(); const today = now.toISOString().split('T')[0]; const ts = now.toISOString(); const central = getCentralTime(now);
    const session = await env.DB.prepare('SELECT * FROM work_sessions WHERE user_id = ? AND session_date = ?').bind(getCurrentUser(), today).first();
    if (!session) return { content: [{ type: "text", text: "🌙 No work session found for today. Did you forget to say good morning?" }] };
    const startTime = new Date(session.started_at); const startCentral = getCentralTime(startTime);
    const totalMinutes = Math.round((now.getTime() - startTime.getTime()) / (1000 * 60)); const hours = Math.floor(totalMinutes / 60); const mins = totalMinutes % 60;
    const checkpoints = await env.DB.prepare(`SELECT * FROM checkpoints WHERE user_id = ? AND session_id = ? ORDER BY checkpoint_time ASC`).bind(getCurrentUser(), session.id).all();
    const completed = await env.DB.prepare(`SELECT * FROM tasks WHERE user_id = ? AND status = 'done' AND DATE(completed_at) = ? ORDER BY completed_at ASC`).bind(getCurrentUser(), today).all();
    const added = await env.DB.prepare(`SELECT * FROM tasks WHERE user_id = ? AND DATE(created_at) = ? ORDER BY created_at ASC`).bind(getCurrentUser(), today).all();
    const nonMorning = (checkpoints.results as any[]).filter(c => c.trigger_type !== 'morning');
    let narrative = nonMorning.length > 0 ? nonMorning.map((c: any) => c.summary).join(' → ') : completed.results.length > 0 ? `Completed ${completed.results.length} task(s)` : 'No checkpoints recorded today.';
    const allTopics = new Set<string>(); for (const c of checkpoints.results as any[]) JSON.parse((c as any).topics || '[]').forEach((t: string) => allTopics.add(t)); allTopics.delete('day_start');
    await env.DB.prepare('INSERT INTO checkpoints (id, user_id, session_id, checkpoint_time, trigger_type, summary, topics, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), getCurrentUser(), session.id, ts, 'night', notes || `Wrapped up: ${narrative.slice(0, 200)}`, JSON.stringify(Array.from(allTopics)), ts).run();
    await env.DB.prepare(`UPDATE work_sessions SET ended_at = ?, total_minutes = ?, end_of_day_summary = ? WHERE id = ?`).bind(ts, totalMinutes, narrative, session.id).run();
    let out = `🌙 **End of Day Report**\n${central.dayName}, ${central.date}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⏱️ TIME TRACKED\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nIn:  ${startCentral.time} Central\nOut: ${central.time} Central\n**Total: ${hours}h ${mins}m**\n`;
    out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 STATS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ Completed: ${completed.results.length}\n➕ Added: ${added.results.length}\n📍 Checkpoints: ${checkpoints.results.length}\n`;
    const net = completed.results.length - added.results.length; out += net > 0 ? `📈 Net: +${net} (burned down the list!)\n` : net < 0 ? `📉 Net: ${net} (scope expanded)\n` : `📊 Net: 0 (balanced)\n`;
    if (completed.results.length > 0) { out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ COMPLETED\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`; for (const t of completed.results as any[]) out += `• ${t.text}\n`; }
    if (notes) out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📍 WHERE YOU LEFT OFF\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${notes}\n`;
    const activeSprint = await env.DB.prepare("SELECT * FROM sprints WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").bind(getCurrentUser()).first();
    if (activeSprint) {
      const objectives = await env.DB.prepare('SELECT * FROM objectives WHERE sprint_id = ? ORDER BY sort_order ASC').bind(activeSprint.id).all();
      let totalTasks = 0, completedTasks = 0;
      for (const obj of objectives.results as any[]) {
        const openCount = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE objective_id = ? AND user_id = ? AND status = 'open'").bind(obj.id, getCurrentUser()).first();
        const doneCount = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE objective_id = ? AND user_id = ? AND status = 'done'").bind(obj.id, getCurrentUser()).first();
        totalTasks += (openCount?.c || 0) + (doneCount?.c || 0); completedTasks += (doneCount?.c || 0);
      }
      out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📋 SPRINT STATUS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${activeSprint.name}: ${completedTasks}/${totalTasks} tasks (${totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0}%)\n⏳ ${Math.ceil((new Date(activeSprint.end_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))} days remaining\n`;
    }
    out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🌟 Good work today!`;
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("checkpoint", { summary: z.string().describe("1-2 sentence summary"), topics: z.array(z.string()).optional(), discoveries: z.string().optional(), task_ids: z.array(z.string()).optional(), trigger: z.enum(['task_added', 'task_completed', 'topic_shift', 'manual', 'auto']).optional().default('auto') }, async ({ summary, topics, discoveries, task_ids, trigger }) => {
    const now = new Date(); const today = now.toISOString().split('T')[0]; const ts = now.toISOString();
    let session = await env.DB.prepare('SELECT * FROM work_sessions WHERE user_id = ? AND session_date = ?').bind(getCurrentUser(), today).first(); let sessionId: string;
    if (!session) { sessionId = crypto.randomUUID(); await env.DB.prepare('INSERT INTO work_sessions (id, user_id, session_date, started_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(sessionId, getCurrentUser(), today, ts, ts).run(); } else sessionId = session.id;
    await env.DB.prepare('INSERT INTO checkpoints (id, user_id, session_id, checkpoint_time, trigger_type, summary, topics, discoveries, task_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), getCurrentUser(), sessionId, ts, trigger, summary, JSON.stringify(topics || []), discoveries || null, JSON.stringify(task_ids || []), ts).run();
    const count = await env.DB.prepare('SELECT COUNT(*) as c FROM checkpoints WHERE user_id = ? AND session_id = ?').bind(getCurrentUser(), sessionId).first();
    return { content: [{ type: "text", text: `📍 Checkpoint #${count?.c || 1}: ${summary.slice(0, 50)}${summary.length > 50 ? '...' : ''}` }] };
  });

  server.tool("work_history", { days: z.number().optional().default(7) }, async ({ days }) => {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sessions = await env.DB.prepare(`SELECT ws.*, (SELECT COUNT(*) FROM checkpoints WHERE session_id = ws.id) as checkpoint_count FROM work_sessions ws WHERE ws.user_id = ? AND ws.session_date >= ? ORDER BY ws.session_date DESC`).bind(getCurrentUser(), since).all();
    if (sessions.results.length === 0) return { content: [{ type: "text", text: `No work sessions in the last ${days} days.` }] };
    let out = `📅 **Work History** (${days} days)\n\n`; let totalMinutes = 0; const now = new Date();
    for (const s of sessions.results as any[]) { let sessionMinutes = s.total_minutes || 0, isActive = false; if (!s.ended_at && s.started_at) { sessionMinutes = Math.round((now.getTime() - new Date(s.started_at).getTime()) / (1000 * 60)); isActive = true; } const hours = Math.floor(sessionMinutes / 60), mins = sessionMinutes % 60; totalMinutes += sessionMinutes; let timeRange = ''; if (s.started_at) { const sc = getCentralTime(new Date(s.started_at)); timeRange = s.ended_at ? ` (${sc.time} → ${getCentralTime(new Date(s.ended_at)).time})` : ` (${sc.time} → now)`; } out += `**${s.session_date}** — ${hours}h ${mins}m${timeRange}${isActive ? ' 🟢' : ''}\n`; if (s.end_of_day_summary) out += `  ${s.end_of_day_summary.slice(0, 100)}${s.end_of_day_summary.length > 100 ? '...' : ''}\n`; out += '\n'; }
    const avgMinutes = Math.round(totalMinutes / sessions.results.length);
    out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nTotal: ${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m across ${sessions.results.length} days\nAverage: ${Math.floor(avgMinutes / 60)}h ${avgMinutes % 60}m per day`;
    return { content: [{ type: "text", text: out }] };
  });
}
