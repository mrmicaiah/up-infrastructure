// Handoff tools - Task queue for async work between sessions

import { ToolContext } from '../types';
import { z } from 'zod';

export function registerHandoffTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  // Manager Tools - for creating and managing tasks
  
  server.tool("handoff_create_task", {
    instruction: z.string().describe("The task instruction/description"),
    context: z.string().optional().describe("Additional context about the task"),
    files_needed: z.array(z.string()).optional().describe("Array of files that might be needed"),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe("Task priority"),
    estimated_complexity: z.enum(['simple', 'moderate', 'complex']).optional().describe("Estimated complexity"),
    project_name: z.string().optional().describe("Project this task belongs to"),
    parent_task_id: z.string().optional().describe("Parent task ID if this is a subtask"),
  }, async ({ instruction, context, files_needed, priority, estimated_complexity, project_name, parent_task_id }) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const pri = priority || 'normal';
    const complexity = estimated_complexity || 'moderate';
    const proj = project_name || 'General';
    
    await env.DB.prepare(`
      INSERT INTO handoff_tasks (id, instruction, context, files_needed, priority, estimated_complexity, project_name, parent_task_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).bind(
      id, instruction, context || null, 
      files_needed ? JSON.stringify(files_needed) : null,
      pri, complexity, proj, parent_task_id || null, now, now
    ).run();
    
    return {
      content: [{
        type: "text",
        text: `✅ Task created\nTask ID: ${id}\nPriority: ${pri}\nProject: ${proj}`
      }]
    };
  });

  server.tool("handoff_view_queue", {
    status: z.enum(['pending', 'claimed', 'in_progress', 'complete', 'blocked']).optional().describe("Filter by status"),
    project_name: z.string().optional().describe("Filter by project"),
    priority: z.string().optional().describe("Filter by priority"),
    limit: z.number().optional().default(20).describe("Max results to return"),
  }, async ({ status, project_name, priority, limit }) => {
    let query = 'SELECT * FROM handoff_tasks WHERE 1=1';
    const params: any[] = [];
    
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (project_name) { query += ' AND project_name = ?'; params.push(project_name); }
    if (priority) { query += ' AND priority = ?'; params.push(priority); }
    
    query += ' ORDER BY CASE priority WHEN "urgent" THEN 1 WHEN "high" THEN 2 WHEN "normal" THEN 3 ELSE 4 END, created_at ASC LIMIT ?';
    params.push(limit || 20);
    
    const result = await env.DB.prepare(query).bind(...params).all();
    const tasks = result.results || [];
    
    let output = `📋 **Handoff Queue** (${tasks.length} tasks)\n\n`;
    
    if (status || project_name || priority) {
      output += `**Filters:** `;
      const filters = [];
      if (status) filters.push(`status=${status}`);
      if (project_name) filters.push(`project=${project_name}`);
      if (priority) filters.push(`priority=${priority}`);
      output += filters.join(', ') + '\n\n';
    }
    
    if (tasks.length === 0) {
      output += 'No tasks found.';
    } else {
      for (const task of tasks as any[]) {
        const priorityIcon = task.priority === 'urgent' ? '🔴' : task.priority === 'high' ? '🟡' : '⚪';
        output += `${priorityIcon} **${task.instruction}**\n`;
        output += `   ID: ${task.id}\n`;
        output += `   Status: ${task.status}\n`;
        if (task.project_name) output += `   Project: ${task.project_name}\n`;
        if (task.context) output += `   Context: ${task.context.slice(0, 100)}${task.context.length > 100 ? '...' : ''}\n`;
        output += '\n';
      }
    }
    
    return { content: [{ type: "text", text: output }] };
  });

  server.tool("handoff_get_results", {
    task_id: z.string().optional().describe("Get specific task result"),
    project_name: z.string().optional().describe("Filter by project"),
    since: z.string().optional().describe("Get results since this date (ISO format)"),
  }, async ({ task_id, project_name, since }) => {
    let query = "SELECT * FROM handoff_tasks WHERE status = 'complete'";
    const params: any[] = [];
    
    if (task_id) { query += ' AND id = ?'; params.push(task_id); }
    if (project_name) { query += ' AND project_name = ?'; params.push(project_name); }
    if (since) { query += ' AND completed_at >= ?'; params.push(since); }
    
    query += ' ORDER BY completed_at DESC LIMIT 20';
    
    const result = await env.DB.prepare(query).bind(...params).all();
    const tasks = result.results || [];
    
    let output = `✅ **Completed Tasks** (${tasks.length} results)\n\n`;
    
    if (tasks.length === 0) {
      output += 'No completed tasks found.';
    } else {
      for (const task of tasks as any[]) {
        output += `**${task.instruction}**\n`;
        output += `   ID: ${task.id}\n`;
        output += `   Completed: ${task.completed_at}\n`;
        if (task.project_name) output += `   Project: ${task.project_name}\n`;
        if (task.output_summary) output += `   Summary: ${task.output_summary}\n`;
        if (task.output_location) output += `   Output: ${task.output_location}\n`;
        output += '\n';
      }
    }
    
    return { content: [{ type: "text", text: output }] };
  });

  server.tool("handoff_update_task", {
    task_id: z.string().describe("Task ID to update (required)"),
    instruction: z.string().optional().describe("New/updated instructions"),
    context: z.string().optional().describe("Add or update context"),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe("Change priority"),
    status: z.enum(['pending', 'claimed', 'in_progress', 'complete', 'blocked']).optional().describe("Manually change status"),
  }, async ({ task_id, instruction, context, priority, status }) => {
    const updates: string[] = [];
    const params: any[] = [];
    
    if (instruction) { updates.push('instruction = ?'); params.push(instruction); }
    if (context) { updates.push('context = ?'); params.push(context); }
    if (priority) { updates.push('priority = ?'); params.push(priority); }
    if (status) { updates.push('status = ?'); params.push(status); }
    
    if (updates.length === 0) {
      return { content: [{ type: "text", text: "❌ No updates provided" }] };
    }
    
    updates.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(task_id);
    
    await env.DB.prepare(`UPDATE handoff_tasks SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
    
    return { content: [{ type: "text", text: `✅ Task updated\nTask ID: ${task_id}` }] };
  });

  server.tool("handoff_project_status", {
    project_name: z.string().describe("Project name to check status for"),
  }, async ({ project_name }) => {
    const stats = await env.DB.prepare(`
      SELECT status, COUNT(*) as count FROM handoff_tasks 
      WHERE project_name = ? GROUP BY status
    `).bind(project_name).all();
    
    const counts: Record<string, number> = { pending: 0, claimed: 0, in_progress: 0, complete: 0, blocked: 0 };
    for (const row of (stats.results || []) as any[]) {
      counts[row.status] = row.count;
    }
    
    const blocked = await env.DB.prepare(`
      SELECT instruction, blocked_reason FROM handoff_tasks 
      WHERE project_name = ? AND status = 'blocked' LIMIT 5
    `).bind(project_name).all();
    
    let output = `📊 **Project Status: ${project_name}**\n\n`;
    output += `**Task Counts:**\n`;
    output += `   Pending: ${counts.pending}\n`;
    output += `   Claimed: ${counts.claimed}\n`;
    output += `   In Progress: ${counts.in_progress}\n`;
    output += `   Complete: ${counts.complete}\n`;
    output += `   Blocked: ${counts.blocked}\n`;
    
    if (blocked.results && blocked.results.length > 0) {
      output += `\n**Blocked Tasks:**\n`;
      for (const task of blocked.results as any[]) {
        output += `   ⚠️ ${task.instruction}\n`;
        if (task.blocked_reason) output += `      Reason: ${task.blocked_reason}\n`;
      }
    }
    
    return { content: [{ type: "text", text: output }] };
  });

  // Worker Tools - for claiming and completing tasks
  
  server.tool("handoff_get_next_task", {
    priority_filter: z.enum(['high', 'urgent']).optional().describe("Only get high/urgent tasks"),
    project_name: z.string().optional().describe("Only get tasks from this project"),
  }, async ({ priority_filter, project_name }) => {
    let query = "SELECT * FROM handoff_tasks WHERE status = 'pending'";
    const params: any[] = [];
    
    if (priority_filter === 'urgent') {
      query += " AND priority = 'urgent'";
    } else if (priority_filter === 'high') {
      query += " AND priority IN ('high', 'urgent')";
    }
    if (project_name) { query += ' AND project_name = ?'; params.push(project_name); }
    
    query += ' ORDER BY CASE priority WHEN "urgent" THEN 1 WHEN "high" THEN 2 WHEN "normal" THEN 3 ELSE 4 END, created_at ASC LIMIT 1';
    
    const result = await env.DB.prepare(query).bind(...params).first() as any;
    
    if (!result) {
      return { content: [{ type: "text", text: "📭 No pending tasks available" }] };
    }
    
    // Claim the task
    await env.DB.prepare(`
      UPDATE handoff_tasks SET status = 'claimed', claimed_at = ?, updated_at = ? WHERE id = ?
    `).bind(new Date().toISOString(), new Date().toISOString(), result.id).run();
    
    let output = `📋 **Claimed Task**\n\n`;
    output += `**${result.instruction}**\n\n`;
    output += `ID: ${result.id}\n`;
    output += `Priority: ${result.priority}\n`;
    output += `Complexity: ${result.estimated_complexity || 'moderate'}\n`;
    if (result.project_name) output += `Project: ${result.project_name}\n`;
    if (result.context) output += `\n**Context:**\n${result.context}\n`;
    if (result.files_needed) {
      const files = JSON.parse(result.files_needed);
      if (files.length > 0) {
        output += `\n**Files Needed:**\n`;
        for (const file of files) {
          output += `   • ${file}\n`;
        }
      }
    }
    
    return { content: [{ type: "text", text: output }] };
  });

  server.tool("handoff_get_task", {
    task_id: z.string().describe("The task ID to retrieve"),
  }, async ({ task_id }) => {
    const task = await env.DB.prepare('SELECT * FROM handoff_tasks WHERE id = ?').bind(task_id).first() as any;
    
    if (!task) {
      return { content: [{ type: "text", text: "❌ Task not found" }] };
    }
    
    let output = `**${task.instruction}**\n\n`;
    output += `ID: ${task.id}\n`;
    output += `Status: ${task.status}\n`;
    output += `Priority: ${task.priority}\n`;
    if (task.project_name) output += `Project: ${task.project_name}\n`;
    if (task.context) output += `\nContext: ${task.context}\n`;
    
    return { content: [{ type: "text", text: output }] };
  });

  server.tool("handoff_complete_task", {
    task_id: z.string().describe("Task ID to mark complete"),
    output_summary: z.string().describe("Summary of what was completed"),
    output_location: z.enum(['github', 'drive', 'both', 'local']).describe("Where the output is located"),
    files_created: z.array(z.string()).optional().describe("List of files created"),
    github_repo: z.string().optional().describe("GitHub repository name"),
    github_paths: z.array(z.string()).optional().describe("Paths in GitHub"),
    drive_folder_id: z.string().optional().describe("Google Drive folder ID"),
    drive_file_ids: z.array(z.string()).optional().describe("Google Drive file IDs"),
    worker_notes: z.string().optional().describe("Additional notes from worker"),
  }, async ({ task_id, output_summary, output_location, files_created, github_repo, github_paths, drive_folder_id, drive_file_ids, worker_notes }) => {
    const now = new Date().toISOString();
    
    await env.DB.prepare(`
      UPDATE handoff_tasks SET 
        status = 'complete', 
        completed_at = ?, 
        updated_at = ?,
        output_summary = ?,
        output_location = ?,
        files_created = ?,
        github_repo = ?,
        github_paths = ?,
        drive_folder_id = ?,
        drive_file_ids = ?,
        worker_notes = ?
      WHERE id = ?
    `).bind(
      now, now, output_summary, output_location,
      files_created ? JSON.stringify(files_created) : null,
      github_repo || null,
      github_paths ? JSON.stringify(github_paths) : null,
      drive_folder_id || null,
      drive_file_ids ? JSON.stringify(drive_file_ids) : null,
      worker_notes || null,
      task_id
    ).run();
    
    return {
      content: [{
        type: "text",
        text: `✅ Task completed\nTask ID: ${task_id}\nOutput location: ${output_location}`
      }]
    };
  });

  server.tool("handoff_block_task", {
    task_id: z.string().describe("Task ID to mark as blocked"),
    reason: z.string().describe("Reason why the task is blocked"),
  }, async ({ task_id, reason }) => {
    await env.DB.prepare(`
      UPDATE handoff_tasks SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?
    `).bind(reason, new Date().toISOString(), task_id).run();
    
    return {
      content: [{
        type: "text",
        text: `⚠️ Task blocked\nTask ID: ${task_id}\nReason: ${reason}`
      }]
    };
  });

  server.tool("handoff_update_progress", {
    task_id: z.string().describe("Task ID to update"),
    notes: z.string().describe("Progress notes"),
  }, async ({ task_id, notes }) => {
    await env.DB.prepare(`
      UPDATE handoff_tasks SET status = 'in_progress', progress_notes = ?, updated_at = ? WHERE id = ?
    `).bind(notes, new Date().toISOString(), task_id).run();
    
    return {
      content: [{
        type: "text",
        text: `✅ Progress updated\nTask ID: ${task_id}`
      }]
    };
  });

  server.tool("handoff_my_tasks", {}, async () => {
    const result = await env.DB.prepare(`
      SELECT * FROM handoff_tasks WHERE status IN ('claimed', 'in_progress') 
      ORDER BY CASE priority WHEN "urgent" THEN 1 WHEN "high" THEN 2 WHEN "normal" THEN 3 ELSE 4 END, created_at ASC
    `).all();
    
    const tasks = result.results || [];
    
    let output = `📋 **My Active Tasks** (${tasks.length} tasks)\n\n`;
    
    if (tasks.length === 0) {
      output += 'No active tasks.';
    } else {
      for (const task of tasks as any[]) {
        const priorityIcon = task.priority === 'urgent' ? '🔴' : task.priority === 'high' ? '🟡' : '⚪';
        const statusIcon = task.status === 'in_progress' ? '🔄' : '📌';
        
        output += `${statusIcon} ${priorityIcon} **${task.instruction}**\n`;
        output += `   ID: ${task.id}\n`;
        output += `   Status: ${task.status}\n`;
        if (task.project_name) output += `   Project: ${task.project_name}\n`;
        output += '\n';
      }
    }
    
    return { content: [{ type: "text", text: output }] };
  });
}
