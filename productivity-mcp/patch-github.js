// Safe GitHub patch - run: node patch-github.js
const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'src', 'index.ts');
let content = fs.readFileSync(indexPath, 'utf8');

// Check if already patched
if (content.includes('GITHUB_API_URL')) {
  console.log('ERROR: GitHub already patched. Run "git checkout src/index.ts" first to restore original.');
  process.exit(1);
}

console.log('Patching GitHub integration...');

// 1. Add GitHub constants after BLOGGER_API_URL line
content = content.replace(
  "const BLOGGER_API_URL = 'https://www.googleapis.com/blogger/v3';",
  `const BLOGGER_API_URL = 'https://www.googleapis.com/blogger/v3';

// GitHub API
const GITHUB_OAUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_URL = 'https://api.github.com';`
);
console.log('  [1/11] Added GitHub constants');

// 2. Add github to OAUTH_SCOPES
content = content.replace(
  "  'blogger': 'https://www.googleapis.com/auth/blogger',\n};",
  "  'blogger': 'https://www.googleapis.com/auth/blogger',\n  'github': 'repo,read:user',\n};"
);
console.log('  [2/11] Updated OAUTH_SCOPES');

// 3. Add GitHub token helper after findOrCreateFolderPath function
const githubHelpers = `

// GitHub token helper
async function getGitHubToken(env: any, userId: string): Promise<string | null> {
  const token = await env.DB.prepare(
    'SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?'
  ).bind(userId, 'github').first();
  if (!token) return null;
  return token.access_token;
}

function buildGitHubOAuthUrl(env: any, userId: string, workerUrl: string): string {
  return GITHUB_OAUTH_URL + '?' + new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: workerUrl + '/oauth/callback',
    scope: 'repo read:user',
    state: userId + ':github',
  }).toString();
}
`;

content = content.replace(
  'return currentFolder;\n}\n\n// ==================\n// TOOL REGISTRATION',
  'return currentFolder;\n}' + githubHelpers + '\n// ==================\n// TOOL REGISTRATION'
);
console.log('  [3/11] Added GitHub helpers');

// 4. Update connection_status to check GitHub
content = content.replace(
  "const bloggerToken = await getValidToken(env, getCurrentUser(), 'blogger');",
  "const bloggerToken = await getValidToken(env, getCurrentUser(), 'blogger');\n    const githubToken = await getGitHubToken(env, getCurrentUser());"
);
content = content.replace(
  "status += bloggerToken ? '\\u2705 Blogger: Connected\\n' : '\\u274C Blogger: Not connected\\n';\n    \n    return",
  "status += bloggerToken ? '\\u2705 Blogger: Connected\\n' : '\\u274C Blogger: Not connected\\n';\n    status += githubToken ? '\\u2705 GitHub: Connected\\n' : '\\u274C GitHub: Not connected\\n';\n    \n    return"
);
console.log('  [4/11] Updated connection_status');

// 5. Update connect_service enum
content = content.replace(
  "z.enum(['google_drive', 'gmail_personal', 'gmail_company', 'blogger']).describe(\"Service to connect\")",
  "z.enum(['google_drive', 'gmail_personal', 'gmail_company', 'blogger', 'github']).describe(\"Service to connect\")"
);
console.log('  [5/11] Updated connect_service enum');

// 6. Update connect_service to handle GitHub OAuth URL
content = content.replace(
  "const url = buildOAuthUrl(env, getCurrentUser(), service, workerUrl);",
  "const url = service === 'github' ? buildGitHubOAuthUrl(env, getCurrentUser(), workerUrl) : buildOAuthUrl(env, getCurrentUser(), service, workerUrl);"
);
console.log('  [6/11] Updated connect_service URL builder');

// 7. Update connect_service serviceNames
content = content.replace(
  "      'blogger': 'Blogger',\n    };\n    \n    return { content: [{ type: \"text\", text: `\\u{1F517}",
  "      'blogger': 'Blogger',\n      'github': 'GitHub',\n    };\n    \n    return { content: [{ type: \"text\", text: `\\u{1F517}"
);
console.log('  [7/11] Updated connect_service serviceNames');

// 8. Update disconnect_service enum
content = content.replace(
  "z.enum(['google_drive', 'gmail_personal', 'gmail_company', 'blogger']).describe(\"Service to disconnect\")",
  "z.enum(['google_drive', 'gmail_personal', 'gmail_company', 'blogger', 'github']).describe(\"Service to disconnect\")"
);
console.log('  [8/11] Updated disconnect_service enum');

// 9. Update disconnect_service serviceNames
content = content.replace(
  "      'blogger': 'Blogger',\n    };\n    \n    return { content: [{ type: \"text\", text: `\\u{1F50C}",
  "      'blogger': 'Blogger',\n      'github': 'GitHub',\n    };\n    \n    return { content: [{ type: \"text\", text: `\\u{1F50C}"
);
console.log('  [9/11] Updated disconnect_service serviceNames');

// 10. Add GitHub tools before drive_status
const githubTools = `
  // ==================
  // GITHUB TOOLS
  // ==================
  
  server.tool("github_status", {}, async () => {
    const env = agent.env as any;
    const token = await getGitHubToken(env, getCurrentUser());
    if (!token) {
      const workerName = env.WORKER_NAME || \`productivity-\${env.USER_ID === 'micaiah' ? 'mcp-server' : env.USER_ID}\`;
      const workerUrl = \`https://\${workerName}.micaiah-tasks.workers.dev\`;
      const url = buildGitHubOAuthUrl(env, getCurrentUser(), workerUrl);
      return { content: [{ type: "text", text: "GitHub not connected. Connect here:\\n" + url }] };
    }
    const resp = await fetch(GITHUB_API_URL + "/user", {
      headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json" }
    });
    if (!resp.ok) return { content: [{ type: "text", text: "GitHub token invalid. Please reconnect." }] };
    const user: any = await resp.json();
    return { content: [{ type: "text", text: "GitHub connected as " + user.login + "\\nProfile: " + user.html_url }] };
  });

  server.tool("github_list_repos", { visibility: z.enum(["all", "public", "private"]).optional().default("all") }, async ({ visibility }) => {
    const env = agent.env as any;
    const token = await getGitHubToken(env, getCurrentUser());
    if (!token) return { content: [{ type: "text", text: "GitHub not connected. Run: connect_service github" }] };
    const resp = await fetch(GITHUB_API_URL + "/user/repos?visibility=" + visibility + "&sort=updated&per_page=20", {
      headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json" }
    });
    if (!resp.ok) return { content: [{ type: "text", text: "Error fetching repos" }] };
    const repos: any[] = await resp.json();
    if (repos.length === 0) return { content: [{ type: "text", text: "No repositories found" }] };
    let out = "Your Repositories:\\n\\n";
    repos.forEach((repo: any) => { out += (repo.private ? "[private] " : "[public] ") + repo.name + "\\n  " + repo.html_url + "\\n\\n"; });
    return { content: [{ type: "text", text: out }] };
  });

  server.tool("github_push_file", {
    repo: z.string().describe("Repository name"),
    path: z.string().describe("File path in repo"),
    content: z.string().describe("File content"),
    message: z.string().optional().default("Update via MCP"),
    branch: z.string().optional().default("main"),
  }, async ({ repo, path, content, message, branch }) => {
    const env = agent.env as any;
    const token = await getGitHubToken(env, getCurrentUser());
    if (!token) return { content: [{ type: "text", text: "GitHub not connected" }] };
    let fullRepo = repo;
    if (!repo.includes("/")) {
      const userResp = await fetch(GITHUB_API_URL + "/user", { headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP" } });
      const user: any = await userResp.json();
      fullRepo = user.login + "/" + repo;
    }
    let sha: string | undefined;
    const existingResp = await fetch(GITHUB_API_URL + "/repos/" + fullRepo + "/contents/" + path + "?ref=" + branch, {
      headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json" }
    });
    if (existingResp.ok) { const existing: any = await existingResp.json(); sha = existing.sha; }
    const encodedContent = btoa(unescape(encodeURIComponent(content)));
    const body: any = { message, content: encodedContent, branch };
    if (sha) body.sha = sha;
    const resp = await fetch(GITHUB_API_URL + "/repos/" + fullRepo + "/contents/" + path, {
      method: "PUT",
      headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!resp.ok) { const error = await resp.text(); return { content: [{ type: "text", text: "Error: " + error }] }; }
    const result: any = await resp.json();
    return { content: [{ type: "text", text: (sha ? "Updated" : "Created") + ": " + path + "\\n" + result.content.html_url }] };
  });

  server.tool("github_push_files", {
    repo: z.string(),
    files: z.array(z.object({ path: z.string(), content: z.string() })),
    message: z.string().optional().default("Update via MCP"),
    branch: z.string().optional().default("main"),
  }, async ({ repo, files, message, branch }) => {
    const env = agent.env as any;
    const token = await getGitHubToken(env, getCurrentUser());
    if (!token) return { content: [{ type: "text", text: "GitHub not connected" }] };
    let fullRepo = repo;
    if (!repo.includes("/")) {
      const userResp = await fetch(GITHUB_API_URL + "/user", { headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP" } });
      const user: any = await userResp.json();
      fullRepo = user.login + "/" + repo;
    }
    const results: string[] = [];
    for (const file of files) {
      let sha: string | undefined;
      const existingResp = await fetch(GITHUB_API_URL + "/repos/" + fullRepo + "/contents/" + file.path + "?ref=" + branch, {
        headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json" }
      });
      if (existingResp.ok) { const existing: any = await existingResp.json(); sha = existing.sha; }
      const encodedContent = btoa(unescape(encodeURIComponent(file.content)));
      const body: any = { message: message + " - " + file.path, content: encodedContent, branch };
      if (sha) body.sha = sha;
      const resp = await fetch(GITHUB_API_URL + "/repos/" + fullRepo + "/contents/" + file.path, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      results.push(resp.ok ? "[OK] " + file.path : "[FAIL] " + file.path);
    }
    return { content: [{ type: "text", text: "Push Results:\\n" + results.join("\\n") + "\\n\\nhttps://github.com/" + fullRepo }] };
  });

  server.tool("github_enable_pages", {
    repo: z.string(),
    branch: z.string().optional().default("main"),
  }, async ({ repo, branch }) => {
    const env = agent.env as any;
    const token = await getGitHubToken(env, getCurrentUser());
    if (!token) return { content: [{ type: "text", text: "GitHub not connected" }] };
    let fullRepo = repo;
    if (!repo.includes("/")) {
      const userResp = await fetch(GITHUB_API_URL + "/user", { headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP" } });
      const user: any = await userResp.json();
      fullRepo = user.login + "/" + repo;
    }
    const resp = await fetch(GITHUB_API_URL + "/repos/" + fullRepo + "/pages", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "User-Agent": "UntitledPublishers-MCP", Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
      body: JSON.stringify({ source: { branch, path: "/" } })
    });
    if (!resp.ok) {
      const error = await resp.text();
      if (error.includes("already")) return { content: [{ type: "text", text: "GitHub Pages already enabled" }] };
      return { content: [{ type: "text", text: "Error: " + error }] };
    }
    const parts = fullRepo.split("/");
    return { content: [{ type: "text", text: "GitHub Pages enabled!\\n\\nSite: https://" + parts[0] + ".github.io/" + parts[1] }] };
  });

`;

content = content.replace(
  '  // Keep drive_status for backward compatibility',
  githubTools + '  // Keep drive_status for backward compatibility'
);
console.log('  [10/11] Added GitHub tools');

// 11. Add GitHub OAuth callback handler
const githubCallback = `      // Handle GitHub OAuth
      if (provider === 'github') {
        const tokenResp = await fetch(GITHUB_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            client_id: (env as any).GITHUB_CLIENT_ID,
            client_secret: (env as any).GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: workerUrl + '/oauth/callback',
          }),
        });
        if (!tokenResp.ok) return new Response('GitHub token failed', { status: 500 });
        const tokens: any = await tokenResp.json();
        if (tokens.error) return new Response('GitHub error: ' + tokens.error_description, { status: 500 });
        await (env as any).DB.prepare(
          'INSERT INTO oauth_tokens (id, user_id, provider, access_token, refresh_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET access_token = ?'
        ).bind(crypto.randomUUID(), stateUserId, 'github', tokens.access_token, null, null, new Date().toISOString(), tokens.access_token).run();
        return new Response('<html><body style="font-family:system-ui;text-align:center;padding:50px"><h1>GitHub Connected!</h1><p>Close this window</p></body></html>', { headers: { 'Content-Type': 'text/html' } });
      }
      
      `;

content = content.replace(
  '      const tokenResp = await fetch(GOOGLE_TOKEN_URL, {',
  githubCallback + 'const tokenResp = await fetch(GOOGLE_TOKEN_URL, {'
);
console.log('  [11/11] Added GitHub OAuth callback');

// Write file
fs.writeFileSync(indexPath, content);
console.log('');
console.log('SUCCESS! GitHub integration added.');
console.log('');
console.log('Next steps:');
console.log('  1. npm run deploy');
console.log('  2. In Claude: connect_service github');
