// Blog tools 
// Two APIs supported:
// 1. micaiahbussey.com via email-bot API (mb_ prefixed tools)
// 2. Multi-tenant UP Blogs via up-blogs-1 worker (up_blog_ prefixed tools)

import { z } from "zod";
import type { ToolContext } from '../types';

// ================================
// MicaiahBussey.com Blog (email-bot API)
// ================================

const MB_BLOG_API_URL = 'https://email-bot-server.micaiah-tasks.workers.dev';
const MB_DEFAULT_SITE = 'micaiah-bussey';

async function mbBlogRequest(env: any, path: string, method: string = 'GET', body?: any) {
  const apiKey = env.COURIER_API_KEY;
  if (!apiKey) {
    throw new Error('COURIER_API_KEY not configured (needed for blog API auth)');
  }
  
  const options: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const resp = await fetch(`${MB_BLOG_API_URL}${path}`, options);
  
  if (!resp.ok) {
    const error = await resp.text();
    throw new Error(`Blog API error: ${resp.status} - ${error}`);
  }
  
  return resp.json();
}

// ================================
// UP Blogs Multi-Tenant System (up-blogs-1 worker)
// ================================

const UP_BLOGS_API_URL = 'https://up-blogs-1.micaiah-tasks.workers.dev';

async function upBlogsRequest(env: any, blogId: string | null, path: string, method: string = 'GET', body?: any, apiKey?: string) {
  const fullPath = blogId ? `/${blogId}${path}` : path;
  
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };
  
  if (apiKey) {
    (options.headers as Record<string, string>)['Authorization'] = `Bearer ${apiKey}`;
  }
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const resp = await fetch(`${UP_BLOGS_API_URL}${fullPath}`, options);
  
  if (!resp.ok) {
    const error = await resp.text();
    throw new Error(`UP Blogs API error: ${resp.status} - ${error}`);
  }
  
  return resp.json();
}

// Helper to get blog API key from env
function getBlogApiKey(env: any, blogId: string): string | null {
  const specificKey = env[`BLOG_API_KEY_${blogId.toUpperCase().replace(/-/g, '_')}`];
  if (specificKey) return specificKey;
  return env.UP_BLOGS_API_KEY || null;
}

export function registerBlogTools(ctx: ToolContext) {
  const { server, env } = ctx;

  // ========================================
  // UP BLOGS TOOLS (up-blogs-1 worker)
  // ========================================

  // Admin tool: Register a new blog
  server.tool("up_blog_register", {
    blog_id: z.string().describe("URL-safe identifier (e.g., 'micaiah-bussey', 'proverbs-library')"),
    site_name: z.string().describe("Display name for the blog (e.g., 'Micaiah Bussey')"),
    site_url: z.string().describe("Full URL (e.g., 'https://micaiahbussey.com')"),
    site_description: z.string().optional().describe("Blog description for SEO"),
    author_name: z.string().optional().describe("Default author name"),
    author_id: z.string().optional().describe("Author ID from authors table"),
    courier_list_slug: z.string().optional().describe("Courier list slug for email subscriptions"),
    github_repo: z.string().optional().describe("GitHub repo for static publishing (owner/repo format)"),
    github_token: z.string().optional().describe("GitHub token for pushing files"),
    twitter_handle: z.string().optional().describe("Twitter handle for cards (e.g., '@micaiah')"),
    favicon: z.string().optional().describe("Favicon URL"),
    default_image: z.string().optional().describe("Default OG image URL"),
    site_colors: z.object({
      primary: z.string().optional().describe("Primary color hex (e.g., '#2563eb')"),
      lightBg: z.string().optional().describe("Light background color hex (e.g., '#f3f4f6')"),
    }).optional().describe("Site color scheme"),
  }, async ({ blog_id, site_name, site_url, site_description, author_name, author_id, courier_list_slug, github_repo, github_token, twitter_handle, favicon, default_image, site_colors }) => {
    try {
      const adminKey = env.UP_BLOGS_ADMIN_KEY;
      if (!adminKey) {
        return { content: [{ type: "text", text: `⛔ UP_BLOGS_ADMIN_KEY not configured. Set this secret to enable blog registration.` }] };
      }
      
      const payload: any = {
        blog_id,
        site_name,
        site_url,
      };
      
      if (site_description) payload.site_description = site_description;
      if (author_name) payload.author_name = author_name;
      if (author_id) payload.author_id = author_id;
      if (courier_list_slug) payload.courier_list_slug = courier_list_slug;
      if (github_repo) payload.github_repo = github_repo;
      if (github_token) payload.github_token = github_token;
      if (twitter_handle) payload.twitter_handle = twitter_handle;
      if (favicon) payload.favicon = favicon;
      if (default_image) payload.default_image = default_image;
      if (site_colors) payload.site_colors = site_colors;
      
      const result: any = await upBlogsRequest(env, null, '/admin/register', 'POST', payload, adminKey);
      
      let out = `✅ **Blog Registered Successfully!**\n\n`;
      out += `**Blog ID:** ${result.blog_id}\n`;
      out += `**API Key:** \`${result.api_key}\`\n\n`;
      out += `⚠️ **IMPORTANT:** Save this API key now! It cannot be retrieved later.\n\n`;
      out += `To use this blog with MCP tools, set the secret:\n`;
      out += `\`\`\`\n`;
      out += `npx wrangler secret put BLOG_API_KEY_${blog_id.toUpperCase().replace(/-/g, '_')}\n`;
      out += `npx wrangler secret put BLOG_API_KEY_${blog_id.toUpperCase().replace(/-/g, '_')} --config wrangler-irene.jsonc\n`;
      out += `\`\`\`\n`;
      out += `Or set UP_BLOGS_API_KEY if this is your only/default blog.`;
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("up_blog_list_blogs", {}, async () => {
    try {
      const result: any = await upBlogsRequest(env, null, '/blogs');
      if (!result.blogs?.length) {
        return { content: [{ type: "text", text: "📭 No blogs found" }] };
      }
      let out = `📚 **UP Blogs** (${result.blogs.length})\n\n`;
      for (const blog of result.blogs) {
        out += `• **${blog.name}** (${blog.id})\n`;
        if (blog.siteUrl) out += `  URL: ${blog.siteUrl}\n`;
        if (blog.authorName) out += `  Author: ${blog.authorName}\n`;
        out += `  Posts: ${blog.postCount || 0}\n\n`;
      }
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("up_blog_list_posts", {
    blog_id: z.string().describe("Blog ID (e.g., 'micaiah-bussey', 'proverbs-library')"),
    status: z.enum(['draft', 'scheduled', 'published']).optional().describe("Filter by status"),
    limit: z.number().optional().default(20).describe("Max posts to return"),
    fields: z.string().optional().describe("Comma-separated fields to return"),
  }, async ({ blog_id, status, limit, fields }) => {
    try {
      const apiKey = getBlogApiKey(env, blog_id);
      if (!apiKey) {
        return { content: [{ type: "text", text: `⛔ No API key found for blog '${blog_id}'. Set UP_BLOGS_API_KEY or BLOG_API_KEY_${blog_id.toUpperCase().replace(/-/g, '_')} secret.` }] };
      }
      let path = '/posts?';
      if (status) path += `status=${status}&`;
      if (limit) path += `limit=${limit}&`;
      if (fields) path += `fields=${fields}&`;
      const result: any = await upBlogsRequest(env, blog_id, path, 'GET', null, apiKey);
      if (!result.posts?.length) {
        return { content: [{ type: "text", text: `📭 No${status ? ` ${status}` : ''} posts found in '${blog_id}'` }] };
      }
      let out = `📝 **${blog_id} Posts** (${result.posts.length})\n\n`;
      for (const p of result.posts) {
        const statusIcon = p.status === 'published' ? '✅' : p.status === 'scheduled' ? '⏰' : '📝';
        out += `${statusIcon} **${p.title}**\n`;
        out += `   ID: ${p.id}\n`;
        out += `   Slug: ${p.slug}\n`;
        out += `   Status: ${p.status}`;
        if (p.published_at) out += ` | Published: ${p.published_at.split('T')[0]}`;
        if (p.scheduled_for) out += ` | Scheduled: ${p.scheduled_for}`;
        out += `\n`;
        if (p.excerpt) out += `   Excerpt: ${p.excerpt.slice(0, 100)}...\n`;
        if (p.tags?.length) out += `   Tags: ${p.tags.join(', ')}\n`;
        out += `\n`;
      }
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("up_blog_get_post", {
    blog_id: z.string().describe("Blog ID (e.g., 'micaiah-bussey', 'proverbs-library')"),
    slug_or_id: z.string().describe("Post slug or ID"),
  }, async ({ blog_id, slug_or_id }) => {
    try {
      const apiKey = getBlogApiKey(env, blog_id);
      if (!apiKey) {
        return { content: [{ type: "text", text: `⛔ No API key found for blog '${blog_id}'` }] };
      }
      const result: any = await upBlogsRequest(env, blog_id, `/posts/${slug_or_id}`, 'GET', null, apiKey);
      const p = result.post;
      const statusIcon = p.status === 'published' ? '✅' : p.status === 'scheduled' ? '⏰' : '📝';
      let out = `${statusIcon} **${p.title}**\n\n`;
      out += `**ID:** ${p.id}\n`;
      out += `**Slug:** ${p.slug}\n`;
      out += `**Status:** ${p.status}\n`;
      out += `**Author:** ${p.author || 'Unknown'}\n`;
      if (p.author_id) out += `**Author ID:** ${p.author_id}\n`;
      if (p.tags?.length) out += `**Tags:** ${p.tags.join(', ')}\n`;
      if (p.excerpt) out += `**Excerpt:** ${p.excerpt}\n`;
      if (p.image) out += `**Image:** ${p.image}\n`;
      if (p.meta_description) out += `**Meta Description:** ${p.meta_description}\n`;
      if (p.published_at) out += `**Published:** ${p.published_at}\n`;
      if (p.scheduled_for) out += `**Scheduled:** ${p.scheduled_for}\n`;
      out += `**Created:** ${p.createdAt}\n`;
      out += `**Updated:** ${p.updatedAt}\n`;
      out += `\n---\n\n**Content (Markdown):**\n\`\`\`markdown\n${p.content?.slice(0, 2000)}${p.content?.length > 2000 ? '\n...(truncated)' : ''}\n\`\`\``;
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("up_blog_create_post", {
    blog_id: z.string().describe("Blog ID"),
    title: z.string().describe("Post title"),
    content: z.string().describe("Post content (Markdown supported)"),
    author: z.string().optional().describe("Author name"),
    author_id: z.string().optional().describe("Author ID"),
    image: z.string().optional().describe("Featured image URL"),
    featured_image_alt: z.string().optional().describe("Alt text for featured image"),
    meta_description: z.string().optional().describe("SEO meta description"),
    tags: z.array(z.string()).optional().describe("Post tags"),
    status: z.enum(['draft', 'published']).optional().default('draft').describe("Post status"),
    scheduled_for: z.string().optional().describe("ISO datetime for scheduled publishing"),
    send_email: z.boolean().optional().default(true).describe("Send email notification on publish"),
  }, async ({ blog_id, title, content, author, author_id, image, featured_image_alt, meta_description, tags, status, scheduled_for, send_email }) => {
    try {
      const apiKey = getBlogApiKey(env, blog_id);
      if (!apiKey) {
        return { content: [{ type: "text", text: `⛔ No API key found for blog '${blog_id}'` }] };
      }
      const postData: any = { title, content, status, send_email };
      if (author) postData.author = author;
      if (author_id) postData.author_id = author_id;
      if (image) postData.image = image;
      if (featured_image_alt) postData.featured_image_alt = featured_image_alt;
      if (meta_description) postData.meta_description = meta_description;
      if (tags?.length) postData.tags = tags;
      if (scheduled_for) postData.scheduled_for = scheduled_for;
      const result: any = await upBlogsRequest(env, blog_id, '/posts', 'POST', postData, apiKey);
      let out = `✅ Post created: **${result.post.title}**\n\n`;
      out += `ID: ${result.post.id}\n`;
      out += `Slug: ${result.post.slug}\n`;
      out += `Status: ${result.post.status}\n`;
      if (result.published) {
        out += `\n🚀 Post was published immediately!`;
        if (result.email?.sent) out += `\n📧 Email notification sent`;
      } else if (result.post.status === 'scheduled') {
        out += `\n⏰ Scheduled for: ${result.post.scheduled_for}`;
      } else {
        out += `\n📝 Saved as draft`;
      }
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("up_blog_update_post", {
    blog_id: z.string().describe("Blog ID"),
    post_id: z.string().describe("Post ID to update"),
    title: z.string().optional().describe("New title"),
    content: z.string().optional().describe("New content"),
    author: z.string().optional().describe("New author name"),
    image: z.string().optional().describe("New featured image URL"),
    featured_image_alt: z.string().optional().describe("New alt text"),
    meta_description: z.string().optional().describe("New meta description"),
    tags: z.array(z.string()).optional().describe("New tags"),
    status: z.enum(['draft', 'scheduled', 'published']).optional().describe("New status"),
    scheduled_for: z.string().optional().describe("New scheduled datetime"),
    send_email: z.boolean().optional().describe("Send email on publish"),
  }, async ({ blog_id, post_id, title, content, author, image, featured_image_alt, meta_description, tags, status, scheduled_for, send_email }) => {
    try {
      const apiKey = getBlogApiKey(env, blog_id);
      if (!apiKey) {
        return { content: [{ type: "text", text: `⛔ No API key found for blog '${blog_id}'` }] };
      }
      const postData: any = { id: post_id };
      if (title !== undefined) postData.title = title;
      if (content !== undefined) postData.content = content;
      if (author !== undefined) postData.author = author;
      if (image !== undefined) postData.image = image;
      if (featured_image_alt !== undefined) postData.featured_image_alt = featured_image_alt;
      if (meta_description !== undefined) postData.meta_description = meta_description;
      if (tags !== undefined) postData.tags = tags;
      if (status !== undefined) postData.status = status;
      if (scheduled_for !== undefined) postData.scheduled_for = scheduled_for;
      if (send_email !== undefined) postData.send_email = send_email;
      const result: any = await upBlogsRequest(env, blog_id, '/posts', 'POST', postData, apiKey);
      let out = `✅ Post updated: **${result.post.title}**\n\n`;
      out += `Status: ${result.post.status}\n`;
      if (result.published) out += `\n🚀 Post was published!`;
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("up_blog_delete_post", {
    blog_id: z.string().describe("Blog ID"),
    post_id: z.string().describe("Post ID to delete"),
  }, async ({ blog_id, post_id }) => {
    try {
      const apiKey = getBlogApiKey(env, blog_id);
      if (!apiKey) {
        return { content: [{ type: "text", text: `⛔ No API key found for blog '${blog_id}'` }] };
      }
      await upBlogsRequest(env, blog_id, `/posts/${post_id}`, 'DELETE', null, apiKey);
      return { content: [{ type: "text", text: `✅ Post deleted` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("up_blog_publish_post", {
    blog_id: z.string().describe("Blog ID"),
    post_id: z.string().describe("Post ID to publish"),
    send_email: z.boolean().optional().default(true).describe("Send email notification"),
  }, async ({ blog_id, post_id, send_email }) => {
    try {
      const apiKey = getBlogApiKey(env, blog_id);
      if (!apiKey) {
        return { content: [{ type: "text", text: `⛔ No API key found for blog '${blog_id}'` }] };
      }
      const postData = { id: post_id, status: 'published', send_email };
      const result: any = await upBlogsRequest(env, blog_id, '/posts', 'POST', postData, apiKey);
      let out = `✅ Post published: **${result.post.title}**\n\n`;
      out += `Slug: ${result.post.slug}\n`;
      out += `Published at: ${result.post.published_at}\n`;
      if (result.email?.sent) out += `\n📧 Email notification sent`;
      else if (result.email?.reason === 'send_email_disabled') out += `\n📧 Email notification skipped (disabled)`;
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("up_blog_schedule_post", {
    blog_id: z.string().describe("Blog ID"),
    post_id: z.string().describe("Post ID to schedule"),
    scheduled_for: z.string().describe("ISO 8601 datetime (e.g., '2026-01-15T09:00:00Z')"),
    send_email: z.boolean().optional().default(true).describe("Send email when published"),
  }, async ({ blog_id, post_id, scheduled_for, send_email }) => {
    try {
      const apiKey = getBlogApiKey(env, blog_id);
      if (!apiKey) {
        return { content: [{ type: "text", text: `⛔ No API key found for blog '${blog_id}'` }] };
      }
      const postData = { id: post_id, scheduled_for, status: 'scheduled', send_email };
      await upBlogsRequest(env, blog_id, '/posts', 'POST', postData, apiKey);
      const date = new Date(scheduled_for);
      const formatted = date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
      return { content: [{ type: "text", text: `⏰ Post scheduled for **${formatted}**` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  // ========================================
  // MICAIAHBUSSEY.COM BLOG TOOLS (email-bot API)
  // ========================================

  server.tool("mb_list_posts", {
    status: z.enum(['draft', 'scheduled', 'published', 'all']).optional().describe("Filter by status (default: all)"),
    limit: z.number().optional().default(20).describe("Number of posts to return (max 100)"),
  }, async ({ status, limit }) => {
    try {
      let path = `/api/blog/admin/posts?site=${MB_DEFAULT_SITE}`;
      if (status && status !== 'all') path += `&status=${status}`;
      if (limit) path += `&limit=${limit}`;
      const result: any = await mbBlogRequest(env, path);
      if (!result.posts?.length) {
        return { content: [{ type: "text", text: "📭 No blog posts found" }] };
      }
      let out = `📝 **MicaiahBussey.com Blog Posts** (${result.posts.length})\n\n`;
      if (result.counts) out += `Drafts: ${result.counts.draft || 0} | Scheduled: ${result.counts.scheduled || 0} | Published: ${result.counts.published || 0}\n\n`;
      for (const p of result.posts) {
        const statusIcon = p.status === 'published' ? '✅' : p.status === 'scheduled' ? '⏰' : '📝';
        out += `${statusIcon} **${p.title}**\n`;
        out += `   Slug: ${p.slug}\n`;
        out += `   Status: ${p.status}`;
        if (p.published_at) out += ` | Published: ${p.published_at.split('T')[0]}`;
        if (p.scheduled_at) out += ` | Scheduled: ${p.scheduled_at}`;
        out += `\n   Category: ${p.category || '(none)'}\n`;
        out += `   ID: ${p.id}\n\n`;
      }
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("mb_get_post", {
    post_id: z.string().describe("Post ID"),
  }, async ({ post_id }) => {
    try {
      const result: any = await mbBlogRequest(env, `/api/blog/admin/posts/${post_id}`);
      const p = result.post;
      const statusIcon = p.status === 'published' ? '✅' : p.status === 'scheduled' ? '⏰' : '📝';
      let out = `${statusIcon} **${p.title}**\n\n`;
      out += `**ID:** ${p.id}\n`;
      out += `**Slug:** ${p.slug}\n`;
      out += `**Status:** ${p.status}\n`;
      out += `**Category:** ${p.category || '(none)'}\n`;
      out += `**Tags:** ${p.tags ? JSON.parse(p.tags).join(', ') : '(none)'}\n`;
      out += `**Author:** ${p.author || 'Micaiah Bussey'}\n`;
      if (p.excerpt) out += `**Excerpt:** ${p.excerpt}\n`;
      if (p.featured_image) out += `**Image:** ${p.featured_image}\n`;
      if (p.published_at) out += `**Published:** ${p.published_at}\n`;
      if (p.scheduled_at) out += `**Scheduled:** ${p.scheduled_at}\n`;
      out += `**Created:** ${p.created_at}\n`;
      out += `**Updated:** ${p.updated_at}\n`;
      out += `\n---\n\n**Content (Markdown):**\n\`\`\`markdown\n${p.content_md?.slice(0, 2000)}${p.content_md?.length > 2000 ? '\n...(truncated)' : ''}\n\`\`\``;
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("mb_create_post", {
    title: z.string().describe("Post title"),
    content_md: z.string().describe("Post content in Markdown"),
    slug: z.string().optional().describe("URL slug (auto-generated from title if not provided)"),
    excerpt: z.string().optional().describe("Short excerpt/summary"),
    category: z.string().optional().describe("Post category"),
    tags: z.array(z.string()).optional().describe("Array of tags"),
    featured_image: z.string().optional().describe("URL of featured image"),
    author: z.string().optional().default("Micaiah Bussey").describe("Author name"),
    status: z.enum(['draft', 'published']).optional().default('draft').describe("Initial status"),
  }, async ({ title, content_md, slug, excerpt, category, tags, featured_image, author, status }) => {
    try {
      const result: any = await mbBlogRequest(env, '/api/blog/admin/posts', 'POST', {
        title, content_md, slug, excerpt, category, tags, featured_image, author, status, site: MB_DEFAULT_SITE,
      });
      let out = `✅ Post created: **${title}**\n\n`;
      out += `ID: ${result.id}\nSlug: ${result.slug}\nStatus: ${result.status}\n`;
      if (result.status === 'draft') out += `\nNext steps:\n• Publish now: mb_publish_post\n• Schedule: mb_schedule_post`;
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("mb_update_post", {
    post_id: z.string().describe("Post ID to update"),
    title: z.string().optional().describe("New title"),
    content_md: z.string().optional().describe("New content in Markdown"),
    slug: z.string().optional().describe("New URL slug"),
    excerpt: z.string().optional().describe("New excerpt"),
    category: z.string().optional().describe("New category"),
    tags: z.array(z.string()).optional().describe("New tags array"),
    featured_image: z.string().optional().describe("New featured image URL"),
    author: z.string().optional().describe("New author name"),
  }, async ({ post_id, title, content_md, slug, excerpt, category, tags, featured_image, author }) => {
    try {
      const updates: any = {};
      if (title !== undefined) updates.title = title;
      if (content_md !== undefined) updates.content_md = content_md;
      if (slug !== undefined) updates.slug = slug;
      if (excerpt !== undefined) updates.excerpt = excerpt;
      if (category !== undefined) updates.category = category;
      if (tags !== undefined) updates.tags = tags;
      if (featured_image !== undefined) updates.featured_image = featured_image;
      if (author !== undefined) updates.author = author;
      await mbBlogRequest(env, `/api/blog/admin/posts/${post_id}`, 'PUT', updates);
      return { content: [{ type: "text", text: `✅ Post updated` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("mb_delete_post", {
    post_id: z.string().describe("Post ID to delete"),
  }, async ({ post_id }) => {
    try {
      await mbBlogRequest(env, `/api/blog/admin/posts/${post_id}`, 'DELETE');
      return { content: [{ type: "text", text: `✅ Post deleted` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("mb_publish_post", {
    post_id: z.string().describe("Post ID to publish immediately"),
  }, async ({ post_id }) => {
    try {
      const result: any = await mbBlogRequest(env, `/api/blog/admin/posts/${post_id}/publish`, 'POST');
      return { content: [{ type: "text", text: `✅ Post published!\n\nPublished at: ${result.published_at}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("mb_schedule_post", {
    post_id: z.string().describe("Post ID to schedule"),
    scheduled_at: z.string().describe("When to publish (ISO 8601 format)"),
  }, async ({ post_id, scheduled_at }) => {
    try {
      await mbBlogRequest(env, `/api/blog/admin/posts/${post_id}/schedule`, 'POST', { scheduled_at });
      const date = new Date(scheduled_at);
      const formatted = date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
      return { content: [{ type: "text", text: `⏰ Post scheduled for **${formatted}**` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("mb_unpublish_post", {
    post_id: z.string().describe("Post ID to unpublish (revert to draft)"),
  }, async ({ post_id }) => {
    try {
      await mbBlogRequest(env, `/api/blog/admin/posts/${post_id}/unpublish`, 'POST');
      return { content: [{ type: "text", text: `✅ Post reverted to draft` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });
}
