// Cloudinary integration tools

import { z } from "zod";
import type { ToolContext } from '../types';

const CLOUDINARY_API_BASE = "https://api.cloudinary.com/v1_1";

// Helper to build auth header
function getCloudinaryAuth(env: any): string {
  const credentials = env.CLOUDINARY_API_KEY + ":" + env.CLOUDINARY_API_SECRET;
  return "Basic " + btoa(credentials);
}

// Helper to check if Cloudinary is configured
function isCloudinaryConfigured(env: any): boolean {
  return !!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

export function registerCloudinaryTools(ctx: ToolContext) {
  const { server, env } = ctx;

  // ============================================================================
  // cloudinary_status - Check connection status
  // ============================================================================
  server.tool("cloudinary_status", {}, async () => {
    if (!isCloudinaryConfigured(env)) {
      return { 
        content: [{ 
          type: "text", 
          text: "❌ Cloudinary not configured.\n\nSet these secrets:\n• CLOUDINARY_CLOUD_NAME\n• CLOUDINARY_API_KEY\n• CLOUDINARY_API_SECRET" 
        }] 
      };
    }
    
    // Test connection by fetching usage stats
    const resp = await fetch(
      `${CLOUDINARY_API_BASE}/${env.CLOUDINARY_CLOUD_NAME}/usage`,
      {
        headers: {
          Authorization: getCloudinaryAuth(env),
        }
      }
    );
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "❌ Cloudinary credentials invalid" }] };
    }
    
    const usage: any = await resp.json();
    
    let out = "✅ **Cloudinary Connected**\n\n";
    out += `Cloud: ${env.CLOUDINARY_CLOUD_NAME}\n`;
    out += `Storage used: ${Math.round((usage.storage?.usage || 0) / 1024 / 1024)} MB\n`;
    out += `Bandwidth used: ${Math.round((usage.bandwidth?.usage || 0) / 1024 / 1024)} MB\n`;
    out += `Transformations: ${usage.transformations?.usage || 0}\n`;
    
    return { content: [{ type: "text", text: out }] };
  });

  // ============================================================================
  // cloudinary_upload - Upload an image
  // ============================================================================
  server.tool("cloudinary_upload", {
    image_base64: z.string().describe("Base64-encoded image data (without data:image prefix)"),
    filename: z.string().optional().describe("Desired filename (without extension)"),
    folder: z.string().optional().describe("Folder path (e.g., 'blog/covers')"),
    tags: z.array(z.string()).optional().describe("Tags for organization"),
    overwrite: z.boolean().optional().default(false).describe("Overwrite if exists"),
  }, async ({ image_base64, filename, folder, tags, overwrite }) => {
    if (!isCloudinaryConfigured(env)) {
      return { content: [{ type: "text", text: "❌ Cloudinary not configured. Run cloudinary_status for setup instructions." }] };
    }
    
    // Build form data for upload
    const formData = new FormData();
    formData.append("file", `data:image/auto;base64,${image_base64}`);
    formData.append("api_key", env.CLOUDINARY_API_KEY || '');
    formData.append("timestamp", Math.floor(Date.now() / 1000).toString());
    
    if (filename) formData.append("public_id", filename);
    if (folder) {
      formData.append("folder", folder);
      formData.append("asset_folder", folder);
    }
    if (tags && tags.length > 0) formData.append("tags", tags.join(","));
    if (overwrite) formData.append("overwrite", "true");
    
    // Generate signature
    const paramsToSign: Record<string, string> = {
      timestamp: Math.floor(Date.now() / 1000).toString(),
    };
    if (filename) paramsToSign.public_id = filename;
    if (folder) {
      paramsToSign.folder = folder;
      paramsToSign.asset_folder = folder;
    }
    if (tags && tags.length > 0) paramsToSign.tags = tags.join(",");
    if (overwrite) paramsToSign.overwrite = "true";
    
    const sortedParams = Object.keys(paramsToSign).sort()
      .map(key => `${key}=${paramsToSign[key]}`)
      .join("&");
    
    const signatureString = sortedParams + env.CLOUDINARY_API_SECRET;
    const encoder = new TextEncoder();
    const data = encoder.encode(signatureString);
    const hashBuffer = await crypto.subtle.digest("SHA-1", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const signature = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
    
    formData.append("signature", signature);
    
    const resp = await fetch(
      `${CLOUDINARY_API_BASE}/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
      {
        method: "POST",
        body: formData,
      }
    );
    
    if (!resp.ok) {
      const err = await resp.text();
      return { content: [{ type: "text", text: "❌ Upload failed: " + err }] };
    }
    
    const result: any = await resp.json();
    
    let out = "✅ **Image Uploaded**\n\n";
    out += `**URL:** ${result.secure_url}\n`;
    out += `**Public ID:** ${result.public_id}\n`;
    out += `**Size:** ${Math.round(result.bytes / 1024)} KB\n`;
    out += `**Dimensions:** ${result.width}x${result.height}\n`;
    out += `**Format:** ${result.format}\n`;
    
    return { content: [{ type: "text", text: out }] };
  });

  // ============================================================================
  // cloudinary_list - List images (uses Search API)
  // ============================================================================
  server.tool("cloudinary_list", {
    folder: z.string().optional().describe("Filter by folder name (e.g., 'beyond fake studying')"),
    tag: z.string().optional().describe("Filter by tag"),
    max_results: z.number().optional().default(30).describe("Max results (default 30)"),
  }, async ({ folder, tag, max_results }) => {
    if (!isCloudinaryConfigured(env)) {
      return { content: [{ type: "text", text: "❌ Cloudinary not configured. Run cloudinary_status for setup instructions." }] };
    }
    
    // Always use Search API for more flexibility
    const searchUrl = `${CLOUDINARY_API_BASE}/${env.CLOUDINARY_CLOUD_NAME}/resources/search`;
    
    // Build search expression
    let expression = "resource_type:image";
    if (folder) {
      // Try asset_folder which is the Media Library folder assignment
      expression = `asset_folder="${folder}"`;
    }
    if (tag) {
      expression = tag ? `tags=${tag}` : expression;
    }
    
    const resp = await fetch(searchUrl, {
      method: "POST",
      headers: {
        Authorization: getCloudinaryAuth(env),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expression: expression,
        max_results: max_results,
        sort_by: [{ created_at: "desc" }],
        with_field: ["tags", "context", "asset_folder"],
      }),
    });
    
    if (!resp.ok) {
      const err = await resp.text();
      return { content: [{ type: "text", text: "❌ Search failed: " + err }] };
    }
    
    const result: any = await resp.json();
    
    if (!result.resources || result.resources.length === 0) {
      let msg = "📂 No images found";
      if (folder) msg += ` in folder: ${folder}`;
      if (tag) msg += ` with tag: ${tag}`;
      return { content: [{ type: "text", text: msg }] };
    }
    
    let out = "📂 **Images**";
    if (folder) out += ` in "${folder}"`;
    if (tag) out += ` tagged "${tag}"`;
    out += "\n\n";
    
    for (const img of result.resources) {
      out += `• **${img.public_id}**\n`;
      out += `  ${img.secure_url}\n`;
      out += `  ${img.width}x${img.height} · ${Math.round(img.bytes / 1024)} KB`;
      if (img.asset_folder) out += ` · 📁 ${img.asset_folder}`;
      out += "\n\n";
    }
    
    out += `_Showing ${result.resources.length} of ${result.total_count || result.resources.length} images_`;
    
    return { content: [{ type: "text", text: out }] };
  });

  // ============================================================================
  // cloudinary_delete - Delete an image
  // ============================================================================
  server.tool("cloudinary_delete", {
    public_id: z.string().describe("Public ID of the image to delete"),
  }, async ({ public_id }) => {
    if (!isCloudinaryConfigured(env)) {
      return { content: [{ type: "text", text: "❌ Cloudinary not configured. Run cloudinary_status for setup instructions." }] };
    }
    
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signatureString = `public_id=${public_id}&timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`;
    
    const encoder = new TextEncoder();
    const data = encoder.encode(signatureString);
    const hashBuffer = await crypto.subtle.digest("SHA-1", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const signature = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
    
    const formData = new FormData();
    formData.append("public_id", public_id);
    formData.append("api_key", env.CLOUDINARY_API_KEY || '');
    formData.append("timestamp", timestamp);
    formData.append("signature", signature);
    
    const resp = await fetch(
      `${CLOUDINARY_API_BASE}/${env.CLOUDINARY_CLOUD_NAME}/image/destroy`,
      {
        method: "POST",
        body: formData,
      }
    );
    
    if (!resp.ok) {
      const err = await resp.text();
      return { content: [{ type: "text", text: "❌ Delete failed: " + err }] };
    }
    
    const result: any = await resp.json();
    
    if (result.result === "ok") {
      return { content: [{ type: "text", text: `✅ Deleted: ${public_id}` }] };
    } else {
      return { content: [{ type: "text", text: `⚠️ Result: ${result.result}` }] };
    }
  });

  // ============================================================================
  // cloudinary_url - Generate transformed URL
  // ============================================================================
  server.tool("cloudinary_url", {
    public_id: z.string().describe("Public ID of the image"),
    width: z.number().optional().describe("Resize width"),
    height: z.number().optional().describe("Resize height"),
    crop: z.enum(["fill", "fit", "scale", "thumb", "crop"]).optional().describe("Crop mode"),
    quality: z.enum(["auto", "auto:low", "auto:eco", "auto:good", "auto:best"]).optional().default("auto").describe("Quality setting"),
    format: z.enum(["auto", "webp", "avif", "jpg", "png"]).optional().default("auto").describe("Output format"),
    gravity: z.enum(["auto", "face", "center", "north", "south", "east", "west"]).optional().describe("Gravity for crop"),
  }, async ({ public_id, width, height, crop, quality, format, gravity }) => {
    if (!isCloudinaryConfigured(env)) {
      return { content: [{ type: "text", text: "❌ Cloudinary not configured. Run cloudinary_status for setup instructions." }] };
    }
    
    const transformations: string[] = [];
    
    if (width || height) {
      let t = "";
      if (width) t += `w_${width}`;
      if (height) t += (t ? "," : "") + `h_${height}`;
      if (crop) t += `,c_${crop}`;
      if (gravity) t += `,g_${gravity}`;
      transformations.push(t);
    }
    
    if (quality) transformations.push(`q_${quality}`);
    if (format) transformations.push(`f_${format}`);
    
    const transformString = transformations.join("/");
    
    const url = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/${transformString}/${public_id}`;
    
    let out = "🔗 **Generated URL**\n\n";
    out += url + "\n\n";
    out += "**Transformations:**\n";
    if (width) out += `• Width: ${width}px\n`;
    if (height) out += `• Height: ${height}px\n`;
    if (crop) out += `• Crop: ${crop}\n`;
    if (gravity) out += `• Gravity: ${gravity}\n`;
    out += `• Quality: ${quality}\n`;
    out += `• Format: ${format}\n`;
    
    return { content: [{ type: "text", text: out }] };
  });

  // ============================================================================
  // cloudinary_folders - List folders
  // ============================================================================
  server.tool("cloudinary_folders", {
    parent: z.string().optional().describe("Parent folder path (empty for root)"),
  }, async ({ parent }) => {
    if (!isCloudinaryConfigured(env)) {
      return { content: [{ type: "text", text: "❌ Cloudinary not configured. Run cloudinary_status for setup instructions." }] };
    }
    
    let url = `${CLOUDINARY_API_BASE}/${env.CLOUDINARY_CLOUD_NAME}/folders`;
    if (parent) url += `/${parent}`;
    
    const resp = await fetch(url, {
      headers: {
        Authorization: getCloudinaryAuth(env),
      }
    });
    
    if (!resp.ok) {
      const err = await resp.text();
      return { content: [{ type: "text", text: "❌ Failed to list folders: " + err }] };
    }
    
    const result: any = await resp.json();
    
    if (!result.folders || result.folders.length === 0) {
      return { content: [{ type: "text", text: "📁 No folders found" + (parent ? ` in ${parent}` : " at root") }] };
    }
    
    let out = `📁 **Folders**${parent ? ` in ${parent}` : ""}\n\n`;
    
    for (const folder of result.folders) {
      out += `• ${folder.name} (${folder.path})\n`;
    }
    
    return { content: [{ type: "text", text: out }] };
  });
}
