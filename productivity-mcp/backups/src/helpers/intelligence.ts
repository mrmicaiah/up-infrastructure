// Intelligence helpers - pattern analysis, event logging, nudges

import { getDayOfWeek, getTimeOfDay } from './utils';

export async function logEvent(env: any, userId: string, eventType: string, taskId: string | null, eventData: any = {}) {
  await env.DB.prepare(
    'INSERT INTO task_events (id, user_id, task_id, event_type, event_data, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    crypto.randomUUID(),
    userId,
    taskId,
    eventType,
    JSON.stringify({ ...eventData, day: getDayOfWeek(), time: getTimeOfDay() }),
    new Date().toISOString()
  ).run();
}

export async function updateDailyLog(env: any, userId: string, field: 'tasks_completed' | 'tasks_created', increment: number = 1) {
  const today = new Date().toISOString().split('T')[0];
  
  // Try to update existing row
  const result = await env.DB.prepare(
    `UPDATE daily_logs SET ${field} = ${field} + ? WHERE user_id = ? AND log_date = ?`
  ).bind(increment, userId, today).run();
  
  // If no row existed, insert one
  if (result.meta.changes === 0) {
    const values = { tasks_completed: 0, tasks_created: 0 };
    values[field] = increment;
    await env.DB.prepare(
      'INSERT INTO daily_logs (id, user_id, log_date, tasks_completed, tasks_created) VALUES (?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), userId, today, values.tasks_completed, values.tasks_created).run();
  }
}

export async function getPatterns(env: any, userId: string): Promise<any[]> {
  try {
    const result = await env.DB.prepare(
      'SELECT * FROM user_patterns WHERE user_id = ? ORDER BY confidence DESC'
    ).bind(userId).all();
    return result.results || [];
  } catch {
    return [];
  }
}

export async function upsertPattern(env: any, userId: string, patternType: string, data: any, confidence: number) {
  const existing = await env.DB.prepare(
    'SELECT id FROM user_patterns WHERE user_id = ? AND pattern_type = ?'
  ).bind(userId, patternType).first();
  
  if (existing) {
    await env.DB.prepare(
      'UPDATE user_patterns SET pattern_data = ?, confidence = ?, updated_at = ? WHERE id = ?'
    ).bind(JSON.stringify(data), confidence, new Date().toISOString(), existing.id).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO user_patterns (user_id, pattern_type, pattern_data, confidence, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(userId, patternType, JSON.stringify(data), confidence, new Date().toISOString()).run();
  }
}

export async function analyzeAndStorePatterns(env: any, userId: string): Promise<string[]> {
  const insights: string[] = [];
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  
  // 1. Peak productivity hours
  const completionsByTime = await env.DB.prepare(`
    SELECT 
      json_extract(event_data, '$.time') as time_of_day,
      COUNT(*) as count
    FROM task_events 
    WHERE user_id = ? AND event_type = 'completed' AND created_at >= ?
    GROUP BY time_of_day
    ORDER BY count DESC
  `).bind(userId, thirtyDaysAgo).all();
  
  if (completionsByTime.results.length > 0) {
    const peak = completionsByTime.results[0];
    if (peak.count >= 3) {
      insights.push(`Most productive in the ${peak.time_of_day}`);
      await upsertPattern(env, userId, 'peak_time', { time: peak.time_of_day, count: peak.count }, peak.count / 10);
    }
  }
  
  // 2. Peak productivity days
  const completionsByDay = await env.DB.prepare(`
    SELECT 
      json_extract(event_data, '$.day') as day_of_week,
      COUNT(*) as count
    FROM task_events 
    WHERE user_id = ? AND event_type = 'completed' AND created_at >= ?
    GROUP BY day_of_week
    ORDER BY count DESC
  `).bind(userId, thirtyDaysAgo).all();
  
  if (completionsByDay.results.length > 0) {
    const peak = completionsByDay.results[0];
    if (peak.count >= 3) {
      insights.push(`Most productive on ${peak.day_of_week}s`);
      await upsertPattern(env, userId, 'peak_day', { day: peak.day_of_week, count: peak.count }, peak.count / 10);
    }
  }
  
  // 3. Completion rate by focus level
  const focusStats = await env.DB.prepare(`
    SELECT 
      focus_level,
      COUNT(CASE WHEN status = 'done' THEN 1 END) as completed,
      COUNT(*) as total
    FROM tasks 
    WHERE user_id = ? AND created_at >= ?
    GROUP BY focus_level
  `).bind(userId, thirtyDaysAgo).all();
  
  for (const stat of focusStats.results) {
    const rate = stat.total > 0 ? stat.completed / stat.total : 0;
    if (stat.total >= 5) {
      if (rate < 0.3) {
        insights.push(`Struggling with ${stat.focus_level}-focus tasks (${Math.round(rate * 100)}% completion)`);
      } else if (rate > 0.7) {
        insights.push(`Great at ${stat.focus_level}-focus tasks (${Math.round(rate * 100)}% completion)`);
      }
      await upsertPattern(env, userId, `completion_rate_${stat.focus_level}`, { rate, total: stat.total }, rate);
    }
  }
  
  // 4. Average time to complete tasks
  const avgCompletion = await env.DB.prepare(`
    SELECT 
      AVG(julianday(completed_at) - julianday(created_at)) as avg_days
    FROM tasks 
    WHERE user_id = ? AND status = 'done' AND completed_at IS NOT NULL AND created_at >= ?
  `).bind(userId, thirtyDaysAgo).first();
  
  if (avgCompletion?.avg_days) {
    const days = Math.round(avgCompletion.avg_days * 10) / 10;
    insights.push(`Average task completion: ${days} days`);
    await upsertPattern(env, userId, 'avg_completion_days', { days }, 0.8);
  }
  
  // 5. Avoidance patterns (tasks that sit open > 7 days)
  const stuckTasks = await env.DB.prepare(`
    SELECT category, COUNT(*) as count
    FROM tasks 
    WHERE user_id = ? AND status = 'open' AND julianday('now') - julianday(created_at) >= 7
    GROUP BY category
    ORDER BY count DESC
  `).bind(userId).all();
  
  if (stuckTasks.results.length > 0 && stuckTasks.results[0].count >= 2) {
    const category = stuckTasks.results[0].category || 'uncategorized';
    insights.push(`Tends to delay ${category} tasks`);
    await upsertPattern(env, userId, 'avoidance_category', { category, count: stuckTasks.results[0].count }, 0.7);
  }
  
  return insights;
}

export function generateNudges(patterns: any[], openTasks: any[]): string[] {
  const nudges: string[] = [];
  const now = new Date();
  const currentTime = getTimeOfDay();
  const currentDay = getDayOfWeek();
  
  for (const pattern of patterns) {
    const data = JSON.parse(pattern.pattern_data);
    
    switch (pattern.pattern_type) {
      case 'peak_time':
        if (data.time === currentTime) {
          nudges.push(`🔥 It's your peak time (${currentTime}) - tackle something important!`);
        }
        break;
      case 'peak_day':
        if (data.day === currentDay) {
          nudges.push(`📈 ${currentDay}s are your most productive day - make it count!`);
        }
        break;
      case 'avoidance_category':
        const avoidedTasks = openTasks.filter(t => t.category === data.category);
        if (avoidedTasks.length > 0) {
          nudges.push(`⚠️ You have ${avoidedTasks.length} ${data.category} tasks piling up`);
        }
        break;
      case 'completion_rate_high':
        if (data.rate < 0.4) {
          nudges.push(`💡 Try breaking down high-focus tasks - you complete ${Math.round(data.rate * 100)}% of them`);
        }
        break;
    }
  }
  
  // Check for tasks due soon
  const upcoming = openTasks.filter(t => {
    if (!t.due_date) return false;
    const due = new Date(t.due_date);
    const daysUntil = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return daysUntil <= 3 && daysUntil >= 0;
  });
  
  if (upcoming.length > 0) {
    nudges.push(`🗓️ ${upcoming.length} task(s) due in the next 3 days`);
  }
  
  // Check for cold tasks
  const coldTasks = openTasks.filter(t => {
    const created = new Date(t.created_at);
    const daysOld = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
    return daysOld >= 7;
  });
  
  if (coldTasks.length >= 3) {
    nudges.push(`❄️ ${coldTasks.length} tasks are over a week old`);
  }
  
  return nudges;
}

// Auto-checkpoint helper - creates checkpoint when tasks are added/completed
export async function autoCheckpoint(
  env: any, 
  userId: string, 
  trigger: string, 
  summary: string, 
  topics: string[] = [],
  taskId: string | null = null
) {
  try {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const ts = now.toISOString();
    
    // Get or create today's session
    let session = await env.DB.prepare(
      'SELECT * FROM work_sessions WHERE user_id = ? AND session_date = ?'
    ).bind(userId, today).first();
    
    let sessionId: string;
    if (!session) {
      // Auto-create session if none exists
      sessionId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO work_sessions (id, user_id, session_date, started_at, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(sessionId, userId, today, ts, ts).run();
    } else {
      sessionId = session.id;
    }
    
    // Create checkpoint
    await env.DB.prepare(
      'INSERT INTO checkpoints (id, user_id, session_id, checkpoint_time, trigger_type, summary, topics, task_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(),
      userId,
      sessionId,
      ts,
      trigger,
      summary,
      JSON.stringify(topics),
      taskId ? JSON.stringify([taskId]) : '[]',
      ts
    ).run();
  } catch (e) {
    // Silently fail - checkpointing shouldn't break task operations
    console.error('Auto-checkpoint failed:', e);
  }
}
