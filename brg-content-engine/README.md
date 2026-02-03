# Blue River Gutters Content Engine

Cloudflare Worker that automates content creation from Jobber job completions.

## What It Does

When a job visit is marked complete in Jobber, this worker:
1. Receives the webhook notification
2. Logs the event for processing
3. (Future) Triggers content generation workflows

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/webhook/jobber` | POST | Receive Jobber webhooks |

## Local Development

```bash
# Install dependencies
npm install

# Start local dev server
npm run dev

# Worker runs at http://localhost:8787
```

## Testing the Webhook

```bash
# Send a test webhook
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

## Deployment

```bash
# Deploy to Cloudflare Workers
npm run deploy

# Deploy to production environment
npm run deploy:production

# View live logs
npm run tail
```

## Jobber Webhook Setup

1. Deploy this worker to get your URL (e.g., `brg-content-engine.your-subdomain.workers.dev`)
2. In Jobber, go to Settings → Integrations → Webhooks
3. Add a new webhook:
   - URL: `https://brg-content-engine.your-subdomain.workers.dev/webhook/jobber`
   - Event: `visit_completed` (or whatever triggers you need)
4. Test with a sample job completion

## Future Enhancements

- [ ] Add webhook signature verification (once Jobber provides signing)
- [ ] Store job data in Cloudflare KV or D1
- [ ] Integrate with Claude API for content generation
- [ ] Send review request emails via Courier
- [ ] Generate case study drafts from job photos
- [ ] Track content performance metrics

## Project Structure

```
brg-content-engine/
├── src/
│   └── index.js       # Main worker code
├── wrangler.toml      # Cloudflare config
├── package.json
└── README.md
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ENVIRONMENT` | "development" or "production" |

Add secrets via Wrangler:
```bash
wrangler secret put JOBBER_WEBHOOK_SECRET
```

## Monitoring

View logs in real-time:
```bash
wrangler tail
```

Or check the Cloudflare dashboard for analytics and error tracking.

---

Part of the Blue River Gutters content automation system.
