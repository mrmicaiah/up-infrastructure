/**
 * List CRUD handlers
 */

import { generateId, generateSlug, jsonResponse, isValidEmail } from './lib.js';

export async function handleGetLists(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'active';
  
  let query = `
    SELECT l.*, 
      (SELECT COUNT(*) FROM subscriptions s WHERE s.list_id = l.id AND s.status = 'active') as subscriber_count,
      ct.name as campaign_template_name,
      st.name as sequence_template_name
    FROM lists l
    LEFT JOIN templates ct ON l.campaign_template_id = ct.id
    LEFT JOIN templates st ON l.sequence_template_id = st.id
    WHERE 1=1
  `;
  const params = [];
  
  if (status !== 'all') {
    query += ' AND l.status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY l.created_at DESC';
  
  const results = await env.DB.prepare(query).bind(...params).all();
  
  return jsonResponse({ lists: results.results });
}

export async function handleCreateList(request, env) {
  try {
    const data = await request.json();
    
    if (!data.name) {
      return jsonResponse({ error: 'Name required' }, 400);
    }
    if (!data.from_email || !isValidEmail(data.from_email)) {
      return jsonResponse({ error: 'Valid from_email required' }, 400);
    }
    
    const id = generateId();
    const slug = data.slug || generateSlug(data.name);
    const now = new Date().toISOString();
    
    const existing = await env.DB.prepare('SELECT id FROM lists WHERE slug = ?').bind(slug).first();
    if (existing) {
      return jsonResponse({ error: 'List with this slug already exists' }, 400);
    }
    
    await env.DB.prepare(`
      INSERT INTO lists (id, name, slug, description, from_name, from_email, reply_to, notify_email, double_optin, campaign_template_id, sequence_template_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).bind(
      id,
      data.name,
      slug,
      data.description || null,
      data.from_name || data.name,
      data.from_email,
      data.reply_to || null,
      data.notify_email || null,
      data.double_optin ? 1 : 0,
      data.campaign_template_id || null,
      data.sequence_template_id || null,
      now,
      now
    ).run();
    
    return jsonResponse({ success: true, id, slug, message: 'List created' }, 201);
  } catch (error) {
    console.error('Create list error:', error);
    return jsonResponse({ error: 'Failed to create list' }, 500);
  }
}

export async function handleGetList(id, env) {
  let list = await env.DB.prepare(`
    SELECT l.*,
      ct.name as campaign_template_name,
      st.name as sequence_template_name
    FROM lists l
    LEFT JOIN templates ct ON l.campaign_template_id = ct.id
    LEFT JOIN templates st ON l.sequence_template_id = st.id
    WHERE l.id = ?
  `).bind(id).first();
  
  if (!list) {
    list = await env.DB.prepare(`
      SELECT l.*,
        ct.name as campaign_template_name,
        st.name as sequence_template_name
      FROM lists l
      LEFT JOIN templates ct ON l.campaign_template_id = ct.id
      LEFT JOIN templates st ON l.sequence_template_id = st.id
      WHERE l.slug = ?
    `).bind(id).first();
  }
  
  if (!list) {
    return jsonResponse({ error: 'List not found' }, 404);
  }
  
  const stats = await env.DB.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'unsubscribed' THEN 1 ELSE 0 END) as unsubscribed
    FROM subscriptions WHERE list_id = ?
  `).bind(list.id).first();
  
  return jsonResponse({ 
    list,
    stats: {
      total: stats?.total || 0,
      active: stats?.active || 0,
      unsubscribed: stats?.unsubscribed || 0
    }
  });
}

export async function handleUpdateList(id, request, env) {
  try {
    const data = await request.json();
    
    const list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(id).first();
    if (!list) {
      return jsonResponse({ error: 'List not found' }, 404);
    }
    
    if (data.slug && data.slug !== list.slug) {
      const existing = await env.DB.prepare('SELECT id FROM lists WHERE slug = ? AND id != ?').bind(data.slug, id).first();
      if (existing) {
        return jsonResponse({ error: 'Slug already in use' }, 400);
      }
    }
    
    // Build dynamic update - only include fields that were provided
    // D1 cannot handle undefined values, so we use existing values as defaults
    const name = data.name !== undefined ? data.name : list.name;
    const slug = data.slug !== undefined ? data.slug : list.slug;
    const description = data.description !== undefined ? data.description : list.description;
    const from_name = data.from_name !== undefined ? data.from_name : list.from_name;
    const from_email = data.from_email !== undefined ? data.from_email : list.from_email;
    const reply_to = data.reply_to !== undefined ? data.reply_to : list.reply_to;
    const notify_email = data.notify_email !== undefined ? (data.notify_email || null) : list.notify_email;
    const double_optin = data.double_optin !== undefined ? (data.double_optin ? 1 : 0) : list.double_optin;
    const welcome_sequence_id = data.welcome_sequence_id !== undefined ? data.welcome_sequence_id : list.welcome_sequence_id;
    const campaign_template_id = data.campaign_template_id !== undefined ? data.campaign_template_id : list.campaign_template_id;
    const sequence_template_id = data.sequence_template_id !== undefined ? data.sequence_template_id : list.sequence_template_id;
    
    await env.DB.prepare(`
      UPDATE lists SET
        name = ?,
        slug = ?,
        description = ?,
        from_name = ?,
        from_email = ?,
        reply_to = ?,
        notify_email = ?,
        double_optin = ?,
        welcome_sequence_id = ?,
        campaign_template_id = ?,
        sequence_template_id = ?,
        updated_at = ?
      WHERE id = ?
    `).bind(
      name,
      slug,
      description,
      from_name,
      from_email,
      reply_to,
      notify_email,
      double_optin,
      welcome_sequence_id,
      campaign_template_id,
      sequence_template_id,
      new Date().toISOString(),
      id
    ).run();
    
    return jsonResponse({ success: true, message: 'List updated' });
  } catch (error) {
    console.error('Update list error:', error);
    return jsonResponse({ error: 'Failed to update list' }, 500);
  }
}

export async function handleArchiveList(id, env) {
  const list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(id).first();
  if (!list) {
    return jsonResponse({ error: 'List not found' }, 404);
  }
  
  await env.DB.prepare(`
    UPDATE lists SET status = 'archived', updated_at = ? WHERE id = ?
  `).bind(new Date().toISOString(), id).run();
  
  return jsonResponse({ success: true, message: 'List archived' });
}

export async function handleListStats(id, env) {
  const list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(id).first();
  if (!list) {
    return jsonResponse({ error: 'List not found' }, 404);
  }
  
  const subscriberStats = await env.DB.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'unsubscribed' THEN 1 ELSE 0 END) as unsubscribed,
      SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) as bounced
    FROM subscriptions WHERE list_id = ?
  `).bind(id).first();
  
  const emailStats = await env.DB.prepare(`
    SELECT 
      COUNT(*) as total_campaigns,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as drafts
    FROM emails WHERE list_id = ?
  `).bind(id).first();
  
  const recentGrowth = await env.DB.prepare(`
    SELECT DATE(subscribed_at) as date, COUNT(*) as count 
    FROM subscriptions 
    WHERE list_id = ? AND subscribed_at >= datetime('now', '-30 days')
    GROUP BY DATE(subscribed_at)
    ORDER BY date DESC
  `).bind(id).all();
  
  return jsonResponse({
    list,
    subscribers: subscriberStats,
    emails: emailStats,
    growth: recentGrowth.results
  });
}
