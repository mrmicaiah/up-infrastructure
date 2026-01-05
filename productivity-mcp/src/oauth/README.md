# /src/oauth - OAuth & Token Management

> OAuth helpers and token management for external services.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | OAuth helpers, token storage/retrieval, refresh logic |

---

## Supported Services

| Service Key | Provider | Scopes | Callback Path |
|-------------|----------|--------|---------------|
| `google_drive` | Google | drive | `/oauth/callback` |
| `gmail_personal` | Google | gmail.modify | `/oauth/callback` |
| `gmail_company` | Google | gmail.modify | `/oauth/callback` |
| `blogger` | Google | blogger | `/oauth/callback` |
| `google_contacts_personal` | Google | contacts.readonly | `/oauth/callback` |
| `google_contacts_company` | Google | contacts.readonly | `/oauth/callback` |
| `github` | GitHub | repo, user | `/oauth/github/callback` |

---

## OAuth Flow

### Google Services (Shared OAuth App)
All Google services use a single OAuth application with multiple scopes.

```
1. User calls connect_service(service: 'google_drive')
2. → Redirect to Google OAuth with requested scopes
3. → User approves
4. → Google redirects to /oauth/callback?code=XXX&state=SERVICE
5. → Exchange code for tokens
6. → Store in oauth_tokens table (user_id + service = unique)
7. → Redirect to success page
```

**Callback URLs:**
- Micaiah: `https://productivity-mcp-server.micaiah-tasks.workers.dev/oauth/callback`
- Irene: `https://productivity-irene.micaiah-tasks.workers.dev/oauth/callback`

### GitHub (Separate OAuth Apps)
GitHub only allows ONE callback URL per OAuth app, so each deployment needs its own app.

```
1. User calls connect_service(service: 'github')
2. → Redirect to GitHub OAuth
3. → User approves
4. → GitHub redirects to /oauth/github/callback?code=XXX
5. → Exchange code for token
6. → Store in oauth_tokens table
7. → Redirect to success page
```

**Callback URLs:**
- Micaiah: `https://productivity-mcp-server.micaiah-tasks.workers.dev/oauth/github/callback`
- Irene: `https://productivity-irene.micaiah-tasks.workers.dev/oauth/github/callback`

---

## Key Functions

### Token Retrieval
```typescript
// Get token for a service (auto-refreshes if expired)
const token = await getGoogleToken(env, userId, 'google_drive');
if (!token) {
  return { content: [{ type: "text", text: "❌ Google Drive not connected" }] };
}
```

### Token Storage
```typescript
// Stored in oauth_tokens table with composite key (user_id, service)
await storeToken(env, userId, service, accessToken, refreshToken, expiresAt);
```

### Token Refresh (Google)
```typescript
// Automatically called by getGoogleToken when token is expired
const newToken = await refreshGoogleToken(env, userId, service, refreshToken);
```

---

## Environment Secrets

Each worker deployment needs these secrets:

### Google (shared across services)
```powershell
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

# For Irene
npx wrangler secret put GOOGLE_CLIENT_ID --config wrangler-irene.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler-irene.jsonc
```

### GitHub (separate apps per deployment)
```powershell
# Micaiah's GitHub app
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET

# Irene's GitHub app (different credentials!)
npx wrangler secret put GITHUB_CLIENT_ID --config wrangler-irene.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler-irene.jsonc
```

---

## Troubleshooting

### "Service not connected" errors
1. Check `oauth_tokens` table for the user/service combo
2. Token might be expired - check `expires_at`
3. Refresh token might be missing or invalid

### OAuth callback fails
1. Verify callback URL matches exactly in provider console
2. Check worker secrets are set correctly
3. For GitHub: verify you're using the right OAuth app for that deployment

### Token refresh fails (Google)
1. User may have revoked access - need to re-authorize
2. Refresh token may have expired (rare, usually 6 months inactive)

---

## Adding a New OAuth Service

1. Add service key to the enum in `connections.ts`
2. Add OAuth URL builder in `oauth/index.ts`
3. Add callback handler in `src/index.ts` (routing)
4. Add token exchange logic in `oauth/index.ts`
5. Update this README

---

## Database Table

```sql
CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  service TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, service)
);
```

See `SCHEMA.md` for full schema documentation.
