/**
 * Blue River Gutters Content Engine
 * 
 * Cloudflare Worker that receives Jobber webhooks and triggers content creation.
 * 
 * Endpoints:
 * - /                     - Service info
 * - /auth/jobber          - Initiates OAuth 2.0 flow with Jobber
 * - /auth/jobber/callback - Handles OAuth callback, stores tokens
 * - /auth/status          - Check Jobber connection status
 * - /auth/google          - Initiates OAuth 2.0 flow with Google (GMB)
 * - /auth/google/callback - Handles Google OAuth callback
 * - /webhook/jobber       - Receives Jobber webhooks (triggers pipeline)
 * - /health               - Health check
 * - /test/pipeline        - Manual pipeline test (dev only)
 * 
 * Version: 1.0.0 - Full pipeline integration
 */

import { runContentPipeline } from './orchestrator.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Route handling
    switch (url.pathname) {
      case '/':
        return handleRoot(request, env);
      
      // Jobber OAuth
      case '/auth/jobber':
        return handleJobberAuth(request, env);
      case '/auth/jobber/callback':
        return handleJobberCallback(request, env);
      case '/auth/status':
        return handleAuthStatus(request, env);
      
      // Google OAuth (for GMB)
      case '/auth/google':
        return handleGoogleAuth(request, env);
      case '/auth/google/callback':
        return handleGoogleCallback(request, env);
      
      // Webhooks
      case '/webhook/jobber':
        return handleJobberWebhook(request, env, ctx);
      
      // Health & Testing
      case '/health':
        return handleHealth(env);
      case '/test/pipeline':
        return handleTestPipeline(request, env);
      
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};

// =============================================================================
// JOBBER OAUTH 2.0 FLOW
// =============================================================================

const JOBBER_AUTH_URL = 'https://api.getjobber.com/api/oauth/authorize';
const JOBBER_TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

async function handleJobberAuth(request, env) {
  if (!env.JOBBER_CLIENT_ID) {
    return new Response(JSON.stringify({
      error: 'Configuration error',
      message: 'JOBBER_CLIENT_ID not configured'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const state = generateState();
  
  if (env.TOKENS) {
    await env.TOKENS.put(`oauth_state:${state}`, 'pending', { expirationTtl: 600 });
  }
  
  const callbackUrl = new URL('/auth/jobber/callback', request.url).toString();
  
  const authUrl = new URL(JOBBER_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', env.JOBBER_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);
  
  console.log('Initiating Jobber OAuth flow');
  
  return Response.redirect(authUrl.toString(), 302);
}

async function handleJobberCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  
  if (error) {
    const errorDescription = url.searchParams.get('error_description') || 'Unknown error';
    return new Response(renderErrorPage('Authorization Denied', errorDescription), {
      status: 400,
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  if (!code || !state) {
    return new Response(renderErrorPage('Invalid Request', 'Missing code or state parameter'), {
      status: 400,
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  if (env.TOKENS) {
    const storedState = await env.TOKENS.get(`oauth_state:${state}`);
    if (!storedState) {
      return new Response(renderErrorPage('Invalid State', 'Authorization session expired.'), {
        status: 400,
        headers: { 'Content-Type': 'text/html' }
      });
    }
    await env.TOKENS.delete(`oauth_state:${state}`);
  }
  
  if (!env.JOBBER_CLIENT_ID || !env.JOBBER_CLIENT_SECRET) {
    return new Response(renderErrorPage('Configuration Error', 'OAuth credentials not configured'), {
      status: 500,
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  const callbackUrl = new URL('/auth/jobber/callback', request.url).toString();
  
  try {
    const tokenResponse = await fetch(JOBBER_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.JOBBER_CLIENT_ID,
        client_secret: env.JOBBER_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: callbackUrl,
      }).toString(),
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token exchange failed:', tokenResponse.status, errorText);
      return new Response(renderErrorPage('Token Exchange Failed', `Status: ${tokenResponse.status}`), {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    const tokens = await tokenResponse.json();
    
    if (env.TOKENS) {
      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type || 'Bearer',
        expires_in: tokens.expires_in,
        created_at: Date.now(),
        expires_at: Date.now() + (tokens.expires_in * 1000),
      };
      await env.TOKENS.put('jobber:tokens', JSON.stringify(tokenData));
      console.log('Jobber tokens stored');
    }
    
    return new Response(renderSuccessPage('Jobber'), {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
    
  } catch (error) {
    console.error('Token exchange error:', error);
    return new Response(renderErrorPage('Connection Error', 'Failed to connect to Jobber API'), {
      status: 500,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

async function handleAuthStatus(request, env) {
  const jobberStatus = await getJobberStatus(env);
  const googleStatus = await getGoogleStatus(env);
  
  return new Response(JSON.stringify({
    jobber: jobberStatus,
    google: googleStatus,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getJobberStatus(env) {
  if (!env.TOKENS) return { connected: false, reason: 'KV not configured' };
  
  const tokenData = await env.TOKENS.get('jobber:tokens', { type: 'json' });
  if (!tokenData) return { connected: false, reason: 'No tokens stored' };
  
  return {
    connected: true,
    expires_at: new Date(tokenData.expires_at).toISOString(),
    is_expired: Date.now() > tokenData.expires_at,
    has_refresh_token: !!tokenData.refresh_token,
  };
}

async function getGoogleStatus(env) {
  if (!env.TOKENS) return { connected: false, reason: 'KV not configured' };
  
  const tokenData = await env.TOKENS.get('google:tokens', { type: 'json' });
  if (!tokenData) return { connected: false, reason: 'No tokens stored' };
  
  return {
    connected: true,
    expires_at: new Date(tokenData.expires_at).toISOString(),
    is_expired: Date.now() > tokenData.expires_at,
    has_refresh_token: !!tokenData.refresh_token,
  };
}

// =============================================================================
// GOOGLE OAUTH 2.0 FLOW (FOR GMB)
// =============================================================================

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/business.manage',
].join(' ');

async function handleGoogleAuth(request, env) {
  if (!env.GOOGLE_CLIENT_ID) {
    return new Response(JSON.stringify({
      error: 'Configuration error',
      message: 'GOOGLE_CLIENT_ID not configured'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const state = generateState();
  
  if (env.TOKENS) {
    await env.TOKENS.put(`google_state:${state}`, 'pending', { expirationTtl: 600 });
  }
  
  const callbackUrl = new URL('/auth/google/callback', request.url).toString();
  
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GOOGLE_SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  
  console.log('Initiating Google OAuth flow');
  
  return Response.redirect(authUrl.toString(), 302);
}

async function handleGoogleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  
  if (error) {
    return new Response(renderErrorPage('Google Authorization Denied', error), {
      status: 400,
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  if (!code || !state) {
    return new Response(renderErrorPage('Invalid Request', 'Missing code or state'), {
      status: 400,
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  if (env.TOKENS) {
    const storedState = await env.TOKENS.get(`google_state:${state}`);
    if (!storedState) {
      return new Response(renderErrorPage('Invalid State', 'Session expired'), {
        status: 400,
        headers: { 'Content-Type': 'text/html' }
      });
    }
    await env.TOKENS.delete(`google_state:${state}`);
  }
  
  const callbackUrl = new URL('/auth/google/callback', request.url).toString();
  
  try {
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: callbackUrl,
      }).toString(),
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Google token exchange failed:', tokenResponse.status, errorText);
      return new Response(renderErrorPage('Token Exchange Failed', `Status: ${tokenResponse.status}`), {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    const tokens = await tokenResponse.json();
    
    if (env.TOKENS) {
      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type || 'Bearer',
        expires_in: tokens.expires_in,
        created_at: Date.now(),
        expires_at: Date.now() + (tokens.expires_in * 1000),
      };
      await env.TOKENS.put('google:tokens', JSON.stringify(tokenData));
      console.log('Google tokens stored');
    }
    
    return new Response(renderSuccessPage('Google Business Profile'), {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
    
  } catch (error) {
    console.error('Google token exchange error:', error);
    return new Response(renderErrorPage('Connection Error', 'Failed to connect to Google'), {
      status: 500,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

// =============================================================================
// TOKEN MANAGEMENT
// =============================================================================

export async function getAccessToken(env) {
  if (!env.TOKENS) throw new Error('TOKENS KV not configured');
  
  const tokenData = await env.TOKENS.get('jobber:tokens', { type: 'json' });
  if (!tokenData) throw new Error('Not connected to Jobber');
  
  // Refresh if expired (with 5 min buffer)
  if (Date.now() > (tokenData.expires_at - 300000)) {
    return await refreshJobberToken(env, tokenData);
  }
  
  return tokenData.access_token;
}

async function refreshJobberToken(env, tokenData) {
  console.log('Refreshing Jobber access token...');
  
  const response = await fetch(JOBBER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.JOBBER_CLIENT_ID,
      client_secret: env.JOBBER_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tokenData.refresh_token,
    }).toString(),
  });
  
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }
  
  const newTokens = await response.json();
  
  const updatedTokenData = {
    access_token: newTokens.access_token,
    refresh_token: newTokens.refresh_token || tokenData.refresh_token,
    token_type: newTokens.token_type || 'Bearer',
    expires_in: newTokens.expires_in,
    created_at: Date.now(),
    expires_at: Date.now() + (newTokens.expires_in * 1000),
  };
  
  await env.TOKENS.put('jobber:tokens', JSON.stringify(updatedTokenData));
  console.log('Token refreshed successfully');
  
  return updatedTokenData.access_token;
}

// =============================================================================
// WEBHOOK HANDLER
// =============================================================================

async function handleJobberWebhook(request, env, ctx) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  
  let payload;
  try {
    payload = await request.json();
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  console.log('=== Jobber Webhook Received ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Event:', payload.event || payload.topic || 'unknown');
  
  // Respond immediately, process in background
  ctx.waitUntil(processWebhookEvent(payload, env));
  
  return new Response(JSON.stringify({
    received: true,
    event: payload.event || 'unknown',
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function processWebhookEvent(payload, env) {
  const eventType = payload.event || payload.topic || 'unknown';
  
  switch (eventType.toLowerCase()) {
    case 'visit_completed':
      await handleVisitCompleted(payload, env);
      break;
    default:
      console.log(`Unhandled event type: ${eventType}`);
  }
}

/**
 * Handle visit_completed webhook - triggers the full content pipeline
 */
async function handleVisitCompleted(payload, env) {
  console.log('=== Visit Completed - Starting Pipeline ===');
  
  const data = payload.data || payload;
  const visitId = data.webHookEvent?.itemId || data.visitId || data.id;
  const jobId = data.webHookEvent?.jobId || data.jobId;
  
  if (!visitId && !jobId) {
    console.error('No visit or job ID found in webhook payload');
    return;
  }
  
  try {
    // Get Jobber access token
    const accessToken = await getAccessToken(env);
    
    // Run the full content pipeline
    const result = await runContentPipeline(visitId, jobId, accessToken, env);
    
    // Store result in KV for debugging
    if (env.TOKENS) {
      const resultKey = `pipeline:${result.jobId}:${Date.now()}`;
      await env.TOKENS.put(resultKey, JSON.stringify(result), {
        expirationTtl: 60 * 60 * 24 * 7, // 7 days
      });
      console.log(`Pipeline result stored: ${resultKey}`);
    }
    
  } catch (error) {
    console.error('Pipeline error:', error);
  }
}

// =============================================================================
// UTILITY ENDPOINTS
// =============================================================================

function handleRoot(request, env) {
  return new Response(JSON.stringify({
    service: 'Blue River Gutters Content Engine',
    version: '1.0.0',
    environment: env.ENVIRONMENT || 'unknown',
    endpoints: {
      health: '/health',
      authJobber: '/auth/jobber',
      authGoogle: '/auth/google',
      authStatus: '/auth/status',
      webhook: '/webhook/jobber',
      testPipeline: '/test/pipeline (dev only)',
    },
    pipeline: {
      steps: [
        '1. Fetch job data from Jobber',
        '2. Process photos through Cloudinary',
        '3. Generate project page content',
        '4. Commit to GitHub',
        '5. Post to Google Business Profile',
        '6. Email social drafts to Adam',
      ],
    },
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function handleHealth(env) {
  return new Response(JSON.stringify({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: env.ENVIRONMENT || 'unknown',
    configured: {
      kv: !!env.TOKENS,
      jobber: !!env.JOBBER_CLIENT_ID,
      google: !!env.GOOGLE_CLIENT_ID,
      github: !!env.GITHUB_TOKEN,
      cloudinary: !!env.CLOUDINARY_API_KEY,
    },
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Manual pipeline test endpoint (dev only)
 * POST /test/pipeline with JSON body { "jobId": "xxx" }
 */
async function handleTestPipeline(request, env) {
  if (env.ENVIRONMENT === 'production') {
    return new Response('Not available in production', { status: 403 });
  }
  
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({
      usage: 'POST /test/pipeline with body { "jobId": "xxx" } or { "visitId": "xxx" }',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const { jobId, visitId } = await request.json();
    
    if (!jobId && !visitId) {
      return new Response(JSON.stringify({ error: 'Provide jobId or visitId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const accessToken = await getAccessToken(env);
    const result = await runContentPipeline(visitId, jobId, accessToken, env);
    
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({
      error: error.message,
      stack: error.stack,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function generateState() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

function renderSuccessPage(service) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Connected to ${service}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .container { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
    .success { color: #22c55e; font-size: 48px; margin-bottom: 20px; }
    h1 { color: #1f2937; margin: 0 0 10px 0; }
    p { color: #6b7280; margin: 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success">✓</div>
    <h1>Connected!</h1>
    <p>Blue River Gutters is now connected to ${service}.</p>
    <p style="margin-top: 20px; font-size: 14px;">You can close this window.</p>
  </div>
</body>
</html>`;
}

function renderErrorPage(title, message) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Error - ${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .container { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
    .error { color: #ef4444; font-size: 48px; margin-bottom: 20px; }
    h1 { color: #1f2937; margin: 0 0 10px 0; }
    p { color: #6b7280; margin: 0; }
    a { color: #3b82f6; }
  </style>
</head>
<body>
  <div class="container">
    <div class="error">✕</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p style="margin-top: 20px;"><a href="/">Back to home</a></p>
  </div>
</body>
</html>`;
}
