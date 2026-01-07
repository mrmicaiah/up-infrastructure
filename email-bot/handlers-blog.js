/**
 * Blog post handlers
 * Manages blog posts for micaiahbussey.com and other sites
 */

import { generateId, generateSlug, jsonResponse } from './lib.js';

// Simple markdown to HTML converter (no external deps)
function parseMarkdown(md) {
  if (!md) return '';
  
  let html = md
    // Escape HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    // Bold and italic
    .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Line breaks and paragraphs
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br>');
  
  // Wrap in paragraph tags
  html = '<p>' + html + '</p>';
  
  // Clean up empty paragraphs
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p>(<h[1-6]>)/g, '$1');
  html = html.replace(/(<\/h[1-6]>)<\/p>/g, '$1');
  
  return html;
}

// ==================== PUBLIC ENDPOINTS ====================

/**
 * Get published posts (public)
 */
export async function handleGetPublicPosts(request, env) {
  try {
    const url = new URL(request.url);
    const site = url.searchParams.get('site') || 'micaiah-bussey';
    const category = url.searchParams.get('category');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 50);
    const offset = parseInt(url.searchParams.get('offset') || '0');
    
    // Include content_html for teasers
    let query = `
      SELECT id, slug, title, excerpt, content_html, category, tags, featured_image, author, published_at, created_at
      FROM blog_posts 
      WHERE site = ? AND status = 'published'
    `;
    const params = [site];
    
    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }
    
    query += ' ORDER BY published_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const results = await env.DB.prepare(query).bind(...params).all();
    
    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM blog_posts WHERE site = ? AND status = 'published'`;
    const countParams = [site];
    if (category) {
      countQuery += ' AND category = ?';
      countParams.push(category);
    }
    const countResult = await env.DB.prepare(countQuery).bind(...countParams).first();
    
    return jsonResponse({
      posts: results.results || [],
      total: countResult?.total || 0,
      limit,
      offset
    }, 200, request);
  } catch (error) {
    console.error('handleGetPublicPosts error:', error);
    return jsonResponse({ error: 'Failed to fetch posts', details: error.message }, 500, request);
  }
}

/**
 * Get single post by slug (public)
 */
export async function handleGetPublicPost(slug, request, env) {
  try {
    const url = new URL(request.url);
    const site = url.searchParams.get('site') || 'micaiah-bussey';
    
    // Simplified query - just check status = published
    const post = await env.DB.prepare(`
      SELECT * FROM blog_posts 
      WHERE site = ? AND slug = ? AND status = 'published'
    `).bind(site, slug).first();
    
    if (!post) {
      return jsonResponse({ error: 'Post not found' }, 404, request);
    }
    
    return jsonResponse({ post }, 200, request);
  } catch (error) {
    console.error('handleGetPublicPost error:', error);
    return jsonResponse({ error: 'Failed to fetch post', details: error.message }, 500, request);
  }
}

/**
 * Get categories with post counts (public)
 */
export async function handleGetPublicCategories(request, env) {
  try {
    const url = new URL(request.url);
    const site = url.searchParams.get('site') || 'micaiah-bussey';
    
    const results = await env.DB.prepare(`
      SELECT category, COUNT(*) as count 
      FROM blog_posts 
      WHERE site = ? AND status = 'published' AND category IS NOT NULL
      GROUP BY category 
      ORDER BY count DESC
    `).bind(site).all();
    
    return jsonResponse({ categories: results.results || [] }, 200, request);
  } catch (error) {
    console.error('handleGetPublicCategories error:', error);
    return jsonResponse({ error: 'Failed to fetch categories', details: error.message }, 500, request);
  }
}

/**
 * RSS feed (public)
 */
export async function handleGetRSSFeed(request, env) {
  try {
    const url = new URL(request.url);
    const site = url.searchParams.get('site') || 'micaiah-bussey';
    
    const posts = await env.DB.prepare(`
      SELECT slug, title, excerpt, content_html, author, published_at 
      FROM blog_posts 
      WHERE site = ? AND status = 'published'
      ORDER BY published_at DESC 
      LIMIT 20
    `).bind(site).all();
    
    // Get site config (could be expanded later)
    const siteConfig = {
      'micaiah-bussey': {
        title: 'Micaiah Bussey - Thriller Writer',
        description: 'Craft insights, process breakdowns, and behind-the-scenes from a thriller writer.',
        link: 'https://micaiahbussey.com/blog',
        author: 'Micaiah Bussey'
      }
    };
    
    const config = siteConfig[site] || siteConfig['micaiah-bussey'];
    
    const rssItems = (posts.results || []).map(post => `
      <item>
        <title><![CDATA[${post.title}]]></title>
        <link>${config.link}/post.html?slug=${post.slug}</link>
        <guid>${config.link}/post.html?slug=${post.slug}</guid>
        <pubDate>${post.published_at ? new Date(post.published_at).toUTCString() : new Date().toUTCString()}</pubDate>
        <description><![CDATA[${post.excerpt || ''}]]></description>
        <author>${post.author || config.author}</author>
      </item>
    `).join('\n');
    
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${config.title}</title>
    <description>${config.description}</description>
    <link>${config.link}</link>
    <atom:link href="${config.link}/api/blog/feed" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${rssItems}
  </channel>
</rss>`;
    
    return new Response(rss, {
      headers: {
        'Content-Type': 'application/rss+xml',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (error) {
    console.error('handleGetRSSFeed error:', error);
    return jsonResponse({ error: 'Failed to generate feed', details: error.message }, 500, request);
  }
}

// ==================== ADMIN ENDPOINTS ====================

/**
 * List all posts (admin)
 */
export async function handleGetPosts(request, env) {
  try {
    const url = new URL(request.url);
    const site = url.searchParams.get('site') || 'micaiah-bussey';
    const status = url.searchParams.get('status'); // draft, scheduled, published, or all
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
    const offset = parseInt(url.searchParams.get('offset') || '0');
    
    let query = 'SELECT * FROM blog_posts WHERE site = ?';
    const params = [site];
    
    if (status && status !== 'all') {
      query += ' AND status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const results = await env.DB.prepare(query).bind(...params).all();
    
    // Get counts by status
    const counts = await env.DB.prepare(`
      SELECT status, COUNT(*) as count 
      FROM blog_posts 
      WHERE site = ?
      GROUP BY status
    `).bind(site).all();
    
    return jsonResponse({
      posts: results.results || [],
      counts: (counts.results || []).reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {}),
      limit,
      offset
    });
  } catch (error) {
    console.error('handleGetPosts error:', error);
    return jsonResponse({ error: 'Failed to fetch posts', details: error.message }, 500);
  }
}

/**
 * Get single post (admin)
 */
export async function handleGetPost(id, env) {
  try {
    const post = await env.DB.prepare('SELECT * FROM blog_posts WHERE id = ?').bind(id).first();
    
    if (!post) {
      return jsonResponse({ error: 'Post not found' }, 404);
    }
    
    return jsonResponse({ post });
  } catch (error) {
    console.error('handleGetPost error:', error);
    return jsonResponse({ error: 'Failed to fetch post', details: error.message }, 500);
  }
}

/**
 * Create post
 */
export async function handleCreatePost(request, env) {
  try {
    const data = await request.json();
    
    if (!data.title) {
      return jsonResponse({ error: 'Title required' }, 400);
    }
    if (!data.content_md) {
      return jsonResponse({ error: 'Content required' }, 400);
    }
    
    const id = generateId();
    const site = data.site || 'micaiah-bussey';
    const slug = data.slug || generateSlug(data.title);
    const now = new Date().toISOString();
    
    // Check slug uniqueness within site
    const existing = await env.DB.prepare(
      'SELECT id FROM blog_posts WHERE site = ? AND slug = ?'
    ).bind(site, slug).first();
    
    if (existing) {
      return jsonResponse({ error: 'Slug already exists for this site' }, 400);
    }
    
    // Convert markdown to HTML
    const content_html = parseMarkdown(data.content_md);
    
    // Determine status and published_at
    let status = data.status || 'draft';
    let published_at = null;
    let scheduled_at = null;
    
    if (status === 'published') {
      published_at = now;
    } else if (status === 'scheduled' && data.scheduled_at) {
      scheduled_at = data.scheduled_at;
    }
    
    await env.DB.prepare(`
      INSERT INTO blog_posts (
        id, site, slug, title, excerpt, content_md, content_html, 
        category, tags, featured_image, author, status, 
        published_at, scheduled_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      site,
      slug,
      data.title,
      data.excerpt || null,
      data.content_md,
      content_html,
      data.category || null,
      data.tags ? JSON.stringify(data.tags) : null,
      data.featured_image || null,
      data.author || 'Micaiah Bussey',
      status,
      published_at,
      scheduled_at,
      now,
      now
    ).run();
    
    return jsonResponse({ 
      success: true, 
      id, 
      slug,
      status,
      message: 'Post created' 
    }, 201);
    
  } catch (error) {
    console.error('Create post error:', error);
    return jsonResponse({ error: 'Failed to create post', details: error.message }, 500);
  }
}

/**
 * Update post
 */
export async function handleUpdatePost(id, request, env) {
  try {
    const data = await request.json();
    
    const post = await env.DB.prepare('SELECT * FROM blog_posts WHERE id = ?').bind(id).first();
    if (!post) {
      return jsonResponse({ error: 'Post not found' }, 404);
    }
    
    // Check slug uniqueness if changing
    if (data.slug && data.slug !== post.slug) {
      const existing = await env.DB.prepare(
        'SELECT id FROM blog_posts WHERE site = ? AND slug = ? AND id != ?'
      ).bind(post.site, data.slug, id).first();
      
      if (existing) {
        return jsonResponse({ error: 'Slug already exists' }, 400);
      }
    }
    
    // Convert markdown if content changed
    let content_html = post.content_html;
    if (data.content_md && data.content_md !== post.content_md) {
      content_html = parseMarkdown(data.content_md);
    }
    
    const now = new Date().toISOString();
    
    await env.DB.prepare(`
      UPDATE blog_posts SET
        slug = ?,
        title = ?,
        excerpt = ?,
        content_md = ?,
        content_html = ?,
        category = ?,
        tags = ?,
        featured_image = ?,
        author = ?,
        updated_at = ?
      WHERE id = ?
    `).bind(
      data.slug !== undefined ? data.slug : post.slug,
      data.title !== undefined ? data.title : post.title,
      data.excerpt !== undefined ? data.excerpt : post.excerpt,
      data.content_md !== undefined ? data.content_md : post.content_md,
      content_html,
      data.category !== undefined ? data.category : post.category,
      data.tags !== undefined ? JSON.stringify(data.tags) : post.tags,
      data.featured_image !== undefined ? data.featured_image : post.featured_image,
      data.author !== undefined ? data.author : post.author,
      now,
      id
    ).run();
    
    return jsonResponse({ success: true, message: 'Post updated' });
    
  } catch (error) {
    console.error('Update post error:', error);
    return jsonResponse({ error: 'Failed to update post', details: error.message }, 500);
  }
}

/**
 * Delete post
 */
export async function handleDeletePost(id, env) {
  try {
    const post = await env.DB.prepare('SELECT * FROM blog_posts WHERE id = ?').bind(id).first();
    if (!post) {
      return jsonResponse({ error: 'Post not found' }, 404);
    }
    
    await env.DB.prepare('DELETE FROM blog_posts WHERE id = ?').bind(id).run();
    
    return jsonResponse({ success: true, message: 'Post deleted' });
  } catch (error) {
    console.error('Delete post error:', error);
    return jsonResponse({ error: 'Failed to delete post', details: error.message }, 500);
  }
}

/**
 * Publish post immediately
 */
export async function handlePublishPost(id, env) {
  try {
    const post = await env.DB.prepare('SELECT * FROM blog_posts WHERE id = ?').bind(id).first();
    if (!post) {
      return jsonResponse({ error: 'Post not found' }, 404);
    }
    
    const now = new Date().toISOString();
    
    await env.DB.prepare(`
      UPDATE blog_posts SET 
        status = 'published', 
        published_at = ?,
        scheduled_at = NULL,
        updated_at = ?
      WHERE id = ?
    `).bind(now, now, id).run();
    
    return jsonResponse({ success: true, message: 'Post published', published_at: now });
  } catch (error) {
    console.error('Publish post error:', error);
    return jsonResponse({ error: 'Failed to publish post', details: error.message }, 500);
  }
}

/**
 * Schedule post for future
 */
export async function handleSchedulePost(id, request, env) {
  try {
    const data = await request.json();
    
    if (!data.scheduled_at) {
      return jsonResponse({ error: 'scheduled_at required' }, 400);
    }
    
    const post = await env.DB.prepare('SELECT * FROM blog_posts WHERE id = ?').bind(id).first();
    if (!post) {
      return jsonResponse({ error: 'Post not found' }, 404);
    }
    
    const scheduledDate = new Date(data.scheduled_at);
    if (scheduledDate <= new Date()) {
      return jsonResponse({ error: 'Scheduled date must be in the future' }, 400);
    }
    
    const now = new Date().toISOString();
    
    await env.DB.prepare(`
      UPDATE blog_posts SET 
        status = 'scheduled', 
        scheduled_at = ?,
        published_at = NULL,
        updated_at = ?
      WHERE id = ?
    `).bind(data.scheduled_at, now, id).run();
    
    return jsonResponse({ success: true, message: 'Post scheduled', scheduled_at: data.scheduled_at });
    
  } catch (error) {
    console.error('Schedule post error:', error);
    return jsonResponse({ error: 'Failed to schedule post', details: error.message }, 500);
  }
}

/**
 * Unpublish post (revert to draft)
 */
export async function handleUnpublishPost(id, env) {
  try {
    const post = await env.DB.prepare('SELECT * FROM blog_posts WHERE id = ?').bind(id).first();
    if (!post) {
      return jsonResponse({ error: 'Post not found' }, 404);
    }
    
    const now = new Date().toISOString();
    
    await env.DB.prepare(`
      UPDATE blog_posts SET 
        status = 'draft', 
        published_at = NULL,
        scheduled_at = NULL,
        updated_at = ?
      WHERE id = ?
    `).bind(now, id).run();
    
    return jsonResponse({ success: true, message: 'Post reverted to draft' });
  } catch (error) {
    console.error('Unpublish post error:', error);
    return jsonResponse({ error: 'Failed to unpublish post', details: error.message }, 500);
  }
}

// ==================== CRON: Process Scheduled Posts ====================

export async function processScheduledPosts(env) {
  try {
    const now = new Date().toISOString();
    
    // Find posts that should be published
    const scheduled = await env.DB.prepare(`
      SELECT id, title FROM blog_posts 
      WHERE status = 'scheduled' AND scheduled_at <= ?
    `).bind(now).all();
    
    let published = 0;
    
    for (const post of (scheduled.results || [])) {
      try {
        await env.DB.prepare(`
          UPDATE blog_posts SET 
            status = 'published',
            published_at = scheduled_at,
            scheduled_at = NULL,
            updated_at = ?
          WHERE id = ?
        `).bind(now, post.id).run();
        
        published++;
        console.log(`Published scheduled post: ${post.title}`);
      } catch (error) {
        console.error(`Failed to publish post ${post.id}:`, error);
      }
    }
    
    return { processed: (scheduled.results || []).length, published };
  } catch (error) {
    console.error('processScheduledPosts error:', error);
    return { processed: 0, published: 0, error: error.message };
  }
}
