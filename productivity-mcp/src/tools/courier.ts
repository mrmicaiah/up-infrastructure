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
        out += `  Slug: ${l.slug}\n`;
        out += `  From: ${l.from_name} <${l.from_email}>\n`;
        out += `  ID: ${l.id}\n\n`;
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_get_list", {
    list_id: z.string().describe("List ID or slug"),
  }, async ({ list_id }) => {
    try {
      const result: any = await courierRequest(env, `/api/lists/${list_id}`);
      const l = result.list;
      
      let out = `📋 **${l.name}**\n\n`;
      out += `**ID:** ${l.id}\n`;
      out += `**Slug:** ${l.slug}\n`;
      out += `**Status:** ${l.status}\n`;
      out += `**From:** ${l.from_name} <${l.from_email}>\n`;
      if (l.reply_to) out += `**Reply-To:** ${l.reply_to}\n`;
      if (l.description) out += `**Description:** ${l.description}\n`;
      out += `**Created:** ${l.created_at}\n`;
      out += `**Updated:** ${l.updated_at}\n`;
      
      if (l.welcome_sequence_id) {
        out += `\n**Welcome Sequence:** ${l.welcome_sequence_id}`;
      }
      
      // Get subscriber count
      try {
        const subs: any = await courierRequest(env, `/api/lists/${l.id}/subscribers?limit=1`);
        out += `\n**Subscribers:** ${subs.total || subs.subscribers?.length || 0}`;
      } catch (e) {
        // ignore
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_update_list", {
    list_id: z.string().describe("List ID"),
    name: z.string().optional(),
    slug: z.string().optional().describe("URL-safe identifier (e.g., 'micaiah-bussey')"),
    from_name: z.string().optional(),
    from_email: z.string().optional(),
    reply_to: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(['active', 'paused']).optional(),
  }, async ({ list_id, name, slug, from_name, from_email, reply_to, description, status }) => {
    try {
      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (slug !== undefined) updates.slug = slug;
      if (from_name !== undefined) updates.from_name = from_name;
      if (from_email !== undefined) updates.from_email = from_email;
      if (reply_to !== undefined) updates.reply_to = reply_to;
      if (description !== undefined) updates.description = description;
      if (status !== undefined) updates.status = status;
      
      await courierRequest(env, `/api/lists/${list_id}`, 'PUT', updates);
      
      return { content: [{ type: "text", text: `✅ List updated` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_create_list", {
    name: z.string().describe("List name"),
    from_name: z.string().describe("Sender name"),
    from_email: z.string().describe("Sender email address"),
    slug: z.string().optional().describe("URL-safe identifier (auto-generated if not provided)"),
    description: z.string().optional(),
    reply_to: z.string().optional(),
  }, async ({ name, from_name, from_email, slug, description, reply_to }) => {
    try {
      const result: any = await courierRequest(env, '/api/lists', 'POST', {
        name,
        from_name,
        from_email,
        slug,
        description,
        reply_to,
      });
      
      return { content: [{ type: "text", text: `✅ List created: **${name}**\nID: ${result.id}\nSlug: ${result.slug || '(auto-generated)'}` }] };
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
        out += `   List: ${e.list_name || '(all subscribers)'}\n`;
        out += `   ID: ${e.id}\n\n`;
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_get_campaign", {
    campaign_id: z.string().describe("Campaign ID"),
  }, async ({ campaign_id }) => {
    try {
      const result: any = await courierRequest(env, `/api/emails/${campaign_id}`);
      const e = result.email;
      
      const statusIcon = e.status === 'sent' ? '✅' : e.status === 'scheduled' ? '⏰' : '📝';
      
      let out = `${statusIcon} **${e.subject}**\n\n`;
      out += `**ID:** ${e.id}\n`;
      out += `**Status:** ${e.status}\n`;
      out += `**List:** ${e.list_name || '(all subscribers)'}\n`;
      out += `**From:** ${e.from_name || 'Default'} <${e.from_email || 'default'}>\n`;
      if (e.preview_text) out += `**Preview:** ${e.preview_text}\n`;
      if (e.scheduled_at) out += `**Scheduled:** ${e.scheduled_at}\n`;
      if (e.sent_at) out += `**Sent:** ${e.sent_at}\n`;
      if (e.sent_count) out += `**Sent to:** ${e.sent_count} subscribers\n`;
      out += `**Created:** ${e.created_at}\n`;
      out += `**Updated:** ${e.updated_at}\n`;
      
      out += `\n---\n\n**Content Preview:**\n\`\`\`html\n${e.body_html?.slice(0, 1000)}${e.body_html?.length > 1000 ? '\n...(truncated)' : ''}\n\`\`\``;
      
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

  server.tool("courier_update_campaign", {
    campaign_id: z.string().describe("Campaign ID to update"),
    subject: z.string().optional().describe("New subject line"),
    body_html: z.string().optional().describe("New HTML content"),
    list_id: z.string().optional().describe("New target list ID"),
    title: z.string().optional().describe("New internal title"),
    preview_text: z.string().optional().describe("New preview text"),
  }, async ({ campaign_id, subject, body_html, list_id, title, preview_text }) => {
    try {
      const updates: any = {};
      if (subject !== undefined) updates.subject = subject;
      if (body_html !== undefined) updates.body_html = body_html;
      if (list_id !== undefined) updates.list_id = list_id;
      if (title !== undefined) updates.title = title;
      if (preview_text !== undefined) updates.preview_text = preview_text;
      
      await courierRequest(env, `/api/emails/${campaign_id}`, 'PUT', updates);
      
      return { content: [{ type: "text", text: `✅ Campaign updated` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_preview_campaign", {
    campaign_id: z.string().describe("Campaign ID to preview"),
  }, async ({ campaign_id }) => {
    try {
      const result: any = await courierRequest(env, `/api/emails/${campaign_id}/preview`);
      const e = result.email;
      
      let out = `📬 **Campaign Preview**\n\n`;
      out += `**Subject:** ${e.subject}\n`;
      out += `**List:** ${e.list_name || '(all subscribers)'}\n`;
      out += `**From:** ${e.from_name || 'Default'} <${e.from_email || 'default'}>\n`;
      out += `\n**Recipients:** ${result.recipient_count} subscriber${result.recipient_count !== 1 ? 's' : ''}\n`;
      
      if (result.recipient_count === 0) {
        out += `\n⚠️ No subscribers will receive this email! Check the list assignment.`;
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_campaign_stats", {
    campaign_id: z.string().describe("Campaign ID to get stats for"),
  }, async ({ campaign_id }) => {
    try {
      const result: any = await courierRequest(env, `/api/emails/${campaign_id}/stats`);
      const e = result.email;
      const s = result.stats;
      
      let out = `📊 **Campaign Stats: ${e.subject}**\n\n`;
      out += `**Status:** ${e.status}\n`;
      if (e.sent_at) out += `**Sent:** ${e.sent_at}\n`;
      out += `\n`;
      out += `**Sent:** ${s.sent}\n`;
      out += `**Opened:** ${s.opened} (${s.open_rate}%)\n`;
      out += `**Clicked:** ${s.clicked} (${s.click_rate}%)\n`;
      
      if (result.top_links?.length) {
        out += `\n**Top Links:**\n`;
        for (const link of result.top_links) {
          out += `• ${link.url} — ${link.count} clicks\n`;
        }
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_duplicate_campaign", {
    campaign_id: z.string().describe("Campaign ID to duplicate"),
  }, async ({ campaign_id }) => {
    try {
      const result: any = await courierRequest(env, `/api/emails/${campaign_id}/duplicate`, 'POST');
      
      return { content: [{ type: "text", text: `✅ Campaign duplicated\nNew ID: ${result.id}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_schedule_campaign", {
    campaign_id: z.string().describe("Campaign ID to schedule"),
    scheduled_at: z.string().describe("When to send (ISO 8601 format, e.g., '2026-01-13T09:00:00Z' or '2026-01-13T09:00:00-05:00' for EST)"),
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

  // ==================== SEQUENCES ====================

  server.tool("courier_list_sequences", {
    list_id: z.string().optional().describe("Filter by list ID"),
    status: z.enum(['draft', 'active', 'paused']).optional(),
  }, async ({ list_id, status }) => {
    try {
      let path = '/api/sequences';
      const params = new URLSearchParams();
      if (list_id) params.append('list_id', list_id);
      if (status) params.append('status', status);
      if (params.toString()) path += '?' + params.toString();
      
      const result: any = await courierRequest(env, path);
      
      if (!result.sequences?.length) {
        return { content: [{ type: "text", text: "📭 No sequences found" }] };
      }
      
      let out = `🔄 **Email Sequences** (${result.sequences.length})\n\n`;
      for (const s of result.sequences) {
        const statusIcon = s.status === 'active' ? '✅' : s.status === 'paused' ? '⏸️' : '📝';
        out += `${statusIcon} **${s.name}**\n`;
        out += `   List: ${s.list_name}\n`;
        out += `   Trigger: ${s.trigger_type}${s.trigger_value ? ` (${s.trigger_value})` : ''}\n`;
        out += `   Steps: ${s.step_count || 0} | Active: ${s.active_enrollments || 0}\n`;
        out += `   ID: ${s.id}\n\n`;
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_get_sequence", {
    sequence_id: z.string().describe("Sequence ID"),
  }, async ({ sequence_id }) => {
    try {
      const result: any = await courierRequest(env, `/api/sequences/${sequence_id}`);
      const s = result.sequence;
      const stats = result.stats;
      
      const statusIcon = s.status === 'active' ? '✅' : s.status === 'paused' ? '⏸️' : '📝';
      
      let out = `${statusIcon} **${s.name}**\n\n`;
      out += `**ID:** ${s.id}\n`;
      out += `**Status:** ${s.status}\n`;
      out += `**List:** ${s.list_name}\n`;
      out += `**Trigger:** ${s.trigger_type}${s.trigger_value ? ` (${s.trigger_value})` : ''}\n`;
      if (s.description) out += `**Description:** ${s.description}\n`;
      out += `\n**Enrollments:**\n`;
      out += `• Total: ${stats.total_enrollments}\n`;
      out += `• Active: ${stats.active}\n`;
      out += `• Completed: ${stats.completed}\n`;
      out += `• Cancelled: ${stats.cancelled}\n`;
      
      if (result.steps?.length) {
        out += `\n**Steps:**\n`;
        for (const step of result.steps) {
          const delayText = step.delay_minutes === 0 ? 'Immediately' : 
            step.delay_minutes < 60 ? `${step.delay_minutes}m` :
            step.delay_minutes < 1440 ? `${Math.round(step.delay_minutes / 60)}h` :
            `${Math.round(step.delay_minutes / 1440)}d`;
          out += `${step.position}. [${delayText}] ${step.subject}${step.status !== 'active' ? ` (${step.status})` : ''}\n`;
        }
      } else {
        out += `\n⚠️ No steps configured yet.`;
      }
      
      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_create_sequence", {
    name: z.string().describe("Sequence name"),
    list_id: z.string().describe("List ID this sequence belongs to"),
    description: z.string().optional(),
    trigger_type: z.enum(['subscribe', 'manual', 'tag']).optional().default('subscribe').describe("What triggers enrollment: subscribe (auto on join), manual, or tag"),
    trigger_value: z.string().optional().describe("For tag trigger: which tag triggers enrollment"),
  }, async ({ name, list_id, description, trigger_type, trigger_value }) => {
    try {
      const result: any = await courierRequest(env, '/api/sequences', 'POST', {
        name,
        list_id,
        description,
        trigger_type,
        trigger_value,
      });
      
      return { content: [{ type: "text", text: `✅ Sequence created: **${name}**\nID: ${result.id}\nStatus: draft\n\nNext: Add steps with courier_add_sequence_step` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_update_sequence", {
    sequence_id: z.string().describe("Sequence ID"),
    name: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(['draft', 'active', 'paused']).optional().describe("Set to 'active' to start auto-enrolling new subscribers"),
    trigger_type: z.enum(['subscribe', 'manual', 'tag']).optional(),
    trigger_value: z.string().optional(),
  }, async ({ sequence_id, name, description, status, trigger_type, trigger_value }) => {
    try {
      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (status !== undefined) updates.status = status;
      if (trigger_type !== undefined) updates.trigger_type = trigger_type;
      if (trigger_value !== undefined) updates.trigger_value = trigger_value;
      
      await courierRequest(env, `/api/sequences/${sequence_id}`, 'PUT', updates);
      
      let message = '✅ Sequence updated';
      if (status === 'active') {
        message += '\n\n🟢 Sequence is now ACTIVE - new subscribers will be auto-enrolled';
      }
      
      return { content: [{ type: "text", text: message }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_delete_sequence", {
    sequence_id: z.string().describe("Sequence ID"),
  }, async ({ sequence_id }) => {
    try {
      await courierRequest(env, `/api/sequences/${sequence_id}`, 'DELETE');
      return { content: [{ type: "text", text: `✅ Sequence deleted` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  // ==================== SEQUENCE STEPS ====================

  server.tool("courier_add_sequence_step", {
    sequence_id: z.string().describe("Sequence ID"),
    subject: z.string().describe("Email subject line"),
    body_html: z.string().describe("HTML email content"),
    delay_minutes: z.number().optional().default(0).describe("Minutes to wait before sending (0 = immediately, 1440 = 1 day, 10080 = 1 week)"),
    preview_text: z.string().optional(),
  }, async ({ sequence_id, subject, body_html, delay_minutes, preview_text }) => {
    try {
      const result: any = await courierRequest(env, `/api/sequences/${sequence_id}/steps`, 'POST', {
        subject,
        body_html,
        delay_minutes,
        preview_text,
      });
      
      const delayText = delay_minutes === 0 ? 'immediately' : 
        delay_minutes < 60 ? `after ${delay_minutes} minutes` :
        delay_minutes < 1440 ? `after ${Math.round(delay_minutes / 60)} hours` :
        `after ${Math.round(delay_minutes / 1440)} days`;
      
      return { content: [{ type: "text", text: `✅ Step ${result.position} added: **${subject}**\nSends: ${delayText}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_update_sequence_step", {
    sequence_id: z.string().describe("Sequence ID"),
    step_id: z.string().describe("Step ID"),
    subject: z.string().optional(),
    body_html: z.string().optional(),
    delay_minutes: z.number().optional(),
    preview_text: z.string().optional(),
    status: z.enum(['active', 'paused']).optional(),
  }, async ({ sequence_id, step_id, subject, body_html, delay_minutes, preview_text, status }) => {
    try {
      const updates: any = {};
      if (subject !== undefined) updates.subject = subject;
      if (body_html !== undefined) updates.body_html = body_html;
      if (delay_minutes !== undefined) updates.delay_minutes = delay_minutes;
      if (preview_text !== undefined) updates.preview_text = preview_text;
      if (status !== undefined) updates.status = status;
      
      await courierRequest(env, `/api/sequences/${sequence_id}/steps/${step_id}`, 'PUT', updates);
      
      return { content: [{ type: "text", text: `✅ Step updated` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_delete_sequence_step", {
    sequence_id: z.string().describe("Sequence ID"),
    step_id: z.string().describe("Step ID"),
  }, async ({ sequence_id, step_id }) => {
    try {
      await courierRequest(env, `/api/sequences/${sequence_id}/steps/${step_id}`, 'DELETE');
      return { content: [{ type: "text", text: `✅ Step deleted` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_reorder_sequence_steps", {
    sequence_id: z.string().describe("Sequence ID"),
    step_ids: z.array(z.string()).describe("Array of step IDs in desired order"),
  }, async ({ sequence_id, step_ids }) => {
    try {
      await courierRequest(env, `/api/sequences/${sequence_id}/steps/reorder`, 'POST', {
        step_ids,
      });
      return { content: [{ type: "text", text: `✅ Steps reordered` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  // ==================== SEQUENCE ENROLLMENTS ====================

  server.tool("courier_enroll_in_sequence", {
    sequence_id: z.string().describe("Sequence ID"),
    email: z.string().describe("Email address to enroll"),
  }, async ({ sequence_id, email }) => {
    try {
      const result: any = await courierRequest(env, `/api/sequences/${sequence_id}/enroll`, 'POST', {
        email,
      });
      
      return { content: [{ type: "text", text: `✅ Enrolled **${email}** in sequence\nEnrollment ID: ${result.enrollment_id}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `⛔ ${e.message}` }] };
    }
  });

  server.tool("courier_sequence_enrollments", {
    sequence_id: z.string().describe("Sequence ID"),
    status: z.enum(['active', 'completed', 'cancelled']).optional(),
    limit: z.number().optional().default(50),
  }, async ({ sequence_id, status, limit }) => {
    try {
      let path = `/api/sequences/${sequence_id}/enrollments`;
      const params = new URLSearchParams();
      if (status) params.append('status', status);
      params.append('limit', String(limit));
      path += '?' + params.toString();
      
      const result: any = await courierRequest(env, path);
      
      if (!result.enrollments?.length) {
        return { content: [{ type: "text", text: "📭 No enrollments found" }] };
      }
      
      let out = `👥 **Sequence Enrollments** (${result.enrollments.length})\n\n`;
      for (const e of result.enrollments) {
        const statusIcon = e.status === 'active' ? '🟢' : e.status === 'completed' ? '✅' : '❌';
        out += `${statusIcon} ${e.name || '(no name)'} <${e.email}>\n`;
        out += `   Step: ${e.current_step} | Enrolled: ${e.enrolled_at?.split('T')[0]}\n`;
      }
      
      return { content: [{ type: "text", text: out }] };
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
