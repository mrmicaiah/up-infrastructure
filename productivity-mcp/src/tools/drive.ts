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
    is_base64: z.boolean().optional().default(false).describe("Set true for binary files (.docx, .xlsx, .pdf, .png, etc.) where content is base64-encoded"),
    folder_id: z.string().optional().describe("Folder ID (preferred - use this when you know the exact folder)"), 
    folder_path: z.string().optional().describe("Folder path like 'My Folder/Subfolder' - will create if not exists. Use folder_id when possible for accuracy.")
  }, async ({ filename, content, is_base64, folder_id, folder_path }) => {
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) return { content: [{ type: "text", text: "⛔ Not connected. Run: connect_service google_drive" }] };
    
    let targetId = folder_id;
    let folderInfo = '';
    
    // Prefer folder_id over folder_path for accuracy
    if (targetId) {
      folderInfo = ` (folder ID: ${targetId})`;
    } else if (folder_path) {
      const folder = await findOrCreateFolderPath(token, folder_path);
      if (folder) {
        targetId = folder.id;
        folderInfo = ` in "${folder_path}" (ID: ${folder.id})`;
      } else {
        return { content: [{ type: "text", text: `⛔ Could not find or create folder path: ${folder_path}\n\n💡 Tip: Use folder_id instead of folder_path for more reliable saves. Use list_drive_folders to find folder IDs.` }] };
      }
    }
    
    const ext = filename.split('.').pop()?.toLowerCase() || 'txt';
    
    // Text file MIME types
    const textMimeTypes: Record<string,string> = { 
      txt: 'text/plain', 
      md: 'text/markdown', 
      html: 'text/html', 
      json: 'application/json',
      ts: 'text/plain',
      js: 'text/javascript',
      css: 'text/css',
      py: 'text/x-python',
      xml: 'application/xml',
      csv: 'text/csv',
    };
    
    // Binary file MIME types
    const binaryMimeTypes: Record<string,string> = {
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      zip: 'application/zip',
      doc: 'application/msword',
      xls: 'application/vnd.ms-excel',
      ppt: 'application/vnd.ms-powerpoint',
    };
    
    // Determine MIME type based on extension and whether it's binary
    let mime: string;
    if (is_base64) {
      mime = binaryMimeTypes[ext] || 'application/octet-stream';
    } else {
      mime = textMimeTypes[ext] || 'text/plain';
    }
    
    const meta: any = { name: filename, mimeType: mime };
    if (targetId) meta.parents = [targetId];
    
    // Handle binary vs text content
    if (is_base64) {
      // Binary upload using simple upload then update metadata
      // First decode base64 to binary
      const binaryStr = atob(content);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      
      // Use resumable upload for binary files (more reliable)
      // Step 1: Initiate resumable upload
      const initResp = await fetch(DRIVE_UPLOAD_URL + '/files?uploadType=resumable', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': mime,
          'X-Upload-Content-Length': bytes.length.toString(),
        },
        body: JSON.stringify(meta),
      });
      
      if (!initResp.ok) {
        const err = await initResp.text();
        return { content: [{ type: "text", text: "⛔ Error initiating upload: " + err }] };
      }
      
      const uploadUrl = initResp.headers.get('Location');
      if (!uploadUrl) {
        return { content: [{ type: "text", text: "⛔ No upload URL returned" }] };
      }
      
      // Step 2: Upload the binary content
      const uploadResp = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': mime,
          'Content-Length': bytes.length.toString(),
        },
        body: bytes,
      });
      
      if (!uploadResp.ok) {
        const err = await uploadResp.text();
        return { content: [{ type: "text", text: "⛔ Error uploading file: " + err }] };
      }
      
      const file: any = await uploadResp.json();
      return { content: [{ type: "text", text: '✅ Saved: ' + file.name + folderInfo + '\nhttps://drive.google.com/file/d/' + file.id + '/view' }] };
      
    } else {
      // Text upload using multipart (existing behavior)
      const boundary = '---b' + Date.now();
      const body = '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n' + content + '\r\n--' + boundary + '--';
      
      const resp = await fetch(DRIVE_UPLOAD_URL + '/files?uploadType=multipart&fields=id,name,webViewLink,parents', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
        body: body
      });
      
      if (!resp.ok) {
        const err = await resp.text();
        return { content: [{ type: "text", text: "⛔ Error saving file: " + err }] };
      }
      
      const file: any = await resp.json();
      return { content: [{ type: "text", text: '✅ Saved: ' + file.name + folderInfo + '\n' + file.webViewLink }] };
    }
  });

  server.tool("search_drive", { query: z.string() }, async ({ query }) => {
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) return { content: [{ type: "text", text: "⛔ Not connected. Run: connect_service google_drive" }] };
    
    const resp = await fetch(DRIVE_API_URL + '/files?q=' + encodeURIComponent("name contains '" + query + "' and trashed = false") + '&fields=files(id,name,webViewLink,parents)&pageSize=10', { 
      headers: { Authorization: 'Bearer ' + token } 
    });
    const data: any = await resp.json();
    if (!data.files?.length) return { content: [{ type: "text", text: 'No results for "' + query + '"' }] };
    
    let out = '🔍 Results:\n';
    data.files.forEach((f: any) => { out += '• ' + f.name + '\n  ' + f.webViewLink + '\n'; });
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("read_from_drive", { 
    file_id: z.string().describe("File ID from search_drive or list_drive_folders"),
  }, async ({ file_id }) => {
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) return { content: [{ type: "text", text: "⛔ Not connected. Run: connect_service google_drive" }] };
    
    // First get file metadata to check type
    const metaResp = await fetch(DRIVE_API_URL + '/files/' + file_id + '?fields=id,name,mimeType,size', {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!metaResp.ok) {
      return { content: [{ type: "text", text: "⛔ File not found or access denied" }] };
    }
    
    const meta: any = await metaResp.json();
    
    // Google Docs need to be exported
    const googleDocTypes: Record<string, string> = {
      'application/vnd.google-apps.document': 'text/plain',
      'application/vnd.google-apps.spreadsheet': 'text/csv',
      'application/vnd.google-apps.presentation': 'text/plain',
    };
    
    let content: string;
    
    if (googleDocTypes[meta.mimeType]) {
      // Export Google Docs/Sheets/Slides
      const exportMime = googleDocTypes[meta.mimeType];
      const exportResp = await fetch(DRIVE_API_URL + '/files/' + file_id + '/export?mimeType=' + encodeURIComponent(exportMime), {
        headers: { Authorization: 'Bearer ' + token }
      });
      
      if (!exportResp.ok) {
        return { content: [{ type: "text", text: "⛔ Error exporting Google Doc" }] };
      }
      
      content = await exportResp.text();
    } else {
      // Download regular files directly
      const downloadResp = await fetch(DRIVE_API_URL + '/files/' + file_id + '?alt=media', {
        headers: { Authorization: 'Bearer ' + token }
      });
      
      if (!downloadResp.ok) {
        return { content: [{ type: "text", text: "⛔ Error downloading file" }] };
      }
      
      content = await downloadResp.text();
    }
    
    // Truncate if too long
    const maxLength = 50000;
    const truncated = content.length > maxLength;
    if (truncated) {
      content = content.slice(0, maxLength);
    }
    
    let out = `📄 **${meta.name}**\n`;
    out += `Type: ${meta.mimeType}\n`;
    out += `---\n\n${content}`;
    if (truncated) {
      out += '\n\n... (truncated)';
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("update_drive_file", { 
    file_id: z.string().describe("File ID to update"),
    content: z.string().describe("New file content"),
  }, async ({ file_id, content }) => {
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) return { content: [{ type: "text", text: "⛔ Not connected. Run: connect_service google_drive" }] };
    
    // Get file metadata first
    const metaResp = await fetch(DRIVE_API_URL + '/files/' + file_id + '?fields=id,name,mimeType', {
      headers: { Authorization: 'Bearer ' + token }
    });
    
    if (!metaResp.ok) {
      return { content: [{ type: "text", text: "⛔ File not found or access denied" }] };
    }
    
    const meta: any = await metaResp.json();
    
    // Can't update Google Docs this way - they need the Docs API
    if (meta.mimeType.startsWith('application/vnd.google-apps.')) {
      return { content: [{ type: "text", text: "⛔ Cannot update Google Docs/Sheets directly. Only regular files (.ts, .md, etc) can be updated." }] };
    }
    
    // Update the file content
    const updateResp = await fetch(DRIVE_UPLOAD_URL + '/files/' + file_id + '?uploadType=media', {
      method: 'PATCH',
      headers: { 
        Authorization: 'Bearer ' + token,
        'Content-Type': meta.mimeType || 'text/plain',
      },
      body: content
    });
    
    if (!updateResp.ok) {
      const err = await updateResp.text();
      return { content: [{ type: "text", text: "⛔ Error updating file: " + err }] };
    }
    
    const updated: any = await updateResp.json();
    return { content: [{ type: "text", text: `✅ Updated: ${updated.name}` }] };
  });

  server.tool("get_folder_id", {
    folder_path: z.string().describe("Folder path like 'Untitled Publishers/BethaneK/productivity-mcp-server/src/tools'"),
  }, async ({ folder_path }) => {
    const token = await getValidToken(env, getCurrentUser(), 'google_drive');
    if (!token) return { content: [{ type: "text", text: "⛔ Not connected. Run: connect_service google_drive" }] };
    
    const parts = folder_path.split('/').filter(p => p.trim());
    let parentId = 'root';
    let currentFolder = { id: 'root', name: 'My Drive' };
    const pathTraversed: string[] = [];
    
    for (const folderName of parts) {
      const query = "'" + parentId + "' in parents and name = '" + folderName.replace(/'/g, "\\'") + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
      
      const response = await fetch(DRIVE_API_URL + '/files?q=' + encodeURIComponent(query) + '&fields=files(id,name)', {
        headers: { Authorization: 'Bearer ' + token },
      });
      
      if (!response.ok) {
        return { content: [{ type: "text", text: `⛔ Error searching at: ${pathTraversed.join('/')}/${folderName}` }] };
      }
      
      const data: any = await response.json();
      
      if (data.files.length === 0) {
        return { content: [{ type: "text", text: `⛔ Folder not found: "${folderName}" in ${pathTraversed.length > 0 ? pathTraversed.join('/') : 'root'}\n\n💡 Use list_drive_folders with parent_id to see available folders.` }] };
      }
      
      if (data.files.length > 1) {
        let out = `⚠️ Multiple folders named "${folderName}" found:\n`;
        data.files.forEach((f: any) => { out += `• ${f.name} (ID: ${f.id})\n`; });
        out += '\n💡 Use the specific folder_id to avoid ambiguity.';
        return { content: [{ type: "text", text: out }] };
      }
      
      currentFolder = data.files[0];
      parentId = currentFolder.id;
      pathTraversed.push(folderName);
    }
    
    return { content: [{ type: "text", text: `📁 **${folder_path}**\n\nFolder ID: \`${currentFolder.id}\`\n\n💡 Use this ID with save_to_drive's folder_id parameter for reliable saves.` }] };
  });
}
