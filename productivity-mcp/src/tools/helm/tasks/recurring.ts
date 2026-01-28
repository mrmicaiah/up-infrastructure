// Recurring task management

import { z } from 'zod';
import type { ToolContext } from '../../../types';
import { normalizeUser, getCaughtUpDueDate } from '../../../helpers/utils';
import { logEvent } from '../../../helpers/intelligence';

export function registerTaskRecurringTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool('catchup_recurring_tasks', {
    dry_run: z.boolean().optional().default(false).describe('Preview what would be updated without making changes'),
    user: z.string().optional().describe('Catch up tasks for a specific user (admin only)'),
  }, async ({ dry_run, user }) => {
    const targetUser = user ? normalizeUser(user) : getCurrentUser();
    const today = new Date().toISOString().split('T')[0];

    const overdueTasks = await env.DB.prepare(
      "SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND recurrence IS NOT NULL AND due_date < ?"
    ).bind(targetUser, today).all();

    if (overdueTasks.results.length === 0) {
      return { content: [{ type: 'text', text: '✅ No overdue recurring tasks found for ' + targetUser }] };
    }

    let out = dry_run ? '🔍 **Preview: Recurring Tasks to Catch Up**\n\n' : '🔄 **Caught Up Recurring Tasks**\n\n';
    out += `Found ${overdueTasks.results.length} overdue recurring task(s) for ${targetUser}:\n\n`;

    const updates: Array<{ task: any; newDate: string }> = [];

    for (const task of overdueTasks.results as any[]) {
      const newDate = getCaughtUpDueDate(task.recurrence);
      updates.push({ task, newDate });

      out += `• **${task.text}**\n`;
      out += `  Was: ${task.due_date} → Now: ${newDate}\n`;
      out += `  Pattern: 🔄${task.recurrence}\n\n`;
    }

    if (!dry_run) {
      const ts = new Date().toISOString();
      for (const { task, newDate } of updates) {
        await env.DB.prepare(
          'UPDATE tasks SET due_date = ?, last_touched = ? WHERE id = ?'
        ).bind(newDate, ts, task.id).run();

        await logEvent(env, targetUser, 'catchup', task.id, {
          oldDate: task.due_date,
          newDate,
          recurrence: task.recurrence,
        });
      }

      out += `\n✅ Updated ${updates.length} task(s)`;
    } else {
      out += `\n💡 Run without dry_run to apply these changes`;
    }

    return { content: [{ type: 'text', text: out }] };
  });
}
