/**
 * UP Blogs Worker (Multi-tenant)
 * Powers Untitled Publishers blogs via API.
 * No admin UI - Claude posts via API key authentication.
 * 
 * KV Structure:
 *   blog:{blogId}:apiKey       - API key for auth
 *   blog:{blogId}:posts        - JSON array of all posts
 *   blog:{blogId}:config       - { listId, githubRepo, githubToken, siteColors, template, courierListSlug }
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
 * 
 * SEO:
 *   Full meta tags, Open Graph, Twitter Cards, Schema.org JSON-LD, sitemap.xml
 * 
 * Last updated: 2026-01-28 - Added likes/reactions system
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Simple hash function for IP anonymization (used for like deduplication)
async function hashIP(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  // Return first 16 chars of hex hash (8 bytes) - enough for deduplication
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Generate excerpt from content (strips markdown, limits to specified length)
function generateExcerpt(content, maxLength = 200) {
  if (!content) return '';
  
  // Strip markdown formatting
  let text = content
    .replace(/^#{1,6}\s+/gm, '')           // Headers
    .replace(/\*\*(.+?)\*\*/g, '$1')       // Bold
    .replace(/_(.+?)_/g, '$1')             // Italic
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')    // Links
    .replace(/^[-*]\s+/gm, '')             // List items
    .replace(/{{subscribe}}/g, '')          // Template tags
    .replace(/\n+/g, ' ')                  // Newlines to spaces
    .trim();
  
  // Truncate at word boundary
  if (text.length <= maxLength) return text;
  
  const truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated) + '...';
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

// Generate subscribe form HTML (for blog pages)
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

// Generate full post page HTML with SEO elements
function generatePostPage(post, config, blogId, workerUrl) {
  const siteUrl = config.siteUrl || `https://${blogId}.com`;
  const siteName = config.siteName || 'Blog';
  const siteDescription = config.siteDescription || '';
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
  
  // Schema.org JSON-LD
  const schemaJson = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": post.title,
    "image": featuredImage || undefined,
    "datePublished": publishedAt,
    "dateModified": updatedAt,
    "author": {
      "@type": "Person",
      "name": post.author || 'Unknown',
      "url": authorUrl
    },
    "publisher": {
      "@type": "Organization",
      "name": config.publisherName || "Untitled Publishers",
      "logo": {
        "@type": "ImageObject",
        "url": config.publisherLogo || "https://untitledpublishers.com/logo.png"
      }
    },
    "description": post.meta_description || generateExcerpt(post.content, 160),
    "mainEntityOfPage": canonicalUrl
  });
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(post.title)} | ${escapeHtml(siteName)}</title>
  <meta name="description" content="${metaDescription}">
  <link rel="canonical" href="${canonicalUrl}">
  
  <!-- Open Graph -->
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(post.title)}">
  <meta property="og:description" content="${metaDescription}">
  ${featuredImage ? `<meta property="og:image" content="${featuredImage}">` : ''}
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:site_name" content="${escapeHtml(siteName)}">
  <meta property="article:published_time" content="${publishedAt}">
  <meta property="article:modified_time" content="${updatedAt}">
  <meta property="article:author" content="${authorName}">
  ${(post.tags || []).map(tag => `<meta property="article:tag" content="${escapeHtml(tag)}">`).join('\n  ')}
  
  <!-- Twitter Card -->
  <meta name="twitter:card" content="${featuredImage ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${escapeHtml(post.title)}">
  <meta name="twitter:description" content="${metaDescription}">
  ${featuredImage ? `<meta name="twitter:image" content="${featuredImage}">
  <meta name="twitter:image:alt" content="${featuredImageAlt}">` : ''}
  ${config.twitterHandle ? `<meta name="twitter:site" content="${config.twitterHandle}">` : ''}
  
  <!-- Schema.org JSON-LD -->
  <script type="application/ld+json">
  ${schemaJson}
  </script>
  
  <!-- RSS -->
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(siteName)} RSS" href="${siteUrl}/blog/feed.xml">
  
  <!-- Favicon -->
  ${config.favicon ? `<link rel="icon" href="${config.favicon}">` : ''}
  
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      background: #fff;
    }
    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: 2rem 1rem;
    }
    header {
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #eee;
    }
    header a {
      color: ${primaryColor};
      text-decoration: none;
      font-weight: 600;
    }
    h1 {
      font-size: 2.5rem;
      line-height: 1.2;
      margin: 0 0 1rem 0;
    }
    .meta {
      color: #666;
      font-size: 0.9rem;
    }
    .featured-image {
      width: 100%;
      height: auto;
      border-radius: 8px;
      margin: 1.5rem 0;
    }
    .content {
      font-size: 1.1rem;
    }
    .content h2 { font-size: 1.75rem; margin-top: 2rem; }
    .content h3 { font-size: 1.5rem; margin-top: 1.5rem; }
    .content p { margin: 1rem 0; }
    .content a { color: ${primaryColor}; }
    .content ul { padding-left: 1.5rem; }
    .content li { margin: 0.5rem 0; }
    .tags {
      margin-top: 2rem;
      padding-top: 1rem;
      border-top: 1px solid #eee;
    }
    .tag {
      display: inline-block;
      background: #f0f0f0;
      padding: 0.25rem 0.75rem;
      border-radius: 999px;
      font-size: 0.85rem;
      margin-right: 0.5rem;
      margin-bottom: 0.5rem;
      color: #666;
    }
    footer {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 1px solid #eee;
      text-align: center;
      color: #666;
      font-size: 0.9rem;
    }
    footer a { color: ${primaryColor}; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <a href="${siteUrl}/blog/">&larr; ${escapeHtml(siteName)}</a>
    </header>
    
    <article>
      <h1>${escapeHtml(post.title)}</h1>
      <p class="meta">
        By ${authorName} &bull; ${new Date(publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
      </p>
      
      ${featuredImage ? `<img class="featured-image" src="${featuredImage}" alt="${featuredImageAlt}">` : ''}
      
      <div class="content">
        ${postHtml}
      </div>
      
      ${(post.tags || []).length > 0 ? `
      <div class="tags">
        ${post.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
      </div>
      ` : ''}
    </article>
    
    <footer>
      <p>&copy; ${new Date().getFullYear()} ${escapeHtml(siteName)}. <a href="${siteUrl}/blog/feed.xml">RSS</a></p>
    </footer>
  </div>
</body>
</html>`;
}

// Generate blog index page with SEO elements
function generateBlogIndex(posts, config, blogId) {
  const siteUrl = config.siteUrl || `https://${blogId}.com`;
  const siteName = config.siteName || 'Blog';
  const siteDescription = config.siteDescription || `Latest posts from ${siteName}`;
  const canonicalUrl = `${siteUrl}/blog/`;
  const primaryColor = config.siteColors?.primary || '#2563eb';
  const featuredImage = config.defaultImage || '';
  
  const sorted = [...posts].sort((a, b) => {
    const dateA = new Date(b.published_at || b.date);
    const dateB = new Date(a.published_at || a.date);
    return dateA - dateB;
  });
  
  // Schema.org JSON-LD for Blog
  const schemaJson = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Blog",
    "name": siteName,
    "description": siteDescription,
    "url": canonicalUrl,
    "publisher": {
      "@type": "Organization",
      "name": config.publisherName || "Untitled Publishers",
      "logo": {
        "@type": "ImageObject",
        "url": config.publisherLogo || "https://untitledpublishers.com/logo.png"
      }
    },
    "blogPost": sorted.slice(0, 10).map(post => ({
      "@type": "BlogPosting",
      "headline": post.title,
      "url": `${siteUrl}/blog/${post.slug}.html`,
      "datePublished": post.published_at || post.date,
      "author": {
        "@type": "Person",
        "name": post.author || 'Unknown'
      }
    }))
  });
  
  const postsHtml = sorted.map(post => {
    const excerpt = generateExcerpt(post.content, 150);
    const postDate = new Date(post.published_at || post.date).toLocaleDateString('en-US', { 
      year: 'numeric', month: 'long', day: 'numeric' 
    });
    
    return `
    <article class="post-preview">
      ${post.image ? `
      <a href="/blog/${post.slug}.html" class="post-image">
        <img src="${post.image}" alt="${escapeHtml(post.featured_image_alt || post.title)}">
      </a>
      ` : ''}
      <div class="post-content">
        <h2><a href="/blog/${post.slug}.html">${escapeHtml(post.title)}</a></h2>
        <p class="post-meta">${escapeHtml(post.author || 'Unknown')} &bull; ${postDate}</p>
        <p class="post-excerpt">${escapeHtml(excerpt)}</p>
        <a href="/blog/${post.slug}.html" class="read-more">Read more &rarr;</a>
      </div>
    </article>`;
  }).join('\n');
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(siteName)}</title>
  <meta name="description" content="${escapeHtml(siteDescription)}">
  <link rel="canonical" href="${canonicalUrl}">
  
  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(siteName)}">
  <meta property="og:description" content="${escapeHtml(siteDescription)}">
  ${featuredImage ? `<meta property="og:image" content="${featuredImage}">` : ''}
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:site_name" content="${escapeHtml(siteName)}">
  
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHtml(siteName)}">
  <meta name="twitter:description" content="${escapeHtml(siteDescription)}">
  ${config.twitterHandle ? `<meta name="twitter:site" content="${config.twitterHandle}">` : ''}
  
  <!-- Schema.org JSON-LD -->
  <script type="application/ld+json">
  ${schemaJson}
  </script>
  
  <!-- RSS -->
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(siteName)} RSS" href="${siteUrl}/blog/feed.xml">
  
  <!-- Favicon -->
  ${config.favicon ? `<link rel="icon" href="${config.favicon}">` : ''}
  
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      background: #fff;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 2rem 1rem;
    }
    header {
      text-align: center;
      margin-bottom: 3rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid #eee;
    }
    header h1 {
      font-size: 2.5rem;
      margin: 0 0 0.5rem 0;
    }
    header p {
      color: #666;
      margin: 0;
      font-size: 1.1rem;
    }
    .posts {
      display: grid;
      gap: 2rem;
    }
    .post-preview {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid #eee;
    }
    @media (min-width: 600px) {
      .post-preview {
        grid-template-columns: 200px 1fr;
      }
    }
    .post-image img {
      width: 100%;
      height: 150px;
      object-fit: cover;
      border-radius: 8px;
    }
    .post-content h2 {
      font-size: 1.5rem;
      margin: 0 0 0.5rem 0;
      line-height: 1.3;
    }
    .post-content h2 a {
      color: #1a1a1a;
      text-decoration: none;
    }
    .post-content h2 a:hover {
      color: ${primaryColor};
    }
    .post-meta {
      color: #666;
      font-size: 0.85rem;
      margin: 0 0 0.5rem 0;
    }
    .post-excerpt {
      color: #444;
      margin: 0 0 0.75rem 0;
    }
    .read-more {
      color: ${primaryColor};
      text-decoration: none;
      font-weight: 500;
    }
    footer {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 1px solid #eee;
      text-align: center;
      color: #666;
      font-size: 0.9rem;
    }
    footer a { color: ${primaryColor}; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${escapeHtml(siteName)}</h1>
      <p>${escapeHtml(siteDescription)}</p>
    </header>
    
    <div class="posts">
      ${postsHtml}
    </div>
    
    <footer>
      <p>&copy; ${new Date().getFullYear()} ${escapeHtml(siteName)}. <a href="${siteUrl}/blog/feed.xml">RSS</a></p>
    </footer>
  </div>
</body>
</html>`;
}

// Generate sitemap.xml for SEO
function generateSitemap(posts, config, blogId) {
  const siteUrl = config.siteUrl || `https://${blogId}.com`;
  const published = posts.filter(p => p.status === 'published' || p.published);
  
  // Sort by most recently updated
  const sorted = [...published].sort((a, b) => {
    const dateA = new Date(a.updatedAt || a.published_at || a.date);
    const dateB = new Date(b.updatedAt || b.published_at || b.date);
    return dateB - dateA;
  });
  
  const postUrls = sorted.map(post => {
    const lastmod = post.updatedAt || post.published_at || post.date;
    return `
  <url>
    <loc>${siteUrl}/blog/${post.slug}.html</loc>
    <lastmod>${new Date(lastmod).toISOString().split('T')[0]}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`;
  }).join('');
  
  const today = new Date().toISOString().split('T')[0];
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${siteUrl}/blog/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>${postUrls}
</urlset>`;
}

// Generate RSS feed with proper formatting
function generateRssFeed(posts, config, blogId) {
  const sorted = [...posts].sort((a, b) => {
    const dateA = new Date(b.published_at || b.date);
    const dateB = new Date(a.published_at || a.date);
    return dateA - dateB;
  });
  const siteUrl = config.siteUrl || `https://${blogId}.com`;
  const siteName = config.siteName || 'Blog';
  const siteDescription = config.siteDescription || '';
  
  const items = sorted.slice(0, 20).map(post => {
    const description = post.meta_description || generateExcerpt(post.content, 200);
    return `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${siteUrl}/blog/${post.slug}.html</link>
      <guid isPermaLink="true">${siteUrl}/blog/${post.slug}.html</guid>
      <pubDate>${new Date(post.published_at || post.date).toUTCString()}</pubDate>
      <author>${escapeXml(post.author || 'Unknown')}</author>
      <description><![CDATA[${description}]]></description>
      ${(post.tags || []).map(tag => `<category>${escapeXml(tag)}</category>`).join('\n      ')}
    </item>`;
  }).join('');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteName)}</title>
    <link>${siteUrl}/blog/</link>
    <description>${escapeXml(siteDescription)}</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${siteUrl}/blog/feed.xml" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;
}

// Generate email HTML for new post notification
function generateEmailHtml(post, config) {
  const siteUrl = config.siteUrl || '';
  const postUrl = `${siteUrl}/blog/${post.slug}.html`;
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
          <!-- Header -->
          <tr>
            <td style="background-color:${primaryColor};padding:24px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600;">${siteName}</h1>
            </td>
          </tr>
          
          <!-- Featured Image -->
          ${post.image ? `
          <tr>
            <td style="padding:0;">
              <img src="${post.image}" alt="${post.featured_image_alt || post.title}" style="width:100%;height:auto;display:block;">
            </td>
          </tr>
          ` : ''}
          
          <!-- Content -->
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
              
              <!-- CTA Button -->
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
          
          <!-- Footer -->
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

// Send email notification via Courier when post is published
async function sendPublishEmail(post, config, blogId, env) {
  // Check if email should be sent
  if (post.send_email === false) {
    console.log(`Skipping email for post "${post.title}" - send_email is false`);
    return { sent: false, reason: 'send_email_disabled' };
  }
  
  // Check if Courier list is configured
  const listSlug = config.courierListSlug || blogId;
  if (!listSlug) {
    console.log(`Skipping email for post "${post.title}" - no Courier list configured`);
    return { sent: false, reason: 'no_list_configured' };
  }
  
  try {
    const emailHtml = generateEmailHtml(post, config);
    
    const campaignPayload = {
      list: listSlug,
      subject: post.title,
      body_html: emailHtml,
      send_now: true,
      tags: ['blog-post', blogId, ...(post.tags || [])]
    };
    
    console.log(`Sending email for post "${post.title}" to list "${listSlug}"`);
    
    const response = await fetch(COURIER_CAMPAIGN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(campaignPayload)
    });
    
    if (response.ok) {
      const result = await response.json().catch(() => ({}));
      console.log(`Email sent successfully for "${post.title}"`, result);
      return { sent: true, result };
    } else {
      const error = await response.text().catch(() => 'Unknown error');
      console.error(`Courier campaign failed for "${post.title}":`, error);
      return { sent: false, reason: 'courier_error', error };
    }
  } catch (e) {
    console.error(`Email send exception for "${post.title}":`, e);
    return { sent: false, reason: 'exception', error: e.message };
  }
}

export default {
  // HTTP request handler
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Health check
    if (path === '/' || path === '/health') {
      return jsonResponse({ status: 'ok', service: 'up-blogs-1', version: '1.8.0' });
    }
    
    // GET /blogs - List all blogs (public, no API keys exposed)
    if (path === '/blogs' && request.method === 'GET') {
      try {
        const blogs = [];
        
        // List all KV keys matching blog:*:config
        const listResult = await env.BLOGS.list({ prefix: 'blog:' });
        
        // Filter for config keys and extract blog IDs
        const configKeys = listResult.keys.filter(k => k.name.endsWith(':config'));
        
        for (const key of configKeys) {
          // Extract blogId from key name (blog:{blogId}:config)
          const parts = key.name.split(':');
          if (parts.length !== 3) continue;
          const blogId = parts[1];
          
          // Get config
          const configJson = await env.BLOGS.get(key.name);
          if (!configJson) continue;
          
          const config = JSON.parse(configJson);
          
          // Get post count
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
        
        // Sort by name
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
      
      // POST /:blogId/posts - Create/update post with scheduling support
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
        
        // Determine status based on scheduled_for and requestedStatus
        let status;
        let shouldPublish = false;
        
        if (requestedStatus === 'draft') {
          status = 'draft';
        } else if (scheduled_for) {
          const scheduledDate = new Date(scheduled_for);
          if (scheduledDate <= now) {
            // Scheduled time is now or in the past - publish immediately
            status = 'published';
            shouldPublish = true;
          } else {
            // Scheduled for future
            status = 'scheduled';
          }
        } else if (requestedStatus === 'published' || !requestedStatus) {
          // No schedule and either explicitly published or no status = publish now
          status = 'published';
          shouldPublish = true;
        } else {
          status = requestedStatus;
        }
        
        let post;
        let wasAlreadyPublished = false;
        
        if (id) {
          // Update existing post
          const idx = posts.findIndex(p => p.id === id);
          if (idx === -1) {
            return jsonResponse({ error: 'Post not found' }, 404);
          }
          
          wasAlreadyPublished = posts[idx].status === 'published' || posts[idx].published;
          
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
          
          // Set published_at if transitioning to published
          if (status === 'published' && !wasAlreadyPublished) {
            post.published_at = nowIso;
            post.date = nowIso; // Keep date for backward compatibility
          }
          
          // Regenerate slug if title changed
          if (title && title !== posts[idx].title) {
            post.slug = slugify(title);
          }
          
          posts[idx] = post;
        } else {
          // Create new post
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
            published_at: status === 'published' ? nowIso : null,
            date: status === 'published' ? nowIso : null, // backward compat
            published: status === 'published', // backward compat
            send_email: send_email,
            createdAt: nowIso,
            updatedAt: nowIso
          };
          posts.push(post);
        }
        
        await env.BLOGS.put(`blog:${blogId}:posts`, JSON.stringify(posts));
        
        let emailResult = null;
        
        // Only push to GitHub and send email if newly published
        if (shouldPublish && !wasAlreadyPublished) {
          // Push to GitHub
          if (config.githubRepo && config.githubToken) {
            try {
              const publishedPosts = posts.filter(p => p.status === 'published' || p.published);
              await publishToGitHub(post, publishedPosts, config, blogId, env);
            } catch (e) {
              console.error('GitHub publish error:', e);
            }
          }
          
          // Send email via Courier
          emailResult = await sendPublishEmail(post, config, blogId, env);
        }
        
        return jsonResponse({ 
          success: true, 
          post,
          published: shouldPublish && !wasAlreadyPublished,
          email: emailResult
        });
      }
      
      // GET /:blogId/posts - List posts with optional filters and field selection
      if (route === 'posts' && request.method === 'GET') {
        if (!await requireAuth()) return jsonResponse({ error: 'Unauthorized' }, 401);
        
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        let posts = postsJson ? JSON.parse(postsJson) : [];
        
        // Query params
        const statusFilter = url.searchParams.get('status');
        const limit = parseInt(url.searchParams.get('limit')) || null;
        const fieldsParam = url.searchParams.get('fields');
        const excerptLength = parseInt(url.searchParams.get('excerpt_length')) || 200;
        
        // Filter by status
        if (statusFilter) {
          posts = posts.filter(p => {
            // Handle backward compat: old posts have 'published' boolean
            if (statusFilter === 'published') {
              return p.status === 'published' || p.published === true;
            }
            return p.status === statusFilter;
          });
        }
        
        // Sort by date descending (newest first)
        posts.sort((a, b) => {
          const dateA = new Date(a.published_at || a.date || a.createdAt);
          const dateB = new Date(b.published_at || b.date || b.createdAt);
          return dateB - dateA;
        });
        
        // Apply limit
        if (limit && limit > 0) {
          posts = posts.slice(0, limit);
        }
        
        // Field selection - if specified, return only those fields
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
          // No field selection - return all fields plus generated excerpt
          posts = posts.map(post => ({
            ...post,
            excerpt: generateExcerpt(post.content, excerptLength),
            tags: post.tags || []
          }));
        }
        
        return jsonResponse({ posts });
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
      
      // POST /:blogId/posts/:postId/like - Like a post (public)
      if (route.match(/^posts\/[^/]+\/like$/) && request.method === 'POST') {
        const postId = route.split('/')[1];
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const ipHash = await hashIP(ip + postId); // Hash IP + postId for anonymization
        
        const likesKey = `blog:${blogId}:likes:${postId}`;
        const likesJson = await env.BLOGS.get(likesKey);
        let likes = likesJson ? JSON.parse(likesJson) : { count: 0, ips: [] };
        
        // Check if already liked (soft check, not bulletproof)
        if (!likes.ips.includes(ipHash)) {
          likes.count++;
          likes.ips.push(ipHash);
          // Keep only last 1000 IPs to prevent unbounded growth
          if (likes.ips.length > 1000) likes.ips = likes.ips.slice(-1000);
          await env.BLOGS.put(likesKey, JSON.stringify(likes));
        }
        
        return jsonResponse({ success: true, count: likes.count });
      }
      
      // GET /:blogId/posts/:postId/likes - Get like count (public)
      if (route.match(/^posts\/[^/]+\/likes$/) && request.method === 'GET') {
        const postId = route.split('/')[1];
        const likesJson = await env.BLOGS.get(`blog:${blogId}:likes:${postId}`);
        const likes = likesJson ? JSON.parse(likesJson) : { count: 0 };
        return jsonResponse({ count: likes.count });
      }
      
      // POST /:blogId/subscribe - Subscribe with Courier forwarding
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
        
        // Honeypot check - silently succeed for bots
        if (honeypot) {
          return jsonResponse({ success: true });
        }
        
        // Validate email
        if (!email || !email.includes('@')) {
          return jsonResponse({ error: 'Invalid email' }, 400);
        }
        
        // Get blog config to find Courier list slug
        const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
        const config = configJson ? JSON.parse(configJson) : {};
        
        // Store subscriber in KV as backup
        const subsJson = await env.BLOGS.get(`blog:${blogId}:subscribers`) || '[]';
        const subs = JSON.parse(subsJson);
        if (!subs.includes(email)) {
          subs.push(email);
          await env.BLOGS.put(`blog:${blogId}:subscribers`, JSON.stringify(subs));
        }
        
        // Forward to Courier API
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
        
        // Handle redirect for form submissions
        const referer = request.headers.get('Referer');
        if (referer && !contentType.includes('application/json')) {
          return Response.redirect(referer + '?subscribed=true', 302);
        }
        
        // Return JSON response
        return jsonResponse({ 
          success: true,
          courier: courierSuccess,
          ...(courierError && { courierError })
        });
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
  },

  // Cron trigger handler - runs hourly to publish scheduled posts
  async scheduled(event, env, ctx) {
    console.log('Cron triggered at:', new Date().toISOString());
    
    try {
      // Find all blogs by listing config keys
      const listResult = await env.BLOGS.list({ prefix: 'blog:' });
      const blogIds = [...new Set(
        listResult.keys
          .map(k => k.name.match(/^blog:([^:]+):config$/)?.[1])
          .filter(Boolean)
      )];
      
      const now = new Date();
      const nowIso = now.toISOString();
      let totalPublished = 0;
      let totalEmails = 0;
      
      for (const blogId of blogIds) {
        const postsJson = await env.BLOGS.get(`blog:${blogId}:posts`);
        if (!postsJson) continue;
        
        let posts = JSON.parse(postsJson);
        let updated = false;
        const postsToPublish = [];
        
        // Find scheduled posts that are due
        for (const post of posts) {
          if (post.status === 'scheduled' && post.scheduled_for) {
            const scheduledDate = new Date(post.scheduled_for);
            if (scheduledDate <= now) {
              // Mark for publishing
              post.status = 'published';
              post.published_at = nowIso;
              post.date = nowIso; // backward compat
              post.published = true; // backward compat
              updated = true;
              postsToPublish.push(post);
              totalPublished++;
              console.log(`Publishing scheduled post: ${post.title} (${blogId})`);
            }
          }
        }
        
        // Save updated posts
        if (updated) {
          await env.BLOGS.put(`blog:${blogId}:posts`, JSON.stringify(posts));
          
          // Get config for GitHub and email
          const configJson = await env.BLOGS.get(`blog:${blogId}:config`);
          const config = configJson ? JSON.parse(configJson) : {};
          
          const publishedPosts = posts.filter(p => p.status === 'published' || p.published);
          
          for (const post of postsToPublish) {
            // Push to GitHub
            if (config.githubRepo && config.githubToken) {
              try {
                await publishToGitHub(post, publishedPosts, config, blogId, env);
                console.log(`GitHub push successful: ${post.slug}`);
              } catch (e) {
                console.error(`GitHub push failed for ${post.slug}:`, e);
              }
            }
            
            // Send email via Courier
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

// Publish post to GitHub with full SEO templates
async function publishToGitHub(post, allPublishedPosts, config, blogId, env) {
  const { githubRepo, githubToken } = config;
  const [owner, repo] = githubRepo.split('/');
  
  const workerUrl = env.WORKER_URL || 'https://up-blogs-1.micaiah-tasks.workers.dev';
  
  // Generate post page with full SEO
  const pageHtml = generatePostPage(post, config, blogId, workerUrl);
  await pushToGitHub(owner, repo, `blog/${post.slug}.html`, pageHtml, githubToken);
  
  // Generate index page with full SEO
  const indexHtml = generateBlogIndex(allPublishedPosts, config, blogId);
  await pushToGitHub(owner, repo, 'blog/index.html', indexHtml, githubToken);
  
  // Generate RSS feed
  const feedXml = generateRssFeed(allPublishedPosts, config, blogId);
  await pushToGitHub(owner, repo, 'blog/feed.xml', feedXml, githubToken);
  
  // Generate sitemap
  const sitemapXml = generateSitemap(allPublishedPosts, config, blogId);
  await pushToGitHub(owner, repo, 'sitemap.xml', sitemapXml, githubToken);
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
