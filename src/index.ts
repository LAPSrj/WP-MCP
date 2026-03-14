#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { discoverTools } from "./discovery.js";
import { WpClient } from "./wp-client.js";
import { buildUrl } from "./tools.js";
import { ToolDefinition } from "./types.js";

async function main() {
  const config = loadConfig();

  if (config.wpIgnoreSsl) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const client = new WpClient(config);

  console.error(`Discovering WP REST API routes from ${config.wpUrl}...`);
  let tools: ToolDefinition[];
  try {
    tools = await discoverTools(config, client);
  } catch (error) {
    console.error(
      `Failed to discover routes: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }
  console.error(`Discovered ${tools.length} tools (mode: ${config.toolMode}, descriptions: ${config.descriptionMode})`);

  let toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "wp-mcp", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } }
  );

  async function refreshTools(): Promise<number> {
    const newTools = await discoverTools(config, client);
    tools = newTools;
    toolMap = new Map(newTools.map((t) => [t.name, t]));
    console.error(`Refreshed: ${newTools.length} tools`);
    await server.sendToolListChanged();
    return newTools.length;
  }

  const refreshToolDef = {
    name: "refresh_tools",
    description:
      "Re-discover all WordPress REST API routes and update the tool list. Use this after registering new post types, installing plugins, or any change that adds/removes REST API endpoints.",
    inputSchema: { type: "object" as const, properties: {} },
  };

  // Compact mode: single wp_api tool that takes method, path, params
  const compactToolDef = {
    name: "wp_api",
    description:
      "Universal WordPress REST API tool. Accepts any REST API path and parameters. Use refresh_tools to discover available routes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method",
        },
        path: {
          type: "string",
          description:
            "REST API path, e.g. /wp/v2/posts or /wp/v2/posts/123",
        },
        params: {
          type: "object",
          description:
            "Query parameters (GET) or body parameters (POST/PUT/PATCH/DELETE). Include _fields to limit response fields (e.g. {\"_fields\": \"id,title,slug\"})",
        },
        file_path: {
          type: "string",
          description:
            "Absolute path to a local file to upload (for media endpoints with POST)",
        },
      },
      required: ["method", "path"],
    },
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (config.toolMode === "compact") {
      return {
        tools: [refreshToolDef, compactToolDef],
      };
    }

    return {
      tools: [
        refreshToolDef,
        ...tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "refresh_tools") {
      try {
        const count = await refreshTools();
        return {
          content: [
            {
              type: "text" as const,
              text: `Refreshed tool list. Discovered ${count} tools.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to refresh tools: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Handle compact mode wp_api tool
    if (name === "wp_api") {
      return handleCompactCall(client, config.wpUrl, args as Record<string, unknown> || {});
    }

    const tool = toolMap.get(name);

    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const providedArgs = (args || {}) as Record<string, unknown>;
    const method = String(providedArgs.method || "GET").toUpperCase();

    if (!tool.methods.includes(method)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Method ${method} not supported for ${name}. Available: ${tool.methods.join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    try {
      // Separate path params from other args
      const pathParamValues: Record<string, string> = {};
      const otherArgs: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(providedArgs)) {
        if (key === "method") continue;
        if (tool.pathParams.includes(key)) {
          pathParamValues[key] = String(value);
        } else {
          otherArgs[key] = value;
        }
      }

      const url = buildUrl(config.wpUrl, tool.route, pathParamValues);

      // Handle file uploads for media endpoint
      const filePath = otherArgs.file_path as string | undefined;
      if (filePath && tool.route.includes("/media") && method === "POST") {
        delete otherArgs.file_path;
        const hasMetaArgs = Object.keys(otherArgs).length > 0;
        const result = await client.uploadFile(
          url,
          filePath,
          hasMetaArgs ? otherArgs : undefined
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result) },
          ],
        };
      }

      const hasOtherArgs = Object.keys(otherArgs).length > 0;
      const result = await client.request(
        method,
        url,
        method === "GET" ? undefined : hasOtherArgs ? otherArgs : undefined,
        method === "GET" ? (hasOtherArgs ? otherArgs : undefined) : undefined
      );

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("wp-mcp server running");
}

async function handleCompactCall(
  client: WpClient,
  wpUrl: string,
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const method = String(args.method || "GET").toUpperCase();
  const path = args.path as string | undefined;

  if (!path) {
    return {
      content: [{ type: "text" as const, text: "Missing required parameter: path" }],
      isError: true,
    };
  }

  const url = `${wpUrl}/wp-json${path.startsWith("/") ? path : `/${path}`}`;
  const params = (args.params || {}) as Record<string, unknown>;
  const filePath = args.file_path as string | undefined;

  try {
    // Handle file uploads
    if (filePath && method === "POST") {
      const result = await client.uploadFile(
        url,
        filePath,
        Object.keys(params).length > 0 ? params : undefined
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result) },
        ],
      };
    }

    const hasParams = Object.keys(params).length > 0;
    const result = await client.request(
      method,
      url,
      method === "GET" ? undefined : hasParams ? params : undefined,
      method === "GET" ? (hasParams ? params : undefined) : undefined
    );

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result) },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
