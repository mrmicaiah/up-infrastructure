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
 *   Requires COURIER_API_KEY secret to be set
 * 
 * GitHub Publishing (11ty):
 *   Posts are pushed as markdown files with frontmatter to src/posts/[slug].md
 *   GitHub Actions builds the site with 11ty and deploys to GitHub Pages
 * 
 * Admin Endpoints:
 *   POST /admin/register - Register a new blog (requires ADMIN_API_KEY)
 *   GET /admin/blogs - List all registered blogs (requires ADMIN_API_KEY)
 *   PUT /admin/config/:blogId - Update blog config (requires ADMIN_API_KEY)
 * 
 * Last updated: 2026-02-19 - Fixed Courier API: use list_id field and add auth header
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
  
  return `
<!DOCTYPE html>
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
  
  // Check for Courier API key
  if (!env.COURIER_API_KEY) {
    console.error(`Cannot send email for "${post.title}" - COURIER_API_KEY not configured`);
    return { sent: false, reason: 'no_courier_api_key' };
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
        'Authorization': `Bearer ${env.COURIER_API_KEY}`
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
        version: '2.3.0',
        courier_configured: !!env.COURIER_API_KEY
      });
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
          
          was