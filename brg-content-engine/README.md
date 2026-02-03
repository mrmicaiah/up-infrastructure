# Blue River Gutters Content Engine

Cloudflare Worker that automates content creation from Jobber job completions.

## What It Does

1. Connects to Blue River Gutters' Jobber account via OAuth 2.0
2. Receives webhook notifications when jobs are completed
3. (Future) Triggers content generation workflows

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/auth/jobber` | GET | Start OAuth flow |
| `/auth/jobber/callback` | GET | OAuth callback (Jobber redirects here) |
| `/auth/status` | GET | Check connection status |
| `/webhook/jobber` | POST | Receive Jobber webhooks |

## Setup

### 1. Create KV Namespace

```bash
# Create the KV namespace for storing tokens
wrangler kv:namespace create "TOKENS"

# You'll get output like:
# [[kv_namespaces]]
# binding = "TOKENS"
# id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Add this to wrangler.toml (uncomment the kv_namespaces section and add your ID)
```

### 2. Add Jobber Credentials

```bash
# Add your Jobber app credentials as secrets
wrangler secret put JOBBER_CLIENT_ID
# Enter your client ID when prompted

wrangler secret put JOBBER_CLIENT_SECRET
# Enter your client secret when prompted
```

### 3. Deploy

```bash
npm install
npm run deploy
```

### 4. Configure Jobber

1. Go to [Jobber Developer Center](https://developer.getjobber.com/)
2. Find your app settings
3. Set the **OAuth Callback URL** to:
   ```
   https://brg-content-engine.<your-subdomain>.workers.dev/auth/jobber/callback
   ```

### 5. Connect Account

1. Visit `https://brg-content-engine.<your-subdomain>.workers.dev/auth/jobber`
2. Log in to Jobber and authorize the app
3. You'll be redirected back with a success message

### 6. Verify Connection

```bash
curl https://brg-content-engine.<your-subdomain>.workers.dev/auth/status
```

Should return:
```json
{
  "connected": true,
  "token_type": "Bearer",
  "expires_at": "2026-02-03T15:30:00.000Z",
  "is_expired": false,
  "has_refresh_token": true
}
```

## Local Development

```bash
# Install dependencies
npm install

# Create a .dev.vars file for local secrets
echo "JOBBER_CLIENT_ID=your_client_id" >> .dev.vars
echo "JOBBER_CLIENT_SECRET=your_client_secret" >> .dev.vars

# Start local dev server
npm run dev

# Worker runs at http://localhost:8787
```

Note: OAuth callback won't work locally unless you use a tunnel (ngrok, cloudflared, etc.)

## Testing

### Test OAuth Status
```bash
curl http://localhost:8787/auth/status
```

### Test Webhook
```bash
curl -X POST http://localhost:8787/webhook/jobber \
  -H "Content-Type: application/json" \
  -d '{
    "event": "visit_completed",
    "data": {
      "job_id": "12345",
      "customer": "John Smith",
      "address": "123 Main St, Huntsville, AL",
      "service": "Gutter Cleaning",
      "completed_at": "2026-02-03T14:30:00Z"
    }
  }'
```

## Token Management

The worker automatically handles token refresh:

- Access tokens are stored in Cloudflare KV
- When a token is within 5 minutes of expiring, it's automatically refreshed
- Refresh tokens are used to get new access tokens
- If refresh fails, user needs to re-authorize via `/auth/jobber`

## Future Enhancements

- [ ] Add webhook signature verification (HMAC)
- [ ] Integrate with Claude API for content generation
- [ ] Send review request emails via Courier
- [ ] Generate case study drafts from job photos
- [ ] Track content performance metrics
- [ ] Multi-tenant support (multiple Jobber accounts)

## Project Structure

```
brg-content-engine/
├── src/
│   └── index.js       # Main worker code with OAuth + webhooks
├── wrangler.toml      # Cloudflare config
├── package.json
├── .dev.vars          # Local secrets (don't commit!)
├── .gitignore
└── README.md
```

## Environment Variables & Secrets

| Name | Type | Description |
|------|------|-------------|
| `ENVIRONMENT` | Variable | "development" or "production" |
| `JOBBER_CLIENT_ID` | Secret | Jobber app client ID |
| `JOBBER_CLIENT_SECRET` | Secret | Jobber app client secret |

## KV Namespaces

| Binding | Purpose |
|---------|---------|
| `TOKENS` | Stores OAuth tokens and state |

### KV Keys

| Key | Contents |
|-----|----------|
| `jobber:tokens` | Access token, refresh token, expiry info |
| `oauth_state:{state}` | Temporary state for CSRF protection (TTL: 10min) |

## Monitoring

View logs in real-time:
```bash
wrangler tail
```

Or check the Cloudflare dashboard for analytics and error tracking.

---

Part of the Blue River Gutters content automation system.
