// Sprint management tools - replaces plans.ts
// Sprints are curated task lists with deadlines, grouped by objectives ("pushing for" statements)

import { z } from "zod";
import type { ToolContext } from '../types';

// Helper: Calculate days remaining until end date
function getDaysRemaining(endDate: string): number {
  const end = new Date(endDate);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

// Helper: Calculate work days remaining (excludes weekends)
function getWorkDaysRemaining(endDate: string): number {
  const end = new Date(endDate);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  
  let workDays = 0;
  const current = new Date(now);
  
  while (current <= end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) workDays++;
    current.setDate(current.getDate() + 1);
  }
  
  return workDays;
}

// Exported for use in bethany.ts
export function formatSprintHeader(sprint: any): string {
  const daysRemaining = getDaysRemaining(sprint.end_date);
  const workDaysRemaining = getWorkDaysRemaining(sprint.end_date);
  
  let header = `📋 **${sprint.name}**\n`;
  header += `📅 Ends: ${sprint.end_date}\n`;
  
  if (daysRemaining < 0) {
    header += `⏰ Sprint ended ${Math.abs(daysRemaining)} days ago\n`;
  } else if (daysRemaining === 0) {
    header += `⚠️ Sprint ends TODAY\n`;
  } else {
    header += `⏳ ${daysRemaining} days remaining (${workDaysRemaining} work days)\n`;
  }
  
  return header;
}

// Exported for use in bethany.ts
export function calculateSprintProgress(sprint: any, objectives: any[], tasksByObjective: Map<string, any[]>): {
  totalTasks: number;
  completedTasks: number;
  daysRemaining: number;
  workDaysRemaining: number;
  velocity: string;
} {
  let totalTasks = 0;
  let completedTasks = 0;
  
  for (const obj of objectives) {
    const tasks = tasksByObjective.get(obj.id) || [];
    totalTasks += tasks.length;
    completedTasks += tasks.filter((t: any) => t.status === 'done').length;
  }
  
  const daysRemaining = getDaysRemaining(sprint.end_date);
  const workDaysRemaining = getWorkDaysRemaining(sprint.end_date);
  const remaining = totalTasks - completedTasks;
  
  let velocity = '0';
  if (remaining > 0 && daysRemaining > 0) {
    velocity = (remaining / daysRemaining).toFixed(1);
  }
  
  return { totalTasks, completedTasks, daysRemaining, workDaysRemaining, velocity };
}

export function registerSprintTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  // ============================================
  // SPRINT MANAGEMENT
  // ============================================

  server.tool("create_sprint", {
    name: z.string().describe("Sprint name (e.g., 'January Sprint', 'This Week', 'Q1 Push')"),
    end_date: z.string().describe("When the sprint ends (YYYY-MM-DD)"),
  }, async ({ name, end_date }) => {
    const ts = new Date().toISOString();
    const id = crypto.randomUUID();
    
    await env.DB.prepare(
      'INSERT INTO sprints (id, user_id, name, end_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, getCurrentUser(), name, end_date, 'active', ts, ts).run();
    
    const daysRemaining = getDaysRemaining(end_date);
    const workDaysRemaining = getWorkDaysRemaining(end_date);
    
    let out = `✅ **Sprint Created: ${name}**\n\n`;
    out += `📅 Ends: ${end_date}\n`;
    out += `⏳ ${daysRemaining} days (${workDaysRemaining} work days)\n`;
    out += `\n💡 Now add objectives with \`add_objective\` - what are you pushing for?`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("add_objective", {
    statement: z.string().describe("What you're pushing for (e.g., 'Two Proverbs Library books done')"),
    sprint_id: z.string().optional().describe("Sprint ID (defaults to most recent active sprint)"),
  }, async ({ statement, sprint_id }) => {
    const ts = new Date().toISOString();
    
    // Get sprint
    let sprint: any;
    if (sprint_id) {
      sprint = await env.DB.prepare('SELECT * FROM sprints WHERE id = ? AND user_id = ?').bind(sprint_id, getCurrentUser()).first();
    } else {
      sprint = await env.DB.prepare("SELECT * FROM sprints WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").bind(getCurrentUser()).first();
    }
    
    if (!sprint) {
      return { content: [{ type: "text", text: "No active sprint found. Create one with `create_sprint` first." }] };
    }
    
    // Get current max sort_order
    const maxOrder = await env.DB.prepare(
      'SELECT MAX(sort_order) as max FROM objectives WHERE sprint_id = ?'
    ).bind(sprint.id).first();
    
    const id = crypto.randomUUID();
    const sortOrder = ((maxOrder?.max as number) || 0) + 1;
    
    await env.DB.prepare(
      'INSERT INTO objectives (id, sprint_id, user_id, statement, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, sprint.id, getCurrentUser(), statement, sortOrder, ts).run();
    
    let out = `✅ Objective added to "${sprint.name}":\n\n`;
    out += `▸ ${statement}\n`;
    out += `\n💡 Now pull tasks into this objective with \`pull_to_sprint\``;
    out += `\n   or ask: "What would it take to get that done?"`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("pull_to_sprint", {
    task_id: z.string().optional(),
    search: z.string().optional().describe("Search for task by text"),
    objective_id: z.string().optional().describe("Which objective to put it under"),
    objective_search: z.string().optional().describe("Search for objective by statement"),
  }, async ({ task_id, search, objective_id, objective_search }) => {
    const ts = new Date().toISOString();
    
    // Find the task
    let task: any;
    if (task_id) {
      task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').bind(task_id, getCurrentUser()).first();
    } else if (search) {
      const results = await env.DB.prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND text LIKE ? LIMIT 5"
      ).bind(getCurrentUser(), '%' + search + '%').all();
      
      if (results.results.length === 0) return { content: [{ type: "text", text: `No task found matching "${search}"` }] };
      if (results.results.length === 1) task = results.results[0];
      else {
        let out = 'Multiple tasks match:\n';
        for (const t of results.results as any[]) {
          out += `• ${t.text} (ID: ${t.id})\n`;
        }
        out += '\nSpecify with task_id.';
        return { content: [{ type: "text", text: out }] };
      }
    } else {
      return { content: [{ type: "text", text: "Need task_id or search text" }] };
    }
    
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    
    // Find the objective
    let objective: any;
    if (objective_id) {
      objective = await env.DB.prepare('SELECT o.*, s.name as sprint_name FROM objectives o JOIN sprints s ON o.sprint_id = s.id WHERE o.id = ? AND o.user_id = ?').bind(objective_id, getCurrentUser()).first();
    } else if (objective_search) {
      const results = await env.DB.prepare(
        "SELECT o.*, s.name as sprint_name FROM objectives o JOIN sprints s ON o.sprint_id = s.id WHERE o.user_id = ? AND o.statement LIKE ? LIMIT 5"
      ).bind(getCurrentUser(), '%' + objective_search + '%').all();
      
      if (results.results.length === 0) return { content: [{ type: "text", text: `No objective found matching "${objective_search}"` }] };
      if (results.results.length === 1) objective = results.results[0];
      else {
        let out = 'Multiple objectives match:\n';
        for (const o of results.results as any[]) {
          out += `• ${o.statement} (ID: ${o.id})\n`;
        }
        out += '\nSpecify with objective_id.';
        return { content: [{ type: "text", text: out }] };
      }
    } else {
      // Default to most recent objective in active sprint
      objective = await env.DB.prepare(`
        SELECT o.*, s.name as sprint_name 
        FROM objectives o 
        JOIN sprints s ON o.sprint_id = s.id 
        WHERE o.user_id = ? AND s.status = 'active'
        ORDER BY o.created_at DESC LIMIT 1
      `).bind(getCurrentUser()).first();
      
      if (!objective) {
        return { content: [{ type: "text", text: "No objectives found. Add one with `add_objective` first." }] };
      }
    }
    
    // Preserve original category if not already set
    const originalCategory = task.original_category || task.category || 'General';
    
    // Update the task
    await env.DB.prepare(
      'UPDATE tasks SET objective_id = ?, original_category = ?, last_touched = ? WHERE id = ?'
    ).bind(objective.id, originalCategory, ts, task.id).run();
    
    let out = `✅ Pulled into sprint:\n\n`;
    out += `📋 "${task.text}"\n`;
    out += `▸ ${objective.statement}\n`;
    out += `\n💡 Use \`activate_task\` when ready to work on it today.`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("remove_from_sprint", {
    task_id: z.string().optional(),
    search: z.string().optional().describe("Search for task by text"),
  }, async ({ task_id, search }) => {
    const ts = new Date().toISOString();
    
    // Find the task
    let task: any;
    if (task_id) {
      task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').bind(task_id, getCurrentUser()).first();
    } else if (search) {
      const results = await env.DB.prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND objective_id IS NOT NULL AND text LIKE ? LIMIT 5"
      ).bind(getCurrentUser(), '%' + search + '%').all();
      
      if (results.results.length === 0) return { content: [{ type: "text", text: `No sprint task found matching "${search}"` }] };
      if (results.results.length === 1) task = results.results[0];
      else {
        let out = 'Multiple tasks match:\n';
        for (const t of results.results as any[]) {
          out += `• ${t.text} (ID: ${t.id})\n`;
        }
        return { content: [{ type: "text", text: out }] };
      }
    } else {
      return { content: [{ type: "text", text: "Need task_id or search text" }] };
    }
    
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    if (!task.objective_id) return { content: [{ type: "text", text: "Task is not in a sprint" }] };
    
    // Restore original category and clear objective
    const restoreCategory = task.original_category || task.category || 'General';
    
    await env.DB.prepare(
      'UPDATE tasks SET objective_id = NULL, category = ?, last_touched = ? WHERE id = ?'
    ).bind(restoreCategory, ts, task.id).run();
    
    return { content: [{ type: "text", text: `➖ Removed from sprint: "${task.text}"\n📁 Returned to [${restoreCategory}]` }] };
  });

  server.tool("view_sprint", {
    sprint_id: z.string().optional().describe("Sprint ID (defaults to most recent active sprint)"),
  }, async ({ sprint_id }) => {
    // Get sprint
    let sprint: any;
    if (sprint_id) {
      sprint = await env.DB.prepare('SELECT * FROM sprints WHERE id = ? AND user_id = ?').bind(sprint_id, getCurrentUser()).first();
    } else {
      sprint = await env.DB.prepare("SELECT * FROM sprints WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").bind(getCurrentUser()).first();
    }
    
    if (!sprint) {
      return { content: [{ type: "text", text: "No active sprint found.\n\n💡 Create one with `create_sprint` or say \"let's build a sprint\"" }] };
    }
    
    // Get objectives with their tasks
    const objectives = await env.DB.prepare(
      'SELECT * FROM objectives WHERE sprint_id = ? ORDER BY sort_order ASC'
    ).bind(sprint.id).all();
    
    // Count stats
    let totalTasks = 0;
    let completedTasks = 0;
    
    let out = formatSprintHeader(sprint);
    out += `\n`;
    
    if (objectives.results.length === 0) {
      out += `\nNo objectives yet.\n`;
      out += `💡 Add what you're pushing for with \`add_objective\`\n`;
    } else {
      for (const obj of objectives.results as any[]) {
        // Get tasks for this objective - FIX: Added user_id filter
        const tasks = await env.DB.prepare(
          'SELECT * FROM tasks WHERE objective_id = ? AND user_id = ? ORDER BY status ASC, is_active DESC, priority DESC, created_at ASC'
        ).bind(obj.id, getCurrentUser()).all();
        
        const objTasks = tasks.results as any[];
        const objComplete = objTasks.filter(t => t.status === 'done').length;
        const objTotal = objTasks.length;
        
        totalTasks += objTotal;
        completedTasks += objComplete;
        
        // Objective header with progress
        const progressIcon = objComplete === objTotal && objTotal > 0 ? '✅' : objComplete > 0 ? '◐' : '○';
        out += `\n${progressIcon} **${obj.statement}**`;
        if (objTotal > 0) {
          out += ` (${objComplete}/${objTotal})`;
        }
        out += `\n`;
        
        // Tasks under this objective
        if (objTasks.length === 0) {
          out += `   (no tasks yet)\n`;
        } else {
          for (const t of objTasks) {
            const status = t.status === 'done' ? '✓' : t.is_active ? '●' : '○';
            const priority = t.priority >= 4 ? ' 🔴' : '';
            const active = t.is_active ? ' 🎯' : '';
            out += `   ${status} ${t.text}${priority}${active}\n`;
          }
        }
      }
    }
    
    // Summary
    out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    out += `📊 Progress: ${completedTasks}/${totalTasks} tasks (${pct}%)\n`;
    
    const daysRemaining = getDaysRemaining(sprint.end_date);
    const remaining = totalTasks - completedTasks;
    if (remaining > 0 && daysRemaining > 0) {
      const velocity = (remaining / daysRemaining).toFixed(1);
      out += `📈 Need ${velocity} tasks/day to finish on time\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("list_sprints", {
    status: z.enum(['active', 'completed', 'abandoned', 'all']).optional().default('all'),
  }, async ({ status }) => {
    let query = 'SELECT * FROM sprints WHERE user_id = ?';
    const bindings: any[] = [getCurrentUser()];
    
    if (status !== 'all') {
      query += ' AND status = ?';
      bindings.push(status);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const sprints = await env.DB.prepare(query).bind(...bindings).all();
    
    if (sprints.results.length === 0) {
      return { content: [{ type: "text", text: status === 'all' 
        ? "No sprints found. Create one with `create_sprint`." 
        : `No ${status} sprints found.` 
      }] };
    }
    
    let out = `📋 **Sprints** (${status})\n\n`;
    
    for (const s of sprints.results as any[]) {
      const statusIcon = s.status === 'active' ? '🟢' : s.status === 'completed' ? '✅' : '❌';
      const daysRemaining = getDaysRemaining(s.end_date);
      const daysText = daysRemaining < 0 ? `ended ${Math.abs(daysRemaining)}d ago` : `${daysRemaining}d left`;
      out += `${statusIcon} **${s.name}** (${s.status})\n`;
      out += `   Ends: ${s.end_date} (${daysText})\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("update_sprint", {
    sprint_id: z.string().optional().describe("Sprint ID (defaults to most recent active sprint)"),
    status: z.enum(['active', 'completed', 'abandoned']).optional(),
    end_date: z.string().optional().describe("New end date (YYYY-MM-DD)"),
    name: z.string().optional().describe("New name"),
  }, async ({ sprint_id, status, end_date, name }) => {
    let sprint: any;
    if (sprint_id) {
      sprint = await env.DB.prepare('SELECT * FROM sprints WHERE id = ? AND user_id = ?').bind(sprint_id, getCurrentUser()).first();
    } else {
      sprint = await env.DB.prepare("SELECT * FROM sprints WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").bind(getCurrentUser()).first();
    }
    
    if (!sprint) return { content: [{ type: "text", text: "Sprint not found" }] };
    
    const updates: string[] = [];
    const bindings: any[] = [];
    
    if (status) { updates.push('status = ?'); bindings.push(status); }
    if (end_date) { updates.push('end_date = ?'); bindings.push(end_date); }
    if (name) { updates.push('name = ?'); bindings.push(name); }
    
    if (updates.length === 0) return { content: [{ type: "text", text: "No updates provided" }] };
    
    updates.push('updated_at = ?');
    bindings.push(new Date().toISOString());
    bindings.push(sprint.id);
    
    await env.DB.prepare('UPDATE sprints SET ' + updates.join(', ') + ' WHERE id = ?').bind(...bindings).run();
    
    let out = `✏️ Updated sprint: "${sprint.name}"`;
    if (status) out += `\nStatus: ${status}`;
    if (end_date) out += `\nNew end date: ${end_date}`;
    if (name) out += `\nNew name: ${name}`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("end_sprint", {
    sprint_id: z.string().optional().describe("Sprint ID (defaults to most recent active sprint)"),
    status: z.enum(['completed', 'abandoned']).optional().default('completed'),
  }, async ({ sprint_id, status }) => {
    const ts = new Date().toISOString();
    
    let sprint: any;
    if (sprint_id) {
      sprint = await env.DB.prepare('SELECT * FROM sprints WHERE id = ? AND user_id = ?').bind(sprint_id, getCurrentUser()).first();
    } else {
      sprint = await env.DB.prepare("SELECT * FROM sprints WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").bind(getCurrentUser()).first();
    }
    
    if (!sprint) return { content: [{ type: "text", text: "No active sprint found" }] };
    
    // Get all objectives for this sprint
    const objectives = await env.DB.prepare(
      'SELECT id FROM objectives WHERE sprint_id = ?'
    ).bind(sprint.id).all();
    
    const objectiveIds = (objectives.results as any[]).map(o => o.id);
    
    // Find incomplete tasks and return them to their original categories
    // FIX: Added user_id filter to only affect current user's tasks
    let returnedCount = 0;
    if (objectiveIds.length > 0) {
      const placeholders = objectiveIds.map(() => '?').join(',');
      const incompleteTasks = await env.DB.prepare(
        `SELECT * FROM tasks WHERE objective_id IN (${placeholders}) AND user_id = ? AND status = 'open'`
      ).bind(...objectiveIds, getCurrentUser()).all();
      
      for (const task of incompleteTasks.results as any[]) {
        const restoreCategory = task.original_category || task.category || 'General';
        await env.DB.prepare(
          'UPDATE tasks SET objective_id = NULL, category = ?, last_touched = ? WHERE id = ?'
        ).bind(restoreCategory, ts, task.id).run();
        returnedCount++;
      }
    }
    
    // Mark sprint as complete/abandoned
    await env.DB.prepare(
      'UPDATE sprints SET status = ?, updated_at = ? WHERE id = ?'
    ).bind(status, ts, sprint.id).run();
    
    let out = `✅ Sprint "${sprint.name}" ${status}\n`;
    if (returnedCount > 0) {
      out += `\n📤 ${returnedCount} incomplete task(s) returned to their original categories.`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  // ============================================
  // TASK ACTIVATION (kept from plans.ts)
  // ============================================

  server.tool("activate_task", {
    task_id: z.string().optional(),
    search: z.string().optional(),
  }, async ({ task_id, search }) => {
    let task: any;
    
    if (task_id) {
      task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').bind(task_id, getCurrentUser()).first();
    } else if (search) {
      const results = await env.DB.prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND text LIKE ? LIMIT 5"
      ).bind(getCurrentUser(), '%' + search + '%').all();
      
      if (results.results.length === 0) return { content: [{ type: "text", text: `No task found matching "${search}"` }] };
      if (results.results.length === 1) task = results.results[0];
      else {
        let out = 'Multiple matches:\n';
        for (const t of results.results as any[]) {
          out += `• ${t.text} (ID: ${t.id})\n`;
        }
        return { content: [{ type: "text", text: out }] };
      }
    } else {
      return { content: [{ type: "text", text: "Need task_id or search text" }] };
    }
    
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    
    const ts = new Date().toISOString();
    await env.DB.prepare(
      'UPDATE tasks SET is_active = 1, last_touched = ? WHERE id = ?'
    ).bind(ts, task.id).run();
    
    return { content: [{ type: "text", text: `✅ Activated: "${task.text}" 🎯` }] };
  });

  server.tool("deactivate_task", {
    task_id: z.string().optional(),
    search: z.string().optional(),
  }, async ({ task_id, search }) => {
    let task: any;
    
    if (task_id) {
      task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').bind(task_id, getCurrentUser()).first();
    } else if (search) {
      const results = await env.DB.prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND is_active = 1 AND text LIKE ? LIMIT 5"
      ).bind(getCurrentUser(), '%' + search + '%').all();
      
      if (results.results.length === 0) return { content: [{ type: "text", text: `No active task found matching "${search}"` }] };
      if (results.results.length === 1) task = results.results[0];
      else {
        let out = 'Multiple matches:\n';
        for (const t of results.results as any[]) {
          out += `• ${t.text} (ID: ${t.id})\n`;
        }
        return { content: [{ type: "text", text: out }] };
      }
    } else {
      return { content: [{ type: "text", text: "Need task_id or search text" }] };
    }
    
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    
    const ts = new Date().toISOString();
    await env.DB.prepare(
      'UPDATE tasks SET is_active = 0, last_touched = ? WHERE id = ?'
    ).bind(ts, task.id).run();
    
    return { content: [{ type: "text", text: `➖ Deactivated: "${task.text}"` }] };
  });
}
