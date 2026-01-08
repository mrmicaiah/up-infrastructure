/**
 * Email/Campaign handlers
 */

import { generateId, jsonResponse, isValidEmail, sendEmailViaSES, renderEmail } from './lib.js';

export async function handleGetEmails(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const listId = url.searchParams.get('list_id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

  let query = 'SELECT e.*, l.name as list_name FROM emails e LEFT JOIN lists l ON e.list_id = l.id WHERE 1=1';
  const params = [];

  if (status) { query += ' AND e.status = ?'; params.push(status); }
  if (listId) { query += ' AND e.list_id = ?'; params.push(listId); }

  query += ' ORDER BY e.updated_at DESC LIMIT ?';
  params.push(limit);

  const results = await env.DB.prepare(query).bind(...params).all();
  
  return jsonResponse({ emails: results.results });
}

export async function handleCreateEmail(request, env) {
  try {
    const data = await request.json();
    
    if (!data.subject) {
      return jsonResponse({ error: 'Subject required' }, 400);
    }
    if (!data.body_html) {
      return jsonResponse({ error: 'Body required' }, 400);
    }

    const id = generateId();
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO emails (id, list_id, title, subject, preview_text, body_html, body_text, segment, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).bind(
      id,
      data.list_id || null,
      data.title || data.subject,
      data.subject,
      data.preview_text || null,
      data.body_html,
      data.body_text || null,
      data.segment || 'all',
      now,
      now
    ).run();

    return jsonResponse({ success: true, id, message: 'Email created' }, 201);
  } catch (error) {
    console.error('Create email error:', error);
    return jsonResponse({ error: 'Failed to create email' }, 500);
  }
}

export async function handleGetEmail(id, env) {
  const email = await env.DB.prepare(
    'SELECT e.*, l.name as list_name, l.from_name, l.from_email FROM emails e LEFT JOIN lists l ON e.list_id = l.id WHERE e.id = ?'
  ).bind(id).first();

  if (!email) {
    return jsonResponse({ error: 'Email not found' }, 404);
  }

  return jsonResponse({ email });
}

export async function handleUpdateEmail(id, request, env) {
  try {
    const data = await request.json();
    const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(id).first();

    if (!email) {
      return jsonResponse({ error: 'Email not found' }, 404);
    }

    if (email.status === 'sent') {
      return jsonResponse({ error: 'Cannot edit sent email' }, 400);
    }

    await env.DB.prepare(`
      UPDATE emails SET
        list_id = COALESCE(?, list_id),
        title = COALESCE(?, title),
        subject = COALESCE(?, subject),
        preview_text = COALESCE(?, preview_text),
        body_html = COALESCE(?, body_html),
        body_text = COALESCE(?, body_text),
        segment = COALESCE(?, segment),
        updated_at = ?
      WHERE id = ?
    `).bind(
      data.list_id,
      data.title,
      data.subject,
      data.preview_text,
      data.body_html,
      data.body_text,
      data.segment,
      new Date().toISOString(),
      id
    ).run();

    return jsonResponse({ success: true, message: 'Email updated' });
  } catch (error) {
    console.error('Update email error:', error);
    return jsonResponse({ error: 'Failed to update email' }, 500);
  }
}

export async function handleDeleteEmail(id, env) {
  const email = await env.DB.prepare('SELECT status FROM emails WHERE id = ?').bind(id).first();

  if (!email) {
    return jsonResponse({ error: 'Email not found' }, 404);
  }

  if (email.status === 'sent') {
    return jsonResponse({ error: 'Cannot delete sent email' }, 400);
  }

  await env.DB.prepare('DELETE FROM emails WHERE id = ?').bind(id).run();

  return jsonResponse({ success: true, message: 'Email deleted' });
}

export async function handleDuplicateEmail(id, env) {
  const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(id).first();

  if (!email) {
    return jsonResponse({ error: 'Email not found' }, 404);
  }

  const newId = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO emails (id, list_id, title, subject, preview_text, body_html, body_text, segment, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).bind(
    newId,
    email.list_id,
    email.title + ' (copy)',
    email.subject,
    email.preview_text,
    email.body_html,
    email.body_text,
    email.segment,
    now,
    now
  ).run();

  return jsonResponse({ success: true, id: newId, message: 'Email duplicated' }, 201);
}

export async function handlePreviewEmail(id, env) {
  const email = await env.DB.prepare(
    'SELECT e.*, l.from_name, l.from_email FROM emails e LEFT JOIN lists l ON e.list_id = l.id WHERE e.id = ?'
  ).bind(id).first();

  if (!email) {
    return jsonResponse({ error: 'Email not found' }, 404);
  }

  let recipientCount;
  if (email.list_id) {
    let query = 'SELECT COUNT(*) as count FROM subscriptions WHERE list_id = ? AND status = ?';
    recipientCount = await env.DB.prepare(query).bind(email.list_id, 'active').first();
  } else {
    let query = 'SELECT COUNT(*) as count FROM leads WHERE unsubscribed_at IS NULL AND (bounce_count IS NULL OR bounce_count < 3)';
    if (email.segment && email.segment !== 'all') {
      query += ' AND segment = ?';
      recipientCount = await env.DB.prepare(query).bind(email.segment).first();
    } else {
      recipientCount = await env.DB.prepare(query).first();
    }
  }

  return jsonResponse({
    email,
    recipient_count: recipientCount?.count || 0
  });
}

export async function handleScheduleEmail(id, request, env) {
  try {
    const data = await request.json();
    
    if (!data.scheduled_at) {
      return jsonResponse({ error: 'scheduled_at required' }, 400);
    }

    const email = await env.DB.prepare('SELECT status FROM emails WHERE id = ?').bind(id).first();

    if (!email) {
      return jsonResponse({ error: 'Email not found' }, 404);
    }

    if (email.status === 'sent') {
      return jsonResponse({ error: 'Email already sent' }, 400);
    }

    await env.DB.prepare(`
      UPDATE emails SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?
    `).bind(data.scheduled_at, new Date().toISOString(), id).run();

    return jsonResponse({ success: true, message: 'Email scheduled', scheduled_at: data.scheduled_at });
  } catch (error) {
    console.error('Schedule email error:', error);
    return jsonResponse({ error: 'Failed to schedule email' }, 500);
  }
}

export async function handleCancelSchedule(id, env) {
  const email = await env.DB.prepare('SELECT status FROM emails WHERE id = ?').bind(id).first();

  if (!email) {
    return jsonResponse({ error: 'Email not found' }, 404);
  }

  if (email.status !== 'scheduled') {
    return jsonResponse({ error: 'Email is not scheduled' }, 400);
  }

  await env.DB.prepare(`
    UPDATE emails SET status = 'draft', scheduled_at = NULL, updated_at = ? WHERE id = ?
  `).bind(new Date().toISOString(), id).run();

  return jsonResponse({ success: true, message: 'Schedule cancelled' });
}

export async function handleSendTestEmail(id, request, env) {
  try {
    const data = await request.json();
    const testEmail = data.email;
    
    if (!testEmail || !isValidEmail(testEmail)) {
      return jsonResponse({ error: 'Valid email required' }, 400);
    }

    const email = await env.DB.prepare(
      'SELECT e.*, l.from_name, l.from_email, l.campaign_template_id FROM emails e LEFT JOIN lists l ON e.list_id = l.id WHERE e.id = ?'
    ).bind(id).first();

    if (!email) {
      return jsonResponse({ error: 'Email not found' }, 404);
    }

    // Fetch campaign template if list has one
    let template = null;
    if (email.campaign_template_id) {
      template = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(email.campaign_template_id).first();
    }

    const fakeSubscriber = { name: 'Test User', email: testEmail };
    const fakeSendId = 'test-' + generateId();
    const baseUrl = 'https://email-bot-server.micaiah-tasks.workers.dev';
    
    const renderedHtml = renderEmail(email, fakeSubscriber, fakeSendId, baseUrl, email, template);
    
    const messageId = await sendEmailViaSES(
      env, 
      testEmail, 
      '[TEST] ' + email.subject, 
      renderedHtml, 
      email.body_text,
      email.from_name,
      email.from_email
    );

    return jsonResponse({ 
      success: true, 
      message: 'Test email sent',
      to: testEmail,
      ses_message_id: messageId,
      used_template: template ? template.name : null
    });
  } catch (error) {
    console.error('Send test email error:', error);
    return jsonResponse({ error: 'Failed to send test email: ' + error.message }, 500);
  }
}

export async function handleSendEmail(id, request, env) {
  try {
    const email = await env.DB.prepare(
      'SELECT e.*, l.from_name, l.from_email, l.campaign_template_id FROM emails e LEFT JOIN lists l ON e.list_id = l.id WHERE e.id = ?'
    ).bind(id).first();

    if (!email) {
      return jsonResponse({ error: 'Email not found' }, 404);
    }

    if (email.status === 'sent') {
      return jsonResponse({ error: 'Email already sent' }, 400);
    }

    // Fetch campaign template if list has one
    let template = null;
    if (email.campaign_template_id) {
      template = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(email.campaign_template_id).first();
    }

    let subscribers;
    
    if (email.list_id) {
      subscribers = await env.DB.prepare(`
        SELECT l.id, l.email, l.name, s.id as subscription_id
        FROM subscriptions s
        JOIN leads l ON s.lead_id = l.id
        WHERE s.list_id = ? AND s.status = 'active'
      `).bind(email.list_id).all();
    } else {
      let subscriberQuery = 'SELECT id, email, name FROM leads WHERE unsubscribed_at IS NULL AND (bounce_count IS NULL OR bounce_count < 3)';
      if (email.segment && email.segment !== 'all') {
        subscriberQuery += ' AND segment = ?';
        subscribers = await env.DB.prepare(subscriberQuery).bind(email.segment).all();
      } else {
        subscribers = await env.DB.prepare(subscriberQuery).all();
      }
    }

    if (!subscribers.results || subscribers.results.length === 0) {
      return jsonResponse({ error: 'No active subscribers found' }, 400);
    }

    const baseUrl = 'https://email-bot-server.micaiah-tasks.workers.dev';
    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const subscriber of subscribers.results) {
      try {
        const sendId = generateId();
        const renderedHtml = renderEmail(email, subscriber, sendId, baseUrl, email, template);
        
        const messageId = await sendEmailViaSES(
          env, 
          subscriber.email, 
          email.subject, 
          renderedHtml, 
          email.body_text,
          email.from_name,
          email.from_email
        );
        
        await env.DB.prepare(`
          INSERT INTO email_sends (id, email_id, lead_id, subscription_id, ses_message_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'sent', ?)
        `).bind(sendId, id, subscriber.id, subscriber.subscription_id || null, messageId, new Date().toISOString()).run();
        
        sent++;
      } catch (e) {
        failed++;
        errors.push({ email: subscriber.email, error: e.message });
        console.error('Failed to send to ' + subscriber.email + ':', e);
      }
    }

    await env.DB.prepare(`
      UPDATE emails SET status = 'sent', sent_at = ?, sent_count = ?, updated_at = ? WHERE id = ?
    `).bind(new Date().toISOString(), sent, new Date().toISOString(), id).run();

    return jsonResponse({ 
      success: true, 
      message: 'Email campaign sent',
      sent,
      failed,
      total: subscribers.results.length,
      used_template: template ? template.name : null,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined
    });
  } catch (error) {
    console.error('Send email error:', error);
    return jsonResponse({ error: 'Failed to send email: ' + error.message }, 500);
  }
}

export async function handleEmailStats(id, env) {
  const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(id).first();

  if (!email) {
    return jsonResponse({ error: 'Email not found' }, 404);
  }

  const sends = await env.DB.prepare(
    'SELECT COUNT(*) as total, SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened, SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked FROM email_sends WHERE email_id = ?'
  ).bind(id).first();

  const clicks = await env.DB.prepare(
    'SELECT url, COUNT(*) as count FROM email_clicks ec JOIN email_sends es ON ec.send_id = es.id WHERE es.email_id = ? GROUP BY url ORDER BY count DESC LIMIT 10'
  ).bind(id).all();

  return jsonResponse({
    email,
    stats: {
      sent: sends?.total || 0,
      opened: sends?.opened || 0,
      clicked: sends?.clicked || 0,
      open_rate: sends?.total > 0 ? ((sends.opened / sends.total) * 100).toFixed(1) : 0,
      click_rate: sends?.total > 0 ? ((sends.clicked / sends.total) * 100).toFixed(1) : 0
    },
    top_links: clicks.results
  });
}
