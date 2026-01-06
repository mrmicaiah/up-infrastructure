/**
 * Legacy handlers - backward compatible endpoints
 */

import { generateId, jsonResponse, isValidEmail, isDisposableEmail, sanitizeString, sendEmailViaSES } from './lib.js';
import { enrollInSequence } from './handlers-sequences.js';

// Send lead notification email to list owner
async function sendLeadNotification(env, list, lead, subscription) {
  if (!list.notify_email) return;
  
  try {
    const subject = `🎉 New subscriber: ${lead.email}`;
    
    const metadata = lead.metadata ? JSON.parse(lead.metadata) : {};
    const metadataRows = Object.entries(metadata)
      .map(([k, v]) => `<tr><td style="padding: 8px; border-bottom: 1px solid #eee; color: #666;">${k}</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${v}</td></tr>`)
      .join('');
    
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>New Subscriber</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f5f5;">
  <div style="background: white; border-radius: 8px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <h2 style="margin-top: 0; color: #333;">New subscriber to ${list.name}</h2>
    
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #eee; color: #666; width: 120px;">Email</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>${lead.email}</strong></td>
      </tr>
      ${lead.name ? `<tr><td style="padding: 8px; border-bottom: 1px solid #eee; color: #666;">Name</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${lead.name}</td></tr>` : ''}
      ${subscription.source ? `<tr><td style="padding: 8px; border-bottom: 1px solid #eee; color: #666;">Source</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${subscription.source}</td></tr>` : ''}
      ${subscription.funnel ? `<tr><td style="padding: 8px; border-bottom: 1px solid #eee; color: #666;">Funnel</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${subscription.funnel}</td></tr>` : ''}
      ${lead.segment ? `<tr><td style="padding: 8px; border-bottom: 1px solid #eee; color: #666;">Segment</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${lead.segment}</td></tr>` : ''}
      ${lead.tags ? `<tr><td style="padding: 8px; border-bottom: 1px solid #eee; color: #666;">Tags</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${JSON.parse(lead.tags).join(', ')}</td></tr>` : ''}
      ${metadataRows}
    </table>
    
    <p style="color: #666; font-size: 14px; margin-bottom: 0;">
      Subscribed at ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
    </p>
  </div>
</body>
</html>`;
    
    await sendEmailViaSES(
      env,
      list.notify_email,
      subject,
      html,
      `New subscriber to ${list.name}: ${lead.email}`,
      'Courier Notifications',
      list.from_email
    );
  } catch (error) {
    console.error('Failed to send lead notification:', error);
    // Don't throw - notification failure shouldn't break subscription
  }
}

export async function handleSubscribe(request, env) {
  try {
    const contentType = request.headers.get('Content-Type');
    if (!contentType || !contentType.includes('application/json')) {
      return jsonResponse({ error: 'Content-Type must be application/json' }, 400, request);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, request);
    }
    
    if (!data.email || typeof data.email !== 'string') {
      return jsonResponse({ error: 'Email required' }, 400, request);
    }
    
    if (!data.list) {
      return jsonResponse({ error: 'List slug required' }, 400, request);
    }
    
    const email = data.email.toLowerCase().trim();
    
    if (!isValidEmail(email)) {
      return jsonResponse({ error: 'Invalid email format' }, 400, request);
    }
    
    if (isDisposableEmail(email)) {
      return jsonResponse({ error: 'Please use a valid email address' }, 400, request);
    }
    
    const list = await env.DB.prepare('SELECT * FROM lists WHERE slug = ? AND status = ?')
      .bind(data.list, 'active').first();
    
    if (!list) {
      return jsonResponse({ error: 'List not found' }, 404, request);
    }
    
    const now = new Date().toISOString();
    
    let lead = await env.DB.prepare('SELECT * FROM leads WHERE email = ?').bind(email).first();
    let leadId;
    let isNewLead = false;
    
    if (!lead) {
      isNewLead = true;
      const result = await env.DB.prepare(`
        INSERT INTO leads (email, name, source, funnel, segment, tags, metadata, ip_country, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        email,
        sanitizeString(data.name, 100),
        sanitizeString(data.source, 50) || data.list,
        sanitizeString(data.funnel, 50),
        sanitizeString(data.segment, 50),
        Array.isArray(data.tags) ? JSON.stringify(data.tags.slice(0, 20).map(t => sanitizeString(t, 30))) : null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        request.cf?.country || null,
        now,
        now
      ).run();
      leadId = result.meta.last_row_id;
      
      // Fetch the newly created lead for notification
      lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
    } else {
      leadId = lead.id;
      const existingTags = lead.tags ? JSON.parse(lead.tags) : [];
      const newTags = data.tags || [];
      const mergedTags = [...new Set([...existingTags, ...newTags])].slice(0, 50);
      
      // Merge metadata
      const existingMetadata = lead.metadata ? JSON.parse(lead.metadata) : {};
      const newMetadata = data.metadata || {};
      const mergedMetadata = { ...existingMetadata, ...newMetadata };
      
      await env.DB.prepare(`
        UPDATE leads SET
          name = COALESCE(?, name),
          tags = ?,
          metadata = ?,
          updated_at = ?
        WHERE id = ?
      `).bind(
        data.name || null, 
        JSON.stringify(mergedTags), 
        Object.keys(mergedMetadata).length > 0 ? JSON.stringify(mergedMetadata) : null,
        now, 
        leadId
      ).run();
      
      // Refresh lead data for notification
      lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
    }
    
    const existingSub = await env.DB.prepare(
      'SELECT * FROM subscriptions WHERE lead_id = ? AND list_id = ?'
    ).bind(leadId, list.id).first();
    
    let subscriptionId;
    let isNew = false;
    let subscription;
    
    if (existingSub) {
      subscriptionId = existingSub.id;
      if (existingSub.status !== 'active') {
        await env.DB.prepare(`
          UPDATE subscriptions SET status = 'active', unsubscribed_at = NULL, subscribed_at = ? WHERE id = ?
        `).bind(now, existingSub.id).run();
        isNew = true;
      }
      subscription = existingSub;
    } else {
      isNew = true;
      subscriptionId = generateId();
      
      const source = sanitizeString(data.source, 50) || data.list;
      const funnel = sanitizeString(data.funnel, 50);
      
      await env.DB.prepare(`
        INSERT INTO subscriptions (id, lead_id, list_id, status, source, funnel, subscribed_at, created_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
      `).bind(
        subscriptionId,
        leadId,
        list.id,
        source,
        funnel,
        now,
        now
      ).run();
      
      subscription = { id: subscriptionId, source, funnel };
      
      // Enroll in welcome sequence if configured
      if (list.welcome_sequence_id) {
        await enrollInSequence(env, subscriptionId, list.welcome_sequence_id);
      }
      
      // Send lead notification if configured
      if (list.notify_email) {
        await sendLeadNotification(env, list, lead, subscription);
      }
    }
    
    await logTouch(env, leadId, data.source || data.list, data.funnel);
    
    return jsonResponse({
      success: true,
      message: isNew ? 'Subscribed' : 'Already subscribed',
      subscription_id: subscriptionId,
      new: isNew
    }, 200, request);
    
  } catch (error) {
    console.error('Subscribe error:', error);
    return jsonResponse({ error: 'Failed to subscribe' }, 500, request);
  }
}

export async function handleLeadCapture(request, env) {
  try {
    const contentType = request.headers.get('Content-Type');
    if (!contentType || !contentType.includes('application/json')) {
      return jsonResponse({ error: 'Content-Type must be application/json' }, 400);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }
    
    if (!data.email || typeof data.email !== 'string') {
      return jsonResponse({ error: 'Email required' }, 400);
    }
    
    const email = data.email.toLowerCase().trim();
    
    if (!isValidEmail(email)) {
      return jsonResponse({ error: 'Invalid email format' }, 400);
    }
    
    if (isDisposableEmail(email)) {
      return jsonResponse({ error: 'Please use a valid email address' }, 400);
    }

    const lead = {
      email: email,
      name: sanitizeString(data.name, 100),
      source: sanitizeString(data.source, 50) || 'direct',
      funnel: sanitizeString(data.funnel, 50),
      segment: sanitizeString(data.segment, 50),
      quiz_result: data.quiz_result ? JSON.stringify(data.quiz_result).slice(0, 5000) : null,
      tags: Array.isArray(data.tags) ? JSON.stringify(data.tags.slice(0, 20).map(t => sanitizeString(t, 30))) : null,
      metadata: data.metadata ? JSON.stringify(data.metadata).slice(0, 2000) : null,
      ip_country: request.cf?.country || null,
      created_at: new Date().toISOString(),
    };

    const existing = await env.DB.prepare(
      'SELECT id, tags FROM leads WHERE email = ?'
    ).bind(lead.email).first();

    let leadId;
    let isNew = false;

    if (existing) {
      leadId = existing.id;
      
      const existingTags = existing.tags ? JSON.parse(existing.tags) : [];
      const newTags = data.tags || [];
      const mergedTags = [...new Set([...existingTags, ...newTags])].slice(0, 50);
      
      await env.DB.prepare(`
        UPDATE leads 
        SET source = COALESCE(?, source),
            funnel = COALESCE(?, funnel),
            segment = COALESCE(?, segment),
            tags = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(
        lead.source,
        lead.funnel,
        lead.segment,
        JSON.stringify(mergedTags),
        new Date().toISOString(),
        existing.id
      ).run();

      await logTouch(env, existing.id, lead.source, lead.funnel);

    } else {
      isNew = true;
      
      const result = await env.DB.prepare(`
        INSERT INTO leads (email, name, source, funnel, segment, quiz_result, tags, metadata, ip_country, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        lead.email,
        lead.name,
        lead.source,
        lead.funnel,
        lead.segment,
        lead.quiz_result,
        lead.tags,
        lead.metadata,
        lead.ip_country,
        lead.created_at,
        lead.created_at
      ).run();

      leadId = result.meta.last_row_id;
      await logTouch(env, leadId, lead.source, lead.funnel);
      
      const defaultList = await env.DB.prepare('SELECT * FROM lists WHERE slug = ?').bind('untitled-publishers').first();
      if (defaultList) {
        const subId = generateId();
        await env.DB.prepare(`
          INSERT OR IGNORE INTO subscriptions (id, lead_id, list_id, status, source, funnel, subscribed_at, created_at)
          VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
        `).bind(subId, leadId, defaultList.id, lead.source, lead.funnel, lead.created_at, lead.created_at).run();
        
        // Send notification for default list captures too
        if (defaultList.notify_email) {
          const fullLead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
          await sendLeadNotification(env, defaultList, fullLead, { source: lead.source, funnel: lead.funnel });
        }
      }
    }

    return jsonResponse({ 
      success: true, 
      message: isNew ? 'Lead captured' : 'Lead updated',
      lead_id: leadId,
      new: isNew
    }, 200, request);

  } catch (error) {
    console.error('Lead capture error:', error);
    return jsonResponse({ error: 'Failed to capture lead' }, 500);
  }
}

async function logTouch(env, leadId, source, funnel) {
  try {
    await env.DB.prepare(`
      INSERT INTO touches (lead_id, source, funnel, touched_at)
      VALUES (?, ?, ?, ?)
    `).bind(leadId, source, funnel, new Date().toISOString()).run();
  } catch (error) {
    console.error('Failed to log touch:', error);
  }
}

export async function handleGetLeads(request, env) {
  const url = new URL(request.url);
  const source = url.searchParams.get('source');
  const funnel = url.searchParams.get('funnel');
  const segment = url.searchParams.get('segment');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 1000);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'), 0);

  let query = 'SELECT * FROM leads WHERE 1=1';
  const params = [];

  if (source) { query += ' AND source = ?'; params.push(source); }
  if (funnel) { query += ' AND funnel = ?'; params.push(funnel); }
  if (segment) { query += ' AND segment = ?'; params.push(segment); }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = await env.DB.prepare(query).bind(...params).all();
  
  let countQuery = 'SELECT COUNT(*) as total FROM leads WHERE 1=1';
  const countParams = [];
  if (source) { countQuery += ' AND source = ?'; countParams.push(source); }
  if (funnel) { countQuery += ' AND funnel = ?'; countParams.push(funnel); }
  if (segment) { countQuery += ' AND segment = ?'; countParams.push(segment); }
  
  const totalResult = await env.DB.prepare(countQuery).bind(...countParams).first();
  
  return jsonResponse({
    leads: results.results,
    count: results.results.length,
    total: totalResult?.total || 0,
    limit,
    offset
  });
}

export async function handleExportLeads(request, env) {
  const url = new URL(request.url);
  const source = url.searchParams.get('source');
  const funnel = url.searchParams.get('funnel');

  let query = 'SELECT email, name, source, funnel, segment, created_at FROM leads WHERE 1=1';
  const params = [];

  if (source) { query += ' AND source = ?'; params.push(source); }
  if (funnel) { query += ' AND funnel = ?'; params.push(funnel); }

  query += ' ORDER BY created_at DESC LIMIT 50000';

  const results = await env.DB.prepare(query).bind(...params).all();
  
  const headers = ['email', 'name', 'source', 'funnel', 'segment', 'created_at'];
  let csv = headers.join(',') + '\n';
  
  for (const row of results.results) {
    csv += headers.map(h => `"${(row[h] || '').toString().replace(/"/g, '""')}"`).join(',') + '\n';
  }

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="leads-${new Date().toISOString().split('T')[0]}.csv"`
    }
  });
}

export async function handleStats(request, env) {
  const total = await env.DB.prepare('SELECT COUNT(*) as count FROM leads').first();
  
  const bySource = await env.DB.prepare(
    'SELECT source, COUNT(*) as count FROM leads GROUP BY source ORDER BY count DESC LIMIT 20'
  ).all();

  const byFunnel = await env.DB.prepare(
    'SELECT funnel, COUNT(*) as count FROM leads WHERE funnel IS NOT NULL GROUP BY funnel ORDER BY count DESC LIMIT 20'
  ).all();

  const bySegment = await env.DB.prepare(
    'SELECT segment, COUNT(*) as count FROM leads WHERE segment IS NOT NULL GROUP BY segment ORDER BY count DESC LIMIT 20'
  ).all();

  const last7Days = await env.DB.prepare(
    "SELECT DATE(created_at) as date, COUNT(*) as count FROM leads WHERE created_at >= datetime('now', '-7 days') GROUP BY DATE(created_at) ORDER BY date DESC"
  ).all();

  const emailStats = await env.DB.prepare(
    'SELECT status, COUNT(*) as count FROM emails GROUP BY status'
  ).all();
  
  const listStats = await env.DB.prepare(
    'SELECT l.name, l.slug, COUNT(s.id) as subscribers FROM lists l LEFT JOIN subscriptions s ON s.list_id = l.id AND s.status = ? WHERE l.status = ? GROUP BY l.id ORDER BY subscribers DESC'
  ).bind('active', 'active').all();

  return jsonResponse({
    total: total?.count || 0,
    by_source: bySource.results,
    by_funnel: byFunnel.results,
    by_segment: bySegment.results,
    last_7_days: last7Days.results,
    emails: emailStats.results,
    lists: listStats.results
  });
}
