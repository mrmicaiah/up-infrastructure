/**
 * Untitled Publishers Email System API
 * Cloudflare Worker + D1 Database + AWS SES
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

const BEEHIIV_SOURCES = ['proverbs-library'];
const FROM_EMAIL = 'hello@untitledpublishers.com';
const FROM_NAME = 'Untitled Publishers';

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
    
    // Public endpoints
    if (url.pathname === '/api/lead' && request.method === 'POST') {
      return handleLeadCapture(request, env);
    }
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
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

    // Protected endpoints - require auth
    if (url.pathname.startsWith('/api/')) {
      const authResult = checkAuth(request, env);
      if (!authResult.ok) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
    }
    
    // === LEADS (existing) ===
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
      return handleUnsubscribe(id, env);
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

async function sendEmailViaSES(env, to, subject, htmlBody, textBody) {
  const region = env.AWS_REGION || 'us-east-2';
  const endpoint = `https://email.${region}.amazonaws.com/`;
  
  const params = new URLSearchParams();
  params.append('Action', 'SendEmail');
  params.append('Version', '2010-12-01');
  params.append('Source', `${FROM_NAME} <${FROM_EMAIL}>`);
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
  
  // Extract MessageId from XML response
  const messageIdMatch = responseText.match(/<MessageId>(.+?)<\/MessageId>/);
  return messageIdMatch ? messageIdMatch[1] : null;
}

// ==================== EMAIL RENDERING ====================

function renderEmail(email, subscriber, sendId, baseUrl) {
  let html = email.body_html;
  
  // Merge tags
  html = html.replace(/\{first_name\}/g, subscriber.name?.split(' ')[0] || 'Friend');
  html = html.replace(/\{name\}/g, subscriber.name || 'Friend');
  html = html.replace(/\{email\}/g, subscriber.email);
  
  // Wrap in template
  const trackingPixel = `<img src="${baseUrl}/t/open?sid=${sendId}" width="1" height="1" style="display:none;" alt="">`;
  const unsubscribeUrl = `${baseUrl}/unsubscribe?sid=${sendId}`;
  
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
    You're receiving this because you signed up at Untitled Publishers.<br>
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
  
  // Return 1x1 transparent GIF
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
  
  if (sendId) {
    try {
      // Get the lead_id from the send record
      const send = await env.DB.prepare(
        'SELECT lead_id FROM email_sends WHERE id = ?'
      ).bind(sendId).first();
      
      if (send) {
        await env.DB.prepare(
          'UPDATE leads SET unsubscribed_at = ? WHERE id = ?'
        ).bind(new Date().toISOString(), send.lead_id).run();
      }
    } catch (e) {
      console.error('Unsubscribe error:', e);
    }
  }
  
  return new Response(`
    <!DOCTYPE html>
    <html>
    <head><title>Unsubscribed</title></head>
    <body style="font-family: sans-serif; text-align: center; padding: 50px;">
      <h1>You've been unsubscribed</h1>
      <p>You will no longer receive emails from Untitled Publishers.</p>
      <p><a href="https://untitledpublishers.com">Return to website</a></p>
    </body>
    </html>
  `, { headers: { 'Content-Type': 'text/html' } });
}

// ==================== BEEHIIV ====================

async function addBeehiivTags(env, subscriptionId, tags) {
  if (!tags || tags.length === 0) return { success: false, reason: 'no_tags' };
  
  try {
    const response = await fetch(
      `https://api.beehiiv.com/v2/publications/${env.BEEHIIV_PUBLICATION_ID}/subscriptions/${subscriptionId}/tags`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.BEEHIIV_API_KEY}`
        },
        body: JSON.stringify({ tags: tags })
      }
    );

    if (response.ok) {
      return { success: true, tags: tags };
    } else {
      const errorData = await response.json().catch(() => ({}));
      return { success: false, reason: 'api_error', status: response.status, error: errorData };
    }
  } catch (error) {
    return { success: false, reason: 'exception', error: error.message };
  }
}

async function pushToBeehiiv(env, lead) {
  if (!env.BEEHIIV_API_KEY || !env.BEEHIIV_PUBLICATION_ID) {
    return { success: false, reason: 'not_configured' };
  }

  if (!BEEHIIV_SOURCES.includes(lead.source)) {
    return { success: false, reason: 'source_not_synced' };
  }

  try {
    const response = await fetch(
      `https://api.beehiiv.com/v2/publications/${env.BEEHIIV_PUBLICATION_ID}/subscriptions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.BEEHIIV_API_KEY}`
        },
        body: JSON.stringify({
          email: lead.email,
          reactivate_existing: true,
          send_welcome_email: true,
          utm_source: lead.funnel || 'website',
          utm_medium: 'lead-capture',
          utm_campaign: lead.source,
          referring_site: 'https://untitledpublishers.com/'
        })
      }
    );

    if (response.ok) {
      const data = await response.json();
      const subscriptionId = data.data?.id;
      
      const tagsToAdd = [];
      if (lead.segment) tagsToAdd.push(lead.segment);
      if (lead.funnel) tagsToAdd.push(lead.funnel);
      if (lead.source) tagsToAdd.push(lead.source);
      
      let tagsResult = { success: false, reason: 'no_subscription_id' };
      if (subscriptionId && tagsToAdd.length > 0) {
        tagsResult = await addBeehiivTags(env, subscriptionId, tagsToAdd);
      }
      
      return { 
        success: true, 
        subscription_id: subscriptionId,
        tags: tagsResult.success ? tagsToAdd : [],
        tags_status: tagsResult.success ? 'added' : tagsResult.reason
      };
    } else {
      const errorData = await response.json().catch(() => ({}));
      return { success: false, reason: 'api_error', status: response.status, error: errorData };
    }
  } catch (error) {
    return { success: false, reason: 'exception', error: error.message };
  }
}

// ==================== LEAD CAPTURE ====================

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
    }

    const beehiivResult = await pushToBeehiiv(env, lead);

    return jsonResponse({ 
      success: true, 
      message: isNew ? 'Lead captured' : 'Lead updated',
      lead_id: leadId,
      new: isNew,
      beehiiv: beehiivResult.success ? 'synced' : 'skipped',
      beehiiv_tags: beehiivResult.tags || [],
      beehiiv_tags_status: beehiivResult.tags_status || 'n/a'
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

// ==================== LEADS ====================

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

  return jsonResponse({
    total: total?.count || 0,
    by_source: bySource.results,
    by_funnel: byFunnel.results,
    by_segment: bySegment.results,
    last_7_days: last7Days.results,
    emails: emailStats.results
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

  return jsonResponse({
    subscriber,
    email_history: emailHistory.results
  });
}

async function handleUnsubscribe(id, env) {
  const result = await env.DB.prepare(
    'UPDATE leads SET unsubscribed_at = ? WHERE id = ? AND unsubscribed_at IS NULL'
  ).bind(new Date().toISOString(), id).run();

  if (result.meta.changes === 0) {
    return jsonResponse({ error: 'Subscriber not found or already unsubscribed' }, 404);
  }

  return jsonResponse({ success: true, message: 'Unsubscribed' });
}

// ==================== EMAILS ====================

async function handleGetEmails(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

  let query = 'SELECT * FROM emails WHERE 1=1';
  const params = [];

  if (status) { query += ' AND status = ?'; params.push(status); }

  query += ' ORDER BY updated_at DESC LIMIT ?';
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
      INSERT INTO emails (id, title, subject, preview_text, body_html, body_text, segment, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).bind(
      id,
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
    'SELECT * FROM emails WHERE id = ?'
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
        title = COALESCE(?, title),
        subject = COALESCE(?, subject),
        preview_text = COALESCE(?, preview_text),
        body_html = COALESCE(?, body_html),
        body_text = COALESCE(?, body_text),
        segment = COALESCE(?, segment),
        updated_at = ?
      WHERE id = ?
    `).bind(
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
    INSERT INTO emails (id, title, subject, preview_text, body_html, body_text, segment, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).bind(
    newId,
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
  const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(id).first();

  if (!email) {
    return jsonResponse({ error: 'Email not found' }, 404);
  }

  let recipientQuery = 'SELECT COUNT(*) as count FROM leads WHERE unsubscribed_at IS NULL AND (bounce_count IS NULL OR bounce_count < 3)';
  if (email.segment && email.segment !== 'all') {
    recipientQuery += ' AND segment = ?';
  }

  const recipientCount = email.segment && email.segment !== 'all'
    ? await env.DB.prepare(recipientQuery).bind(email.segment).first()
    : await env.DB.prepare(recipientQuery).first();

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

    const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(id).first();

    if (!email) {
      return jsonResponse({ error: 'Email not found' }, 404);
    }

    // Create a fake subscriber for rendering
    const fakeSubscriber = { name: 'Test User', email: testEmail };
    const fakeSendId = 'test-' + generateId();
    const baseUrl = 'https://email-bot-server.micaiah-tasks.workers.dev';
    
    const renderedHtml = renderEmail(email, fakeSubscriber, fakeSendId, baseUrl);
    
    const messageId = await sendEmailViaSES(env, testEmail, `[TEST] ${email.subject}`, renderedHtml, email.body_text);

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
    const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(id).first();

    if (!email) {
      return jsonResponse({ error: 'Email not found' }, 404);
    }

    if (email.status === 'sent') {
      return jsonResponse({ error: 'Email already sent' }, 400);
    }

    // Get active subscribers
    let subscriberQuery = 'SELECT id, email, name FROM leads WHERE unsubscribed_at IS NULL AND (bounce_count IS NULL OR bounce_count < 3)';
    if (email.segment && email.segment !== 'all') {
      subscriberQuery += ' AND segment = ?';
    }

    const subscribers = email.segment && email.segment !== 'all'
      ? await env.DB.prepare(subscriberQuery).bind(email.segment).all()
      : await env.DB.prepare(subscriberQuery).all();

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
        const renderedHtml = renderEmail(email, subscriber, sendId, baseUrl);
        
        const messageId = await sendEmailViaSES(env, subscriber.email, email.subject, renderedHtml, email.body_text);
        
        // Log the send
        await env.DB.prepare(`
          INSERT INTO email_sends (id, email_id, lead_id, ses_message_id, status, created_at)
          VALUES (?, ?, ?, ?, 'sent', ?)
        `).bind(sendId, id, subscriber.id, messageId, new Date().toISOString()).run();
        
        sent++;
      } catch (e) {
        failed++;
        errors.push({ email: subscriber.email, error: e.message });
        console.error(`Failed to send to ${subscriber.email}:`, e);
      }
    }

    // Update email status
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
