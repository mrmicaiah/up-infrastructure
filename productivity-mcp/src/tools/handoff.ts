/**
 * Handoff Tools - Manager/Worker dual-chat workflow system
 * Manager creates tasks, Worker claims and completes them
 */

import { ToolContext } from '../types';
import { z } from 'zod';

export function registerHandoffTools(ctx: ToolContext) {
  const { server, env } = ctx;
  const db = env.DB;

  // ==================== MANAGER TOOLS ====================

  server.tool(
    'handoff_create_task',
    {
      instruction: z.string().describe('Clear description of what needs to be done'),
      context: z.string().optional().describe('Additional requirements, constraints, or background'),
      files_needed: z.array(z.string()).optional().describe('File references the Worker might need'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Task priority (default: normal)'),
      estimated_complexity: z.enum(['simple', 'moderate', 'complex']).optional().describe('Estimated complexity'),
      project_name: z.string().optional().describe('Group related tasks together'),
      parent_task_id: z.string().optional().describe('If this is a subtask of another task'),
    },
    async (params) => {
      const taskId = `TASK-${crypto.randomUUID().slice(0, 10)}`;

      await db
        .prepare(
          `INSERT INTO handoff_queue (
            id, instruction, context, files_needed, priority,
            estimated_complexity, project_name, parent_task_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`
        )
        .bind(
          taskId,
          params.instruction,
          params.context || null,
          params.files_needed ? JSON.stringify(params.files_needed) : null,
          params.priority || 'normal',
          params.estimated_complexity || 'moderate',
          params.project_name || null,
          params.parent_task_id || null
        )
        .run();

      return {
        content: [
          {
            type: 'text',
            text: `✅ **Task Created: ${taskId}**\n\n**Instruction:** ${params.instruction}\n**Priority:** ${params.priority || 'normal'}\n**Project:** ${params.project_name || 'unassigned'}\n\nTask is now in the queue for a Worker chat to claim.`,
          },
        ],
      };
    }
  );

  server.tool(
    'handoff_view_queue',
    {
      status: z.enum(['pending', 'claimed', 'in_progress', 'complete', 'blocked']).optional().describe('Filter by status'),
      project_name: z.string().optional().describe('Filter by project'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Filter by priority'),
      limit: z.number().optional().default(20).describe('Max results (default: 20)'),
    },
    async (params) => {
      const { status, project_name, priority, limit = 20 } = params;

      let query = 'SELECT * FROM handoff_queue WHERE 1=1';
      const bindings: any[] = [];

      if (status) {
        query += ' AND status = ?';
        bindings.push(status);
      }

      if (project_name) {
        query += ' AND project_name = ?';
        bindings.push(project_name);
      }

      if (priority) {
        query += ' AND priority = ?';
        bindings.push(priority);
      }

      query += ` ORDER BY 
        CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 END,
        created_at ASC LIMIT ?`;
      bindings.push(limit);

      const result = await db
        .prepare(query)
        .bind(...bindings)
        .all();

      const tasks = (result.results || []).map((task: any) => ({
        ...task,
        files_needed: task.files_needed ? JSON.parse(task.files_needed) : [],
        files_created: task.files_created ? JSON.parse(task.files_created) : [],
      }));

      if (tasks.length === 0) {
        return { content: [{ type: 'text', text: '📭 No tasks match the criteria.' }] };
      }

      const statusEmoji: Record<string, string> = {
        pending: '⏳',
        claimed: '👋',
        in_progress: '🔧',
        complete: '✅',
        blocked: '🚫',
      };

      const lines = tasks.map((t: any) => {
        const emoji = statusEmoji[t.status] || '❓';
        const proj = t.project_name ? ` [${t.project_name}]` : '';
        return `${emoji} **${t.id}**${proj} (${t.priority})\n   ${t.instruction.slice(0, 80)}${t.instruction.length > 80 ? '...' : ''}`;
      });

      return {
        content: [
          {
            type: 'text',
            text: `📋 **Handoff Queue** (${tasks.length} tasks)\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    }
  );

  server.tool(
    'handoff_get_results',
    {
      task_id: z.string().optional().describe('Get specific task results'),
      project_name: z.string().optional().describe('Get all results for a project'),
      since: z.string().optional().describe('ISO date to get results since'),
    },
    async (params) => {
      let query = `SELECT * FROM handoff_queue WHERE status = 'complete'`;
      const bindings: any[] = [];

      if (params.task_id) {
        query = 'SELECT * FROM handoff_queue WHERE id = ?';
        bindings.push(params.task_id);
      } else {
        if (params.project_name) {
          query += ' AND project_name = ?';
          bindings.push(params.project_name);
        }
        if (params.since) {
          query += ' AND completed_at >= ?';
          bindings.push(params.since);
        }
        query += ' ORDER BY completed_at DESC LIMIT 50';
      }

      const result = await db
        .prepare(query)
        .bind(...bindings)
        .all();

      const tasks = (result.results || []).map((task: any) => ({
        ...task,
        files_created: task.files_created ? JSON.parse(task.files_created) : [],
        github_paths: task.github_paths ? JSON.parse(task.github_paths) : [],
        drive_file_ids: task.drive_file_ids ? JSON.parse(task.drive_file_ids) : [],
      }));

      if (tasks.length === 0) {
        return { content: [{ type: 'text', text: '📭 No completed tasks found.' }] };
      }

      const lines = tasks.map((t: any) => {
        let output = `✅ **${t.id}**\n`;
        output += `   ${t.instruction.slice(0, 60)}...\n`;
        output += `   📍 ${t.output_location || 'unknown'}\n`;
        if (t.output_summary) output += `   📝 ${t.output_summary.slice(0, 100)}...\n`;
        if (t.github_repo) output += `   🔗 ${t.github_repo}\n`;
        return output;
      });

      return {
        content: [{ type: 'text', text: `📦 **Completed Tasks** (${tasks.length})\n\n${lines.join('\n')}` }],
      };
    }
  );

  server.tool(
    'handoff_update_task',
    {
      task_id: z.string().describe('Task to update (required)'),
      instruction: z.string().optional().describe('New/updated instructions'),
      context: z.string().optional().describe('Add or update context'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Change priority'),
      status: z.enum(['pending', 'claimed', 'in_progress', 'complete', 'blocked']).optional().describe('Manually change status'),
    },
    async (params) => {
      const updates: string[] = [];
      const bindings: any[] = [];

      if (params.instruction) {
        updates.push('instruction = ?');
        bindings.push(params.instruction);
      }
      if (params.context) {
        updates.push('context = ?');
        bindings.push(params.context);
      }
      if (params.priority) {
        updates.push('priority = ?');
        bindings.push(params.priority);
      }
      if (params.status) {
        updates.push('status = ?');
        bindings.push(params.status);
      }

      if (updates.length === 0) {
        return { content: [{ type: 'text', text: '⚠️ No updates provided.' }] };
      }

      updates.push("updated_at = datetime('now')");
      bindings.push(params.task_id);

      await db
        .prepare(`UPDATE handoff_queue SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...bindings)
        .run();

      return { content: [{ type: 'text', text: `✅ Task **${params.task_id}** updated.` }] };
    }
  );

  server.tool(
    'handoff_project_status',
    {
      project_name: z.string().describe('Project to check (required)'),
    },
    async (params) => {
      const statsResult = await db
        .prepare(
          `SELECT status, COUNT(*) as count FROM handoff_queue WHERE project_name = ? GROUP BY status`
        )
        .bind(params.project_name)
        .all();

      const stats: Record<string, number> = { pending: 0, claimed: 0, in_progress: 0, complete: 0, blocked: 0 };
      (statsResult.results || []).forEach((row: any) => {
        stats[row.status] = row.count;
      });

      const blockedResult = await db
        .prepare(
          `SELECT id, instruction, blocked_reason FROM handoff_queue WHERE project_name = ? AND status = 'blocked'`
        )
        .bind(params.project_name)
        .all();

      const total = Object.values(stats).reduce((a, b) => a + b, 0);
      const progress = total > 0 ? Math.round((stats.complete / total) * 100) : 0;

      let text = `📊 **${params.project_name}** - ${progress}% complete\n\n`;
      text += `⏳ Pending: ${stats.pending}\n`;
      text += `👋 Claimed: ${stats.claimed}\n`;
      text += `🔧 In Progress: ${stats.in_progress}\n`;
      text += `✅ Complete: ${stats.complete}\n`;
      text += `🚫 Blocked: ${stats.blocked}\n`;

      if ((blockedResult.results || []).length > 0) {
        text += `\n**Blocked Tasks:**\n`;
        (blockedResult.results || []).forEach((t: any) => {
          text += `- ${t.id}: ${t.blocked_reason || 'No reason given'}\n`;
        });
      }

      return { content: [{ type: 'text', text }] };
    }
  );

  // ==================== WORKER TOOLS ====================

  server.tool(
    'handoff_get_next_task',
    {
      priority_filter: z.enum(['high', 'urgent']).optional().describe('Only claim high/urgent tasks'),
      project_name: z.string().optional().describe('Only claim from specific project'),
    },
    async (params) => {
      let query = `SELECT * FROM handoff_queue WHERE status = 'pending'`;
      const bindings: any[] = [];

      if (params.priority_filter) {
        query += ` AND priority = ?`;
        bindings.push(params.priority_filter);
      }

      if (params.project_name) {
        query += ` AND project_name = ?`;
        bindings.push(params.project_name);
      }

      query += ` ORDER BY 
        CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 END,
        created_at ASC LIMIT 1`;

      const result = await db
        .prepare(query)
        .bind(...bindings)
        .all();

      if ((result.results || []).length === 0) {
        return { content: [{ type: 'text', text: '📭 No pending tasks matching criteria.' }] };
      }

      const task: any = result.results![0];

      // Claim the task
      await db
        .prepare(`UPDATE handoff_queue SET status = 'claimed', claimed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
        .bind(task.id)
        .run();

      const filesNeeded = task.files_needed ? JSON.parse(task.files_needed) : [];

      let text = `✅ **Claimed Task: ${task.id}**\n\n`;
      text += `**Priority:** ${task.priority}\n`;
      text += `**Project:** ${task.project_name || 'unassigned'}\n`;
      text += `**Complexity:** ${task.estimated_complexity}\n\n`;
      text += `**Instruction:**\n${task.instruction}\n\n`;
      if (task.context) text += `**Context:**\n${task.context}\n\n`;
      if (filesNeeded.length > 0) text += `**Files Needed:**\n${filesNeeded.map((f: string) => `- ${f}`).join('\n')}\n`;

      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'handoff_get_task',
    {
      task_id: z.string().describe('The task ID (required)'),
    },
    async (params) => {
      const result = await db.prepare('SELECT * FROM handoff_queue WHERE id = ?').bind(params.task_id).all();

      if ((result.results || []).length === 0) {
        return { content: [{ type: 'text', text: `❌ Task ${params.task_id} not found.` }] };
      }

      const task: any = result.results![0];
      const filesNeeded = task.files_needed ? JSON.parse(task.files_needed) : [];

      let text = `📋 **Task: ${task.id}**\n\n`;
      text += `**Status:** ${task.status}\n`;
      text += `**Priority:** ${task.priority}\n`;
      text += `**Project:** ${task.project_name || 'unassigned'}\n\n`;
      text += `**Instruction:**\n${task.instruction}\n\n`;
      if (task.context) text += `**Context:**\n${task.context}\n\n`;
      if (filesNeeded.length > 0) text += `**Files Needed:**\n${filesNeeded.map((f: string) => `- ${f}`).join('\n')}\n`;
      if (task.blocked_reason) text += `\n🚫 **Blocked:** ${task.blocked_reason}\n`;

      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'handoff_complete_task',
    {
      task_id: z.string().describe('Task to complete (required)'),
      output_summary: z.string().describe('What was accomplished (required)'),
      output_location: z.enum(['github', 'drive', 'both', 'local']).describe('Where outputs are stored (required)'),
      files_created: z.array(z.string()).optional().describe('List of files created'),
      github_repo: z.string().optional().describe('Repository name'),
      github_paths: z.array(z.string()).optional().describe('File paths in repo'),
      drive_folder_id: z.string().optional().describe('Google Drive folder ID'),
      drive_file_ids: z.array(z.string()).optional().describe('Drive file IDs'),
      worker_notes: z.string().optional().describe('Worker commentary or recommendations'),
    },
    async (params) => {
      await db
        .prepare(
          `UPDATE handoff_queue SET
            status = 'complete',
            completed_at = datetime('now'),
            updated_at = datetime('now'),
            output_summary = ?,
            output_location = ?,
            files_created = ?,
            github_repo = ?,
            github_paths = ?,
            drive_folder_id = ?,
            drive_file_ids = ?,
            worker_notes = ?
          WHERE id = ?`
        )
        .bind(
          params.output_summary,
          params.output_location,
          params.files_created ? JSON.stringify(params.files_created) : null,
          params.github_repo || null,
          params.github_paths ? JSON.stringify(params.github_paths) : null,
          params.drive_folder_id || null,
          params.drive_file_ids ? JSON.stringify(params.drive_file_ids) : null,
          params.worker_notes || null,
          params.task_id
        )
        .run();

      return {
        content: [
          {
            type: 'text',
            text: `✅ **Task ${params.task_id} Completed!**\n\n**Summary:** ${params.output_summary}\n**Location:** ${params.output_location}`,
          },
        ],
      };
    }
  );

  server.tool(
    'handoff_block_task',
    {
      task_id: z.string().describe('Task to block (required)'),
      reason: z.string().describe('Clear explanation of what is blocking (required)'),
    },
    async (params) => {
      await db
        .prepare(`UPDATE handoff_queue SET status = 'blocked', blocked_reason = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(params.reason, params.task_id)
        .run();

      return {
        content: [{ type: 'text', text: `🚫 **Task ${params.task_id} Blocked**\n\nReason: ${params.reason}\n\nManager will be notified to provide missing information.` }],
      };
    }
  );

  server.tool(
    'handoff_update_progress',
    {
      task_id: z.string().describe('Task to update (required)'),
      notes: z.string().describe('Progress update notes (required)'),
    },
    async (params) => {
      await db
        .prepare(`UPDATE handoff_queue SET status = 'in_progress', worker_notes = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(params.notes, params.task_id)
        .run();

      return { content: [{ type: 'text', text: `🔧 **Progress Updated on ${params.task_id}**\n\n${params.notes}` }] };
    }
  );

  server.tool(
    'handoff_my_tasks',
    {},
    async () => {
      const result = await db
        .prepare(`SELECT * FROM handoff_queue WHERE status IN ('claimed', 'in_progress') ORDER BY priority DESC, claimed_at ASC`)
        .all();

      const tasks = result.results || [];

      if (tasks.length === 0) {
        return { content: [{ type: 'text', text: '📭 No claimed tasks. Use `handoff_get_next_task` to claim one.' }] };
      }

      const lines = tasks.map((t: any) => {
        const status = t.status === 'claimed' ? '👋' : '🔧';
        return `${status} **${t.id}** (${t.priority})\n   ${t.instruction.slice(0, 80)}...`;
      });

      return { content: [{ type: 'text', text: `📋 **Your Tasks** (${tasks.length})\n\n${lines.join('\n\n')}` }] };
    }
  );
}
