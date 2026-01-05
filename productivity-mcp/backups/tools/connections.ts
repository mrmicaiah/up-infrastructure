// Service connection tools

import { z } from "zod";
import type { ToolContext } from '../types';
import { getValidToken, buildOAuthUrl, SERVICE_NAMES } from '../oauth';

export function registerConnectionTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool("connection_status", {}, async () => {
    const driveToken = await getValidToken(env, getCurrentUser(), 'google_drive');
    const personalEmailToken = await getValidToken(env, getCurrentUser(), 'gmail_personal');
    const companyEmailToken = await getValidToken(env, getCurrentUser(), 'gmail_company');
    const bloggerToken = await getValidToken(env, getCurrentUser(), 'blogger');
    const personalContactsToken = await getValidToken(env, getCurrentUser(), 'google_contacts_personal');
    const companyContactsToken = await getValidToken(env, getCurrentUser(), 'google_contacts_company');
    
    let status = '🔌 **Connection Status**\n\n';
    status += driveToken ? '✅ Google Drive: Connected\n' : '❌ Google Drive: Not connected\n';
    status += personalEmailToken ? '✅ Personal Email: Connected\n' : '❌ Personal Email: Not connected\n';
    status += companyEmailToken ? '✅ Company Email: Connected\n' : '❌ Company Email: Not connected\n';
    status += bloggerToken ? '✅ Blogger: Connected\n' : '❌ Blogger: Not connected\n';
    status += personalContactsToken ? '✅ Personal Contacts: Connected\n' : '❌ Personal Contacts: Not connected\n';
    status += companyContactsToken ? '✅ Company Contacts: Connected\n' : '❌ Company Contacts: Not connected\n';
    
    return { content: [{ type: "text", text: status }] };
  });

  server.tool("connect_service", { 
    service: z.enum(['google_drive', 'gmail_personal', 'gmail_company', 'blogger', 'google_contacts_personal', 'google_contacts_company']).describe("Service to connect")
  }, async ({ service }) => {
    const token = await getValidToken(env, getCurrentUser(), service);
    
    if (token) {
      return { content: [{ type: "text", text: `✅ ${service} is already connected!` }] };
    }
    
    const workerName = env.WORKER_NAME || `productivity-${env.USER_ID === 'micaiah' ? 'mcp-server' : env.USER_ID}`;
    const workerUrl = `https://${workerName}.micaiah-tasks.workers.dev`;
    
    const url = buildOAuthUrl(env, getCurrentUser(), service, workerUrl);
    
    const serviceNames: Record<string, string> = {
      'google_drive': 'Google Drive',
      'gmail_personal': 'Personal Gmail (private - only you can see)',
      'gmail_company': 'Company Gmail (shared with team)',
      'blogger': 'Blogger',
      'google_contacts_personal': 'Personal Contacts',
      'google_contacts_company': 'Company Contacts',
    };
    
    return { content: [{ type: "text", text: `🔗 Connect ${serviceNames[service]}:\n\n${url}` }] };
  });

  server.tool("disconnect_service", { 
    service: z.enum(['google_drive', 'gmail_personal', 'gmail_company', 'blogger', 'google_contacts_personal', 'google_contacts_company']).describe("Service to disconnect")
  }, async ({ service }) => {
    const userId = getCurrentUser();
    
    // Check if connected first
    const token = await getValidToken(env, userId, service);
    
    if (!token) {
      return { content: [{ type: "text", text: `⚠️ ${service} is not connected.` }] };
    }
    
    // Delete the token
    await env.DB.prepare(
      'DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?'
    ).bind(userId, service).run();
    
    return { content: [{ type: "text", text: `🔌 Disconnected ${SERVICE_NAMES[service] || service}.\n\nTo reconnect with a different account, run:\n\`connect_service ${service}\`\n\n**Tip:** Open the OAuth link in an incognito window to ensure you sign in with the correct account.` }] };
  });
}
