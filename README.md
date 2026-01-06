# UP Infrastructure

Backend infrastructure for Untitled Publishers. This repo is for **backend code only**.

## ⚠️ IMPORTANT: Dashboard Locations

**Dashboards are NOT hosted here.** They live in the **UntitledPublishers** repo:

| Dashboard | Production URL | Repo Location |
|-----------|---------------|---------------|
| Helm (Productivity) | `untitledpublishers.com/dashboard/` | `UntitledPublishers/dashboard/index.html` |
| Courier (Email) | `untitledpublishers.com/emailbot/` | `UntitledPublishers/emailbot/index.html` |

**Do NOT put dashboard HTML files in this repo.** The `email-bot/dashboard.html` and `productivity-dashboard/` folder are deprecated test files.

## What belongs here

- `email-bot/` - Email platform Cloudflare Worker (index.js, schema.sql)
- `productivity-mcp/` - Reference/backup for productivity MCP server

## Deployment

The main website (untitledpublishers.com) is served from the **UntitledPublishers** GitHub repo via GitHub Pages.
