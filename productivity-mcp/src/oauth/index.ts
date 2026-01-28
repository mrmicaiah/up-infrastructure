// OAuth helpers and constants

// Google OAuth
export const GOOGLE_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const DRIVE_API_URL = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3';
export const GMAIL_API_URL = 'https://gmail.googleapis.com/gmail/v1';
export const BLOGGER_API_URL = 'https://www.googleapis.com/blogger/v3';
export const PEOPLE_API_URL = 'https://people.googleapis.com/v1';
export const ANALYTICS_DATA_API = 'https://analyticsdata.googleapis.com/v1beta';

// GitHub OAuth
export const GITHUB_OAUTH_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_API_URL = 'https://api.github.com';

// OAuth scopes by provider
export const OAUTH_SCOPES: Record<string, string> = {
  'google_drive': 'https://www.googleapis.com/auth/drive',
  'gmail_personal': 'https://www.googleapis.com/auth/gmail.modify',
  'gmail_company': 'https://www.googleapis.com/auth/gmail.modify',
  'blogger': 'https://www.googleapis.com/auth/blogger',
  'blogger_personal': 'https://www.googleapis.com/auth/blogger',
  'blogger_company': 'https://www.googleapis.com/auth/blogger',
  'google_contacts_personal': 'https://www.googleapis.com/auth/contacts.readonly',
  'google_contacts_company': 'https://www.googleapis.com/auth/contacts.readonly',
  'google_analytics': 'https://www.googleapis.com/auth/analytics.readonly',
  'github': 'repo,user',
};

// Service display names
export const SERVICE_NAMES: Record<string, string> = {
  'google_drive': 'Google Drive',
  'gmail_personal': 'Personal Email',
  'gmail_company': 'Company Email',
  'blogger': 'Blogger',
  'blogger_personal': 'Personal Blogger',
  'blogger_company': 'Company Blogger',
  'google_contacts_personal': 'Personal Contacts',
  'google_contacts_company': 'Company Contacts',
  'google_analytics': 'Google Analytics',
  'github': 'GitHub',
};

// Check if a provider is a Google service
export function isGoogleProvider(provider: string): boolean {
  return provider !== 'github';
}

export async function getValidToken(env: any, userId: string, provider: string = 'google_drive'): Promise<string | null> {
  const token = await env.DB.prepare(
    'SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?'
  ).bind(userId, provider).first();
  
  if (!token) return null;
  
  // GitHub tokens don't expire the same way
  if (provider === 'github') {
    return token.access_token;
  }
  
  if (token.expires_at && new Date(token.expires_at) < new Date()) {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    
    if (!response.ok) return null;
    
    const data: any = await response.json();
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
    
    await env.DB.prepare(
      'UPDATE oauth_tokens SET access_token = ?, expires_at = ? WHERE user_id = ? AND provider = ?'
    ).bind(data.access_token, expiresAt, userId, provider).run();
    
    return data.access_token;
  }
  
  return token.access_token;
}

// Separate function for GitHub tokens
export async function getGitHubToken(env: any, userId: string): Promise<string | null> {
  const token = await env.DB.prepare(
    'SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?'
  ).bind(userId, 'github').first();
  
  return token?.access_token || null;
}

export function buildOAuthUrl(env: any, userId: string, provider: string, workerUrl: string): string {
  // Handle GitHub separately
  if (provider === 'github') {
    return buildGitHubOAuthUrl(env, userId, workerUrl);
  }
  
  const scope = OAUTH_SCOPES[provider] || OAUTH_SCOPES['google_drive'];
  const state = userId + ':' + provider; // Encode both user and provider in state
  
  return GOOGLE_OAUTH_URL + '?' + new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: workerUrl + '/oauth/callback',
    response_type: 'code',
    scope: scope,
    access_type: 'offline',
    prompt: 'consent',
    state: state,
  }).toString();
}

export function buildGitHubOAuthUrl(env: any, userId: string, workerUrl: string): string {
  const state = userId + ':github';
  
  return GITHUB_OAUTH_URL + '?' + new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: workerUrl + '/oauth/github/callback',
    scope: 'repo user',
    state: state,
  }).toString();
}

export async function findOrCreateFolderPath(token: string, path: string): Promise<{ id: string; name: string } | null> {
  const parts = path.split('/').filter(p => p.trim());
  let parentId = 'root';
  let currentFolder = { id: 'root', name: 'My Drive' };
  
  for (const folderName of parts) {
    const query = "'" + parentId + "' in parents and name = '" + folderName.replace(/'/g, "\\'") + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    
    const response = await fetch(DRIVE_API_URL + '/files?q=' + encodeURIComponent(query) + '&fields=files(id,name)', {
      headers: { Authorization: 'Bearer ' + token },
    });
    
    if (!response.ok) return null;
    
    const data: any = await response.json();
    
    if (data.files.length > 0) {
      currentFolder = data.files[0];
      parentId = currentFolder.id;
    } else {
      const createResponse = await fetch(DRIVE_API_URL + '/files?fields=id,name', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId],
        }),
      });
      
      if (!createResponse.ok) return null;
      
      currentFolder = await createResponse.json();
      parentId = currentFolder.id;
    }
  }
  
  return currentFolder;
}
