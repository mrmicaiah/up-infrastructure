// Blog tools for micaiahbussey.com (email-bot API)

import { z } from "zod";
import type { ToolContext } from '../types';

const BLOG_API_URL = 'https://email-bot-server.micaiah-tasks.workers.dev';
const DEFAULT_SITE = 'micaiah-bussey';

async function blogRequest(env: any, path: string, method: string = 'GET', body?: any) {
  const apiKey = env.COURIER_API_KEY; // Reusing same API key as courier
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
  
  const resp = await fetch(`${BLOG_API_URL}${path}`, options);
  
  if (!resp.ok) {
    const error = await resp.text();
    throw new Error(`Blog API error: ${resp.status} - ${error}`);
  }
  
  return resp.json();
}

export function registerBlogTools(ctx: ToolContext) {
  const { server, env } = ctx;

  // ==================== LIST POSTS ====================

  server.tool("blog_list_posts", {
    status: z.enum(['draft', 'scheduled', 'published', 'all']).optional().describe("Filter by status (default: all)"),
    limit: z.number().optional().default(20).describe("Number of posts to return (max 100)"),
  }, async ({ status, limit }) => {
    try {
      let path = `/api/blog/admin/posts?site=${DEFAULT_SITE}`;
      if (status && status !== 'all') {
        path += `&status=${status}`;
      }
      if (limit) {
        path += `&limit=${limit}`;
      }
      
      const result: any = await blogRequest(env, path);
      
      if (!result.posts?.length) {
        return { content: [{ type: "text", text: "📭 No blog posts found" }] };
      }
      
      let out = `📝 **Blog Posts** (${result.posts.length})\n\n`;
      
      // Show counts if available
      if (result.counts) {
        out += `Drafts: ${result.counts.draft || 0} | Scheduled: ${result.counts.scheduled || 0} | Published: ${result.counts.published || 0}\n\n`;
      }
      
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

  // ==================== GET POST ====================

  server.tool("blog_get_post", {
    post_id: z.string().describe("Post ID"),
  }, async ({ post_id }) => {
    try {
      const result: any = await blogRequest(env, `/api/blog/admin/posts/${post_id}`);
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

  // ==================== CREATE POST ====================

  server.tool("blog_create_post", {
    title: z.string().describe("Post title"),
    content_md: z.string().describe("Post content in Markdown"),
    slug: z.string().optional().describe("URL slug (auto-generated from title if not provided)"),
    excerpt: z.string().optional().describe("Short excerpt/summary"),
    category: z.string().optional().describe("Post category (e.g., 'Craft', 'Process', 'Behind the Scenes')"),
    tags: z.array(z.string()).optional().describe("Array of tags"),
    featured_image: z.string().optional().describe("URL of featured image"),
    author: z.string().optional().default("Micaiah Bussey").describe("Author name"),
    status: z.enum(['draft', 'published']).optional().default('draft').describe("Initial status"),
  }, async ({ title, content_md, slug, excerpt, category, tags, featured_image, author, status }) => {
    try {
      const result: any = await blogRequest(env, '/api/blog/admin/posts', 'POST', {
        title,
        content_md,
        slug,
        excerpt,
        category,
        tags,
        featured_image,
        author,
        status,
        site: DEFAULT_SITE,
      });
      
      let out = `✅ Post created: **${title}**\n\n`;
      out += `ID: ${result.id}\n`;
      out += `Slug: ${result.slug}\n`;
      out += `Status: ${result.status}\n`;
      
      if (result.status === 'draft') {
        out += `\nNext steps:\n`;
        out += `• Publish now: blog_publish_post\n`;
        out += `• Schedule: blog_schedule_post`;
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  // ==================== UPDATE POST ====================

  server.tool("blog_update_post", {
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
      
      await blogRequest(env, `/api/blog/admin/posts/${post_id}`, 'PUT', updates);
      
      return { content: [{ type: "text", text: `✅ Post updated` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  // ==================== DELETE POST ====================

  server.tool("blog_delete_post", {
    post_id: z.string().describe("Post ID to delete"),
  }, async ({ post_id }) => {
    try {
      await blogRequest(env, `/api/blog/admin/posts/${post_id}`, 'DELETE');
      return { content: [{ type: "text", text: `✅ Post deleted` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  // ==================== PUBLISH POST ====================

  server.tool("blog_publish_post", {
    post_id: z.string().describe("Post ID to publish immediately"),
  }, async ({ post_id }) => {
    try {
      const result: any = await blogRequest(env, `/api/blog/admin/posts/${post_id}/publish`, 'POST');
      
      return { content: [{ type: "text", text: `✅ Post published!\n\nPublished at: ${result.published_at}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  // ==================== SCHEDULE POST ====================

  server.tool("blog_schedule_post", {
    post_id: z.string().describe("Post ID to schedule"),
    scheduled_at: z.string().describe("When to publish (ISO 8601 format, e.g., '2026-01-15T09:00:00Z')"),
  }, async ({ post_id, scheduled_at }) => {
    try {
      const result: any = await blogRequest(env, `/api/blog/admin/posts/${post_id}/schedule`, 'POST', {
        scheduled_at,
      });
      
      const date = new Date(scheduled_at);
      const formatted = date.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
      });
      
      return { content: [{ type: "text", text: `⏰ Post scheduled for **${formatted}**` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  // ==================== UNPUBLISH POST ====================

  server.tool("blog_unpublish_post", {
    post_id: z.string().describe("Post ID to unpublish (revert to draft)"),
  }, async ({ post_id }) => {
    try {
      await blogRequest(env, `/api/blog/admin/posts/${post_id}/unpublish`, 'POST');
      return { content: [{ type: "text", text: `✅ Post reverted to draft` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });
}
