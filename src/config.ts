export type ToolMode = "all" | "compact" | "allowlist" | "blocklist";
export type DescriptionMode = "verbose" | "minimal";

export interface Config {
  wpUrl: string;
  wpUsername: string;
  wpAppPassword: string;
  wpIgnoreSsl: boolean;
  toolMode: ToolMode;
  toolFilter: string[];
  descriptionMode: DescriptionMode;
}

export function loadConfig(): Config {
  const wpUrl = process.env.WP_URL;
  if (!wpUrl) {
    throw new Error("WP_URL environment variable is required");
  }

  const toolMode = (process.env.WP_TOOL_MODE || "all") as ToolMode;
  if (!["all", "compact", "allowlist", "blocklist"].includes(toolMode)) {
    throw new Error(
      `Invalid WP_TOOL_MODE: ${toolMode}. Must be one of: all, compact, allowlist, blocklist`
    );
  }

  const toolFilter = process.env.WP_TOOL_FILTER
    ? process.env.WP_TOOL_FILTER.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const descriptionMode = (process.env.WP_DESCRIPTION_MODE || "minimal") as DescriptionMode;
  if (!["verbose", "minimal"].includes(descriptionMode)) {
    throw new Error(
      `Invalid WP_DESCRIPTION_MODE: ${descriptionMode}. Must be one of: verbose, minimal`
    );
  }

  return {
    wpUrl: wpUrl.replace(/\/+$/, ""),
    wpUsername: process.env.WP_USERNAME || "",
    wpAppPassword: process.env.WP_APP_PASSWORD || "",
    wpIgnoreSsl: process.env.WP_IGNORE_SSL === "true",
    toolMode,
    toolFilter,
    descriptionMode,
  };
}
