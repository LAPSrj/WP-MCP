import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Config } from "./config.js";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function getMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

export class WpClient {
  private authHeader: string | undefined;

  constructor(private config: Config) {
    if (config.wpUsername && config.wpAppPassword) {
      const credentials = Buffer.from(
        `${config.wpUsername}:${config.wpAppPassword}`
      ).toString("base64");
      this.authHeader = `Basic ${credentials}`;
    }
  }

  async request(
    method: string,
    url: string,
    body?: Record<string, unknown>,
    queryParams?: Record<string, unknown>
  ): Promise<unknown> {
    let fullUrl = url;

    if (queryParams) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== null) {
          searchParams.set(key, String(value));
        }
      }
      const qs = searchParams.toString();
      if (qs) {
        fullUrl += `?${qs}`;
      }
    }

    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }
    if (method !== "GET" && body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(fullUrl, {
      method,
      headers,
      body: method !== "GET" && body ? JSON.stringify(body) : undefined,
    });

    const responseBody = await response.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      parsed = responseBody;
    }

    if (!response.ok) {
      const wpError = parsed as { code?: string; message?: string };
      const msg =
        wpError && typeof wpError === "object" && wpError.message
          ? `${response.status} ${response.statusText}: ${wpError.message} (${wpError.code || "unknown"})`
          : `${response.status} ${response.statusText}: ${responseBody}`;
      throw new Error(msg);
    }

    return parsed;
  }

  async uploadFile(
    url: string,
    filePath: string,
    meta?: Record<string, unknown>
  ): Promise<unknown> {
    const fileData = await readFile(filePath);
    const filename = basename(filePath);
    const contentType = getMimeType(filePath);

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    };
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: fileData,
    });

    const responseBody = await response.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      parsed = responseBody;
    }

    if (!response.ok) {
      const wpError = parsed as { code?: string; message?: string };
      const msg =
        wpError && typeof wpError === "object" && wpError.message
          ? `${response.status} ${response.statusText}: ${wpError.message} (${wpError.code || "unknown"})`
          : `${response.status} ${response.statusText}: ${responseBody}`;
      throw new Error(msg);
    }

    // If there are meta fields (title, alt_text, caption, etc.), update them
    if (meta && Object.keys(meta).length > 0) {
      const mediaId = (parsed as { id: number }).id;
      const updateUrl = `${url}/${mediaId}`;
      parsed = await this.request("POST", updateUrl, meta);
    }

    return parsed;
  }

  async get(url: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.request("GET", url, undefined, params);
  }
}
