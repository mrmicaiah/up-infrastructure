/**
 * Untitled Publishers Email Platform
 * Cloudflare Worker + D1 Database + AWS SES
 * 
 * Refactored modular architecture
 */

import { checkAuth, getCorsHeaders, jsonResponse, CORS_HEADERS } from './lib.js';

// Handler imports
import { handleTrackOpen, handleTrackClick, handlePublicUnsubscribe } from './handlers-tracking.js';
import { handleGetLists, handleCreateList, handleGetList, handleUpdateList, handleArchiveList, handleListStats } from './handlers-lists.js';
import { handleGetListSubscribers, handleAddSubscriber, handleRemoveSubscriber, handleExportListSubscribers, handleImportSubscribers, handleGetSubscribers, handleGetSubscriber, handleUnsubscribeLead } from './handlers-subscribers.js';
import { handleGetSequences, handleCreateSequence, handleGetSequence, handleUpdateSequence, handleDeleteSequence, handleGetSequenceSteps, handleAddSequenceStep, handleUpdateSequenceStep, handleDeleteSequenceStep, handleReorderSequenceSteps, handleEnrollInSequence, handleGetSequenceEnrollments } from './handlers-sequences.js';
import { handleGetEmails, handleCreateEmail, handleGetEmail, handleUpdateEmail, handleDeleteEmail, handleDuplicateEmail, handlePreviewEmail, handleScheduleEmail, handleCancelSchedule, handleSendTestEmail, handleSendEmail, handleEmailStats } from './handlers-emails.js';
import { handleGetTemplates, handleCreateTemplate, handleGetTemplate, handleUpdateTemplate, handleDeleteTemplate, handleDuplicateTemplate } from './handlers-templates.js';
import { handleSubscribe, handleLeadCapture, handleGetLeads, handleExportLeads, handleStats } from './handlers-legacy.js';
import { processSequenceEmails, processScheduledCampaigns, handleProcessSequences } from './cron.js';
import { handleGetPublicPosts, handleGetPublicPost, handleGetPublicCategories, handleGetRSSFeed, handleGetPosts, handleGetPost, handleCreatePost, handleUpdatePost, handleDeletePost, handlePublishPost, handleSchedulePost, handleUnpublishPost, processScheduledPosts } from './handlers-blog.js';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: getCorsHeaders(request) });
    }

    const url = new URL(request.url);
    
    // Debug endpoint
    if (url.pathname === '/debug') {
      const authHeader = request.headers.get('Authorization');
      return jsonResponse({
        hasApiKey: !!env.ADMIN_API_KEY,
        apiKeyLength: env.ADMIN_API_KEY ? env.ADMIN_API_KEY.length : 0,
        hasAwsKey: !!env.AWS_ACCESS_KEY_ID,
        hasAwsSecret: !!env.AWS_SECRET_ACCESS_KEY,
        awsRegion: env.AWS_REGION || 'not set',
        authHeader: authHeader ? authHeader.substring(0, 20) + '...' : null,
        timestamp: new Date().toISOString()
      });
    }
    
    // === PUBLIC ENDPOINTS ===
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
    }
    
    if (url.pathname === '/api/lead' && request.method === 'POST') {
      return handleLeadCapture(request, env);
    }
    
    if (url.pathname === '/api/subscribe' && request.method === 'POST') {
      return handleSubscribe(request, env);
    }
    
    if (url.pathname === '/t/open') {
      return handleTrackOpen(request, env);
    }
    if (url.pathname === '/t/click') {
      return handleTrackClick(request, env);
    }
    if (url.pathname === '/unsubscribe') {
      return handlePublicUnsubscribe(request, env);
    }

    // === PUBLIC BLOG ENDPOINTS ===
    if (url.pathname === '/api/blog/posts' && request.method === 'GET') {
      return handleGetPublicPosts(request, env);
    }
    if (url.pathname.match(/^\/api\/blog\/posts\/[a-zA-Z0-9-]+$/) && request.method === 'GET') {
      const slug = url.pathname.split('/').pop();
      // Check if it looks like a UUID (admin request) vs slug (public request)
      if (slug.match(/^[a-f0-9-]{36}$/)) {
        // This is an admin request by ID, needs auth - fall through to protected section
      } else {
        return handleGetPublicPost(slug, request, env);
      }
    }
    if (url.pathname === '/api/blog/categories' && request.method === 'GET') {
      return handleGetPublicCategories(request, env);
    }
    if (url.pathname === '/api/blog/feed' && request.method === 'GET') {
      return handleGetRSSFeed(request, env);
    }

    // === PROTECTED ENDPOINTS ===
    if (url.pathname.startsWith('/api/')) {
      const authResult = checkAuth(request, env);
      if (!authResult.ok) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
    }
    
    // === MANUAL CRON TRIGGERS ===
    if (url.pathname === '/api/process-sequences' && request.method === 'POST') {
      return handleProcessSequences(request, env);
    }
    
    // === LISTS ===
    if (url.pathname === '/api/lists' && request.method === 'GET') {
      return handleGetLists(request, env);
    }
    if (url.pathname === '/api/lists' && request.method === 'POST') {
      return handleCreateList(request, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+$/) && request.method === 'GET') {
      return handleGetList(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+$/) && request.method === 'PUT') {
      return handleUpdateList(url.pathname.split('/').pop(), request, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+$/) && request.method === 'DELETE') {
      return handleArchiveList(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+\/stats$/) && request.method === 'GET') {
      return handleListStats(url.pathname.split('/')[3], env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+\/subscribers$/) && request.method === 'GET') {
      return handleGetListSubscribers(url.pathname.split('/')[3], request, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+\/subscribers$/) && request.method === 'POST') {
      return handleAddSubscriber(url.pathname.split('/')[3], request, env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+\/subscribers\/[a-zA-Z0-9-]+$/) && request.method === 'DELETE') {
      const parts = url.pathname.split('/');
      return handleRemoveSubscriber(parts[3], parts[5], env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+\/export$/) && request.method === 'GET') {
      return handleExportListSubscribers(url.pathname.split('/')[3], env);
    }
    if (url.pathname.match(/^\/api\/lists\/[a-zA-Z0-9-]+\/import$/) && request.method === 'POST') {
      return handleImportSubscribers(url.pathname.split('/')[3], request, env);
    }

    // === SEQUENCES ===
    if (url.pathname === '/api/sequences' && request.method === 'GET') {
      return handleGetSequences(request, env);
    }
    if (url.pathname === '/api/sequences' && request.method === 'POST') {
      return handleCreateSequence(request, env);
    }
    if (url.pathname.match(/^\/api\/sequences\/[a-zA-Z0-9-]+$/) && request.method === 'GET') {
      return handleGetSequence(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.match(/^\/api\/sequences\/[a-zA-Z0-9-]+$/) && request.method === 'PUT') {
      return handleUpdateSequence(url.pathname.split('/').pop(), request, env);
    }
    if (url.pathname.match(/^\/api\/sequences\/[a-zA-Z0-9-]+$/) && request.method === 'DELETE') {
      return handleDeleteSequence(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.match(/^\/api\/sequences\/[a-zA-Z0-9-]+\/steps$/) && request.method === 'GET') {
      return handleGetSequenceSteps(url.pathname.split('/')[3], env);
    }
    if (url.pathname.match(/^\/api\/sequences\/[a-zA-Z0-9-]+\/steps$/) && request.method === 'POST') {
      return handleAddSequenceStep(url.pathname.split('/')[3], request, env);
    }
    if (url.pathname.match(/^\/api\/sequences\/[a-zA-Z0-9-]+\/steps\/[a-zA-Z0-9-]+$/) && request.method === 'PUT') {
      const parts = url.pathname.split('/');
      return handleUpdateSequenceStep(parts[3], parts[5], request, env);
    }
    if (url.pathname.match(/^\/api\/sequences\/[a-zA-Z0-9-]+\/steps\/[a-zA-Z0-9-]+$/) && request.method === 'DELETE') {
      const parts = url.pathname.split('/');
      return handleDeleteSequenceStep(parts[3], parts[5], env);
    }
    if (url.pathname.match(/^\/api\/sequences\/[a-zA-Z0-9-]+\/steps\/reorder$/) && request.method === 'POST') {
      return handleReorderSequenceSteps(url.pathname.split('/')[3], request, env);
    }
    if (url.pathname.match(/^\/api\/sequences\/[a-zA-Z0-9-]+\/enroll$/) && request.method === 'POST') {
      return handleEnrollInSequence(url.pathname.split('/')[3], request, env);
    }
    if (url.pathname.match(/^\/api\/sequences\/[a-zA-Z0-9-]+\/enrollments$/) && request.method === 'GET') {
      return handleGetSequenceEnrollments(url.pathname.split('/')[3], request, env);
    }

    // === TEMPLATES ===
    if (url.pathname === '/api/templates' && request.method === 'GET') {
      return handleGetTemplates(request, env);
    }
    if (url.pathname === '/api/templates' && request.method === 'POST') {
      return handleCreateTemplate(request, env);
    }
    if (url.pathname.match(/^\/api\/templates\/[a-zA-Z0-9-]+$/) && request.method === 'GET') {
      return handleGetTemplate(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.match(/^\/api\/templates\/[a-zA-Z0-9-]+$/) && request.method === 'PUT') {
      return handleUpdateTemplate(url.pathname.split('/').pop(), request, env);
    }
    if (url.pathname.match(/^\/api\/templates\/[a-zA-Z0-9-]+$/) && request.method === 'DELETE') {
      return handleDeleteTemplate(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.match(/^\/api\/templates\/[a-zA-Z0-9-]+\/duplicate$/) && request.method === 'POST') {
      return handleDuplicateTemplate(url.pathname.split('/')[3], env);
    }

    // === LEGACY LEADS ===
    if (url.pathname === '/api/leads' && request.method === 'GET') {
      return handleGetLeads(request, env);
    }
    if (url.pathname === '/api/leads/export' && request.method === 'GET') {
      return handleExportLeads(request, env);
    }
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      return handleStats(request, env);
    }

    // === SUBSCRIBERS ===
    if (url.pathname === '/api/subscribers' && request.method === 'GET') {
      return handleGetSubscribers(request, env);
    }
    if (url.pathname.match(/^\/api\/subscribers\/\d+$/) && request.method === 'GET') {
      return handleGetSubscriber(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.match(/^\/api\/subscribers\/\d+$/) && request.method === 'DELETE') {
      return handleUnsubscribeLead(url.pathname.split('/').pop(), env);
    }

    // === EMAILS ===
    if (url.pathname === '/api/emails' && request.method === 'GET') {
      return handleGetEmails(request, env);
    }
    if (url.pathname === '/api/emails' && request.method === 'POST') {
      return handleCreateEmail(request, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+$/) && request.method === 'GET') {
      return handleGetEmail(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+$/) && request.method === 'PUT') {
      return handleUpdateEmail(url.pathname.split('/').pop(), request, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+$/) && request.method === 'DELETE') {
      return handleDeleteEmail(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/duplicate$/) && request.method === 'POST') {
      return handleDuplicateEmail(url.pathname.split('/')[3], env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/preview$/) && request.method === 'GET') {
      return handlePreviewEmail(url.pathname.split('/')[3], env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/schedule$/) && request.method === 'POST') {
      return handleScheduleEmail(url.pathname.split('/')[3], request, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/schedule$/) && request.method === 'DELETE') {
      return handleCancelSchedule(url.pathname.split('/')[3], env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/send$/) && request.method === 'POST') {
      return handleSendEmail(url.pathname.split('/')[3], request, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/test$/) && request.method === 'POST') {
      return handleSendTestEmail(url.pathname.split('/')[3], request, env);
    }
    if (url.pathname.match(/^\/api\/emails\/[a-zA-Z0-9-]+\/stats$/) && request.method === 'GET') {
      return handleEmailStats(url.pathname.split('/')[3], env);
    }

    // === BLOG (Admin) ===
    if (url.pathname === '/api/blog/admin/posts' && request.method === 'GET') {
      return handleGetPosts(request, env);
    }
    if (url.pathname === '/api/blog/admin/posts' && request.method === 'POST') {
      return handleCreatePost(request, env);
    }
    if (url.pathname.match(/^\/api\/blog\/admin\/posts\/[a-zA-Z0-9-]+$/) && request.method === 'GET') {
      return handleGetPost(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.match(/^\/api\/blog\/admin\/posts\/[a-zA-Z0-9-]+$/) && request.method === 'PUT') {
      return handleUpdatePost(url.pathname.split('/').pop(), request, env);
    }
    if (url.pathname.match(/^\/api\/blog\/admin\/posts\/[a-zA-Z0-9-]+$/) && request.method === 'DELETE') {
      return handleDeletePost(url.pathname.split('/').pop(), env);
    }
    if (url.pathname.match(/^\/api\/blog\/admin\/posts\/[a-zA-Z0-9-]+\/publish$/) && request.method === 'POST') {
      return handlePublishPost(url.pathname.split('/')[5], env);
    }
    if (url.pathname.match(/^\/api\/blog\/admin\/posts\/[a-zA-Z0-9-]+\/schedule$/) && request.method === 'POST') {
      return handleSchedulePost(url.pathname.split('/')[5], request, env);
    }
    if (url.pathname.match(/^\/api\/blog\/admin\/posts\/[a-zA-Z0-9-]+\/unpublish$/) && request.method === 'POST') {
      return handleUnpublishPost(url.pathname.split('/')[5], env);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processSequenceEmails(env));
    ctx.waitUntil(processScheduledCampaigns(env));
    ctx.waitUntil(processScheduledPosts(env));
  }
};
