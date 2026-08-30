# Linear plugin

This Cusco plugin connects directly to [Linear's official hosted MCP
server](https://linear.app/docs/mcp). It does not use `mcp-remote`, a local
bridge, or a third-party proxy.

## Connect

1. Install **Linear** from Cusco's Plugins catalog.
2. Select **Connect** and authorize the intended Linear workspace in the
   browser.
3. Return to Cusco after Linear redirects to the local callback page.

Cusco uses Linear's primary Streamable HTTP read-write endpoint, OAuth 2.1 with
dynamic client registration, PKCE, token refresh, and Secret Service storage.
No Linear API key, Client ID, or client secret is stored in the plugin.

The connection acts with the permissions of the authenticated Linear account.
Cusco keeps every MCP tool permission-gated. For an intrinsically read-only
connection, use Linear's official `https://mcp.linear.app/mcp/readonly`
endpoint as a separately configured MCP server instead of assuming prompt-level
instructions can enforce read-only access.

See Linear's [MCP documentation](https://linear.app/docs/mcp) for current setup,
authentication, read-only options, and capabilities.
