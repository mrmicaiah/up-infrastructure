/**
 * Shared utilities for Email Platform
 */

// ==================== CONSTANTS ====================

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export const ALLOWED_ORIGINS = [
  'https://untitledpublishers.com',
  'https://www.untitledpublishers.com',
  'https://proverbs.untitledpublishers.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
];

export const DEFAULT_FROM_EMAIL = 'no-reply@untitledpublishers.com';
export const DEFAULT_FROM_NAME = 'Untitled Publishers';

// ==================== AUTH ====================

export function checkAuth(request, env) {
  if (!env.ADMIN_API_KEY) return { ok: true };
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return { ok: false };
  return { ok: authHeader.slice(7) === env.ADMIN_API_KEY };
}

export function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = { ...CORS_HEADERS };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// ==================== HELPERS ====================

export function generateId() {
  return crypto.randomUUID();
}

export function generateSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

export function jsonResponse(data, status = 200, request = null) {
  const headers = request ? getCorsHeaders(request) : CORS_HEADERS;
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

export function isValidEmail(email) {
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isDisposableEmail(email) {
  const disposableDomains = [
    'tempmail.com', 'throwaway.email', 'guerrillamail.com', 
    'mailinator.com', '10minutemail.com', 'temp-mail.org',
    'fakeinbox.com', 'trashmail.com', 'yopmail.com'
  ];
  const domain = email.split('@')[1]?.toLowerCase();
  return disposableDomains.includes(domain);
}

export function sanitizeString(str, maxLength = 100) {
  if (!str || typeof str !== 'string') return null;
  return str.trim().slice(0, maxLength).replace(/[<>]/g, '');
}

export function parseCSVLine(line) {
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

// ==================== AWS SES ====================

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

export async function sendEmailViaSES(env, to, subject, htmlBody, textBody, fromName, fromEmail) {
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

export function renderEmail(email, subscriber, sendId, baseUrl, list) {
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
