/**
 * Untitled Publishers Email Platform
 * Cloudflare Worker + D1 Database + AWS SES
 * 
 * Phase 1: Multi-list support with subscriptions
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const ALLOWED_ORIGINS = [
  'https://untitledpublishers.com',
  'https://www.untitledpublishers.com',
  'https://proverbs.untitledpublishers.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
];

const DEFAULT_FROM_EMAIL = 'no-reply@untitledpublishers.com';
const DEFAULT_FROM_NAME = 'Untitled Publishers';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: getCorsHeaders(request) });
    }

    const url = new URL(request.url);
    
    // Debug endpoint
    if (url.pathname === '/debug') {
      const authHeader = request.headers.get('Authorization');
      return jsonResponse({
        hasApiKey: !!env.ADMIN_API_KEY,
        apiKeyLength: env.ADMIN_API_KEY ? env.ADMIN_API_KEY.length : 0,
        hasAwsKey: !!env.AWS_ACCESS_KEY_ID,
        hasAwsSecret: !!env.AWS_SECRET_ACCESS_KEY,
        awsRegion: env.AWS_REGION || 'not set',
        authHeader: authHeader ? authHeader.substring(0, 20) + '...' : null,
        timestamp: new Date().toISOString()
      });
    }
    
    // === PUBLIC ENDPOINTS ===
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
    }
    
    // Lead capture (backward compatible)
    if (url.pathname === '/api/lead' && request.method === 'POST') {
      return handleLeadCapture(request, env);
    }
    
    // New list-aware subscribe endpoint
    if (url.pathname === '/api/subscribe' && request.method === 'POST') {
      return handleSubscribe(request, env);
    }
    
    // Tracking endpoints (public)
    if (url.pathname === '/t/open') {
      return handleTrackOpen(request, env);
    }
    if (url.pathname === '/t/click') {
      return handleTrackClick(request, env);
    }
    if (url.pathname === '/unsubscribe') {
      return handlePublicUnsubscribe(request, env);
    }

    // === PROTECTED ENDPOINTS ===
    if (url.pathname.startsWith('/api/')) {
      const authResult = checkAuth(request, env);
      if (!authResult.ok) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
    }
    
    // === LISTS ===
    if (url.pathname === '/api/lists' && request.method === 'GET') {
      return handleGetLists(request, env);
    }
    if (url.pathname === '/api/lists' && request.method === 'POST') {
      return handleCreateList(request, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+$/) && request.method === 'GET') {
      const id = url.pathname.split('/').pop();
      return handleGetList(id, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+$/) && request.method === 'PUT') {
      const id = url.pathname.split('/').pop();
      return handleUpdateList(id, request, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+$/) && request.method === 'DELETE') {
      const id = url.pathname.split('/').pop();
      return handleArchiveList(id, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+\/stats$/) && request.method === 'GET') {
      const id = url.pathname.split('/')[3];
      return handleListStats(id, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+\/subscribers$/) && request.method === 'GET') {
      const id = url.pathname.split('/')[3];
      return handleGetListSubscribers(id, request, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+\/subscribers$/) && request.method === 'POST') {
      const id = url.pathname.split('/')[3];
      return handleAddSubscriber(id, request, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+\/subscribers\/[a-zA-Z0-9-]+$/) && request.method === 'DELETE') {
      const parts = url.pathname.split('/');
      const listId = parts[3];
      const subscriptionId = parts[5];
      return handleRemoveSubscriber(listId, subscriptionId, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+\/export$/) && request.method === 'GET') {
      const id = url.pathname.split('/')[3];
      return handleExportListSubscribers(id, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+\/import$/) && request.method === 'POST') {
      const id = url.pathname.split('/')[3];
      return handleImportSubscribers(id, request, env);
    }

    // === LEGACY LEADS (backward compatible) ===
    if (url.pathname === '/api/leads' && request.method === 'GET') {
      return handleGetLeads(request, env);
    }
    if (url.pathname === '/api/leads/export' && request.method === 'GET') {
      return handleExportLeads(request, env);
    }
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      return handleStats(request, env);
    }

    // === SUBSCRIBERS ===
    if (url.pathname === '/api/subscribers' && request.method === 'GET') {
      return handleGetSubscribers(request, env);
    }
    if (url.pathname.match(/^\/api\/subscribers\/\d+$/) && request.method === 'GET') {
      const id = url.pathname.split('/').pop();
      return handleGetSubscriber(id, env);
    }
    if (url.pathname.match(/^\/api\/subscribers\/\d+$/) && request.method === 'DELETE') {
      const id = url.pathname.split('/').pop();
      return handleUnsubscribeLead(id, env);
    }

    // === EMAILS ===
    if (url.pathname === '/api/emails' && request.method === 'GET') {
      return handleGetEmails(request, env);
    }
    if (url.pathname === '/api/emails' && request.method === 'POST') {
      return handleCreateEmail(request, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+$/) && request.method === 'GET') {
      const id = url.pathname.split('/').pop();
      return handleGetEmail(id, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+$/) && request.method === 'PUT') {
      const id = url.pathname.split('/').pop();
      return handleUpdateEmail(id, request, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+$/) && request.method === 'DELETE') {
      const id = url.pathname.split('/').pop();
      return handleDeleteEmail(id, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/duplicate$/) && request.method === 'POST') {
      const id = url.pathname.split('/')[3];
      return handleDuplicateEmail(id, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/preview$/) && request.method === 'GET') {
      const id = url.pathname.split('/')[3];
      return handlePreviewEmail(id, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/schedule$/) && request.method === 'POST') {
      const id = url.pathname.split('/')[3];
      return handleScheduleEmail(id, request, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/schedule$/) && request.method === 'DELETE') {
      const id = url.pathname.split('/')[3];
      return handleCancelSchedule(id, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/send$/) && request.method === 'POST') {
      const id = url.pathname.split('/')[3];
      return handleSendEmail(id, request, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/test$/) && request.method === 'POST') {
      const id = url.pathname.split('/')[3];
      return handleSendTestEmail(id, request, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/stats$/) && request.method === 'GET') {
      const id = url.pathname.split('/')[3];
      return handleEmailStats(id, env);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },

  // Cron handler for scheduled tasks
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processSequenceEmails(env));
    ctx.waitUntil(processScheduledCampaigns(env));
  }
};

// ==================== AUTH ====================

function checkAuth(request, env) {
  if (!env.ADMIN_API_KEY) return { ok: true };
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return { ok: false };
  return { ok: authHeader.slice(7) === env.ADMIN_API_KEY };
}

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = { ...CORS_HEADERS };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// ==================== HELPERS ====================

function generateId() {
  return crypto.randomUUID();
}

function generateSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

function jsonResponse(data, status = 200, request = null) {
  const headers = request ? getCorsHeaders(request) : CORS_HEADERS;
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function isValidEmail(email) {
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isDisposableEmail(email) {
  const disposableDomains = [
    'tempmail.com', 'throwaway.email', 'guerrillamail.com', 
    'mailinator.com', '10minutemail.com', 'temp-mail.org',
    'fakeinbox.com', 'trashmail.com', 'yopmail.com'
  ];
  const domain = email.split('@')[1]?.toLowerCase();
  return disposableDomains.includes(domain);
}

function sanitizeString(str, maxLength = 100) {
  if (!str || typeof str !== 'string') return null;
  return str.trim().slice(0, maxLength).replace(/[<>]/g, '');
}

// ==================== AWS SES ====================

async function signAWSRequest(request, env) {
  const region = env.AWS_REGION || 'us-east-2';
  const service = 'ses';
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  
  const date = new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const url = new URL(request.url);
  const canonicalUri = url.pathname;
  const canonicalQuerystring = url.search.slice(1);
  
  const headers = new Headers(request.headers);
  headers.set('host', url.host);
  headers.set('x-amz-date', amzDate);
  
  const signedHeaders = 'content-type;host;x-amz-date';
  const body = await request.clone().text();
  const payloadHash = await sha256(body);
  
  const canonicalHeaders = `content-type:${headers.get('content-type')}\nhost:${url.host}\nx-amz-date:${amzDate}\n`;
  
  const canonicalRequest = [
    request.method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    await sha256(canonicalRequest)
  ].join('\n');
  
  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);
  
  const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  headers.set('Authorization', authorizationHeader);
  
  return new Request(request.url, {
    method: request.method,
    headers: headers,
    body: body
  });
}

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

async function hmacHex(key, message) {
  const sig = await hmac(key, message);
  return Array.from(sig).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(key, dateStamp, region, service) {
  const kDate = await hmac('AWS4' + key, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  return kSigning;
}

async function sendEmailViaSES(env, to, subject, htmlBody, textBody, fromName, fromEmail) {
  const region = env.AWS_REGION || 'us-east-2';
  const endpoint = `https://email.${region}.amazonaws.com/`;
  
  const params = new URLSearchParams();
  params.append('Action', 'SendEmail');
  params.append('Version', '2010-12-01');
  params.append('Source', `${fromName || DEFAULT_FROM_NAME} <${fromEmail || DEFAULT_FROM_EMAIL}>`);
  params.append('Destination.ToAddresses.member.1', to);
  params.append('Message.Subject.Data', subject);
  params.append('Message.Subject.Charset', 'UTF-8');
  params.append('Message.Body.Html.Data', htmlBody);
  params.append('Message.Body.Html.Charset', 'UTF-8');
  if (textBody) {
    params.append('Message.Body.Text.Data', textBody);
    params.append('Message.Body.Text.Charset', 'UTF-8');
  }
  
  const request = new Request(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  
  const signedRequest = await signAWSRequest(request, env);
  const response = await fetch(signedRequest);
  const responseText = await response.text();
  
  if (!response.ok) {
    console.error('SES Error:', responseText);
    throw new Error(`SES Error: ${response.status} - ${responseText}`);
  }
  
  const messageIdMatch = responseText.match(/<MessageId>(.+?)<\/MessageId>/);
  return messageIdMatch ? messageIdMatch[1] : null;
}

// ==================== EMAIL RENDERING ====================

function renderEmail(email, subscriber, sendId, baseUrl, list) {
  let html = email.body_html;
  
  // Merge tags
  html = html.replace(/\{first_name\}/g, subscriber.name?.split(' ')[0] || 'Friend');
  html = html.replace(/\{name\}/g, subscriber.name || 'Friend');
  html = html.replace(/\{email\}/g, subscriber.email);
  
  // Wrap in template
  const trackingPixel = `<img src="${baseUrl}/t/open?sid=${sendId}" width="1" height="1" style="display:none;" alt="">`;
  const unsubscribeUrl = `${baseUrl}/unsubscribe?sid=${sendId}`;
  
  const fromName = list?.from_name || DEFAULT_FROM_NAME;
  
  const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${email.subject}</title>
</head>
<body style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 20px; line-height: 1.6;">
  ${html}
  <hr style="margin-top: 40px; border: none; border-top: 1px solid #ddd;">
  <p style="font-size: 12px; color: #666; text-align: center;">
    You're receiving this because you signed up for ${fromName}.<br>
    <a href="${unsubscribeUrl}" style="color: #666;">Unsubscribe</a>
  </p>
  ${trackingPixel}
</body>
</html>`;

  return fullHtml;
}

// ==================== TRACKING ====================

async function handleTrackOpen(request, env) {
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

async function handleTrackClick(request, env) {
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

async function handlePublicUnsubscribe(request, env) {
  const url = new URL(request.url);
  const sendId = url.searchParams.get('sid');
  let listName = 'this list';
  
  if (sendId) {
    try {
      // Get the subscription from the send record
      const send = await env.DB.prepare(
        'SELECT subscription_id, lead_id FROM email_sends WHERE id = ?'
      ).bind(sendId).first();
      
      if (send) {
        // Unsubscribe from the specific list (via subscription)
        if (send.subscription_id) {
          // Get list name for the confirmation page
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
        
        // Also mark the lead as unsubscribed (backward compat)
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

// ==================== LISTS CRUD ====================

async function handleGetLists(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'active';
  
  let query = `
    SELECT l.*, 
      (SELECT COUNT(*) FROM subscriptions s WHERE s.list_id = l.id AND s.status = 'active') as subscriber_count 
    FROM lists l WHERE 1=1
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

async function handleCreateList(request, env) {
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
      INSERT INTO lists (id, name, slug, description, from_name, from_email, reply_to, double_optin, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).bind(
      id,
      data.name,
      slug,
      data.description || null,
      data.from_name || data.name,
      data.from_email,
      data.reply_to || null,
      data.double_optin ? 1 : 0,
      now,
      now
    ).run();
    
    return jsonResponse({ success: true, id, slug, message: 'List created' }, 201);
  } catch (error) {
    console.error('Create list error:', error);
    return jsonResponse({ error: 'Failed to create list' }, 500);
  }
}

async function handleGetList(id, env) {
  let list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(id).first();
  if (!list) {
    list = await env.DB.prepare('SELECT * FROM lists WHERE slug = ?').bind(id).first();
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

async function handleUpdateList(id, request, env) {
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
    
    await env.DB.prepare(`
      UPDATE lists SET
        name = COALESCE(?, name),
        slug = COALESCE(?, slug),
        description = COALESCE(?, description),
        from_name = COALESCE(?, from_name),
        from_email = COALESCE(?, from_email),
        reply_to = COALESCE(?, reply_to),
        double_optin = COALESCE(?, double_optin),
        welcome_sequence_id = COALESCE(?, welcome_sequence_id),
        updated_at = ?
      WHERE id = ?
    `).bind(
      data.name,
      data.slug,
      data.description,
      data.from_name,
      data.from_email,
      data.reply_to,
      data.double_optin !== undefined ? (data.double_optin ? 1 : 0) : null,
      data.welcome_sequence_id,
      new Date().toISOString(),
      id
    ).run();
    
    return jsonResponse({ success: true, message: 'List updated' });
  } catch (error) {
    console.error('Update list error:', error);
    return jsonResponse({ error: 'Failed to update list' }, 500);
  }
}

async function handleArchiveList(id, env) {
  const list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(id).first();
  if (!list) {
    return jsonResponse({ error: 'List not found' }, 404);
  }
  
  await env.DB.prepare(`
    UPDATE lists SET status = 'archived', updated_at = ? WHERE id = ?
  `).bind(new Date().toISOString(), id).run();
  
  return jsonResponse({ success: true, message: 'List archived' });
}

async function handleListStats(id, env) {
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

// ==================== LIST SUBSCRIBERS ====================

async function handleGetListSubscribers(listId, request, env) {
  // Look up by ID first, then by slug
  let list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(listId).first();
  if (!list) {
    list = await env.DB.prepare('SELECT * FROM lists WHERE slug = ?').bind(listId).first();
  }
  if (!list) {
    return jsonResponse({ error: 'List not found' }, 404);
  }
  listId = list.id; // Use actual ID for queries
  
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

async function handleAddSubscriber(listId, request, env) {
  try {
    const data = await request.json();
    
    if (!data.email || !isValidEmail(data.email)) {
      return jsonResponse({ error: 'Valid email required' }, 400);
    }
    
    // Look up by ID first, then by slug
    let list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(listId).first();
    if (!list) {
      list = await env.DB.prepare('SELECT * FROM lists WHERE slug = ?').bind(listId).first();
    }
    if (!list) {
      return jsonResponse({ error: 'List not found' }, 404);
    }
    listId = list.id; // Use actual ID for queries
    
    const email = data.email.toLowerCase().trim();
    const now = new Date().toISOString();
    
    // Get or create lead
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
    
    // Check existing subscription
    const existingSub = await env.DB.prepare(
      'SELECT * FROM subscriptions WHERE lead_id = ? AND list_id = ?'
    ).bind(leadId, listId).first();
    
    if (existingSub) {
      if (existingSub.status === 'active') {
        return jsonResponse({ error: 'Already subscribed' }, 400);
      }
      // Reactivate
      await env.DB.prepare(`
        UPDATE subscriptions SET status = 'active', unsubscribed_at = NULL, subscribed_at = ? WHERE id = ?
      `).bind(now, existingSub.id).run();
      return jsonResponse({ success: true, subscription_id: existingSub.id, reactivated: true });
    }
    
    // Create new subscription
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

async function handleRemoveSubscriber(listId, subscriptionId, env) {
  // Look up list by ID first, then by slug
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

async function handleExportListSubscribers(listId, env) {
  // Look up list by ID first, then by slug
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

async function handleImportSubscribers(listId, request, env) {
  try {
    // Look up list by ID first, then by slug
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
    
    // Parse CSV
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
      return jsonResponse({ error: 'CSV must have header row and at least one data row' }, 400);
    }
    
    // Parse header
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
    
    // Process each row
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
        
        // Get or create lead
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
        
        // Check existing subscription
        const existingSub = await env.DB.prepare(
          'SELECT * FROM subscriptions WHERE lead_id = ? AND list_id = ?'
        ).bind(leadId, list.id).first();
        
        if (existingSub) {
          if (existingSub.status === 'active') {
            skipped++;
            continue;
          }
          // Reactivate
          await env.DB.prepare(`
            UPDATE subscriptions SET status = 'active', unsubscribed_at = NULL, subscribed_at = ? WHERE id = ?
          `).bind(now, existingSub.id).run();
        } else {
          // Create new subscription
          const subId = generateId();
          await env.DB.prepare(`
            INSERT INTO subscriptions (id, lead_id, list_id, status, source, subscribed_at, created_at)
            VALUES (?, ?, ?, 'active', ?, ?, ?)
          `).bind(subId, leadId, list.id, source, now, now).run();
        }
        
        imported++;
      } catch (e) {
        errors.push({ row: i + 1, error: e.message });
        if (errors.length >= 10) break; // Stop after 10 errors
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

// Simple CSV line parser (handles quoted fields)
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  
  return result;
}

// ==================== SUBSCRIBE (NEW LIST-AWARE) ====================

async function handleSubscribe(request, env) {
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
    
    // Find list by slug
    const list = await env.DB.prepare('SELECT * FROM lists WHERE slug = ? AND status = ?')
      .bind(data.list, 'active').first();
    
    if (!list) {
      return jsonResponse({ error: 'List not found' }, 404, request);
    }
    
    const now = new Date().toISOString();
    
    // Get or create lead
    let lead = await env.DB.prepare('SELECT * FROM leads WHERE email = ?').bind(email).first();
    let leadId;
    let isNewLead = false;
    
    if (!lead) {
      isNewLead = true;
      const result = await env.DB.prepare(`
        INSERT INTO leads (email, name, source, funnel, segment, tags, ip_country, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        email,
        sanitizeString(data.name, 100),
        sanitizeString(data.source, 50) || data.list,
        sanitizeString(data.funnel, 50),
        sanitizeString(data.segment, 50),
        Array.isArray(data.tags) ? JSON.stringify(data.tags.slice(0, 20).map(t => sanitizeString(t, 30))) : null,
        request.cf?.country || null,
        now,
        now
      ).run();
      leadId = result.meta.last_row_id;
    } else {
      leadId = lead.id;
      // Update lead with new info
      const existingTags = lead.tags ? JSON.parse(lead.tags) : [];
      const newTags = data.tags || [];
      const mergedTags = [...new Set([...existingTags, ...newTags])].slice(0, 50);
      
      await env.DB.prepare(`
        UPDATE leads SET
          name = COALESCE(?, name),
          tags = ?,
          updated_at = ?
        WHERE id = ?
      `).bind(data.name || null, JSON.stringify(mergedTags), now, leadId).run();
    }
    
    // Check existing subscription
    const existingSub = await env.DB.prepare(
      'SELECT * FROM subscriptions WHERE lead_id = ? AND list_id = ?'
    ).bind(leadId, list.id).first();
    
    let subscriptionId;
    let isNew = false;
    
    if (existingSub) {
      subscriptionId = existingSub.id;
      if (existingSub.status !== 'active') {
        // Reactivate
        await env.DB.prepare(`
          UPDATE subscriptions SET status = 'active', unsubscribed_at = NULL, subscribed_at = ? WHERE id = ?
        `).bind(now, existingSub.id).run();
        isNew = true;
      }
    } else {
      isNew = true;
      subscriptionId = generateId();
      await env.DB.prepare(`
        INSERT INTO subscriptions (id, lead_id, list_id, status, source, funnel, subscribed_at, created_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
      `).bind(
        subscriptionId,
        leadId,
        list.id,
        sanitizeString(data.source, 50) || data.list,
        sanitizeString(data.funnel, 50),
        now,
        now
      ).run();
      
      // Enroll in welcome sequence if list has one
      if (list.welcome_sequence_id) {
        await enrollInSequence(env, subscriptionId, list.welcome_sequence_id);
      }
    }
    
    // Log touch
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

async function enrollInSequence(env, subscriptionId, sequenceId) {
  try {
    // Check if already enrolled
    const existing = await env.DB.prepare(
      'SELECT * FROM sequence_enrollments WHERE subscription_id = ? AND sequence_id = ?'
    ).bind(subscriptionId, sequenceId).first();
    
    if (existing) return;
    
    // Get first step to determine next_send_at
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

// ==================== LEAD CAPTURE (BACKWARD COMPATIBLE) ====================

async function handleLeadCapture(request, env) {
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
      
      // Also create subscription to default list
      const defaultList = await env.DB.prepare('SELECT id FROM lists WHERE slug = ?').bind('untitled-publishers').first();
      if (defaultList) {
        const subId = generateId();
        await env.DB.prepare(`
          INSERT OR IGNORE INTO subscriptions (id, lead_id, list_id, status, source, funnel, subscribed_at, created_at)
          VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
        `).bind(subId, leadId, defaultList.id, lead.source, lead.funnel, lead.created_at, lead.created_at).run();
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

// ==================== LEGACY LEADS ====================

async function handleGetLeads(request, env) {
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

async function handleExportLeads(request, env) {
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

async function handleStats(request, env) {
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

// ==================== SUBSCRIBERS ====================

async function handleGetSubscribers(request, env) {
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

async function handleGetSubscriber(id, env) {
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
  
  // Get all list subscriptions
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

async function handleUnsubscribeLead(id, env) {
  const result = await env.DB.prepare(
    'UPDATE leads SET unsubscribed_at = ? WHERE id = ? AND unsubscribed_at IS NULL'
  ).bind(new Date().toISOString(), id).run();

  if (result.meta.changes === 0) {
    return jsonResponse({ error: 'Subscriber not found or already unsubscribed' }, 404);
  }
  
  // Also unsubscribe from all lists
  await env.DB.prepare(
    'UPDATE subscriptions SET status = ?, unsubscribed_at = ? WHERE lead_id = ? AND status = ?'
  ).bind('unsubscribed', new Date().toISOString(), id, 'active').run();

  return jsonResponse({ success: true, message: 'Unsubscribed' });
}

// ==================== EMAILS ====================

async function handleGetEmails(request, env) {
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

async function handleCreateEmail(request, env) {
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

async function handleGetEmail(id, env) {
  const email = await env.DB.prepare(
    'SELECT e.*, l.name as list_name, l.from_name, l.from_email FROM emails e LEFT JOIN lists l ON e.list_id = l.id WHERE e.id = ?'
  ).bind(id).first();

  if (!email) {
    return jsonResponse({ error: 'Email not found' }, 404);
  }

  return jsonResponse({ email });
}

async function handleUpdateEmail(id, request, env) {
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

async function handleDeleteEmail(id, env) {
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

async function handleDuplicateEmail(id, env) {
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

async function handlePreviewEmail(id, env) {
  const email = await env.DB.prepare(
    'SELECT e.*, l.from_name, l.from_email FROM emails e LEFT JOIN lists l ON e.list_id = l.id WHERE e.id = ?'
  ).bind(id).first();

  if (!email) {
    return jsonResponse({ error: 'Email not found' }, 404);
  }

  let recipientCount;
  if (email.list_id) {
    // Count from subscriptions for that list
    let query = 'SELECT COUNT(*) as count FROM subscriptions WHERE list_id = ? AND status = ?';
    recipientCount = await env.DB.prepare(query).bind(email.list_id, 'active').first();
  } else {
    // Fallback to all active leads
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

async function handleScheduleEmail(id, request, env) {
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

async function handleCancelSchedule(id, env) {
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

async function handleSendTestEmail(id, request, env) {
  try {
    const data = await request.json();
    const testEmail = data.email;
    
    if (!testEmail || !isValidEmail(testEmail)) {
      return jsonResponse({ error: 'Valid email required' }, 400);
    }

    const email = await env.DB.prepare(
      'SELECT e.*, l.from_name, l.from_email FROM emails e LEFT JOIN lists l ON e.list_id = l.id WHERE e.id = ?'
    ).bind(id).first();

    if (!email) {
      return jsonResponse({ error: 'Email not found' }, 404);
    }

    const fakeSubscriber = { name: 'Test User', email: testEmail };
    const fakeSendId = 'test-' + generateId();
    const baseUrl = 'https://email-bot-server.micaiah-tasks.workers.dev';
    
    const renderedHtml = renderEmail(email, fakeSubscriber, fakeSendId, baseUrl, email);
    
    const messageId = await sendEmailViaSES(
      env, 
      testEmail, 
      `[TEST] ${email.subject}`, 
      renderedHtml, 
      email.body_text,
      email.from_name,
      email.from_email
    );

    return jsonResponse({ 
      success: true, 
      message: 'Test email sent',
      to: testEmail,
      ses_message_id: messageId
    });
  } catch (error) {
    console.error('Send test email error:', error);
    return jsonResponse({ error: 'Failed to send test email: ' + error.message }, 500);
  }
}

async function handleSendEmail(id, request, env) {
  try {
    const email = await env.DB.prepare(
      'SELECT e.*, l.from_name, l.from_email FROM emails e LEFT JOIN lists l ON e.list_id = l.id WHERE e.id = ?'
    ).bind(id).first();

    if (!email) {
      return jsonResponse({ error: 'Email not found' }, 404);
    }

    if (email.status === 'sent') {
      return jsonResponse({ error: 'Email already sent' }, 400);
    }

    let subscribers;
    
    if (email.list_id) {
      // Get subscribers from list
      subscribers = await env.DB.prepare(`
        SELECT l.id, l.email, l.name, s.id as subscription_id
        FROM subscriptions s
        JOIN leads l ON s.lead_id = l.id
        WHERE s.list_id = ? AND s.status = 'active'
      `).bind(email.list_id).all();
    } else {
      // Fallback: get all active leads (legacy)
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
        const renderedHtml = renderEmail(email, subscriber, sendId, baseUrl, email);
        
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
        console.error(`Failed to send to ${subscriber.email}:`, e);
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
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined
    });
  } catch (error) {
    console.error('Send email error:', error);
    return jsonResponse({ error: 'Failed to send email: ' + error.message }, 500);
  }
}

async function handleEmailStats(id, env) {
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

// ==================== CRON: SEQUENCE PROCESSING ====================

async function processSequenceEmails(env) {
  try {
    const due = await env.DB.prepare(`
      SELECT e.id as enrollment_id, e.sequence_id, e.current_step, e.subscription_id,
             ss.id as step_id, ss.subject, ss.preview_text, ss.body_html, ss.body_text, ss.delay_minutes,
             sub.lead_id, l.email, l.name,
             seq.list_id, lst.from_name, lst.from_email
      FROM sequence_enrollments e
      JOIN sequence_steps ss ON ss.sequence_id = e.sequence_id AND ss.position = e.current_step + 1
      JOIN subscriptions sub ON sub.id = e.subscription_id
      JOIN leads l ON l.id = sub.lead_id
      JOIN sequences seq ON seq.id = e.sequence_id
      JOIN lists lst ON lst.id = seq.list_id
      WHERE e.status = 'active'
        AND e.next_send_at <= datetime('now')
        AND ss.status = 'active'
        AND sub.status = 'active'
      LIMIT 50
    `).all();
    
    if (!due.results || due.results.length === 0) return;
    
    const baseUrl = 'https://email-bot-server.micaiah-tasks.workers.dev';
    
    for (const enrollment of due.results) {
      try {
        const sendId = generateId();
        const subscriber = { email: enrollment.email, name: enrollment.name };
        const emailObj = {
          subject: enrollment.subject,
          body_html: enrollment.body_html,
          body_text: enrollment.body_text
        };
        const list = {
          from_name: enrollment.from_name,
          from_email: enrollment.from_email
        };
        
        const renderedHtml = renderEmail(emailObj, subscriber, sendId, baseUrl, list);
        
        await sendEmailViaSES(
          env,
          enrollment.email,
          enrollment.subject,
          renderedHtml,
          enrollment.body_text,
          enrollment.from_name,
          enrollment.from_email
        );
        
        // Log the send
        await env.DB.prepare(`
          INSERT INTO email_sends (id, email_id, lead_id, subscription_id, status, created_at)
          VALUES (?, ?, ?, ?, 'sent', ?)
        `).bind(sendId, enrollment.step_id, enrollment.lead_id, enrollment.subscription_id, new Date().toISOString()).run();
        
        // Check for next step
        const nextStep = await env.DB.prepare(`
          SELECT * FROM sequence_steps 
          WHERE sequence_id = ? AND position = ? AND status = 'active'
        `).bind(enrollment.sequence_id, enrollment.current_step + 2).first();
        
        if (nextStep) {
          const nextSendAt = new Date(Date.now() + nextStep.delay_minutes * 60000).toISOString();
          await env.DB.prepare(`
            UPDATE sequence_enrollments 
            SET current_step = current_step + 1, next_send_at = ?
            WHERE id = ?
          `).bind(nextSendAt, enrollment.enrollment_id).run();
        } else {
          // Sequence complete
          await env.DB.prepare(`
            UPDATE sequence_enrollments 
            SET status = 'completed', completed_at = datetime('now'), current_step = current_step + 1
            WHERE id = ?
          `).bind(enrollment.enrollment_id).run();
        }
      } catch (error) {
        console.error('Sequence email failed:', enrollment.enrollment_id, error);
      }
    }
  } catch (error) {
    console.error('Process sequence emails error:', error);
  }
}

async function processScheduledCampaigns(env) {
  try {
    const due = await env.DB.prepare(`
      SELECT id FROM emails 
      WHERE status = 'scheduled' AND scheduled_at <= datetime('now')
    `).all();
    
    if (!due.results || due.results.length === 0) return;
    
    for (const campaign of due.results) {
      try {
        // Create a mock request for the send handler
        const response = await handleSendEmail(campaign.id, null, env);
        console.log('Scheduled campaign sent:', campaign.id);
      } catch (error) {
        console.error('Scheduled campaign failed:', campaign.id, error);
      }
    }
  } catch (error) {
    console.error('Process scheduled campaigns error:', error);
  }
}
