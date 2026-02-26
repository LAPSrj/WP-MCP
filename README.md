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
