/**
 * UP Blogs Worker (Multi-tenant)
 * Powers Untitled Publishers blogs via API.
 * No admin UI - Claude posts via API key authentication.
 * 
 * KV Structure:
 *   blog:{blogId}:apiKey       - API key for auth
 *   blog:{blogId}:posts        - JSON array of all posts
 *   blog:{blogId}:config       - { siteName, siteUrl, authorName, ... }
 *   blog:{blogId}:comments:{postId} - approved comments
 *   blog:{blogId}:comments:pending  - pending comments queue
 *   blog:{blogId}:likes:{postId}    - { count: N, ips: ["hash1", ...] }
 *   blog:{blogId}:subscribers       - backup subscriber list
 * 
 * Admin Endpoints (require ADMIN_API_KEY):
 *   POST /admin/register              - Register new blog
 *   GET  /admin/blogs                 - List all blogs with stats
 *   PUT  /admin/blogs/:blogId         - Update blog config
 *   POST /admin/blogs/:blogId/rotate-key - Regenerate API key
 *   DELETE /admin/blogs/:blogId       - Delete blog
 * 
 * Last updated: 2026-01-29 - Added admin registration endpoints
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
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeXml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  let text = content.replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/_(.+?)_/g, '$1').replace(/\[(.+?)\]\(.+?\)/g, '$1').replace(/^[-*]\s+/gm, '').replace(/{{subscribe}}/g, '').replace(/\n+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated) + '...';
}

function markdownToHtml(text) {
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function generateSubscribeForm(blogId, config, workerUrl) {
  const primaryColor = config.siteColors?.primary || '#2563eb';
  const lightBg = config.siteColors?.lightBg || '#f3f4f6';
  return `<div class="blog-subscribe-embed" style="text-align:center;margin:2rem 0;padding:2rem;background:${lightBg};border-radius:8px;"><p style="margin-bottom:1rem;font-size:1.1rem;">Get new posts delivered to your inbox</p><form action="${workerUrl}/${blogId}/subscribe" method="POST" style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;"><input type="email" name="email" placeholder="your@email.com" required style="padding:0.75rem 1rem;border:1px solid #ddd;border-radius:4px;font-size:1rem;"><input type="text" name="website" style="position:absolute;left:-9999px;" tabindex="-1" autocomplete="off"><button type="submit" style="padding:0.75rem 1.5rem;background:${primaryColor};color:white;border:none;border-radius:4px;font-size:1rem;cursor:pointer;">Subscribe</button></form></div>`;
}

function generatePostPage(post, config, blogId, workerUrl) {
  const siteUrl = config.siteUrl || `https://${blogId}.com`;
  const siteName = config.siteName || 'Blog';
  const canonicalUrl = `${siteUrl}/blog/${post.slug}.html`;
  const metaDescription = escapeHtml(post.meta_description || generateExcerpt(post.content, 160));
  const publishedAt = post.published_at || post.date || post.createdAt;
  const updatedAt = post.updatedAt || publishedAt;
  const authorName = escapeHtml(post.author || 'Unknown');
  const authorUrl = config.authorUrl || siteUrl;
  const featuredImage = post.image || config.defaultImage || '';
  const featuredImageAlt = escapeHtml(post.featured_image_alt || post.title);
  const primaryColor = config.siteColors?.primary || '#2563eb';
  let postHtml = markdownToHtml(post.content);
  postHtml = postHtml.replace(/{{subscribe}}/g, generateSubscribeForm(blogId, config, workerUrl));
  const schemaJson = JSON.stringify({"@context":"https://schema.org","@type":"BlogPosting","headline":post.title,"image":featuredImage||undefined,"datePublished":publishedAt,"dateModified":updatedAt,"author":{"@type":"Person","name":post.author||'Unknown',"url":authorUrl},"publisher":{"@type":"Organization","name":config.publisherName||"Untitled Publishers","logo":{"@type":"ImageObject","url":config.publisherLogo||"https://untitledpublishers.com/logo.png"}},"description":post.meta_description||generateExcerpt(post.content,160),"mainEntityOfPage":canonicalUrl});
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(post.title)} | ${escapeHtml(siteName)}</title><meta name="description" content="${metaDescription}"><link rel="canonical" href="${canonicalUrl}"><meta property="og:type" content="article"><meta property="og:title" content="${escapeHtml(post.title)}"><meta property="og:description" content="${metaDescription}">${featuredImage?`<meta property="og:image" content="${featuredImage}">`:''}<meta property="og:url" content="${canonicalUrl}"><meta property="og:site_name" content="${escapeHtml(siteName)}"><meta property="article:published_time" content="${publishedAt}"><meta property="article:modified_time" content="${updatedAt}"><meta property="article:author" content="${authorName}">${(post.tags||[]).map(tag=>`<meta property="article:tag" content="${escapeHtml(tag)}">`).join('')}<meta name="twitter:card" content="${featuredImage?'summary_large_image':'summary'}"><meta name="twitter:title" content="${escapeHtml(post.title)}"><meta name="twitter:description" content="${metaDescription}">${featuredImage?`<meta name="twitter:image" content="${featuredImage}"><meta name="twitter:image:alt" content="${featuredImageAlt}">`:''} ${config.twitterHandle?`<meta name="twitter:site" content="${config.twitterHandle}">`:''}
<script type="application/ld+json">${schemaJson}</script><link rel="alternate" type="application/rss+xml" title="${escapeHtml(siteName)} RSS" href="${siteUrl}/blog/feed.xml">${config.favicon?`<link rel="icon" href="${config.favicon}">`:''}
<style>*{box-sizing:border-box}body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;line-height:1.6;color:#1a1a1a;background:#fff}.container{max-width:720px;margin:0 auto;padding:2rem 1rem}header{margin-bottom:2rem;padding-bottom:1rem;border-bottom:1px solid #eee}header a{color:${primaryColor};text-decoration:none;font-weight:600}h1{font-size:2.5rem;line-height:1.2;margin:0 0 1rem 0}.meta{color:#666;font-size:0.9rem}.featured-image{width:100%;height:auto;border-radius:8px;margin:1.5rem 0}.content{font-size:1.1rem}.content h2{font-size:1.75rem;margin-top:2rem}.content h3{font-size:1.5rem;margin-top:1.5rem}.content p{margin:1rem 0}.content a{color:${primaryColor}}.content ul{padding-left:1.5rem}.content li{margin:0.5rem 0}.tags{margin-top:2rem;padding-top:1rem;border-top:1px solid #eee}.tag{display:inline-block;background:#f0f0f0;padding:0.25rem 0.75rem;border-radius:999px;font-size:0.85rem;margin-right:0.5rem;margin-bottom:0.5rem;color:#666}footer{margin-top:3rem;padding-top:1rem;border-top:1px solid #eee;text-align:center;color:#666;font-size:0.9rem}footer a{color:${primaryColor}}</style></head><body><div class="container"><header><a href="${siteUrl}/blog/">&larr; ${escapeHtml(siteName)}</a></header><article><h1>${escapeHtml(post.title)}</h1><p class="meta">By ${authorName} &bull; ${new Date(publishedAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</p>${featuredImage?`<img class="featured-image" src="${featuredImage}" alt="${featuredImageAlt}">`:''}<div class="content">${postHtml}</div>${(post.tags||[]).length>0?`<div class="tags">${post.tags.map(tag=>`<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>`:''}</article><footer><p>&copy; ${new Date().getFullYear()} ${escapeHtml(siteName)}. <a href="${siteUrl}/blog/feed.xml">RSS</a></p></footer></div></body></html>`;
}

function generateBlogIndex(posts, config, blogId) {
  const siteUrl = config.siteUrl || `https://${blogId}.com`;
  const siteName = config.siteName || 'Blog';
  const siteDescription = config.siteDescription || `Latest posts from ${siteName}`;
  const canonicalUrl = `${siteUrl}/blog/`;
  const primaryColor = config.siteColors?.primary || '#2563eb';
  const sorted = [...posts].sort((a,b)=>new Date(b.published_at||b.date)-new Date(a.published_at||a.date));
  const schemaJson = JSON.stringify({"@context":"https://schema.org","@type":"Blog","name":siteName,"description":siteDescription,"url":canonicalUrl,"publisher":{"@type":"Organization","name":config.publisherName||"Untitled Publishers","logo":{"@type":"ImageObject","url":config.publisherLogo||"https://untitledpublishers.com/logo.png"}},"blogPost":sorted.slice(0,10).map(post=>({"@type":"BlogPosting","headline":post.title,"url":`${siteUrl}/blog/${post.slug}.html`,"datePublished":post.published_at||post.date,"author":{"@type":"Person","name":post.author||'Unknown'}}))});
  const postsHtml = sorted.map(post=>{const excerpt=generateExcerpt(post.content,150);const postDate=new Date(post.published_at||post.date).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});return `<article class="post-preview">${post.image?`<a href="/blog/${post.slug}.html" class="post-image"><img src="${post.image}" alt="${escapeHtml(post.featured_image_alt||post.title)}"></a>`:''}<div class="post-content"><h2><a href="/blog/${post.slug}.html">${escapeHtml(post.title)}</a></h2><p class="post-meta">${escapeHtml(post.author||'Unknown')} &bull; ${postDate}</p><p class="post-excerpt">${escapeHtml(excerpt)}</p><a href="/blog/${post.slug}.html" class="read-more">Read more &rarr;</a></div></article>`;}).join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(siteName)}</title><meta name="description" content="${escapeHtml(siteDescription)}"><link rel="canonical" href="${canonicalUrl}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(siteName)}"><meta property="og:description" content="${escapeHtml(siteDescription)}"><meta property="og:url" content="${canonicalUrl}"><meta property="og:site_name" content="${escapeHtml(siteName)}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escapeHtml(siteName)}"><meta name="twitter:description" content="${escapeHtml(siteDescription)}">${config.twitterHandle?`<meta name="twitter:site" content="${config.twitterHandle}">`:''}
<script type="application/ld+json">${schemaJson}</script><link rel="alternate" type="application/rss+xml" title="${escapeHtml(siteName)} RSS" href="${siteUrl}/blog/feed.xml">${config.favicon?`<link rel="icon" href="${config.favicon}">`:''}
<style>*{box-sizing:border-box}body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;line-height:1.6;color:#1a1a1a;background:#fff}.container{max-width:900px;margin:0 auto;padding:2rem 1rem}header{text-align:center;margin-bottom:3rem;padding-bottom:2rem;border-bottom:1px solid #eee}header h1{font-size:2.5rem;margin:0 0 0.5rem 0}header p{color:#666;margin:0;font-size:1.1rem}.posts{display:grid;gap:2rem}.post-preview{display:grid;grid-template-columns:1fr;gap:1rem;padding-bottom:2rem;border-bottom:1px solid #eee}@media(min-width:600px){.post-preview{grid-template-columns:200px 1fr}}.post-image img{width:100%;height:150px;object-fit:cover;border-radius:8px}.post-content h2{font-size:1.5rem;margin:0 0 0.5rem 0;line-height:1.3}.post-content h2 a{color:#1a1a1a;text-decoration:none}.post-content h2 a:hover{color:${primaryColor}}.post-meta{color:#666;font-size:0.85rem;margin:0 0 0.5rem 0}.post-excerpt{color:#444;margin:0 0 0.75rem 0}.read-more{color:${primaryColor};text-decoration:none;font-weight:500}footer{margin-top:3rem;padding-top:1rem;border-top:1px solid #eee;text-align:center;color:#666;font-size:0.9rem}footer a{color:${primaryColor}}</style></head><body><div class="container"><header><h1>${escapeHtml(siteName)}</h1><p>${escapeHtml(siteDescription)}</p></header><div class="posts">${postsHtml}</div><footer><p>&copy; ${new Date().getFullYear()} ${escapeHtml(siteName)}. <a href="${siteUrl}/blog/feed.xml">RSS</a></p></footer></div></body></html>`;
}

function generateSitemap(posts, config, blogId) {
  const siteUrl = config.siteUrl || `https://${blogId}.com`;
  const published = posts.filter(p => p.status === 'published' || p.published);
  const sorted = [...published].sort((a,b)=>new Date(b.updatedAt||b.published_at||b.date)-new Date(a.updatedAt||a.published_at||a.date));
  const postUrls = sorted.map(post=>{const lastmod=post.updatedAt||post.published_at||post.date;return `<url><loc>${siteUrl}/blog/${post.slug}.html</loc><lastmod>${new Date(lastmod).toISOString().split('T')[0]}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>`;}).join('');
  const today = new Date().toISOString().split('T')[0];
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteUrl}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url><url><loc>${siteUrl}/blog/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>${postUrls}</urlset>`;
}

function generateRssFeed(posts, config, blogId) {
  const sorted = [...posts].sort((a,b)=>new Date(b.published_at||b.date)-new Date(a.published_at||a.date));
  const siteUrl = config.siteUrl || `https://${blogId}.com`;
  const siteName = config.siteName || 'Blog';
  const siteDescription = config.siteDescription || '';
  const items = sorted.slice(0,20).map(post=>{const description=post.meta_description||generateExcerpt(post.content,200);return `<item><title>${escapeXml(post.title)}</title><link>${siteUrl}/blog/${post.slug}.html</link><guid isPermaLink="true">${siteUrl}/blog/${post.slug}.html</guid><pubDate>${new Date(post.published_at||post.date).toUTCString()}</pubDate><author>${escapeXml(post.author||'Unknown')}</author><description><![CDATA[${description}]]></description>${(post.tags||[]).map(tag=>`<category>${escapeXml(tag)}</category>`).join('')}</item>`;}).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${escapeXml(siteName)}</title><link>${siteUrl}/blog/</link><description>${escapeXml(siteDescription)}</description><language>en-us</language><lastBuildDate>${new Date().toUTCString()}</lastBuildDate><atom:link href="${siteUrl}/blog/feed.xml" rel="self" type="application/rss+xml"/>${items}</channel></rss>`;
}

function generateEmailHtml(post, config) {
  const siteUrl = config.siteUrl || '';
  const postUrl = `${siteUrl}/blog/${post.slug}.html`;
  const primaryColor = config.siteColors?.primary || '#2563eb';
  const siteName = config.siteName || 'Our Blog';
  const excerpt = generateExcerpt(post.content, 300);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${post.title}</title></head><body style="margin:0;padding:0;background-color:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:20px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;max-width:100%;"><tr><td style="background-color:${primaryColor};padding:24px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600;">${siteName}</h1></td></tr>${post.image?`<tr><td style="padding:0;"><img src="${post.image}" alt="${post.featured_image_alt||post.title}" style="width:100%;height:auto;display:block;"></td></tr>`:''}<tr><td style="padding:32px;"><h2 style="margin:0 0 16px 0;font-size:28px;line-height:1.3;color:#1a1a1a;"><a href="${postUrl}" style="color:#1a1a1a;text-decoration:none;">${post.title}</a></h2><p style="margin:0 0 8px 0;font-size:14px;color:#666666;">By ${post.author||'Unknown'} • ${new Date(post.published_at||post.date).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</p><p style="margin:24px 0;font-size:16px;line-height:1.6;color:#333333;">${excerpt}</p><table cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="background-color:${primaryColor};border-radius:6px;"><a href="${postUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;">Read More →</a></td></tr></table></td></tr><tr><td style="background-color:#f9f9f9;padding:24px;text-align:center;border-top:1px solid #eeeeee;"><p style="margin:0 0 8px 0;font-size:14px;color:#666666;">You're receiving this because you subscribed to ${siteName}.</p><p style="margin:0;font-size:12px;color:#999999;"><a href="{{{unsubscribe_url}}}" style="color:#999999;">Unsubscribe</a></p></td></tr></table></td></tr></table></body></html>`;
}

async function sendPublishEmail(post, config, blogId, env) {
  if (post.send_email === false) return { sent: false, reason: 'send_email_disabled' };
  const listSlug = config.courierListSlug || blogId;
  if (!listSlug) return { sent: false, reason: 'no_list_configured' };
  try {
    const emailHtml = generateEmailHtml(post, config);
    const response = await fetch(COURIER_CAMPAIGN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list: listSlug, subject: post.title, body_html: emailHtml, send_now: true, tags: ['blog-post', blogId, ...(post.tags || [])] })
    });
    if (response.ok) { const result = await response.json().catch(()=>({})); return { sent: true, result }; }
    else { const error = await response.text().catch(()=>'Unknown error'); return { sent: false, reason: 'courier_error', error }; }
  } catch (e) { return { sent: false, reason: 'exception', error: e.message }; }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Health check
    if (path === '/' || path === '/health') {
      return jsonResponse({ status: 'ok', service: 'up-blogs-1', version: '2.0.0' });
    }
    
    // ===== ADMIN ENDPOINTS =====
    
    const requireAdminAuth = () => {
      const auth = request.headers.get('Authorization');
      const apiKey = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!apiKey || !env.ADMIN_API_KEY) return false;
      return apiKey === env.ADMIN_API_KEY;
    };
    
    const generateApiKey = () => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      const randomValues = new Uint8Array(32);
      crypto.getRandomValues(randomValues);
      for (let i = 0; i < 32; i++) result += chars[randomValues[i] % chars.length];
      return result;
    };
    
    // POST /admin/register - Register a new blog
    if (path === '/admin/register' && request.method === 'POST') {
      if (!requireAdminAuth()) return jsonResponse({ error: 'Unauthorized - Admin API key required' }, 401);
      try {
        const body = await request.json();
        const { blog_id, site_name, site_url, site_description, author_name, author_id, author_url, courier_list_slug, github_repo, github_token, twitter_handle, favicon, default_image, site_colors, publisher_name, publisher_logo } = body;
        if (!blog_id) return jsonResponse({ error: 'blog_id is required' }, 400);
        if (!/^[a-z0-9-]+$/.test(blog_id)) return jsonResponse({ error: 'blog_id must be lowercase alphanumeric with hyphens only' }, 400);
        const existingKey = await env.BLOGS.get(`blog:${blog_id}:apiKey`);
        if (existingKey) return jsonResponse({ error: `Blog '${blog_id}' already exists` }, 409);
        const apiKey = generateApiKey();
        const config = { siteName: site_name || blog_id, siteUrl: site_url || null, siteDescription: site_description || null, authorName: author_name || null, authorId: author_id || null, authorUrl: author_url || null, courierListSlug: courier_list_slug || blog_id, githubRepo: github_repo || null, githubToken: github_token || null, twitterHandle: twitter_handle || null, favicon: favicon || null, defaultImage: default_image || null, siteColors: site_colors || { primary: '#2563eb', lightBg: '#f3f4f6' }, publisherName: publisher_name || 'Untitled Publishers', publisherLogo: publisher_logo || 'https://untitledpublishers.com/logo.png', createdAt: new Date().toISOString() };
        await Promise.all([env.BLOGS.put(`blog:${blog_id}:apiKey`, apiKey), env.BLOGS.put(`blog:${blog_id}:config`, JSON.stringify(config)), env.BLOGS.put(`blog:${blog_id}:posts`, '[]')]);
        return jsonResponse({ success: true, blog_id, api_key: apiKey, message: 'Blog registered successfully. Save your API key - it cannot be retrieved later!' }, 201);
      } catch (e) { return jsonResponse({ error: 'Failed to register blog', details: e.message }, 500); }
    }
    
    // GET /admin/blogs - List all registered blogs with details
    if (path === '/admin/blogs' && request.method === 'GET') {
      if (!requireAdminAuth()) return jsonResponse({ error: 'Unauthorized - Admin API key required' }, 401);
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
          const subsJson = await env.BLOGS.get(`blog:${blogId}:subscribers`);
          const subs = subsJson ? JSON.parse(subsJson) : [];
          blogs.push({ id: blogId, siteName: config.siteName || blogId, siteUrl: config.siteUrl, siteDescription: config.siteDescription, authorName: config.authorName, authorId: config.authorId, courierListSlug: config.courierListSlug, githubRepo: config.githubRepo, hasGithubToken: !!config.githubToken, twitterHandle: config.twitterHandle, createdAt: config.createdAt, stats: { totalPosts: posts.length, publishedPosts: posts.filter(p=>p.status==='published'||p.published).length, draftPosts: posts.filter(p=>p.status==='draft').length, scheduledPosts: posts.filter(p=>p.status==='scheduled').length, subscribers: subs.length } });
        }
        blogs.sort((a, b) => (a.siteName||'').localeCompare(b.siteName||''));
        return jsonResponse({ blogs, total: blogs.length });
      } catch (e) { return jsonResponse({ error: 'Failed to list blogs', details: e.message }, 500); }
    }
    
    // PUT /admin/blogs/:blogId - Update blog config
    if (path.match(/^\/admin\/blogs\/[a-z0-9-]+$/) && request.method === 'PUT') {
      if (!requireAdminAuth()) return jsonResponse({ error: 'Unauthorized - Admin API key required' }, 401);
      try {
        const blogId = path.split('/')[3];
        const existingConfig = await env.BLOGS.get(`blog:${blogId}:config`);
        if (!existingConfig) return jsonResponse({ error: `Blog '${blogId}' not found` }, 404);
        const config = JSON.parse(existingConfig);
        const body = await request.json();
        const fieldMapping = { site_name:'siteName', site_url:'siteUrl', site_description:'siteDescription', author_name:'authorName', author_id:'authorId', author_url:'authorUrl', courier_list_slug:'courierListSlug', github_repo:'githubRepo', github_token:'githubToken', twitter_handle:'twitterHandle', default_image:'defaultImage', site_colors:'siteColors', publisher_name:'publisherName', publisher_logo:'publisherLogo', favicon:'favicon' };
        for (const [snakeKey, camelKey] of Object.entries(fieldMapping)) { if (body[snakeKey] !== undefined) config[camelKey] = body[snakeKey]; }
        config.updatedAt = new Date().toISOString();
        await env.BLOGS.put(`blog:${blogId}:config`, JSON.stringify(config));
        return jsonResponse({ success: true, blog_id: blogId, message: 'Blog config updated' });
      } catch (e) { return jsonResponse({ error: 'Failed to update blog', details: e.message }, 500); }
    }
    
    // POST /admin/blogs/:blogId/rotate-key - Regenerate API key
    if (path.match(/^\/admin\/blogs\/[a-z0-9-]+\/rotate-key$/) && request.method === 'POST') {
      if (!requireAdminAuth()) return jsonResponse({ error: 'Unauthorized - Admin API key required' }, 401);
      try {
        const blogId = path.split('/')[3];
        const existingKey = await env.BLOGS.get(`blog:${blogId}:apiKey`);
        if (!existingKey) return jsonResponse({ error: `Blog '${blogId}' not found` }, 404);
        const newApiKey = generateApiKey();
        await env.BLOGS.put(`blog:${blogId}:apiKey`, newApiKey);
        return jsonResponse({ success: true, blog_id: blogId, api_key: newApiKey, message: 'API key rotated. Save your new API key!' });
      } catch (e) { return jsonResponse({ error: 'Failed to rotate key', details: e.message }, 500); }
    }
    
    // DELETE /admin/blogs/:blogId - Delete a blog
    if (path.match(/^\/admin\/blogs\/[a-z0-9-]+$/) && request.method === 'DELETE') {
      if (!requireAdminAuth()) return jsonResponse({ error: 'Unauthorized - Admin API key required' }, 401);
      try {
        const blogId = path.split('/')[3];
        const existingKey = await env.BLOGS.get(`blog:${blogId}:apiKey`);
        if (!existingKey) return jsonResponse({ error: `Blog '${blogId}' not found` }, 404);
        const listResult = await env.BLOGS.list({ prefix: `blog:${blogId}:` });
        await Promise.all(listResult.keys.map(k => env.BLOGS.delete(k.name)));
        return jsonResponse({ success: true, blog_id: blogId, message: 'Blog and all associated data deleted' });
      } catch (e) { return jsonResponse({ error: 'Failed to delete blog', details: e.message }, 500); }
    }
    
    // GET /blogs - List all blogs (public)
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
          blogs.push({ id: blogId, name: config.siteName || blogId, slug: blogId, siteUrl: config.siteUrl || null, authorId: config.authorId || null, authorName: config.authorName || null, postCount: publishedPosts.length });
        }
        blogs.sort((a, b) => a.name.localeCompare(b.name));
        return jsonResponse({ blogs });
      } catch (e) { return jsonResponse({ error: 'Failed to list blogs', details: e.message }, 500); }
    }
    
    // Parse /:blogId/... routes
    const match = path.match(/^\/([a-z0-9-]+)\/(.*)$/);
    if (!match) return jsonResponse({ error: 'Invalid path' }, 404);
    const [, blogId, route] = match;
    
    const getApiKey = () => { const auth = request.headers.get('Authorization'); return auth?.startsWith('Bearer ') ? auth.slice(7) : null; };
    const requireAuth = async () => { const apiKey = getApiKey(); if (!apiKey) return false; const storedKey = await env.BLOGS.get(`blog:${blogId}:apiKey`); return apiKey === storedKey; };
    
    try {
      // POST /:blogId/posts - Create/update post
      if (route === 'posts' && request.method === 'POST') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        const body = await request.json();
        const { id, title, content, image, featured_image_alt, author, author_id, meta_description, scheduled_for, status: requestedStatus, send_email = true, tags = [] } = body;
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        let posts = postsJson ? JSON.parse(postsJson) : [];
        const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
        const config = configJson ? JSON.parse(configJson) : {};
        const now = new Date();
        const nowIso = now.toISOString();
        let status, shouldPublish = false;
        if (requestedStatus === 'draft') status = 'draft';
        else if (scheduled_for) { const scheduledDate = new Date(scheduled_for); if (scheduledDate <= now) { status = 'published'; shouldPublish = true; } else status = 'scheduled'; }
        else if (requestedStatus === 'published' || !requestedStatus) { status = 'published'; shouldPublish = true; }
        else status = requestedStatus;
        let post, wasAlreadyPublished = false;
        if (id) {
          const idx = posts.findIndex(p => p.id === id);
          if (idx === -1) return jsonResponse({ error: 'Post not found' }, 404);
          wasAlreadyPublished = posts[idx].status === 'published' || posts[idx].published;
          post = { ...posts[idx], title: title ?? posts[idx].title, content: content ?? posts[idx].content, image: image ?? posts[idx].image, featured_image_alt: featured_image_alt ?? posts[idx].featured_image_alt, author: author ?? posts[idx].author, author_id: author_id ?? posts[idx].author_id, meta_description: meta_description ?? posts[idx].meta_description, scheduled_for: scheduled_for ?? posts[idx].scheduled_for, tags: tags.length > 0 ? tags : (posts[idx].tags || []), status, send_email: send_email ?? posts[idx].send_email ?? true, updatedAt: nowIso };
          if (status === 'published' && !wasAlreadyPublished) { post.published_at = nowIso; post.date = nowIso; }
          if (title && title !== posts[idx].title) post.slug = slugify(title);
          posts[idx] = post;
        } else {
          post = { id: generateId(), title, content, image: image || null, featured_image_alt: featured_image_alt || null, author: author || config.authorName || 'Untitled Publishers', author_id: author_id || config.authorId || null, meta_description: meta_description || null, slug: slugify(title), status, scheduled_for: scheduled_for || null, tags: tags || [], published_at: status === 'published' ? nowIso : null, date: status === 'published' ? nowIso : null, published: status === 'published', send_email, createdAt: nowIso, updatedAt: nowIso };
          posts.push(post);
        }
        await env.BLOGS.put(`blog:${blogId}:posts`, JSON.stringify(posts));
        let emailResult = null;
        if (shouldPublish && !wasAlreadyPublished) {
          if (config.githubRepo && config.githubToken) { try { await publishToGitHub(post, posts.filter(p=>p.status==='published'||p.published), config, blogId, env); } catch (e) { console.error('GitHub error:', e); } }
          emailResult = await sendPublishEmail(post, config, blogId, env);
        }
        return jsonResponse({ success: true, post, published: shouldPublish && !wasAlreadyPublished, email: emailResult });
      }
      
      // GET /:blogId/posts - List posts
      if (route === 'posts' && request.method === 'GET') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        let posts = postsJson ? JSON.parse(postsJson) : [];
        const statusFilter = url.searchParams.get('status');
        const limit = parseInt(url.searchParams.get('limit')) || null;
        const fieldsParam = url.searchParams.get('fields');
        const excerptLength = parseInt(url.searchParams.get('excerpt_length')) || 200;
        if (statusFilter) posts = posts.filter(p => statusFilter==='published' ? (p.status==='published'||p.published===true) : p.status===statusFilter);
        posts.sort((a,b) => new Date(b.published_at||b.date||b.createdAt) - new Date(a.published_at||a.date||a.createdAt));
        if (limit && limit > 0) posts = posts.slice(0, limit);
        if (fieldsParam) { const requestedFields = fieldsParam.split(',').map(f=>f.trim()); posts = posts.map(post => { const result = {}; for (const field of requestedFields) { if (field==='excerpt') result.excerpt=generateExcerpt(post.content,excerptLength); else if (field==='tags') result.tags=post.tags||[]; else if (post[field]!==undefined) result[field]=post[field]; } return result; }); }
        else posts = posts.map(post => ({ ...post, excerpt: generateExcerpt(post.content, excerptLength), tags: post.tags || [] }));
        return jsonResponse({ posts });
      }
      
      // GET /:blogId/posts/:slugOrId - Get single post
      if (route.startsWith('posts/') && route.split('/').length === 2 && request.method === 'GET') {
        const routeParts = route.split('/');
        if (routeParts[1] !== 'like' && routeParts[1] !== 'likes') {
          if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
          const slugOrId = routeParts[1];
          const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
          const posts = postsJson ? JSON.parse(postsJson) : [];
          let post = posts.find(p => p.slug === slugOrId) || posts.find(p => p.id === slugOrId);
          if (!post) return jsonResponse({ error: 'Post not found' }, 404);
          return jsonResponse({ post: { ...post, excerpt: generateExcerpt(post.content, 200), tags: post.tags || [] } });
        }
      }
      
      // DELETE /:blogId/posts/:postId
      if (route.startsWith('posts/') && route.split('/').length === 2 && request.method === 'DELETE') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        const postId = route.split('/')[1];
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        let posts = postsJson ? JSON.parse(postsJson) : [];
        const idx = posts.findIndex(p => p.id === postId);
        if (idx === -1) return jsonResponse({ error: 'Post not found' }, 404);
        posts.splice(idx, 1);
        await env.BLOGS.put(`blog:${blogId}:posts`, JSON.stringify(posts));
        return jsonResponse({ success: true });
      }
      
      // Comments endpoints
      if (route === 'comments/pending' && request.method === 'GET') { if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401); const pendingJson = await env.BLOGS.get(`blog:${blogId}:comments:pending`); return jsonResponse({ comments: pendingJson ? JSON.parse(pendingJson) : [] }); }
      if (route.match(/^comments\/[^/]+\/approve$/) && request.method === 'POST') { if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401); const commentId = route.split('/')[1]; const pendingJson = await env.BLOGS.get(`blog:${blogId}:comments:pending`); let pending = pendingJson ? JSON.parse(pendingJson) : []; const idx = pending.findIndex(c => c.id === commentId); if (idx === -1) return jsonResponse({ error: 'Comment not found' }, 404); const comment = pending[idx]; pending.splice(idx, 1); await env.BLOGS.put(`blog:${blogId}:comments:pending`, JSON.stringify(pending)); const postCommentsKey = `blog:${blogId}:comments:${comment.postId}`; const approvedJson = await env.BLOGS.get(postCommentsKey); const approved = approvedJson ? JSON.parse(approvedJson) : []; comment.approved = true; comment.approvedAt = new Date().toISOString(); approved.push(comment); await env.BLOGS.put(postCommentsKey, JSON.stringify(approved)); return jsonResponse({ success: true }); }
      if (route.match(/^comments\/[^/]+\/reject$/) && request.method === 'POST') { if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401); const commentId = route.split('/')[1]; const pendingJson = await env.BLOGS.get(`blog:${blogId}:comments:pending`); let pending = pendingJson ? JSON.parse(pendingJson) : []; const idx = pending.findIndex(c => c.id === commentId); if (idx === -1) return jsonResponse({ error: 'Comment not found' }, 404); pending.splice(idx, 1); await env.BLOGS.put(`blog:${blogId}:comments:pending`, JSON.stringify(pending)); return jsonResponse({ success: true }); }
      
      // Public: Likes
      if (route.match(/^posts\/[^/]+\/like$/) && request.method === 'POST') { const postId = route.split('/')[1]; const ip = request.headers.get('CF-Connecting-IP') || 'unknown'; const ipHash = await hashIP(ip + postId); const likesKey = `blog:${blogId}:likes:${postId}`; const likesJson = await env.BLOGS.get(likesKey); let likes = likesJson ? JSON.parse(likesJson) : { count: 0, ips: [] }; if (!likes.ips.includes(ipHash)) { likes.count++; likes.ips.push(ipHash); if (likes.ips.length > 1000) likes.ips = likes.ips.slice(-1000); await env.BLOGS.put(likesKey, JSON.stringify(likes)); } return jsonResponse({ success: true, count: likes.count }); }
      if (route.match(/^posts\/[^/]+\/likes$/) && request.method === 'GET') { const postId = route.split('/')[1]; const likesJson = await env.BLOGS.get(`blog:${blogId}:likes:${postId}`); const likes = likesJson ? JSON.parse(likesJson) : { count: 0 }; return jsonResponse({ count: likes.count }); }
      
      // Public: Subscribe
      if (route === 'subscribe' && request.method === 'POST') {
        let email, honeypot;
        const contentType = request.headers.get('Content-Type') || '';
        if (contentType.includes('application/json')) { const body = await request.json(); email = body.email; honeypot = body.website; }
        else { const formData = await request.formData(); email = formData.get('email'); honeypot = formData.get('website'); }
        if (honeypot) return jsonResponse({ success: true });
        if (!email || !email.includes('@')) return jsonResponse({ error: 'Invalid email' }, 400);
        const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
        const config = configJson ? JSON.parse(configJson) : {};
        const subsJson = await env.BLOGS.get(`blog:${blogId}:subscribers`) || '[]';
        const subs = JSON.parse(subsJson);
        if (!subs.includes(email)) { subs.push(email); await env.BLOGS.put(`blog:${blogId}:subscribers`, JSON.stringify(subs)); }
        let courierSuccess = false, courierError = null;
        try { const courierRes = await fetch(COURIER_SUBSCRIBE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, list: config.courierListSlug || blogId, source: `blog:${blogId}` }) }); if (courierRes.ok) courierSuccess = true; else { const errorData = await courierRes.json().catch(()=>({})); courierError = errorData.error || `Courier API returned ${courierRes.status}`; } } catch (e) { courierError = e.message; }
        const referer = request.headers.get('Referer');
        if (referer && !contentType.includes('application/json')) return Response.redirect(referer + '?subscribed=true', 302);
        return jsonResponse({ success: true, courier: courierSuccess, ...(courierError && { courierError }) });
      }
      
      // Public: Comment submission
      if (route === 'comments' && request.method === 'POST') { const { postId, name, email, content, website, captchaAnswer, captchaExpected } = await request.json(); if (website) return jsonResponse({ success: true }); if (captchaExpected && captchaAnswer !== captchaExpected) return jsonResponse({ error: 'Incorrect answer' }, 400); if (!postId || !name || !content) return jsonResponse({ error: 'Missing required fields' }, 400); const comment = { id: generateId(), postId, name, email, content, createdAt: new Date().toISOString() }; const pendingJson = await env.BLOGS.get(`blog:${blogId}:comments:pending`); const pending = pendingJson ? JSON.parse(pendingJson) : []; pending.push(comment); await env.BLOGS.put(`blog:${blogId}:comments:pending`, JSON.stringify(pending)); return jsonResponse({ success: true, message: 'Comment submitted for review' }); }
      
      // Public: Get approved comments
      if (route.startsWith('comments/') && request.method === 'GET') { const postId = route.split('/')[1]; if (postId === 'pending') return jsonResponse({ error: 'Unauthorized' }, 401); const commentsJson = await env.BLOGS.get(`blog:${blogId}:comments:${postId}`); const comments = commentsJson ? JSON.parse(commentsJson) : []; return jsonResponse({ comments: comments.map(({ email, ...rest }) => rest) }); }
      
      return jsonResponse({ error: 'Not found' }, 404);
    } catch (e) { console.error('Error:', e); return jsonResponse({ error: 'Internal error', details: e.message }, 500); }
  },

  async scheduled(event, env, ctx) {
    console.log('Cron triggered:', new Date().toISOString());
    try {
      const listResult = await env.BLOGS.list({ prefix: 'blog:' });
      const blogIds = [...new Set(listResult.keys.map(k => k.name.match(/^blog:([^:]+):config$/)?.[1]).filter(Boolean))];
      const now = new Date();
      const nowIso = now.toISOString();
      let totalPublished = 0, totalEmails = 0;
      for (const blogId of blogIds) {
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        if (!postsJson) continue;
        let posts = JSON.parse(postsJson);
        let updated = false;
        const postsToPublish = [];
        for (const post of posts) {
          if (post.status === 'scheduled' && post.scheduled_for) {
            if (new Date(post.scheduled_for) <= now) { post.status = 'published'; post.published_at = nowIso; post.date = nowIso; post.published = true; updated = true; postsToPublish.push(post); totalPublished++; }
          }
        }
        if (updated) {
          await env.BLOGS.put(`blog:${blogId}:posts`, JSON.stringify(posts));
          const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
          const config = configJson ? JSON.parse(configJson) : {};
          const publishedPosts = posts.filter(p => p.status === 'published' || p.published);
          for (const post of postsToPublish) {
            if (config.githubRepo && config.githubToken) { try { await publishToGitHub(post, publishedPosts, config, blogId, env); } catch (e) { console.error('GitHub error:', e); } }
            const emailResult = await sendPublishEmail(post, config, blogId, env);
            if (emailResult.sent) totalEmails++;
          }
        }
      }
      console.log(`Cron complete. Published ${totalPublished} posts, sent ${totalEmails} emails.`);
    } catch (e) { console.error('Cron error:', e); }
  }
};

async function publishToGitHub(post, allPublishedPosts, config, blogId, env) {
  const { githubRepo, githubToken } = config;
  const [owner, repo] = githubRepo.split('/');
  const workerUrl = env.WORKER_URL || 'https://up-blogs-1.micaiah-tasks.workers.dev';
  await pushToGitHub(owner, repo, `blog/${post.slug}.html`, generatePostPage(post, config, blogId, workerUrl), githubToken);
  await pushToGitHub(owner, repo, 'blog/index.html', generateBlogIndex(allPublishedPosts, config, blogId), githubToken);
  await pushToGitHub(owner, repo, 'blog/feed.xml', generateRssFeed(allPublishedPosts, config, blogId), githubToken);
  await pushToGitHub(owner, repo, 'sitemap.xml', generateSitemap(allPublishedPosts, config, blogId), githubToken);
}

async function pushToGitHub(owner, repo, path, content, token) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  let sha;
  try { const getRes = await fetch(apiUrl, { headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'up-blogs-worker' } }); if (getRes.ok) { const data = await getRes.json(); sha = data.sha; } } catch (e) {}
  const res = await fetch(apiUrl, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'up-blogs-worker', 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `Update ${path}`, content: btoa(unescape(encodeURIComponent(content))), sha }) });
  if (!res.ok) throw new Error(`GitHub push failed: ${res.status}`);
}
