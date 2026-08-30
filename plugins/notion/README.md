# Notion plugin

This Cusco plugin connects directly to [Notion's official hosted MCP
server](https://developers.notion.com/guides/mcp/overview). It does not use a
third-party proxy and does not require a Notion API token in a configuration
file.

## Connect

1. Install **Notion** from Cusco's Plugins catalog.
2. Select **Connect** and complete the Notion OAuth authorization in the
   browser.
3. Return to Cusco after Notion redirects to the local callback page.

Cusco uses Notion's recommended Streamable HTTP endpoint, OAuth Authorization
Code flow with PKCE, dynamic client registration, token refresh, and Secret
Service storage. The plugin never stores an access token or client secret in
its manifest.

The connection acts with the permissions of the Notion user and workspace that
authorized it. Workspace administrators may restrict which MCP clients are
allowed to connect. Remove the connection from Cusco or Notion's connection
settings to revoke access.

See Notion's [custom MCP client
guide](https://developers.notion.com/guides/mcp/build-mcp-client) and [supported
tool list](https://developers.notion.com/guides/mcp/mcp-supported-tools) for the
current protocol and capabilities.
