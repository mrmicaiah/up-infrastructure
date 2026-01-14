// Check-ins and work logs tools

import { z } from "zod";
import type { ToolContext } from '../types';

export function registerCheckinsTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  // === CHECK-INS ===

  server.tool("add_checkin", {
    thread_summary: z.string().describe("~280 chars, fun/sarcastic tone"),
    full_recap: z.string().describe("Detailed markdown recap"),
    project_name: z.string().optional()
  }, async ({ thread_summary, full_recap, project_name }) => {
    const id = crypto.randomUUID().slice(0, 8);
    await env.DB.prepare(
      'INSERT INTO check_ins (id, user_id, thread_summary, full_recap, project_name, created_at, logged) VALUES (?, ?, ?, ?, ?, ?, 0)'
    ).bind(id, getCurrentUser(), thread_summary, full_recap, project_name || null, new Date().toISOString()).run();
    return { content: [{ type: "text", text: '✅ Check-in saved (id: ' + id + ')\n\n"' + thread_summary + '"' }] };
  });

  server.tool("list_checkins", {
    user_id: z.string().optional().describe("Filter by user (defaults to all)"),
    logged: z.boolean().optional().describe("Filter by logged status"),
    limit: z.number().optional().default(20)
  }, async ({ user_id, logged, limit }) => {
    let q = "SELECT id, user_id, thread_summary, project_name, created_at, logged FROM check_ins WHERE 1=1";
    const b: any[] = [];
    
    if (user_id) { 
      q += " AND user_id = ?"; 
      b.push(user_id); 
    }
    if (logged !== undefined) { 
      q += " AND logged = ?"; 
      b.push(logged ? 1 : 0); 
    }
    q += " ORDER BY created_at DESC LIMIT ?";
    b.push(limit);
    
    const r = await env.DB.prepare(q).bind(...b).all();
    if (r.results.length === 0) return { content: [{ type: "text", text: "No check-ins yet" }] };
    
    let out = '📋 Check-ins:\n\n';
    r.results.forEach((c: any) => {
      const date = new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const loggedTag = c.logged ? ' [logged]' : '';
      const projectTag = c.project_name ? ' • ' + c.project_name : '';
      out += '**' + c.user_id + '** • ' + date + projectTag + loggedTag + '\n';
      out += c.thread_summary + '\n';
      out += '(id: ' + c.id + ')\n\n';
    });
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("get_checkin", {
    id: z.string()
  }, async ({ id }) => {
    let checkin = await env.DB.prepare('SELECT * FROM check_ins WHERE id = ?').bind(id).first();
    if (!checkin) {
      checkin = await env.DB.prepare('SELECT * FROM check_ins WHERE id LIKE ?').bind(id + '%').first();
    }
    if (!checkin) return { content: [{ type: "text", text: "Check-in not found" }] };
    
    // Get comments
    const comments = await env.DB.prepare(
      'SELECT * FROM check_in_comments WHERE check_in_id = ? ORDER BY created_at ASC'
    ).bind((checkin as any).id).all();
    
    const c = checkin as any;
    const date = new Date(c.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    
    let out = '📋 Check-in by **' + c.user_id + '**\n';
    out += '📅 ' + date + '\n';
    if (c.project_name) out += '📁 ' + c.project_name + '\n';
    out += c.logged ? '✓ Logged to work log: ' + c.work_log_id + '\n' : '○ Not yet logged\n';
    out += '\n---\n\n';
    out += '**Thread:** ' + c.thread_summary + '\n\n';
    out += '**Full Recap:**\n' + c.full_recap;
    
    if (comments.results.length > 0) {
      out += '\n\n---\n💬 **Comments:**\n';
      comments.results.forEach((comment: any) => {
        const cdate = new Date(comment.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        out += '\n**' + comment.user_id + '** • ' + cdate + '\n' + comment.content + '\n';
      });
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  // === COMMENTS ===

  server.tool("add_checkin_comment", {
    check_in_id: z.string(),
    content: z.string()
  }, async ({ check_in_id, content }) => {
    // Find the check-in
    let checkin = await env.DB.prepare('SELECT id, user_id FROM check_ins WHERE id = ?').bind(check_in_id).first();
    if (!checkin) {
      checkin = await env.DB.prepare('SELECT id, user_id FROM check_ins WHERE id LIKE ?').bind(check_in_id + '%').first();
    }
    if (!checkin) return { content: [{ type: "text", text: "Check-in not found" }] };
    
    const id = crypto.randomUUID().slice(0, 8);
    const checkinData = checkin as any;
    
    await env.DB.prepare(
      'INSERT INTO check_in_comments (id, check_in_id, user_id, content, created_at, seen) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, checkinData.id, getCurrentUser(), content, new Date().toISOString(), 0).run();
    
    return { content: [{ type: "text", text: '💬 Comment added to ' + checkinData.user_id + "'s check-in" }] };
  });

  server.tool("list_checkin_comments", {
    check_in_id: z.string()
  }, async ({ check_in_id }) => {
    // Support partial ID
    let checkin = await env.DB.prepare('SELECT id FROM check_ins WHERE id = ?').bind(check_in_id).first();
    if (!checkin) {
      checkin = await env.DB.prepare('SELECT id FROM check_ins WHERE id LIKE ?').bind(check_in_id + '%').first();
    }
    if (!checkin) return { content: [{ type: "text", text: "Check-in not found" }] };
    
    const comments = await env.DB.prepare(
      'SELECT * FROM check_in_comments WHERE check_in_id = ? ORDER BY created_at ASC'
    ).bind((checkin as any).id).all();
    
    if (comments.results.length === 0) return { content: [{ type: "text", text: "No comments on this check-in" }] };
    
    let out = '💬 Comments:\n\n';
    comments.results.forEach((c: any) => {
      const date = new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      out += '**' + c.user_id + '** • ' + date + '\n' + c.content + '\n\n';
    });
    return { content: [{ type: "text", text: out }] };
  });

  // === WORK LOGS ===

  server.tool("create_work_log", {}, async () => {
    const checkins = await env.DB.prepare(
      'SELECT * FROM check_ins WHERE user_id = ? AND logged = 0 ORDER BY created_at ASC'
    ).bind(getCurrentUser()).all();
    
    if (checkins.results.length === 0) {
      return { content: [{ type: "text", text: "Nothing to log—go do some recaps first!" }] };
    }
    
    let out = '📝 **' + checkins.results.length + ' unlogged check-ins ready for synthesis:**\n\n';
    
    const ids: string[] = [];
    checkins.results.forEach((c: any, i: number) => {
      ids.push(c.id);
      const date = new Date(c.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      out += '---\n**' + (i + 1) + '. ' + date + '**';
      if (c.project_name) out += ' • ' + c.project_name;
      out += '\n\n' + c.full_recap + '\n\n';
    });
    
    const firstDate = new Date((checkins.results[0] as any).created_at).toLocaleDateString();
    const lastDate = new Date((checkins.results[checkins.results.length - 1] as any).created_at).toLocaleDateString();
    
    out += '---\n\n**Period:** ' + firstDate + ' → ' + lastDate + '\n';
    out += '**Check-in IDs:** ' + ids.join(', ') + '\n\n';
    out += '_Now synthesize these into a narrative and call `save_work_log` with the narrative, shipped items, and these check_in_ids._';
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("save_work_log", {
    narrative: z.string().describe("Synthesized story of the work"),
    shipped: z.array(z.string()).describe("Array of concrete outputs"),
    check_in_ids: z.array(z.string()).describe("IDs of check-ins being logged")
  }, async ({ narrative, shipped, check_in_ids }) => {
    if (check_in_ids.length === 0) {
      return { content: [{ type: "text", text: "No check-in IDs provided" }] };
    }
    
    // Get date range from check-ins
    const placeholders = check_in_ids.map(() => '?').join(',');
    const checkins = await env.DB.prepare(
      'SELECT created_at FROM check_ins WHERE id IN (' + placeholders + ') ORDER BY created_at ASC'
    ).bind(...check_in_ids).all();
    
    if (checkins.results.length === 0) {
      return { content: [{ type: "text", text: "No matching check-ins found" }] };
    }
    
    const periodStart = (checkins.results[0] as any).created_at;
    const periodEnd = (checkins.results[checkins.results.length - 1] as any).created_at;
    
    // Create work log
    const logId = crypto.randomUUID().slice(0, 8);
    await env.DB.prepare(
      'INSERT INTO work_logs (id, user_id, created_at, period_start, period_end, narrative, shipped) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(logId, getCurrentUser(), new Date().toISOString(), periodStart, periodEnd, narrative, JSON.stringify(shipped)).run();
    
    // Mark check-ins as logged
    await env.DB.prepare(
      'UPDATE check_ins SET logged = 1, work_log_id = ? WHERE id IN (' + placeholders + ')'
    ).bind(logId, ...check_in_ids).run();
    
    const startDate = new Date(periodStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endDate = new Date(periodEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    
    return { content: [{ type: "text", text: '📓 Work log created (id: ' + logId + ')\n\nLogged ' + check_in_ids.length + ' check-ins covering ' + startDate + ' → ' + endDate }] };
  });

  server.tool("list_work_logs", {
    user_id: z.string().optional(),
    limit: z.number().optional().default(10)
  }, async ({ user_id, limit }) => {
    let q = "SELECT * FROM work_logs";
    const b: any[] = [];
    
    if (user_id) {
      q += " WHERE user_id = ?";
      b.push(user_id);
    }
    q += " ORDER BY created_at DESC LIMIT ?";
    b.push(limit);
    
    const r = await env.DB.prepare(q).bind(...b).all();
    if (r.results.length === 0) return { content: [{ type: "text", text: "No work logs yet" }] };
    
    let out = '📓 Work Logs:\n\n';
    r.results.forEach((log: any) => {
      const start = new Date(log.period_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const end = new Date(log.period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const shipped = JSON.parse(log.shipped || '[]');
      
      out += '**' + log.user_id + '** • ' + start + ' → ' + end + '\n';
      out += log.narrative.slice(0, 150) + (log.narrative.length > 150 ? '...' : '') + '\n';
      if (shipped.length > 0) out += '🚀 Shipped: ' + shipped.slice(0, 3).join(', ') + (shipped.length > 3 ? '...' : '') + '\n';
      out += '(id: ' + log.id + ')\n\n';
    });
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("get_work_log", {
    id: z.string()
  }, async ({ id }) => {
    let log = await env.DB.prepare('SELECT * FROM work_logs WHERE id = ?').bind(id).first();
    if (!log) {
      log = await env.DB.prepare('SELECT * FROM work_logs WHERE id LIKE ?').bind(id + '%').first();
    }
    if (!log) return { content: [{ type: "text", text: "Work log not found" }] };
    
    const l = log as any;
    const start = new Date(l.period_start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const end = new Date(l.period_end).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const shipped = JSON.parse(l.shipped || '[]');
    
    let out = '📓 Work Log by **' + l.user_id + '**\n';
    out += '📅 ' + start + ' → ' + end + '\n\n';
    out += '---\n\n';
    out += l.narrative + '\n\n';
    
    if (shipped.length > 0) {
      out += '---\n🚀 **Shipped:**\n';
      shipped.forEach((item: string) => { out += '• ' + item + '\n'; });
    }
    
    return { content: [{ type: "text", text: out }] };
  });
}
