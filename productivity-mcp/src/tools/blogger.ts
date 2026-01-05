// Blogger tools

import { z } from "zod";
import type { ToolContext } from '../types';
import { getValidToken, BLOGGER_API_URL } from '../oauth';

// Helper to get the correct blogger token
async function getBloggerToken(env: any, userId: string, account: 'personal' | 'company'): Promise<string | null> {
  const provider = account === 'personal' ? 'blogger_personal' : 'blogger_company';
  let token = await getValidToken(env, userId, provider);
  
  // Fallback to legacy 'blogger' token for company account
  if (!token && account === 'company') {
    token = await getValidToken(env, userId, 'blogger');
  }
  
  return token;
}

export function registerBloggerTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool("list_blogs", {
    account: z.enum(['personal', 'company']).optional().default('company').describe("Which Blogger account to use"),
  }, async ({ account }) => {
    const token = await getBloggerToken(env, getCurrentUser(), account);
    
    if (!token) {
      const service = account === 'personal' ? 'blogger_personal' : 'blogger_company';
      return { content: [{ type: "text", text: `⛔ ${account === 'personal' ? 'Personal' : 'Company'} Blogger not connected. Run: connect_service ${service}` }] };
    }
    
    const resp = await fetch(`${BLOGGER_API_URL}/users/self/blogs`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "⛔ Error fetching blogs" }] };
    }
    
    const data: any = await resp.json();
    
    if (!data.items?.length) {
      return { content: [{ type: "text", text: "📝 No blogs found. Create one at blogger.com first." }] };
    }
    
    let out = `📝 **Your Blogs** (${account})\n\n`;
    data.items.forEach((blog: any) => {
      out += `• **${blog.name}**\n  ID: ${blog.id}\n  URL: ${blog.url}\n  Posts: ${blog.posts?.totalItems || 0}\n\n`;
    });
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("list_blog_posts", {
    blog_id: z.string().describe("Blog ID from list_blogs"),
    status: z.enum(['live', 'draft', 'scheduled']).optional().default('live'),
    max_results: z.number().optional().default(10),
    account: z.enum(['personal', 'company']).optional().default('company').describe("Which Blogger account to use"),
  }, async ({ blog_id, status, max_results, account }) => {
    const token = await getBloggerToken(env, getCurrentUser(), account);
    
    if (!token) {
      return { content: [{ type: "text", text: `⛔ ${account === 'personal' ? 'Personal' : 'Company'} Blogger not connected` }] };
    }
    
    const endpoint = status === 'live' 
      ? `${BLOGGER_API_URL}/blogs/${blog_id}/posts?maxResults=${max_results}`
      : `${BLOGGER_API_URL}/blogs/${blog_id}/posts?status=${status}&maxResults=${max_results}`;
    
    const resp = await fetch(endpoint, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "⛔ Error fetching posts" }] };
    }
    
    const data: any = await resp.json();
    
    if (!data.items?.length) {
      return { content: [{ type: "text", text: `No ${status} posts found` }] };
    }
    
    let out = `📄 **${status.charAt(0).toUpperCase() + status.slice(1)} Posts** (${data.items.length}):\n\n`;
    data.items.forEach((post: any) => {
      const date = new Date(post.published || post.updated).toLocaleDateString();
      out += `• **${post.title}**\n  ID: ${post.id}\n  Date: ${date}\n  URL: ${post.url || 'draft'}\n\n`;
    });
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("get_blog_post", {
    blog_id: z.string(),
    post_id: z.string(),
    account: z.enum(['personal', 'company']).optional().default('company').describe("Which Blogger account to use"),
  }, async ({ blog_id, post_id, account }) => {
    const token = await getBloggerToken(env, getCurrentUser(), account);
    
    if (!token) {
      return { content: [{ type: "text", text: `⛔ ${account === 'personal' ? 'Personal' : 'Company'} Blogger not connected` }] };
    }
    
    const resp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/posts/${post_id}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "⛔ Error fetching post" }] };
    }
    
    const post: any = await resp.json();
    
    let out = `📄 **${post.title}**\n\n`;
    out += `Status: ${post.status || 'live'}\n`;
    out += `Published: ${post.published || 'not yet'}\n`;
    out += `URL: ${post.url || 'draft'}\n`;
    out += `Labels: ${post.labels?.join(', ') || 'none'}\n\n`;
    out += `---\n\n${post.content?.slice(0, 3000) || '(empty)'}`;
    if (post.content?.length > 3000) out += '\n\n... (truncated)';
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("create_blog_post", {
    blog_id: z.string().describe("Blog ID from list_blogs"),
    title: z.string(),
    content: z.string().describe("HTML content of the post"),
    labels: z.array(z.string()).optional().describe("Tags/categories"),
    is_draft: z.boolean().optional().default(true).describe("Save as draft (true) or publish immediately (false)"),
    account: z.enum(['personal', 'company']).optional().default('company').describe("Which Blogger account to use"),
  }, async ({ blog_id, title, content, labels, is_draft, account }) => {
    const token = await getBloggerToken(env, getCurrentUser(), account);
    
    if (!token) {
      return { content: [{ type: "text", text: `⛔ ${account === 'personal' ? 'Personal' : 'Company'} Blogger not connected` }] };
    }
    
    const postData: any = { title, content };
    if (labels?.length) postData.labels = labels;
    
    const endpoint = is_draft
      ? `${BLOGGER_API_URL}/blogs/${blog_id}/posts?isDraft=true`
      : `${BLOGGER_API_URL}/blogs/${blog_id}/posts`;
    
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(postData)
    });
    
    if (!resp.ok) {
      const error = await resp.text();
      return { content: [{ type: "text", text: `⛔ Error creating post: ${error}` }] };
    }
    
    const post: any = await resp.json();
    
    const status = is_draft ? 'Draft saved' : 'Published';
    return { content: [{ type: "text", text: `✅ ${status}: "${post.title}"\n\nPost ID: ${post.id}\nURL: ${post.url || 'will be available after publishing'}` }] };
  });

  server.tool("update_blog_post", {
    blog_id: z.string(),
    post_id: z.string(),
    title: z.string().optional(),
    content: z.string().optional().describe("HTML content"),
    labels: z.array(z.string()).optional(),
    account: z.enum(['personal', 'company']).optional().default('company').describe("Which Blogger account to use"),
  }, async ({ blog_id, post_id, title, content, labels, account }) => {
    const token = await getBloggerToken(env, getCurrentUser(), account);
    
    if (!token) {
      return { content: [{ type: "text", text: `⛔ ${account === 'personal' ? 'Personal' : 'Company'} Blogger not connected` }] };
    }
    
    // First get the existing post
    const getResp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/posts/${post_id}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!getResp.ok) {
      return { content: [{ type: "text", text: "⛔ Post not found" }] };
    }
    
    const existing: any = await getResp.json();
    
    // Merge updates
    const postData: any = {
      title: title || existing.title,
      content: content || existing.content,
    };
    if (labels) postData.labels = labels;
    
    const resp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/posts/${post_id}`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(postData)
    });
    
    if (!resp.ok) {
      const error = await resp.text();
      return { content: [{ type: "text", text: `⛔ Error updating post: ${error}` }] };
    }
    
    const post: any = await resp.json();
    return { content: [{ type: "text", text: `✅ Updated: "${post.title}"\n\nURL: ${post.url}` }] };
  });

  server.tool("publish_blog_post", {
    blog_id: z.string(),
    post_id: z.string(),
    account: z.enum(['personal', 'company']).optional().default('company').describe("Which Blogger account to use"),
  }, async ({ blog_id, post_id, account }) => {
    const token = await getBloggerToken(env, getCurrentUser(), account);
    
    if (!token) {
      return { content: [{ type: "text", text: `⛔ ${account === 'personal' ? 'Personal' : 'Company'} Blogger not connected` }] };
    }
    
    const resp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/posts/${post_id}/publish`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      const error = await resp.text();
      return { content: [{ type: "text", text: `⛔ Error publishing: ${error}` }] };
    }
    
    const post: any = await resp.json();
    return { content: [{ type: "text", text: `✅ Published: "${post.title}"\n\nLive at: ${post.url}` }] };
  });

  server.tool("delete_blog_post", {
    blog_id: z.string(),
    post_id: z.string(),
    account: z.enum(['personal', 'company']).optional().default('company').describe("Which Blogger account to use"),
  }, async ({ blog_id, post_id, account }) => {
    const token = await getBloggerToken(env, getCurrentUser(), account);
    
    if (!token) {
      return { content: [{ type: "text", text: `⛔ ${account === 'personal' ? 'Personal' : 'Company'} Blogger not connected` }] };
    }
    
    const resp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/posts/${post_id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      const error = await resp.text();
      return { content: [{ type: "text", text: `⛔ Error deleting: ${error}` }] };
    }
    
    return { content: [{ type: "text", text: `✅ Post deleted` }] };
  });

  server.tool("get_blog_stats", {
    blog_id: z.string().describe("Blog ID from list_blogs"),
    range: z.enum(['7DAYS', '30DAYS', 'ALL']).optional().default('30DAYS'),
    account: z.enum(['personal', 'company']).optional().default('company').describe("Which Blogger account to use"),
  }, async ({ blog_id, range, account }) => {
    const token = await getBloggerToken(env, getCurrentUser(), account);
    
    if (!token) {
      return { content: [{ type: "text", text: `⛔ ${account === 'personal' ? 'Personal' : 'Company'} Blogger not connected` }] };
    }
    
    // Get blog info
    const blogResp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!blogResp.ok) {
      return { content: [{ type: "text", text: "⛔ Blog not found" }] };
    }
    
    const blog: any = await blogResp.json();
    
    // Get pageviews
    const statsResp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/pageviews?range=${range}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    let pageviews = 'N/A';
    if (statsResp.ok) {
      const statsData: any = await statsResp.json();
      if (statsData.counts?.length) {
        const total = statsData.counts.reduce((sum: number, c: any) => sum + parseInt(c.count || 0), 0);
        pageviews = total.toLocaleString();
      }
    }
    
    // Get recent posts for top performers
    const postsResp = await fetch(`${BLOGGER_API_URL}/blogs/${blog_id}/posts?maxResults=10&fetchBodies=false`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    let recentPosts = '';
    if (postsResp.ok) {
      const postsData: any = await postsResp.json();
      if (postsData.items?.length) {
        recentPosts = '\n**Recent Posts:**\n';
        postsData.items.slice(0, 5).forEach((post: any) => {
          const date = new Date(post.published).toLocaleDateString();
          recentPosts += `• ${post.title} (${date})\n`;
        });
      }
    }
    
    const rangeLabel = range === '7DAYS' ? 'Last 7 days' : range === '30DAYS' ? 'Last 30 days' : 'All time';
    
    let out = `📊 **${blog.name} Stats** (${account})\n\n`;
    out += `**Overview:**\n`;
    out += `• Total Posts: ${blog.posts?.totalItems || 0}\n`;
    out += `• Total Pages: ${blog.pages?.totalItems || 0}\n`;
    out += `• Page Views (${rangeLabel}): ${pageviews}\n`;
    out += `• URL: ${blog.url}\n`;
    out += recentPosts;
    
    return { content: [{ type: "text", text: out }] };
  });
}
