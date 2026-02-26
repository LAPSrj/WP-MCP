export interface Config {
  wpUrl: string;
  wpUsername: string;
  wpAppPassword: string;
  wpIgnoreSsl: boolean;
}

export function loadConfig(): Config {
  const wpUrl = process.env.WP_URL;
  if (!wpUrl) {
    throw new Error("WP_URL environment variable is required");
  }

  return {
    wpUrl: wpUrl.replace(/\/+$/, ""),
    wpUsername: process.env.WP_USERNAME || "",
    wpAppPassword: process.env.WP_APP_PASSWORD || "",
    wpIgnoreSsl: process.env.WP_IGNORE_SSL === "true",
  };
}
