import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";

// Environment type
export interface Env {
  DB: any;
  USER_ID?: string;
  TEAM?: string;
  WORKER_NAME?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  COURIER_API_KEY?: string;  // Email marketing platform API key
  UP_BLOGS_ADMIN_KEY?: string;  // Admin API key for up-blogs-1 worker (blog registration)
}

// Tool context passed to each tool registration function
export interface ToolContext {
  server: McpServer;
  agent: McpAgent;
  env: Env;
  getCurrentUser: () => string;
  getTeammates: () => string[];
  getTeammate: () => string;
}

// Launch document parser types
export interface ParsedItem {
  phase: string;
  section: string;
  item_text: string;
  sort_order: number;
  tags: string[];
  due_offset: number | null;
  is_recurring: string | null;
}

export interface ParsedLaunchDoc {
  phases: string[];
  items: ParsedItem[];
}
