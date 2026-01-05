// Launch Docs tools

import { z } from "zod";
import type { ToolContext } from '../types';
import { parseLaunchDocument } from '../helpers/launch-parser';
import { getPreviousDate } from '../helpers/utils';
import { inferFocusLevel } from '../helpers/utils';

export function registerLaunchTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  // --- DOCUMENT MANAGEMENT ---
  
  server.tool("add_launch_doc", {
    name: z.string(),
    doc_type: z.enum(['engine', 'playbook', 'operations']),
    description: z.string().optional(),
    content: z.string().describe("Markdown content with phases and checklist items"),
  }, async ({ name, doc_type, description, content }) => {
    const { phases, items } = parseLaunchDocument(content);
    
    if (phases.length === 0) {
      return { content: [{ type: "text", text: "⛔ No phases found. Use # PHASE 1: NAME format." }] };
    }
    
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    
    await env.DB.prepare(
      'INSERT INTO launch_docs (id, name, doc_type, description, content, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, name, doc_type, description || null, content, '1.0', ts, ts).run();
    
    return { content: [{ type: "text", text: `✅ Created: ${name}\n\nType: ${doc_type}\nPhases: ${phases.join(' → ')}\nChecklist items: ${items.length}\nDoc ID: ${id}` }] };
  });

  server.tool("list_launch_docs", {
    doc_type: z.enum(['engine', 'playbook', 'operations']).optional(),
  }, async ({ doc_type }) => {
    let query = 'SELECT id, name, doc_type, description, version, updated_at FROM launch_docs';
    const params: any[] = [];
    
    if (doc_type) {
      query += ' WHERE doc_type = ?';
      params.push(doc_type);
    }
    query += ' ORDER BY name';
    
    const r = await env.DB.prepare(query).bind(...params).all();
    
    if (r.results.length === 0) {
      return { content: [{ type: "text", text: "📄 No launch documents found" }] };
    }
    
    let out = '📄 **Launch Documents**\n\n';
    r.results.forEach((doc: any) => {
      out += `• **${doc.name}** (${doc.doc_type})\n  ID: ${doc.id}\n  v${doc.version} | Updated: ${doc.updated_at.split('T')[0]}\n\n`;
    });
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("view_launch_doc", {
    doc_id: z.string().optional(),
    name: z.string().optional(),
  }, async ({ doc_id, name }) => {
    let doc;
    if (doc_id) {
      doc = await env.DB.prepare('SELECT * FROM launch_docs WHERE id = ?').bind(doc_id).first();
    } else if (name) {
      doc = await env.DB.prepare('SELECT * FROM launch_docs WHERE name LIKE ?').bind('%' + name + '%').first();
    }
    
    if (!doc) {
      return { content: [{ type: "text", text: "⛔ Document not found" }] };
    }
    
    const { phases, items } = parseLaunchDocument(doc.content);
    
    let out = `📄 **${doc.name}**\n\n`;
    out += `Type: ${doc.doc_type} | Version: ${doc.version}\n`;
    out += `Phases: ${phases.join(' → ')}\n`;
    out += `Items: ${items.length}\n\n`;
    out += `---\n\n${doc.content.slice(0, 5000)}`;
    if (doc.content.length > 5000) out += '\n\n... (truncated)';
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("update_launch_doc", {
    doc_id: z.string(),
    content: z.string(),
    version: z.string().optional(),
  }, async ({ doc_id, content, version }) => {
    const existing = await env.DB.prepare('SELECT * FROM launch_docs WHERE id = ?').bind(doc_id).first();
    if (!existing) {
      return { content: [{ type: "text", text: "⛔ Document not found" }] };
    }
    
    const { phases, items } = parseLaunchDocument(content);
    const newVersion = version || (parseFloat(existing.version) + 0.1).toFixed(1);
    const ts = new Date().toISOString();
    
    await env.DB.prepare(
      'UPDATE launch_docs SET content = ?, version = ?, updated_at = ? WHERE id = ?'
    ).bind(content, newVersion, ts, doc_id).run();
    
    return { content: [{ type: "text", text: `✅ Updated: ${existing.name}\n\nVersion: ${newVersion}\nPhases: ${phases.join(' → ')}\nItems: ${items.length}` }] };
  });

  // --- PROJECT MANAGEMENT ---

  server.tool("create_launch", {
    title: z.string(),
    launch_doc_ids: z.array(z.string()).describe("Array of document IDs to use"),
    target_launch_date: z.string().optional().describe("YYYY-MM-DD format"),
    genre: z.string().optional(),
    shared: z.boolean().optional().default(false),
  }, async ({ title, launch_doc_ids, target_launch_date, genre, shared }) => {
    const projectId = crypto.randomUUID();
    const ts = new Date().toISOString();
    
    // Validate documents exist
    const docs: any[] = [];
    for (const docId of launch_doc_ids) {
      const doc = await env.DB.prepare('SELECT * FROM launch_docs WHERE id = ?').bind(docId).first();
      if (!doc) {
        return { content: [{ type: "text", text: `⛔ Document not found: ${docId}` }] };
      }
      docs.push(doc);
    }
    
    // Parse all documents and collect items
    let allItems: any[] = [];
    let allPhases: string[] = [];
    
    for (const doc of docs) {
      const { phases, items } = parseLaunchDocument(doc.content);
      
      // Add doc_id to each item
      const itemsWithDoc = items.map(item => ({
        ...item,
        doc_id: doc.id,
      }));
      
      allItems = allItems.concat(itemsWithDoc);
      phases.forEach(p => {
        if (!allPhases.includes(p)) allPhases.push(p);
      });
    }
    
    // Re-sort items by phase order then original sort_order
    const phaseOrder: Record<string, number> = {};
    allPhases.forEach((p, i) => phaseOrder[p] = i);
    allItems.sort((a, b) => {
      const phaseDiff = (phaseOrder[a.phase] || 0) - (phaseOrder[b.phase] || 0);
      if (phaseDiff !== 0) return phaseDiff;
      return a.sort_order - b.sort_order;
    });
    
    // Create project
    await env.DB.prepare(
      'INSERT INTO launch_projects (id, user_id, title, genre, launch_doc_ids, target_launch_date, status, current_phase, shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      projectId, getCurrentUser(), title, genre || null, 
      JSON.stringify(launch_doc_ids), target_launch_date || null,
      'setup', allPhases[0] || 'Setup', shared ? 1 : 0, ts, ts
    ).run();
    
    // Insert all checklist items
    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];
      await env.DB.prepare(
        'INSERT INTO launch_checklist (id, project_id, doc_id, phase, section, item_text, sort_order, tags, due_offset, is_recurring, completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)'
      ).bind(
        crypto.randomUUID(), projectId, item.doc_id,
        item.phase, item.section || null, item.item_text, i,
        JSON.stringify(item.tags), item.due_offset, item.is_recurring
      ).run();
    }
    
    let out = `✅ Created launch: **${title}**\n\n`;
    out += `Documents: ${docs.map(d => d.name).join(', ')}\n`;
    out += `Total checklist items: ${allItems.length}\n`;
    out += `Phases: ${allPhases.join(' → ')}\n`;
    if (target_launch_date) {
      const days = Math.ceil((new Date(target_launch_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      out += `Target: ${target_launch_date} (${days} days)\n`;
    } else {
      out += `Target: Not set\n`;
    }
    out += `\nProject ID: ${projectId}`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("launch_status", {
    project_id: z.string().optional(),
    title: z.string().optional(),
  }, async ({ project_id, title }) => {
    let project;
    if (project_id) {
      project = await env.DB.prepare('SELECT * FROM launch_projects WHERE id = ?').bind(project_id).first();
    } else if (title) {
      project = await env.DB.prepare('SELECT * FROM launch_projects WHERE title LIKE ? AND user_id = ?').bind('%' + title + '%', getCurrentUser()).first();
    } else {
      // Get user's most recent active project
      project = await env.DB.prepare("SELECT * FROM launch_projects WHERE user_id = ? AND status != 'complete' ORDER BY updated_at DESC LIMIT 1").bind(getCurrentUser()).first();
    }
    
    if (!project) {
      return { content: [{ type: "text", text: "⛔ No launch project found" }] };
    }
    
    // Get completion stats by phase
    const phaseStats = await env.DB.prepare(`
      SELECT phase, 
        COUNT(*) as total,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as done
      FROM launch_checklist 
      WHERE project_id = ?
      GROUP BY phase
      ORDER BY MIN(sort_order)
    `).bind(project.id).all();
    
    // Get section stats for current phase
    const sectionStats = await env.DB.prepare(`
      SELECT section,
        COUNT(*) as total,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as done
      FROM launch_checklist
      WHERE project_id = ? AND phase = ?
      GROUP BY section
      ORDER BY MIN(sort_order)
    `).bind(project.id, project.current_phase).all();
    
    // Get active tasks from this launch
    const activeTasks = await env.DB.prepare(`
      SELECT lc.item_text, t.id as task_id
      FROM launch_checklist lc
      JOIN tasks t ON lc.task_id = t.id
      WHERE lc.project_id = ? AND lc.completed = 0 AND t.status = 'open'
      LIMIT 5
    `).bind(project.id).all();
    
    // Get recent metrics
    const recentMetrics = await env.DB.prepare(`
      SELECT metric_type, metric_name, value
      FROM launch_metrics
      WHERE project_id = ?
      ORDER BY recorded_date DESC
      LIMIT 10
    `).bind(project.id).all();
    
    // Calculate posting streak
    const streakResult = await env.DB.prepare(`
      SELECT post_date FROM posting_log
      WHERE project_id = ? AND platform = 'tiktok'
      ORDER BY post_date DESC
      LIMIT 30
    `).bind(project.id).all();
    
    let streak = 0;
    if (streakResult.results.length > 0) {
      const today = new Date().toISOString().split('T')[0];
      let checkDate = today;
      for (const row of streakResult.results as any[]) {
        if (row.post_date === checkDate || row.post_date === getPreviousDate(checkDate)) {
          streak++;
          checkDate = getPreviousDate(row.post_date);
        } else {
          break;
        }
      }
    }
    
    // Build output
    let out = `**${project.title.toUpperCase()}** - Launch Status\n\n`;
    out += `Phase: ${project.current_phase} (${phaseStats.results.findIndex((p: any) => p.phase === project.current_phase) + 1} of ${phaseStats.results.length})\n`;
    
    if (project.target_launch_date) {
      const days = Math.ceil((new Date(project.target_launch_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      out += `Target: ${project.target_launch_date} (${days} days)\n`;
    }
    
    const totalDone = phaseStats.results.reduce((sum: number, p: any) => sum + p.done, 0);
    const totalItems = phaseStats.results.reduce((sum: number, p: any) => sum + p.total, 0);
    const pct = totalItems > 0 ? Math.round((totalDone / totalItems) * 100) : 0;
    out += `Progress: ${totalDone}/${totalItems} complete (${pct}%)\n\n`;
    
    // Phase breakdown
    out += `**${project.current_phase.toUpperCase()} PHASE:**\n`;
    for (const section of sectionStats.results as any[]) {
      const icon = section.done === section.total ? '✓' : section.done > 0 ? '◐' : '○';
      const sectionName = section.section || 'General';
      out += `${icon} ${sectionName} (${section.done}/${section.total})\n`;
    }
    
    // Active tasks
    if (activeTasks.results.length > 0) {
      out += `\n**Active tasks from this launch:**\n`;
      for (const task of activeTasks.results as any[]) {
        out += `• ${task.item_text}\n`;
      }
    }
    
    // Metrics
    if (recentMetrics.results.length > 0) {
      out += `\n**Metrics (last recorded):**\n`;
      const seen = new Set();
      for (const m of recentMetrics.results as any[]) {
        const key = `${m.metric_type}:${m.metric_name}`;
        if (!seen.has(key)) {
          out += `• ${m.metric_type}/${m.metric_name}: ${m.value}\n`;
          seen.add(key);
        }
      }
    }
    
    out += `\nPosting streak: ${streak} days`;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("launch_overview", {}, async () => {
    const projects = await env.DB.prepare(`
      SELECT lp.*, 
        (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id) as total_items,
        (SELECT COUNT(*) FROM launch_checklist WHERE project_id = lp.id AND completed = 1) as done_items
      FROM launch_projects lp
      WHERE lp.status != 'complete'
      ORDER BY lp.updated_at DESC
    `).all();
    
    if (projects.results.length === 0) {
      return { content: [{ type: "text", text: "📋 No active launch projects" }] };
    }
    
    let out = '📋 **All Active Launches**\n\n';
    
    for (const p of projects.results as any[]) {
      const pct = p.total_items > 0 ? Math.round((p.done_items / p.total_items) * 100) : 0;
      let days = '';
      if (p.target_launch_date) {
        const d = Math.ceil((new Date(p.target_launch_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        days = ` | ${d} days`;
      }
      
      out += `**${p.title}** (${p.user_id})\n`;
      out += `  Phase: ${p.current_phase} | ${pct}% complete${days}\n`;
      out += `  Status: ${p.status}\n\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  // --- LAUNCH HEALTH (Smart Analysis) ---

  server.tool("launch_health", {
    project_id: z.string().optional(),
  }, async ({ project_id }) => {
    // Get all active launches for user, or specific one
    let projects;
    if (project_id) {
      const p = await env.DB.prepare('SELECT * FROM launch_projects WHERE id = ?').bind(project_id).first();
      projects = p ? [p] : [];
    } else {
      const r = await env.DB.prepare(`
        SELECT * FROM launch_projects 
        WHERE user_id = ? AND status != 'complete'
        ORDER BY updated_at DESC
      `).bind(getCurrentUser()).all();
      projects = r.results;
    }
    
    if (projects.length === 0) {
      return { content: [{ type: "text", text: "📋 No active launch projects" }] };
    }
    
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    let out = '';
    
    for (const project of projects as any[]) {
      // Get last activity (last completed item)
      const lastActivity = await env.DB.prepare(`
        SELECT completed_at FROM launch_checklist
        WHERE project_id = ? AND completed = 1
        ORDER BY completed_at DESC LIMIT 1
      `).bind(project.id).first();
      
      const daysSinceActivity = lastActivity?.completed_at
        ? Math.floor((now.getTime() - new Date(lastActivity.completed_at).getTime()) / (1000 * 60 * 60 * 24))
        : 999;
      
      // Get items waiting on others (handed off)
      const waitingOn = await env.DB.prepare(`
        SELECT item_text, handed_to, handed_at FROM launch_checklist
        WHERE project_id = ? AND completed = 0 AND handed_to IS NOT NULL
        ORDER BY handed_at ASC
      `).bind(project.id).all();
      
      // Get next actionable items (not handed off, not complete, current phase)
      const nextItems = await env.DB.prepare(`
        SELECT id, item_text, section, tags FROM launch_checklist
        WHERE project_id = ? AND phase = ? AND completed = 0 AND handed_to IS NULL
        ORDER BY sort_order
        LIMIT 5
      `).bind(project.id, project.current_phase).all();
      
      // Get overall stats
      const stats = await env.DB.prepare(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as done,
          SUM(CASE WHEN handed_to IS NOT NULL AND completed = 0 THEN 1 ELSE 0 END) as waiting
        FROM launch_checklist WHERE project_id = ?
      `).bind(project.id).first();
      
      // Determine health status
      let healthIcon = '🟢';
      let healthStatus = 'on track';
      if (daysSinceActivity >= 7) {
        healthIcon = '🔴';
        healthStatus = 'stalled';
      } else if (daysSinceActivity >= 4) {
        healthIcon = '🟡';
        healthStatus = 'slowing';
      }
      
      // Build output for this project
      out += `${healthIcon} **${project.title}** — ${healthStatus}`;
      if (daysSinceActivity < 999) {
        out += ` (${daysSinceActivity === 0 ? 'active today' : daysSinceActivity + ' days idle'})`;
      }
      out += '\n';
      
      // Progress bar
      const pct = stats?.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
      out += `   ${stats?.done}/${stats?.total} complete (${pct}%)\n`;
      
      // Waiting on others
      if (waitingOn.results.length > 0) {
        out += `\n   ⏳ **Waiting on others** (${waitingOn.results.length}):\n`;
        for (const item of waitingOn.results.slice(0, 3) as any[]) {
          const daysWaiting = item.handed_at
            ? Math.floor((now.getTime() - new Date(item.handed_at).getTime()) / (1000 * 60 * 60 * 24))
            : 0;
          out += `   • ${item.item_text} [${item.handed_to}`;
          if (daysWaiting > 0) out += ` - ${daysWaiting}d`;
          out += `]\n`;
        }
        if (waitingOn.results.length > 3) {
          out += `   ...and ${waitingOn.results.length - 3} more\n`;
        }
        out += `   → Check in with them?\n`;
      }
      
      // Your next items
      if (nextItems.results.length > 0) {
        out += `\n   📋 **Your next:**\n`;
        for (const item of nextItems.results as any[]) {
          const tags = JSON.parse(item.tags || '[]');
          const critical = tags.includes('CRITICAL') ? ' 🔴' : '';
          out += `   • ${item.item_text}${critical}\n`;
        }
        
        // If stalled, prompt action
        if (daysSinceActivity >= 4 && nextItems.results.length > 0) {
          out += `\n   💬 What's blocking the first item?\n`;
        }
      } else if (waitingOn.results.length > 0) {
        out += `\n   ℹ️ All your items are done or waiting on others\n`;
      } else {
        out += `\n   ✅ Current phase complete - ready to advance?\n`;
      }
      
      out += '\n';
    }
    
    return { content: [{ type: "text", text: out.trim() }] };
  });

  server.tool("advance_launch_phase", {
    project_id: z.string(),
  }, async ({ project_id }) => {
    const project = await env.DB.prepare('SELECT * FROM launch_projects WHERE id = ?').bind(project_id).first();
    if (!project) {
      return { content: [{ type: "text", text: "⛔ Project not found" }] };
    }
    
    // Check for incomplete CRITICAL items in current phase
    const criticalIncomplete = await env.DB.prepare(`
      SELECT item_text FROM launch_checklist
      WHERE project_id = ? AND phase = ? AND completed = 0 AND tags LIKE '%CRITICAL%'
    `).bind(project_id, project.current_phase).all();
    
    if (criticalIncomplete.results.length > 0) {
      let out = `⛔ Cannot advance. CRITICAL items incomplete:\n\n`;
      for (const item of criticalIncomplete.results as any[]) {
        out += `• ${item.item_text}\n`;
      }
      return { content: [{ type: "text", text: out }] };
    }
    
    // Get all phases in order
    const phases = await env.DB.prepare(`
      SELECT DISTINCT phase FROM launch_checklist
      WHERE project_id = ?
      ORDER BY MIN(sort_order)
    `).bind(project_id).all();
    
    const phaseList = (phases.results as any[]).map(p => p.phase);
    const currentIndex = phaseList.indexOf(project.current_phase);
    
    if (currentIndex >= phaseList.length - 1) {
      return { content: [{ type: "text", text: "✅ Already on final phase. Use complete_launch when ready." }] };
    }
    
    const nextPhase = phaseList[currentIndex + 1];
    const ts = new Date().toISOString();
    
    await env.DB.prepare(
      'UPDATE launch_projects SET current_phase = ?, status = ?, updated_at = ? WHERE id = ?'
    ).bind(nextPhase, nextPhase.toLowerCase().replace(/\s+/g, '-'), ts, project_id).run();
    
    // Get stats for new phase
    const newPhaseStats = await env.DB.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as done
      FROM launch_checklist
      WHERE project_id = ? AND phase = ?
    `).bind(project_id, nextPhase).first();
    
    return { content: [{ type: "text", text: `✅ Advanced to: **${nextPhase}**\n\nItems in this phase: ${newPhaseStats?.total || 0}\nAlready complete: ${newPhaseStats?.done || 0}` }] };
  });

  server.tool("complete_launch", {
    project_id: z.string(),
  }, async ({ project_id }) => {
    const ts = new Date().toISOString();
    
    await env.DB.prepare(
      "UPDATE launch_projects SET status = 'complete', updated_at = ? WHERE id = ?"
    ).bind(ts, project_id).run();
    
    const stats = await env.DB.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as done
      FROM launch_checklist WHERE project_id = ?
    `).bind(project_id).first();
    
    return { content: [{ type: "text", text: `🎉 Launch complete!\n\nFinal stats: ${stats?.done || 0}/${stats?.total || 0} items completed` }] };
  });

  server.tool("reset_launch", {
    project_id: z.string(),
    keep_metrics: z.boolean().optional().default(true),
  }, async ({ project_id, keep_metrics }) => {
    const project = await env.DB.prepare('SELECT * FROM launch_projects WHERE id = ?').bind(project_id).first();
    if (!project) {
      return { content: [{ type: "text", text: "⛔ Project not found" }] };
    }
    
    const ts = new Date().toISOString();
    
    // Reset checklist items (including handoffs)
    await env.DB.prepare(
      'UPDATE launch_checklist SET completed = 0, completed_at = NULL, task_id = NULL, handed_to = NULL, handed_at = NULL WHERE project_id = ?'
    ).bind(project_id).run();
    
    // Get first phase
    const firstPhase = await env.DB.prepare(
      'SELECT phase FROM launch_checklist WHERE project_id = ? ORDER BY sort_order LIMIT 1'
    ).bind(project_id).first();
    
    // Reset project
    await env.DB.prepare(
      "UPDATE launch_projects SET status = 'setup', current_phase = ?, updated_at = ? WHERE id = ?"
    ).bind(firstPhase?.phase || 'Setup', ts, project_id).run();
    
    // Optionally clear metrics
    if (!keep_metrics) {
      await env.DB.prepare('DELETE FROM launch_metrics WHERE project_id = ?').bind(project_id).run();
      await env.DB.prepare('DELETE FROM content_batches WHERE project_id = ?').bind(project_id).run();
      await env.DB.prepare('DELETE FROM posting_log WHERE project_id = ?').bind(project_id).run();
      await env.DB.prepare('DELETE FROM launch_checkins WHERE project_id = ?').bind(project_id).run();
    }
    
    return { content: [{ type: "text", text: `✅ Reset: ${project.title}\n\nAll checklist items unmarked.\nMetrics: ${keep_metrics ? 'kept' : 'cleared'}` }] };
  });

  // --- CHECKLIST MANAGEMENT ---

  server.tool("hand_off_checklist_item", {
    item_id: z.string().optional(),
    search: z.string().optional(),
    to: z.string().describe("Who to hand off to (e.g., 'irene')"),
  }, async ({ item_id, search, to }) => {
    let item;
    if (item_id) {
      item = await env.DB.prepare('SELECT * FROM launch_checklist WHERE id = ?').bind(item_id).first();
    } else if (search) {
      item = await env.DB.prepare('SELECT * FROM launch_checklist WHERE item_text LIKE ? AND completed = 0').bind('%' + search + '%').first();
    }
    
    if (!item) {
      return { content: [{ type: "text", text: "⛔ Item not found" }] };
    }
    
    if (item.completed) {
      return { content: [{ type: "text", text: "⛔ Item already completed" }] };
    }
    
    const ts = new Date().toISOString();
    const toNormalized = to.toLowerCase().trim();
    
    await env.DB.prepare(
      'UPDATE launch_checklist SET handed_to = ?, handed_at = ? WHERE id = ?'
    ).bind(toNormalized, ts, item.id).run();
    
    return { content: [{ type: "text", text: `✅ Handed off to ${toNormalized}: "${item.item_text}"\n\nI'll remind you to check in on this.` }] };
  });

  server.tool("reclaim_checklist_item", {
    item_id: z.string().optional(),
    search: z.string().optional(),
  }, async ({ item_id, search }) => {
    let item;
    if (item_id) {
      item = await env.DB.prepare('SELECT * FROM launch_checklist WHERE id = ?').bind(item_id).first();
    } else if (search) {
      item = await env.DB.prepare('SELECT * FROM launch_checklist WHERE item_text LIKE ? AND handed_to IS NOT NULL').bind('%' + search + '%').first();
    }
    
    if (!item) {
      return { content: [{ type: "text", text: "⛔ Item not found" }] };
    }
    
    if (!item.handed_to) {
      return { content: [{ type: "text", text: "⛔ Item isn't handed off" }] };
    }
    
    const previousOwner = item.handed_to;
    
    await env.DB.prepare(
      'UPDATE launch_checklist SET handed_to = NULL, handed_at = NULL WHERE id = ?'
    ).bind(item.id).run();
    
    return { content: [{ type: "text", text: `✅ Reclaimed from ${previousOwner}: "${item.item_text}"` }] };
  });

  server.tool("surface_launch_tasks", {
    project_id: z.string(),
    count: z.number().optional().default(5),
  }, async ({ project_id, count }) => {
    const project = await env.DB.prepare('SELECT * FROM launch_projects WHERE id = ?').bind(project_id).first();
    if (!project) {
      return { content: [{ type: "text", text: "⛔ Project not found" }] };
    }
    
    // Find items to surface (not handed off)
    const candidates = await env.DB.prepare(`
      SELECT * FROM launch_checklist
      WHERE project_id = ? AND phase = ? AND completed = 0 AND task_id IS NULL AND handed_to IS NULL
      ORDER BY 
        CASE WHEN tags LIKE '%CRITICAL%' THEN 0 ELSE 1 END,
        CASE WHEN tags LIKE '%PRIORITY:HIGH%' THEN 0 ELSE 1 END,
        sort_order
      LIMIT ?
    `).bind(project_id, project.current_phase, count).all();
    
    if (candidates.results.length === 0) {
      return { content: [{ type: "text", text: "✅ No items to surface. All current phase items are either complete, handed off, or already on your task list." }] };
    }
    
    const ts = new Date().toISOString();
    const surfaced: string[] = [];
    
    for (const item of candidates.results as any[]) {
      // Create task
      const taskId = crypto.randomUUID();
      const tags = JSON.parse(item.tags || '[]');
      const priority = tags.includes('CRITICAL') ? 5 : tags.includes('PRIORITY:HIGH') ? 4 : 3;
      const notes = `From launch: ${project.title}\nPhase: ${item.phase}\nSection: ${item.section || 'General'}`;
      
      await env.DB.prepare(
        "INSERT INTO tasks (id, user_id, text, priority, category, project, status, created_at, last_touched, notes, focus_level) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 'medium')"
      ).bind(taskId, getCurrentUser(), item.item_text, priority, 'Launch', project.title, ts, ts, notes).run();
      
      // Link back to checklist
      await env.DB.prepare(
        'UPDATE launch_checklist SET task_id = ? WHERE id = ?'
      ).bind(taskId, item.id).run();
      
      const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
      surfaced.push(`• ${item.item_text}${tagStr}`);
    }
    
    return { content: [{ type: "text", text: `✅ Surfaced ${surfaced.length} items to your task list:\n\n${surfaced.join('\n')}` }] };
  });

  server.tool("complete_checklist_item", {
    item_id: z.string().optional(),
    search: z.string().optional(),
  }, async ({ item_id, search }) => {
    let item;
    if (item_id) {
      item = await env.DB.prepare('SELECT * FROM launch_checklist WHERE id = ?').bind(item_id).first();
    } else if (search) {
      item = await env.DB.prepare('SELECT * FROM launch_checklist WHERE item_text LIKE ? AND completed = 0').bind('%' + search + '%').first();
    }
    
    if (!item) {
      return { content: [{ type: "text", text: "⛔ Item not found" }] };
    }
    
    const ts = new Date().toISOString();
    
    // Mark checklist item complete (also clear handoff if it was handed off)
    await env.DB.prepare(
      'UPDATE launch_checklist SET completed = 1, completed_at = ?, handed_to = NULL, handed_at = NULL WHERE id = ?'
    ).bind(ts, item.id).run();
    
    // If linked to a task, complete that too
    if (item.task_id) {
      await env.DB.prepare(
        "UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?"
      ).bind(ts, item.task_id).run();
    }
    
    // Update project updated_at to track activity
    await env.DB.prepare(
      'UPDATE launch_projects SET updated_at = ? WHERE id = ?'
    ).bind(ts, item.project_id).run();
    
    let response = `✅ Completed: ${item.item_text}`;
    if (item.handed_to) {
      response += `\n(Was handed to ${item.handed_to})`;
    }
    
    return { content: [{ type: "text", text: response }] };
  });

  server.tool("list_checklist", {
    project_id: z.string(),
    phase: z.string().optional(),
    section: z.string().optional(),
    status: z.enum(['all', 'open', 'done']).optional().default('all'),
  }, async ({ project_id, phase, section, status }) => {
    let query = 'SELECT * FROM launch_checklist WHERE project_id = ?';
    const params: any[] = [project_id];
    
    if (phase) {
      query += ' AND phase = ?';
      params.push(phase);
    }
    if (section) {
      query += ' AND section = ?';
      params.push(section);
    }
    if (status === 'open') {
      query += ' AND completed = 0';
    } else if (status === 'done') {
      query += ' AND completed = 1';
    }
    
    query += ' ORDER BY sort_order';
    
    const r = await env.DB.prepare(query).bind(...params).all();
    
    if (r.results.length === 0) {
      return { content: [{ type: "text", text: "No items found" }] };
    }
    
    let out = `📋 **Checklist** (${r.results.length} items)\n\n`;
    let currentPhase = '';
    let currentSection = '';
    
    for (const item of r.results as any[]) {
      if (item.phase !== currentPhase) {
        currentPhase = item.phase;
        out += `\n**${currentPhase}**\n`;
        currentSection = '';
      }
      if (item.section !== currentSection) {
        currentSection = item.section;
        if (currentSection) out += `\n_${currentSection}_\n`;
      }
      
      const check = item.completed ? '✓' : '○';
      const tags = JSON.parse(item.tags || '[]');
      const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
      const onTask = item.task_id ? ' 📌' : '';
      const handedOff = item.handed_to ? ` ⏳${item.handed_to}` : '';
      out += `${check} ${item.item_text}${tagStr}${onTask}${handedOff}\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("add_checklist_item", {
    project_id: z.string(),
    phase: z.string(),
    section: z.string().optional(),
    item_text: z.string(),
    tags: z.array(z.string()).optional(),
  }, async ({ project_id, phase, section, item_text, tags }) => {
    // Get max sort_order for this phase
    const maxOrder = await env.DB.prepare(
      'SELECT MAX(sort_order) as max FROM launch_checklist WHERE project_id = ? AND phase = ?'
    ).bind(project_id, phase).first();
    
    const id = crypto.randomUUID();
    
    await env.DB.prepare(
      'INSERT INTO launch_checklist (id, project_id, doc_id, phase, section, item_text, sort_order, tags, completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)'
    ).bind(id, project_id, 'manual', phase, section || null, item_text, (maxOrder?.max || 0) + 1, JSON.stringify(tags || [])).run();
    
    return { content: [{ type: "text", text: `✅ Added: ${item_text}` }] };
  });

  // --- METRICS & TRACKING ---

  server.tool("log_launch_metrics", {
    project_id: z.string(),
    metrics: z.record(z.record(z.number())).describe("{ type: { name: value } }"),
  }, async ({ project_id, metrics }) => {
    const ts = new Date().toISOString();
    const today = ts.split('T')[0];
    
    let logged: string[] = [];
    
    for (const [type, values] of Object.entries(metrics)) {
      for (const [name, value] of Object.entries(values as Record<string, number>)) {
        await env.DB.prepare(
          'INSERT INTO launch_metrics (id, project_id, user_id, recorded_date, metric_type, metric_name, value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), project_id, getCurrentUser(), today, type, name, value, ts).run();
        logged.push(`${type}/${name}: ${value}`);
      }
    }
    
    return { content: [{ type: "text", text: `✅ Logged metrics:\n\n${logged.join('\n')}` }] };
  });

  server.tool("launch_metrics_history", {
    project_id: z.string(),
    metric_type: z.string().optional(),
    days: z.number().optional().default(30),
  }, async ({ project_id, metric_type, days }) => {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    let query = 'SELECT * FROM launch_metrics WHERE project_id = ? AND recorded_date >= ?';
    const params: any[] = [project_id, since];
    
    if (metric_type) {
      query += ' AND metric_type = ?';
      params.push(metric_type);
    }
    
    query += ' ORDER BY recorded_date DESC, metric_type, metric_name';
    
    const r = await env.DB.prepare(query).bind(...params).all();
    
    if (r.results.length === 0) {
      return { content: [{ type: "text", text: "No metrics recorded" }] };
    }
    
    let out = `📊 **Metrics History** (${days} days)\n\n`;
    let currentDate = '';
    
    for (const m of r.results as any[]) {
      if (m.recorded_date !== currentDate) {
        currentDate = m.recorded_date;
        out += `\n**${currentDate}**\n`;
      }
      out += `  ${m.metric_type}/${m.metric_name}: ${m.value}\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("log_content_batch", {
    project_id: z.string(),
    scripted: z.number().optional().default(0),
    filmed: z.number().optional().default(0),
    edited: z.number().optional().default(0),
    scheduled: z.number().optional().default(0),
    platform: z.string().optional().default('tiktok'),
    notes: z.string().optional(),
  }, async ({ project_id, scripted, filmed, edited, scheduled, platform, notes }) => {
    const ts = new Date().toISOString();
    const today = ts.split('T')[0];
    
    await env.DB.prepare(
      'INSERT INTO content_batches (id, project_id, user_id, batch_date, platform, videos_scripted, videos_filmed, videos_edited, videos_scheduled, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), project_id, getCurrentUser(), today, platform, scripted, filmed, edited, scheduled, notes || null, ts).run();
    
    // Get buffer status
    const buffer = await env.DB.prepare(`
      SELECT 
        SUM(videos_scheduled) as total_scheduled,
        (SELECT COUNT(*) FROM posting_log WHERE project_id = ? AND platform = ?) as total_posted
      FROM content_batches
      WHERE project_id = ? AND platform = ?
    `).bind(project_id, platform, project_id, platform).first();
    
    const bufferDays = (buffer?.total_scheduled || 0) - (buffer?.total_posted || 0);
    
    return { content: [{ type: "text", text: `✅ Logged batch:\n\nScripted: ${scripted}\nFilmed: ${filmed}\nEdited: ${edited}\nScheduled: ${scheduled}\n\n📦 Content buffer: ~${bufferDays} days` }] };
  });

  server.tool("log_post", {
    project_id: z.string(),
    platform: z.enum(['tiktok', 'email', 'substack', 'instagram', 'youtube']),
    count: z.number().optional().default(1),
    notes: z.string().optional(),
  }, async ({ project_id, platform, count, notes }) => {
    const ts = new Date().toISOString();
    const today = ts.split('T')[0];
    
    await env.DB.prepare(
      'INSERT INTO posting_log (id, project_id, user_id, post_date, platform, post_count, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), project_id, getCurrentUser(), today, platform, count, notes || null, ts).run();
    
    // Calculate streak
    const streakResult = await env.DB.prepare(`
      SELECT DISTINCT post_date FROM posting_log
      WHERE project_id = ? AND platform = ?
      ORDER BY post_date DESC
      LIMIT 60
    `).bind(project_id, platform).all();
    
    let streak = 0;
    let checkDate = today;
    for (const row of streakResult.results as any[]) {
      if (row.post_date === checkDate) {
        streak++;
        checkDate = getPreviousDate(checkDate);
      } else if (row.post_date === getPreviousDate(checkDate)) {
        streak++;
        checkDate = getPreviousDate(row.post_date);
      } else {
        break;
      }
    }
    
    return { content: [{ type: "text", text: `✅ Logged ${count} ${platform} post(s)\n\n🔥 Current streak: ${streak} days` }] };
  });

  server.tool("posting_streak", {
    project_id: z.string(),
    platform: z.string().optional(),
  }, async ({ project_id, platform }) => {
    const platforms = platform ? [platform] : ['tiktok', 'email', 'substack', 'instagram', 'youtube'];
    let out = '🔥 **Posting Streaks**\n\n';
    
    for (const p of platforms) {
      const streakResult = await env.DB.prepare(`
        SELECT DISTINCT post_date FROM posting_log
        WHERE project_id = ? AND platform = ?
        ORDER BY post_date DESC
        LIMIT 60
      `).bind(project_id, p).all();
      
      if (streakResult.results.length === 0) continue;
      
      let streak = 0;
      const today = new Date().toISOString().split('T')[0];
      let checkDate = today;
      
      for (const row of streakResult.results as any[]) {
        if (row.post_date === checkDate || row.post_date === getPreviousDate(checkDate)) {
          streak++;
          checkDate = getPreviousDate(row.post_date);
        } else {
          break;
        }
      }
      
      const total = await env.DB.prepare(
        'SELECT SUM(post_count) as total FROM posting_log WHERE project_id = ? AND platform = ?'
      ).bind(project_id, p).first();
      
      out += `**${p}**: ${streak} day streak (${total?.total || 0} total posts)\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  // --- ACCOUNTABILITY ---

  server.tool("launch_checkin", {
    project_id: z.string(),
    wins: z.string(),
    struggles: z.string(),
    patterns: z.string().optional(),
    next_week_focus: z.string(),
  }, async ({ project_id, wins, struggles, patterns, next_week_focus }) => {
    const ts = new Date().toISOString();
    const today = ts.split('T')[0];
    
    // Get week number
    const startOfYear = new Date(new Date().getFullYear(), 0, 1);
    const weekNumber = Math.ceil(((Date.now() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
    
    // Snapshot current metrics
    const metrics = await env.DB.prepare(`
      SELECT metric_type, metric_name, value
      FROM launch_metrics
      WHERE project_id = ? AND recorded_date = (
        SELECT MAX(recorded_date) FROM launch_metrics WHERE project_id = ?
      )
    `).bind(project_id, project_id).all();
    
    const metricsSnapshot = JSON.stringify(metrics.results);
    
    await env.DB.prepare(
      'INSERT INTO launch_checkins (id, project_id, user_id, week_number, checkin_date, wins, struggles, patterns, next_week_focus, metrics_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), project_id, getCurrentUser(), weekNumber, today, wins, struggles, patterns || null, next_week_focus, metricsSnapshot, ts).run();
    
    // Get streak count
    const checkinCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM launch_checkins WHERE project_id = ? AND user_id = ?'
    ).bind(project_id, getCurrentUser()).first();
    
    return { content: [{ type: "text", text: `✅ Week ${weekNumber} check-in recorded!\n\n🔥 Check-in streak: ${checkinCount?.count || 1} weeks` }] };
  });

  server.tool("checkin_history", {
    project_id: z.string(),
    count: z.number().optional().default(4),
  }, async ({ project_id, count }) => {
    const r = await env.DB.prepare(
      'SELECT * FROM launch_checkins WHERE project_id = ? ORDER BY checkin_date DESC LIMIT ?'
    ).bind(project_id, count).all();
    
    if (r.results.length === 0) {
      return { content: [{ type: "text", text: "No check-ins recorded yet" }] };
    }
    
    let out = '📋 **Check-in History**\n\n';
    
    for (const c of r.results as any[]) {
      out += `**Week ${c.week_number}** (${c.checkin_date})\n`;
      out += `Wins: ${c.wins}\n`;
      out += `Struggles: ${c.struggles}\n`;
      if (c.patterns) out += `Patterns: ${c.patterns}\n`;
      out += `Next focus: ${c.next_week_focus}\n\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });
}
