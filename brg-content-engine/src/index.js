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
 * - /api/reviews          - Fetch Google reviews for website
 * - /health               - Health check
 * - /test/pipeline        - Manual pipeline test (dev only)
 * 
 * Version: 1.1.0 - Added reviews API
 */

import { runContentPipeline } from './orchestrator.js';
import { getReviews, getAccounts, getLocations, getGoogleAccessToken } from './google-gbp.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS headers for API endpoints
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
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
      
      // API Endpoints
      case '/api/reviews':
        return handleGetReviews(request, env, corsHeaders);
      case '/api/reviews/sync':
        return handleSyncReviews(request, env, ctx, corsHeaders);
      
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
// REVIEWS API
// =============================================================================

/**
 * GET /api/reviews - Fetch reviews from cache or GBP
 * Returns reviews in format compatible with bluerivergutters website
 */
async function handleGetReviews(request, env, corsHeaders) {
  try {
    // Check cache first
    if (env.TOKENS) {
      const cached = await env.TOKENS.get('reviews:data', { type: 'json' });
      if (cached) {
        return new Response(JSON.stringify(cached, null, 2), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'HIT' }
        });
      }
    }
    
    // Fetch fresh from GBP
    const reviewsData = await fetchAndFormatReviews(env);
    
    // Cache for 1 hour
    if (env.TOKENS) {
      await env.TOKENS.put('reviews:data', JSON.stringify(reviewsData), {
        expirationTtl: 60 * 60, // 1 hour
      });
    }
    
    return new Response(JSON.stringify(reviewsData, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'MISS' }
    });
    
  } catch (error) {
    console.error('Reviews fetch error:', error);
    
    // Return fallback data if available
    if (env.TOKENS) {
      const fallback = await env.TOKENS.get('reviews:fallback', { type: 'json' });
      if (fallback) {
        return new Response(JSON.stringify(fallback, null, 2), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'FALLBACK' }
        });
      }
    }
    
    return new Response(JSON.stringify({
      error: 'Failed to fetch reviews',
      message: error.message,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

/**
 * POST /api/reviews/sync - Force refresh reviews from GBP and update GitHub
 */
async function handleSyncReviews(request, env, ctx, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }
  
  try {
    // Fetch fresh reviews
    const reviewsData = await fetchAndFormatReviews(env);
    
    // Update cache
    if (env.TOKENS) {
      await env.TOKENS.put('reviews:data', JSON.stringify(reviewsData), {
        expirationTtl: 60 * 60,
      });
      await env.TOKENS.put('reviews:fallback', JSON.stringify(reviewsData));
    }
    
    // Update GitHub in background
    ctx.waitUntil(updateGitHubReviews(reviewsData, env));
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Reviews synced',
      totalReviews: reviewsData.business.totalReviews,
      averageRating: reviewsData.business.averageRating,
      reviewCount: reviewsData.reviews.length,
    }, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Reviews sync error:', error);
    return new Response(JSON.stringify({
      error: 'Sync failed',
      message: error.message,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Fetch reviews from GBP and format for website
 */
async function fetchAndFormatReviews(env) {
  // Get location ID (cached or fetch)
  let locationId = env.GBP_LOCATION_ID;
  
  if (!locationId && env.TOKENS) {
    locationId = await env.TOKENS.get('google:locationId');
  }
  
  if (!locationId) {
    // Discover account and location
    const accounts = await getAccounts(env);
    if (!accounts.accounts?.length) {
      throw new Error('No GBP accounts found');
    }
    
    const accountId = accounts.accounts[0].name;
    const locations = await getLocations(env, accountId);
    
    if (!locations.locations?.length) {
      throw new Error('No GBP locations found');
    }
    
    locationId = locations.locations[0].name;
    
    // Cache location ID
    if (env.TOKENS) {
      await env.TOKENS.put('google:locationId', locationId);
    }
  }
  
  // Fetch reviews
  const gbpReviews = await getReviews(env, locationId, 50);
  
  // Calculate aggregate stats
  let totalRating = 0;
  const reviews = [];
  
  for (const review of (gbpReviews.reviews || [])) {
    const rating = starRatingToNumber(review.starRating);
    totalRating += rating;
    
    reviews.push({
      id: review.reviewId || review.name?.split('/').pop(),
      author: review.reviewer?.displayName || 'Anonymous',
      rating: rating,
      date: review.createTime?.split('T')[0] || new Date().toISOString().split('T')[0],
      text: review.comment || '',
      service: detectService(review.comment),
      city: detectCity(review.comment),
      ownerResponse: review.reviewReply ? {
        date: review.reviewReply.updateTime?.split('T')[0],
        text: review.reviewReply.comment,
      } : null,
    });
  }
  
  const totalReviews = gbpReviews.totalReviewCount || reviews.length;
  const averageRating = gbpReviews.averageRating || (reviews.length > 0 ? (totalRating / reviews.length).toFixed(1) : 4.7);
  
  return {
    business: {
      name: 'Blue River Gutters',
      averageRating: parseFloat(averageRating),
      totalReviews: totalReviews,
      googlePlaceId: env.GOOGLE_PLACE_ID || 'ChIJxxxxxx',
      lastUpdated: new Date().toISOString().split('T')[0],
    },
    reviews: reviews,
  };
}

/**
 * Update reviews.json in GitHub
 */
async function updateGitHubReviews(reviewsData, env) {
  if (!env.GITHUB_TOKEN) {
    console.log('No GitHub token, skipping repo update');
    return;
  }
  
  try {
    const content = JSON.stringify(reviewsData, null, 2);
    const base64Content = btoa(unescape(encodeURIComponent(content)));
    
    // Get current file SHA
    const getResponse = await fetch(
      'https://api.github.com/repos/mrmicaiah/bluerivergutters/contents/src/_data/reviews.json',
      {
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'BRG-Content-Engine',
        },
      }
    );
    
    let sha = null;
    if (getResponse.ok) {
      const fileData = await getResponse.json();
      sha = fileData.sha;
    }
    
    // Update or create file
    const updateResponse = await fetch(
      'https://api.github.com/repos/mrmicaiah/bluerivergutters/contents/src/_data/reviews.json',
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'BRG-Content-Engine',
        },
        body: JSON.stringify({
          message: `Update reviews from GBP - ${reviewsData.business.totalReviews} reviews, ${reviewsData.business.averageRating}★`,
          content: base64Content,
          sha: sha,
        }),
      }
    );
    
    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      console.error('GitHub update failed:', error);
    } else {
      console.log('GitHub reviews.json updated');
    }
    
  } catch (error) {
    console.error('GitHub update error:', error);
  }
}

/**
 * Convert GBP star rating enum to number
 */
function starRatingToNumber(starRating) {
  const ratings = {
    'ONE': 1, 'TWO': 2, 'THREE': 3, 'FOUR': 4, 'FIVE': 5,
    'STAR_RATING_UNSPECIFIED': 5,
  };
  return ratings[starRating] || 5;
}

/**
 * Detect service type from review text
 */
function detectService(text) {
  if (!text) return 'Gutter Services';
  const lower = text.toLowerCase();
  if (lower.includes('guard') || lower.includes('leaf')) return 'Gutter Guards';
  if (lower.includes('clean')) return 'Gutter Cleaning';
  if (lower.includes('underground') || lower.includes('drain')) return 'Underground Drains';
  if (lower.includes('rott') || lower.includes('fascia') || lower.includes('wood')) return 'Rotten Wood Repair';
  if (lower.includes('downspout')) return 'Downspouts';
  return 'Seamless Gutters';
}

/**
 * Detect city from review text
 */
function detectCity(text) {
  if (!text) return 'North Alabama';
  const lower = text.toLowerCase();
  const cities = ['huntsville', 'madison', 'decatur', 'athens', 'hartselle', 'hampton cove', 'meridianville', 'hazel green', 'owens cross roads', 'harvest'];
  for (const city of cities) {
    if (lower.includes(city)) {
      return city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }
  return 'North Alabama';
}

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
  
  return Response.redirect(authUrl.toString(), 302);
}

async function handleJobberCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  
  if (error) {
    return new Response(renderErrorPage('Authorization Denied', url.searchParams.get('error_description') || 'Unknown error'), {
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
      return new Response(renderErrorPage('Token Exchange Failed', `Status: ${tokenResponse.status}`), {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    const tokens = await tokenResponse.json();
    
    if (env.TOKENS) {
      await env.TOKENS.put('jobber:tokens', JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type || 'Bearer',
        expires_in: tokens.expires_in,
        created_at: Date.now(),
        expires_at: Date.now() + (tokens.expires_in * 1000),
      }));
    }
    
    return new Response(renderSuccessPage('Jobber'), { headers: { 'Content-Type': 'text/html' } });
    
  } catch (error) {
    return new Response(renderErrorPage('Connection Error', 'Failed to connect to Jobber API'), {
      status: 500,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

async function handleAuthStatus(request, env) {
  const jobberStatus = await getJobberStatus(env);
  const googleStatus = await getGoogleStatus(env);
  
  return new Response(JSON.stringify({ jobber: jobberStatus, google: googleStatus }, null, 2), {
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
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/business.manage'].join(' ');

async function handleGoogleAuth(request, env) {
  if (!env.GOOGLE_CLIENT_ID) {
    return new Response(JSON.stringify({ error: 'GOOGLE_CLIENT_ID not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const state = generateState();
  if (env.TOKENS) await env.TOKENS.put(`google_state:${state}`, 'pending', { expirationTtl: 600 });
  
  const callbackUrl = new URL('/auth/google/callback', request.url).toString();
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GOOGLE_SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  
  return Response.redirect(authUrl.toString(), 302);
}

async function handleGoogleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  
  if (error) return new Response(renderErrorPage('Google Authorization Denied', error), { status: 400, headers: { 'Content-Type': 'text/html' } });
  if (!code || !state) return new Response(renderErrorPage('Invalid Request', 'Missing code or state'), { status: 400, headers: { 'Content-Type': 'text/html' } });
  
  if (env.TOKENS) {
    const storedState = await env.TOKENS.get(`google_state:${state}`);
    if (!storedState) return new Response(renderErrorPage('Invalid State', 'Session expired'), { status: 400, headers: { 'Content-Type': 'text/html' } });
    await env.TOKENS.delete(`google_state:${state}`);
  }
  
  try {
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: new URL('/auth/google/callback', request.url).toString(),
      }).toString(),
    });
    
    if (!tokenResponse.ok) return new Response(renderErrorPage('Token Exchange Failed', `Status: ${tokenResponse.status}`), { status: 500, headers: { 'Content-Type': 'text/html' } });
    
    const tokens = await tokenResponse.json();
    if (env.TOKENS) {
      await env.TOKENS.put('google:tokens', JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type || 'Bearer',
        expires_in: tokens.expires_in,
        created_at: Date.now(),
        expires_at: Date.now() + (tokens.expires_in * 1000),
      }));
    }
    
    return new Response(renderSuccessPage('Google Business Profile'), { headers: { 'Content-Type': 'text/html' } });
  } catch (error) {
    return new Response(renderErrorPage('Connection Error', 'Failed to connect to Google'), { status: 500, headers: { 'Content-Type': 'text/html' } });
  }
}

// =============================================================================
// TOKEN MANAGEMENT
// =============================================================================

export async function getAccessToken(env) {
  if (!env.TOKENS) throw new Error('TOKENS KV not configured');
  const tokenData = await env.TOKENS.get('jobber:tokens', { type: 'json' });
  if (!tokenData) throw new Error('Not connected to Jobber');
  if (Date.now() > (tokenData.expires_at - 300000)) return await refreshJobberToken(env, tokenData);
  return tokenData.access_token;
}

async function refreshJobberToken(env, tokenData) {
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
  
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  const newTokens = await response.json();
  
  const updated = {
    access_token: newTokens.access_token,
    refresh_token: newTokens.refresh_token || tokenData.refresh_token,
    token_type: newTokens.token_type || 'Bearer',
    expires_in: newTokens.expires_in,
    created_at: Date.now(),
    expires_at: Date.now() + (newTokens.expires_in * 1000),
  };
  
  await env.TOKENS.put('jobber:tokens', JSON.stringify(updated));
  return updated.access_token;
}

// =============================================================================
// WEBHOOK HANDLER
// =============================================================================

async function handleJobberWebhook(request, env, ctx) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  
  let payload;
  try { payload = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  
  ctx.waitUntil(processWebhookEvent(payload, env));
  
  return new Response(JSON.stringify({ received: true, event: payload.event || 'unknown', timestamp: new Date().toISOString() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function processWebhookEvent(payload, env) {
  const eventType = payload.event || payload.topic || 'unknown';
  if (eventType.toLowerCase() === 'visit_completed') await handleVisitCompleted(payload, env);
}

async function handleVisitCompleted(payload, env) {
  const data = payload.data || payload;
  const visitId = data.webHookEvent?.itemId || data.visitId || data.id;
  const jobId = data.webHookEvent?.jobId || data.jobId;
  
  if (!visitId && !jobId) return;
  
  try {
    const accessToken = await getAccessToken(env);
    const result = await runContentPipeline(visitId, jobId, accessToken, env);
    if (env.TOKENS) await env.TOKENS.put(`pipeline:${result.jobId}:${Date.now()}`, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 7 });
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
    version: '1.1.0',
    environment: env.ENVIRONMENT || 'unknown',
    endpoints: {
      health: '/health',
      authJobber: '/auth/jobber',
      authGoogle: '/auth/google',
      authStatus: '/auth/status',
      webhook: '/webhook/jobber',
      reviews: '/api/reviews',
      reviewsSync: '/api/reviews/sync (POST)',
      testPipeline: '/test/pipeline (dev only)',
    },
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
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
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleTestPipeline(request, env) {
  if (env.ENVIRONMENT === 'production') return new Response('Not available in production', { status: 403 });
  if (request.method !== 'POST') return new Response(JSON.stringify({ usage: 'POST /test/pipeline with body { "jobId": "xxx" }' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  
  try {
    const { jobId, visitId } = await request.json();
    if (!jobId && !visitId) return new Response(JSON.stringify({ error: 'Provide jobId or visitId' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const accessToken = await getAccessToken(env);
    const result = await runContentPipeline(visitId, jobId, accessToken, env);
    return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message, stack: error.stack }), { status: 500, headers: { 'Content-Type': 'application/json' } });
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
  return `<!DOCTYPE html><html><head><title>Connected</title><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}.c{background:#fff;padding:40px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);text-align:center;max-width:400px}.s{color:#22c55e;font-size:48px}h1{color:#1f2937;margin:10px 0}p{color:#6b7280}</style></head><body><div class="c"><div class="s">✓</div><h1>Connected!</h1><p>Blue River Gutters is now connected to ${service}.</p><p style="margin-top:20px;font-size:14px">You can close this window.</p></div></body></html>`;
}

function renderErrorPage(title, msg) {
  return `<!DOCTYPE html><html><head><title>Error</title><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}.c{background:#fff;padding:40px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);text-align:center;max-width:400px}.e{color:#ef4444;font-size:48px}h1{color:#1f2937;margin:10px 0}p{color:#6b7280}a{color:#3b82f6}</style></head><body><div class="c"><div class="e">✕</div><h1>${title}</h1><p>${msg}</p><p style="margin-top:20px"><a href="/">Back to home</a></p></div></body></html>`;
}
