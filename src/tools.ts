import { createHash } from "node:crypto";
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

  // Enforce 64-char limit with intelligent shortening
  if (name.length <= 64) return name;

  // Try stripping wp- or wp_ prefix from non-core namespaces
  const stripped = name.replace(/^wp[-_]/, "");
  if (stripped.length <= 64) return stripped;

  // Keep first two + last two segments
  const segments = name.split(".");
  if (segments.length > 4) {
    const short = `${segments[0]}.${segments[1]}..${segments[segments.length - 2]}.${segments[segments.length - 1]}`;
    if (short.length <= 64) return short;
  }

  // Last resort: head_[6-char-hash]_tail for uniqueness
  const hash = createHash("md5").update(name).digest("hex").slice(0, 6);
  const head = segments.slice(0, 2).join(".");
  const tail = segments.slice(-1)[0];
  const hashed = `${head}_${hash}_${tail}`;
  if (hashed.length <= 64) return hashed;

  return name.slice(0, 64);
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

const VALID_PROPERTY_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;

function sanitizePropertyKey(key: string): string {
  // Replace brackets like filter[key] with filter.key
  let sanitized = key.replace(/\[/g, ".").replace(/\]/g, "");
  // Replace any remaining invalid characters with underscore
  sanitized = sanitized.replace(/[^a-zA-Z0-9_.-]/g, "_");
  // Collapse consecutive underscores/dots
  sanitized = sanitized.replace(/[_.]{2,}/g, "_");
  // Trim leading/trailing separators
  sanitized = sanitized.replace(/^[_.-]+|[_.-]+$/g, "");
  // Truncate to 64 characters
  return sanitized.slice(0, 64);
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

      // Sanitize property key to match API requirements
      const safeKey = VALID_PROPERTY_KEY.test(argName)
        ? argName
        : sanitizePropertyKey(argName);

      // Skip if sanitization produced an empty key or collision
      if (!safeKey || properties[safeKey]) continue;

      properties[safeKey] = wpArgToJsonSchema(argDef);

      if (argDef.required) {
        required.push(safeKey);
      }
    }
  }

  // Inject _fields — WordPress global query param for field selection
  properties["_fields"] = {
    type: "string",
    description:
      "Comma-separated list of fields to include in the response (e.g. \"id,title,slug\"). Reduces response size.",
  };

  // Inject _save_response — save response to file instead of returning inline
  properties["_save_response"] = {
    type: "string",
    description:
      "File path to save the response to instead of returning it inline. Returns a compact summary with file path and size. Useful for large responses that would fill the context window.",
  };
  properties["_save_response_field"] = {
    type: "string",
    description:
      "Dot-notation field path to extract before saving (e.g. \"content.rendered\"). Only the extracted value is written to the file. Used with _save_response.",
  };

  // Inject _file_params and _body_file for endpoints that support writes
  const hasWriteMethods = endpoints.some((ep) =>
    ep.methods.some((m) => ["POST", "PUT", "PATCH", "DELETE"].includes(m))
  );
  if (hasWriteMethods) {
    properties["_file_params"] = {
      type: "object",
      description:
        "Map of parameter names to file paths. Each file is read and its contents used as the string value for that parameter. E.g. {\"content\": \"/tmp/page.html\", \"excerpt\": \"/tmp/excerpt.txt\"}. Avoids sending large content inline.",
    };
    properties["_body_file"] = {
      type: "string",
      description:
        "Path to a JSON file whose contents are parsed and merged into the request body. Explicit parameters and _file_params take precedence over values from this file.",
    };
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

export function buildMinimalDescription(
  routePattern: string,
  endpoints: WpEndpoint[]
): string {
  const seenMethods = new Set<string>();
  for (const endpoint of endpoints) {
    for (const method of endpoint.methods) {
      seenMethods.add(method);
    }
  }

  // Collect all parameter names
  const paramNames = new Set<string>();
  for (const endpoint of endpoints) {
    for (const argName of Object.keys(endpoint.args)) {
      paramNames.add(argName);
    }
  }

  const methods = Array.from(seenMethods).join(", ");
  const params = Array.from(paramNames);
  const paramStr = params.length > 0 ? ` — Params: ${params.join(", ")}` : "";
  return `${routePattern} [${methods}]${paramStr}`;
}

export function stripSchemaDescriptions(
  inputSchema: Record<string, unknown>
): Record<string, unknown> {
  const schema = { ...inputSchema };
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return schema;

  const strippedProps: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(properties)) {
    const { description: _, ...rest } = value;
    strippedProps[key] = rest;
  }
  schema.properties = strippedProps;
  return schema;
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
