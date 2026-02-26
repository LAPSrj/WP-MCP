import { WpArg, WpEndpoint } from "./types.js";

const WP_CORE_PREFIX = "wp/v2/";

export function extractPathParams(routePattern: string): string[] {
  const regex = /\(\?P<(\w+)>[^)]+\)/g;
  const params: string[] = [];
  let match;
  while ((match = regex.exec(routePattern)) !== null) {
    params.push(match[1]);
  }
  return params;
}

export function buildToolName(routePattern: string): string {
  let name = routePattern
    .replace(/\(\?P<(\w+)>[^)]+\)/g, "$1")
    .replace(/\//g, ".")
    .replace(/^\./, "")
    .replace(/[^A-Za-z0-9._-]/g, "");

  // Strip wp.v2. prefix for core routes
  if (name.startsWith("wp.v2.")) {
    name = name.slice("wp.v2.".length);
  }

  return name.slice(0, 128);
}

export function buildToolDescription(
  routePattern: string,
  endpoints: WpEndpoint[]
): string {
  const methodDescriptions: string[] = [];
  const seenMethods = new Set<string>();

  for (const endpoint of endpoints) {
    for (const method of endpoint.methods) {
      if (seenMethods.has(method)) continue;
      seenMethods.add(method);
      methodDescriptions.push(method);
    }
  }

  const methods = methodDescriptions.join(", ");
  return `${routePattern} [${methods}]`;
}

const VALID_JSON_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);

function sanitizeType(type: string): string {
  if (VALID_JSON_SCHEMA_TYPES.has(type)) return type;
  // WP uses "mixed" and other non-standard types — fall back to string
  return "string";
}

function sanitizeItems(items: unknown): Record<string, unknown> | undefined {
  if (!items || typeof items !== "object") return undefined;
  const obj = items as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  if (obj.type) {
    const t = String(obj.type);
    if (VALID_JSON_SCHEMA_TYPES.has(t)) {
      result.type = t;
    } else {
      result.type = "string";
    }
  } else {
    result.type = "string";
  }

  if (Array.isArray(obj.enum) && obj.enum.length > 0) {
    result.enum = obj.enum;
  }

  return result;
}

function wpArgToJsonSchema(arg: WpArg): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  if (arg.type) {
    if (Array.isArray(arg.type)) {
      const nonNull = arg.type.filter((t) => t !== "null");
      schema.type = sanitizeType(nonNull[0] || "string");
    } else {
      schema.type = sanitizeType(arg.type);
    }
  } else {
    schema.type = "string";
  }

  if (arg.description) {
    schema.description = arg.description;
  }

  if (Array.isArray(arg.enum) && arg.enum.length > 0) {
    schema.enum = arg.enum;
  }

  // Arrays must have items
  if (schema.type === "array") {
    schema.items = sanitizeItems(arg.items) || { type: "string" };
  }

  return schema;
}

export function buildInputSchema(
  pathParams: string[],
  endpoints: WpEndpoint[]
): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  // Collect all unique methods across endpoints for the enum
  const allMethods = new Set<string>();
  for (const endpoint of endpoints) {
    for (const m of endpoint.methods) {
      allMethods.add(m);
    }
  }

  // method parameter — always required
  properties["method"] = {
    type: "string",
    description: "HTTP method to use",
    enum: Array.from(allMethods),
  };
  required.push("method");

  // Path params — always required
  for (const param of pathParams) {
    properties[param] = {
      type: "string",
      description: `URL path parameter: ${param}`,
    };
    required.push(param);
  }

  // Merge args from all endpoints (superset)
  for (const endpoint of endpoints) {
    for (const [argName, argDef] of Object.entries(endpoint.args)) {
      if (argName === "method") continue; // reserved
      if (pathParams.includes(argName)) {
        // Path param already added; enrich description if available
        if (argDef.description && properties[argName]) {
          properties[argName].description = argDef.description;
        }
        continue;
      }

      // If already added from a different endpoint, skip (first wins)
      if (properties[argName]) continue;

      properties[argName] = wpArgToJsonSchema(argDef);

      if (argDef.required) {
        required.push(argName);
      }
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

export function buildUrl(
  baseUrl: string,
  routePattern: string,
  pathParamValues: Record<string, string>
): string {
  let path = routePattern;
  for (const [name, value] of Object.entries(pathParamValues)) {
    path = path.replace(
      new RegExp(`\\(\\?P<${name}>[^)]+\\)`),
      encodeURIComponent(value)
    );
  }
  return `${baseUrl}/wp-json${path}`;
}
