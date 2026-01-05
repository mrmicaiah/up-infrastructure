// Google Drive tools

import { z } from "zod";
import type { ToolContext } from '../types';
import { getValidToken, buildOAuthUrl, findOrCreateFolderPath, DRIVE_API_URL, DRIVE_UPLOAD_URL } from '../oauth';

export function registerDriveTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  server.tool("drive_status", {}, async () => {
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) {
      const workerName = env.WORKER_NAME || `productivity-${env.USER_ID === 'micaiah' ? 'mcp-server' : env.USER_ID}`;
      const workerUrl = `https://${workerName}.micaiah-tasks.workers.dev`;
      const url = buildOAuthUrl(env, getCurrentUser(), 'google_drive', workerUrl);
      return { content: [{ type: "text", text: '🔗 Not connected. Click:\n' + url }] };
    }
    return { content: [{ type: "text", text: "✅ Google Drive connected" }] };
  });

  server.tool("list_drive_folders", { parent_id: z.string().optional() }, async ({ parent_id }) => {
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) return { content: [{ type: "text", text: "⛔ Not connected. Run: connect_service google_drive" }] };
    
    const q = parent_id ? "'" + parent_id + "' in parents" : "'root' in parents";
    const resp = await fetch(DRIVE_API_URL + '/files?q=' + encodeURIComponent(q + " and mimeType = 'application/vnd.google-apps.folder' and trashed = false") + '&fields=files(id,name)', { 
      headers: { Authorization: 'Bearer ' + token } 
    });
    const data: any = await resp.json();
    if (!data.files?.length) return { content: [{ type: "text", text: "No folders" }] };
    
    let out = '📁 Folders:\n';
    data.files.forEach((f: any) => { out += '• ' + f.name + ' (ID: ' + f.id + ')\n'; });
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("save_to_drive", { 
    filename: z.string(), 
    content: z.string(), 
    folder_id: z.string().optional(), 
    folder_path: z.string().optional() 
  }, async ({ filename, content, folder_id, folder_path }) => {
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) return { content: [{ type: "text", text: "⛔ Not connected. Run: connect_service google_drive" }] };
    
    let targetId = folder_id;
    if (!targetId && folder_path) {
      const folder = await findOrCreateFolderPath(token, folder_path);
      if (folder) targetId = folder.id;
    }
    
    const ext = filename.split('.').pop()?.toLowerCase() || 'txt';
    const mimeTypes: Record<string,string> = { txt: 'text/plain', md: 'text/markdown', html: 'text/html', json: 'application/json' };
    const mime = mimeTypes[ext] || 'text/plain';
    
    const meta: any = { name: filename, mimeType: mime };
    if (targetId) meta.parents = [targetId];
    
    const boundary = '---b';
    const body = '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n' + content + '\r\n--' + boundary + '--';
    
    const resp = await fetch(DRIVE_UPLOAD_URL + '/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: body
    });
    
    if (!resp.ok) return { content: [{ type: "text", text: "⛔ Error" }] };
    const file: any = await resp.json();
    return { content: [{ type: "text", text: '✅ Saved: ' + file.name + '\n' + file.webViewLink }] };
  });

  server.tool("search_drive", { query: z.string() }, async ({ query }) => {
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) return { content: [{ type: "text", text: "⛔ Not connected. Run: connect_service google_drive" }] };
    
    const resp = await fetch(DRIVE_API_URL + '/files?q=' + encodeURIComponent("name contains '" + query + "' and trashed = false") + '&fields=files(id,name,webViewLink)&pageSize=10', { 
      headers: { Authorization: 'Bearer ' + token } 
    });
    const data: any = await resp.json();
    if (!data.files?.length) return { content: [{ type: "text", text: 'No results for "' + query + '"' }] };
    
    let out = '🔍 Results:\n';
    data.files.forEach((f: any) => { out += '• ' + f.name + '\n  ' + f.webViewLink + '\n'; });
    return { content: [{ type: "text", text: out }] };
  });
}
