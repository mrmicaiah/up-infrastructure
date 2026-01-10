# Client Blogs Worker (Multi-tenant)

Powers blog admin dashboards for client websites.

## Setup

1. Create KV namespace:
```bash
wrangler kv:namespace create BLOGS
```

2. Update wrangler.toml with the KV ID

3. Set secrets:
```bash
wrangler secret put JWT_SECRET
```

4. Deploy:
```bash
pm run deploy
```

## Adding a New Blog

```bash
# Set initial password (will be hashed by the worker on first login)
wrangler kv:key put --namespace-id=YOUR_KV_ID "blog:my-blog-id:password" "HASHED_PASSWORD"

# Set config
wrangler kv:key put --namespace-id=YOUR_KV_ID "blog:my-blog-id:config" '{"githubRepo":"owner/repo","githubToken":"ghp_xxx","siteUrl":"https://example.com"}'
```

## API Endpoints

| Endpoint | Auth | Purpose |
|----------|------|--------|
| `POST /:blogId/auth` | Public | Password login, returns JWT |
| `POST /:blogId/change-password` | JWT | Update password |
| `GET /:blogId/posts` | JWT | List all posts |
| `POST /:blogId/posts` | JWT | Create/update post |
| `DELETE /:blogId/posts/:id` | JWT | Delete post |
| `POST /:blogId/subscribe` | Public | Add email subscriber |

## Current Blogs

| Blog ID | Client | GitHub Repo |
|---------|--------|-------------|
| `built-by-denny` | Denny Liuzzo | mrmicaiah/built-by-denny |
