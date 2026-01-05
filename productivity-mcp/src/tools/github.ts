// GitHub integration tools

import { z } from "zod";
import type { ToolContext } from '../types';
import { getGitHubToken, buildGitHubOAuthUrl, GITHUB_API_URL } from '../oauth';

export function registerGitHubTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

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
    
    let repoPath = repo;
    if (!repo.includes('/')) {
      const userResp = await fetch(GITHUB_API_URL + "/user", {
        headers: { 
          Authorization: "Bearer " + token,
          "User-Agent": "UntitledPublishers-MCP",
          Accept: "application/vnd.github.v3+json",
        }
      });
      if (!userResp.ok) {
        return { content: [{ type: "text", text: "❌ Could not get GitHub user" }] };
      }
      const user: any = await userResp.json();
      repoPath = user.login + "/" + repo;
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
    
    let repoPath = repo;
    if (!repo.includes('/')) {
      const userResp = await fetch(GITHUB_API_URL + "/user", {
        headers: { 
          Authorization: "Bearer " + token,
          "User-Agent": "UntitledPublishers-MCP",
          Accept: "application/vnd.github.v3+json",
        }
      });
      if (!userResp.ok) {
        return { content: [{ type: "text", text: "❌ Could not get GitHub user" }] };
      }
      const user: any = await userResp.json();
      repoPath = user.login + "/" + repo;
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
    
    let repoPath = repo;
    if (!repo.includes('/')) {
      const userResp = await fetch(GITHUB_API_URL + "/user", {
        headers: { 
          Authorization: "Bearer " + token,
          "User-Agent": "UntitledPublishers-MCP",
          Accept: "application/vnd.github.v3+json",
        }
      });
      if (!userResp.ok) {
        return { content: [{ type: "text", text: "❌ Could not get GitHub user" }] };
      }
      const user: any = await userResp.json();
      repoPath = user.login + "/" + repo;
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
    
    let repoPath = repo;
    if (!repo.includes('/')) {
      const userResp = await fetch(GITHUB_API_URL + "/user", {
        headers: { 
          Authorization: "Bearer " + token,
          "User-Agent": "UntitledPublishers-MCP",
          Accept: "application/vnd.github.v3+json",
        }
      });
      if (!userResp.ok) {
        return { content: [{ type: "text", text: "❌ Could not get GitHub user" }] };
      }
      const user: any = await userResp.json();
      repoPath = user.login + "/" + repo;
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
    
    let repoPath = repo;
    if (!repo.includes('/')) {
      const userResp = await fetch(GITHUB_API_URL + "/user", {
        headers: { 
          Authorization: "Bearer " + token,
          "User-Agent": "UntitledPublishers-MCP",
          Accept: "application/vnd.github.v3+json",
        }
      });
      if (!userResp.ok) {
        return { content: [{ type: "text", text: "❌ Could not get GitHub user" }] };
      }
      const user: any = await userResp.json();
      repoPath = user.login + "/" + repo;
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
