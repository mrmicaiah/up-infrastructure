// Capture Portal tools - Client photo upload management

import { z } from "zod";
import type { ToolContext } from '../types';

export function registerCaptureTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  // ============================================================================
  // capture_create_portal - Create a new client upload portal
  // ============================================================================
  server.tool("capture_create_portal", {
    client_name: z.string().describe("Client's business name (e.g., 'Smith Plumbing')"),
    client_slug: z.string().describe("URL-safe identifier (e.g., 'smith-plumbing')"),
    pin: z.string().describe("4-digit PIN for client access"),
    cloudinary_folder: z.string().optional().describe("Cloudinary folder path (defaults to 'clients/{slug}')"),
  }, async ({ client_name, client_slug, pin, cloudinary_folder }) => {
    const slug = client_slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const folder = cloudinary_folder || `clients/${slug}`;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      await env.DB.prepare(`
        INSERT INTO capture_portals (id, user_id, client_slug, client_name, pin, cloudinary_folder, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
      `).bind(id, getCurrentUser(), slug, client_name, pin, folder, now).run();

      let out = `✅ **Capture Portal Created**\n\n`;
      out += `**Client:** ${client_name}\n`;
      out += `**URL:** untitledpublishers.com/capture/${slug}\n`;
      out += `**PIN:** ${pin}\n`;
      out += `**Cloudinary Folder:** ${folder}\n`;
      out += `\nShare the URL and PIN with your client!`;

      return { content: [{ type: "text", text: out }] };
    } catch (e: any) {
      if (e.message?.includes('UNIQUE constraint')) {
        return { content: [{ type: "text", text: `❌ A portal with slug "${slug}" already exists` }] };
      }
      throw e;
    }
  });

  // ============================================================================
  // capture_list_portals - List all client portals
  // ============================================================================
  server.tool("capture_list_portals", {
    status: z.enum(['active', 'paused', 'all']).optional().default('active'),
  }, async ({ status }) => {
    let query = 'SELECT * FROM capture_portals WHERE user_id = ?';
    const params: any[] = [getCurrentUser()];

    if (status !== 'all') {
      query += ' AND status = ?';
      params.push(status);
    }
    query += ' ORDER BY created_at DESC';

    const portals = await env.DB.prepare(query).bind(...params).all();

    if (!portals.results || portals.results.length === 0) {
      return { content: [{ type: "text", text: "📷 No capture portals found.\n\nUse capture_create_portal to create one!" }] };
    }

    let out = `📷 **Capture Portals** (${portals.results.length})\n\n`;

    for (const p of portals.results as any[]) {
      // Get upload count
      const countResult = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM capture_uploads WHERE portal_id = ?'
      ).bind(p.id).first() as any;

      const uploadCount = countResult?.count || 0;

      out += `**${p.client_name}**\n`;
      out += `• URL: /capture/${p.client_slug}\n`;
      out += `• PIN: ${p.pin}\n`;
      out += `• Uploads: ${uploadCount}\n`;
      out += `• Status: ${p.status === 'active' ? '🟢' : '⏸️'} ${p.status}\n`;
      out += `• Folder: ${p.cloudinary_folder}\n`;
      out += `• ID: ${p.id}\n\n`;
    }

    return { content: [{ type: "text", text: out }] };
  });

  // ============================================================================
  // capture_get_portal - Get details of a specific portal
  // ============================================================================
  server.tool("capture_get_portal", {
    portal_id: z.string().optional(),
    client_slug: z.string().optional(),
  }, async ({ portal_id, client_slug }) => {
    if (!portal_id && !client_slug) {
      return { content: [{ type: "text", text: "❌ Provide either portal_id or client_slug" }] };
    }

    let portal: any;
    if (portal_id) {
      portal = await env.DB.prepare(
        'SELECT * FROM capture_portals WHERE id = ? AND user_id = ?'
      ).bind(portal_id, getCurrentUser()).first();
    } else {
      portal = await env.DB.prepare(
        'SELECT * FROM capture_portals WHERE client_slug = ? AND user_id = ?'
      ).bind(client_slug, getCurrentUser()).first();
    }

    if (!portal) {
      return { content: [{ type: "text", text: "❌ Portal not found" }] };
    }

    // Get recent uploads
    const uploads = await env.DB.prepare(`
      SELECT * FROM capture_uploads WHERE portal_id = ? ORDER BY uploaded_at DESC LIMIT 10
    `).bind(portal.id).all();

    // Get total count
    const countResult = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM capture_uploads WHERE portal_id = ?'
    ).bind(portal.id).first() as any;

    let out = `📷 **${portal.client_name}**\n\n`;
    out += `**Portal Details:**\n`;
    out += `• URL: untitledpublishers.com/capture/${portal.client_slug}\n`;
    out += `• PIN: ${portal.pin}\n`;
    out += `• Status: ${portal.status === 'active' ? '🟢 Active' : '⏸️ Paused'}\n`;
    out += `• Cloudinary Folder: ${portal.cloudinary_folder}\n`;
    out += `• Created: ${portal.created_at}\n`;
    out += `• Total Uploads: ${countResult?.count || 0}\n`;

    if (uploads.results && uploads.results.length > 0) {
      out += `\n**Recent Uploads:**\n`;
      for (const u of uploads.results as any[]) {
        out += `• ${u.original_filename || u.cloudinary_public_id} (${new Date(u.uploaded_at).toLocaleDateString()})\n`;
        out += `  ${u.cloudinary_url}\n`;
      }
    }

    return { content: [{ type: "text", text: out }] };
  });

  // ============================================================================
  // capture_update_portal - Update portal settings
  // ============================================================================
  server.tool("capture_update_portal", {
    portal_id: z.string().describe("Portal ID to update"),
    client_name: z.string().optional(),
    pin: z.string().optional(),
    cloudinary_folder: z.string().optional(),
    status: z.enum(['active', 'paused']).optional(),
  }, async ({ portal_id, client_name, pin, cloudinary_folder, status }) => {
    const updates: string[] = [];
    const params: any[] = [];

    if (client_name) { updates.push('client_name = ?'); params.push(client_name); }
    if (pin) { updates.push('pin = ?'); params.push(pin); }
    if (cloudinary_folder) { updates.push('cloudinary_folder = ?'); params.push(cloudinary_folder); }
    if (status) { updates.push('status = ?'); params.push(status); }

    if (updates.length === 0) {
      return { content: [{ type: "text", text: "❌ No updates provided" }] };
    }

    params.push(portal_id, getCurrentUser());

    await env.DB.prepare(`
      UPDATE capture_portals SET ${updates.join(', ')} WHERE id = ? AND user_id = ?
    `).bind(...params).run();

    let out = `✅ Portal updated`;
    if (status === 'paused') out += ` (now paused - clients cannot upload)`;
    if (status === 'active') out += ` (now active)`;

    return { content: [{ type: "text", text: out }] };
  });

  // ============================================================================
  // capture_delete_portal - Delete a portal
  // ============================================================================
  server.tool("capture_delete_portal", {
    portal_id: z.string().describe("Portal ID to delete"),
    confirm: z.boolean().describe("Set to true to confirm deletion"),
  }, async ({ portal_id, confirm }) => {
    if (!confirm) {
      return { content: [{ type: "text", text: "⚠️ This will delete the portal and all upload records (not the actual images in Cloudinary).\n\nSet confirm=true to proceed." }] };
    }

    // Delete uploads first
    await env.DB.prepare('DELETE FROM capture_uploads WHERE portal_id = ?').bind(portal_id).run();
    
    // Delete portal
    await env.DB.prepare(
      'DELETE FROM capture_portals WHERE id = ? AND user_id = ?'
    ).bind(portal_id, getCurrentUser()).run();

    return { content: [{ type: "text", text: "✅ Portal and upload records deleted.\n\nNote: Images in Cloudinary were not deleted." }] };
  });

  // ============================================================================
  // capture_list_uploads - List uploads for a portal
  // ============================================================================
  server.tool("capture_list_uploads", {
    portal_id: z.string().optional(),
    client_slug: z.string().optional(),
    limit: z.number().optional().default(20),
  }, async ({ portal_id, client_slug, limit }) => {
    let portalIdToUse = portal_id;

    if (!portalIdToUse && client_slug) {
      const portal = await env.DB.prepare(
        'SELECT id FROM capture_portals WHERE client_slug = ? AND user_id = ?'
      ).bind(client_slug, getCurrentUser()).first() as any;
      
      if (!portal) {
        return { content: [{ type: "text", text: `❌ Portal with slug "${client_slug}" not found` }] };
      }
      portalIdToUse = portal.id;
    }

    if (!portalIdToUse) {
      return { content: [{ type: "text", text: "❌ Provide either portal_id or client_slug" }] };
    }

    const uploads = await env.DB.prepare(`
      SELECT cu.*, cp.client_name 
      FROM capture_uploads cu
      JOIN capture_portals cp ON cu.portal_id = cp.id
      WHERE cu.portal_id = ?
      ORDER BY cu.uploaded_at DESC
      LIMIT ?
    `).bind(portalIdToUse, limit).all();

    if (!uploads.results || uploads.results.length === 0) {
      return { content: [{ type: "text", text: "📷 No uploads found for this portal" }] };
    }

    let out = `📷 **Uploads** (${uploads.results.length})\n\n`;

    for (const u of uploads.results as any[]) {
      const date = new Date(u.uploaded_at).toLocaleDateString();
      const size = u.file_size ? `${Math.round(u.file_size / 1024)} KB` : 'unknown size';
      
      out += `**${u.original_filename || 'Untitled'}**\n`;
      out += `• ${date} · ${size}\n`;
      out += `• ${u.cloudinary_url}\n`;
      if (u.thumbnail_url) out += `• Thumb: ${u.thumbnail_url}\n`;
      out += `\n`;
    }

    return { content: [{ type: "text", text: out }] };
  });

  // ============================================================================
  // capture_stats - Get upload statistics across all portals
  // ============================================================================
  server.tool("capture_stats", {}, async () => {
    const portals = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM capture_portals WHERE user_id = ?'
    ).bind(getCurrentUser()).first() as any;

    const activePortals = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM capture_portals WHERE user_id = ? AND status = 'active'"
    ).bind(getCurrentUser()).first() as any;

    const totalUploads = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM capture_uploads cu
      JOIN capture_portals cp ON cu.portal_id = cp.id
      WHERE cp.user_id = ?
    `).bind(getCurrentUser()).first() as any;

    const thisMonth = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM capture_uploads cu
      JOIN capture_portals cp ON cu.portal_id = cp.id
      WHERE cp.user_id = ? AND cu.uploaded_at >= date('now', 'start of month')
    `).bind(getCurrentUser()).first() as any;

    const topPortals = await env.DB.prepare(`
      SELECT cp.client_name, COUNT(cu.id) as upload_count
      FROM capture_portals cp
      LEFT JOIN capture_uploads cu ON cp.id = cu.portal_id
      WHERE cp.user_id = ?
      GROUP BY cp.id
      ORDER BY upload_count DESC
      LIMIT 5
    `).bind(getCurrentUser()).all();

    let out = `📊 **Capture Portal Stats**\n\n`;
    out += `**Overview:**\n`;
    out += `• Total Portals: ${portals?.count || 0} (${activePortals?.count || 0} active)\n`;
    out += `• Total Uploads: ${totalUploads?.count || 0}\n`;
    out += `• This Month: ${thisMonth?.count || 0}\n`;

    if (topPortals.results && topPortals.results.length > 0) {
      out += `\n**Top Clients:**\n`;
      for (const p of topPortals.results as any[]) {
        out += `• ${p.client_name}: ${p.upload_count} uploads\n`;
      }
    }

    return { content: [{ type: "text", text: out }] };
  });
}
