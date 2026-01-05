# UP Infrastructure

Backend services for Untitled Publishers.

## Projects

| Folder | Description | Worker URL |
|--------|-------------|------------|
| `email-bot/` | Lead capture API | `email-bot-server.micaiah-tasks.workers.dev` |
| `productivity-mcp/` | Productivity MCP server | `productivity-mcp-server.micaiah-tasks.workers.dev` |

## Deploy

Each project deploys independently:

```bash
# Email Bot
cd email-bot
npm run deploy

# Productivity MCP
cd productivity-mcp
npm run deploy
npx wrangler deploy --config wrangler-irene.jsonc
```

<!-- test deploy -->
