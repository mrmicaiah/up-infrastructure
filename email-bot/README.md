# Email Bot Server

Cloudflare Worker for capturing email leads across Untitled Publishers properties.

## Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|--------|
| `/api/lead` | POST | Public | Capture leads |
| `/api/leads` | GET | Bearer | List leads |
| `/api/leads/export` | GET | Bearer | CSV export |
| `/api/stats` | GET | Bearer | Dashboard stats |
| `/health` | GET | Public | Health check |

## Deploy

```bash
cd email-bot
npm run deploy
```

## Secrets

```bash
wrangler secret put ADMIN_API_KEY
wrangler secret put BEEHIIV_API_KEY
wrangler secret put BEEHIIV_PUBLICATION_ID
```

## Database

- **Name:** email-bot-db
- **ID:** 1f723e35-3d79-4f80-92a0-b73b9569a310