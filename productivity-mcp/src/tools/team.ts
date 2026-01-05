// Team collaboration tools

import { z } from "zod";
import type { ToolContext } from '../types';

export function registerTeamTools(ctx: ToolContext) {
  const { server, env, getCurrentUser, getTeammates, getTeammate } = ctx;

  // ==================
  // MESSAGING
  // ==================

  server.tool("send_message", {
    to: z.string().optional().describe("Teammate to message (defaults to first teammate)"),
    message: z.string().describe("The message content")
  }, async ({ to, message }) => {
    const targetUser = to || getTeammate();
    const teammates = getTeammates();
    
    if (!teammates.includes(targetUser) && targetUser !== getTeammate()) {
      return { content: [{ type: "text", text: `"${targetUser}" is not on your team. Teammates: ${teammates.join(', ')}` }] };
    }

    // Clean up expired messages while we're here
    await env.DB.prepare("DELETE FROM messages WHERE expires_at < datetime('now')").run();

    const id = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 days

    await env.DB.prepare(
      'INSERT INTO messages (id, from_user, to_user, content, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, getCurrentUser(), targetUser, message, now.toISOString(), expiresAt.toISOString()).run();

    return { content: [{ type: "text", text: `✉️ Message sent to ${targetUser}` }] };
  });

  server.tool("check_messages", {
    include_read: z.boolean().optional().describe("Include already-read messages (default: false)")
  }, async ({ include_read }) => {
    // Clean up expired messages
    await env.DB.prepare("DELETE FROM messages WHERE expires_at < datetime('now')").run();

    let query = "SELECT * FROM messages WHERE to_user = ?";
    if (!include_read) {
      query += " AND read_at IS NULL";
    }
    query += " ORDER BY created_at DESC LIMIT 20";

    const r = await env.DB.prepare(query).bind(getCurrentUser()).all();

    if (r.results.length === 0) {
      return { content: [{ type: "text", text: include_read ? "No messages" : "No new messages 📭" }] };
    }

    // Mark unread messages as read
    const unreadIds = r.results.filter((m: any) => !m.read_at).map((m: any) => m.id);
    if (unreadIds.length > 0) {
      for (const id of unreadIds) {
        await env.DB.prepare("UPDATE messages SET read_at = datetime('now') WHERE id = ?").bind(id).run();
      }
    }

    let out = `📬 **Messages** (${r.results.length}):\n\n`;
    r.results.forEach((m: any) => {
      const time = formatRelativeTime(m.created_at);
      const unread = !m.read_at ? '🆕 ' : '';
      out += `${unread}**${m.from_user}** (${time}):\n${m.content}\n\n`;
    });

    return { content: [{ type: "text", text: out.trim() }] };
  });

  server.tool("message_history", {
    with_user: z.string().optional().describe("Filter to conversation with specific teammate"),
    limit: z.number().optional().describe("Number of messages (default 20)")
  }, async ({ with_user, limit }) => {
    const currentUser = getCurrentUser();
    const maxMessages = limit || 20;

    let query = `
      SELECT * FROM messages 
      WHERE (from_user = ? OR to_user = ?)
    `;
    const params: any[] = [currentUser, currentUser];

    if (with_user) {
      query += ` AND (from_user = ? OR to_user = ?)`;
      params.push(with_user, with_user);
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(maxMessages);

    const r = await env.DB.prepare(query).bind(...params).all();

    if (r.results.length === 0) {
      return { content: [{ type: "text", text: "No message history" }] };
    }

    let out = `💬 **Message History**${with_user ? ` with ${with_user}` : ''} (${r.results.length}):\n\n`;
    
    // Reverse to show oldest first
    const messages = [...r.results].reverse();
    messages.forEach((m: any) => {
      const time = formatRelativeTime(m.created_at);
      const direction = m.from_user === currentUser ? '→' : '←';
      const other = m.from_user === currentUser ? m.to_user : m.from_user;
      out += `${direction} **${m.from_user}** (${time}): ${m.content}\n`;
    });

    return { content: [{ type: "text", text: out.trim() }] };
  });

  // ==================
  // TEAM OVERVIEW
  // ==================

  server.tool("team_summary", {}, async () => {
    const team = env.TEAM || 'micaiah,irene';
    const members = team.split(',').map((t: string) => t.trim());
    
    let summary = '👥 **Untitled Publishers Team**\n\n';
    
    for (const member of members) {
      const stats = await env.DB.prepare(`
        SELECT 
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
          SUM(CASE WHEN status = 'done' AND DATE(completed_at) = DATE('now') THEN 1 ELSE 0 END) as today
        FROM tasks WHERE user_id = ?
      `).bind(member).first();
      
      // Check for unread messages
      const unread = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM messages WHERE to_user = ? AND read_at IS NULL"
      ).bind(member).first();
      
      const isYou = member === getCurrentUser() ? ' (you)' : '';
      const msgNote = member === getCurrentUser() && (unread?.count || 0) > 0 ? ` 📬 ${unread?.count} unread` : '';
      summary += `**${member}**${isYou}: ${stats?.open || 0} open, ${stats?.today || 0} done today${msgNote}\n`;
    }
    
    return { content: [{ type: "text", text: summary }] };
  });

  server.tool("view_teammate_tasks", { 
    teammate: z.string().optional().describe("Which teammate to view - leave empty to see all teammates"),
    category: z.string().optional() 
  }, async ({ teammate, category }) => {
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
      
      out += `📋 **${tm}'s tasks** (${r.results.length}):\n`;
      if (r.results.length === 0) {
        out += '  No open tasks\n';
      } else {
        r.results.forEach((t: any) => {
          const p = t.priority >= 4 ? '🔴' : t.priority === 3 ? '🟡' : '⚪';
          out += `  ${p} ${t.text}\n`;
        });
      }
      out += '\n';
    }
    
    return { content: [{ type: "text", text: out.trim() }] };
  });

  // ==================
  // HANDOFFS
  // ==================

  server.tool("suggest_handoff", { 
    task_id: z.string(), 
    to_teammate: z.string().optional().describe("Which teammate to suggest to - defaults to first teammate"),
    reason: z.string().optional() 
  }, async ({ task_id, to_teammate, reason }) => {
    const task = await env.DB.prepare("SELECT text FROM tasks WHERE id = ?").bind(task_id).first();
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    
    const targetTeammate = to_teammate || getTeammate();
    const teammates = getTeammates();
    
    if (!teammates.includes(targetTeammate) && targetTeammate !== getTeammate()) {
      return { content: [{ type: "text", text: `"${targetTeammate}" is not on your team. Teammates: ${teammates.join(', ')}` }] };
    }
    
    await env.DB.prepare('INSERT INTO handoff_suggestions (id, from_user, to_user, task_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), getCurrentUser(), targetTeammate, task_id, reason || null, 'pending', new Date().toISOString()).run();
    return { content: [{ type: "text", text: '📤 Suggested to ' + targetTeammate + ': "' + task.text + '"' }] };
  });

  server.tool("check_handoffs", {}, async () => {
    const r = await env.DB.prepare("SELECT h.*, t.text as task_text FROM handoff_suggestions h JOIN tasks t ON h.task_id = t.id WHERE h.to_user = ? AND h.status = 'pending'").bind(getCurrentUser()).all();
    if (r.results.length === 0) return { content: [{ type: "text", text: "No pending handoffs" }] };
    let out = '📥 Handoffs:\n';
    r.results.forEach((s: any) => { out += 'From ' + s.from_user + ': "' + s.task_text + '" (ID: ' + s.task_id + ')\n'; });
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("accept_handoff", { task_id: z.string() }, async ({ task_id }) => {
    await env.DB.prepare("UPDATE tasks SET user_id = ? WHERE id = ?").bind(getCurrentUser(), task_id).run();
    await env.DB.prepare("UPDATE handoff_suggestions SET status = 'accepted' WHERE task_id = ?").bind(task_id).run();
    return { content: [{ type: "text", text: "✅ Accepted" }] };
  });

  server.tool("who_am_i", {}, async () => {
    const teammates = getTeammates();
    
    // Check unread messages
    const unread = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM messages WHERE to_user = ? AND read_at IS NULL"
    ).bind(getCurrentUser()).first();
    
    let out = `You are: ${getCurrentUser()}\nTeammates: ${teammates.join(', ')}`;
    if ((unread?.count || 0) > 0) {
      out += `\n\n📬 You have ${unread?.count} unread message${(unread?.count || 0) > 1 ? 's' : ''}`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });
}

// Helper function
function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
