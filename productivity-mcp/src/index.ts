import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { Env, ToolContext } from './types';
import { registerAllTools } from './tools';
import { GOOGLE_TOKEN_URL, SERVICE_NAMES } from './oauth';
import { createApiRoutes } from './api-routes';
import { createCaptureRoutes } from './capture-routes';

// ==================
// USER AGENTS
// ==================
export class ProductivityMCP extends McpAgent {
  server = new McpServer({ name: "Untitled Publishers Productivity", version: "5.1.2" });

  async init() {
    const env = this.env as Env;
    const userId = env.USER_ID || 'micaiah';

    // Support multiple teammates via TEAM env var
    const getTeammates = (): string[] => {
      const team = env.TEAM || 'micaiah,irene';
      return team.split(',').map((t: string) => t.trim()).filter((t: string) => t !== userId);
    };

    const ctx: ToolContext = {
      server: this.server,
      env,
      getCurrentUser: () => userId,
      getTeammates,
      getTeammate: () => getTeammates()[0] || 'unknown',
    };

    registerAllTools(ctx);
  }
}

// Keep aliases for backward compatibility
export { ProductivityMCP as MyMCP };
export { ProductivityMCP as MicaiahMCP };
export { ProductivityMCP as IreneMCP };

// ==================
// ROUTING
// ==================
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const userId = env.USER_ID || 'micaiah';
    const workerName = env.WORKER_NAME || `productivity-${userId === 'micaiah' ? 'mcp-server' : userId}`;
    const workerUrl = `https://${workerName}.micaiah-tasks.workers.dev`;

    // Capture Portal routes (API endpoints)
    if (url.pathname.startsWith('/api/capture/')) {
      const captureRoutes = createCaptureRoutes(env as any);
      const response = await captureRoutes.fetch(request);
      if (response) return response;
    }

    // Capture Portal UI - serve the upload interface
    if (url.pathname.startsWith('/capture/')) {
      const slug = url.pathname.replace('/capture/', '').replace(/\/$/, '');
      
      if (!slug) {
        return new Response('Portal not found', { status: 404 });
      }

      // Serve the capture portal HTML
      return new Response(getCapturePortalHTML(slug, workerUrl), {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // REST API routes for dashboard
    if (url.pathname.startsWith('/api/')) {
      const apiRoutes = createApiRoutes(env);
      return apiRoutes.fetch(request);
    }

    // Google OAuth callback
    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) return new Response('Missing params', { status: 400 });

      // Parse state: "userId:provider" format
      const [stateUserId, provider] = state.includes(':')
        ? state.split(':')
        : [state, 'google_drive']; // Backward compatibility

      const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: workerUrl + '/oauth/callback',
          grant_type: 'authorization_code'
        }),
      });

      if (!tokenResp.ok) {
        const err = await tokenResp.text();
        return new Response('Token failed: ' + err, { status: 500 });
      }

      const tokens: any = await tokenResp.json();
      const exp = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      await env.DB.prepare(
        'INSERT INTO oauth_tokens (id, user_id, provider, access_token, refresh_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?'
      ).bind(
        crypto.randomUUID(),
        stateUserId,
        provider,
        tokens.access_token,
        tokens.refresh_token,
        exp,
        new Date().toISOString(),
        tokens.access_token,
        tokens.refresh_token,
        exp
      ).run();

      return new Response(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh"><div style="text-align:center"><h1>✅ ${SERVICE_NAMES[provider] || provider} Connected!</h1><p>Close this window and return to Claude</p></div></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }

    // GitHub OAuth callback
    if (url.pathname === "/oauth/github/callback") {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) return new Response('Missing params', { status: 400 });

      const [stateUserId, provider] = state.split(':');

      const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code: code,
          redirect_uri: workerUrl + '/oauth/github/callback',
        }),
      });

      if (!tokenResp.ok) {
        const err = await tokenResp.text();
        return new Response('GitHub token failed: ' + err, { status: 500 });
      }

      const tokens: any = await tokenResp.json();
      
      if (tokens.error) {
        return new Response('GitHub error: ' + tokens.error_description, { status: 500 });
      }

      await env.DB.prepare(
        'INSERT INTO oauth_tokens (id, user_id, provider, access_token, refresh_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?'
      ).bind(
        crypto.randomUUID(),
        stateUserId,
        'github',
        tokens.access_token,
        null,  // GitHub doesn't use refresh tokens
        null,  // GitHub tokens don't expire
        new Date().toISOString(),
        tokens.access_token,
        null,
        null
      ).run();

      return new Response(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh"><div style="text-align:center"><h1>✅ GitHub Connected!</h1><p>Close this window and return to Claude</p></div></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }

    // All SSE requests go to the same MCP class - user is determined by env
    if (url.pathname.startsWith("/sse")) {
      return ProductivityMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    return new Response(JSON.stringify({ status: "running", user: userId, version: "5.1.2" }), { headers: { "Content-Type": "application/json" } });
  },
};

// Capture Portal HTML - simple photo upload interface
function getCapturePortalHTML(slug: string, apiBase: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Photo Upload</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; min-height: 100vh; padding: 20px; }
    .container { max-width: 500px; margin: 0 auto; }
    h1 { font-size: 1.5rem; color: #333; margin-bottom: 1rem; text-align: center; }
    .status { padding: 1rem; border-radius: 8px; margin-bottom: 1rem; text-align: center; }
    .status.success { background: #d4edda; color: #155724; }
    .status.error { background: #f8d7da; color: #721c24; }
    .status.loading { background: #fff3cd; color: #856404; }
    .upload-area { background: white; border: 2px dashed #ddd; border-radius: 12px; padding: 2rem; text-align: center; margin-bottom: 1rem; cursor: pointer; transition: border-color 0.2s; }
    .upload-area:hover { border-color: #007bff; }
    .upload-area.dragover { border-color: #007bff; background: #f0f7ff; }
    .upload-icon { font-size: 3rem; margin-bottom: 1rem; }
    .upload-text { color: #666; margin-bottom: 0.5rem; }
    .upload-hint { font-size: 0.85rem; color: #999; }
    input[type="file"] { display: none; }
    .gallery { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .gallery img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; }
    .upload-count { text-align: center; color: #666; margin-top: 1rem; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📷 Upload Photos</h1>
    <div id="status" class="status" style="display: none;"></div>
    <div class="upload-area" id="uploadArea">
      <div class="upload-icon">📸</div>
      <div class="upload-text">Tap to take or select photos</div>
      <div class="upload-hint">or drag and drop images here</div>
    </div>
    <input type="file" id="fileInput" accept="image/*" multiple capture="environment">
    <div class="gallery" id="gallery"></div>
    <div class="upload-count" id="uploadCount"></div>
  </div>
  <script>
    const slug = '${slug}';
    const apiBase = '${apiBase}';
    let portalId = null;
    
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const status = document.getElementById('status');
    const gallery = document.getElementById('gallery');
    const uploadCount = document.getElementById('uploadCount');
    
    // Initialize - auth with slug (no PIN required)
    async function init() {
      showStatus('Connecting...', 'loading');
      try {
        const resp = await fetch(apiBase + '/api/capture/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, pin: '' })
        });
        const data = await resp.json();
        if (data.success) {
          portalId = data.portal_id;
          document.querySelector('h1').textContent = '📷 ' + data.portal_name;
          hideStatus();
          loadRecent();
        } else {
          showStatus('Portal not found: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (e) {
        showStatus('Connection failed: ' + e.message, 'error');
      }
    }
    
    // Load recent uploads
    async function loadRecent() {
      try {
        const resp = await fetch(apiBase + '/api/capture/recent?portal_id=' + portalId);
        const data = await resp.json();
        if (data.uploads?.length) {
          gallery.innerHTML = data.uploads.map(u => 
            '<img src="' + u.thumbnail_url + '" alt="' + u.original_filename + '">'
          ).join('');
          uploadCount.textContent = data.uploads.length + ' photos uploaded';
        }
      } catch (e) { console.error('Load recent failed:', e); }
    }
    
    // Upload handler
    async function uploadFiles(files) {
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        showStatus('Uploading ' + file.name + '...', 'loading');
        
        const formData = new FormData();
        formData.append('portal_id', portalId);
        formData.append('image', file);
        
        try {
          const resp = await fetch(apiBase + '/api/capture/upload', {
            method: 'POST',
            body: formData
          });
          const data = await resp.json();
          if (data.success) {
            showStatus('✓ Uploaded!', 'success');
            setTimeout(hideStatus, 2000);
            loadRecent();
          } else {
            showStatus('Upload failed: ' + (data.error || 'Unknown error'), 'error');
          }
        } catch (e) {
          showStatus('Upload failed: ' + e.message, 'error');
        }
      }
    }
    
    function showStatus(msg, type) {
      status.textContent = msg;
      status.className = 'status ' + type;
      status.style.display = 'block';
    }
    
    function hideStatus() { status.style.display = 'none'; }
    
    // Event listeners
    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => uploadFiles(e.target.files));
    
    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      uploadFiles(e.dataTransfer.files);
    });
    
    init();
  </script>
</body>
</html>`;
}
