// Author management tools - for blog author profiles

import { z } from "zod";
import type { ToolContext } from '../types';

export function registerAuthorsTools(ctx: ToolContext) {
  const { server, env } = ctx;

  server.tool("author_list", {}, async () => {
    const result = await env.DB.prepare(
      'SELECT id, name, slug, bio, photo_url, email, created_at FROM authors ORDER BY name'
    ).all();
    
    if (result.results.length === 0) {
      return { content: [{ type: "text", text: "No authors found. Use author_create to add one." }] };
    }
    
    let out = '👤 **Authors** (' + result.results.length + ')\n\n';
    
    for (const author of result.results as any[]) {
      out += '• **' + author.name + '** (' + author.slug + ')\n';
      if (author.bio) out += '  ' + (author.bio.length > 100 ? author.bio.substring(0, 100) + '...' : author.bio) + '\n';
      if (author.email) out += '  📧 ' + author.email + '\n';
      out += '  ID: ' + author.id + '\n\n';
    }
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("author_get", {
    id: z.string().optional().describe("Author ID"),
    slug: z.string().optional().describe("Author slug (e.g., 'micaiah-bussey')"),
  }, async ({ id, slug }) => {
    if (!id && !slug) {
      return { content: [{ type: "text", text: "Need either id or slug to find author." }] };
    }
    
    let author: any;
    if (id) {
      author = await env.DB.prepare('SELECT * FROM authors WHERE id = ?').bind(id).first();
    } else {
      author = await env.DB.prepare('SELECT * FROM authors WHERE slug = ?').bind(slug).first();
    }
    
    if (!author) {
      return { content: [{ type: "text", text: 'Author not found.' }] };
    }
    
    let out = '👤 **' + author.name + '**\n\n';
    out += '**ID:** ' + author.id + '\n';
    out += '**Slug:** ' + author.slug + '\n';
    if (author.email) out += '**Email:** ' + author.email + '\n';
    if (author.photo_url) out += '**Photo:** ' + author.photo_url + '\n';
    if (author.bio) out += '\n**Bio:**\n' + author.bio + '\n';
    out += '\n**Created:** ' + author.created_at;
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("author_create", {
    name: z.string().describe("Author's display name"),
    slug: z.string().describe("URL-safe identifier (e.g., 'john-doe')"),
    bio: z.string().optional().describe("Author biography"),
    photo_url: z.string().optional().describe("URL to author's photo"),
    email: z.string().optional().describe("Author's email address"),
  }, async ({ name, slug, bio, photo_url, email }) => {
    // Normalize slug
    const normalizedSlug = slug.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    
    // Check if slug already exists
    const existing = await env.DB.prepare(
      'SELECT id FROM authors WHERE slug = ?'
    ).bind(normalizedSlug).first();
    
    if (existing) {
      return { content: [{ type: "text", text: 'Author with slug "' + normalizedSlug + '" already exists.' }] };
    }
    
    const id = 'author-' + crypto.randomUUID().split('-')[0];
    
    await env.DB.prepare(
      'INSERT INTO authors (id, name, slug, bio, photo_url, email) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, name, normalizedSlug, bio || null, photo_url || null, email || null).run();
    
    return { content: [{ type: "text", text: '✅ Created author "' + name + '" (slug: ' + normalizedSlug + ')\nID: ' + id }] };
  });

  server.tool("author_update", {
    id: z.string().describe("Author ID to update"),
    name: z.string().optional().describe("New display name"),
    slug: z.string().optional().describe("New URL-safe identifier"),
    bio: z.string().optional().describe("New biography"),
    photo_url: z.string().optional().describe("New photo URL"),
    email: z.string().optional().describe("New email address"),
  }, async ({ id, name, slug, bio, photo_url, email }) => {
    // Check author exists
    const existing = await env.DB.prepare(
      'SELECT * FROM authors WHERE id = ?'
    ).bind(id).first();
    
    if (!existing) {
      return { content: [{ type: "text", text: 'Author not found.' }] };
    }
    
    const updates: string[] = [];
    const bindings: any[] = [];
    
    if (name !== undefined) {
      updates.push('name = ?');
      bindings.push(name);
    }
    
    if (slug !== undefined) {
      const normalizedSlug = slug.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      // Check slug isn't taken by another author
      const slugCheck = await env.DB.prepare(
        'SELECT id FROM authors WHERE slug = ? AND id != ?'
      ).bind(normalizedSlug, id).first();
      
      if (slugCheck) {
        return { content: [{ type: "text", text: 'Slug "' + normalizedSlug + '" is already in use.' }] };
      }
      
      updates.push('slug = ?');
      bindings.push(normalizedSlug);
    }
    
    if (bio !== undefined) {
      updates.push('bio = ?');
      bindings.push(bio || null);
    }
    
    if (photo_url !== undefined) {
      updates.push('photo_url = ?');
      bindings.push(photo_url || null);
    }
    
    if (email !== undefined) {
      updates.push('email = ?');
      bindings.push(email || null);
    }
    
    if (updates.length === 0) {
      return { content: [{ type: "text", text: 'No updates provided.' }] };
    }
    
    bindings.push(id);
    
    await env.DB.prepare(
      'UPDATE authors SET ' + updates.join(', ') + ' WHERE id = ?'
    ).bind(...bindings).run();
    
    return { content: [{ type: "text", text: '✅ Updated author "' + (name || existing.name) + '"' }] };
  });

  server.tool("author_delete", {
    id: z.string().describe("Author ID to delete"),
  }, async ({ id }) => {
    const existing = await env.DB.prepare(
      'SELECT name FROM authors WHERE id = ?'
    ).bind(id).first();
    
    if (!existing) {
      return { content: [{ type: "text", text: 'Author not found.' }] };
    }
    
    await env.DB.prepare('DELETE FROM authors WHERE id = ?').bind(id).run();
    
    return { content: [{ type: "text", text: '🗑️ Deleted author "' + existing.name + '"' }] };
  });
}
