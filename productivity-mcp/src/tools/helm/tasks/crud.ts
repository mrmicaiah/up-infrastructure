// Task CRUD operations: list, add, update, delete

import { z } from 'zod';
import type { ToolContext } from '../../../types';
import {
  needsBreakdown,
  isVagueTask,
  inferFocusLevel,
  normalizeUser,
} from '../../../helpers/utils';
import { logEvent, updateDailyLog, autoCheckpoint } from '../../../helpers/intelligence';

export function registerTaskCrudTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool('list_tasks', {
    status: z.enum(['open', 'done', 'all']).optional().default('open'),
    category: z.string().optional(),
    project: z.string().optional(),
    include_teammate: z.boolean().optional().default(false),
  }, async ({ status, category, project, include_teammate }) => {
    let query = 'SELECT t.*, o.statement as objective_statement FROM tasks t LEFT JOIN objectives o ON t.objective_id = o.id WHERE 1=1';
    const bindings: any[] = [];

    if (!include_teammate) {
      query += ' AND t.user_id = ?';
      bindings.push(getCurrentUser());
    }
    if (status !== 'all') {
      query += ' AND t.status = ?';
      bindings.push(status);
    }
    if (category) {
      query += ' AND t.category = ?';
      bindings.push(category);
    }
    if (project) {
      query += ' AND t.project = ?';
      bindings.push(project);
    }
    query += ' ORDER BY t.priority DESC, t.created_at ASC';

    const result = await env.DB.prepare(query).bind(...bindings).all();
    const tasks = result.results.map((t: any) => ({
      ...t,
      days_old: Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86400000),
    }));

    if (tasks.length === 0) {
      return { content: [{ type: 'text', text: 'No tasks found.\n\n💬 What have you been working on?' }] };
    }

    let output = 'Found ' + tasks.length + ' tasks:\n\n';
    tasks.forEach((t: any, index: number) => {
      const p = t.priority >= 4 ? '🔴' : t.priority === 3 ? '🟡' : '⚪';
      let line = (index + 1) + '. ' + p + ' ' + t.text;
      if (t.category) line += ' [' + t.category + ']';
      if (t.due_date) line += ' (due: ' + t.due_date + ')';
      if (t.recurrence) line += ' 🔄' + t.recurrence;
      if (t.assigned_by) line += ' 📥 from ' + t.assigned_by;
      if (t.is_active) line += ' 🎯';
      if (t.objective_statement) line += ' → ' + t.objective_statement;
      output += line + '\n   ID: ' + t.id + '\n';
    });

    return { content: [{ type: 'text', text: output }] };
  });

  server.tool('add_task', {
    text: z.string(),
    priority: z.number().min(1).max(5).optional().default(3),
    due_date: z.string().optional(),
    category: z.string().optional(),
    project: z.string().optional(),
    notes: z.string().optional(),
    for_user: z.string().optional().describe('Username to assign task to (e.g., "micaiah" or "irene"). Defaults to current user.'),
    recurrence: z.string().optional().describe('daily, weekdays, weekly, biweekly, monthly, yearly, or specific days like "mon,thu" or "fri"'),
    is_active: z.boolean().optional().describe('Add directly to Active list'),
  }, async ({ text, priority, due_date, category, project, notes, for_user, recurrence, is_active }) => {
    const targetUser = normalizeUser(for_user || getCurrentUser());
    const assignedBy = (for_user && normalizeUser(for_user) !== getCurrentUser()) ? getCurrentUser() : null;
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    const focusLevel = inferFocusLevel(text);

    const effectiveDueDate = due_date || (recurrence ? new Date().toISOString().split('T')[0] : null);

    await env.DB.prepare(
      'INSERT INTO tasks (id, user_id, text, priority, due_date, category, project, status, created_at, last_touched, needs_breakdown, is_vague, focus_level, notes, recurrence, assigned_by, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, targetUser, text, priority, effectiveDueDate, category || null, project || null, 'open', ts, ts, needsBreakdown(text) ? 1 : 0, isVagueTask(text) ? 1 : 0, focusLevel, notes || null, recurrence || null, assignedBy, is_active ? 1 : 0).run();

    await logEvent(env, targetUser, 'created', id, { text, priority, category, focusLevel, recurrence, assignedBy });
    await updateDailyLog(env, targetUser, 'tasks_created');
    await autoCheckpoint(env, targetUser, 'task_added', `Added task: ${text}`, [category || project || 'general'], id);

    let resp = 'Added: "' + text + '"';
    if (for_user && normalizeUser(for_user) !== getCurrentUser()) resp += ' (assigned to ' + targetUser + ' — will appear in their Incoming)';
    if (priority >= 4) resp += ' 🔴';
    if (effectiveDueDate) resp += ' - due ' + effectiveDueDate;
    if (recurrence) resp += ' 🔄 ' + recurrence;
    if (is_active) resp += ' 🎯 (active)';

    if (needsBreakdown(text)) resp += '\n\n💡 This looks like a big task. Want to break it down?';
    if (isVagueTask(text)) resp += '\n\n💭 This seems a bit vague. Can you make it more specific?';

    return { content: [{ type: 'text', text: resp }] };
  });

  server.tool('update_task', {
    task_id: z.string(),
    priority: z.number().min(1).max(5).optional(),
    due_date: z.string().optional(),
    category: z.string().optional(),
    notes: z.string().optional(),
    recurrence: z.string().optional().describe('daily, weekdays, weekly, biweekly, monthly, yearly, or specific days like "mon,thu". Set to empty string to remove recurrence.'),
  }, async ({ task_id, priority, due_date, category, notes, recurrence }) => {
    const updates: string[] = [];
    const bindings: any[] = [];
    const changes: any = {};

    if (priority !== undefined) { updates.push('priority = ?'); bindings.push(priority); changes.priority = priority; }
    if (due_date !== undefined) { updates.push('due_date = ?'); bindings.push(due_date); changes.due_date = due_date; }
    if (category !== undefined) { updates.push('category = ?'); bindings.push(category); changes.category = category; }
    if (notes !== undefined) { updates.push('notes = ?'); bindings.push(notes); changes.notes = notes; }
    if (recurrence !== undefined) { updates.push('recurrence = ?'); bindings.push(recurrence === '' ? null : recurrence); changes.recurrence = recurrence; }

    if (updates.length === 0) return { content: [{ type: 'text', text: 'No updates' }] };

    updates.push('last_touched = ?');
    bindings.push(new Date().toISOString());
    bindings.push(task_id);

    await env.DB.prepare('UPDATE tasks SET ' + updates.join(', ') + ' WHERE id = ?').bind(...bindings).run();
    await logEvent(env, getCurrentUser(), 'updated', task_id, changes);

    let resp = '✏️ Updated';
    if (recurrence !== undefined) resp += recurrence ? ' (now recurring: ' + recurrence + ')' : ' (recurrence removed)';

    return { content: [{ type: 'text', text: resp }] };
  });

  server.tool('delete_task', { task_id: z.string() }, async ({ task_id }) => {
    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(task_id).first();
    if (!task) return { content: [{ type: 'text', text: 'Not found' }] };

    await logEvent(env, getCurrentUser(), 'deleted', task_id, { text: task.text });
    await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(task_id).run();

    return { content: [{ type: 'text', text: '🗑️ Deleted: "' + task.text + '"' }] };
  });
}
