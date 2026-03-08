import { Config } from "./config.js";
import { WpClient } from "./wp-client.js";
import { WpIndex, WpEndpoint, ToolDefinition } from "./types.js";
import {
  extractPathParams,
  buildToolName,
  buildToolDescription,
  buildMinimalDescription,
  buildInputSchema,
  stripSchemaDescriptions,
} from "./tools.js";

export async function discoverTools(
  config: Config,
  client: WpClient
): Promise<ToolDefinition[]> {
  const index = (await client.get(`${config.wpUrl}/wp-json`)) as WpIndex;

  const hasAcf = index.namespaces?.includes("acf/v1") ?? false;

  const tools: ToolDefinition[] = [];

  for (const [routePattern, routeData] of Object.entries(index.routes)) {
    // Skip the root index route
    if (routePattern === "/") continue;

    const pathParams = extractPathParams(routePattern);
    const name = buildToolName(routePattern);

    const isMinimal = config.descriptionMode === "minimal";

    const description = isMinimal
      ? buildMinimalDescription(routePattern, routeData.endpoints)
      : buildToolDescription(routePattern, routeData.endpoints);

    let inputSchema = buildInputSchema(pathParams, routeData.endpoints);

    // Inject file_path parameter for media upload routes
    if (routePattern === "/wp/v2/media") {
      const props = inputSchema.properties as Record<string, unknown>;
      props["file_path"] = {
        type: "string",
        description:
          "Absolute path to a local file to upload. When provided with POST method, the file is uploaded as a media attachment.",
      };
    }

    // Inject acf parameter for writable routes when ACF is active
    if (hasAcf) {
      const hasWriteMethods = routeData.endpoints.some((ep) =>
        ep.methods.some((m) => ["POST", "PUT", "PATCH"].includes(m))
      );
      if (hasWriteMethods && routePattern.startsWith("/wp/v2/")) {
        const props = inputSchema.properties as Record<string, unknown>;
        props["acf"] = {
          type: "object",
          description:
            "ACF (Advanced Custom Fields) values to set. Pass an object with field names as keys, e.g. {\"field_name\": \"value\"}. For image fields, pass the attachment ID as an integer.",
        };
      }
    }

    // Strip property descriptions in minimal mode
    if (isMinimal) {
      inputSchema = stripSchemaDescriptions(inputSchema);
    }

    // Build method → endpoint lookup
    const endpointsByMethod = new Map<string, WpEndpoint>();
    for (const endpoint of routeData.endpoints) {
      for (const method of endpoint.methods) {
        endpointsByMethod.set(method, endpoint);
      }
    }

    const allMethods: string[] = [];
    for (const endpoint of routeData.endpoints) {
      for (const method of endpoint.methods) {
        if (!allMethods.includes(method)) {
          allMethods.push(method);
        }
      }
    }

    tools.push({
      name,
      description,
      inputSchema,
      route: routePattern,
      methods: allMethods,
      pathParams,
      endpointsByMethod,
    });
  }

  return applyToolFilter(config, tools);
}

function applyToolFilter(
  config: Config,
  tools: ToolDefinition[]
): ToolDefinition[] {
  if (config.toolMode === "all" || config.toolMode === "compact") {
    return tools;
  }

  const patterns = config.toolFilter;
  if (patterns.length === 0) return tools;

  const matches = (tool: ToolDefinition): boolean => {
    return patterns.some(
      (p) => tool.name === p || tool.route === p || tool.route.startsWith(p)
    );
  };

  if (config.toolMode === "allowlist") {
    return tools.filter(matches);
  }

  // blocklist
  return tools.filter((t) => !matches(t));
}
