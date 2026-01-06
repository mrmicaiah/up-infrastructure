// Courier Email Marketing tools (email-bot API)

import { z } from "zod";
import type { ToolContext } from '../types';

const COURIER_API_URL = 'https://email-bot-server.micaiah-tasks.workers.dev';

async function courierRequest(env: any, path: string, method: string = 'GET', body?: any) {
  const apiKey = env.COURIER_API_KEY;
  if (!apiKey) {
    throw new Error('COURIER_API_KEY not configured');
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
  
  const resp = await fetch(`${COURIER_API_URL}${path}`, options);
  
  if (!resp.ok) {
    const error = await resp.text();
    throw new Error(`Courier API error: ${resp.status} - ${error}`);
  }
  
  return resp.json();
}

export function registerCourierTools(ctx: ToolContext) {
  const { server, env } = ctx;

  // ==================== TEMPLATES ====================

  server.tool("courier_add_template", {
    name: z.string().describe("Template name"),
    subject: z.string().describe("Default email subject line"),
    body_html: z.string().describe("HTML email content"),
    description: z.string().optional().describe("Template description"),
    category: z.string().optional().describe("Template category (e.g., 'editorial', 'promotional', 'transactional')"),
    list_id: z.string().optional().describe("Associate with a specific list"),
  }, async ({ name, subject, body_html, description, category, list_id }) => {
    try {
      const result: any = await courierRequest(env, '/api/templates', 'POST', {
        name,
        subject,
        body_html,
        description,
        category,
        list_id,
      });
      
      return { content: [{ type: "text", text: `✅ Template created: **${name}**\nID: ${result.id}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_list_templates", {
    category: z.string().optional().describe("Filter by category"),
    list_id: z.string().optional().describe("Filter by list"),
  }, async ({ category, list_id }) => {
    try {
      let path = '/api/templates';
      const params = new URLSearchParams();
      if (category) params.append('category', category);
      if (list_id) params.append('list_id', list_id);
      if (params.toString()) path += '?' + params.toString();
      
      const result: any = await courierRequest(env, path);
      
      if (!result.templates?.length) {
        return { content: [{ type: "text", text: "📭 No templates found" }] };
      }
      
      let out = `📧 **Email Templates** (${result.templates.length})\n\n`;
      for (const t of result.templates) {
        out += `• **${t.name}**${t.category ? ` [${t.category}]` : ''}\n`;
        out += `  Subject: ${t.subject || '(none)'}\n`;
        out += `  ID: ${t.id}\n\n`;
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_get_template", {
    template_id: z.string().describe("Template ID"),
  }, async ({ template_id }) => {
    try {
      const result: any = await courierRequest(env, `/api/templates/${template_id}`);
      const t = result.template;
      
      let out = `📧 **${t.name}**\n\n`;
      out += `ID: ${t.id}\n`;
      out += `Category: ${t.category || '(none)'}\n`;
      out += `Subject: ${t.subject || '(none)'}\n`;
      out += `Description: ${t.description || '(none)'}\n`;
      out += `Created: ${t.created_at}\n`;
      out += `Updated: ${t.updated_at}\n\n`;
      out += `---\n\n**HTML Preview:**\n\`\`\`html\n${t.body_html?.slice(0, 500)}${t.body_html?.length > 500 ? '...' : ''}\n\`\`\``;
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_delete_template", {
    template_id: z.string().describe("Template ID"),
  }, async ({ template_id }) => {
    try {
      await courierRequest(env, `/api/templates/${template_id}`, 'DELETE');
      return { content: [{ type: "text", text: `✅ Template deleted` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  // ==================== LISTS ====================

  server.tool("courier_list_lists", {}, async () => {
    try {
      const result: any = await courierRequest(env, '/api/lists');
      
      if (!result.lists?.length) {
        return { content: [{ type: "text", text: "📭 No email lists found" }] };
      }
      
      let out = `📋 **Email Lists** (${result.lists.length})\n\n`;
      for (const l of result.lists) {
        out += `• **${l.name}**${l.status !== 'active' ? ` [${l.status}]` : ''}\n`;
        out += `  From: ${l.from_name} <${l.from_email}>\n`;
        out += `  ID: ${l.id}\n\n`;
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_create_list", {
    name: z.string().describe("List name"),
    from_name: z.string().describe("Sender name"),
    from_email: z.string().describe("Sender email address"),
    description: z.string().optional(),
    reply_to: z.string().optional(),
  }, async ({ name, from_name, from_email, description, reply_to }) => {
    try {
      const result: any = await courierRequest(env, '/api/lists', 'POST', {
        name,
        from_name,
        from_email,
        description,
        reply_to,
      });
      
      return { content: [{ type: "text", text: `✅ List created: **${name}**\nID: ${result.id}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  // ==================== CAMPAIGNS ====================

  server.tool("courier_list_campaigns", {
    status: z.enum(['draft', 'scheduled', 'sent']).optional(),
    list_id: z.string().optional(),
  }, async ({ status, list_id }) => {
    try {
      let path = '/api/emails';
      const params = new URLSearchParams();
      if (status) params.append('status', status);
      if (list_id) params.append('list_id', list_id);
      if (params.toString()) path += '?' + params.toString();
      
      const result: any = await courierRequest(env, path);
      
      if (!result.emails?.length) {
        return { content: [{ type: "text", text: "📭 No campaigns found" }] };
      }
      
      let out = `📨 **Email Campaigns** (${result.emails.length})\n\n`;
      for (const e of result.emails) {
        const statusIcon = e.status === 'sent' ? '✅' : e.status === 'scheduled' ? '⏰' : '📝';
        out += `${statusIcon} **${e.subject}**\n`;
        out += `   Status: ${e.status}${e.sent_count ? ` (sent to ${e.sent_count})` : ''}${e.scheduled_at ? `\n   Scheduled: ${e.scheduled_at}` : ''}\n`;
        out += `   ID: ${e.id}\n\n`;
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_create_campaign", {
    subject: z.string().describe("Email subject line"),
    body_html: z.string().describe("HTML email content"),
    list_id: z.string().optional().describe("Target list ID"),
    title: z.string().optional().describe("Internal title for the campaign"),
    preview_text: z.string().optional().describe("Preview text shown in inbox"),
  }, async ({ subject, body_html, list_id, title, preview_text }) => {
    try {
      const result: any = await courierRequest(env, '/api/emails', 'POST', {
        subject,
        body_html,
        list_id,
        title,
        preview_text,
      });
      
      return { content: [{ type: "text", text: `✅ Campaign created: **${subject}**\nID: ${result.id}\nStatus: draft` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_schedule_campaign", {
    campaign_id: z.string().describe("Campaign ID to schedule"),
    scheduled_at: z.string().describe("When to send (ISO 8601 format, e.g., '2026-01-13T09:00:00Z')"),
  }, async ({ campaign_id, scheduled_at }) => {
    try {
      const result: any = await courierRequest(env, `/api/emails/${campaign_id}/schedule`, 'POST', {
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
      
      return { content: [{ type: "text", text: `⏰ Campaign scheduled for **${formatted}**` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_cancel_schedule", {
    campaign_id: z.string().describe("Campaign ID to unschedule"),
  }, async ({ campaign_id }) => {
    try {
      await courierRequest(env, `/api/emails/${campaign_id}/schedule`, 'DELETE');
      return { content: [{ type: "text", text: `✅ Schedule cancelled - campaign returned to draft` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_send_test", {
    campaign_id: z.string().describe("Campaign ID"),
    email: z.string().describe("Email address to send test to"),
  }, async ({ campaign_id, email }) => {
    try {
      const result: any = await courierRequest(env, `/api/emails/${campaign_id}/test`, 'POST', {
        email,
      });
      
      return { content: [{ type: "text", text: `✅ Test email sent to **${email}**` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_send_now", {
    campaign_id: z.string().describe("Campaign ID to send immediately"),
  }, async ({ campaign_id }) => {
    try {
      const result: any = await courierRequest(env, `/api/emails/${campaign_id}/send`, 'POST');
      
      return { content: [{ type: "text", text: `✅ Campaign sent!\n\nSent: ${result.sent}\nFailed: ${result.failed}\nTotal: ${result.total}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  // ==================== SUBSCRIBERS ====================

  server.tool("courier_list_subscribers", {
    list_id: z.string().optional().describe("Filter by list ID"),
    limit: z.number().optional().default(50),
  }, async ({ list_id, limit }) => {
    try {
      let path = list_id ? `/api/lists/${list_id}/subscribers` : '/api/subscribers';
      path += `?limit=${limit}`;
      
      const result: any = await courierRequest(env, path);
      const subscribers = result.subscribers || result.results || [];
      
      if (!subscribers.length) {
        return { content: [{ type: "text", text: "📭 No subscribers found" }] };
      }
      
      let out = `👥 **Subscribers** (${subscribers.length})\n\n`;
      for (const s of subscribers.slice(0, 20)) {
        out += `• ${s.name || '(no name)'} <${s.email}>\n`;
      }
      if (subscribers.length > 20) {
        out += `\n... and ${subscribers.length - 20} more`;
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_stats", {}, async () => {
    try {
      const result: any = await courierRequest(env, '/api/stats');
      
      let out = `📊 **Email Platform Stats**\n\n`;
      out += `Total Leads: ${result.total_leads || 0}\n`;
      out += `Today: ${result.today || 0}\n`;
      out += `This Week: ${result.this_week || 0}\n`;
      out += `This Month: ${result.this_month || 0}\n`;
      
      if (result.by_source) {
        out += `\n**By Source:**\n`;
        for (const [source, count] of Object.entries(result.by_source)) {
          out += `• ${source}: ${count}\n`;
        }
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });
}
