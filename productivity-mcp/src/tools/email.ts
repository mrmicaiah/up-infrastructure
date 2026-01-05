// Gmail tools

import { z } from "zod";
import type { ToolContext } from '../types';
import { getValidToken, GMAIL_API_URL, DRIVE_API_URL } from '../oauth';
import { logEvent, updateDailyLog } from '../helpers/intelligence';

/**
 * EMAIL ATTACHMENTS WORKFLOW
 * 
 * To send an email with an attachment:
 * 1. Create/save the file to the Email_Attachments folder:
 *    - Folder ID: 1Vl5harilp08cxZp_Pfw5va4X1HVkKAYJ
 *    - Use save_to_drive with folder_id parameter
 * 2. Call send_email with the attachment_file_id parameter
 * 
 * Example:
 *   1. save_to_drive({ content: "...", filename: "report.pdf", folder_id: "1Vl5harilp08cxZp_Pfw5va4X1HVkKAYJ" })
 *   2. send_email({ to: "...", subject: "...", body: "...", attachment_file_id: "<file_id_from_step_1>" })
 */

const EMAIL_ATTACHMENTS_FOLDER_ID = '1Vl5harilp08cxZp_Pfw5va4X1HVkKAYJ';

export function registerEmailTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool("check_inbox", {
    account: z.enum(['personal', 'company']).describe("Which email account to check"),
    max_results: z.number().optional().default(10),
  }, async ({ account, max_results }) => {
    const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
    const token = await getValidToken(env, getCurrentUser(), provider);
    
    if (!token) {
      return { content: [{ type: "text", text: `⛔ ${account} email not connected. Run: connect_service ${provider}` }] };
    }
    
    const resp = await fetch(`${GMAIL_API_URL}/users/me/messages?maxResults=${max_results}&q=is:unread`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "⛔ Error fetching emails" }] };
    }
    
    const data: any = await resp.json();
    
    if (!data.messages?.length) {
      return { content: [{ type: "text", text: `📭 No unread emails in ${account} inbox` }] };
    }
    
    let out = `📬 **${account.charAt(0).toUpperCase() + account.slice(1)} Inbox** (${data.messages.length} unread):\n\n`;
    
    // Fetch details for each message
    for (const msg of data.messages.slice(0, max_results)) {
      const msgResp = await fetch(`${GMAIL_API_URL}/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, {
        headers: { Authorization: 'Bearer ' + token }
      });
      
      if (msgResp.ok) {
        const msgData: any = await msgResp.json();
        const headers = msgData.payload?.headers || [];
        const from = headers.find((h: any) => h.name === 'From')?.value || 'Unknown';
        const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)';
        out += `• **${subject}**\n  From: ${from}\n  ID: ${msg.id}\n\n`;
      }
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("read_email", {
    account: z.enum(['personal', 'company']),
    message_id: z.string().describe("Email message ID"),
  }, async ({ account, message_id }) => {
    const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
    const token = await getValidToken(env, getCurrentUser(), provider);
    
    if (!token) {
      return { content: [{ type: "text", text: `⛔ ${account} email not connected` }] };
    }
    
    const resp = await fetch(`${GMAIL_API_URL}/users/me/messages/${message_id}?format=full`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "⛔ Error fetching email" }] };
    }
    
    const data: any = await resp.json();
    const headers = data.payload?.headers || [];
    const from = headers.find((h: any) => h.name === 'From')?.value || 'Unknown';
    const to = headers.find((h: any) => h.name === 'To')?.value || 'Unknown';
    const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)';
    const date = headers.find((h: any) => h.name === 'Date')?.value || '';
    
    // Extract body
    let body = '';
    if (data.payload?.body?.data) {
      body = atob(data.payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
    } else if (data.payload?.parts) {
      const textPart = data.payload.parts.find((p: any) => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        body = atob(textPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      }
    }
    
    let out = `📧 **${subject}**\n\n`;
    out += `From: ${from}\n`;
    out += `To: ${to}\n`;
    out += `Date: ${date}\n\n`;
    out += `---\n\n${body.slice(0, 2000)}`;
    if (body.length > 2000) out += '\n\n... (truncated)';
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("search_email", {
    account: z.enum(['personal', 'company']),
    query: z.string().describe("Search query (Gmail search syntax)"),
    max_results: z.number().optional().default(10),
  }, async ({ account, query, max_results }) => {
    const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
    const token = await getValidToken(env, getCurrentUser(), provider);
    
    if (!token) {
      return { content: [{ type: "text", text: `⛔ ${account} email not connected` }] };
    }
    
    const resp = await fetch(`${GMAIL_API_URL}/users/me/messages?maxResults=${max_results}&q=${encodeURIComponent(query)}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "⛔ Error searching emails" }] };
    }
    
    const data: any = await resp.json();
    
    if (!data.messages?.length) {
      return { content: [{ type: "text", text: `No emails found for "${query}"` }] };
    }
    
    let out = `🔍 **Search results for "${query}"** (${data.messages.length}):\n\n`;
    
    for (const msg of data.messages.slice(0, max_results)) {
      const msgResp = await fetch(`${GMAIL_API_URL}/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
        headers: { Authorization: 'Bearer ' + token }
      });
      
      if (msgResp.ok) {
        const msgData: any = await msgResp.json();
        const headers = msgData.payload?.headers || [];
        const from = headers.find((h: any) => h.name === 'From')?.value || 'Unknown';
        const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)';
        out += `• **${subject}**\n  From: ${from}\n  ID: ${msg.id}\n\n`;
      }
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("send_email", {
    account: z.enum(['personal', 'company']),
    to: z.string().describe("Recipient email address"),
    subject: z.string(),
    body: z.string(),
    attachment_file_id: z.string().optional().describe("Google Drive file ID to attach. Save files to Email_Attachments folder (ID: 1Vl5harilp08cxZp_Pfw5va4X1HVkKAYJ) first."),
  }, async ({ account, to, subject, body, attachment_file_id }) => {
    const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
    const token = await getValidToken(env, getCurrentUser(), provider);
    
    if (!token) {
      return { content: [{ type: "text", text: `⛔ ${account} email not connected` }] };
    }
    
    let encodedEmail: string;
    
    if (attachment_file_id) {
      // Need Drive token to fetch the file
      const driveToken = await getValidToken(env, getCurrentUser(), 'google_drive');
      if (!driveToken) {
        return { content: [{ type: "text", text: `⛔ Google Drive not connected. Required for attachments.` }] };
      }
      
      // Get file metadata
      const metaResp = await fetch(`${DRIVE_API_URL}/files/${attachment_file_id}?fields=id,name,mimeType`, {
        headers: { Authorization: 'Bearer ' + driveToken }
      });
      
      if (!metaResp.ok) {
        return { content: [{ type: "text", text: `⛔ Could not find attachment file. Make sure the file ID is correct.` }] };
      }
      
      const fileMeta: any = await metaResp.json();
      
      // Download file content
      const fileResp = await fetch(`${DRIVE_API_URL}/files/${attachment_file_id}?alt=media`, {
        headers: { Authorization: 'Bearer ' + driveToken }
      });
      
      if (!fileResp.ok) {
        return { content: [{ type: "text", text: `⛔ Could not download attachment file.` }] };
      }
      
      const fileBuffer = await fileResp.arrayBuffer();
      const fileBase64 = btoa(String.fromCharCode(...new Uint8Array(fileBuffer)));
      
      // Build multipart MIME message with attachment
      const boundary = `boundary_${crypto.randomUUID().replace(/-/g, '')}`;
      
      const mimeMessage = [
        `To: ${to}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
        '',
        `--${boundary}`,
        `Content-Type: ${fileMeta.mimeType || 'application/octet-stream'}`,
        `Content-Disposition: attachment; filename="${fileMeta.name}"`,
        'Content-Transfer-Encoding: base64',
        '',
        fileBase64,
        '',
        `--${boundary}--`
      ].join('\r\n');
      
      encodedEmail = btoa(unescape(encodeURIComponent(mimeMessage)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    } else {
      // Simple email without attachment
      const email = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        body
      ].join('\r\n');
      
      encodedEmail = btoa(email).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    
    const resp = await fetch(`${GMAIL_API_URL}/users/me/messages/send`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: encodedEmail })
    });
    
    if (!resp.ok) {
      const error = await resp.text();
      return { content: [{ type: "text", text: `⛔ Error sending email: ${error}` }] };
    }
    
    const attachmentNote = attachment_file_id ? ` (with attachment)` : '';
    return { content: [{ type: "text", text: `✅ Email sent to ${to}${attachmentNote}` }] };
  });

  server.tool("email_to_task", {
    account: z.enum(['personal', 'company']),
    message_id: z.string(),
    priority: z.number().min(1).max(5).optional().default(3),
  }, async ({ account, message_id, priority }) => {
    const provider = account === 'personal' ? 'gmail_personal' : 'gmail_company';
    const token = await getValidToken(env, getCurrentUser(), provider);
    
    if (!token) {
      return { content: [{ type: "text", text: `⛔ ${account} email not connected` }] };
    }
    
    // Fetch the email
    const resp = await fetch(`${GMAIL_API_URL}/users/me/messages/${message_id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "⛔ Error fetching email" }] };
    }
    
    const data: any = await resp.json();
    const headers = data.payload?.headers || [];
    const from = headers.find((h: any) => h.name === 'From')?.value || 'Unknown';
    const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)';
    
    // Create task
    const taskId = crypto.randomUUID();
    const ts = new Date().toISOString();
    const taskText = `Reply to: ${subject}`;
    const notes = `From: ${from}\nEmail ID: ${message_id}\nAccount: ${account}`;
    
    await env.DB.prepare(
      'INSERT INTO tasks (id, user_id, text, priority, category, status, created_at, last_touched, notes, focus_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(taskId, getCurrentUser(), taskText, priority, 'Email', 'open', ts, ts, notes, 'low').run();
    
    await logEvent(env, getCurrentUser(), 'created', taskId, { text: taskText, source: 'email', priority });
    await updateDailyLog(env, getCurrentUser(), 'tasks_created');
    
    return { content: [{ type: "text", text: `✅ Created task: "${taskText}"\n\nFrom: ${from}` }] };
  });
}
