# Content Engine Deployment Checklist

## Pre-Deployment

### 1. Deploy Worker
```bash
cd brg-content-engine
npm install
wrangler deploy
```

Note the worker URL: `https://brg-content-engine.<subdomain>.workers.dev`

### 2. Create KV Namespace
```bash
wrangler kv:namespace create "TOKENS"
```
Add the returned ID to `wrangler.toml` and redeploy.

### 3. Add Secrets
```bash
# Jobber
wrangler secret put JOBBER_CLIENT_ID
wrangler secret put JOBBER_CLIENT_SECRET

# Cloudinary
wrangler secret put CLOUDINARY_API_KEY
wrangler secret put CLOUDINARY_API_SECRET

# Google (after GBP API access is approved)
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET

# GitHub
wrangler secret put GITHUB_TOKEN
```

---

## Jobber Developer Portal Setup

### 1. Update OAuth Callback URL
Go to: https://developer.getjobber.com/

Set callback URL to:
```
https://brg-content-engine.<subdomain>.workers.dev/auth/jobber/callback
```

### 2. Add Webhook
In the Jobber Developer Portal:
- URL: `https://brg-content-engine.<subdomain>.workers.dev/webhook/jobber`
- Events: `visit_completed`

---

## Google Cloud Console Setup

### 1. Create/Select Project
Go to: https://console.cloud.google.com/

### 2. Enable APIs
- Google My Business API
- My Business Account Management API  
- My Business Business Information API

### 3. Create OAuth Credentials
- Type: Web application
- Authorized redirect URI:
  ```
  https://brg-content-engine.<subdomain>.workers.dev/auth/google/callback
  ```

### 4. Apply for GBP API Access
Go to: https://developers.google.com/my-business/content/basic-setup

This requires Google review and approval.

---

## Connect Adam's Accounts

### 1. Send Adam the Setup Guide
Share `docs/SETUP-GUIDE-ADAM.md` or the authorization links:

- Jobber: `https://brg-content-engine.<subdomain>.workers.dev/auth/jobber`
- Google: `https://brg-content-engine.<subdomain>.workers.dev/auth/google`

### 2. Verify Connections
```bash
curl https://brg-content-engine.<subdomain>.workers.dev/auth/status
```

Expected:
```json
{
  "jobber": { "connected": true },
  "google": { "connected": true }
}
```

### 3. Get GBP Location ID
After Google is connected:
```bash
curl https://brg-content-engine.<subdomain>.workers.dev/api/gbp/accounts
```

Find the location ID and add to `wrangler.toml`:
```toml
[vars]
BRG_LOCATION_ID = "accounts/123456789/locations/987654321"
```

Redeploy after updating.

---

## Testing

### Test Webhook (Manual)
```bash
curl -X POST https://brg-content-engine.<subdomain>.workers.dev/webhook/jobber \
  -H "Content-Type: application/json" \
  -d '{
    "event": "visit_completed",
    "data": {
      "id": "test-123",
      "title": "Seamless Gutters",
      "property": {
        "address": { "city": "Madison" }
      }
    }
  }'
```

### Real Test
Have Adam complete a real job with photos in Jobber and verify:
1. GBP post appears
2. Project page added to website
3. Photos uploaded to Cloudinary

---

## Monitoring

### View Logs
```bash
wrangler tail
```

### Check Status
```bash
curl https://brg-content-engine.<subdomain>.workers.dev/health
```

---

## Post-Deployment

- [ ] Worker deployed
- [ ] KV namespace created
- [ ] All secrets added
- [ ] Jobber callback URL updated
- [ ] Jobber webhook configured
- [ ] Google APIs enabled
- [ ] Google OAuth credentials created
- [ ] GBP API access approved (may take days)
- [ ] Adam authorized Jobber
- [ ] Adam authorized Google
- [ ] GBP location ID configured
- [ ] Test job completed successfully