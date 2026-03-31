# WP-MCP

MCP server that wraps the WordPress REST JSON API. It dynamically discovers all available routes from your WordPress site and exposes each as an MCP tool.

## Features

- Automatic route discovery from `/wp-json` — all core and plugin endpoints are exposed
- Authentication via WordPress Application Passwords
- Optional SSL certificate verification bypass for local/dev environments
- One tool per route with `method` as a parameter (GET, POST, PUT, PATCH, DELETE)
- Clean tool names: `posts`, `posts.id`, `categories`, `media.id`, etc.

## Configuration

The server is configured via environment variables passed through your MCP client:

| Variable | Required | Description |
|---|---|---|
| `WP_URL` | Yes | WordPress site URL (e.g. `https://example.com`) |
| `WP_USERNAME` | No | WordPress username for authenticated requests |
| `WP_APP_PASSWORD` | No | WordPress Application Password |
| `WP_IGNORE_SSL` | No | Set to `"true"` to skip SSL certificate verification |
| `WP_TOOL_MODE` | No | Tool exposure strategy: `all` (default), `compact`, `allowlist`, or `blocklist` |
| `WP_TOOL_FILTER` | No | Comma-separated list of tool names or route patterns for allowlist/blocklist modes |
| `WP_DESCRIPTION_MODE` | No | `verbose` or `minimal` (default). Minimal strips property descriptions to reduce token usage |

### Generating an Application Password

1. In your WordPress admin, go to **Users > Profile**
2. Scroll to **Application Passwords**
3. Enter a name (e.g. "wp-mcp") and click **Add New Application Password**
4. Copy the generated password

## Setup

### Build from source

```bash
npm install
npm run build
```

### MCP client configuration

Add to your MCP client settings (e.g. Claude Desktop `claude_desktop_config.json` or VS Code `settings.json`):

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "node",
      "args": ["/path/to/wp-mcp/dist/index.js"],
      "env": {
        "WP_URL": "https://example.com",
        "WP_USERNAME": "admin",
        "WP_APP_PASSWORD": "xxxx xxxx xxxx xxxx",
        "WP_IGNORE_SSL": "false"
      }
    }
  }
}
```

## How it works

On startup the server fetches the WordPress REST API index at `WP_URL/wp-json`, which returns all registered routes with their methods, arguments, and schemas. Each route becomes an MCP tool:

| WP Route | Tool Name |
|---|---|
| `/wp/v2/posts` | `posts` |
| `/wp/v2/posts/(?P<id>[\d]+)` | `posts.id` |
| `/wp/v2/categories` | `categories` |
| `/wp/v2/media/(?P<id>[\d]+)` | `media.id` |
| `/wc/v3/products` | `wc.v3.products` |

The `wp/v2/` prefix is stripped from core routes for cleaner names. Plugin namespaces are preserved to avoid collisions.

Every tool accepts a required `method` parameter (enum of the HTTP methods that route supports) plus the route's own arguments as additional parameters.

### Built-in parameters

These parameters are injected into every tool's schema by the MCP server.

**`_fields`** — Added to all tools. Comma-separated list of fields to include in the response (e.g. `id,title,slug`). This is a native WordPress query parameter that reduces response size — it is passed through to WordPress.

The following parameters are intercepted by the MCP server and not sent to WordPress:

**`_save_response`** — Added to all tools. File path to save the response to instead of returning it inline. When set, the tool returns a compact summary (file path, size, and identifying fields like id/title/type) instead of the full response body. Useful for large responses that would waste context tokens.

**`_save_response_field`** — Added to all tools. Used with `_save_response`. Dot-notation path to extract a specific field before saving (e.g. `content.rendered`). Only the extracted value is written to the file — string values are written raw (not JSON-quoted), so you get clean HTML/text.

**`_file_params`** — Added to writable tools (POST/PUT/PATCH/DELETE). An object mapping parameter names to file paths. Each file is read and its contents used as the string value for that parameter. Example: `{"content": "/tmp/page.html", "excerpt": "/tmp/excerpt.txt"}`.

**`_body_file`** — Added to writable tools. Path to a JSON file whose contents are parsed and merged into the request body. Precedence: `_file_params` > explicit inline parameters > `_body_file`.

### File-based content workflow

When working with large content (e.g. editing a WordPress page), agents can use these parameters to keep content out of the conversation context entirely:

```
1. GET  pages.id  { "id": 42, "_save_response": "/tmp/page.json" }
   → returns: {"saved_to":"/tmp/page.json","size":"24.3KB","id":42,"title":"About Us","type":"page"}

2. Agent reads /tmp/page.json, edits it locally

3. POST pages.id  { "id": 42, "method": "POST", "_body_file": "/tmp/page.json" }
   → MCP reads the file and sends its contents as the request body
```

Or to work with just the content field:

```
1. GET  pages.id  { "id": 42, "_save_response": "/tmp/content.html", "_save_response_field": "content.rendered" }
   → saves raw HTML to file, returns compact summary

2. Agent edits /tmp/content.html

3. POST pages.id  { "id": 42, "method": "POST", "_file_params": { "content": "/tmp/content.html" } }
   → MCP reads the HTML file and sends it as the content parameter
```

### Other features

- **Media uploads**: The `media` tool accepts a `file_path` parameter for uploading local files.
- **ACF support**: When Advanced Custom Fields is detected, writable tools on core routes get an `acf` object parameter for setting custom field values.
- **`refresh_tools`**: A built-in tool that re-discovers all WordPress REST API routes. Use after installing plugins or registering new post types.
