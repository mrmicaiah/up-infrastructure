/**
 * Google Business Profile API Integration
 * 
 * OAuth 2.0 flow and API calls for creating posts, fetching reviews, etc.
 * See docs/GOOGLE_GBP_SETUP.md for setup instructions.
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GBP_ACCOUNTS_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';

// OAuth Flow
export async function handleGoogleAuth(request, env) {
  if (!env.GOOGLE_CLIENT_ID) {
    return new Response(JSON.stringify({ error: 'GOOGLE_CLIENT_ID not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  
  const state = generateState();
  if (env.TOKENS) await env.TOKENS.put(`google_oauth_state:${state}`, 'pending', { expirationTtl: 600 });
  
  const callbackUrl = new URL('/auth/google/callback', request.url).toString();
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GBP_SCOPE);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  
  return Response.redirect(authUrl.toString(), 302);
}

export async function handleGoogleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  
  if (error) return new Response(renderErrorPage('Google Auth Failed', error), { status: 400, headers: { 'Content-Type': 'text/html' } });
  if (!code || !state) return new Response(renderErrorPage('Invalid Request', 'Missing code or state'), { status: 400, headers: { 'Content-Type': 'text/html' } });
  
  if (env.TOKENS) {
    const storedState = await env.TOKENS.get(`google_oauth_state:${state}`);
    if (!storedState) return new Response(renderErrorPage('Invalid State', 'Session expired'), { status: 400, headers: { 'Content-Type': 'text/html' } });
    await env.TOKENS.delete(`google_oauth_state:${state}`);
  }
  
  try {
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: new URL('/auth/google/callback', request.url).toString(),
      }).toString(),
    });
    
    if (!tokenResponse.ok) throw new Error('Token exchange failed');
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
    
    return new Response(renderSuccessPage('Google Business Profile'), { status: 200, headers: { 'Content-Type': 'text/html' } });
  } catch (err) {
    return new Response(renderErrorPage('Connection Error', err.message), { status: 500, headers: { 'Content-Type': 'text/html' } });
  }
}

export async function getGoogleAccessToken(env) {
  if (!env.TOKENS) throw new Error('TOKENS KV not configured');
  const tokenData = await env.TOKENS.get('google:tokens', { type: 'json' });
  if (!tokenData) throw new Error('Not connected to Google');
  
  const bufferMs = 5 * 60 * 1000;
  if (Date.now() > (tokenData.expires_at - bufferMs)) {
    return await refreshGoogleToken(env, tokenData);
  }
  return tokenData.access_token;
}

async function refreshGoogleToken(env, tokenData) {
  if (!tokenData.refresh_token) throw new Error('No refresh token');
  
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tokenData.refresh_token,
    }).toString(),
  });
  
  if (!response.ok) throw new Error(`Refresh failed: ${response.status}`);
  const newTokens = await response.json();
  
  const updated = { ...tokenData, access_token: newTokens.access_token, expires_at: Date.now() + (newTokens.expires_in * 1000) };
  await env.TOKENS.put('google:tokens', JSON.stringify(updated));
  return updated.access_token;
}

// GBP API Functions
export async function getAccounts(env) {
  const token = await getGoogleAccessToken(env);
  const response = await fetch(GBP_ACCOUNTS_URL, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Failed to get accounts: ${response.status}`);
  return await response.json();
}

export async function getLocations(env, accountId) {
  const token = await getGoogleAccessToken(env);
  const response = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountId}/locations`, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Failed to get locations: ${response.status}`);
  return await response.json();
}

export async function createPost(env, locationId, postData) {
  const token = await getGoogleAccessToken(env);
  const post = { languageCode: 'en-US', summary: postData.summary, topicType: postData.type || 'STANDARD' };
  if (postData.media) post.media = postData.media.map(m => ({ mediaFormat: m.type || 'PHOTO', sourceUrl: m.url }));
  if (postData.callToAction) post.callToAction = { actionType: postData.callToAction.type || 'LEARN_MORE', url: postData.callToAction.url };
  
  const response = await fetch(`https://mybusiness.googleapis.com/v4/${locationId}/localPosts`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(post),
  });
  if (!response.ok) throw new Error(`Failed to create post: ${response.status}`);
  return await response.json();
}

export async function getReviews(env, locationId, pageSize = 50) {
  const token = await getGoogleAccessToken(env);
  const response = await fetch(`https://mybusiness.googleapis.com/v4/${locationId}/reviews?pageSize=${pageSize}`, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Failed to get reviews: ${response.status}`);
  return await response.json();
}

export async function replyToReview(env, reviewId, comment) {
  const token = await getGoogleAccessToken(env);
  const response = await fetch(`https://mybusiness.googleapis.com/v4/${reviewId}/reply`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
  if (!response.ok) throw new Error(`Failed to reply: ${response.status}`);
  return await response.json();
}

// Project Post Helper
export async function createProjectPost(env, locationId, jobData, photoUrls) {
  const city = jobData.location?.city || 'North Alabama';
  const service = (jobData.services || ['gutter services'])[0];
  
  const summary = `Another ${service} project completed in ${city}! Our team delivers quality seamless gutters that protect your home. Ready to protect your home? Call for a free estimate! #BlueRiverGutters`;
  
  const postData = { type: 'STANDARD', summary, callToAction: { type: 'CALL', url: 'tel:+12566167760' } };
  if (photoUrls?.length) postData.media = photoUrls.slice(0, 10).map(url => ({ type: 'PHOTO', url }));
  
  return await createPost(env, locationId, postData);
}

// Helpers
function generateState() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

function renderSuccessPage(name) {
  return `<!DOCTYPE html><html><head><title>Connected</title><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}.c{background:#fff;padding:40px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);text-align:center}.s{color:#22c55e;font-size:48px}h1{color:#1f2937;margin:10px 0}p{color:#6b7280}</style></head><body><div class="c"><div class="s">✓</div><h1>Connected!</h1><p>Successfully connected to ${name}.</p></div></body></html>`;
}

function renderErrorPage(title, msg) {
  return `<!DOCTYPE html><html><head><title>Error</title><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}.c{background:#fff;padding:40px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);text-align:center}.e{color:#ef4444;font-size:48px}h1{color:#1f2937;margin:10px 0}p{color:#6b7280}</style></head><body><div class="c"><div class="e">✕</div><h1>${title}</h1><p>${msg}</p></div></body></html>`;
}
