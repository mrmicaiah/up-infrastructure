// Notes and ideas tools

import { z } from "zod";
import type { ToolContext } from '../types';

export function registerNotesTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool("add_note", { 
    title: z.string(), 
    content: z.string().optional(), 
    category: z.string().optional().default("General") 
  }, async ({ title, content, category }) => {
    await env.DB.prepare(
      'INSERT INTO notes (id, user_id, title, content, category, created_at, archived) VALUES (?, ?, ?, ?, ?, ?, 0)'
    ).bind(crypto.randomUUID(), getCurrentUser(), title, content || null, category, new Date().toISOString()).run();
    return { content: [{ type: "text", text: '📝 Note saved: "' + title + '"' }] };
  });

  server.tool("add_idea", { 
    title: z.string(), 
    content: z.string().optional(), 
    category: z.enum(["Writing Ideas", "Business Ideas", "Tech Ideas", "Content Ideas", "Unsorted"]).optional().default("Unsorted") 
  }, async ({ title, content, category }) => {
    await env.DB.prepare(
      'INSERT INTO incubation (id, user_id, title, content, category, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), getCurrentUser(), title, content || null, category, new Date().toISOString()).run();
    return { content: [{ type: "text", text: '💡 Idea: "' + title + '"' }] };
  });

  server.tool("list_ideas", { category: z.string().optional() }, async ({ category }) => {
    let q = "SELECT * FROM incubation WHERE user_id = ?";
    const b: any[] = [getCurrentUser()];
    if (category) { q += " AND category = ?"; b.push(category); }
    const r = await env.DB.prepare(q).bind(...b).all();
    if (r.results.length === 0) return { content: [{ type: "text", text: "No ideas yet" }] };
    let out = '💡 Ideas:\n';
    r.results.forEach((i: any) => { out += '• ' + i.title + '\n'; });
    return { content: [{ type: "text", text: out }] };
  });
}
