import { ToolContext } from '../types';
import { z } from 'zod';
import {
  handoff_create_task,
  handoff_view_queue,
  handoff_get_results,
  handoff_update_task,
  handoff_project_status
} from './project-manager/handoff-manager-tools';
import {
  handoff_get_next_task,
  handoff_get_task,
  handoff_complete_task,
  handoff_block_task,
  handoff_update_progress,
  handoff_list_my_tasks
} from './project-manager/handoff-worker-tools';

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
  }, async (params) => {
    const result = await handoff_create_task(env.DB, params);
    return {
      content: [{
        type: "text",
        text: `✅ ${result.message}\nTask ID: ${result.task_id}\nPriority: ${result.priority}\nProject: ${result.project}`
      }]
    };
  });

  server.tool("handoff_view_queue", {
    status: z.enum(['pending', 'claimed', 'in_progress', 'complete', 'blocked']).optional().describe("Filter by status"),
    project_name: z.string().optional().describe("Filter by project"),
    priority: z.string().optional().describe("Filter by priority"),
    limit: z.number().optional().default(20).describe("Max results to return"),
  }, async (params) => {
    const result = await handoff_view_queue(env.DB, params);
    
    let output = `📋 **Handoff Queue** (${result.total_tasks} tasks)\n\n`;
    
    if (result.filters_applied.status || result.filters_applied.project_name || result.filters_applied.priority) {
      output += `**Filters:** `;
      const filters = [];
      if (result.filters_applied.status) filters.push(`status=${result.filters_applied.status}`);
      if (result.filters_applied.project_name) filters.push(`project=${result.filters_applied.project_name}`);
      if (result.filters_applied.priority) filters.push(`priority=${result.filters_applied.priority}`);
      output += filters.join(', ') + '\n\n';
    }
    
    if (result.tasks.length === 0) {
      output += 'No tasks found.';
    } else {
      for (const task of result.tasks) {
        const priorityIcon = task.priority === 'urgent' ? '🔴' : task.priority === 'high' ? '🟡' : '⚪';
        output += `${priorityIcon} **${task.instruction}**\n`;
        output += `   ID: ${task.id}\n`;
        output += `   Status: ${task.status}\n`;
        if (task.project_name) output += `   Project: ${task.project_name}\n`;
        if (task.context) output += `   Context: ${task.context}\n`;
        if (task.files_needed && task.files_needed.length > 0) {
          output += `   Files needed: ${task.files_needed.join(', ')}\n`;
        }
        output += '\n';
      }
    }
    
    return {
      content: [{ type: "text", text: output }]
    };
  });

  server.tool("handoff_get_results", {
    task_id: z.string().optional().describe("Get specific task result"),
    project_name: z.string().optional().describe("Filter by project"),
    since: z.string().optional().describe("Get results since this date (ISO format)"),
  }, async (params) => {
    const result = await handoff_get_results(env.DB, params);
    
    let output = `✅ **Completed Tasks** (${result.results_count} results)\n\n`;
    
    if (result.tasks.length === 0) {
      output += 'No completed tasks found.';
    } else {
      for (const task of result.tasks) {
        output += `**${task.instruction}**\n`;
        output += `   ID: ${task.id}\n`;
        output += `   Completed: ${task.completed_at}\n`;
        if (task.project_name) output += `   Project: ${task.project_name}\n`;
        if (task.output_summary) output += `   Summary: ${task.output_summary}\n`;
        if (task.output_location) output += `   Output: ${task.output_location}\n`;
        if (task.files_created && task.files_created.length > 0) {
          output += `   Files created: ${task.files_created.join(', ')}\n`;
        }
        if (task.github_paths && task.github_paths.length > 0) {
          output += `   GitHub: ${task.github_paths.join(', ')}\n`;
        }
        if (task.drive_file_ids && task.drive_file_ids.length > 0) {
          output += `   Drive files: ${task.drive_file_ids.length} file(s)\n`;
        }
        output += '\n';
      }
    }
    
    return {
      content: [{ type: "text", text: output }]
    };
  });

  server.tool("handoff_update_task", {
    task_id: z.string().describe("Task ID to update"),
    instruction: z.string().optional().describe("New instruction text"),
    context: z.string().optional().describe("New context"),
    priority: z.string().optional().describe("New priority"),
    status: z.string().optional().describe("New status"),
  }, async (params) => {
    const result = await handoff_update_task(env.DB, params);
    
    if (!result.success) {
      return {
        content: [{ type: "text", text: `❌ Error: ${result.error}` }]
      };
    }
    
    return {
      content: [{ type: "text", text: `✅ ${result.message}\nTask ID: ${result.task_id}` }]
    };
  });

  server.tool("handoff_project_status", {
    project_name: z.string().describe("Project name to check status for"),
  }, async (params) => {
    const result = await handoff_project_status(env.DB, params);
    
    let output = `📊 **Project Status: ${result.project_name}**\n\n`;
    output += `**Task Counts:**\n`;
    output += `   Pending: ${result.stats.pending}\n`;
    output += `   Claimed: ${result.stats.claimed}\n`;
    output += `   In Progress: ${result.stats.in_progress}\n`;
    output += `   Complete: ${result.stats.complete}\n`;
    output += `   Blocked: ${result.stats.blocked}\n`;
    
    if (result.recent_completions && result.recent_completions.length > 0) {
      output += `\n**Recent Completions:**\n`;
      for (const task of result.recent_completions.slice(0, 5)) {
        output += `   ✅ ${task.instruction}\n`;
      }
    }
    
    if (result.blocked_tasks && result.blocked_tasks.length > 0) {
      output += `\n**Blocked Tasks:**\n`;
      for (const task of result.blocked_tasks) {
        output += `   ⚠️ ${task.instruction}\n`;
        output += `      Reason: ${task.blocked_reason}\n`;
      }
    }
    
    return {
      content: [{ type: "text", text: output }]
    };
  });

  // Worker Tools - for claiming and completing tasks
  
  server.tool("handoff_get_next_task", {
    priority_filter: z.enum(['high', 'urgent']).optional().describe("Only get high/urgent tasks"),
    project_name: z.string().optional().describe("Only get tasks from this project"),
  }, async (params) => {
    const result = await handoff_get_next_task(env.DB, params);
    
    if (!result.found) {
      return {
        content: [{ type: "text", text: `📭 ${result.message}` }]
      };
    }
    
    const task = result.task;
    let output = `📋 **Claimed Task**\n\n`;
    output += `**${task.instruction}**\n\n`;
    output += `ID: ${task.id}\n`;
    output += `Priority: ${task.priority}\n`;
    output += `Complexity: ${task.estimated_complexity}\n`;
    if (task.project_name) output += `Project: ${task.project_name}\n`;
    if (task.context) output += `\n**Context:**\n${task.context}\n`;
    if (task.files_needed && task.files_needed.length > 0) {
      output += `\n**Files Needed:**\n`;
      for (const file of task.files_needed) {
        output += `   • ${file}\n`;
      }
    }
    
    return {
      content: [{ type: "text", text: output }]
    };
  });

  server.tool("handoff_get_task", {
    task_id: z.string().describe("Task ID to retrieve"),
  }, async (params) => {
    const result = await handoff_get_task(env.DB, params);
    
    if (!result.found) {
      return {
        content: [{ type: "text", text: `❌ ${result.message}` }]
      };
    }
    
    const task = result.task;
    let output = `**${task.instruction}**\n\n`;
    output += `ID: ${task.id}\n`;
    output += `Status: ${task.status}\n`;
    output += `Priority: ${task.priority}\n`;
    if (task.project_name) output += `Project: ${task.project_name}\n`;
    if (task.context) output += `\nContext: ${task.context}\n`;
    
    return {
      content: [{ type: "text", text: output }]
    };
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
  }, async (params) => {
    const result = await handoff_complete_task(env.DB, params);
    
    let output = `✅ ${result.message}\n`;
    output += `Task ID: ${result.task_id}\n`;
    output += `Output location: ${result.output_location}`;
    
    return {
      content: [{ type: "text", text: output }]
    };
  });

  server.tool("handoff_block_task", {
    task_id: z.string().describe("Task ID to mark as blocked"),
    reason: z.string().describe("Reason why the task is blocked"),
  }, async (params) => {
    const result = await handoff_block_task(env.DB, params);
    
    return {
      content: [{
        type: "text",
        text: `⚠️ ${result.message}\nTask ID: ${result.task_id}\nReason: ${result.reason}`
      }]
    };
  });

  server.tool("handoff_update_progress", {
    task_id: z.string().describe("Task ID to update"),
    notes: z.string().describe("Progress notes"),
  }, async (params) => {
    const result = await handoff_update_progress(env.DB, params);
    
    return {
      content: [{
        type: "text",
        text: `✅ ${result.message}\nTask ID: ${result.task_id}`
      }]
    };
  });

  server.tool("handoff_list_my_tasks", {}, async () => {
    const result = await handoff_list_my_tasks(env.DB);
    
    let output = `📋 **My Active Tasks** (${result.total} tasks)\n\n`;
    
    if (result.tasks.length === 0) {
      output += 'No active tasks.';
    } else {
      for (const task of result.tasks) {
        const priorityIcon = task.priority === 'urgent' ? '🔴' : task.priority === 'high' ? '🟡' : '⚪';
        const statusIcon = task.status === 'in_progress' ? '🔄' : '📌';
        
        output += `${statusIcon} ${priorityIcon} **${task.instruction}**\n`;
        output += `   ID: ${task.id}\n`;
        output += `   Status: ${task.status}\n`;
        if (task.project_name) output += `   Project: ${task.project_name}\n`;
        if (task.files_needed && task.files_needed.length > 0) {
          output += `   Files needed: ${task.files_needed.length} file(s)\n`;
        }
        output += '\n';
      }
    }
    
    return {
      content: [{ type: "text", text: output }]
    };
  });
}
