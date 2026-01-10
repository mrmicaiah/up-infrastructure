# UP Blogs Worker (Multi-tenant)

Powers Untitled Publishers blogs via API. No admin UI - Claude posts via API key.

## Setup

1. Create KV namespace:
```bash
wrangler kv:namespace create BLOGS
```

2. Update wrangler.toml with the KV ID

3. Deploy:
```bash
npm run deploy
```

## Adding a New Blog

```bash
# Generate and set API key
wrangler kv:key put --namespace-id=YOUR_KV_ID "blog:my-blog-id:apiKey" "your-api-key-here"

# Set config
wrangler kv:key put --namespace-id=YOUR_KV_ID "blog:my-blog-id:config" '{"githubRepo":"owner/repo","githubToken":"ghp_xxx","siteUrl":"https://example.com"}'
```

## API Endpoints

### Authenticated (API Key)

| Endpoint | Method | Purpose |
|----------|--------|--------|
| `/:blogId/posts` | POST | Create/update post |
| `/:blogId/posts` | GET | List all posts |
| `/:blogId/posts/:id` | DELETE | Delete post |
| `/:blogId/comments/pending` | GET | Get pending comments |
| `/:blogId/comments/:id/approve` | POST | Approve comment |
| `/:blogId/comments/:id/reject` | POST | Reject comment |

### Public

| Endpoint | Method | Purpose |
|----------|--------|--------|
| `/:blogId/subscribe` | POST | Add email subscriber |
| `/:blogId/comments` | POST | Submit comment |
| `/:blogId/comments/:postId` | GET | Get approved comments |

## Current Blogs

| Blog ID | Site | GitHub Repo |
|---------|------|-------------|
| `micaiah-bussey` | MicaiahBussey.com | mrmicaiah/Micaiah-Bussey |
