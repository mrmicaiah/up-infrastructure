// Journal tools

import { z } from "zod";
import type { ToolContext } from '../types';
import { getValidToken, GMAIL_API_URL } from '../oauth';
import { extractEntities, refineJournalContent, getDayOfWeek } from '../helpers/utils';

// Mood options
const MOOD_OPTIONS = ['anxious', 'calm', 'excited', 'frustrated', 'grateful', 'hopeful', 'sad', 'angry', 'content', 'overwhelmed', 'focused', 'scattered'] as const;

// Entry types
const ENTRY_TYPES = ['freeform', 'morning', 'evening', 'reflection', 'braindump'] as const;

// Get emoji for mood
function getMoodEmoji(mood: string): string {
  const moodEmojis: Record<string, string> = {
    anxious: '😰', calm: '😌', excited: '🎉', frustrated: '😤',
    grateful: '🙏', hopeful: '🌟', sad: '😢', angry: '😠',
    content: '😊', overwhelmed: '😵', focused: '🎯', scattered: '🌀'
  };
  return moodEmojis[mood] || '📓';
}

// UTF-8 safe base64 encoding for Gmail API
function utf8ToBase64(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Forward entry to Penzu via Gmail
async function forwardToPenzu(env: any, userId: string, refinedContent: string): Promise<boolean> {
  const token = await getValidToken(env, userId, 'gmail_personal');
  if (!token) return false;
  
  // Get Penzu email from settings
  const settings = await env.DB.prepare(
    'SELECT penzu_email FROM journal_settings WHERE user_id = ?'
  ).bind(userId).first();
  
  const penzuEmail = settings?.penzu_email || 'micaiah31763@post.penzu.com';
  
  // Build email
  const email = [
    `To: ${penzuEmail}`,
    `Subject: Journal Entry`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    refinedContent
  ].join('\r\n');
  
  // Base64 encode with UTF-8 support
  const encodedEmail = utf8ToBase64(email);
  
  try {
    const resp = await fetch(`${GMAIL_API_URL}/users/me/messages/send`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: encodedEmail })
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export function registerJournalTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool("add_journal_entry", {
    content: z.string().describe("Your journal entry - write naturally, I'll clean it up"),
    entry_type: z.enum(ENTRY_TYPES).optional().default('freeform'),
    mood: z.enum(MOOD_OPTIONS).optional(),
    energy: z.number().min(1).max(10).optional().describe("Energy level 1-10"),
    forward_to_penzu: z.boolean().optional().default(true),
  }, async ({ content, entry_type, mood, energy, forward_to_penzu }) => {
    const userId = getCurrentUser();
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    const today = ts.split('T')[0];
    
    // Refine content for Penzu
    const refinedContent = refineJournalContent(content, entry_type);
    
    // Extract entities
    const entities = extractEntities(content);
    
    // Save entry - includes updated_at field
    await env.DB.prepare(`
      INSERT INTO journal_entries (id, user_id, entry_date, entry_type, raw_content, refined_content, mood, energy_level, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, userId, today, entry_type, content, refinedContent, mood || null, energy || null, ts, ts).run();
    
    // Save entities
    for (const entity of entities) {
      await env.DB.prepare(`
        INSERT INTO journal_entities (id, entry_id, entity_type, entity_value, sentiment, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), id, entity.type, entity.value, entity.sentiment || 'neutral', ts).run();
    }
    
    // Forward to Penzu if requested
    let penzuStatus = '';
    if (forward_to_penzu) {
      const sent = await forwardToPenzu(env, userId, refinedContent);
      if (sent) {
        await env.DB.prepare('UPDATE journal_entries SET linked_to_penzu = 1 WHERE id = ?').bind(id).run();
        penzuStatus = '\n📤 Forwarded to Penzu';
      } else {
        penzuStatus = '\n⚠️ Could not forward to Penzu (check Gmail connection)';
      }
    }
    
    // Build response
    let out = `${getMoodEmoji(mood || 'content')} **Journal Entry Saved**\n\n`;
    out += `Type: ${entry_type}`;
    if (mood) out += ` | Mood: ${mood}`;
    if (energy) out += ` | Energy: ${energy}/10`;
    out += penzuStatus;
    
    if (entities.length > 0) {
      out += `\n\n**Extracted:**\n`;
      const byType: Record<string, string[]> = {};
      for (const e of entities) {
        if (!byType[e.type]) byType[e.type] = [];
        byType[e.type].push(e.value);
      }
      for (const [type, values] of Object.entries(byType)) {
        out += `• ${type}: ${values.join(', ')}\n`;
      }
    }
    
    // Check streak
    const streakInfo = await getJournalStreak(env, userId);
    if (streakInfo.streak > 0) {
      out += `\n🔥 ${streakInfo.streak} entry streak!`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("list_journal_entries", {
    days: z.number().optional().default(7),
    mood: z.enum(MOOD_OPTIONS).optional(),
    entry_type: z.enum(ENTRY_TYPES).optional(),
  }, async ({ days, mood, entry_type }) => {
    const userId = getCurrentUser();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    let query = 'SELECT * FROM journal_entries WHERE user_id = ? AND entry_date >= ?';
    const params: any[] = [userId, since];
    
    if (mood) {
      query += ' AND mood = ?';
      params.push(mood);
    }
    if (entry_type) {
      query += ' AND entry_type = ?';
      params.push(entry_type);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const entries = await env.DB.prepare(query).bind(...params).all();
    
    if (entries.results.length === 0) {
      return { content: [{ type: "text", text: `📓 No journal entries in the last ${days} days` }] };
    }
    
    let out = `📓 **Journal Entries** (${entries.results.length})\n\n`;
    
    for (const entry of entries.results as any[]) {
      const emoji = getMoodEmoji(entry.mood);
      out += `${emoji} **${entry.entry_date}** (${entry.entry_type})`;
      if (entry.mood) out += ` - ${entry.mood}`;
      if (entry.energy_level) out += ` - ${entry.energy_level}/10`;
      out += `\n${entry.raw_content.slice(0, 100)}${entry.raw_content.length > 100 ? '...' : ''}\n`;
      out += `ID: ${entry.id}\n\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("view_journal_entry", {
    entry_id: z.string(),
  }, async ({ entry_id }) => {
    const userId = getCurrentUser();
    
    const entry = await env.DB.prepare(
      'SELECT * FROM journal_entries WHERE id = ? AND user_id = ?'
    ).bind(entry_id, userId).first();
    
    if (!entry) {
      return { content: [{ type: "text", text: "❌ Entry not found" }] };
    }
    
    // Get entities
    const entities = await env.DB.prepare(
      'SELECT * FROM journal_entities WHERE entry_id = ?'
    ).bind(entry_id).all();
    
    // Get linked items
    const links = await env.DB.prepare(
      'SELECT * FROM journal_entry_links WHERE entry_id = ?'
    ).bind(entry_id).all();
    
    const emoji = getMoodEmoji(entry.mood);
    let out = `${emoji} **${entry.entry_date}** (${entry.entry_type})\n\n`;
    
    if (entry.mood) out += `Mood: ${entry.mood}`;
    if (entry.energy_level) out += ` | Energy: ${entry.energy_level}/10`;
    out += '\n\n---\n\n';
    out += entry.raw_content;
    out += '\n\n---\n';
    
    if (entities.results.length > 0) {
      out += '\n**Entities:**\n';
      for (const e of entities.results as any[]) {
        const sentimentIcon = e.sentiment === 'positive' ? '✨' : e.sentiment === 'negative' ? '⚡' : '';
        out += `• ${e.entity_type}: ${e.entity_value} ${sentimentIcon}\n`;
      }
    }
    
    if (links.results.length > 0) {
      out += '\n**Linked to:**\n';
      for (const link of links.results as any[]) {
        out += `• ${link.link_type}: ${link.link_id}\n`;
      }
    }
    
    if (entry.linked_to_penzu) {
      out += '\n📤 Synced to Penzu';
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("search_journal", {
    query: z.string().describe("Search by keyword, entity, or mood"),
    days: z.number().optional().default(30),
  }, async ({ query, days }) => {
    const userId = getCurrentUser();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const lowerQuery = query.toLowerCase();
    
    // Search in content
    const contentMatches = await env.DB.prepare(`
      SELECT * FROM journal_entries 
      WHERE user_id = ? AND entry_date >= ? AND (raw_content LIKE ? OR mood = ?)
      ORDER BY created_at DESC
    `).bind(userId, since, `%${query}%`, lowerQuery).all();
    
    // Search in entities
    const entityMatches = await env.DB.prepare(`
      SELECT DISTINCT je.* FROM journal_entries je
      JOIN journal_entities ent ON je.id = ent.entry_id
      WHERE je.user_id = ? AND je.entry_date >= ? AND ent.entity_value LIKE ?
      ORDER BY je.created_at DESC
    `).bind(userId, since, `%${query}%`).all();
    
    // Combine and dedupe
    const allIds = new Set<string>();
    const results: any[] = [];
    
    for (const entry of [...contentMatches.results, ...entityMatches.results] as any[]) {
      if (!allIds.has(entry.id)) {
        allIds.add(entry.id);
        results.push(entry);
      }
    }
    
    if (results.length === 0) {
      return { content: [{ type: "text", text: `🔍 No entries found matching "${query}"` }] };
    }
    
    let out = `🔍 **Found ${results.length} entries matching "${query}"**\n\n`;
    
    for (const entry of results.slice(0, 10)) {
      const emoji = getMoodEmoji(entry.mood);
      out += `${emoji} **${entry.entry_date}**`;
      if (entry.mood) out += ` (${entry.mood})`;
      out += `\n${entry.raw_content.slice(0, 80)}...\n`;
      out += `ID: ${entry.id}\n\n`;
    }
    
    if (results.length > 10) {
      out += `... and ${results.length - 10} more`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("journal_insights", {
    days: z.number().optional().default(30),
  }, async ({ days }) => {
    const userId = getCurrentUser();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    // Mood breakdown
    const moodStats = await env.DB.prepare(`
      SELECT mood, COUNT(*) as count FROM journal_entries
      WHERE user_id = ? AND entry_date >= ? AND mood IS NOT NULL
      GROUP BY mood ORDER BY count DESC
    `).bind(userId, since).all();
    
    // Energy average by day
    const energyByDay = await env.DB.prepare(`
      SELECT 
        CASE strftime('%w', entry_date)
          WHEN '0' THEN 'Sunday' WHEN '1' THEN 'Monday' WHEN '2' THEN 'Tuesday'
          WHEN '3' THEN 'Wednesday' WHEN '4' THEN 'Thursday' WHEN '5' THEN 'Friday'
          WHEN '6' THEN 'Saturday'
        END as day,
        AVG(energy_level) as avg_energy
      FROM journal_entries
      WHERE user_id = ? AND entry_date >= ? AND energy_level IS NOT NULL
      GROUP BY strftime('%w', entry_date)
      ORDER BY avg_energy DESC
    `).bind(userId, since).all();
    
    // Top entities
    const topEntities = await env.DB.prepare(`
      SELECT entity_type, entity_value, COUNT(*) as count
      FROM journal_entities ent
      JOIN journal_entries je ON ent.entry_id = je.id
      WHERE je.user_id = ? AND je.entry_date >= ?
      GROUP BY entity_type, entity_value
      ORDER BY count DESC
      LIMIT 10
    `).bind(userId, since).all();
    
    // Entry count
    const totalEntries = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM journal_entries WHERE user_id = ? AND entry_date >= ?
    `).bind(userId, since).first();
    
    let out = `📊 **Journal Insights** (${days} days)\n\n`;
    out += `Total entries: ${totalEntries?.count || 0}\n\n`;
    
    if (moodStats.results.length > 0) {
      out += `**Mood Breakdown:**\n`;
      for (const m of moodStats.results as any[]) {
        const emoji = getMoodEmoji(m.mood);
        out += `${emoji} ${m.mood}: ${m.count}\n`;
      }
      out += '\n';
    }
    
    if (energyByDay.results.length > 0) {
      out += `**Energy by Day:**\n`;
      for (const d of energyByDay.results as any[]) {
        const bar = '█'.repeat(Math.round(d.avg_energy));
        out += `${d.day}: ${bar} ${d.avg_energy.toFixed(1)}\n`;
      }
      out += '\n';
    }
    
    if (topEntities.results.length > 0) {
      out += `**Top Mentions:**\n`;
      for (const e of topEntities.results as any[]) {
        out += `• ${e.entity_value} (${e.entity_type}): ${e.count}x\n`;
      }
    }
    
    // Check streak
    const streakInfo = await getJournalStreak(env, userId);
    out += `\n🔥 Current streak: ${streakInfo.streak} days`;
    out += `\n📅 Goal: 3 entries/week (Mon/Wed/Fri)`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("journal_streak", {}, async () => {
    const userId = getCurrentUser();
    const streakInfo = await getJournalStreak(env, userId);
    
    let out = `📓 **Journal Streak**\n\n`;
    out += `🔥 Current streak: ${streakInfo.streak} days\n`;
    out += `📅 This week: ${streakInfo.thisWeek}/3 entries\n\n`;
    
    out += `**Goal days:** Mon, Wed, Fri\n`;
    out += `**Status:**\n`;
    out += streakInfo.monday ? '✅' : '⬜'; out += ' Monday\n';
    out += streakInfo.wednesday ? '✅' : '⬜'; out += ' Wednesday\n';
    out += streakInfo.friday ? '✅' : '⬜'; out += ' Friday\n';
    
    if (streakInfo.thisWeek >= 3) {
      out += '\n🎉 Weekly goal achieved!';
    } else {
      const remaining = 3 - streakInfo.thisWeek;
      out += `\n${remaining} more ${remaining === 1 ? 'entry' : 'entries'} to hit weekly goal`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("delete_journal_entry", {
    entry_id: z.string(),
  }, async ({ entry_id }) => {
    const userId = getCurrentUser();
    
    const entry = await env.DB.prepare(
      'SELECT * FROM journal_entries WHERE id = ? AND user_id = ?'
    ).bind(entry_id, userId).first();
    
    if (!entry) {
      return { content: [{ type: "text", text: "❌ Entry not found" }] };
    }
    
    // Delete entities first
    await env.DB.prepare('DELETE FROM journal_entities WHERE entry_id = ?').bind(entry_id).run();
    // Delete links
    await env.DB.prepare('DELETE FROM journal_entry_links WHERE entry_id = ?').bind(entry_id).run();
    // Delete entry
    await env.DB.prepare('DELETE FROM journal_entries WHERE id = ?').bind(entry_id).run();
    
    return { content: [{ type: "text", text: `🗑️ Deleted entry from ${entry.entry_date}` }] };
  });

  server.tool("link_journal_entry", {
    entry_id: z.string(),
    link_type: z.enum(['task', 'launch', 'project']),
    link_id: z.string(),
  }, async ({ entry_id, link_type, link_id }) => {
    const userId = getCurrentUser();
    
    // Verify entry exists
    const entry = await env.DB.prepare(
      'SELECT * FROM journal_entries WHERE id = ? AND user_id = ?'
    ).bind(entry_id, userId).first();
    
    if (!entry) {
      return { content: [{ type: "text", text: "❌ Entry not found" }] };
    }
    
    await env.DB.prepare(`
      INSERT INTO journal_entry_links (id, entry_id, link_type, link_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), entry_id, link_type, link_id, new Date().toISOString()).run();
    
    return { content: [{ type: "text", text: `🔗 Linked to ${link_type}: ${link_id}` }] };
  });

  server.tool("update_journal_entry", {
    entry_id: z.string(),
    mood: z.enum(MOOD_OPTIONS).optional(),
    energy: z.number().min(1).max(10).optional(),
    content: z.string().optional(),
  }, async ({ entry_id, mood, energy, content }) => {
    const userId = getCurrentUser();
    
    const entry = await env.DB.prepare(
      'SELECT * FROM journal_entries WHERE id = ? AND user_id = ?'
    ).bind(entry_id, userId).first();
    
    if (!entry) {
      return { content: [{ type: "text", text: "❌ Entry not found" }] };
    }
    
    const ts = new Date().toISOString();
    const updates: string[] = ['updated_at = ?'];
    const params: any[] = [ts];
    
    if (mood) { updates.push('mood = ?'); params.push(mood); }
    if (energy) { updates.push('energy_level = ?'); params.push(energy); }
    if (content) { 
      updates.push('raw_content = ?'); 
      params.push(content);
      updates.push('refined_content = ?');
      params.push(refineJournalContent(content, entry.entry_type));
    }
    
    params.push(entry_id);
    await env.DB.prepare(`UPDATE journal_entries SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
    
    // Re-extract entities if content changed
    if (content) {
      await env.DB.prepare('DELETE FROM journal_entities WHERE entry_id = ?').bind(entry_id).run();
      const entities = extractEntities(content);
      for (const entity of entities) {
        await env.DB.prepare(`
          INSERT INTO journal_entities (id, entry_id, entity_type, entity_value, sentiment, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(crypto.randomUUID(), entry_id, entity.type, entity.value, entity.sentiment || 'neutral', ts).run();
      }
    }
    
    return { content: [{ type: "text", text: `✏️ Updated entry from ${entry.entry_date}` }] };
  });

  server.tool("configure_journal", {
    penzu_email: z.string().optional().describe("Penzu forwarding email address"),
    weekly_goal: z.number().optional().describe("Entries per week goal"),
  }, async ({ penzu_email, weekly_goal }) => {
    const userId = getCurrentUser();
    const ts = new Date().toISOString();
    
    // Check if settings exist
    const existing = await env.DB.prepare(
      'SELECT * FROM journal_settings WHERE user_id = ?'
    ).bind(userId).first();
    
    if (existing) {
      const updates: string[] = ['updated_at = ?'];
      const params: any[] = [ts];
      
      if (penzu_email) { updates.push('penzu_email = ?'); params.push(penzu_email); }
      if (weekly_goal) { updates.push('weekly_goal = ?'); params.push(weekly_goal); }
      
      params.push(userId);
      await env.DB.prepare(`UPDATE journal_settings SET ${updates.join(', ')} WHERE user_id = ?`).bind(...params).run();
    } else {
      await env.DB.prepare(`
        INSERT INTO journal_settings (id, user_id, penzu_email, weekly_goal, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), userId, penzu_email || 'micaiah31763@post.penzu.com', weekly_goal || 3, ts, ts).run();
    }
    
    let out = `⚙️ **Journal Settings Updated**\n\n`;
    if (penzu_email) out += `Penzu email: ${penzu_email}\n`;
    if (weekly_goal) out += `Weekly goal: ${weekly_goal} entries\n`;
    
    return { content: [{ type: "text", text: out }] };
  });
}

// Helper to get journal streak info
async function getJournalStreak(env: any, userId: string): Promise<{
  streak: number;
  thisWeek: number;
  monday: boolean;
  wednesday: boolean;
  friday: boolean;
}> {
  // Get this week's Monday
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - now.getDay() + 1);
  monday.setHours(0, 0, 0, 0);
  const mondayStr = monday.toISOString().split('T')[0];
  
  // Get entries this week
  const thisWeekEntries = await env.DB.prepare(`
    SELECT entry_date FROM journal_entries
    WHERE user_id = ? AND entry_date >= ?
  `).bind(userId, mondayStr).all();
  
  const dates = new Set((thisWeekEntries.results as any[]).map(e => e.entry_date));
  
  // Check Mon/Wed/Fri
  const wed = new Date(monday);
  wed.setDate(monday.getDate() + 2);
  const fri = new Date(monday);
  fri.setDate(monday.getDate() + 4);
  
  const hasMonday = dates.has(mondayStr);
  const hasWednesday = dates.has(wed.toISOString().split('T')[0]);
  const hasFriday = dates.has(fri.toISOString().split('T')[0]);
  
  // Calculate streak (consecutive days with entries)
  let streak = 0;
  let checkDate = new Date();
  checkDate.setHours(0, 0, 0, 0);
  
  while (true) {
    const dateStr = checkDate.toISOString().split('T')[0];
    const hasEntry = await env.DB.prepare(
      'SELECT 1 FROM journal_entries WHERE user_id = ? AND entry_date = ?'
    ).bind(userId, dateStr).first();
    
    if (hasEntry) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
    
    // Safety limit
    if (streak > 365) break;
  }
  
  return {
    streak,
    thisWeek: dates.size,
    monday: hasMonday,
    wednesday: hasWednesday,
    friday: hasFriday
  };
}
