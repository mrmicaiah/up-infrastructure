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

// Store journal-specific patterns
async function upsertJournalPattern(env: any, userId: string, patternType: string, data: any, confidence: number) {
  const ts = new Date().toISOString();
  
  const existing = await env.DB.prepare(
    'SELECT id FROM journal_patterns WHERE user_id = ? AND pattern_type = ?'
  ).bind(userId, patternType).first();
  
  if (existing) {
    await env.DB.prepare(
      'UPDATE journal_patterns SET pattern_data = ?, confidence = ?, updated_at = ? WHERE id = ?'
    ).bind(JSON.stringify(data), confidence, ts, existing.id).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO journal_patterns (id, user_id, pattern_type, pattern_data, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), userId, patternType, JSON.stringify(data), confidence, ts, ts).run();
  }
}

export async function analyzeAndStorePatterns(env: any, userId: string): Promise<string[]> {
  const insights: string[] = [];
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  
  // ==================
  // TASK PATTERNS
  // ==================
  
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
  
  // ==================
  // JOURNAL PATTERNS
  // ==================
  
  try {
    // 6. Mood patterns by day of week
    const moodByDay = await env.DB.prepare(`
      SELECT 
        CASE CAST(strftime('%w', entry_date) AS INTEGER)
          WHEN 0 THEN 'sunday' WHEN 1 THEN 'monday' WHEN 2 THEN 'tuesday'
          WHEN 3 THEN 'wednesday' WHEN 4 THEN 'thursday' WHEN 5 THEN 'friday' WHEN 6 THEN 'saturday'
        END as day_name,
        mood,
        COUNT(*) as count
      FROM journal_entries
      WHERE user_id = ? AND entry_date >= ? AND mood IS NOT NULL
      GROUP BY day_name, mood
      ORDER BY count DESC
    `).bind(userId, thirtyDaysAgo.split('T')[0]).all();
    
    if (moodByDay.results.length > 0) {
      // Find dominant mood per day
      const dayMoods: Record<string, { mood: string; count: number }> = {};
      for (const row of moodByDay.results as any[]) {
        if (!dayMoods[row.day_name] || row.count > dayMoods[row.day_name].count) {
          dayMoods[row.day_name] = { mood: row.mood, count: row.count };
        }
      }
      
      // Check for consistent patterns
      const negativeMoods = ['anxious', 'frustrated', 'sad', 'angry', 'overwhelmed', 'scattered'];
      for (const [day, data] of Object.entries(dayMoods)) {
        if (data.count >= 2 && negativeMoods.includes(data.mood)) {
          insights.push(`Often feel ${data.mood} on ${day}s`);
          await upsertJournalPattern(env, userId, `mood_day_${day}`, data, data.count / 5);
        }
      }
    }
    
    // 7. Energy patterns
    const energyByDay = await env.DB.prepare(`
      SELECT 
        CASE CAST(strftime('%w', entry_date) AS INTEGER)
          WHEN 0 THEN 'sunday' WHEN 1 THEN 'monday' WHEN 2 THEN 'tuesday'
          WHEN 3 THEN 'wednesday' WHEN 4 THEN 'thursday' WHEN 5 THEN 'friday' WHEN 6 THEN 'saturday'
        END as day_name,
        AVG(energy_level) as avg_energy
      FROM journal_entries
      WHERE user_id = ? AND entry_date >= ? AND energy_level IS NOT NULL
      GROUP BY day_name
    `).bind(userId, thirtyDaysAgo.split('T')[0]).all();
    
    if (energyByDay.results.length >= 3) {
      const sorted = (energyByDay.results as any[]).sort((a, b) => b.avg_energy - a.avg_energy);
      const highDay = sorted[0];
      const lowDay = sorted[sorted.length - 1];
      
      if (highDay.avg_energy >= 7) {
        insights.push(`Highest energy on ${highDay.day_name}s (avg ${Math.round(highDay.avg_energy)}/10)`);
        await upsertJournalPattern(env, userId, 'energy_high_day', { day: highDay.day_name, avg: highDay.avg_energy }, 0.7);
      }
      if (lowDay.avg_energy <= 4) {
        insights.push(`Lowest energy on ${lowDay.day_name}s (avg ${Math.round(lowDay.avg_energy)}/10)`);
        await upsertJournalPattern(env, userId, 'energy_low_day', { day: lowDay.day_name, avg: lowDay.avg_energy }, 0.7);
      }
    }
    
    // 8. Mood-productivity correlation
    const moodProductivity = await env.DB.prepare(`
      SELECT 
        je.mood,
        AVG(dl.tasks_completed) as avg_tasks
      FROM journal_entries je
      JOIN daily_logs dl ON je.entry_date = dl.log_date AND je.user_id = dl.user_id
      WHERE je.user_id = ? AND je.entry_date >= ? AND je.mood IS NOT NULL
      GROUP BY je.mood
      HAVING COUNT(*) >= 2
    `).bind(userId, thirtyDaysAgo.split('T')[0]).all();
    
    if (moodProductivity.results.length >= 2) {
      const sorted = (moodProductivity.results as any[]).sort((a, b) => b.avg_tasks - a.avg_tasks);
      const mostProductive = sorted[0];
      const leastProductive = sorted[sorted.length - 1];
      
      if (mostProductive.avg_tasks >= 3) {
        insights.push(`Most productive when feeling ${mostProductive.mood} (avg ${Math.round(mostProductive.avg_tasks)} tasks)`);
        await upsertJournalPattern(env, userId, 'productive_mood', mostProductive, 0.8);
      }
      if (leastProductive.avg_tasks <= 1 && mostProductive.mood !== leastProductive.mood) {
        insights.push(`Least productive when feeling ${leastProductive.mood}`);
        await upsertJournalPattern(env, userId, 'unproductive_mood', leastProductive, 0.6);
      }
    }
    
    // 9. Entity sentiment patterns (who/what affects mood)
    const entityMoodCorrelation = await env.DB.prepare(`
      SELECT 
        ent.entity_value,
        ent.entity_type,
        je.mood,
        COUNT(*) as mentions
      FROM journal_entities ent
      JOIN journal_entries je ON ent.entry_id = je.id
      WHERE je.user_id = ? AND je.entry_date >= ? AND je.mood IS NOT NULL
      GROUP BY ent.entity_value, ent.entity_type, je.mood
      HAVING COUNT(*) >= 2
      ORDER BY mentions DESC
    `).bind(userId, thirtyDaysAgo.split('T')[0]).all();
    
    if (entityMoodCorrelation.results.length > 0) {
      const negativeMoods = ['anxious', 'frustrated', 'sad', 'angry', 'overwhelmed'];
      const positiveMoods = ['calm', 'excited', 'grateful', 'hopeful', 'content', 'focused'];
      
      for (const row of entityMoodCorrelation.results.slice(0, 10) as any[]) {
        if (row.mentions >= 3) {
          if (negativeMoods.includes(row.mood)) {
            insights.push(`Often feel ${row.mood} when "${row.entity_value}" is mentioned`);
            await upsertJournalPattern(env, userId, `entity_negative_${row.entity_value}`, row, row.mentions / 5);
          } else if (positiveMoods.includes(row.mood)) {
            insights.push(`Often feel ${row.mood} around "${row.entity_value}"`);
            await upsertJournalPattern(env, userId, `entity_positive_${row.entity_value}`, row, row.mentions / 5);
          }
        }
      }
    }
    
  } catch (e) {
    // Journal tables might not exist yet - that's okay
    console.error('Journal pattern analysis error:', e);
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

// Generate nudges that include journal insights
export async function generateEnhancedNudges(env: any, userId: string, patterns: any[], openTasks: any[]): Promise<string[]> {
  const nudges = generateNudges(patterns, openTasks);
  const currentDay = getDayOfWeek();
  
  try {
    // Check for journal-based nudges
    const journalPatterns = await env.DB.prepare(
      'SELECT * FROM journal_patterns WHERE user_id = ? ORDER BY confidence DESC'
    ).bind(userId).all();
    
    for (const jp of journalPatterns.results as any[]) {
      const data = JSON.parse(jp.pattern_data);
      
      // Energy warning
      if (jp.pattern_type === 'energy_low_day' && data.day === currentDay) {
        nudges.push(`⚡ ${currentDay}s are usually low-energy days - plan accordingly`);
      }
      
      // Mood warning
      if (jp.pattern_type.startsWith('mood_day_') && jp.pattern_type.includes(currentDay)) {
        nudges.push(`💭 You often feel ${data.mood} on ${currentDay}s - be kind to yourself`);
      }
      
      // Productive mood reminder
      if (jp.pattern_type === 'productive_mood') {
        nudges.push(`🎯 You're most productive when ${data.mood} - check in with how you're feeling`);
      }
    }
    
    // Journal streak reminder
    const today = new Date().toISOString().split('T')[0];
    const dayOfWeek = new Date().getDay();
    const isTargetDay = [1, 3, 5].includes(dayOfWeek); // Mon, Wed, Fri
    
    if (isTargetDay) {
      const todayEntry = await env.DB.prepare(
        'SELECT id FROM journal_entries WHERE user_id = ? AND entry_date = ?'
      ).bind(userId, today).first();
      
      if (!todayEntry) {
        nudges.push(`📓 Today's a journaling day - don't break your streak!`);
      }
    }
    
  } catch (e) {
    // Journal tables might not exist yet
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
