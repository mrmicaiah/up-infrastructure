// Task workflow operations: complete, claim, snooze, break down

import { z } from 'zod';
import type { ToolContext } from '../../../types';
import { inferFocusLevel, getNextDueDate } from '../../../helpers/utils';
import { logEvent, updateDailyLog, autoCheckpoint } from '../../../helpers/intelligence';

export function registerTaskWorkflowTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool('complete_task', {
    task_id: z.string().optional(),
    search: z.string().optional(),
    position: z.number().optional().describe('Task number from list (e.g., 3 to complete the 3rd task)'),
    include_teammate: z.boolean().optional().default(false).describe('Also search teammate tasks'),
  }, async ({ task_id, search, position, include_teammate }) => {
    let task: any = null;
    let isTeammateTask = false;

    if (position) {
      const results = await env.DB.prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND status = 'open' ORDER BY priority DESC, created_at ASC"
      ).bind(getCurrentUser()).all();

      if (position < 1 || position > results.results.length) {
        return { content: [{ type: 'text', text: `Invalid position. You have ${results.results.length} open tasks.` }] };
      }
      task = results.results[position - 1];
    } else if (task_id) {
      task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(task_id).first();
      if (task && task.user_id !== getCurrentUser()) {
        isTeammateTask = true;
      }
    } else if (search) {
      let results = await env.DB.prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND text LIKE ? LIMIT 5"
      ).bind(getCurrentUser(), '%' + search + '%').all();

      if (results.results.length === 0) {
        results = await env.DB.prepare(
          "SELECT * FROM tasks WHERE user_id != ? AND status = 'open' AND text LIKE ? LIMIT 5"
        ).bind(getCurrentUser(), '%' + search + '%').all();

        if (results.results.length > 0) {
          isTeammateTask = true;
        }
      }

      if (results.results.length === 0) return { content: [{ type: 'text', text: 'No task found matching "' + search + '"' }] };
      if (results.results.length === 1) {
        task = results.results[0];
        if (task.user_id !== getCurrentUser()) {
          isTeammateTask = true;
        }
      } else {
        let out = 'Multiple matches:\n';
        results.results.forEach((t: any, i: number) => {
          out += (i + 1) + '. ' + t.text;
          if (t.user_id !== getCurrentUser()) out += ' (owner: ' + t.user_id + ')';
          out += ' (ID: ' + t.id + ')\n';
        });
        return { content: [{ type: 'text', text: out }] };
      }
    } else {
      return { content: [{ type: 'text', text: 'Need task_id, search text, or position number' }] };
    }

    if (!task) return { content: [{ type: 'text', text: 'Task not found' }] };

    const completedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE tasks SET status = 'done', completed_at = ?, is_active = 0 WHERE id = ?").bind(completedAt, task.id).run();

    // Check if linked to launch checklist
    const checklistItem = await env.DB.prepare('SELECT * FROM launch_checklist WHERE task_id = ?').bind(task.id).first();
    if (checklistItem) {
      await env.DB.prepare('UPDATE launch_checklist SET completed = 1, completed_at = ? WHERE id = ?').bind(completedAt, checklistItem.id).run();
    }

    const daysToComplete = Math.round((Date.now() - new Date(task.created_at).getTime()) / 86400000);

    const taskOwner = task.user_id;
    await logEvent(env, taskOwner, 'completed', task.id, { text: task.text, daysToComplete, focusLevel: task.focus_level, category: task.category, completedBy: getCurrentUser() });
    await updateDailyLog(env, taskOwner, 'tasks_completed');
    await autoCheckpoint(env, getCurrentUser(), 'task_completed', `Completed: ${task.text}`, [task.category || task.project || 'general'], task.id);

    let resp = '✅ Completed: "' + task.text + '"';
    if (isTeammateTask) resp += '\n👥 (Task owned by ' + task.user_id + ')';
    if (daysToComplete === 0) resp += '\n⚡ Same-day completion!';
    else if (daysToComplete <= 1) resp += '\n🎯 Quick turnaround!';
    if (checklistItem) resp += '\n📋 Launch checklist item also marked complete';

    // Handle recurring task
    if (task.recurrence) {
      const nextDue = getNextDueDate(task.due_date, task.recurrence);
      const newId = crypto.randomUUID();
      const ts = new Date().toISOString();

      await env.DB.prepare(
        'INSERT INTO tasks (id, user_id, text, priority, due_date, category, project, status, created_at, last_touched, focus_level, notes, recurrence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(newId, task.user_id, task.text, task.priority, nextDue, task.category, task.project, 'open', ts, ts, task.focus_level, task.notes, task.recurrence).run();

      await logEvent(env, task.user_id, 'created', newId, { text: task.text, recurrence: task.recurrence, source: 'recurring' });
      resp += '\n🔄 Next occurrence created for ' + nextDue;
    }

    return { content: [{ type: 'text', text: resp }] };
  });

  server.tool('claim_task', {
    task_id: z.string().optional(),
    search: z.string().optional(),
    category: z.string().optional().describe('Move to this category when claiming'),
    activate: z.boolean().optional().describe('Also add to Active list'),
  }, async ({ task_id, search, category, activate }) => {
    let task: any = null;

    if (task_id) {
      task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').bind(task_id, getCurrentUser()).first();
    } else if (search) {
      const results = await env.DB.prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND assigned_by IS NOT NULL AND text LIKE ? LIMIT 5"
      ).bind(getCurrentUser(), '%' + search + '%').all();

      if (results.results.length === 0) return { content: [{ type: 'text', text: 'No incoming task found matching "' + search + '"' }] };
      if (results.results.length === 1) task = results.results[0];
      else {
        let out = 'Multiple matches:\n';
        results.results.forEach((t: any, i: number) => { out += (i + 1) + '. ' + t.text + ' (from ' + t.assigned_by + ')\n'; });
        return { content: [{ type: 'text', text: out }] };
      }
    } else {
      return { content: [{ type: 'text', text: 'Need task_id or search text' }] };
    }

    if (!task) return { content: [{ type: 'text', text: 'Task not found' }] };
    if (!task.assigned_by) return { content: [{ type: 'text', text: 'This task is not in your Incoming (no assigned_by)' }] };

    const ts = new Date().toISOString();
    const updates = ['assigned_by = NULL', 'last_touched = ?'];
    const bindings: any[] = [ts];

    if (category) { updates.push('category = ?'); bindings.push(category); }
    if (activate) { updates.push('is_active = 1'); }
    bindings.push(task.id);

    await env.DB.prepare('UPDATE tasks SET ' + updates.join(', ') + ' WHERE id = ?').bind(...bindings).run();

    let resp = '✅ Claimed: "' + task.text + '"';
    if (category) resp += ' → moved to [' + category + ']';
    if (activate) resp += ' 🎯 (activated)';
    resp += '\n\nTask removed from Incoming and added to your list.';

    return { content: [{ type: 'text', text: resp }] };
  });

  server.tool('snooze_task', {
    task_id: z.string(),
    until: z.string().optional(),
    days: z.number().optional(),
  }, async ({ task_id, until, days }) => {
    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(task_id).first();
    if (!task) return { content: [{ type: 'text', text: 'Task not found' }] };

    let snoozeUntil: string;
    if (until) snoozeUntil = until;
    else if (days) { const d = new Date(); d.setDate(d.getDate() + days); snoozeUntil = d.toISOString().split('T')[0]; }
    else { const d = new Date(); d.setDate(d.getDate() + 1); snoozeUntil = d.toISOString().split('T')[0]; }

    await env.DB.prepare('UPDATE tasks SET snoozed_until = ?, last_touched = ? WHERE id = ?').bind(snoozeUntil, new Date().toISOString(), task_id).run();
    await logEvent(env, getCurrentUser(), 'snoozed', task_id, { until: snoozeUntil });

    return { content: [{ type: 'text', text: '😴 Snoozed until ' + snoozeUntil + ': "' + task.text + '"' }] };
  });

  server.tool('break_down_task', {
    task_id: z.string(),
    subtasks: z.array(z.string()),
  }, async ({ task_id, subtasks }) => {
    const parent = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(task_id).first();
    if (!parent) return { content: [{ type: 'text', text: 'Task not found' }] };

    const ts = new Date().toISOString();
    for (const sub of subtasks) {
      const subId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO tasks (id, user_id, text, priority, category, project, status, created_at, last_touched, parent_task_id, focus_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(subId, parent.user_id, sub, parent.priority, parent.category, parent.project, 'open', ts, ts, task_id, inferFocusLevel(sub)).run();
      await logEvent(env, parent.user_id, 'created', subId, { text: sub, parentTask: task_id });
    }

    await env.DB.prepare('UPDATE tasks SET needs_breakdown = 0 WHERE id = ?').bind(task_id).run();
    await logEvent(env, parent.user_id, 'broken_down', task_id, { subtaskCount: subtasks.length });

    return { content: [{ type: 'text', text: 'Broke down into ' + subtasks.length + ' subtasks' }] };
  });

  server.tool('log_progress', {
    description: z.string(),
    task_id: z.string().optional(),
    minutes_spent: z.number().optional(),
  }, async ({ description, task_id, minutes_spent }) => {
    await env.DB.prepare(
      'INSERT INTO progress_logs (id, user_id, logged_at, task_id, description, minutes_spent, was_planned) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), getCurrentUser(), new Date().toISOString(), task_id || null, description, minutes_spent || null, task_id ? 1 : 0).run();

    await logEvent(env, getCurrentUser(), 'progress', task_id || null, { description, minutes_spent });
    return { content: [{ type: 'text', text: '📝 Logged: ' + description }] };
  });
}
