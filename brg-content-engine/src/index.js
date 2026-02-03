/**
 * Blue River Gutters Content Engine
 * 
 * Cloudflare Worker that receives Jobber webhooks and triggers content creation.
 * 
 * Endpoints:
 * - /auth/jobber          - Initiates OAuth 2.0 flow with Jobber
 * - /auth/jobber/callback - Handles OAuth callback, stores tokens
 * - /webhook/jobber       - Receives Jobber webhooks
 * - /health               - Health check
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Route handling
    switch (url.pathname) {
      case '/':
        return handleRoot(request, env);
      
      case '/auth/jobber':
        return handleJobberAuth(request, env);
      
      case '/auth/jobber/callback':
        return handleJobberCallback(request, env);
      
      case '/auth/status':
        return handleAuthStatus(request, env);
      
      case '/webhook/jobber':
        return handleJobberWebhook(request, env, ctx);
      
      case '/health':
        return handleHealth(env);
      
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};

// =============================================================================
// OAUTH 2.0 FLOW
// =============================================================================

/**
 * Jobber OAuth configuration
 */
const JOBBER_AUTH_URL = 'https://api.getjobber.com/api/oauth/authorize';
const JOBBER_TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

/**
 * Initiate OAuth 2.0 flow with Jobber
 * GET /auth/jobber
 * 
 * Redirects user to Jobber's authorization page
 */
async function handleJobberAuth(request, env) {
  // Verify required secrets are configured
  if (!env.JOBBER_CLIENT_ID) {
    return new Response(JSON.stringify({
      error: 'Configuration error',
      message: 'JOBBER_CLIENT_ID not configured'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Generate state parameter for CSRF protection
  const state = generateState();
  
  // Store state in KV for validation during callback (expires in 10 minutes)
  if (env.TOKENS) {
    await env.TOKENS.put(`oauth_state:${state}`, 'pending', { expirationTtl: 600 });
  }
  
  // Build the callback URL based on the current request
  const callbackUrl = new URL('/auth/jobber/callback', request.url).toString();
  
  // Build Jobber authorization URL
  const authUrl = new URL(JOBBER_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', env.JOBBER_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);
  
  console.log('Initiating Jobber OAuth flow');
  console.log('Callback URL:', callbackUrl);
  
  // Redirect user to Jobber
  return Response.redirect(authUrl.toString(), 302);
}

/**
 * Handle OAuth callback from Jobber
 * GET /auth/jobber/callback?code=xxx&state=xxx
 * 
 * Exchanges authorization code for access/refresh tokens
 */
async function handleJobberCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  
  // Handle error from Jobber
  if (error) {
    const errorDescription = url.searchParams.get('error_description') || 'Unknown error';
    console.error('Jobber OAuth error:', error, errorDescription);
    return new Response(renderErrorPage('Authorization Denied', errorDescription), {
      status: 400,
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  // Validate required parameters
  if (!code || !state) {
    return new Response(renderErrorPage('Invalid Request', 'Missing code or state parameter'), {
      status: 400,
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  // Validate state parameter (CSRF protection)
  if (env.TOKENS) {
    const storedState = await env.TOKENS.get(`oauth_state:${state}`);
    if (!storedState) {
      console.error('Invalid or expired state parameter');
      return new Response(renderErrorPage('Invalid State', 'Authorization session expired. Please try again.'), {
        status: 400,
        headers: { 'Content-Type': 'text/html' }
      });
    }
    // Clean up used state
    await env.TOKENS.delete(`oauth_state:${state}`);
  }
  
  // Verify required secrets
  if (!env.JOBBER_CLIENT_ID || !env.JOBBER_CLIENT_SECRET) {
    return new Response(renderErrorPage('Configuration Error', 'OAuth credentials not configured'), {
      status: 500,
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  // Build callback URL (must match what we sent in the auth request)
  const callbackUrl = new URL('/auth/jobber/callback', request.url).toString();
  
  // Exchange authorization code for tokens
  try {
    const tokenResponse = await fetch(JOBBER_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
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
      return new Response(renderErrorPage('Token Exchange Failed', `Failed to get access token: ${tokenResponse.status}`), {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    const tokens = await tokenResponse.json();
    
    console.log('Token exchange successful');
    console.log('Token type:', tokens.token_type);
    console.log('Expires in:', tokens.expires_in, 'seconds');
    
    // Store tokens in KV
    if (env.TOKENS) {
      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type || 'Bearer',
        expires_in: tokens.expires_in,
        created_at: Date.now(),
        expires_at: Date.now() + (tokens.expires_in * 1000),
      };
      
      // Store as the primary Jobber connection
      await env.TOKENS.put('jobber:tokens', JSON.stringify(tokenData));
      
      console.log('Tokens stored in KV');
    } else {
      console.warn('TOKENS KV namespace not configured - tokens not persisted!');
    }
    
    // Success page
    return new Response(renderSuccessPage(), {
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

/**
 * Check authorization status
 * GET /auth/status
 */
async function handleAuthStatus(request, env) {
  if (!env.TOKENS) {
    return new Response(JSON.stringify({
      connected: false,
      reason: 'KV namespace not configured'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const tokenData = await env.TOKENS.get('jobber:tokens', { type: 'json' });
  
  if (!tokenData) {
    return new Response(JSON.stringify({
      connected: false,
      reason: 'No tokens stored'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const isExpired = Date.now() > tokenData.expires_at;
  
  return new Response(JSON.stringify({
    connected: true,
    token_type: tokenData.token_type,
    expires_at: new Date(tokenData.expires_at).toISOString(),
    is_expired: isExpired,
    has_refresh_token: !!tokenData.refresh_token,
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Refresh access token using refresh token
 * Called internally when access token is expired
 */
async function refreshAccessToken(env) {
  if (!env.TOKENS) {
    throw new Error('TOKENS KV namespace not configured');
  }
  
  const tokenData = await env.TOKENS.get('jobber:tokens', { type: 'json' });
  
  if (!tokenData || !tokenData.refresh_token) {
    throw new Error('No refresh token available');
  }
  
  console.log('Refreshing access token...');
  
  const response = await fetch(JOBBER_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: env.JOBBER_CLIENT_ID,
      client_secret: env.JOBBER_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tokenData.refresh_token,
    }).toString(),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('Token refresh failed:', response.status, errorText);
    throw new Error(`Token refresh failed: ${response.status}`);
  }
  
  const newTokens = await response.json();
  
  // Update stored tokens
  const updatedTokenData = {
    access_token: newTokens.access_token,
    refresh_token: newTokens.refresh_token || tokenData.refresh_token, // Some APIs don't return new refresh token
    token_type: newTokens.token_type || 'Bearer',
    expires_in: newTokens.expires_in,
    created_at: Date.now(),
    expires_at: Date.now() + (newTokens.expires_in * 1000),
  };
  
  await env.TOKENS.put('jobber:tokens', JSON.stringify(updatedTokenData));
  
  console.log('Access token refreshed successfully');
  
  return updatedTokenData.access_token;
}

/**
 * Get valid access token (refreshing if needed)
 * Export for use in other modules
 */
export async function getAccessToken(env) {
  if (!env.TOKENS) {
    throw new Error('TOKENS KV namespace not configured');
  }
  
  const tokenData = await env.TOKENS.get('jobber:tokens', { type: 'json' });
  
  if (!tokenData) {
    throw new Error('Not connected to Jobber');
  }
  
  // Check if token is expired (with 5 minute buffer)
  const bufferMs = 5 * 60 * 1000;
  if (Date.now() > (tokenData.expires_at - bufferMs)) {
    return await refreshAccessToken(env);
  }
  
  return tokenData.access_token;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Generate cryptographically secure state parameter
 */
function generateState() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Render success page HTML
 */
function renderSuccessPage() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Connected to Jobber</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
           display: flex; justify-content: center; align-items: center; min-height: 100vh;
           margin: 0; background: #f5f5f5; }
    .container { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                 text-align: center; max-width: 400px; }
    .success { color: #22c55e; font-size: 48px; margin-bottom: 20px; }
    h1 { color: #1f2937; margin: 0 0 10px 0; }
    p { color: #6b7280; margin: 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success">✓</div>
    <h1>Connected!</h1>
    <p>Blue River Gutters is now connected to Jobber.</p>
    <p style="margin-top: 20px; font-size: 14px;">You can close this window.</p>
  </div>
</body>
</html>`;
}

/**
 * Render error page HTML
 */
function renderErrorPage(title, message) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Error - ${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
           display: flex; justify-content: center; align-items: center; min-height: 100vh;
           margin: 0; background: #f5f5f5; }
    .container { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                 text-align: center; max-width: 400px; }
    .error { color: #ef4444; font-size: 48px; margin-bottom: 20px; }
    h1 { color: #1f2937; margin: 0 0 10px 0; }
    p { color: #6b7280; margin: 0; }
    a { color: #3b82f6; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="error">✕</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p style="margin-top: 20px;"><a href="/auth/jobber">Try again</a></p>
  </div>
</body>
</html>`;
}

// =============================================================================
// EXISTING ENDPOINTS
// =============================================================================

/**
 * Root endpoint - simple info response
 */
function handleRoot(request, env) {
  return new Response(JSON.stringify({
    service: 'Blue River Gutters Content Engine',
    version: '0.2.0',
    environment: env.ENVIRONMENT || 'unknown',
    endpoints: {
      health: '/health',
      auth: '/auth/jobber',
      authCallback: '/auth/jobber/callback',
      authStatus: '/auth/status',
      webhook: '/webhook/jobber'
    }
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Health check endpoint
 */
function handleHealth(env) {
  return new Response(JSON.stringify({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: env.ENVIRONMENT || 'unknown',
    kv_configured: !!env.TOKENS
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Handle incoming Jobber webhooks
 */
async function handleJobberWebhook(request, env, ctx) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  
  let payload;
  
  try {
    payload = await request.json();
  } catch (error) {
    console.error('Failed to parse webhook payload:', error);
    return new Response(JSON.stringify({
      error: 'Invalid JSON payload'
    }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  console.log('=== Jobber Webhook Received ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Payload:', JSON.stringify(payload, null, 2));
  
  const validation = validatePayload(payload);
  if (!validation.valid) {
    console.error('Invalid payload structure:', validation.reason);
    return new Response(JSON.stringify({
      error: 'Invalid payload structure',
      reason: validation.reason
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
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

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, reason: 'Payload must be a JSON object' };
  }
  if (Object.keys(payload).length === 0) {
    return { valid: false, reason: 'Payload is empty' };
  }
  return { valid: true };
}

async function processWebhookEvent(payload, env) {
  console.log('=== Processing Webhook Event ===');
  
  const eventType = payload.event || payload.topic || 'unknown';
  
  switch (eventType) {
    case 'visit_completed':
    case 'VISIT_COMPLETED':
      await handleVisitCompleted(payload, env);
      break;
    default:
      console.log(`Unhandled event type: ${eventType}`);
      console.log('Full payload:', JSON.stringify(payload));
  }
}

async function handleVisitCompleted(payload, env) {
  console.log('=== Visit Completed Event ===');
  const data = payload.data || payload;
  console.log('Visit data:', JSON.stringify(data, null, 2));
  console.log('Visit completed event processed (logging only for now)');
}
