// Skills management tools - stored skill instructions for Claude to fetch and follow

import { z } from "zod";
import type { ToolContext } from '../types';

export function registerSkillsTools(ctx: ToolContext) {
  const { server, env } = ctx;

  server.tool("list_skills", {
    category: z.string().optional().describe("Filter by category (e.g., 'planning', 'launch', 'content')"),
  }, async ({ category }) => {
    let query = 'SELECT id, name, description, category, version, updated_at FROM skills';
    const bindings: any[] = [];
    
    if (category) {
      query += ' WHERE category = ?';
      bindings.push(category);
    }
    
    query += ' ORDER BY category, name';
    
    const result = await env.DB.prepare(query).bind(...bindings).all();
    
    if (result.results.length === 0) {
      return { content: [{ type: "text", text: category 
        ? `No skills found in category "${category}".` 
        : "No skills found. Use save_skill to create one." 
      }] };
    }
    
    let out = '📚 **Available Skills**\n\n';
    
    // Group by category
    const byCategory: Record<string, any[]> = {};
    for (const skill of result.results as any[]) {
      const cat = skill.category || 'Uncategorized';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(skill);
    }
    
    for (const [cat, skills] of Object.entries(byCategory)) {
      out += `**[${cat}]**\n`;
      for (const s of skills) {
        out += `• **${s.name}** (v${s.version})\n`;
        if (s.description) out += `  ${s.description}\n`;
      }
      out += '\n';
    }
    
    out += `\n💡 Use \`get_skill("name")\` to retrieve skill instructions.`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("get_skill", {
    name: z.string().describe("Name of the skill to retrieve"),
  }, async ({ name }) => {
    const skill = await env.DB.prepare(
      'SELECT * FROM skills WHERE name = ?'
    ).bind(name.toLowerCase()).first();
    
    if (!skill) {
      // Try partial match
      const partial = await env.DB.prepare(
        'SELECT name FROM skills WHERE name LIKE ? LIMIT 5'
      ).bind('%' + name.toLowerCase() + '%').all();
      
      if (partial.results.length > 0) {
        const suggestions = (partial.results as any[]).map(s => s.name).join(', ');
        return { content: [{ type: "text", text: `Skill "${name}" not found. Did you mean: ${suggestions}?` }] };
      }
      
      return { content: [{ type: "text", text: `Skill "${name}" not found. Use list_skills to see available skills.` }] };
    }
    
    let out = `📖 **Skill: ${skill.name}** (v${skill.version})\n`;
    if (skill.description) out += `${skill.description}\n`;
    if (skill.category) out += `Category: ${skill.category}\n`;
    out += `\n---\n\n${skill.content}`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("save_skill", {
    name: z.string().describe("Unique name for the skill (lowercase, no spaces)"),
    content: z.string().describe("The skill instructions/prompts"),
    description: z.string().optional().describe("Brief description of what the skill does"),
    category: z.string().optional().describe("Category (e.g., 'planning', 'launch', 'content')"),
    version: z.string().optional().describe("Version string (default: 1.0)"),
  }, async ({ name, content, description, category, version }) => {
    const normalizedName = name.toLowerCase().replace(/\s+/g, '-');
    const ts = new Date().toISOString();
    
    // Check if skill exists
    const existing = await env.DB.prepare(
      'SELECT id, version FROM skills WHERE name = ?'
    ).bind(normalizedName).first();
    
    if (existing) {
      // Update existing skill
      const newVersion = version || incrementVersion(existing.version as string);
      
      await env.DB.prepare(
        'UPDATE skills SET content = ?, description = ?, category = ?, version = ?, updated_at = ? WHERE name = ?'
      ).bind(content, description || null, category || null, newVersion, ts, normalizedName).run();
      
      return { content: [{ type: "text", text: `✅ Updated skill "${normalizedName}" to v${newVersion}` }] };
    } else {
      // Create new skill
      const id = crypto.randomUUID();
      
      await env.DB.prepare(
        'INSERT INTO skills (id, name, description, content, category, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, normalizedName, description || null, content, category || null, version || '1.0', ts, ts).run();
      
      return { content: [{ type: "text", text: `✅ Created skill "${normalizedName}" v${version || '1.0'}` }] };
    }
  });

  server.tool("delete_skill", {
    name: z.string().describe("Name of the skill to delete"),
  }, async ({ name }) => {
    const normalizedName = name.toLowerCase();
    
    const existing = await env.DB.prepare(
      'SELECT id FROM skills WHERE name = ?'
    ).bind(normalizedName).first();
    
    if (!existing) {
      return { content: [{ type: "text", text: `Skill "${name}" not found.` }] };
    }
    
    await env.DB.prepare('DELETE FROM skills WHERE name = ?').bind(normalizedName).run();
    
    return { content: [{ type: "text", text: `🗑️ Deleted skill "${normalizedName}"` }] };
  });
}

// Helper to increment version string
function incrementVersion(version: string): string {
  const parts = version.split('.');
  if (parts.length === 1) {
    return (parseInt(parts[0]) + 1).toString();
  }
  const minor = parseInt(parts[parts.length - 1]) + 1;
  parts[parts.length - 1] = minor.toString();
  return parts.join('.');
}
