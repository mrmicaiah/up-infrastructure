# Blue River Gutters Content Engine

Cloudflare Worker that automates content creation from Jobber job completions.

## What It Does

1. Connects to Blue River Gutters' Jobber account via OAuth 2.0
2. Receives webhook notifications when jobs are completed
3. Downloads job photos and uploads to Cloudinary CDN
4. Creates Google Business Profile posts with project photos
5. (Future) Generates project pages on the website

## Pipeline Flow

```
Jobber Visit Complete
        ↓
   Webhook fires
        ↓
  Fetch job details + photos
        ↓
  Upload photos to Cloudinary
        ↓
  Create GBP post with photos
        ↓
  (Future) Create project page
```

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/auth/jobber` | GET | Start Jobber OAuth flow |
| `/auth/jobber/callback` | GET | Jobber OAuth callback |
| `/auth/google` | GET | Start Google OAuth flow |
| `/auth/google/callback` | GET | Google OAuth callback |
| `/auth/status` | GET | Check connection status (all services) |
| `/webhook/jobber` | POST | Receive Jobber webhooks |
| `/test/post` | POST | Test GBP post creation |

---

## Setup Guide

### Prerequisites

- Node.js 18+
- Cloudflare account with Workers enabled
- Jobber developer account
- Google Cloud Console project with Business Profile API enabled
- Cloudinary account

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

### 2. Jobber Setup

1. Go to [Jobber Developer Center](https://developer.getjobber.com/)
2. Create a new app (or use existing)
3. Set OAuth Callback URL to: `https://brg-content-engine.<your-subdomain>.workers.dev/auth/jobber/callback`
4. Note your Client ID and Client Secret

```bash
wrangler secret put JOBBER_CLIENT_ID
# Enter your client ID when prompted

wrangler secret put JOBBER_CLIENT_SECRET
# Enter your client secret when prompted
```

### 3. Google Business Profile Setup

**Important:** GBP API access requires Google approval. Apply at [Google Business Profile API](https://developers.google.com/my-business/content/basic-setup).

#### Create OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the following APIs:
   - Google My Business API
   - My Business Account Management API
   - My Business Business Information API
4. Go to **APIs & Services > Credentials**
5. Click **Create Credentials > OAuth 2.0 Client ID**
6. Application type: **Web application**
7. Add authorized redirect URI:
   ```
   https://brg-content-engine.<your-subdomain>.workers.dev/auth/google/callback
   ```
8. Note your Client ID and Client Secret

```bash
wrangler secret put GOOGLE_CLIENT_ID
# Enter your client ID when prompted

wrangler secret put GOOGLE_CLIENT_SECRET
# Enter your client secret when prompted
```

#### Get Your Location ID

After connecting, you can find your location ID:

```bash
# Get accounts
curl https://mybusinessaccountmanagement.googleapis.com/v1/accounts \
  -H "Authorization: Bearer <access_token>"

# Get locations for an account
curl https://mybusinessbusinessinformation.googleapis.com/v1/<accountId>/locations \
  -H "Authorization: Bearer <access_token>"
```

Add the location ID to `wrangler.toml`:
```toml
[vars]
BRG_LOCATION_ID = "accounts/123456789/locations/987654321"
```

### 4. Cloudinary Setup

1. Go to [Cloudinary Console](https://console.cloudinary.com/)
2. Find your API Key and API Secret in Settings > Access Keys

```bash
wrangler secret put CLOUDINARY_API_KEY
# Enter your API key when prompted

wrangler secret put CLOUDINARY_API_SECRET
# Enter your API secret when prompted
```

Your Cloudinary cloud name is: `dxzw1zwez`

### 5. Deploy

```bash
npm install
npm run deploy
```

### 6. Connect Accounts

1. **Jobber:** Visit `/auth/jobber` and authorize
2. **Google:** Visit `/auth/google` and authorize

### 7. Configure Jobber Webhooks

In Jobber Developer Center, add a webhook:
- URL: `https://brg-content-engine.<your-subdomain>.workers.dev/webhook/jobber`
- Events: `visit_completed`

---

## Local Development

```bash
# Install dependencies
npm install

# Create a .dev.vars file for local secrets
cat > .dev.vars << EOF
JOBBER_CLIENT_ID=your_jobber_client_id
JOBBER_CLIENT_SECRET=your_jobber_client_secret
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
CLOUDINARY_API_KEY=your_cloudinary_key
CLOUDINARY_API_SECRET=your_cloudinary_secret
EOF

# Start local dev server
npm run dev

# Worker runs at http://localhost:8787
```

Note: OAuth callbacks won't work locally unless you use a tunnel (ngrok, cloudflared, etc.)

---

## Testing

### Test OAuth Status
```bash
curl https://brg-content-engine.<subdomain>.workers.dev/auth/status
```

Expected response:
```json
{
  "jobber": {
    "connected": true,
    "expires_at": "2026-02-03T20:00:00.000Z"
  },
  "google": {
    "connected": true,
    "expires_at": "2026-02-03T20:00:00.000Z"
  }
}
```

### Test Webhook (Manual)
```bash
curl -X POST https://brg-content-engine.<subdomain>.workers.dev/webhook/jobber \
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

### Test GBP Post Creation
```bash
curl -X POST https://brg-content-engine.<subdomain>.workers.dev/test/post \
  -H "Content-Type: application/json" \
  -d '{
    "summary": "Test post from content engine",
    "type": "STANDARD"
  }'
```

---

## Token Management

The worker automatically handles token refresh for both Jobber and Google:

- Access tokens are stored in Cloudflare KV
- When a token is within 5 minutes of expiring, it's automatically refreshed
- Refresh tokens are used to get new access tokens
- If refresh fails, user needs to re-authorize

---

## Environment Variables & Secrets

| Name | Type | Description |
|------|------|-------------|
| `ENVIRONMENT` | Variable | "development" or "production" |
| `BRG_LOCATION_ID` | Variable | Google Business Profile location ID |
| `JOBBER_CLIENT_ID` | Secret | Jobber app client ID |
| `JOBBER_CLIENT_SECRET` | Secret | Jobber app client secret |
| `GOOGLE_CLIENT_ID` | Secret | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Secret | Google OAuth client secret |
| `CLOUDINARY_API_KEY` | Secret | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Secret | Cloudinary API secret |

## KV Namespaces

| Binding | Purpose |
|---------|---------|
| `TOKENS` | Stores OAuth tokens and state |

### KV Keys

| Key | Contents |
|-----|----------|
| `jobber:tokens` | Jobber access/refresh tokens |
| `google:tokens` | Google access/refresh tokens |
| `jobber_oauth_state:{state}` | Temporary state for CSRF (TTL: 10min) |
| `google_oauth_state:{state}` | Temporary state for CSRF (TTL: 10min) |

---

## Project Structure

```
brg-content-engine/
├── src/
│   ├── index.js           # Main worker, routing, webhooks
│   ├── jobber-api.js      # Jobber OAuth + API client
│   ├── google-gbp.js      # Google Business Profile OAuth + API
│   └── photo-pipeline.js  # Jobber photos → Cloudinary upload
├── wrangler.toml          # Cloudflare config
├── package.json
├── .dev.vars              # Local secrets (don't commit!)
├── .gitignore
└── README.md
```

---

## API Reference

### Google Business Profile

**Post Types:**
- `STANDARD` - General update (What's New)
- `EVENT` - Event post
- `OFFER` - Special offer

**Call-to-Action Types:**
- `BOOK` - Book an appointment
- `ORDER` - Order online
- `SHOP` - Shop products
- `LEARN_MORE` - Learn more
- `SIGN_UP` - Sign up
- `CALL` - Call the business

**Example Post Request:**
```javascript
{
  summary: "Another gutter project completed in Madison! ...",
  type: "STANDARD",
  media: [{ type: "PHOTO", url: "https://res.cloudinary.com/..." }],
  callToAction: { type: "CALL", url: "tel:+12566167760" }
}
```

---

## Monitoring

View logs in real-time:
```bash
wrangler tail
```

Or check the Cloudflare dashboard for analytics and error tracking.

---

## Troubleshooting

### Google OAuth Fails
- Verify redirect URI matches exactly (including trailing slash)
- Check that Business Profile APIs are enabled
- Ensure your Google account has owner/manager access to the GBP

### Jobber Webhook Not Firing
- Verify webhook URL is correct
- Check that `visit_completed` event is selected
- Test with Jobber's webhook tester

### Photos Not Uploading
- Verify Cloudinary credentials
- Check that photos exist on the job in Jobber
- Ensure Jobber API token has read access to media

---

## Future Enhancements

- [ ] Webhook signature verification (HMAC)
- [ ] Auto-generate project page on website
- [ ] Review request emails via Courier
- [ ] Track content performance metrics
- [ ] Multi-tenant support

---

Part of the Blue River Gutters content automation system.
