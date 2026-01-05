import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { Env, ToolContext } from './types';
import { registerAllTools } from './tools';
import { GOOGLE_TOKEN_URL, SERVICE_NAMES } from './oauth';

// ==================
// USER AGENTS
// ==================
export class ProductivityMCP extends McpAgent {
  server = new McpServer({ name: "Untitled Publishers Productivity", version: "5.1.0" });
  
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
    
    // All SSE requests go to the same MCP class - user is determined by env
    if (url.pathname.startsWith("/sse")) {
      return ProductivityMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    
    return new Response(JSON.stringify({ status: "running", user: userId, version: "5.1.0" }), { headers: { "Content-Type": "application/json" } });
  },
};
