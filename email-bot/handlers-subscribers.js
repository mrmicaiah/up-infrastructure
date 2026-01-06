/**
 * Subscriber management handlers
 */

import { generateId, jsonResponse, isValidEmail, parseCSVLine } from './lib.js';

export async function handleGetListSubscribers(listId, request, env) {
  let list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(listId).first();
  if (!list) {
    list = await env.DB.prepare('SELECT * FROM lists WHERE slug = ?').bind(listId).first();
  }
  if (!list) {
    return jsonResponse({ error: 'List not found' }, 404);
  }
  listId = list.id;
  
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const search = url.searchParams.get('search');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'), 0);
  
  let query = `
    SELECT s.id as subscription_id, s.status as subscription_status, s.source, s.funnel, 
           s.subscribed_at, s.unsubscribed_at, l.id as lead_id, l.email, l.name, l.created_at
    FROM subscriptions s
    JOIN leads l ON s.lead_id = l.id
    WHERE s.list_id = ?
  `;
  const params = [listId];
  
  if (status) {
    query += ' AND s.status = ?';
    params.push(status);
  }
  if (search) {
    query += ' AND (l.email LIKE ? OR l.name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  
  query += ' ORDER BY s.subscribed_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  
  const results = await env.DB.prepare(query).bind(...params).all();
  
  const countQuery = `SELECT COUNT(*) as total FROM subscriptions WHERE list_id = ?${status ? ' AND status = ?' : ''}`;
  const countParams = status ? [listId, status] : [listId];
  const total = await env.DB.prepare(countQuery).bind(...countParams).first();
  
  return jsonResponse({
    subscribers: results.results,
    count: results.results.length,
    total: total?.total || 0,
    limit,
    offset
  });
}

export async function handleAddSubscriber(listId, request, env) {
  try {
    const data = await request.json();
    
    if (!data.email || !isValidEmail(data.email)) {
      return jsonResponse({ error: 'Valid email required' }, 400);
    }
    
    let list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(listId).first();
    if (!list) {
      list = await env.DB.prepare('SELECT * FROM lists WHERE slug = ?').bind(listId).first();
    }
    if (!list) {
      return jsonResponse({ error: 'List not found' }, 404);
    }
    listId = list.id;
    
    const email = data.email.toLowerCase().trim();
    const now = new Date().toISOString();
    
    let lead = await env.DB.prepare('SELECT * FROM leads WHERE email = ?').bind(email).first();
    let leadId;
    
    if (!lead) {
      const result = await env.DB.prepare(`
        INSERT INTO leads (email, name, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(email, data.name || null, 'manual', now, now).run();
      leadId = result.meta.last_row_id;
    } else {
      leadId = lead.id;
    }
    
    const existingSub = await env.DB.prepare(
      'SELECT * FROM subscriptions WHERE lead_id = ? AND list_id = ?'
    ).bind(leadId, listId).first();
    
    if (existingSub) {
      if (existingSub.status === 'active') {
        return jsonResponse({ error: 'Already subscribed' }, 400);
      }
      await env.DB.prepare(`
        UPDATE subscriptions SET status = 'active', unsubscribed_at = NULL, subscribed_at = ? WHERE id = ?
      `).bind(now, existingSub.id).run();
      return jsonResponse({ success: true, subscription_id: existingSub.id, reactivated: true });
    }
    
    const subId = generateId();
    await env.DB.prepare(`
      INSERT INTO subscriptions (id, lead_id, list_id, status, source, subscribed_at, created_at)
      VALUES (?, ?, ?, 'active', 'manual', ?, ?)
    `).bind(subId, leadId, listId, now, now).run();
    
    return jsonResponse({ success: true, subscription_id: subId }, 201);
  } catch (error) {
    console.error('Add subscriber error:', error);
    return jsonResponse({ error: 'Failed to add subscriber' }, 500);
  }
}

export async function handleRemoveSubscriber(listId, subscriptionId, env) {
  let list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(listId).first();
  if (!list) {
    list = await env.DB.prepare('SELECT * FROM lists WHERE slug = ?').bind(listId).first();
  }
  if (!list) {
    return jsonResponse({ error: 'List not found' }, 404);
  }
  
  const sub = await env.DB.prepare(
    'SELECT * FROM subscriptions WHERE id = ? AND list_id = ?'
  ).bind(subscriptionId, list.id).first();
  
  if (!sub) {
    return jsonResponse({ error: 'Subscription not found' }, 404);
  }
  
  await env.DB.prepare(`
    UPDATE subscriptions SET status = 'unsubscribed', unsubscribed_at = ? WHERE id = ?
  `).bind(new Date().toISOString(), subscriptionId).run();
  
  return jsonResponse({ success: true, message: 'Subscriber removed from list' });
}

export async function handleExportListSubscribers(listId, env) {
  let list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(listId).first();
  if (!list) {
    list = await env.DB.prepare('SELECT * FROM lists WHERE slug = ?').bind(listId).first();
  }
  if (!list) {
    return jsonResponse({ error: 'List not found' }, 404);
  }
  
  const results = await env.DB.prepare(`
    SELECT l.email, l.name, s.source, s.funnel, s.status, s.subscribed_at
    FROM subscriptions s
    JOIN leads l ON s.lead_id = l.id
    WHERE s.list_id = ? AND s.status = 'active'
    ORDER BY s.subscribed_at DESC
    LIMIT 50000
  `).bind(list.id).all();
  
  const headers = ['email', 'name', 'source', 'funnel', 'status', 'subscribed_at'];
  let csv = headers.join(',') + '\n';
  
  for (const row of results.results) {
    csv += headers.map(h => `"${(row[h] || '').toString().replace(/"/g, '""')}"`).join(',') + '\n';
  }

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${list.slug}-subscribers-${new Date().toISOString().split('T')[0]}.csv"`
    }
  });
}

export async function handleImportSubscribers(listId, request, env) {
  try {
    let list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(listId).first();
    if (!list) {
      list = await env.DB.prepare('SELECT * FROM lists WHERE slug = ?').bind(listId).first();
    }
    if (!list) {
      return jsonResponse({ error: 'List not found' }, 404);
    }
    
    const contentType = request.headers.get('Content-Type');
    let csvText;
    
    if (contentType?.includes('text/csv')) {
      csvText = await request.text();
    } else if (contentType?.includes('application/json')) {
      const data = await request.json();
      csvText = data.csv;
    } else {
      return jsonResponse({ error: 'Content-Type must be text/csv or application/json with csv field' }, 400);
    }
    
    if (!csvText || !csvText.trim()) {
      return jsonResponse({ error: 'CSV data required' }, 400);
    }
    
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
      return jsonResponse({ error: 'CSV must have header row and at least one data row' }, 400);
    }
    
    const headerLine = lines[0].toLowerCase();
    const headers = parseCSVLine(headerLine);
    const emailIndex = headers.findIndex(h => h === 'email');
    const nameIndex = headers.findIndex(h => h === 'name');
    const sourceIndex = headers.findIndex(h => h === 'source');
    
    if (emailIndex === -1) {
      return jsonResponse({ error: 'CSV must have an "email" column' }, 400);
    }
    
    const now = new Date().toISOString();
    let imported = 0;
    let skipped = 0;
    let errors = [];
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      try {
        const values = parseCSVLine(line);
        const email = values[emailIndex]?.toLowerCase().trim();
        
        if (!email || !isValidEmail(email)) {
          skipped++;
          continue;
        }
        
        const name = nameIndex !== -1 ? values[nameIndex]?.trim() : null;
        const source = sourceIndex !== -1 ? values[sourceIndex]?.trim() : 'import';
        
        let lead = await env.DB.prepare('SELECT * FROM leads WHERE email = ?').bind(email).first();
        let leadId;
        
        if (!lead) {
          const result = await env.DB.prepare(`
            INSERT INTO leads (email, name, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
          `).bind(email, name, source, now, now).run();
          leadId = result.meta.last_row_id;
        } else {
          leadId = lead.id;
        }
        
        const existingSub = await env.DB.prepare(
          'SELECT * FROM subscriptions WHERE lead_id = ? AND list_id = ?'
        ).bind(leadId, list.id).first();
        
        if (existingSub) {
          if (existingSub.status === 'active') {
            skipped++;
            continue;
          }
          await env.DB.prepare(`
            UPDATE subscriptions SET status = 'active', unsubscribed_at = NULL, subscribed_at = ? WHERE id = ?
          `).bind(now, existingSub.id).run();
        } else {
          const subId = generateId();
          await env.DB.prepare(`
            INSERT INTO subscriptions (id, lead_id, list_id, status, source, subscribed_at, created_at)
            VALUES (?, ?, ?, 'active', ?, ?, ?)
          `).bind(subId, leadId, list.id, source, now, now).run();
        }
        
        imported++;
      } catch (e) {
        errors.push({ row: i + 1, error: e.message });
        if (errors.length >= 10) break;
      }
    }
    
    return jsonResponse({
      success: true,
      imported,
      skipped,
      total: lines.length - 1,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Import error:', error);
    return jsonResponse({ error: 'Failed to import subscribers: ' + error.message }, 500);
  }
}

export async function handleGetSubscribers(request, env) {
  const url = new URL(request.url);
  const segment = url.searchParams.get('segment');
  const status = url.searchParams.get('status');
  const search = url.searchParams.get('search');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'), 0);

  let query = 'SELECT id, email, name, segment, source, created_at, unsubscribed_at, bounce_count FROM leads WHERE 1=1';
  const params = [];

  if (segment) { query += ' AND segment = ?'; params.push(segment); }
  if (status === 'active') { query += ' AND unsubscribed_at IS NULL AND (bounce_count IS NULL OR bounce_count < 3)'; }
  if (status === 'unsubscribed') { query += ' AND unsubscribed_at IS NOT NULL'; }
  if (search) { query += ' AND (email LIKE ? OR name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = await env.DB.prepare(query).bind(...params).all();
  
  const activeCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM leads WHERE unsubscribed_at IS NULL AND (bounce_count IS NULL OR bounce_count < 3)'
  ).first();

  return jsonResponse({
    subscribers: results.results,
    count: results.results.length,
    active_total: activeCount?.count || 0,
    limit,
    offset
  });
}

export async function handleGetSubscriber(id, env) {
  const subscriber = await env.DB.prepare(
    'SELECT * FROM leads WHERE id = ?'
  ).bind(id).first();

  if (!subscriber) {
    return jsonResponse({ error: 'Subscriber not found' }, 404);
  }

  const emailHistory = await env.DB.prepare(`
    SELECT es.*, e.subject 
    FROM email_sends es 
    JOIN emails e ON es.email_id = e.id 
    WHERE es.lead_id = ? 
    ORDER BY es.created_at DESC 
    LIMIT 20
  `).bind(id).all();
  
  const subscriptions = await env.DB.prepare(`
    SELECT s.*, l.name as list_name, l.slug as list_slug
    FROM subscriptions s
    JOIN lists l ON s.list_id = l.id
    WHERE s.lead_id = ?
    ORDER BY s.subscribed_at DESC
  `).bind(id).all();

  return jsonResponse({
    subscriber,
    email_history: emailHistory.results,
    subscriptions: subscriptions.results
  });
}

export async function handleUnsubscribeLead(id, env) {
  const result = await env.DB.prepare(
    'UPDATE leads SET unsubscribed_at = ? WHERE id = ? AND unsubscribed_at IS NULL'
  ).bind(new Date().toISOString(), id).run();

  if (result.meta.changes === 0) {
    return jsonResponse({ error: 'Subscriber not found or already unsubscribed' }, 404);
  }
  
  await env.DB.prepare(
    'UPDATE subscriptions SET status = ?, unsubscribed_at = ? WHERE lead_id = ? AND status = ?'
  ).bind('unsubscribed', new Date().toISOString(), id, 'active').run();

  return jsonResponse({ success: true, message: 'Unsubscribed' });
}
