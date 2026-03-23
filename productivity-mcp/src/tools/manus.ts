// Manus AI Integration Tools
// Allows Claude to delegate complex, long-running tasks to Manus AI agent

import type { ToolContext } from '../types';

const MANUS_API_BASE = "https://api.manus.ai/v1";

// Helper to make Manus API requests
async function manusRequest(
  endpoint: string,
  method: "GET" | "POST" | "DELETE",
  apiKey: string,
  body?: object
): Promise<any> {
  const response = await fetch(`${MANUS_API_BASE}${endpoint}`, {
    method,
    headers: {
      "API_KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Manus API error (${response.status}): ${error}`);
  }

  return response.json();
}

export function registerManusTools(ctx: ToolContext) {
  const { server, env } = ctx;

  // Create a new Manus task
  server.tool(
    "manus_create_task",
    "Delegate a complex task to Manus AI agent. Use for tasks that require web browsing, code execution, file creation, or multi-step workflows. Manus runs autonomously and can deploy web apps, research topics, analyze documents, and more.",
    {
      prompt: {
        type: "string",
        description: "The task instruction for Manus. Be specific about what you want accomplished.",
      },
      agent_profile: {
        type: "string",
        description: "Manus model to use: 'manus-1.6' (default, best quality), 'manus-1.6-lite' (faster, cheaper), 'manus-1.6-max' (most capable), or 'speed' (fastest)",
        enum: ["manus-1.6", "manus-1.6-lite", "manus-1.6-max", "speed"],
      },
      task_mode: {
        type: "string",
        description: "Task mode: 'agent' (autonomous, default), 'chat' (conversational), 'adaptive' (auto-selects)",
        enum: ["agent", "chat", "adaptive"],
      },
      create_shareable_link: {
        type: "boolean",
        description: "Whether to create a public shareable link for the task",
      },
      connectors: {
        type: "array",
        items: { type: "string" },
        description: "Optional connector IDs to enable (e.g., Gmail, Notion). User must have these configured in Manus.",
      },
    },
    async ({ prompt, agent_profile, task_mode, create_shareable_link, connectors }) => {
      if (!env.MANUS_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "❌ Manus API key not configured. Add MANUS_API_KEY as a secret to the worker:\n\n```\nnpx wrangler secret put MANUS_API_KEY\n```\n\nGet your API key from: Manus Dashboard → Settings → Integration → Build with Manus API",
            },
          ],
        };
      }

      try {
        const payload: any = {
          prompt,
          agentProfile: agent_profile || "manus-1.6",
        };

        if (task_mode) payload.taskMode = task_mode;
        if (create_shareable_link !== undefined) payload.createShareableLink = create_shareable_link;
        if (connectors && connectors.length > 0) payload.connectors = connectors;

        const result = await manusRequest("/tasks", "POST", env.MANUS_API_KEY, payload);

        return {
          content: [
            {
              type: "text",
              text: `✅ **Manus task created!**\n\n**Task ID:** \`${result.task_id}\`\n**Title:** ${result.task_title || "Processing..."}\n**Task URL:** ${result.task_url}\n${result.share_url ? `**Share URL:** ${result.share_url}` : ""}\n\nManus is now working on this task autonomously. Use \`manus_get_task\` with the task ID to check progress and get results.`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to create Manus task: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Get task status and results
  server.tool(
    "manus_get_task",
    "Get the status and results of a Manus task. Use to check if a task is complete and retrieve outputs.",
    {
      task_id: {
        type: "string",
        description: "The Manus task ID to retrieve",
      },
    },
    async ({ task_id }) => {
      if (!env.MANUS_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "❌ Manus API key not configured.",
            },
          ],
        };
      }

      try {
        const result = await manusRequest(`/tasks/${task_id}`, "GET", env.MANUS_API_KEY);

        const statusEmoji: Record<string, string> = {
          pending: "⏳",
          running: "🔄",
          completed: "✅",
          failed: "❌",
        };

        let response = `${statusEmoji[result.status] || "❓"} **Task Status: ${result.status}**\n\n**Task ID:** \`${result.task_id}\`\n**Title:** ${result.task_title || "Untitled"}\n**Created:** ${result.created_at || "Unknown"}\n**Task URL:** ${result.task_url || "N/A"}`;

        if (result.status === "completed" && result.output) {
          response += `\n\n**Results:**\n`;
          if (Array.isArray(result.output)) {
            for (const msg of result.output) {
              if (msg.role === "assistant" && msg.content) {
                const text = Array.isArray(msg.content)
                  ? msg.content.map((c: any) => c.text || "").join("\n")
                  : msg.content;
                response += `\n${text}`;
              }
            }
          } else {
            response += JSON.stringify(result.output, null, 2);
          }
        }

        if (result.status === "failed" && result.error) {
          response += `\n\n**Error:** ${result.error}`;
        }

        return {
          content: [
            {
              type: "text",
              text: response,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to get Manus task: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // List recent tasks
  server.tool(
    "manus_list_tasks",
    "List recent Manus tasks with their status.",
    {
      limit: {
        type: "number",
        description: "Maximum number of tasks to return (default: 10, max: 100)",
      },
      status: {
        type: "string",
        description: "Filter by status",
        enum: ["pending", "running", "completed", "failed"],
      },
    },
    async ({ limit, status }) => {
      if (!env.MANUS_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "❌ Manus API key not configured.",
            },
          ],
        };
      }

      try {
        let endpoint = `/tasks?limit=${limit || 10}`;
        if (status) endpoint += `&status=${status}`;

        const result = await manusRequest(endpoint, "GET", env.MANUS_API_KEY);

        if (!result.results || result.results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No Manus tasks found.",
              },
            ],
          };
        }

        const statusEmoji: Record<string, string> = {
          pending: "⏳",
          running: "🔄",
          completed: "✅",
          failed: "❌",
        };

        const taskList = result.results
          .map((task: any) => {
            const emoji = statusEmoji[task.status] || "❓";
            return `${emoji} **${task.task_title || "Untitled"}**\n   ID: \`${task.task_id}\` | Status: ${task.status}\n   URL: ${task.task_url || "N/A"}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `**Recent Manus Tasks:**\n\n${taskList}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to list Manus tasks: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Delete a task
  server.tool(
    "manus_delete_task",
    "Delete a Manus task.",
    {
      task_id: {
        type: "string",
        description: "The Manus task ID to delete",
      },
    },
    async ({ task_id }) => {
      if (!env.MANUS_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "❌ Manus API key not configured.",
            },
          ],
        };
      }

      try {
        await manusRequest(`/tasks/${task_id}`, "DELETE", env.MANUS_API_KEY);

        return {
          content: [
            {
              type: "text",
              text: `✅ Task \`${task_id}\` deleted successfully.`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to delete Manus task: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // Update a task (send a message/continue)
  server.tool(
    "manus_update_task",
    "Send a follow-up message to an existing Manus task. Use to continue a conversation or provide additional instructions.",
    {
      task_id: {
        type: "string",
        description: "The Manus task ID to update",
      },
      message: {
        type: "string",
        description: "The follow-up message or instruction to send",
      },
    },
    async ({ task_id, message }) => {
      if (!env.MANUS_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "❌ Manus API key not configured.",
            },
          ],
        };
      }

      try {
        const result = await manusRequest(
          `/tasks/${task_id}`,
          "POST",
          env.MANUS_API_KEY,
          { message }
        );

        return {
          content: [
            {
              type: "text",
              text: `✅ Message sent to task \`${task_id}\`.\n\nManus is processing your follow-up. Use \`manus_get_task\` to check for the response.`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to update Manus task: ${error.message}`,
            },
          ],
        };
      }
    }
  );
}
