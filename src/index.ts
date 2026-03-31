#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { discoverTools } from "./discovery.js";
import { WpClient } from "./wp-client.js";
import { buildUrl } from "./tools.js";
import { ToolDefinition } from "./types.js";

// --- File-based parameter helpers ---

interface FileOptions {
  saveResponse?: string;
  saveResponseField?: string;
  fileParams?: Record<string, string>;
  bodyFile?: string;
}

/** Extract and remove file-related meta-parameters from args */
function extractFileOptions(args: Record<string, unknown>): FileOptions {
  const opts: FileOptions = {};
  if (args._save_response) {
    opts.saveResponse = String(args._save_response);
    delete args._save_response;
  }
  if (args._save_response_field) {
    opts.saveResponseField = String(args._save_response_field);
    delete args._save_response_field;
  }
  if (args._file_params && typeof args._file_params === "object") {
    opts.fileParams = args._file_params as Record<string, string>;
    delete args._file_params;
  }
  if (args._body_file) {
    opts.bodyFile = String(args._body_file);
    delete args._body_file;
  }
  return opts;
}

/** Read _body_file and _file_params, merge into args.
 *  Precedence: _file_params > explicit inline args > _body_file */
async function applyFileInputs(
  args: Record<string, unknown>,
  opts: FileOptions
): Promise<void> {
  if (opts.bodyFile) {
    const raw = await readFile(opts.bodyFile, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (!(key in args)) {
        args[key] = value;
      }
    }
  }
  if (opts.fileParams) {
    for (const [paramName, filePath] of Object.entries(opts.fileParams)) {
      args[paramName] = await readFile(String(filePath), "utf-8");
    }
  }
}

/** Resolve a dot-notation field path on an object */
function extractField(obj: unknown, fieldPath: string): unknown {
  const parts = fieldPath.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** If _save_response is set, write to file and return summary; otherwise return inline JSON */
async function formatResponse(
  result: unknown,
  opts: FileOptions
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  if (!opts.saveResponse) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }

  let dataToSave: unknown = result;
  if (opts.saveResponseField) {
    dataToSave = extractField(result, opts.saveResponseField);
  }

  const fileContent =
    typeof dataToSave === "string"
      ? dataToSave
      : JSON.stringify(dataToSave, null, 2);

  await writeFile(opts.saveResponse, fileContent, "utf-8");

  const size = Buffer.byteLength(fileContent, "utf-8");
  const summary: Record<string, unknown> = {
    saved_to: opts.saveResponse,
    size: size > 1024 ? `${(size / 1024).toFixed(1)}KB` : `${size}B`,
  };

  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (r.id !== undefined) summary.id = r.id;
    if (r.title) {
      summary.title =
        typeof r.title === "object" && r.title !== null
          ? (r.title as Record<string, unknown>).rendered
          : r.title;
    }
    if (r.type) summary.type = r.type;
    if (r.status) summary.status = r.status;
  } else if (Array.isArray(result)) {
    summary.item_count = result.length;
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary) }],
  };
}

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
        _save_response: {
          type: "string",
          description:
            "File path to save the response to instead of returning it inline. Returns a compact summary.",
        },
        _save_response_field: {
          type: "string",
          description:
            "Dot-notation field path to extract before saving (e.g. \"content.rendered\"). Used with _save_response.",
        },
        _file_params: {
          type: "object",
          description:
            "Map of parameter names to file paths. Each file is read and its contents used as the parameter value.",
        },
        _body_file: {
          type: "string",
          description:
            "Path to a JSON file whose contents are merged into the request body. Explicit params and _file_params take precedence.",
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

      // Extract file-based meta-parameters before they reach WordPress
      const fileOpts = extractFileOptions(otherArgs);

      // Apply _body_file and _file_params into otherArgs
      await applyFileInputs(otherArgs, fileOpts);

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
        return formatResponse(result, fileOpts);
      }

      const hasOtherArgs = Object.keys(otherArgs).length > 0;
      const result = await client.request(
        method,
        url,
        method === "GET" ? undefined : hasOtherArgs ? otherArgs : undefined,
        method === "GET" ? (hasOtherArgs ? otherArgs : undefined) : undefined
      );

      return formatResponse(result, fileOpts);
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

  // Extract file-based meta-parameters from top-level args
  const fileOpts = extractFileOptions(args);

  const url = `${wpUrl}/wp-json${path.startsWith("/") ? path : `/${path}`}`;
  const params = (args.params || {}) as Record<string, unknown>;
  const filePath = args.file_path as string | undefined;

  try {
    // Apply _body_file and _file_params into params
    await applyFileInputs(params, fileOpts);

    // Handle file uploads
    if (filePath && method === "POST") {
      const result = await client.uploadFile(
        url,
        filePath,
        Object.keys(params).length > 0 ? params : undefined
      );
      return formatResponse(result, fileOpts);
    }

    const hasParams = Object.keys(params).length > 0;
    const result = await client.request(
      method,
      url,
      method === "GET" ? undefined : hasParams ? params : undefined,
      method === "GET" ? (hasParams ? params : undefined) : undefined
    );

    return formatResponse(result, fileOpts);
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
