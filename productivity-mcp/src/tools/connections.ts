// Service connection tools

import { z } from "zod";
import type { ToolContext } from '../types';
import { getValidToken, getGitHubToken, buildOAuthUrl, SERVICE_NAMES } from '../oauth';

export function registerConnectionTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool("connection_status", {}, async () => {
    const driveToken = await getValidToken(env, getCurrentUser(), 'google_drive');
    const personalEmailToken = await getValidToken(env, getCurrentUser(), 'gmail_personal');
    const companyEmailToken = await getValidToken(env, getCurrentUser(), 'gmail_company');
    const bloggerPersonalToken = await getValidToken(env, getCurrentUser(), 'blogger_personal');
    const bloggerCompanyToken = await getValidToken(env, getCurrentUser(), 'blogger_company');
    const personalContactsToken = await getValidToken(env, getCurrentUser(), 'google_contacts_personal');
    const companyContactsToken = await getValidToken(env, getCurrentUser(), 'google_contacts_company');
    const analyticsToken = await getValidToken(env, getCurrentUser(), 'google_analytics');
    const githubToken = await getGitHubToken(env, getCurrentUser());
    
    // Check for legacy 'blogger' token and migrate display
    const legacyBloggerToken = await getValidToken(env, getCurrentUser(), 'blogger');
    
    let status = '🔌 **Connection Status**\n\n';
    status += driveToken ? '✅ Google Drive: Connected\n' : '❌ Google Drive: Not connected\n';
    status += personalEmailToken ? '✅ Personal Email: Connected\n' : '❌ Personal Email: Not connected\n';
    status += companyEmailToken ? '✅ Company Email: Connected\n' : '❌ Company Email: Not connected\n';
    
    // Blogger section - handle legacy and new
    if (legacyBloggerToken && !bloggerCompanyToken) {
      status += '⚠️ Blogger (legacy): Connected - consider reconnecting as blogger_company\n';
    }
    status += bloggerPersonalToken ? '✅ Personal Blogger: Connected\n' : '❌ Personal Blogger: Not connected\n';
    status += bloggerCompanyToken ? '✅ Company Blogger: Connected\n' : '❌ Company Blogger: Not connected\n';
    
    status += personalContactsToken ? '✅ Personal Contacts: Connected\n' : '❌ Personal Contacts: Not connected\n';
    status += companyContactsToken ? '✅ Company Contacts: Connected\n' : '❌ Company Contacts: Not connected\n';
    status += analyticsToken ? '✅ Google Analytics: Connected\n' : '❌ Google Analytics: Not connected\n';
    status += githubToken ? '✅ GitHub: Connected\n' : '❌ GitHub: Not connected\n';
    
    return { content: [{ type: "text", text: status }] };
  });

  server.tool("connect_service", { 
    service: z.enum([
      'google_drive', 
      'gmail_personal', 
      'gmail_company', 
      'blogger',           // Legacy - maps to blogger_company
      'blogger_personal',
      'blogger_company',
      'google_contacts_personal', 
      'google_contacts_company',
      'google_analytics',
      'github'
    ]).describe("Service to connect")
  }, async ({ service }) => {
    // Map legacy 'blogger' to 'blogger_company'
    const actualService = service === 'blogger' ? 'blogger_company' : service;
    
    // Check if already connected
    if (actualService === 'github') {
      const token = await getGitHubToken(env, getCurrentUser());
      if (token) {
        return { content: [{ type: "text", text: `✅ GitHub is already connected!` }] };
      }
    } else {
      const token = await getValidToken(env, getCurrentUser(), actualService);
      if (token) {
        return { content: [{ type: "text", text: `✅ ${SERVICE_NAMES[actualService] || actualService} is already connected!` }] };
      }
    }
    
    const workerName = env.WORKER_NAME || `productivity-${env.USER_ID === 'micaiah' ? 'mcp-server' : env.USER_ID}`;
    const workerUrl = `https://${workerName}.micaiah-tasks.workers.dev`;
    
    const url = buildOAuthUrl(env, getCurrentUser(), actualService, workerUrl);
    
    const serviceNames: Record<string, string> = {
      'google_drive': 'Google Drive',
      'gmail_personal': 'Personal Gmail (private - only you can see)',
      'gmail_company': 'Company Gmail (shared with team)',
      'blogger_personal': 'Personal Blogger (different Google account)',
      'blogger_company': 'Company Blogger (Untitled Publishers account)',
      'google_contacts_personal': 'Personal Contacts',
      'google_contacts_company': 'Company Contacts',
      'google_analytics': 'Google Analytics (read-only access to your GA4 data)',
      'github': 'GitHub (repository access)',
    };
    
    let note = '';
    if (service === 'blogger') {
      note = '\n\n💡 Note: `blogger` now maps to `blogger_company`. Use `blogger_personal` for your personal account.';
    }
    if (actualService === 'blogger_personal') {
      note = '\n\n💡 **Tip:** Open this link in an incognito window to ensure you sign in with your personal Google account (not the Untitled Publishers account).';
    }
    if (actualService === 'google_analytics') {
      note = '\n\n📊 **Setup Required:**\n1. Make sure Google Analytics Data API is enabled in your Google Cloud Console\n2. Sign in with the Google account that has access to your GA4 properties\n3. After connecting, use `analytics_add_property` to add your GA4 property IDs';
    }
    
    return { content: [{ type: "text", text: `🔗 Connect ${serviceNames[actualService] || actualService}:\n\n${url}${note}` }] };
  });

  server.tool("disconnect_service", { 
    service: z.enum([
      'google_drive', 
      'gmail_personal', 
      'gmail_company', 
      'blogger',           // Legacy
      'blogger_personal',
      'blogger_company',
      'google_contacts_personal', 
      'google_contacts_company',
      'google_analytics',
      'github'
    ]).describe("Service to disconnect")
  }, async ({ service }) => {
    const userId = getCurrentUser();
    
    // Map legacy 'blogger' to 'blogger_company'
    const actualService = service === 'blogger' ? 'blogger_company' : service;
    
    // Check if connected first
    let token;
    if (actualService === 'github') {
      token = await getGitHubToken(env, userId);
    } else {
      token = await getValidToken(env, userId, actualService);
    }
    
    if (!token) {
      return { content: [{ type: "text", text: `⚠️ ${SERVICE_NAMES[actualService] || actualService} is not connected.` }] };
    }
    
    // Delete the token
    await env.DB.prepare(
      'DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?'
    ).bind(userId, actualService).run();
    
    return { content: [{ type: "text", text: `🔌 Disconnected ${SERVICE_NAMES[actualService] || actualService}.\n\nTo reconnect with a different account, run:\n\`connect_service ${actualService}\`\n\n**Tip:** Open the OAuth link in an incognito window to ensure you sign in with the correct account.` }] };
  });
}
