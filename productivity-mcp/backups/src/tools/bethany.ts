import { z } from "zod";
import { ToolContext } from '../types';

export function registerBethanyTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool("good_morning", {
    notes: z.string().optional().describe("Any context about today - energy level, focus, constraints"),
  }, async ({ notes }) => {
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
