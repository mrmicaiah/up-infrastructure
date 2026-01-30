// GitHub integration tools

import { z } from "zod";
import type { ToolContext } from '../types';
import { getGitHubToken, buildGitHubOAuthUrl, GITHUB_API_URL } from '../oauth';

// Helper to check if a repo is protected
async function isRepoProtected(db: any, repo: string): Promise<{ protected: boolean; reason?: string }> {
  try {
    // Normalize repo name - could be "courier" or "mrmicaiah/courier"
    const result = await db.prepare(
      'SELECT * FROM protected_repos WHERE repo = ? OR repo LIKE ?'
    ).bind(repo, '%/' + repo).first();
    
    if (result) {
      return { protected: true, reason: result.reason };
    }
  } catch (e) {
    // Table might not exist yet, allow writes
  }
  return { protected: false };
}

// Helper to normalize repo path
async function normalizeRepoPath(token: string, repo: string): Promise<string> {
  if (repo.includes('/')) {
    return repo;
  }
  
  const userResp = await fetch(GITHUB_API_URL + "/user", {
    headers: { 
      Authorization: "Bearer " + token,
      "User-Agent": "UntitledPublishers-MCP",
      Accept: "application/vnd.github.v3+json",
    }
  });
  
  if (!userResp.ok) {
    throw new Error("Could not get GitHub user");
  }
  
  const user: any = await userResp.json();
  return user.login + "/" + repo;
}

export function registerGitHubTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  // ==================== DEPLOY STATUS TOOLS ====================
  
  server.tool("check_deploys", {
    repo: z.string().optional().describe("Filter by repo name (e.g., 'up-infrastructure' or 'mrmicaiah/up-infrastructure')"),
    limit: z.number().optional().default(5).describe("Number of deploys to show"),
  }, async ({ repo, limit }) => {
    const db = env.DB;
    
    try {
      let query = 'SELECT * FROM deploys';
      const params: any[] = [];
      
      if (repo) {
        // Support both "repo" and "owner/repo" formats
        query += ' WHERE repo = ? OR repo LIKE ?';
        params.push(repo, '%/' + repo);
      }
      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      
      const deploys = await db.prepare(query).bind(...params).all();
      
      if (!deploys.results || deploys.results.length === 0) {
        return { content: [{ type: "text", text: "📭 No deploys recorded yet.\n\nMake sure the GitHub webhook is configured to send workflow_run events to:\n`https://productivity-mcp-server.micaiah-tasks.workers.dev/api/github-webhook`" }] };
      }
      
      let out = "🚀 **Recent Deploys**\n\n";
      
      for (const d of deploys.results as any[]) {
        const statusIcon = d.status === 'success' ? '✅' : 
                          d.status === 'failure' ? '❌' : 
                          d.status === 'in_progress' ? '🔄' : 
                          d.status === 'cancelled' ? '⚪' : '❓';
        
        out += `${statusIcon} **${d.repo}** - ${d.workflow}\n`;
        out += `   Branch: \`${d.branch || 'unknown'}\``;
        if (d.commit_message) out += ` | "${d.commit_message}"`;
        out += '\n';
        out += `   Status: ${d.status}`;
        if (d.duration_seconds) out += ` (${d.duration_seconds}s)`;
        out += '\n';
        if (d.error_message) out += `   ⚠️ ${d.error_message}\n`;
        out += `   ${new Date(d.created_at).toLocaleString()}\n\n`;
      }
      
      return { content: [{ type: "text", text: out }] };
      
    } catch (e: any) {
      if (e.message?.includes('no such table')) {
        return { content: [{ type: "text", text: "❌ Deploys table not created yet. Run the migration:\n```\nnpx wrangler d1 execute productivity-db --file=productivity-mcp/deploys-migration.sql\n```" }] };
      }
      return { content: [{ type: "text", text: "❌ Error checking deploys: " + e.message }] };
    }
  });

  server.tool("deploy_status", {
    repo: z.string().describe("Repository name to check latest deploy for"),
  }, async ({ repo }) => {
    const db = env.DB;
    
    try {
      const deploy = await db.prepare(
        'SELECT * FROM deploys WHERE repo = ? OR repo LIKE ? ORDER BY created_at DESC LIMIT 1'
      ).bind(repo, '%/' + repo).first() as any;
      
      if (!deploy) {
        return { content: [{ type: "text", text: `📭 No deploys found for **${repo}**` }] };
      }
      
      const statusIcon = deploy.status === 'success' ? '✅' : 
                        deploy.status === 'failure' ? '❌' : 
                        deploy.status === 'in_progress' ? '🔄' : 
                        deploy.status === 'cancelled' ? '⚪' : '❓';
      
      let out = `${statusIcon} **${deploy.repo}** - Latest Deploy\n\n`;
      out += `**Workflow:** ${deploy.workflow}\n`;
      out += `**Branch:** \`${deploy.branch || 'unknown'}\`\n`;
      out += `**Status:** ${deploy.status}\n`;
      if (deploy.commit_sha) out += `**Commit:** \`${deploy.commit_sha.substring(0, 7)}\`\n`;
      if (deploy.commit_message) out += `**Message:** "${deploy.commit_message}"\n`;
      if (deploy.triggered_by) out += `**Triggered by:** ${deploy.triggered_by}\n`;
      if (deploy.duration_seconds) out += `**Duration:** ${deploy.duration_seconds}s\n`;
      if (deploy.error_message) out += `\n⚠️ **Error:** ${deploy.error_message}\n`;
      out += `\n**Time:** ${new Date(deploy.created_at).toLocaleString()}`;
      
      return { content: [{ type: "text", text: out }] };
      
    } catch (e: any) {
      if (e.message?.includes('no such table')) {
        return { content: [{ type: "text", text: "❌ Deploys table not created yet. Run the migration:\n```\nnpx wrangler d1 execute productivity-db --file=productivity-mcp/deploys-migration.sql\n```" }] };
      }
      return { content: [{ type: "text", text: "❌ Error: " + e.message }] };
    }
  });

  // ==================== GITHUB TOOLS ====================

  server.tool("github_status", {}, async () => {
    const token = await getGitHubToken(env, getCurrentUser());
    
    if (!token) {
      const workerName = env.WORKER_NAME || `productivity-${env.USER_ID === 'micaiah' ? 'mcp-server' : env.USER_ID}`;
      const workerUrl = `https://${workerName}.micaiah-tasks.workers.dev`;
      const url = buildGitHubOAuthUrl(env, getCurrentUser(), workerUrl);
      return { content: [{ type: "text", text: "GitHub not connected. Connect here:\n" + url }] };
    }
    
    const resp = await fetch(GITHUB_API_URL + "/user", {
      headers: { 
        Authorization: "Bearer " + token,
        "User-Agent": "UntitledPublishers-MCP",
        Accept: "application/vnd.github.v3+json",
      }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "GitHub token invalid. Please reconnect." }] };
    }
    
    const user: any = await resp.json();
    return { content: [{ type: "text", text: "✅ GitHub connected as " + user.login + "\n\nProfile: " + user.html_url }] };
  });

  server.tool("github_list_repos", {
    visibility: z.enum(["all", "public", "private"]).optional().default("all"),
  }, async ({ visibility }) => {
    const token = await getGitHubToken(env, getCurrentUser());
    
    if (!token) {
      return { content: [{ type: "text", text: "❌ GitHub not connected. Run: connect_service github" }] };
    }
    
    const resp = await fetch(GITHUB_API_URL + "/user/repos?visibility=" + visibility + "&sort=updated&per_page=20", {
      headers: { 
        Authorization: "Bearer " + token,
        "User-Agent": "UntitledPublishers-MCP",
        Accept: "application/vnd.github.v3+json",
      }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "❌ Error fetching repos" }] };
    }
    
    const repos: any[] = await resp.json();
    
    if (repos.length === 0) {
      return { content: [{ type: "text", text: "📂 No repositories found" }] };
    }
    
    let out = "📂 **Your Repositories**\n\n";
    repos.forEach((repo: any) => {
      const vis = repo.private ? "🔒" : "🌐";
      out += vis + " **" + repo.name + "**\n";
      out += "   " + repo.html_url + "\n";
      if (repo.description) out += "   " + repo.description + "\n";
      out += "\n";
    });
    
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("github_push_file", {
    repo: z.string().describe("Repository name (e.g., 'UntitledPublishers' or 'owner/repo')"),
    path: z.string().describe("File path in repo (e.g., 'index.html')"),
    content: z.string().describe("File content"),
    message: z.string().optional().default("Update file via MCP"),
    branch: z.string().optional().default("main"),
  }, async ({ repo, path, content, message, branch }) => {
    const token = await getGitHubToken(env, getCurrentUser());
    
    if (!token) {
      return { content: [{ type: "text", text: "❌ GitHub not connected. Run: connect_service github" }] };
    }
    
    let repoPath: string;
    try {
      repoPath = await normalizeRepoPath(token, repo);
    } catch (e) {
      return { content: [{ type: "text", text: "❌ Could not get GitHub user" }] };
    }
    
    // Check if repo is protected
    const protection = await isRepoProtected(env.DB, repoPath);
    if (protection.protected) {
      return { content: [{ type: "text", text: `🔒 **${repoPath}** is protected.\n\nWrite operations are blocked to prevent accidental changes.${protection.reason ? '\n\nReason: ' + protection.reason : ''}\n\n_To make changes, unprotect the repo in Helm first._` }] };
    }
    
    let sha: string | undefined;
    const existingResp = await fetch(GITHUB_API_URL + "/repos/" + repoPath + "/contents/" + path + "?ref=" + branch, {
      headers: { 
        Authorization: "Bearer " + token,
        "User-Agent": "UntitledPublishers-MCP",
        Accept: "application/vnd.github.v3+json",
      }
    });
    
    if (existingResp.ok) {
      const existing: any = await existingResp.json();
      sha = existing.sha;
    }
    
    const body: any = {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      branch,
    };
    if (sha) body.sha = sha;
    
    const resp = await fetch(GITHUB_API_URL + "/repos/" + repoPath + "/contents/" + path, {
      method: "PUT",
      headers: { 
        Authorization: "Bearer " + token,
        "User-Agent": "UntitledPublishers-MCP",
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    
    if (!resp.ok) {
      const err = await resp.text();
      return { content: [{ type: "text", text: "❌ Failed to push file: " + err }] };
    }
    
    const result: any = await resp.json();
    return { content: [{ type: "text", text: "✅ Pushed " + path + " to " + repoPath + "\n\n" + result.content.html_url }] };
  });

  server.tool("github_push_files", {
    repo: z.string().describe("Repository name"),
    files: z.array(z.object({
      path: z.string(),
      content: z.string(),
    })).describe("Array of files to push"),
    message: z.string().optional().default("Update files via MCP"),
    branch: z.string().optional().default("main"),
  }, async ({ repo, files, message, branch }) => {
    const token = await getGitHubToken(env, getCurrentUser());
    
    if (!token) {
      return { content: [{ type: "text", text: "❌ GitHub not connected. Run: connect_service github" }] };
    }
    
    let repoPath: string;
    try {
      repoPath = await normalizeRepoPath(token, repo);
    } catch (e) {
      return { content: [{ type: "text", text: "❌ Could not get GitHub user" }] };
    }
    
    // Check if repo is protected
    const protection = await isRepoProtected(env.DB, repoPath);
    if (protection.protected) {
      return { content: [{ type: "text", text: `🔒 **${repoPath}** is protected.\n\nWrite operations are blocked to prevent accidental changes.${protection.reason ? '\n\nReason: ' + protection.reason : ''}\n\n_To make changes, unprotect the repo in Helm first._` }] };
    }
    
    const refResp = await fetch(GITHUB_API_URL + "/repos/" + repoPath + "/git/ref/heads/" + branch, {
      headers: { 
        Authorization: "Bearer " + token,
        "User-Agent": "UntitledPublishers-MCP",
        Accept: "application/vnd.github.v3+json",
      }
    });
    
    if (!refResp.ok) {
      return { content: [{ type: "text", text: "❌ Could not get branch ref. Does the branch exist?" }] };
    }
    
    const ref: any = await refResp.json();
    const commitSha = ref.object.sha;
    
    const commitResp = await fetch(GITHUB_API_URL + "/repos/" + repoPath + "/git/commits/" + commitSha, {
      headers: { 
        Authorization: "Bearer " + token,
        "User-Agent": "UntitledPublishers-MCP",
        Accept: "application/vnd.github.v3+json",
      }
    });
    
    if (!commitResp.ok) {
      return { content: [{ type: "text", text: "❌ Could not get commit" }] };
    }
    
    const commit: any = await commitResp.json();
    const treeSha = commit.tree.sha;
    
    const treeItems: any[] = [];
    for (const file of files) {
      const blobResp = await fetch(GITHUB_API_URL + "/repos/" + repoPath + "/git/blobs", {
        method: "POST",
        headers: { 
          Authorization: "Bearer " + token,
          "User-Agent": "UntitledPublishers-MCP",
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: file.content,
          encoding: "utf-8",
        }),
      });
      
      if (!blobResp.ok) {
        return { content: [{ type: "text", text: "❌ Failed to create blob for " + file.path }] };
      }
      
      const blob: any = await blobResp.json();
      treeItems.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }
    
    const newTreeResp = await fetch(GITHUB_API_URL + "/repos/" + repoPath + "/git/trees", {
      method: "POST",
      headers: { 
        Authorization: "Bearer " + token,
        "User-Agent": "UntitledPublishers-MCP",
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        base_tree: treeSha,
        tree: treeItems,
      }),
    });
    
    if (!newTreeResp.ok) {
      return { content: [{ type: "text", text: "❌ Failed to create tree" }] };
    }
    
    const newTree: any = await newTreeResp.json();
    
    const newCommitResp = await fetch(GITHUB_API_URL + "/repos/" + repoPath + "/git/commits", {
      method: "POST",
      headers: { 
        Authorization: "Bearer " + token,
        "User-Agent": "UntitledPublishers-MCP",
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        tree: newTree.sha,
        parents: [commitSha],
      }),
    });
    
    if (!newCommitResp.ok) {
      return { content: [{ type: "text", text: "❌ Failed to create commit" }] };
    }
    
    const newCommit: any = await newCommitResp.json();
    
    const updateRefResp = await fetch(GITHUB_API_URL + "/repos/" + repoPath + "/git/refs/heads/" + branch, {
      method: "PATCH",
      headers: { 
        Authorization: "Bearer " + token,
        "User-Agent": "UntitledPublishers-MCP",
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sha: newCommit.sha,
      }),
    });
    
    if (!updateRefResp.ok) {
      return { content: [{ type: "text", text: "❌ Failed to update branch" }] };
    }
    
    return { content: [{ type: "text", text: "✅ Pushed " + files.length + " files to " + repoPath + "\n\nCommit: " + newCommit.html_url }] };
  });

  server.tool("github_enable_pages", {
    repo: z.string().describe("Repository name"),
    branch: z.string().optional().default("main"),
    path: z.enum(["/", "/docs"]).optional().default("/"),
  }, async ({ repo, branch, path }) => {
    const token = await getGitHubToken(env, getCurrentUser());
    
    if (!token) {
      return { content: [{ type: "text", text: "❌ GitHub not connected. Run: connect_service github" }] };
    }
    
    let repoPath: string;
    try {
      repoPath = await normalizeRepoPath(token, repo);
    } catch (e) {
      return { content: [{ type: "text", text: "❌ Could not get GitHub user" }] };
    }
    
    const resp = await fetch(GITHUB_API_URL + "/repos/" + repoPath + "/pages", {
      method: "POST",
      headers: { 
        Authorization: "Bearer " + token,
        "User-Agent": "UntitledPublishers-MCP",
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: { branch, path },
      }),
    });
    
    if (resp.status === 409) {
      const pagesResp = await fetch(GITHUB_API_URL + "/repos/" + repoPath + "/pages", {
        headers: { 
          Authorization: "Bearer " + token,
          "User-Agent": "UntitledPublishers-MCP",
          Accept: "application/vnd.github.v3+json",
        }
      });
      
      if (pagesResp.ok) {
        const pages: any = await pagesResp.json();
        return { content: [{ type: "text", text: "ℹ️ GitHub Pages already enabled\n\n🌐 " + pages.html_url }] };
      }
    }
    
    if (!resp.ok) {
      const err = await resp.text();
      return { content: [{ type: "text", text: "❌ Failed to enable Pages: " + err }] };
    }
    
    const pages: any = await resp.json();
    return { content: [{ type: "text", text: "✅ GitHub Pages enabled!\n\n🌐 " + (pages.html_url || "URL will be available shortly") }] };
  });

  server.tool("github_get_file", {
    repo: z.string().describe("Repository name"),
    path: z.string().describe("File path in repo"),
    branch: z.string().optional().default("main"),
  }, async ({ repo, path, branch }) => {
    const token = await getGitHubToken(env, getCurrentUser());
    
    if (!token) {
      return { content: [{ type: "text", text: "❌ GitHub not connected. Run: connect_service github" }] };
    }
    
    let repoPath: string;
    try {
      repoPath = await normalizeRepoPath(token, repo);
    } catch (e) {
      return { content: [{ type: "text", text: "❌ Could not get GitHub user" }] };
    }
    
    const resp = await fetch(GITHUB_API_URL + "/repos/" + repoPath + "/contents/" + path + "?ref=" + branch, {
      headers: { 
        Authorization: "Bearer " + token,
        "User-Agent": "UntitledPublishers-MCP",
        Accept: "application/vnd.github.v3+json",
      }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "❌ File not found or error fetching" }] };
    }
    
    const file: any = await resp.json();
    
    if (file.type !== "file") {
      return { content: [{ type: "text", text: "❌ Path is not a file (it's a " + file.type + ")" }] };
    }
    
    const content = decodeURIComponent(escape(atob(file.content)));
    
    return { content: [{ type: "text", text: "📄 **" + path + "**\n\n```\n" + content + "\n```" }] };
  });

  server.tool("github_list_files", {
    repo: z.string().describe("Repository name"),
    path: z.string().optional().default(""),
    branch: z.string().optional().default("main"),
  }, async ({ repo, path, branch }) => {
    const token = await getGitHubToken(env, getCurrentUser());
    
    if (!token) {
      return { content: [{ type: "text", text: "❌ GitHub not connected. Run: connect_service github" }] };
    }
    
    let repoPath: string;
    try {
      repoPath = await normalizeRepoPath(token, repo);
    } catch (e) {
      return { content: [{ type: "text", text: "❌ Could not get GitHub user" }] };
    }
    
    const apiPath = path ? "/contents/" + path : "/contents";
    const resp = await fetch(GITHUB_API_URL + "/repos/" + repoPath + apiPath + "?ref=" + branch, {
      headers: { 
        Authorization: "Bearer " + token,
        "User-Agent": "UntitledPublishers-MCP",
        Accept: "application/vnd.github.v3+json",
      }
    });
    
    if (!resp.ok) {
      return { content: [{ type: "text", text: "❌ Could not list files" }] };
    }
    
    const items: any[] = await resp.json();
    
    if (!Array.isArray(items)) {
      return { content: [{ type: "text", text: "❌ Path is a file, not a directory" }] };
    }
    
    let out = "📁 **" + (path || "/") + "**\n\n";
    
    items.sort((a, b) => {
      if (a.type === "dir" && b.type !== "dir") return -1;
      if (a.type !== "dir" && b.type === "dir") return 1;
      return a.name.localeCompare(b.name);
    });
    
    for (const item of items) {
      const icon = item.type === "dir" ? "📁" : "📄";
      out += icon + " " + item.name + "\n";
    }
    
    return { content: [{ type: "text", text: out }] };
  });
}
