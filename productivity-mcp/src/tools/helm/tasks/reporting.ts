// Task reporting tools: summaries, stats, patterns, insights

import { z } from 'zod';
import type { ToolContext } from '../../../types';
import { getDayOfWeek } from '../../../helpers/utils';
import { getPatterns, generateNudges, analyzeAndStorePatterns } from '../../../helpers/intelligence';

export function registerTaskReportingTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool('get_daily_summary', {}, async () => {
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

    return { content: [{ type: 'text', text: output }] };
  });

  server.tool('weekly_recap', {}, async () => {
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - now.getDay() + 1);
    monday.setHours(0, 0, 0, 0);

    const done = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at >= ?").bind(getCurrentUser(), monday.toISOString()).first();
    const added = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND created_at >= ?").bind(getCurrentUser(), monday.toISOString()).first();
    const dailyStats = await env.DB.prepare('SELECT log_date, tasks_completed, tasks_created FROM daily_logs WHERE user_id = ? AND log_date >= ? ORDER BY log_date').bind(getCurrentUser(), monday.toISOString().split('T')[0]).all();

    let recap = '📊 Weekly Recap\n\n✅ Completed: ' + (done?.c || 0) + '\n➕ Added: ' + (added?.c || 0);
    if (dailyStats.results.length > 0) {
      recap += '\n\n**By day:**\n';
      dailyStats.results.forEach((d: any) => { recap += d.log_date + ': ' + d.tasks_completed + ' done, ' + d.tasks_created + ' added\n'; });
    }

    return { content: [{ type: 'text', text: recap }] };
  });

  server.tool('plan_week', {
    focus_level: z.enum(['high', 'normal', 'low']).optional().default('normal'),
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

    return { content: [{ type: 'text', text: plan }] };
  });

  server.tool('get_stats', {}, async () => {
    const total = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ?").bind(getCurrentUser()).first();
    const open = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'open'").bind(getCurrentUser()).first();
    const done = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'done'").bind(getCurrentUser()).first();
    const recurring = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'open' AND recurrence IS NOT NULL").bind(getCurrentUser()).first();
    const active = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'open' AND (is_active = 1 OR objective_id IS NOT NULL)").bind(getCurrentUser()).first();

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekDone = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at >= ?").bind(getCurrentUser(), weekAgo).first();

    let stats = '📊 Stats\n\nTotal: ' + (total?.c || 0) + '\nOpen: ' + (open?.c || 0) + '\nActive: ' + (active?.c || 0) + ' 🎯\nDone: ' + (done?.c || 0) + '\nRecurring: ' + (recurring?.c || 0) + ' 🔄\n\nLast 7 days: ' + (weekDone?.c || 0) + ' completed';
    if (total?.c > 0) stats += '\nCompletion rate: ' + Math.round((done?.c || 0) / total.c * 100) + '%';

    return { content: [{ type: 'text', text: stats }] };
  });

  server.tool('get_challenges', {}, async () => {
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

    return { content: [{ type: 'text', text: out }] };
  });

  server.tool('analyze_patterns', {}, async () => {
    const insights = await analyzeAndStorePatterns(env, getCurrentUser());
    if (insights.length === 0) return { content: [{ type: 'text', text: '📊 Not enough data yet. Keep using the system and check back in a week!' }] };

    let output = '📊 **Your Productivity Patterns**\n\n';
    insights.forEach(i => { output += '• ' + i + '\n'; });
    return { content: [{ type: 'text', text: output }] };
  });

  server.tool('get_insights', {}, async () => {
    const patterns = await getPatterns(env, getCurrentUser());
    const open = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open'").bind(getCurrentUser()).all();

    if (patterns.length === 0) return { content: [{ type: 'text', text: '💡 No patterns learned yet. Run analyze_patterns after a week of use!' }] };

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

    return { content: [{ type: 'text', text: output }] };
  });

  server.tool('end_of_day_recap', {}, async () => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    const session = await env.DB.prepare('SELECT * FROM work_sessions WHERE user_id = ? AND session_date = ?').bind(getCurrentUser(), today).first();
    const checkpoints = await env.DB.prepare("SELECT * FROM checkpoints WHERE user_id = ? AND DATE(checkpoint_time) = ? ORDER BY checkpoint_time ASC").bind(getCurrentUser(), today).all();
    const completed = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'done' AND DATE(completed_at) = ? ORDER BY completed_at ASC").bind(getCurrentUser(), today).all();
    const added = await env.DB.prepare('SELECT * FROM tasks WHERE user_id = ? AND DATE(created_at) = ?').bind(getCurrentUser(), today).all();
    const progressLogs = await env.DB.prepare('SELECT * FROM progress_logs WHERE user_id = ? AND DATE(logged_at) = ?').bind(getCurrentUser(), today).all();

    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const yesterdayCompleted = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = 'done' AND DATE(completed_at) = ?").bind(getCurrentUser(), yesterday).first();

    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const weekStats = await env.DB.prepare("SELECT COUNT(*) as total, COUNT(DISTINCT DATE(completed_at)) as days FROM tasks WHERE user_id = ? AND status = 'done' AND DATE(completed_at) >= ?").bind(getCurrentUser(), weekAgo).first();
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

    const dueSoon = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND due_date IS NOT NULL AND due_date <= date('now', '+3 days') ORDER BY due_date ASC").bind(getCurrentUser()).all();
    if (dueSoon.results.length > 0) {
      out += '\n**⚠️ Due soon:**\n';
      for (const t of dueSoon.results.slice(0, 3) as any[]) out += '• ' + t.text + ' (' + t.due_date + ')' + (t.recurrence ? ' 🔄' : '') + '\n';
    }

    if (completed.results.length === 0 && checkpoints.results.length === 0 && progressLogs.results.length === 0) {
      out = '📊 **End of Day Recap**\n\nNo activity tracked today.\n\n💡 Start tomorrow with "good morning" to track your work day!';
    }

    return { content: [{ type: 'text', text: out }] };
  });
}
