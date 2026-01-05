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
