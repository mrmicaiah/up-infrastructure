/**
 * Client Blogs Worker (Multi-tenant)
 * Powers blog admin dashboards for client websites.
 * Each blog has its own password, posts, and config.
 * 
 * KV Structure:
 *   blog:{blogId}:password     - bcrypt hash of admin password
 *   blog:{blogId}:posts        - JSON array of all posts
 *   blog:{blogId}:config       - { listId, githubRepo, githubToken, commentsEnabled, siteColors, template }
 *   blog:{blogId}:comments:{postId} - approved comments
 *   blog:{blogId}:comments:pending  - pending comments queue
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Simple JWT implementation
const JWT_SECRET_KEY = 'your-secret-key'; // Will be overridden by env

async function createJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const data = { ...payload, iat: now, exp: now + 86400 }; // 24 hour expiry
  
  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '');
  const payloadB64 = btoa(JSON.stringify(data)).replace(/=/g, '');
  
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'HMAC', key, encoder.encode(`${headerB64}.${payloadB64}`)
  );
  
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

async function verifyJWT(token, secret) {
  try {
    const [headerB64, payloadB64, sigB64] = token.split('.');
    const payload = JSON.parse(atob(payloadB64));
    
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    
    const sigBytes = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      'HMAC', key, sigBytes, encoder.encode(`${headerB64}.${payloadB64}`)
    );
    
    return valid ? payload : null;
  } catch (e) {
    return null;
  }
}

// Simple password hashing (for demo - consider bcrypt via wasm for production)
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'client-blogs-salt');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function verifyPassword(password, hash) {
  const computed = await hashPassword(password);
  return computed === hash;
}

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

// Markdown to HTML converter
function markdownToHtml(text) {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  
  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');
  
  // Links
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  
  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  
  // Paragraphs
  html = html.split('\n\n').map(para => {
    para = para.trim();
    if (!para) return '';
    if (para.startsWith('<')) return para;
    return `<p>${para.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  
  return html;
}

// Generate subscribe form HTML
function generateSubscribeForm(blogId, config, workerUrl) {
  const primaryColor = config.siteColors?.primary || '#2563eb';
  const lightBg = config.siteColors?.lightBg || '#f3f4f6';
  
  return `
<div class="blog-subscribe-embed" style="text-align:center;margin:2rem 0;padding:2rem;background:${lightBg};border-radius:8px;">
  <p style="margin-bottom:1rem;font-size:1.1rem;">Get new posts delivered to your inbox</p>
  <form action="${workerUrl}/${blogId}/subscribe" method="POST" style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;">
    <input type="email" name="email" placeholder="your@email.com" required style="padding:0.75rem 1rem;border:1px solid #ddd;border-radius:4px;font-size:1rem;">
    <input type="text" name="website" style="position:absolute;left:-9999px;" tabindex="-1" autocomplete="off">
    <button type="submit" style="padding:0.75rem 1.5rem;background:${primaryColor};color:white;border:none;border-radius:4px;font-size:1rem;cursor:pointer;">Subscribe</button>
  </form>
</div>`;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Health check
    if (path === '/' || path === '/health') {
      return jsonResponse({ status: 'ok', service: 'client-blogs-1', version: '1.0.0' });
    }
    
    // Parse /:blogId/... routes
    const match = path.match(/^\/([a-z0-9-]+)\/(.*)$/);
    if (!match) {
      return jsonResponse({ error: 'Invalid path' }, 404);
    }
    
    const [, blogId, route] = match;
    const jwtSecret = env.JWT_SECRET || JWT_SECRET_KEY;
    
    // Helper to get auth token
    const getToken = () => {
      const auth = request.headers.get('Authorization');
      return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    };
    
    // Helper to verify auth
    const requireAuth = async () => {
      const token = getToken();
      if (!token) return null;
      const payload = await verifyJWT(token, jwtSecret);
      if (!payload || payload.blogId !== blogId) return null;
      return payload;
    };
    
    try {
      // POST /:blogId/auth - Login
      if (route === 'auth' && request.method === 'POST') {
        const { password } = await request.json();
        const storedHash = await env.BLOGS.get(`blog:${blogId}:password`);
        
        if (!storedHash) {
          return jsonResponse({ error: 'Blog not found' }, 404);
        }
        
        const valid = await verifyPassword(password, storedHash);
        if (!valid) {
          return jsonResponse({ error: 'Invalid password' }, 401);
        }
        
        const token = await createJWT({ blogId }, jwtSecret);
        return jsonResponse({ success: true, token });
      }
      
      // POST /:blogId/change-password
      if (route === 'change-password' && request.method === 'POST') {
        const auth = await requireAuth();
        if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const { currentPassword, newPassword } = await request.json();
        const storedHash = await env.BLOGS.get(`blog:${blogId}:password`);
        
        const valid = await verifyPassword(currentPassword, storedHash);
        if (!valid) {
          return jsonResponse({ error: 'Current password incorrect' }, 401);
        }
        
        const newHash = await hashPassword(newPassword);
        await env.BLOGS.put(`blog:${blogId}:password`, newHash);
        
        return jsonResponse({ success: true });
      }
      
      // GET /:blogId/posts - List posts
      if (route === 'posts' && request.method === 'GET') {
        const auth = await requireAuth();
        if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        const posts = postsJson ? JSON.parse(postsJson) : [];
        
        return jsonResponse({ posts });
      }
      
      // POST /:blogId/posts - Create/update post
      if (route === 'posts' && request.method === 'POST') {
        const auth = await requireAuth();
        if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const { id, title, content, image, published, author } = await request.json();
        
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        let posts = postsJson ? JSON.parse(postsJson) : [];
        
        const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
        const config = configJson ? JSON.parse(configJson) : {};
        
        let post;
        const now = new Date().toISOString();
        
        if (id) {
          // Update existing
          const idx = posts.findIndex(p => p.id === id);
          if (idx === -1) {
            return jsonResponse({ error: 'Post not found' }, 404);
          }
          post = { ...posts[idx], title, content, image, published, author, updatedAt: now };
          if (!posts[idx].slug) post.slug = slugify(title);
          posts[idx] = post;
        } else {
          // Create new
          post = {
            id: generateId(),
            title,
            content,
            image,
            published,
            author,
            slug: slugify(title),
            date: now,
            createdAt: now,
            updatedAt: now
          };
          posts.push(post);
        }
        
        await env.BLOGS.put(`blog:${blogId}:posts`, JSON.stringify(posts));
        
        // If publishing, push to GitHub
        if (published && config.githubRepo && config.githubToken) {
          try {
            await publishToGitHub(post, posts.filter(p => p.published), config, blogId, env);
          } catch (e) {
            console.error('GitHub publish error:', e);
            // Don't fail the whole request
          }
        }
        
        return jsonResponse({ success: true, post });
      }
      
      // DELETE /:blogId/posts/:postId
      if (route.startsWith('posts/') && request.method === 'DELETE') {
        const auth = await requireAuth();
        if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const postId = route.split('/')[1];
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        let posts = postsJson ? JSON.parse(postsJson) : [];
        
        const idx = posts.findIndex(p => p.id === postId);
        if (idx === -1) {
          return jsonResponse({ error: 'Post not found' }, 404);
        }
        
        posts.splice(idx, 1);
        await env.BLOGS.put(`blog:${blogId}:posts`, JSON.stringify(posts));
        
        return jsonResponse({ success: true });
      }
      
      // POST /:blogId/subscribe - Public subscribe endpoint
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
        
        // Honeypot check
        if (honeypot) {
          // Bot detected, silently accept
          return jsonResponse({ success: true });
        }
        
        if (!email || !email.includes('@')) {
          return jsonResponse({ error: 'Invalid email' }, 400);
        }
        
        const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
        const config = configJson ? JSON.parse(configJson) : {};
        
        // TODO: Add to Courier list using config.listId
        // For now, just store in KV
        const subsJson = await env.BLOGS.get(`blog:${blogId}:subscribers`) || '[]';
        const subs = JSON.parse(subsJson);
        if (!subs.includes(email)) {
          subs.push(email);
          await env.BLOGS.put(`blog:${blogId}:subscribers`, JSON.stringify(subs));
        }
        
        // Redirect back or return success
        const referer = request.headers.get('Referer');
        if (referer && !contentType.includes('application/json')) {
          return Response.redirect(referer + '?subscribed=true', 302);
        }
        
        return jsonResponse({ success: true });
      }
      
      return jsonResponse({ error: 'Not found' }, 404);
      
    } catch (e) {
      console.error('Error:', e);
      return jsonResponse({ error: 'Internal error', details: e.message }, 500);
    }
  }
};

// Publish post to GitHub
async function publishToGitHub(post, allPublishedPosts, config, blogId, env) {
  const { githubRepo, githubToken, template } = config;
  const [owner, repo] = githubRepo.split('/');
  
  const workerUrl = env.WORKER_URL || 'https://client-blogs-1.micaiah-tasks.workers.dev';
  
  // Generate post HTML
  let postHtml = markdownToHtml(post.content);
  postHtml = postHtml.replace(/{{subscribe}}/g, generateSubscribeForm(blogId, config, workerUrl));
  
  // Use template or default
  const pageHtml = template ? 
    template
      .replace('{{title}}', post.title)
      .replace('{{content}}', postHtml)
      .replace('{{author}}', post.author || '')
      .replace('{{date}}', new Date(post.date).toLocaleDateString())
      .replace('{{image}}', post.image || '') :
    `<!DOCTYPE html><html><head><title>${post.title}</title></head><body><h1>${post.title}</h1>${postHtml}</body></html>`;
  
  // Push post file
  await pushToGitHub(owner, repo, `blog/${post.slug}.html`, pageHtml, githubToken);
  
  // Generate and push index.html
  const indexHtml = generateBlogIndex(allPublishedPosts, config);
  await pushToGitHub(owner, repo, 'blog/index.html', indexHtml, githubToken);
  
  // Generate and push feed.xml
  const feedXml = generateRssFeed(allPublishedPosts, config, blogId);
  await pushToGitHub(owner, repo, 'blog/feed.xml', feedXml, githubToken);
}

async function pushToGitHub(owner, repo, path, content, token) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  
  // Get current file SHA if exists
  let sha;
  try {
    const getRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'client-blogs-worker'
      }
    });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }
  } catch (e) {}
  
  // Push file
  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'client-blogs-worker',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: `Update ${path}`,
      content: btoa(unescape(encodeURIComponent(content))),
      sha
    })
  });
  
  if (!res.ok) {
    throw new Error(`GitHub push failed: ${res.status}`);
  }
}

function generateBlogIndex(posts, config) {
  const sorted = [...posts].sort((a, b) => new Date(b.date) - new Date(a.date));
  
  const postsHtml = sorted.map(post => `
    <article class="post-preview">
      ${post.image ? `<img src="${post.image}" alt="${post.title}">` : ''}
      <h2><a href="/blog/${post.slug}.html">${post.title}</a></h2>
      <p class="date">${new Date(post.date).toLocaleDateString()}</p>
    </article>
  `).join('\n');
  
  return `<!DOCTYPE html>
<html>
<head>
  <title>Blog</title>
  <link rel="alternate" type="application/rss+xml" title="RSS" href="/blog/feed.xml">
</head>
<body>
  <h1>Blog</h1>
  ${postsHtml}
</body>
</html>`;
}

function generateRssFeed(posts, config, blogId) {
  const sorted = [...posts].sort((a, b) => new Date(b.date) - new Date(a.date));
  const siteUrl = config.siteUrl || `https://${blogId}.com`;
  
  const items = sorted.slice(0, 20).map(post => `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${siteUrl}/blog/${post.slug}.html</link>
      <pubDate>${new Date(post.date).toUTCString()}</pubDate>
      <description>${escapeXml(post.content.substring(0, 200))}...</description>
    </item>
  `).join('');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${config.siteName || 'Blog'}</title>
    <link>${siteUrl}/blog</link>
    <description>${config.siteDescription || ''}</description>
    ${items}
  </channel>
</rss>`;
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
