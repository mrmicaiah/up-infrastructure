/**
 * UP Blogs Worker (Multi-tenant)
 * Powers Untitled Publishers blogs via API.
 * No admin UI - Claude posts via API key authentication.
 * 
 * KV Structure:
 *   blog:{blogId}:apiKey       - API key for auth
 *   blog:{blogId}:posts        - JSON array of all posts
 *   blog:{blogId}:config       - { listId, githubRepo, githubToken, siteColors, template }
 *   blog:{blogId}:comments:{postId} - approved comments
 *   blog:{blogId}:comments:pending  - pending comments queue
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

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
      return jsonResponse({ status: 'ok', service: 'up-blogs-1', version: '1.0.0' });
    }
    
    // Parse /:blogId/... routes
    const match = path.match(/^\/([a-z0-9-]+)\/(.*)$/);
    if (!match) {
      return jsonResponse({ error: 'Invalid path' }, 404);
    }
    
    const [, blogId, route] = match;
    
    // Helper to get API key from header
    const getApiKey = () => {
      const auth = request.headers.get('Authorization');
      return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    };
    
    // Helper to verify API key
    const requireAuth = async () => {
      const apiKey = getApiKey();
      if (!apiKey) return false;
      const storedKey = await env.BLOGS.get(`blog:${blogId}:apiKey`);
      return apiKey === storedKey;
    };
    
    try {
      // ===== AUTHENTICATED ENDPOINTS =====
      
      // POST /:blogId/posts - Create/update post
      if (route === 'posts' && request.method === 'POST') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const { id, title, content, image, author, sendEmail } = await request.json();
        
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        let posts = postsJson ? JSON.parse(postsJson) : [];
        
        const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
        const config = configJson ? JSON.parse(configJson) : {};
        
        let post;
        const now = new Date().toISOString();
        
        if (id) {
          const idx = posts.findIndex(p => p.id === id);
          if (idx === -1) {
            return jsonResponse({ error: 'Post not found' }, 404);
          }
          post = { ...posts[idx], title, content, image, author, updatedAt: now };
          posts[idx] = post;
        } else {
          post = {
            id: generateId(),
            title,
            content,
            image,
            author: author || 'Untitled Publishers',
            slug: slugify(title),
            published: true,
            date: now,
            createdAt: now,
            updatedAt: now
          };
          posts.push(post);
        }
        
        await env.BLOGS.put(`blog:${blogId}:posts`, JSON.stringify(posts));
        
        // Push to GitHub
        if (config.githubRepo && config.githubToken) {
          try {
            await publishToGitHub(post, posts.filter(p => p.published), config, blogId, env);
          } catch (e) {
            console.error('GitHub publish error:', e);
          }
        }
        
        // TODO: Send email via Courier if sendEmail flag is true
        
        return jsonResponse({ success: true, post });
      }
      
      // GET /:blogId/posts - List posts
      if (route === 'posts' && request.method === 'GET') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        const posts = postsJson ? JSON.parse(postsJson) : [];
        
        return jsonResponse({ posts });
      }
      
      // DELETE /:blogId/posts/:postId
      if (route.startsWith('posts/') && request.method === 'DELETE') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        
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
      
      // GET /:blogId/comments/pending - Get pending comments
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
        
        // Add to approved comments for that post
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
      
      // ===== PUBLIC ENDPOINTS =====
      
      // POST /:blogId/subscribe - Public subscribe
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
          return jsonResponse({ success: true });
        }
        
        if (!email || !email.includes('@')) {
          return jsonResponse({ error: 'Invalid email' }, 400);
        }
        
        // Store subscriber
        const subsJson = await env.BLOGS.get(`blog:${blogId}:subscribers`) || '[]';
        const subs = JSON.parse(subsJson);
        if (!subs.includes(email)) {
          subs.push(email);
          await env.BLOGS.put(`blog:${blogId}:subscribers`, JSON.stringify(subs));
        }
        
        // TODO: Add to Courier list
        
        const referer = request.headers.get('Referer');
        if (referer && !contentType.includes('application/json')) {
          return Response.redirect(referer + '?subscribed=true', 302);
        }
        
        return jsonResponse({ success: true });
      }
      
      // POST /:blogId/comments - Public comment submission
      if (route === 'comments' && request.method === 'POST') {
        const { postId, name, email, content, website, captchaAnswer, captchaExpected } = await request.json();
        
        // Honeypot check
        if (website) {
          return jsonResponse({ success: true });
        }
        
        // Math captcha check
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
      
      // GET /:blogId/comments/:postId - Get approved comments for a post
      if (route.startsWith('comments/') && request.method === 'GET') {
        const postId = route.split('/')[1];
        
        // Don't expose pending endpoint publicly
        if (postId === 'pending') {
          return jsonResponse({ error: 'Unauthorized' }, 401);
        }
        
        const commentsJson = await env.BLOGS.get(`blog:${blogId}:comments:${postId}`);
        const comments = commentsJson ? JSON.parse(commentsJson) : [];
        
        // Remove email from public response
        const publicComments = comments.map(({ email, ...rest }) => rest);
        
        return jsonResponse({ comments: publicComments });
      }
      
      return jsonResponse({ error: 'Not found' }, 404);
      
    } catch (e) {
      console.error('Error:', e);
      return jsonResponse({ error: 'Internal error', details: e.message }, 500);
    }
  }
};

// Publish post to GitHub (same as client-blogs)
async function publishToGitHub(post, allPublishedPosts, config, blogId, env) {
  const { githubRepo, githubToken, template } = config;
  const [owner, repo] = githubRepo.split('/');
  
  const workerUrl = env.WORKER_URL || 'https://up-blogs-1.micaiah-tasks.workers.dev';
  
  let postHtml = markdownToHtml(post.content);
  postHtml = postHtml.replace(/{{subscribe}}/g, generateSubscribeForm(blogId, config, workerUrl));
  
  const pageHtml = template ? 
    template
      .replace('{{title}}', post.title)
      .replace('{{content}}', postHtml)
      .replace('{{author}}', post.author || '')
      .replace('{{date}}', new Date(post.date).toLocaleDateString())
      .replace('{{image}}', post.image || '') :
    `<!DOCTYPE html><html><head><title>${post.title}</title></head><body><h1>${post.title}</h1>${postHtml}</body></html>`;
  
  await pushToGitHub(owner, repo, `blog/${post.slug}.html`, pageHtml, githubToken);
  
  const indexHtml = generateBlogIndex(allPublishedPosts, config);
  await pushToGitHub(owner, repo, 'blog/index.html', indexHtml, githubToken);
  
  const feedXml = generateRssFeed(allPublishedPosts, config, blogId);
  await pushToGitHub(owner, repo, 'blog/feed.xml', feedXml, githubToken);
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
