# Cloudflare plugin

This Cusco plugin connects directly to Cloudflare's official hosted API MCP
server at `https://mcp.cloudflare.com/mcp`. It does not use a local bridge or a
third-party proxy.

## Connect

1. Install **Cloudflare** from Cusco's Plugins catalog.
2. Select **Connect** and authorize the intended Cloudflare account in the
   browser.
3. Return to Cusco after Cloudflare completes the OAuth flow.

The server exposes Cloudflare's API through compact search and execute tools.
Cusco stores OAuth credentials in the desktop Secret Service and asks for
permission before every MCP tool call. No API token, OAuth access token, client
ID, or client secret is embedded in the plugin.

The endpoint and logo were verified against Cloudflare's official
[`cloudflare/skills`](https://github.com/cloudflare/skills) repository. See
Cloudflare's [managed MCP server documentation](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)
for current capabilities and authentication details.
