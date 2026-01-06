/**
 * Tracking handlers - opens, clicks, unsubscribe
 */

import { generateId } from './lib.js';

export async function handleTrackOpen(request, env) {
  const url = new URL(request.url);
  const sendId = url.searchParams.get('sid');
  
  if (sendId) {
    try {
      await env.DB.prepare(
        'UPDATE email_sends SET opened_at = COALESCE(opened_at, ?) WHERE id = ?'
      ).bind(new Date().toISOString(), sendId).run();
    } catch (e) {
      console.error('Track open error:', e);
    }
  }
  
  const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
  return new Response(gif, {
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }
  });
}

export async function handleTrackClick(request, env) {
  const url = new URL(request.url);
  const sendId = url.searchParams.get('sid');
  const targetUrl = url.searchParams.get('url');
  
  if (sendId && targetUrl) {
    try {
      await env.DB.prepare(
        'UPDATE email_sends SET clicked_at = COALESCE(clicked_at, ?) WHERE id = ?'
      ).bind(new Date().toISOString(), sendId).run();
      
      await env.DB.prepare(
        'INSERT INTO email_clicks (id, send_id, url, clicked_at) VALUES (?, ?, ?, ?)'
      ).bind(generateId(), sendId, targetUrl, new Date().toISOString()).run();
    } catch (e) {
      console.error('Track click error:', e);
    }
  }
  
  return Response.redirect(targetUrl || 'https://untitledpublishers.com', 302);
}

export async function handlePublicUnsubscribe(request, env) {
  const url = new URL(request.url);
  const sendId = url.searchParams.get('sid');
  let listName = 'this list';
  
  if (sendId) {
    try {
      const send = await env.DB.prepare(
        'SELECT subscription_id, lead_id FROM email_sends WHERE id = ?'
      ).bind(sendId).first();
      
      if (send) {
        if (send.subscription_id) {
          const sub = await env.DB.prepare(`
            SELECT l.name FROM subscriptions s 
            JOIN lists l ON s.list_id = l.id 
            WHERE s.id = ?
          `).bind(send.subscription_id).first();
          if (sub) listName = sub.name;
          
          await env.DB.prepare(
            'UPDATE subscriptions SET status = ?, unsubscribed_at = ? WHERE id = ?'
          ).bind('unsubscribed', new Date().toISOString(), send.subscription_id).run();
        }
        
        await env.DB.prepare(
          'UPDATE leads SET unsubscribed_at = ? WHERE id = ? AND unsubscribed_at IS NULL'
        ).bind(new Date().toISOString(), send.lead_id).run();
      }
    } catch (e) {
      console.error('Unsubscribe error:', e);
    }
  }
  
  return new Response(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Unsubscribed</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 50px; max-width: 500px; margin: 0 auto;">
      <h1 style="color: #333;">You've been unsubscribed</h1>
      <p style="color: #666; font-size: 18px;">You will no longer receive emails from <strong>${listName}</strong>.</p>
      <p style="margin-top: 30px;"><a href="https://untitledpublishers.com" style="color: #007bff; text-decoration: none;">Return to website</a></p>
    </body>
    </html>
  `, { headers: { 'Content-Type': 'text/html' } });
}
