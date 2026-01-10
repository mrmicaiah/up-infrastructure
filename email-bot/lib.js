/**
 * Shared utilities for Email Platform
 */

// ==================== CONSTANTS ====================

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-MTC-Password',
};

export const ALLOWED_ORIGINS = [
  'https://untitledpublishers.com',
  'https://www.untitledpublishers.com',
  'https://proverbs.untitledpublishers.com',
  'https://contractorsparty.com',
  'https://www.contractorsparty.com',
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
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else { current += char; }
  }
  result.push(current.trim());
  return result;
}

// ==================== RESEND EMAIL ====================

export async function sendEmailViaSES(env, to, subject, htmlBody, textBody, fromName, fromEmail) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: (fromName || DEFAULT_FROM_NAME) + ' <' + (fromEmail || DEFAULT_FROM_EMAIL) + '>',
      to: [to],
      subject: subject,
      html: htmlBody,
      text: textBody || undefined
    })
  });
  const result = await response.json();
  if (!response.ok) {
    console.error('Resend Error:', result);
    throw new Error('Resend Error: ' + response.status + ' - ' + (result.message || JSON.stringify(result)));
  }
  return result.id;
}

// ==================== EMAIL RENDERING ====================

function applyMergeTags(html, subscriber) {
  if (!html) return html;
  const firstName = subscriber.name ? subscriber.name.split(' ')[0] : 'Friend';
  const fullName = subscriber.name || 'Friend';
  const email = subscriber.email || '';
  return html
    .replace(/\{first_name\}/g, firstName)
    .replace(/\{name\}/g, fullName)
    .replace(/\{email\}/g, email);
}

export function renderEmail(email, subscriber, sendId, baseUrl, list, template) {
  let contentHtml = email.body_html;
  contentHtml = applyMergeTags(contentHtml, subscriber);
  
  const trackingPixel = '<img src="' + baseUrl + '/t/open?sid=' + sendId + '" width="1" height="1" style="display:none;" alt="">';
  const unsubscribeUrl = baseUrl + '/unsubscribe?sid=' + sendId;
  const fromName = (list && list.from_name) ? list.from_name : DEFAULT_FROM_NAME;
  
  let fullHtml;
  
  if (template && template.body_html) {
    fullHtml = template.body_html;
    fullHtml = fullHtml.replace(/\{content\}/g, contentHtml);
    fullHtml = applyMergeTags(fullHtml, subscriber);
    fullHtml = fullHtml.replace(/\{unsubscribe_url\}/g, unsubscribeUrl);
    fullHtml = fullHtml.replace(/\{from_name\}/g, fromName);
    fullHtml = fullHtml.replace(/\{subject\}/g, email.subject || '');
    if (fullHtml.indexOf('/t/open?sid=') === -1) {
      fullHtml = fullHtml.replace('</body>', trackingPixel + '</body>');
    }
  } else {
    fullHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' + email.subject + '</title></head><body style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 20px; line-height: 1.6;">' + contentHtml + '<hr style="margin-top: 40px; border: none; border-top: 1px solid #ddd;"><p style="font-size: 12px; color: #666; text-align: center;">You are receiving this because you signed up for ' + fromName + '.<br><a href="' + unsubscribeUrl + '" style="color: #666;">Unsubscribe</a></p>' + trackingPixel + '</body></html>';
  }
  
  return fullHtml;
}
