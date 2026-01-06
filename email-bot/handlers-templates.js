/**
 * Template CRUD handlers
 */

import { generateId, jsonResponse } from './lib.js';

export async function handleGetTemplates(request, env) {
  const url = new URL(request.url);
  const listId = url.searchParams.get('list_id');
  const category = url.searchParams.get('category');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  
  let query = `
    SELECT t.*, l.name as list_name, l.slug as list_slug
    FROM templates t
    LEFT JOIN lists l ON t.list_id = l.id
    WHERE 1=1
  `;
  const params = [];
  
  if (listId) {
    query += ' AND (t.list_id = ? OR t.list_id IS NULL)';
    params.push(listId);
  }
  if (category) {
    query += ' AND t.category = ?';
    params.push(category);
  }
  
  query += ' ORDER BY t.updated_at DESC LIMIT ?';
  params.push(limit);
  
  const results = await env.DB.prepare(query).bind(...params).all();
  
  return jsonResponse({ templates: results.results });
}

export async function handleCreateTemplate(request, env) {
  try {
    const data = await request.json();
    
    if (!data.name) {
      return jsonResponse({ error: 'Name required' }, 400);
    }
    if (!data.body_html) {
      return jsonResponse({ error: 'Body HTML required' }, 400);
    }
    
    if (data.list_id) {
      let list = await env.DB.prepare('SELECT id FROM lists WHERE id = ?').bind(data.list_id).first();
      if (!list) {
        list = await env.DB.prepare('SELECT id FROM lists WHERE slug = ?').bind(data.list_id).first();
      }
      if (!list) {
        return jsonResponse({ error: 'List not found' }, 404);
      }
      data.list_id = list.id;
    }
    
    const id = generateId();
    const now = new Date().toISOString();
    
    await env.DB.prepare(`
      INSERT INTO templates (id, list_id, name, description, subject, body_html, body_text, category, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      data.list_id || null,
      data.name,
      data.description || null,
      data.subject || null,
      data.body_html,
      data.body_text || null,
      data.category || null,
      now,
      now
    ).run();
    
    return jsonResponse({ success: true, id, message: 'Template created' }, 201);
  } catch (error) {
    console.error('Create template error:', error);
    return jsonResponse({ error: 'Failed to create template' }, 500);
  }
}

export async function handleGetTemplate(id, env) {
  const template = await env.DB.prepare(`
    SELECT t.*, l.name as list_name, l.slug as list_slug
    FROM templates t
    LEFT JOIN lists l ON t.list_id = l.id
    WHERE t.id = ?
  `).bind(id).first();
  
  if (!template) {
    return jsonResponse({ error: 'Template not found' }, 404);
  }
  
  return jsonResponse({ template });
}

export async function handleUpdateTemplate(id, request, env) {
  try {
    const data = await request.json();
    
    const template = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
    if (!template) {
      return jsonResponse({ error: 'Template not found' }, 404);
    }
    
    if (data.list_id) {
      let list = await env.DB.prepare('SELECT id FROM lists WHERE id = ?').bind(data.list_id).first();
      if (!list) {
        list = await env.DB.prepare('SELECT id FROM lists WHERE slug = ?').bind(data.list_id).first();
      }
      if (!list) {
        return jsonResponse({ error: 'List not found' }, 404);
      }
      data.list_id = list.id;
    }
    
    await env.DB.prepare(`
      UPDATE templates SET
        list_id = COALESCE(?, list_id),
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        subject = COALESCE(?, subject),
        body_html = COALESCE(?, body_html),
        body_text = COALESCE(?, body_text),
        category = COALESCE(?, category),
        updated_at = ?
      WHERE id = ?
    `).bind(
      data.list_id,
      data.name,
      data.description,
      data.subject,
      data.body_html,
      data.body_text,
      data.category,
      new Date().toISOString(),
      id
    ).run();
    
    return jsonResponse({ success: true, message: 'Template updated' });
  } catch (error) {
    console.error('Update template error:', error);
    return jsonResponse({ error: 'Failed to update template' }, 500);
  }
}

export async function handleDeleteTemplate(id, env) {
  const template = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
  
  if (!template) {
    return jsonResponse({ error: 'Template not found' }, 404);
  }
  
  await env.DB.prepare('DELETE FROM templates WHERE id = ?').bind(id).run();
  
  return jsonResponse({ success: true, message: 'Template deleted' });
}

export async function handleDuplicateTemplate(id, env) {
  const template = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
  
  if (!template) {
    return jsonResponse({ error: 'Template not found' }, 404);
  }
  
  const newId = generateId();
  const now = new Date().toISOString();
  
  await env.DB.prepare(`
    INSERT INTO templates (id, list_id, name, description, subject, body_html, body_text, category, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId,
    template.list_id,
    template.name + ' (copy)',
    template.description,
    template.subject,
    template.body_html,
    template.body_text,
    template.category,
    now,
    now
  ).run();
  
  return jsonResponse({ success: true, id: newId, message: 'Template duplicated' }, 201);
}
