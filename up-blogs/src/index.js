/**
 * UP Blogs Worker (Multi-tenant)
 * Powers Untitled Publishers blogs via API.
 * No admin UI - Claude posts via API key authentication.
 * 
 * KV Structure:
 *   blog:{blogId}:apiKey       - API key for auth
 *   blog:{blogId}:posts        - JSON array of all posts
 *   blog:{blogId}:config       - { listId, githubRepo, githubToken, siteColors, template, courierListSlug, ga4Id, facebookPixel }
 *   blog:{blogId}:comments:{postId} - approved comments
 *   blog:{blogId}:comments:pending  - pending comments queue
 *   blog:{blogId}:likes:{postId}    - { count: N, ips: ["hash1", ...] }
 * 
 * Post Data Model:
 *   id, title, content, slug, author, author_id, image, featured_image_alt,
 *   meta_description, status (draft|scheduled|published), scheduled_for,
 *   published_at, date, createdAt, updatedAt, send_email, tags
 * 
 * Cron Trigger:
 *   Runs hourly to check for scheduled posts that are due for publishing
 * 
 * Email Notifications:
 *   When a post is published, sends email to subscribers via Courier API
 *   Uses ADMIN_API_KEY for Courier authentication
 * 
 * GitHub Publishing (11ty):
 *   Posts are pushed as markdown files with frontmatter to src/posts/[slug].md
 *   GitHub Actions builds the site with 11ty and deploys to GitHub Pages
 * 
 * Facebook Lead Ads:
 *   POST /facebook-lead/:list - Receives FB lead webhooks, converts format, forwards to Courier
 * 
 * Admin Endpoints:
 *   POST /admin/register - Register a new blog (requires ADMIN_API_KEY)
 *   GET /admin/blogs - List all registered blogs (requires ADMIN_API_KEY)
 *   PUT /admin/config/:blogId - Update blog config (requires ADMIN_API_KEY)
 * 
 * Last updated: 2026-02-19 - Added Facebook Lead Ads webhook converter
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const COURIER_SUBSCRIBE_URL = 'https://email-bot-server.micaiah-tasks.workers.dev/api/subscribe';
const COURIER_CAMPAIGN_URL = 'https://email-bot-server.micaiah-tasks.workers.dev/api/campaigns';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => chars[byte % chars.length]).join('');
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function hashIP(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateExcerpt(content, maxLength = 200) {
  if (!content) return '';
  
  let text = content
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/{{subscribe}}/g, '')
    .replace(/\n+/g, ' ')
    .trim();
  
  if (text.length <= maxLength) return text;
  
  const truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated) + '...';
}

function markdownToHtml(text) {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  
  html = html.split('\n\n').map(para => {
    para = para.trim();
    if (!para) return '';
    if (para.startsWith('<')) return para;
    return `<p>${para.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  
  return html;
}

function generateEmailHtml(post, config) {
  const siteUrl = config.siteUrl || '';
  const postUrl = `${siteUrl}/${post.slug}/`;
  const primaryColor = config.siteColors?.primary || '#2563eb';
  const siteName = config.siteName || 'Our Blog';
  const excerpt = generateExcerpt(post.content, 300);
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${post.title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:20px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;max-width:100%;">
          <tr>
            <td style="background-color:${primaryColor};padding:24px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600;">${siteName}</h1>
            </td>
          </tr>
          ${post.image ? `
          <tr>
            <td style="padding:0;">
              <img src="${post.image}" alt="${post.featured_image_alt || post.title}" style="width:100%;height:auto;display:block;">
            </td>
          </tr>
          ` : ''}
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 16px 0;font-size:28px;line-height:1.3;color:#1a1a1a;">
                <a href="${postUrl}" style="color:#1a1a1a;text-decoration:none;">${post.title}</a>
              </h2>
              <p style="margin:0 0 8px 0;font-size:14px;color:#666666;">
                By ${post.author || 'Unknown'} • ${new Date(post.published_at || post.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
              </p>
              <p style="margin:24px 0;font-size:16px;line-height:1.6;color:#333333;">
                ${excerpt}
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
                <tr>
                  <td style="background-color:${primaryColor};border-radius:6px;">
                    <a href="${postUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;">
                      Read More →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f9f9f9;padding:24px;text-align:center;border-top:1px solid #eeeeee;">
              <p style="margin:0 0 8px 0;font-size:14px;color:#666666;">
                You're receiving this because you subscribed to ${siteName}.
              </p>
              <p style="margin:0;font-size:12px;color:#999999;">
                <a href="{{{unsubscribe_url}}}" style="color:#999999;">Unsubscribe</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendPublishEmail(post, config, blogId, env) {
  if (post.send_email === false) {
    console.log(`Skipping email for post "${post.title}" - send_email is false`);
    return { sent: false, reason: 'send_email_disabled' };
  }
  
  const listSlug = config.courierListSlug || blogId;
  if (!listSlug) {
    console.log(`Skipping email for post "${post.title}" - no Courier list configured`);
    return { sent: false, reason: 'no_list_configured' };
  }
  
  // Check for API key (used for Courier auth)
  if (!env.ADMIN_API_KEY) {
    console.error(`Cannot send email for "${post.title}" - ADMIN_API_KEY not configured`);
    return { sent: false, reason: 'no_api_key' };
  }
  
  try {
    const emailHtml = generateEmailHtml(post, config);
    
    // Use list_id (not list) per Courier API spec
    const campaignPayload = {
      list_id: listSlug,
      subject: post.title,
      body_html: emailHtml,
      send_now: true
    };
    
    console.log(`Sending email for post "${post.title}" to list "${listSlug}"`);
    
    const response = await fetch(COURIER_CAMPAIGN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.ADMIN_API_KEY}`
      },
      body: JSON.stringify(campaignPayload)
    });
    
    if (response.ok) {
      const result = await response.json().catch(() => ({}));
      console.log(`Email sent successfully for "${post.title}"`, result);
      return { sent: true, result };
    } else {
      const error = await response.text().catch(() => 'Unknown error');
      console.error(`Courier campaign failed for "${post.title}":`, response.status, error);
      return { sent: false, reason: 'courier_error', status: response.status, error };
    }
  } catch (e) {
    console.error(`Email send exception for "${post.title}":`, e);
    return { sent: false, reason: 'exception', error: e.message };
  }
}

/**
 * Extract field value from Facebook Lead Ads field_data array
 * Facebook sends: [{ "name": "email", "values": ["test@example.com"] }, ...]
 */
function extractFacebookField(fieldData, fieldName) {
  if (!Array.isArray(fieldData)) return null;
  const field = fieldData.find(f => f.name === fieldName);
  if (field && Array.isArray(field.values) && field.values.length > 0) {
    return field.values[0];
  }
  return null;
}

/**
 * Handle Facebook Lead Ads webhook
 * Converts Facebook's format to Courier's format and forwards
 */
async function handleFacebookLead(request, listSlug) {
  try {
    const body = await request.json();
    console.log('Facebook Lead webhook received:', JSON.stringify(body).substring(0, 500));
    
    let email = null;
    let name = null;
    
    // Facebook webhook format: { entry: [{ changes: [{ value: { field_data: [...] } }] }] }
    if (body.entry && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        if (entry.changes && Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            const fieldData = change.value?.field_data;
            if (fieldData) {
              email = email || extractFacebookField(fieldData, 'email');
              name = name || extractFacebookField(fieldData, 'full_name') 
                        || extractFacebookField(fieldData, 'first_name');
            }
          }
        }
      }
    }
    
    // Also check for direct/simple format (some integrations send flattened data)
    if (!email && body.email) {
      email = body.email;
    }
    if (!name && (body.full_name || body.name || body.first_name)) {
      name = body.full_name || body.name || body.first_name;
    }
    
    // Check field_data at root level too
    if (!email && body.field_data) {
      email = extractFacebookField(body.field_data, 'email');
      name = name || extractFacebookField(body.field_data, 'full_name')
                  || extractFacebookField(body.field_data, 'first_name');
    }
    
    if (!email) {
      console.error('Facebook Lead: No email found in payload');
      return jsonResponse({ error: 'No email found in payload', received: body }, 400);
    }
    
    // Forward to Courier
    const courierPayload = {
      email,
      list: listSlug,
      source: 'facebook-lead-ads',
      ...(name && { name })
    };
    
    console.log(`Forwarding Facebook lead to Courier: ${email} -> ${listSlug}`);
    
    const courierRes = await fetch(COURIER_SUBSCRIBE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(courierPayload)
    });
    
    if (courierRes.ok) {
      const result = await courierRes.json().catch(() => ({}));
      console.log(`Facebook lead subscribed: ${email} to ${listSlug}`);
      return jsonResponse({ 
        success: true, 
        email,
        name: name || null,
        list: listSlug,
        courier: result 
      });
    } else {
      const error = await courierRes.text().catch(() => 'Unknown error');
      console.error(`Courier subscribe failed for Facebook lead: ${error}`);
      return jsonResponse({ 
        success: false, 
        error: 'Courier subscribe failed',
        details: error 
      }, 500);
    }
    
  } catch (e) {
    console.error('Facebook Lead webhook error:', e);
    return jsonResponse({ error: 'Failed to process webhook', details: e.message }, 500);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    if (path === '/' || path === '/health') {
      return jsonResponse({ 
        status: 'ok', 
        service: 'up-blogs-1', 
        version: '2.4.0',
        courier_configured: !!env.ADMIN_API_KEY
      });
    }
    
    // Facebook Lead Ads webhook converter
    // POST /facebook-lead/:listSlug
    const fbLeadMatch = path.match(/^\/facebook-lead\/([a-z0-9-]+)$/);
    if (fbLeadMatch && request.method === 'POST') {
      const listSlug = fbLeadMatch[1];
      return handleFacebookLead(request, listSlug);
    }
    
    // Facebook webhook verification (GET request with hub.challenge)
    if (fbLeadMatch && request.method === 'GET') {
      const challenge = url.searchParams.get('hub.challenge');
      const verifyToken = url.searchParams.get('hub.verify_token');
      
      // Facebook sends a verification request when setting up the webhook
      // We accept any verify_token for simplicity (the URL itself is the "secret")
      if (challenge) {
        console.log(`Facebook webhook verification for list: ${fbLeadMatch[1]}`);
        return new Response(challenge, { 
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      return jsonResponse({ error: 'Missing hub.challenge' }, 400);
    }
    
    const requireAdminAuth = () => {
      const auth = request.headers.get('Authorization');
      const apiKey = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!apiKey || !env.ADMIN_API_KEY) return false;
      return apiKey === env.ADMIN_API_KEY;
    };
    
    // POST /admin/register
    if (path === '/admin/register' && request.method === 'POST') {
      if (!requireAdminAuth()) {
        return jsonResponse({ error: 'Unauthorized - Admin API key required' }, 401);
      }
      
      try {
        const body = await request.json();
        const {
          blog_id, site_name, site_url, site_description, author_name, author_id,
          courier_list_slug, github_repo, github_token, twitter_handle, favicon,
          default_image, site_colors, publisher_name, publisher_logo, author_url,
          ga4_id, facebook_pixel
        } = body;
        
        if (!blog_id) {
          return jsonResponse({ error: 'blog_id is required' }, 400);
        }
        
        if (!/^[a-z0-9-]+$/.test(blog_id)) {
          return jsonResponse({ error: 'blog_id must be lowercase alphanumeric with hyphens only' }, 400);
        }
        
        const existingKey = await env.BLOGS.get(`blog:${blog_id}:apiKey`);
        if (existingKey) {
          return jsonResponse({ error: 'Blog already exists', blog_id }, 409);
        }
        
        const blogApiKey = generateApiKey();
        
        const config = {
          siteName: site_name || blog_id,
          siteUrl: site_url || null,
          siteDescription: site_description || '',
          authorName: author_name || null,
          authorId: author_id || null,
          authorUrl: author_url || null,
          courierListSlug: courier_list_slug || blog_id,
          githubRepo: github_repo || null,
          githubToken: github_token || null,
          twitterHandle: twitter_handle || null,
          favicon: favicon || null,
          defaultImage: default_image || null,
          siteColors: site_colors || { primary: '#2563eb', lightBg: '#f3f4f6' },
          publisherName: publisher_name || 'Untitled Publishers',
          publisherLogo: publisher_logo || 'https://untitledpublishers.com/logo.png',
          ga4Id: ga4_id || null,
          facebookPixel: facebook_pixel || null,
          createdAt: new Date().toISOString()
        };
        
        await env.BLOGS.put(`blog:${blog_id}:apiKey`, blogApiKey);
        await env.BLOGS.put(`blog:${blog_id}:config`, JSON.stringify(config));
        await env.BLOGS.put(`blog:${blog_id}:posts`, JSON.stringify([]));
        
        console.log(`Blog registered: ${blog_id}`);
        
        return jsonResponse({
          success: true,
          blog_id,
          api_key: blogApiKey,
          message: 'Blog registered successfully. Save this API key - it cannot be retrieved later.'
        }, 201);
        
      } catch (e) {
        console.error('Admin register error:', e);
        return jsonResponse({ error: 'Failed to register blog', details: e.message }, 500);
      }
    }
    
    // PUT /admin/config/:blogId
    if (path.match(/^\/admin\/config\/[a-z0-9-]+$/) && request.method === 'PUT') {
      if (!requireAdminAuth()) {
        return jsonResponse({ error: 'Unauthorized - Admin API key required' }, 401);
      }
      
      try {
        const blogId = path.split('/')[3];
        
        const existingConfig = await env.BLOGS.get(`blog:${blogId}:config`);
        if (!existingConfig) {
          return jsonResponse({ error: 'Blog not found', blog_id: blogId }, 404);
        }
        
        const currentConfig = JSON.parse(existingConfig);
        const body = await request.json();
        
        const {
          site_name, site_url, site_description, author_name, author_id,
          courier_list_slug, github_repo, github_token, twitter_handle, favicon,
          default_image, site_colors, publisher_name, publisher_logo, author_url,
          ga4_id, facebook_pixel
        } = body;
        
        const updatedConfig = {
          ...currentConfig,
          ...(site_name !== undefined && { siteName: site_name }),
          ...(site_url !== undefined && { siteUrl: site_url }),
          ...(site_description !== undefined && { siteDescription: site_description }),
          ...(author_name !== undefined && { authorName: author_name }),
          ...(author_id !== undefined && { authorId: author_id }),
          ...(author_url !== undefined && { authorUrl: author_url }),
          ...(courier_list_slug !== undefined && { courierListSlug: courier_list_slug }),
          ...(github_repo !== undefined && { githubRepo: github_repo }),
          ...(github_token !== undefined && { githubToken: github_token }),
          ...(twitter_handle !== undefined && { twitterHandle: twitter_handle }),
          ...(favicon !== undefined && { favicon: favicon }),
          ...(default_image !== undefined && { defaultImage: default_image }),
          ...(site_colors !== undefined && { siteColors: site_colors }),
          ...(publisher_name !== undefined && { publisherName: publisher_name }),
          ...(publisher_logo !== undefined && { publisherLogo: publisher_logo }),
          ...(ga4_id !== undefined && { ga4Id: ga4_id }),
          ...(facebook_pixel !== undefined && { facebookPixel: facebook_pixel }),
          updatedAt: new Date().toISOString()
        };
        
        await env.BLOGS.put(`blog:${blogId}:config`, JSON.stringify(updatedConfig));
        
        console.log(`Blog config updated: ${blogId}`);
        
        return jsonResponse({
          success: true,
          blog_id: blogId,
          config: updatedConfig,
          message: 'Blog config updated successfully'
        });
        
      } catch (e) {
        console.error('Admin update config error:', e);
        return jsonResponse({ error: 'Failed to update config', details: e.message }, 500);
      }
    }
    
    // GET /admin/config/:blogId
    if (path.match(/^\/admin\/config\/[a-z0-9-]+$/) && request.method === 'GET') {
      if (!requireAdminAuth()) {
        return jsonResponse({ error: 'Unauthorized - Admin API key required' }, 401);
      }
      
      try {
        const blogId = path.split('/')[3];
        
        const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
        if (!configJson) {
          return jsonResponse({ error: 'Blog not found', blog_id: blogId }, 404);
        }
        
        const config = JSON.parse(configJson);
        
        const safeConfig = {
          ...config,
          githubToken: config.githubToken ? '***masked***' : null
        };
        
        return jsonResponse({
          blog_id: blogId,
          config: safeConfig
        });
        
      } catch (e) {
        console.error('Admin get config error:', e);
        return jsonResponse({ error: 'Failed to get config', details: e.message }, 500);
      }
    }
    
    // GET /admin/blogs
    if (path === '/admin/blogs' && request.method === 'GET') {
      if (!requireAdminAuth()) {
        return jsonResponse({ error: 'Unauthorized - Admin API key required' }, 401);
      }
      
      try {
        const blogs = [];
        
        const listResult = await env.BLOGS.list({ prefix: 'blog:' });
        const configKeys = listResult.keys.filter(k => k.name.endsWith(':config'));
        
        for (const key of configKeys) {
          const parts = key.name.split(':');
          if (parts.length !== 3) continue;
          const blogId = parts[1];
          
          const configJson = await env.BLOGS.get(key.name);
          if (!configJson) continue;
          
          const config = JSON.parse(configJson);
          
          const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
          const posts = postsJson ? JSON.parse(postsJson) : [];
          const publishedPosts = posts.filter(p => p.status === 'published' || p.published);
          const draftPosts = posts.filter(p => p.status === 'draft');
          const scheduledPosts = posts.filter(p => p.status === 'scheduled');
          
          blogs.push({
            id: blogId,
            name: config.siteName || blogId,
            siteUrl: config.siteUrl || null,
            authorId: config.authorId || null,
            authorName: config.authorName || null,
            courierListSlug: config.courierListSlug || null,
            githubRepo: config.githubRepo || null,
            hasGithubToken: !!config.githubToken,
            ga4Id: config.ga4Id || null,
            facebookPixel: config.facebookPixel || null,
            createdAt: config.createdAt || null,
            postCounts: {
              published: publishedPosts.length,
              draft: draftPosts.length,
              scheduled: scheduledPosts.length,
              total: posts.length
            }
          });
        }
        
        blogs.sort((a, b) => a.name.localeCompare(b.name));
        
        return jsonResponse({ blogs, total: blogs.length });
        
      } catch (e) {
        console.error('Admin list blogs error:', e);
        return jsonResponse({ error: 'Failed to list blogs', details: e.message }, 500);
      }
    }
    
    // GET /blogs (public)
    if (path === '/blogs' && request.method === 'GET') {
      try {
        const blogs = [];
        
        const listResult = await env.BLOGS.list({ prefix: 'blog:' });
        const configKeys = listResult.keys.filter(k => k.name.endsWith(':config'));
        
        for (const key of configKeys) {
          const parts = key.name.split(':');
          if (parts.length !== 3) continue;
          const blogId = parts[1];
          
          const configJson = await env.BLOGS.get(key.name);
          if (!configJson) continue;
          
          const config = JSON.parse(configJson);
          
          const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
          const posts = postsJson ? JSON.parse(postsJson) : [];
          const publishedPosts = posts.filter(p => p.status === 'published' || p.published);
          
          blogs.push({
            id: blogId,
            name: config.siteName || blogId,
            slug: blogId,
            siteUrl: config.siteUrl || null,
            authorId: config.authorId || null,
            authorName: config.authorName || null,
            postCount: publishedPosts.length
          });
        }
        
        blogs.sort((a, b) => a.name.localeCompare(b.name));
        
        return jsonResponse({ blogs });
      } catch (e) {
        console.error('Error listing blogs:', e);
        return jsonResponse({ error: 'Failed to list blogs', details: e.message }, 500);
      }
    }
    
    // Parse /:blogId/... routes
    const match = path.match(/^\/([a-z0-9-]+)\/(.*)$/);
    if (!match) {
      return jsonResponse({ error: 'Invalid path' }, 404);
    }
    
    const [, blogId, route] = match;
    
    const getApiKey = () => {
      const auth = request.headers.get('Authorization');
      return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    };
    
    const requireAuth = async () => {
      const apiKey = getApiKey();
      if (!apiKey) return false;
      const storedKey = await env.BLOGS.get(`blog:${blogId}:apiKey`);
      return apiKey === storedKey;
    };
    
    try {
      // POST /:blogId/posts - Create/update post
      if (route === 'posts' && request.method === 'POST') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const body = await request.json();
        const {
          id,
          title,
          content,
          image,
          featured_image_alt,
          author,
          author_id,
          meta_description,
          scheduled_for,
          published_at: requestedPublishedAt,
          status: requestedStatus,
          send_email = true,
          tags = []
        } = body;
        
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        let posts = postsJson ? JSON.parse(postsJson) : [];
        
        const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
        const config = configJson ? JSON.parse(configJson) : {};
        
        const now = new Date();
        const nowIso = now.toISOString();
        
        // Determine status
        let status;
        let shouldPublish = false;
        
        if (requestedStatus === 'draft') {
          status = 'draft';
        } else if (scheduled_for) {
          const scheduledDate = new Date(scheduled_for);
          if (scheduledDate <= now) {
            status = 'published';
            shouldPublish = true;
          } else {
            status = 'scheduled';
          }
        } else if (requestedStatus === 'published' || !requestedStatus) {
          status = 'published';
          shouldPublish = true;
        } else {
          status = requestedStatus;
        }
        
        let post;
        let wasAlreadyPublished = false;
        let previousSlug = null;
        let dateChanged = false;
        
        if (id) {
          // Update existing post
          const idx = posts.findIndex(p => p.id === id);
          if (idx === -1) {
            return jsonResponse({ error: 'Post not found' }, 404);
          }
          
          wasAlreadyPublished = posts[idx].status === 'published' || posts[idx].published;
          previousSlug = posts[idx].slug;
          
          if (requestedPublishedAt && requestedPublishedAt !== posts[idx].published_at) {
            dateChanged = true;
          }
          
          post = {
            ...posts[idx],
            title: title ?? posts[idx].title,
            content: content ?? posts[idx].content,
            image: image ?? posts[idx].image,
            featured_image_alt: featured_image_alt ?? posts[idx].featured_image_alt,
            author: author ?? posts[idx].author,
            author_id: author_id ?? posts[idx].author_id,
            meta_description: meta_description ?? posts[idx].meta_description,
            scheduled_for: scheduled_for ?? posts[idx].scheduled_for,
            tags: tags.length > 0 ? tags : (posts[idx].tags || []),
            status,
            send_email: send_email ?? posts[idx].send_email ?? true,
            updatedAt: nowIso
          };
          
          if (requestedPublishedAt !== undefined) {
            post.published_at = requestedPublishedAt;
            post.date = requestedPublishedAt;
          } else if (status === 'published' && !wasAlreadyPublished) {
            post.published_at = nowIso;
            post.date = nowIso;
          }
          
          if (title && title !== posts[idx].title) {
            post.slug = slugify(title);
          }
          
          if (wasAlreadyPublished && status === 'draft') {
            if (config.githubRepo && config.githubToken) {
              try {
                await unpublishFromGitHub(previousSlug, config);
                console.log(`Unpublished from GitHub: ${previousSlug}`);
              } catch (e) {
                console.error('GitHub unpublish error:', e);
              }
            }
          }
          
          posts[idx] = post;
        } else {
          // Create new post
          const publishedAt = requestedPublishedAt || (status === 'published' ? nowIso : null);
          
          post = {
            id: generateId(),
            title,
            content,
            image: image || null,
            featured_image_alt: featured_image_alt || null,
            author: author || config.authorName || 'Untitled Publishers',
            author_id: author_id || config.authorId || null,
            meta_description: meta_description || null,
            slug: slugify(title),
            status,
            scheduled_for: scheduled_for || null,
            tags: tags || [],
            published_at: publishedAt,
            date: publishedAt,
            published: status === 'published',
            send_email: send_email,
            createdAt: nowIso,
            updatedAt: nowIso
          };
          posts.push(post);
        }
        
        await env.BLOGS.put(`blog:${blogId}:posts`, JSON.stringify(posts));
        
        let emailResult = null;
        let githubResult = null;
        
        if (shouldPublish && !wasAlreadyPublished) {
          if (config.githubRepo && config.githubToken) {
            try {
              await publishToGitHub(post, config);
              githubResult = { pushed: true, path: `src/posts/${post.slug}.md` };
            } catch (e) {
              console.error('GitHub publish error:', e);
              githubResult = { pushed: false, error: e.message };
            }
          }
          
          emailResult = await sendPublishEmail(post, config, blogId, env);
        } else if (wasAlreadyPublished && (shouldPublish || dateChanged)) {
          if (config.githubRepo && config.githubToken) {
            try {
              if (previousSlug && previousSlug !== post.slug) {
                await unpublishFromGitHub(previousSlug, config);
              }
              await publishToGitHub(post, config);
              githubResult = { pushed: true, path: `src/posts/${post.slug}.md`, updated: true, dateChanged };
            } catch (e) {
              console.error('GitHub update error:', e);
              githubResult = { pushed: false, error: e.message };
            }
          }
        }
        
        return jsonResponse({ 
          success: true, 
          post,
          published: shouldPublish && !wasAlreadyPublished,
          dateChanged,
          github: githubResult,
          email: emailResult
        });
      }
      
      // GET /:blogId/posts
      if (route === 'posts' && request.method === 'GET') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        let posts = postsJson ? JSON.parse(postsJson) : [];
        
        const statusFilter = url.searchParams.get('status');
        const limit = parseInt(url.searchParams.get('limit')) || null;
        const fieldsParam = url.searchParams.get('fields');
        const excerptLength = parseInt(url.searchParams.get('excerpt_length')) || 200;
        
        if (statusFilter) {
          posts = posts.filter(p => {
            if (statusFilter === 'published') {
              return p.status === 'published' || p.published === true;
            }
            return p.status === statusFilter;
          });
        }
        
        posts.sort((a, b) => {
          const dateA = new Date(a.published_at || a.date || a.createdAt);
          const dateB = new Date(b.published_at || b.date || b.createdAt);
          return dateB - dateA;
        });
        
        if (limit && limit > 0) {
          posts = posts.slice(0, limit);
        }
        
        if (fieldsParam) {
          const requestedFields = fieldsParam.split(',').map(f => f.trim());
          
          posts = posts.map(post => {
            const result = {};
            
            for (const field of requestedFields) {
              if (field === 'excerpt') {
                result.excerpt = generateExcerpt(post.content, excerptLength);
              } else if (field === 'tags') {
                result.tags = post.tags || [];
              } else if (post[field] !== undefined) {
                result[field] = post[field];
              }
            }
            
            return result;
          });
        } else {
          posts = posts.map(post => ({
            ...post,
            excerpt: generateExcerpt(post.content, excerptLength),
            tags: post.tags || []
          }));
        }
        
        return jsonResponse({ posts });
      }
      
      // GET /:blogId/posts/:slugOrId
      if (route.startsWith('posts/') && route.split('/').length === 2 && request.method === 'GET') {
        const routeParts = route.split('/');
        if (routeParts[1] === 'like' || routeParts[1] === 'likes') {
          // Fall through to public endpoints
        } else {
          if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
          
          const slugOrId = routeParts[1];
          const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
          const posts = postsJson ? JSON.parse(postsJson) : [];
          
          let post = posts.find(p => p.slug === slugOrId);
          if (!post) {
            post = posts.find(p => p.id === slugOrId);
          }
          
          if (!post) {
            return jsonResponse({ error: 'Post not found' }, 404);
          }
          
          const excerpt = generateExcerpt(post.content, 200);
          
          return jsonResponse({
            post: {
              ...post,
              excerpt,
              tags: post.tags || []
            }
          });
        }
      }
      
      // DELETE /:blogId/posts/:postId
      if (route.startsWith('posts/') && route.split('/').length === 2 && request.method === 'DELETE') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const postId = route.split('/')[1];
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        let posts = postsJson ? JSON.parse(postsJson) : [];
        
        const idx = posts.findIndex(p => p.id === postId);
        if (idx === -1) {
          return jsonResponse({ error: 'Post not found' }, 404);
        }
        
        const deletedPost = posts[idx];
        posts.splice(idx, 1);
        await env.BLOGS.put(`blog:${blogId}:posts`, JSON.stringify(posts));
        
        let githubResult = null;
        if (deletedPost.status === 'published' || deletedPost.published) {
          const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
          const config = configJson ? JSON.parse(configJson) : {};
          
          if (config.githubRepo && config.githubToken) {
            try {
              await unpublishFromGitHub(deletedPost.slug, config);
              githubResult = { removed: true, path: `src/posts/${deletedPost.slug}.md` };
              console.log(`Deleted from GitHub: ${deletedPost.slug}`);
            } catch (e) {
              console.error('GitHub delete error:', e);
              githubResult = { removed: false, error: e.message };
            }
          }
        }
        
        return jsonResponse({ success: true, github: githubResult });
      }
      
      // GET /:blogId/comments/pending
      if (route === 'comments/pending' && request.method === 'GET') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const pendingJson = await env.BLOGS.get(`blog:${blogId}:comments:pending`);
        const pending = pendingJson ? JSON.parse(pendingJson) : [];
        
        return jsonResponse({ comments: pending });
      }
      
      // POST /:blogId/comments/:commentId/approve
      if (route.match(/^comments\/[^/]+\/approve$/) && request.method === 'POST') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const commentId = route.split('/')[1];
        
        const pendingJson = await env.BLOGS.get(`blog:${blogId}:comments:pending`);
        let pending = pendingJson ? JSON.parse(pendingJson) : [];
        
        const idx = pending.findIndex(c => c.id === commentId);
        if (idx === -1) {
          return jsonResponse({ error: 'Comment not found' }, 404);
        }
        
        const comment = pending[idx];
        pending.splice(idx, 1);
        await env.BLOGS.put(`blog:${blogId}:comments:pending`, JSON.stringify(pending));
        
        const postCommentsKey = `blog:${blogId}:comments:${comment.postId}`;
        const approvedJson = await env.BLOGS.get(postCommentsKey);
        const approved = approvedJson ? JSON.parse(approvedJson) : [];
        comment.approved = true;
        comment.approvedAt = new Date().toISOString();
        approved.push(comment);
        await env.BLOGS.put(postCommentsKey, JSON.stringify(approved));
        
        return jsonResponse({ success: true });
      }
      
      // POST /:blogId/comments/:commentId/reject
      if (route.match(/^comments\/[^/]+\/reject$/) && request.method === 'POST') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const commentId = route.split('/')[1];
        
        const pendingJson = await env.BLOGS.get(`blog:${blogId}:comments:pending`);
        let pending = pendingJson ? JSON.parse(pendingJson) : [];
        
        const idx = pending.findIndex(c => c.id === commentId);
        if (idx === -1) {
          return jsonResponse({ error: 'Comment not found' }, 404);
        }
        
        pending.splice(idx, 1);
        await env.BLOGS.put(`blog:${blogId}:comments:pending`, JSON.stringify(pending));
        
        return jsonResponse({ success: true });
      }
      
      // PUBLIC ENDPOINTS
      
      // POST /:blogId/posts/:postId/like
      if (route.match(/^posts\/[^/]+\/like$/) && request.method === 'POST') {
        const postId = route.split('/')[1];
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const ipHash = await hashIP(ip + postId);
        
        const likesKey = `blog:${blogId}:likes:${postId}`;
        const likesJson = await env.BLOGS.get(likesKey);
        let likes = likesJson ? JSON.parse(likesJson) : { count: 0, ips: [] };
        
        if (!likes.ips.includes(ipHash)) {
          likes.count++;
          likes.ips.push(ipHash);
          if (likes.ips.length > 1000) likes.ips = likes.ips.slice(-1000);
          await env.BLOGS.put(likesKey, JSON.stringify(likes));
        }
        
        return jsonResponse({ success: true, count: likes.count });
      }
      
      // GET /:blogId/posts/:postId/likes
      if (route.match(/^posts\/[^/]+\/likes$/) && request.method === 'GET') {
        const postId = route.split('/')[1];
        const likesJson = await env.BLOGS.get(`blog:${blogId}:likes:${postId}`);
        const likes = likesJson ? JSON.parse(likesJson) : { count: 0 };
        return jsonResponse({ count: likes.count });
      }
      
      // POST /:blogId/subscribe
      if (route === 'subscribe' && request.method === 'POST') {
        let email, honeypot;
        
        const contentType = request.headers.get('Content-Type') || '';
        if (contentType.includes('application/json')) {
          const body = await request.json();
          email = body.email;
          honeypot = body.website;
        } else {
          const formData = await request.formData();
          email = formData.get('email');
          honeypot = formData.get('website');
        }
        
        if (honeypot) {
          return jsonResponse({ success: true });
        }
        
        if (!email || !email.includes('@')) {
          return jsonResponse({ error: 'Invalid email' }, 400);
        }
        
        const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
        const config = configJson ? JSON.parse(configJson) : {};
        
        const subsJson = await env.BLOGS.get(`blog:${blogId}:subscribers`) || '[]';
        const subs = JSON.parse(subsJson);
        if (!subs.includes(email)) {
          subs.push(email);
          await env.BLOGS.put(`blog:${blogId}:subscribers`, JSON.stringify(subs));
        }
        
        let courierSuccess = false;
        let courierError = null;
        
        try {
          const courierPayload = {
            email,
            list: config.courierListSlug || blogId,
            source: `blog:${blogId}`
          };
          
          const courierRes = await fetch(COURIER_SUBSCRIBE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(courierPayload)
          });
          
          if (courierRes.ok) {
            courierSuccess = true;
          } else {
            const errorData = await courierRes.json().catch(() => ({}));
            courierError = errorData.error || `Courier API returned ${courierRes.status}`;
            console.error('Courier subscribe error:', courierError);
          }
        } catch (e) {
          courierError = e.message;
          console.error('Courier subscribe exception:', e);
        }
        
        const referer = request.headers.get('Referer');
        if (referer && !contentType.includes('application/json')) {
          return Response.redirect(referer + '?subscribed=true', 302);
        }
        
        return jsonResponse({ 
          success: true,
          courier: courierSuccess,
          ...(courierError && { courierError })
        });
      }
      
      // POST /:blogId/comments
      if (route === 'comments' && request.method === 'POST') {
        const { postId, name, email, content, website, captchaAnswer, captchaExpected } = await request.json();
        
        if (website) {
          return jsonResponse({ success: true });
        }
        
        if (captchaExpected && captchaAnswer !== captchaExpected) {
          return jsonResponse({ error: 'Incorrect answer' }, 400);
        }
        
        if (!postId || !name || !content) {
          return jsonResponse({ error: 'Missing required fields' }, 400);
        }
        
        const comment = {
          id: generateId(),
          postId,
          name,
          email,
          content,
          createdAt: new Date().toISOString()
        };
        
        const pendingJson = await env.BLOGS.get(`blog:${blogId}:comments:pending`);
        const pending = pendingJson ? JSON.parse(pendingJson) : [];
        pending.push(comment);
        await env.BLOGS.put(`blog:${blogId}:comments:pending`, JSON.stringify(pending));
        
        return jsonResponse({ success: true, message: 'Comment submitted for review' });
      }
      
      // GET /:blogId/comments/:postId
      if (route.startsWith('comments/') && request.method === 'GET') {
        const postId = route.split('/')[1];
        
        if (postId === 'pending') {
          return jsonResponse({ error: 'Unauthorized' }, 401);
        }
        
        const commentsJson = await env.BLOGS.get(`blog:${blogId}:comments:${postId}`);
        const comments = commentsJson ? JSON.parse(commentsJson) : [];
        
        const publicComments = comments.map(({ email, ...rest }) => rest);
        
        return jsonResponse({ comments: publicComments });
      }
      
      return jsonResponse({ error: 'Not found' }, 404);
      
    } catch (e) {
      console.error('Error:', e);
      return jsonResponse({ error: 'Internal error', details: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    console.log('Cron triggered at:', new Date().toISOString());
    
    try {
      const listResult = await env.BLOGS.list({ prefix: 'blog:' });
      const blogIds = [...new Set(
        listResult.keys
          .map(k => k.name.match(/^blog:([^:]+):config$/)?.[1])
          .filter(Boolean)
      )];
      
      const now = new Date();
      let totalPublished = 0;
      let totalEmails = 0;
      
      for (const blogId of blogIds) {
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        if (!postsJson) continue;
        
        let posts = JSON.parse(postsJson);
        let updated = false;
        const postsToPublish = [];
        
        for (const post of posts) {
          if (post.status === 'scheduled' && post.scheduled_for) {
            const scheduledDate = new Date(post.scheduled_for);
            if (scheduledDate <= now) {
              post.status = 'published';
              post.published_at = post.scheduled_for;
              post.date = post.scheduled_for;
              post.published = true;
              updated = true;
              postsToPublish.push(post);
              totalPublished++;
              console.log(`Publishing scheduled post: ${post.title} (${blogId}) with date ${post.scheduled_for}`);
            }
          }
        }
        
        if (updated) {
          await env.BLOGS.put(`blog:${blogId}:posts`, JSON.stringify(posts));
          
          const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
          const config = configJson ? JSON.parse(configJson) : {};
          
          for (const post of postsToPublish) {
            if (config.githubRepo && config.githubToken) {
              try {
                await publishToGitHub(post, config);
                console.log(`GitHub push successful: src/posts/${post.slug}.md`);
              } catch (e) {
                console.error(`GitHub push failed for ${post.slug}:`, e);
              }
            }
            
            const emailResult = await sendPublishEmail(post, config, blogId, env);
            if (emailResult.sent) {
              totalEmails++;
            }
          }
        }
      }
      
      console.log(`Cron complete. Published ${totalPublished} posts, sent ${totalEmails} emails.`);
    } catch (e) {
      console.error('Cron error:', e);
    }
  }
};

async function publishToGitHub(post, config) {
  const { githubRepo, githubToken } = config;
  const [owner, repo] = githubRepo.split('/');
  
  const publishDate = post.published_at || post.date || new Date().toISOString();
  const dateStr = publishDate.split('T')[0];
  
  const frontmatter = [
    '---',
    `title: "${escapeYaml(post.title)}"`,
    `date: ${dateStr}`,
  ];
  
  const excerpt = post.meta_description || generateExcerpt(post.content, 200);
  if (excerpt) {
    frontmatter.push(`excerpt: "${escapeYaml(excerpt)}"`);
  }
  
  if (post.image) {
    frontmatter.push(`image: ${post.image}`);
  }
  
  if (post.featured_image_alt) {
    frontmatter.push(`imageAlt: "${escapeYaml(post.featured_image_alt)}"`);
  }
  
  const authorName = post.author || config.authorName || 'Untitled Publishers';
  frontmatter.push(`author: ${authorName}`);
  
  if (post.tags && post.tags.length > 0) {
    frontmatter.push('tags:');
    for (const tag of post.tags) {
      frontmatter.push(`  - ${tag}`);
    }
  }
  
  frontmatter.push('---');
  
  const markdown = frontmatter.join('\n') + '\n\n' + (post.content || '');
  
  await pushToGitHub(owner, repo, `src/posts/${post.slug}.md`, markdown, githubToken);
}

async function unpublishFromGitHub(slug, config) {
  const { githubRepo, githubToken } = config;
  const [owner, repo] = githubRepo.split('/');
  
  await deleteFromGitHub(owner, repo, `src/posts/${slug}.md`, githubToken);
}

function escapeYaml(text) {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ');
}

async function pushToGitHub(owner, repo, path, content, token) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  
  let sha;
  try {
    const getRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'up-blogs-worker'
      }
    });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }
  } catch (e) {}
  
  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'up-blogs-worker',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: `Publish: ${path}`,
      content: btoa(unescape(encodeURIComponent(content))),
      sha
    })
  });
  
  if (!res.ok) {
    throw new Error(`GitHub push failed: ${res.status}`);
  }
}

async function deleteFromGitHub(owner, repo, path, token) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  
  let sha;
  try {
    const getRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'up-blogs-worker'
      }
    });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    } else if (getRes.status === 404) {
      console.log(`File not found on GitHub, skipping delete: ${path}`);
      return;
    }
  } catch (e) {
    console.error(`Error checking file on GitHub: ${path}`, e);
    return;
  }
  
  if (!sha) return;
  
  const res = await fetch(apiUrl, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'up-blogs-worker',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: `Unpublish: ${path}`,
      sha
    })
  });
  
  if (!res.ok) {
    throw new Error(`GitHub delete failed: ${res.status}`);
  }
}
