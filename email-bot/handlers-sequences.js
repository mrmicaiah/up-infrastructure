/**
 * Sequence handlers - sequences, steps, enrollments
 */

import { generateId, jsonResponse } from './lib.js';

export async function handleGetSequences(request, env) {
  const url = new URL(request.url);
  const listId = url.searchParams.get('list_id');
  const status = url.searchParams.get('status');
  
  let query = `
    SELECT s.*, l.name as list_name, l.slug as list_slug,
      (SELECT COUNT(*) FROM sequence_steps ss WHERE ss.sequence_id = s.id AND ss.status = 'active') as step_count,
      (SELECT COUNT(*) FROM sequence_enrollments se WHERE se.sequence_id = s.id AND se.status = 'active') as active_enrollments
    FROM sequences s
    JOIN lists l ON s.list_id = l.id
    WHERE 1=1
  `;
  const params = [];
  
  if (listId) {
    query += ' AND s.list_id = ?';
    params.push(listId);
  }
  if (status) {
    query += ' AND s.status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY s.created_at DESC';
  
  const results = await env.DB.prepare(query).bind(...params).all();
  
  return jsonResponse({ sequences: results.results });
}

export async function handleCreateSequence(request, env) {
  try {
    const data = await request.json();
    
    if (!data.name) {
      return jsonResponse({ error: 'Name required' }, 400);
    }
    if (!data.list_id) {
      return jsonResponse({ error: 'list_id required' }, 400);
    }
    
    let list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(data.list_id).first();
    if (!list) {
      list = await env.DB.prepare('SELECT * FROM lists WHERE slug = ?').bind(data.list_id).first();
    }
    if (!list) {
      return jsonResponse({ error: 'List not found' }, 404);
    }
    
    const id = generateId();
    const now = new Date().toISOString();
    
    await env.DB.prepare(`
      INSERT INTO sequences (id, list_id, name, description, trigger_type, trigger_value, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).bind(
      id,
      list.id,
      data.name,
      data.description || null,
      data.trigger_type || 'subscribe',
      data.trigger_value || null,
      now,
      now
    ).run();
    
    return jsonResponse({ success: true, id, message: 'Sequence created' }, 201);
  } catch (error) {
    console.error('Create sequence error:', error);
    return jsonResponse({ error: 'Failed to create sequence' }, 500);
  }
}

export async function handleGetSequence(id, env) {
  const sequence = await env.DB.prepare(`
    SELECT s.*, l.name as list_name, l.slug as list_slug
    FROM sequences s
    JOIN lists l ON s.list_id = l.id
    WHERE s.id = ?
  `).bind(id).first();
  
  if (!sequence) {
    return jsonResponse({ error: 'Sequence not found' }, 404);
  }
  
  const steps = await env.DB.prepare(`
    SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY position ASC
  `).bind(id).all();
  
  const stats = await env.DB.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
    FROM sequence_enrollments WHERE sequence_id = ?
  `).bind(id).first();
  
  return jsonResponse({
    sequence,
    steps: steps.results,
    stats: {
      total_enrollments: stats?.total || 0,
      active: stats?.active || 0,
      completed: stats?.completed || 0,
      cancelled: stats?.cancelled || 0
    }
  });
}

export async function handleUpdateSequence(id, request, env) {
  try {
    const data = await request.json();
    
    const sequence = await env.DB.prepare('SELECT * FROM sequences WHERE id = ?').bind(id).first();
    if (!sequence) {
      return jsonResponse({ error: 'Sequence not found' }, 404);
    }
    
    const updates = [];
    const params = [];
    
    if (data.name !== undefined) { updates.push('name = ?'); params.push(data.name); }
    if (data.description !== undefined) { updates.push('description = ?'); params.push(data.description); }
    if (data.trigger_type !== undefined) { updates.push('trigger_type = ?'); params.push(data.trigger_type); }
    if (data.trigger_value !== undefined) { updates.push('trigger_value = ?'); params.push(data.trigger_value); }
    if (data.status !== undefined) { updates.push('status = ?'); params.push(data.status); }
    
    if (updates.length === 0) {
      return jsonResponse({ error: 'No fields to update' }, 400);
    }
    
    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    
    await env.DB.prepare(`
      UPDATE sequences SET ${updates.join(', ')} WHERE id = ?
    `).bind(...params).run();
    
    if (data.status === 'active' && sequence.trigger_type === 'subscribe') {
      await env.DB.prepare(`
        UPDATE lists SET welcome_sequence_id = ?, updated_at = ? WHERE id = ? AND (welcome_sequence_id IS NULL OR welcome_sequence_id = ?)
      `).bind(id, new Date().toISOString(), sequence.list_id, id).run();
    }
    
    return jsonResponse({ success: true, message: 'Sequence updated' });
  } catch (error) {
    console.error('Update sequence error:', error);
    return jsonResponse({ error: 'Failed to update sequence' }, 500);
  }
}

export async function handleDeleteSequence(id, env) {
  const sequence = await env.DB.prepare('SELECT * FROM sequences WHERE id = ?').bind(id).first();
  if (!sequence) {
    return jsonResponse({ error: 'Sequence not found' }, 404);
  }
  
  const activeEnrollments = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM sequence_enrollments WHERE sequence_id = ? AND status = ?'
  ).bind(id, 'active').first();
  
  if (activeEnrollments?.count > 0) {
    return jsonResponse({ error: 'Cannot delete sequence with active enrollments. Pause or cancel them first.' }, 400);
  }
  
  await env.DB.prepare(
    'UPDATE lists SET welcome_sequence_id = NULL WHERE welcome_sequence_id = ?'
  ).bind(id).run();
  
  await env.DB.prepare('DELETE FROM sequence_steps WHERE sequence_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM sequence_enrollments WHERE sequence_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM sequences WHERE id = ?').bind(id).run();
  
  return jsonResponse({ success: true, message: 'Sequence deleted' });
}

// ==================== SEQUENCE STEPS ====================

export async function handleGetSequenceSteps(sequenceId, env) {
  const sequence = await env.DB.prepare('SELECT * FROM sequences WHERE id = ?').bind(sequenceId).first();
  if (!sequence) {
    return jsonResponse({ error: 'Sequence not found' }, 404);
  }
  
  const steps = await env.DB.prepare(`
    SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY position ASC
  `).bind(sequenceId).all();
  
  return jsonResponse({ steps: steps.results });
}

export async function handleAddSequenceStep(sequenceId, request, env) {
  try {
    const data = await request.json();
    
    const sequence = await env.DB.prepare('SELECT * FROM sequences WHERE id = ?').bind(sequenceId).first();
    if (!sequence) {
      return jsonResponse({ error: 'Sequence not found' }, 404);
    }
    
    if (!data.subject) {
      return jsonResponse({ error: 'Subject required' }, 400);
    }
    if (!data.body_html) {
      return jsonResponse({ error: 'Body HTML required' }, 400);
    }
    
    const lastStep = await env.DB.prepare(
      'SELECT MAX(position) as max_pos FROM sequence_steps WHERE sequence_id = ?'
    ).bind(sequenceId).first();
    const position = (lastStep?.max_pos || 0) + 1;
    
    const id = generateId();
    const now = new Date().toISOString();
    
    await env.DB.prepare(`
      INSERT INTO sequence_steps (id, sequence_id, position, delay_minutes, subject, preview_text, body_html, body_text, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).bind(
      id,
      sequenceId,
      position,
      data.delay_minutes || 0,
      data.subject,
      data.preview_text || null,
      data.body_html,
      data.body_text || null,
      now,
      now
    ).run();
    
    return jsonResponse({ success: true, id, position, message: 'Step added' }, 201);
  } catch (error) {
    console.error('Add sequence step error:', error);
    return jsonResponse({ error: 'Failed to add step' }, 500);
  }
}

export async function handleUpdateSequenceStep(sequenceId, stepId, request, env) {
  try {
    const data = await request.json();
    
    const step = await env.DB.prepare(
      'SELECT * FROM sequence_steps WHERE id = ? AND sequence_id = ?'
    ).bind(stepId, sequenceId).first();
    
    if (!step) {
      return jsonResponse({ error: 'Step not found' }, 404);
    }
    
    await env.DB.prepare(`
      UPDATE sequence_steps SET
        delay_minutes = COALESCE(?, delay_minutes),
        subject = COALESCE(?, subject),
        preview_text = COALESCE(?, preview_text),
        body_html = COALESCE(?, body_html),
        body_text = COALESCE(?, body_text),
        status = COALESCE(?, status),
        updated_at = ?
      WHERE id = ?
    `).bind(
      data.delay_minutes,
      data.subject,
      data.preview_text,
      data.body_html,
      data.body_text,
      data.status,
      new Date().toISOString(),
      stepId
    ).run();
    
    return jsonResponse({ success: true, message: 'Step updated' });
  } catch (error) {
    console.error('Update sequence step error:', error);
    return jsonResponse({ error: 'Failed to update step' }, 500);
  }
}

export async function handleDeleteSequenceStep(sequenceId, stepId, env) {
  const step = await env.DB.prepare(
    'SELECT * FROM sequence_steps WHERE id = ? AND sequence_id = ?'
  ).bind(stepId, sequenceId).first();
  
  if (!step) {
    return jsonResponse({ error: 'Step not found' }, 404);
  }
  
  await env.DB.prepare('DELETE FROM sequence_steps WHERE id = ?').bind(stepId).run();
  
  await env.DB.prepare(`
    UPDATE sequence_steps 
    SET position = position - 1 
    WHERE sequence_id = ? AND position > ?
  `).bind(sequenceId, step.position).run();
  
  return jsonResponse({ success: true, message: 'Step deleted' });
}

export async function handleReorderSequenceSteps(sequenceId, request, env) {
  try {
    const data = await request.json();
    
    if (!data.step_ids || !Array.isArray(data.step_ids)) {
      return jsonResponse({ error: 'step_ids array required' }, 400);
    }
    
    const sequence = await env.DB.prepare('SELECT * FROM sequences WHERE id = ?').bind(sequenceId).first();
    if (!sequence) {
      return jsonResponse({ error: 'Sequence not found' }, 404);
    }
    
    for (let i = 0; i < data.step_ids.length; i++) {
      await env.DB.prepare(
        'UPDATE sequence_steps SET position = ?, updated_at = ? WHERE id = ? AND sequence_id = ?'
      ).bind(i + 1, new Date().toISOString(), data.step_ids[i], sequenceId).run();
    }
    
    return jsonResponse({ success: true, message: 'Steps reordered' });
  } catch (error) {
    console.error('Reorder steps error:', error);
    return jsonResponse({ error: 'Failed to reorder steps' }, 500);
  }
}

// ==================== SEQUENCE ENROLLMENTS ====================

export async function handleEnrollInSequence(sequenceId, request, env) {
  try {
    const data = await request.json();
    
    if (!data.subscription_id && !data.email) {
      return jsonResponse({ error: 'subscription_id or email required' }, 400);
    }
    
    const sequence = await env.DB.prepare('SELECT * FROM sequences WHERE id = ?').bind(sequenceId).first();
    if (!sequence) {
      return jsonResponse({ error: 'Sequence not found' }, 404);
    }
    
    if (sequence.status !== 'active') {
      return jsonResponse({ error: 'Sequence is not active' }, 400);
    }
    
    let subscriptionId = data.subscription_id;
    
    if (!subscriptionId && data.email) {
      const sub = await env.DB.prepare(`
        SELECT s.id FROM subscriptions s
        JOIN leads l ON s.lead_id = l.id
        WHERE l.email = ? AND s.list_id = ? AND s.status = 'active'
      `).bind(data.email.toLowerCase(), sequence.list_id).first();
      
      if (!sub) {
        return jsonResponse({ error: 'Subscription not found for this email on this list' }, 404);
      }
      subscriptionId = sub.id;
    }
    
    const existing = await env.DB.prepare(
      'SELECT * FROM sequence_enrollments WHERE subscription_id = ? AND sequence_id = ?'
    ).bind(subscriptionId, sequenceId).first();
    
    if (existing) {
      if (existing.status === 'active') {
        return jsonResponse({ error: 'Already enrolled in this sequence' }, 400);
      }
      const firstStep = await env.DB.prepare(
        'SELECT * FROM sequence_steps WHERE sequence_id = ? AND position = 1 AND status = ?'
      ).bind(sequenceId, 'active').first();
      
      const now = new Date();
      const nextSendAt = firstStep 
        ? new Date(now.getTime() + (firstStep.delay_minutes || 0) * 60000).toISOString()
        : null;
      
      await env.DB.prepare(`
        UPDATE sequence_enrollments 
        SET status = 'active', current_step = 0, enrolled_at = ?, next_send_at = ?, completed_at = NULL, cancelled_at = NULL
        WHERE id = ?
      `).bind(now.toISOString(), nextSendAt, existing.id).run();
      
      return jsonResponse({ success: true, enrollment_id: existing.id, message: 'Re-enrolled in sequence' });
    }
    
    const firstStep = await env.DB.prepare(
      'SELECT * FROM sequence_steps WHERE sequence_id = ? AND position = 1 AND status = ?'
    ).bind(sequenceId, 'active').first();
    
    if (!firstStep) {
      return jsonResponse({ error: 'Sequence has no active steps' }, 400);
    }
    
    const now = new Date();
    const nextSendAt = new Date(now.getTime() + (firstStep.delay_minutes || 0) * 60000).toISOString();
    
    const enrollmentId = generateId();
    await env.DB.prepare(`
      INSERT INTO sequence_enrollments (id, subscription_id, sequence_id, current_step, status, enrolled_at, next_send_at, created_at)
      VALUES (?, ?, ?, 0, 'active', ?, ?, ?)
    `).bind(
      enrollmentId,
      subscriptionId,
      sequenceId,
      now.toISOString(),
      nextSendAt,
      now.toISOString()
    ).run();
    
    return jsonResponse({ success: true, enrollment_id: enrollmentId, message: 'Enrolled in sequence' }, 201);
  } catch (error) {
    console.error('Enroll in sequence error:', error);
    return jsonResponse({ error: 'Failed to enroll in sequence' }, 500);
  }
}

export async function handleGetSequenceEnrollments(sequenceId, request, env) {
  const sequence = await env.DB.prepare('SELECT * FROM sequences WHERE id = ?').bind(sequenceId).first();
  if (!sequence) {
    return jsonResponse({ error: 'Sequence not found' }, 404);
  }
  
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'), 0);
  
  let query = `
    SELECT e.*, l.email, l.name
    FROM sequence_enrollments e
    JOIN subscriptions s ON e.subscription_id = s.id
    JOIN leads l ON s.lead_id = l.id
    WHERE e.sequence_id = ?
  `;
  const params = [sequenceId];
  
  if (status) {
    query += ' AND e.status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY e.enrolled_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  
  const results = await env.DB.prepare(query).bind(...params).all();
  
  return jsonResponse({
    enrollments: results.results,
    count: results.results.length,
    limit,
    offset
  });
}

// Internal helper - used by subscribe flow
export async function enrollInSequence(env, subscriptionId, sequenceId) {
  try {
    const existing = await env.DB.prepare(
      'SELECT * FROM sequence_enrollments WHERE subscription_id = ? AND sequence_id = ?'
    ).bind(subscriptionId, sequenceId).first();
    
    if (existing) return;
    
    const firstStep = await env.DB.prepare(
      'SELECT * FROM sequence_steps WHERE sequence_id = ? AND position = 1 AND status = ?'
    ).bind(sequenceId, 'active').first();
    
    if (!firstStep) return;
    
    const now = new Date();
    const nextSendAt = new Date(now.getTime() + (firstStep.delay_minutes || 0) * 60000).toISOString();
    
    await env.DB.prepare(`
      INSERT INTO sequence_enrollments (id, subscription_id, sequence_id, current_step, status, enrolled_at, next_send_at, created_at)
      VALUES (?, ?, ?, 0, 'active', ?, ?, ?)
    `).bind(
      generateId(),
      subscriptionId,
      sequenceId,
      now.toISOString(),
      nextSendAt,
      now.toISOString()
    ).run();
  } catch (error) {
    console.error('Enroll in sequence error:', error);
  }
}
